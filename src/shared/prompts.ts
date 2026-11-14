import type { Address, ChatTurn, FullMessage } from './types';
import { formatAddress } from './compose';
import { getLang } from './i18n';

const en = () => getLang() === 'en';

export interface PromptInput {
  message: FullMessage;
  ownName: string;
  ownEmail: string;
  tone: string;
  examples: string[];
  draft?: string;
  history: ChatTurn[];
  instruction?: string;
  // Övriga mejl i samma konversation, äldst först.
  thread?: ContextMail[];
  // Tidigare mejl med samma person utanför tråden, nyast först.
  earlier?: ContextMail[];
}

export interface ContextMail {
  from: Address;
  to: Address[];
  date: number;
  subject: string;
  text: string;
}

const MAX_THREAD_CHARS = 14000;
const MAX_CONTEXT_CHARS = 9000;

const stamp = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ');

// Bara det nya i ett svar: citerade rader och allt efter "Den ... skrev" tas bort för att spara plats.
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  for (const l of lines) {
    if (/^(Den|On|Am|Le)\s.{3,160}\s(skrev|wrote|schrieb|a écrit)\b.*:\s*$/i.test(l.trim())) break;
    if (/^-{2,}\s*(Ursprungligt meddelande|Original Message|Vidarebefordrat meddelande)/i.test(l.trim())) break;
    if (l.startsWith('>')) continue;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function contextBlock(mails: ContextMail[], budget: number, perMail: number): string {
  const parts: string[] = [];
  let used = 0;
  for (const m of mails) {
    let body = stripQuoted(m.text);
    if (body.length > perMail) body = body.slice(0, perMail) + ' [...]';
    const part = en()
      ? `From: ${formatAddress(m.from)}\nDate: ${stamp(m.date)}\nSubject: ${m.subject}\n\n${body}`
      : `Från: ${formatAddress(m.from)}\nDatum: ${stamp(m.date)}\nÄmne: ${m.subject}\n\n${body}`;
    if (used + part.length > budget) break;
    parts.push(part);
    used += part.length;
  }
  return parts.join('\n---\n');
}

// Tråden och tidigare mejl med samma person, som bakgrund före mejlet som gäller.
export function contextText(input: Pick<PromptInput, 'thread' | 'earlier' | 'message'>): string {
  const out: string[] = [];
  if (input.thread?.length) out.push(`<tidigare_i_traden>\n${contextBlock(input.thread, MAX_CONTEXT_CHARS, 2500)}\n</tidigare_i_traden>`);
  if (input.earlier?.length) {
    out.push(
      `<tidigare_mejl_med_personen>\n${en() ? `Other emails with ${formatAddress(input.message.from)} recently, newest first. Background only.` : `Andra mejl med ${formatAddress(input.message.from)} på senare tid, nyast först. Bara bakgrund.`}\n\n${contextBlock(input.earlier, 5000, 900)}\n</tidigare_mejl_med_personen>`
    );
  }
  return out.length ? `${out.join('\n\n')}\n\n` : '';
}

export function threadText(msg: FullMessage): string {
  const dateStr = new Date(msg.date).toISOString().slice(0, 16).replace('T', ' ');
  const L = en()
    ? { from: 'From', to: 'To', cc: 'Cc', date: 'Date', subject: 'Subject', att: 'Attachments', cut: '[...truncated...]' }
    : { from: 'Från', to: 'Till', cc: 'Kopia', date: 'Datum', subject: 'Ämne', att: 'Bilagor', cut: '[...avkortat...]' };
  const header = [
    `${L.from}: ${formatAddress(msg.from)}`,
    `${L.to}: ${msg.to.map(formatAddress).join(', ')}`,
    msg.cc.length ? `${L.cc}: ${msg.cc.map(formatAddress).join(', ')}` : '',
    `${L.date}: ${dateStr}`,
    `${L.subject}: ${msg.subject}`
  ]
    .filter(Boolean)
    .join('\n');
  let body = msg.body.text.replace(/\r/g, '').trim();
  if (body.length > MAX_THREAD_CHARS) body = body.slice(0, MAX_THREAD_CHARS) + `\n${L.cut}`;
  const atts = msg.body.attachments.filter((a) => !a.inline).map((a) => a.filename);
  return `${header}\n${atts.length ? `${L.att}: ${atts.join(', ')}\n` : ''}\n${body}`;
}

export function systemPrompt(input: Pick<PromptInput, 'ownName' | 'ownEmail' | 'tone' | 'examples'>): string {
  const lines = en()
    ? [
        `You write draft replies to emails on behalf of ${input.ownName || 'the user'} (${input.ownEmail}).`,
        'Write the reply in the same language as the email being answered (the latest email in the thread), unless the tone setting below says otherwise.',
        'Write only the body of the reply: greeting, content and closing. No subject line, no explanations, no alternatives, no placeholders in square brackets if it can be avoided.',
        'Do not invent facts, dates, prices or promises that are not in the thread. If information is missing, write the reply so that it asks for it or leaves the decision open.',
        'Never use dashes (em dash or en dash). Rewrite with a comma, colon or period. No emojis.',
        `Tone and style: ${input.tone}`
      ]
    : [
    `Du skriver svarsutkast på mejl åt ${input.ownName || 'användaren'} (${input.ownEmail}).`,
    'Skriv svaret på samma språk som mejlet du svarar på (det senaste mejlet i tråden), om inte tonen nedan säger något annat. Är det svenska, skriv svenska.',
    'Skriv bara själva brödtexten i svaret: hälsning, innehåll och avslutning. Ingen ämnesrad, inga förklaringar, inga alternativ, inga platshållare i hakparentes om det går att undvika.',
    'Hitta inte på fakta, datum, priser eller löften som inte står i tråden. Saknas information, skriv svaret så att det frågar efter den eller lämnar beslutet öppet.',
    'Använd aldrig tankestreck (em-dash eller en-dash). Skriv om med komma, kolon eller punkt. Inga emojis.',
    `Ton och stil: ${input.tone}`
      ];
  const ex = input.examples.map((e) => e.trim()).filter((e) => e.length > 40).slice(0, 3);
  if (ex.length) {
    lines.push('', en() ? 'Examples of emails the user has written recently, to match the tone (do not copy the content):' : 'Exempel på mejl som användaren själv har skrivit nyligen, för att träffa tonen (kopiera inte innehållet):');
    ex.forEach((e, i) => lines.push(en() ? `--- Example ${i + 1} ---` : `--- Exempel ${i + 1} ---`, e.slice(0, 1200)));
  }
  return lines.join('\n');
}

export function userPrompt(input: PromptInput): string {
  if (en()) return `${contextText(input)}Here is the email to answer:\n\n<mejl>\n${threadText(input.message)}\n</mejl>\n\nWrite a draft reply.`;
  return `${contextText(input)}Här är mejlet som ska besvaras:\n\n<mejl>\n${threadText(input.message)}\n</mejl>\n\nSkriv ett svarsutkast.`;
}

const TASKS = {
  summary: {
    system:
      'Du sammanfattar mejlkonversationer på svenska åt användaren. Skriv 2 till 5 korta punkter med "- " först: vad saken gäller, vad som bestämts, vad som är öppet. Nämn namn, datum och belopp som står i mejlen. Hitta inte på något. Inga tankestreck, inga emojis, ingen inledning.',
    ask: 'Sammanfatta konversationen.'
  },
  todo: {
    system:
      'Du hjälper användaren att se vad hen behöver göra efter en mejlkonversation. Svara på svenska med en kort lista med "- " först, en punkt per sak användaren själv behöver göra, med tidpunkt om den står i mejlen. Behöver inget göras, svara exakt: Inget behöver göras. Hitta inte på något. Inga tankestreck, inga emojis, ingen inledning.',
    ask: 'Vad behöver jag göra?'
  },
  quick: {
    system:
      'Du föreslår snabbsvar på mejl. Skriv exakt tre olika korta svar som användaren kan skicka direkt, på samma språk som mejlet, vart och ett högst två meningar med hälsning (till exempel "Hej Anna!") först. Ett som säger ja eller bekräftar, ett som ber om mer information eller föreslår annat, ett som tackar eller avböjer vänligt. Skriv varje svar på en egen rad som börjar med 1., 2. och 3. Inga tankestreck, inga emojis, inget annat.',
    ask: 'Föreslå tre snabbsvar.'
  }
} as const;

const TASKS_EN = {
  summary: {
    system:
      'You summarize email conversations in English for the user. Write 2 to 5 short points starting with "- ": what the matter is about, what has been decided, what is open. Mention names, dates and amounts that appear in the emails. Do not invent anything. No dashes, no emojis, no introduction.',
    ask: 'Summarize the conversation.'
  },
  todo: {
    system:
      'You help the user see what they need to do after an email conversation. Answer in English with a short list starting with "- ", one point per thing the user needs to do themselves, with a time if it is stated in the emails. If nothing needs to be done, answer exactly: Nothing needs to be done. Do not invent anything. No dashes, no emojis, no introduction.',
    ask: 'What do I need to do?'
  },
  quick: {
    system:
      'You suggest quick replies to emails. Write exactly three different short replies the user can send right away, in the same language as the email, each at most two sentences and starting with a greeting (for example "Hi Anna!"). One that says yes or confirms, one that asks for more information or proposes something else, one that thanks or politely declines. Write each reply on its own line starting with 1., 2. and 3. No dashes, no emojis, nothing else.',
    ask: 'Suggest three quick replies.'
  }
} as const;

const taskDef = (task: 'summary' | 'todo' | 'quick') => (en() ? TASKS_EN : TASKS)[task];

// Meddelanden för sammanfattning, att göra och snabbsvar. Hela tråden skickas med.
export function buildTaskMessages(task: 'summary' | 'todo' | 'quick', input: PromptInput): ChatMessage[] {
  const t = taskDef(task);
  const who = en() ? `The user is named ${input.ownName || 'the user'} (${input.ownEmail}).` : `Användaren heter ${input.ownName || 'användaren'} (${input.ownEmail}).`;
  const tone = task === 'quick' ? (en() ? ` Tone: ${input.tone}` : ` Ton: ${input.tone}`) : '';
  return [
    { role: 'system', content: `${t.system} ${who}${tone}` },
    { role: 'user', content: `${contextText(input)}<mejl>\n${threadText(input.message)}\n</mejl>\n\n${t.ask}` }
  ];
}

export function taskCliPrompt(task: 'summary' | 'todo' | 'quick'): string {
  if (en()) return `The email and background are in the input. ${taskDef(task).ask} Answer with the answer only.`;
  return `Mejlet och bakgrunden finns i indata. ${taskDef(task).ask} Svara bara med svaret.`;
}

// Plockar ut de tre snabbsvaren ur modellens svar.
export function parseQuickReplies(text: string): string[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  let cur: string | null = null;
  for (const raw of lines) {
    const m = raw.match(/^\s*(?:[1-3][.)]|[-*•])\s+(.*)$/);
    if (m) {
      if (cur) out.push(cur.trim());
      cur = m[1];
    } else if (cur !== null && raw.trim()) cur += ` ${raw.trim()}`;
  }
  if (cur) out.push(cur.trim());
  return out
    .map((s) => s.replace(/^["“”']|["“”']$/g, '').trim())
    .filter(Boolean)
    .slice(0, 3);
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function buildMessages(input: PromptInput): ChatMessage[] {
  const msgs: ChatMessage[] = [
    { role: 'system', content: systemPrompt(input) },
    { role: 'user', content: userPrompt(input) }
  ];
  for (const t of input.history) msgs.push({ role: t.role, content: t.content });
  if (input.instruction) {
    const current = input.draft?.trim();
    msgs.push({
      role: 'user',
      content: current
        ? en()
          ? `Current draft (may have been edited by hand):\n\n<utkast>\n${current}\n</utkast>\n\nChange the draft like this: ${input.instruction}\nAnswer with the whole new draft only.`
          : `Nuvarande utkast (kan vara redigerat för hand):\n\n<utkast>\n${current}\n</utkast>\n\nÄndra utkastet så här: ${input.instruction}\nSvara bara med hela det nya utkastet.`
        : en()
          ? `Change the draft like this: ${input.instruction}\nAnswer with the whole new draft only.`
          : `Ändra utkastet så här: ${input.instruction}\nSvara bara med hela det nya utkastet.`
    });
  }
  return msgs;
}

export function flattenForCli(msgs: ChatMessage[]): { system: string; prompt: string; stdin: string } {
  const system = msgs.find((m) => m.role === 'system')?.content ?? '';
  const rest = msgs.filter((m) => m.role !== 'system');
  const first = rest[0];
  const later = rest.slice(1);
  const convo = later.map((m) => `${m.role === 'user' ? (en() ? 'THE USER' : 'ANVÄNDAREN') : en() ? 'YOUR PREVIOUS DRAFT' : 'DITT TIDIGARE UTKAST'}:\n${m.content}`).join('\n\n');
  const stdin = first ? first.content : '';
  const prompt = en()
    ? later.length
      ? `The email to answer is in the input. Earlier in the conversation:\n\n${convo}\n\nAnswer with the whole new draft only, no comment.`
      : 'The email to answer is in the input. Answer with the draft reply only, no comment.'
    : later.length
      ? `Mejlet som ska besvaras finns i indata. Tidigare i samtalet:\n\n${convo}\n\nSvara bara med hela det nya utkastet, ingen kommentar.`
      : 'Mejlet som ska besvaras finns i indata. Svara bara med svarsutkastet, ingen kommentar.';
  return { system, prompt, stdin };
}
