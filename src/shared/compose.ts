import { locale, t } from './i18n';
import type { AccountConfig, Address, ComposeDraft, ComposeMode, FullMessage } from './types';
import { htmlToPlain, looksLikeHtml, quoteBlockHtml, signatureBlock, textToEditorHtml } from './richtext';

export function formatAddress(a: Address): string {
  if (!a.name || a.name.toLowerCase() === a.address.toLowerCase()) return a.address;
  const needsQuotes = /[",;<>@()]/.test(a.name);
  return needsQuotes ? `"${a.name.replace(/"/g, '')}" <${a.address}>` : `${a.name} <${a.address}>`;
}

export function displayName(a: Address): string {
  return a.name || a.address;
}

export function prefixSubject(subject: string, prefix: 'Re' | 'Fwd'): string {
  const s = subject.trim();
  const re = prefix === 'Re' ? /^(re|sv|aw|vs)\s*:/i : /^(fwd?|vb|wg|tr)\s*:/i;
  if (re.test(s)) return s;
  return `${prefix}: ${s || t('(inget ämne)')}`;
}

export function parseAddressList(input: string): Address[] {
  const out: Address[] = [];
  const parts = input.match(/("[^"]*"|[^,;])+/g) ?? [];
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    const m = p.match(/^(.*)<([^>]+)>$/);
    if (m) out.push({ name: m[1].trim().replace(/^"|"$/g, ''), address: m[2].trim().toLowerCase() });
    else out.push({ name: '', address: p.toLowerCase() });
  }
  return out;
}

function uniqueAddresses(list: Address[], exclude: string[]): Address[] {
  const seen = new Set(exclude.map((e) => e.toLowerCase()));
  const out: Address[] = [];
  for (const a of list) {
    const key = a.address.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

const dateFmt = (ts: number) => new Intl.DateTimeFormat(locale(), { dateStyle: 'long', timeStyle: 'short' }).format(new Date(ts));

export function quoteHeader(msg: FullMessage): string {
  return t('Den {date} skrev {name}:', { date: dateFmt(msg.date), name: formatAddress(msg.from) });
}

export function quoteText(msg: FullMessage): string {
  const header = quoteHeader(msg);
  const body = msg.body.text.replace(/\r/g, '').trimEnd();
  return `${header}\n${body
    .split('\n')
    .map((l) => (l.startsWith('>') ? `>${l}` : `> ${l}`))
    .join('\n')}`;
}

export function forwardHeaderLines(msg: FullMessage): string[] {
  const lines = [
    t('---------- Vidarebefordrat meddelande ---------'),
    `${t('Från')}: ${formatAddress(msg.from)}`,
    `${t('Datum')}: ${dateFmt(msg.date)}`,
    `${t('Ämne')}: ${msg.subject}`,
    `${t('Till')}: ${msg.to.map(formatAddress).join(', ')}`
  ];
  if (msg.cc.length) lines.push(`${t('Kopia')}: ${msg.cc.map(formatAddress).join(', ')}`);
  return lines;
}

export function forwardHeader(msg: FullMessage): string {
  return `${forwardHeaderLines(msg).join('\n')}\n\n${msg.body.text.replace(/\r/g, '').trimEnd()}`;
}

export function buildDraft(mode: ComposeMode, account: AccountConfig, msg?: FullMessage): ComposeDraft {
  // Textdelen får signaturen som ren text, aldrig som HTML-kod.
  const sigRaw = account.signature?.trim() ?? '';
  const sigText = looksLikeHtml(sigRaw) ? htmlToPlain(sigRaw) : sigRaw;
  const signature = sigText ? `\n\n${sigText}` : '';
  const sigBlock = signatureBlock(account.signature);
  const base: ComposeDraft = {
    accountId: account.id,
    to: '',
    cc: '',
    bcc: '',
    subject: '',
    text: signature,
    html: sigBlock ? `<div><br></div><div><br></div>${sigBlock}` : '<div><br></div>',
    quote: '',
    quoteHtml: '',
    forwardAttachments: []
  };
  if (mode === 'new' || !msg) return base;
  const own = account.email.toLowerCase();
  if (mode === 'draft') {
    // Ett sparat utkast öppnas igen: allt ligger redan i brödtexten, inget nytt citat.
    return {
      ...base,
      to: msg.to.map(formatAddress).join(', '),
      cc: msg.cc.map(formatAddress).join(', '),
      subject: msg.subject,
      text: msg.body.text,
      html: msg.body.html ? msg.body.html : textToEditorHtml(msg.body.text),
      inReplyTo: msg.body.inReplyTo ?? undefined,
      references: msg.body.references.length ? msg.body.references : undefined,
      forwardAttachments: msg.body.attachments.filter((a) => !a.inline),
      forwardOf: msg.body.attachments.some((a) => !a.inline) ? msg.id : undefined,
      draftOf: msg.id
    };
  }
  if (mode === 'forward') {
    return {
      ...base,
      subject: prefixSubject(msg.subject, 'Fwd'),
      quote: forwardHeader(msg),
      quoteHtml: quoteBlockHtml(forwardHeaderLines(msg)[0], `${forwardHeaderLines(msg).slice(1).join('\n')}\n\n${msg.body.text}`),
      forwardAttachments: msg.body.attachments.filter((a) => !a.inline),
      forwardOf: msg.id
    };
  }
  const replyTarget = msg.body.replyTo.length ? msg.body.replyTo : [msg.from];
  const sentByMe = msg.from.address.toLowerCase() === own;
  let to = sentByMe ? msg.to : replyTarget;
  let cc: Address[] = [];
  if (mode === 'replyAll') {
    to = uniqueAddresses(sentByMe ? msg.to : [...replyTarget], [own]);
    cc = uniqueAddresses(
      [...(sentByMe ? [] : msg.to), ...msg.cc],
      [own, ...to.map((a) => a.address)]
    );
  }
  const references = [...msg.body.references];
  if (msg.messageId && !references.includes(msg.messageId)) references.push(msg.messageId);
  return {
    ...base,
    to: to.map(formatAddress).join(', '),
    cc: cc.map(formatAddress).join(', '),
    subject: prefixSubject(msg.subject, 'Re'),
    quote: quoteText(msg),
    quoteHtml: quoteBlockHtml(quoteHeader(msg), msg.body.text),
    inReplyTo: msg.messageId || undefined,
    references
  };
}

const DASH_CLASS = `[${String.fromCharCode(0x2013, 0x2014)}]`;
const DASH_RANGE = new RegExp(`(\\d)\\s*${DASH_CLASS}\\s*(?=\\d)`, 'g');
const DASH_SPACED = new RegExp(`\\s*${DASH_CLASS}\\s*`, 'g');

export function removeDashes(text: string): string {
  return text
    .replace(DASH_RANGE, `$1 ${t('till')} `)
    .replace(DASH_SPACED, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/,\s*([.!?])/g, '$1');
}

export function cleanAiText(text: string): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  t = t.replace(/^```[a-z]*\n?|```\s*$/gim, '');
  t = t.replace(/^\s*(Ämne|Subject)\s*:.*\n+/i, '');
  return removeDashes(t).trim();
}
