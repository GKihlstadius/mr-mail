import type { AccountConfig, AccountStatus, AttachmentInfo, Folder, FolderRole, FullMessage, InviteResponse, MessageSummary, OutgoingAttachment, OutgoingMessage, Settings } from '../shared/types';
import { inviteSummary, responseFrom } from './invite';
import type { CalendarEvent, CalendarInfo, EventInput } from '../shared/calendar';
import { addDays, isoDate } from '../shared/ics';
import { parseAddressList } from '../shared/compose';
import { TOOL_ALIASES, type AgentArgs } from '../shared/agentTools';
import { APP_NAME } from '../shared/brand';
import type { CleanAction, SenderCategory, SenderStat } from '../shared/cleanup';
import { buildDraft, formatAddress, removeDashes } from '../shared/compose';
import { htmlToPlain, outgoingHtml, signatureBlock, textToEditorHtml } from '../shared/richtext';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import { attachmentText } from './filetext';

const MAX_ATTACH = 25 * 1024 * 1024;

function safeFileName(name: string): string {
  return basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180) || 'attachment';
}

// Gamla svenska verktygsnamn och fältnamn. Anrop med dem översätts till de engelska före utförandet,
// så att agenter som redan är inställda på den gamla listan fortsätter fungera.

const ARG_ALIASES: Record<string, string> = {
  konto: 'account',
  mapp: 'folder',
  bara_olasta: 'unread_only',
  antal: 'limit',
  fraga: 'query',
  markera_last: 'mark_read',
  bilaga: 'attachment',
  till: 'to',
  kopia: 'cc',
  hemlig_kopia: 'bcc',
  amne: 'subject',
  svar_pa: 'reply_to',
  svara_alla: 'reply_all',
  vidarebefordra: 'forward',
  bilagor: 'attachments',
  ta_bort_bilagor: 'remove_attachments',
  oppna: 'open',
  skicka_kl: 'send_at',
  last: 'read',
  flaggad: 'flagged',
  kategori: 'category',
  adress: 'address',
  atgard: 'action',
  alltid: 'always',
  aldre_an_dagar: 'older_than_days',
  namn: 'name',
  i_mapp: 'parent_folder',
  tid: 'time',
  svar: 'response',
  kommentar: 'comment',
  titel: 'title',
  slut: 'end',
  heldag: 'all_day',
  plats: 'location',
  beskrivning: 'description',
  deltagare: 'attendees',
  kalender: 'calendar',
  fran: 'from',
  langd_minuter: 'duration_minutes',
  arbetsdag_start: 'work_start',
  arbetsdag_slut: 'work_end',
  helger: 'include_weekends'
};

// Översätter gamla fältnamn till nya. Ett nytt namn som redan finns går före det gamla.
export function normalizeArgs(args: AgentArgs): AgentArgs {
  const out: AgentArgs = {};
  for (const [k, v] of Object.entries(args)) {
    const key = Object.prototype.hasOwnProperty.call(ARG_ALIASES, k) ? ARG_ALIASES[k] : k;
    if (key !== k && Object.prototype.hasOwnProperty.call(args, key)) continue;
    out[key] = v;
  }
  return out;
}

const CATEGORY_WORDS: Record<string, SenderCategory> = {
  newsletter: 'newsletter',
  newsletters: 'newsletter',
  nyhetsbrev: 'newsletter',
  notification: 'notification',
  notifications: 'notification',
  aviseringar: 'notification',
  avisering: 'notification',
  receipt: 'receipt',
  receipts: 'receipt',
  kvitton: 'receipt',
  kvitto: 'receipt',
  social: 'social',
  sociala: 'social',
  personal: 'personal',
  personligt: 'personal'
};

const CATEGORY_NAME: Record<SenderCategory, string> = {
  newsletter: 'newsletters',
  notification: 'notifications',
  receipt: 'receipts',
  social: 'social',
  personal: 'personal'
};

// Ett ledigt filnamn i mappen, så att inget skrivs över: "fil.docx", "fil (2).docx" och så vidare.
function freePath(dir: string, name: string): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let p = join(dir, name);
  for (let i = 2; existsSync(p); i++) p = join(dir, `${stem} (${i})${ext}`);
  return p;
}

// Utför verktygsanropen från AI-agenter. Appen ger tillgång till cache, konton och åtgärder via AgentHost.
export interface AgentHost {
  accounts(): AccountConfig[];
  statuses(): AccountStatus[];
  settings(): Settings;
  folders(): Folder[];
  rolePath(accountId: string, role: FolderRole): string | null;
  listFolder(accountId: string, path: string, limit: number): MessageSummary[];
  listUnified(role: FolderRole, limit: number): MessageSummary[];
  search(query: string, limit: number): Promise<MessageSummary[]>;
  getMessage(id: string): MessageSummary | null;
  open(id: string, markSeen: boolean): Promise<FullMessage>;
  thread(id: string): MessageSummary[];
  send(msg: OutgoingMessage): Promise<void>;
  saveDraft(msg: OutgoingMessage): Promise<string | null>;
  setFlag(id: string, flag: 'seen' | 'flagged', value: boolean): Promise<void>;
  moveToRole(id: string, role: FolderRole): Promise<void>;
  moveToPath(id: string, path: string): Promise<void>;
  showMessage(id: string): void;
  openDraft(id: string): void;
  notifySent(subject: string, to: string): void;
  senders(accountId?: string): SenderStat[];
  unsubscribe(address: string): Promise<{ method: string }>;
  cleanBulk(address: string, action: CleanAction, olderThanDays?: number, accountId?: string): Promise<number>;
  setRule(address: string, action: CleanAction | null): void;
  attachment(id: string, index: number): Promise<{ filename: string; contentType: string; content: Buffer }>;
  contacts(query: string): { name: string; address: string; count: number }[];
  remind(id: string, due: number | null): void;
  sendLater(msg: OutgoingMessage, at: number): Promise<void>;
  createFolder(accountId: string, name: string, parent?: string): Promise<string>;
  downloadsDir(): string;
  tempDir(): string;
  inviteAnswer(id: string): InviteResponse | null;
  respondInvite(id: string, response: InviteResponse, comment?: string): Promise<{ calendar: boolean }>;
  calendars(): CalendarInfo[];
  calendarEvents(from: number, to: number, filter: { accountId?: string; calendar?: string; query?: string }): Promise<CalendarEvent[]>;
  freeSlots(o: { from: number; to: number; durationMin: number; workStart?: string; workEnd?: string; weekends?: boolean; accountId?: string }): Promise<{ start: number; end: number }[]>;
  createEvent(input: EventInput, calendar?: string, accountId?: string): Promise<CalendarEvent>;
  updateEvent(id: string, patch: Partial<EventInput>): Promise<CalendarEvent>;
  deleteEvent(id: string): Promise<CalendarEvent>;
  getEvent(id: string): CalendarEvent | null;
}

export class AgentError extends Error {}

// Byter ut det egna skrivna i ett utkast men behåller signatur och citat.
export function replaceOwnHtml(html: string, ownHtml: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const wrap = /^\s*<div style="[^"]*">([\s\S]*)<\/div>\s*$/.exec(body);
  const inner = wrap ? wrap[1] : body;
  const sig = inner.search(/<div[^>]*class="[^"]*brevlada-signature/);
  let cut = sig;
  if (cut < 0) {
    const quote = inner.search(/<blockquote/i);
    if (quote >= 0) {
      // Raden "Den ... skrev:" står i en egen div precis före citatet.
      const header = inner.lastIndexOf('<div>', quote);
      cut = header >= 0 ? header : quote;
    }
  }
  const rest = cut >= 0 ? inner.slice(cut) : '';
  const lead = rest && !/^<div><br><\/div>/.test(rest) ? '<div><br></div>' : '';
  return outgoingHtml(`${ownHtml}${lead}${rest}`, '');
}

export function replaceOwnText(old: string, own: string, cfg: AccountConfig): string {
  const clean = old.replace(/\r/g, '');
  const sig = buildDraft('new', cfg).text.trim();
  let cut = sig ? clean.indexOf(sig.split('\n')[0]) : -1;
  if (cut < 0) {
    const q = /\n[^\n]*\n> /.exec(clean);
    cut = q ? q.index + 1 : -1;
  }
  return cut >= 0 ? `${own}\n\n${clean.slice(cut)}` : own;
}

// Filer från disken som ska bifogas, kontrollerade.
function localFiles(v: unknown): OutgoingAttachment[] {
  const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : typeof v === 'string' && v.trim() ? [v] : [];
  let total = 0;
  return list.map((raw) => {
    const path = raw.trim();
    if (!isAbsolute(path)) throw new AgentError(`Give the full path to the file: ${path}`);
    if (!existsSync(path) || !statSync(path).isFile()) throw new AgentError(`The file does not exist: ${path}`);
    const size = statSync(path).size;
    total += size;
    if (total > MAX_ATTACH) throw new AgentError('The attachments add up to more than 25 MB, too large for email.');
    return { filename: basename(path), path, size };
  });
}

const ROLE_WORDS: Record<string, FolderRole> = {
  inkorg: 'inbox',
  inbox: 'inbox',
  skickat: 'sent',
  skickade: 'sent',
  sent: 'sent',
  utkast: 'drafts',
  drafts: 'drafts',
  arkiv: 'archive',
  arkivet: 'archive',
  archive: 'archive',
  'alla mejl': 'archive',
  papperskorg: 'trash',
  papperskorgen: 'trash',
  trash: 'trash',
  skrap: 'junk',
  skräp: 'junk',
  skräppost: 'junk',
  junk: 'junk',
  spam: 'junk'
};

const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const n = (v: unknown, def: number, max: number) => Math.max(1, Math.min(max, typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def));

// "YYYY-MM-DD HH:MM" i lokal tid. Utan klockslag blir det 08:00.
function parseWhen(when: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(when.trim());
  if (!m) throw new AgentError('Give the time as YYYY-MM-DD HH:MM (local time).');
  const due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] ? Number(m[4]) : 8, m[5] ? Number(m[5]) : 0).getTime();
  if (due <= Date.now()) throw new AgentError('That time has already passed.');
  return due;
}

// Tid för kalendern: "YYYY-MM-DD" eller "YYYY-MM-DD HH:MM" i lokal tid. Får ligga bakåt i tiden.
export function parseCalendarTime(v: string): { ms: number; date: string; dateOnly: boolean } {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(v.trim());
  if (!m) throw new AgentError(`Give the time as YYYY-MM-DD or YYYY-MM-DD HH:MM (local time), not "${v}".`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0);
  if (d.getMonth() !== Number(m[2]) - 1) throw new AgentError(`No such date: ${v}.`);
  return { ms: d.getTime(), date: `${m[1]}-${m[2]}-${m[3]}`, dateOnly: !m[4] };
}

const localIso = (ms: number) => {
  const d = new Date(ms);
  return isoDate({ y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate() });
};

function attendeeList(v: unknown): { name: string; email: string }[] {
  const raw = Array.isArray(v) ? v.map(String).join(', ') : typeof v === 'string' ? v : '';
  const list = parseAddressList(raw);
  const bad = list.filter((a) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.address));
  if (bad.length) throw new AgentError(`Not an email address: ${bad.map((a) => a.address).join(', ')}. Use find_contact to look up addresses.`);
  return list.map((a) => ({ name: a.name, email: a.address.toLowerCase() }));
}

function date(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function createAgent(host: AgentHost) {
  const accountById = (id: string) => host.accounts().find((a) => a.id === id);

  function findAccount(spec: string): AccountConfig {
    const q = spec.toLowerCase();
    const all = host.accounts();
    const hit = all.find((a) => a.email.toLowerCase() === q) ?? all.find((a) => a.name.toLowerCase() === q) ?? all.find((a) => a.id === spec);
    if (!hit) throw new AgentError(`No account "${spec}" found. Accounts: ${all.map((a) => `${a.name} <${a.email}>`).join(', ')}.`);
    return hit;
  }

  function folderPath(accountId: string, spec: string): string {
    const role = ROLE_WORDS[spec.toLowerCase()];
    if (role) {
      const path = host.rolePath(accountId, role);
      if (!path) throw new AgentError(`The account has no ${spec} folder.`);
      return path;
    }
    const folders = host.folders().filter((f) => f.accountId === accountId);
    const hit = folders.find((f) => f.path === spec) ?? folders.find((f) => f.name.toLowerCase() === spec.toLowerCase());
    if (!hit) throw new AgentError(`No folder "${spec}" found. Folders: ${folders.map((f) => f.name).join(', ')}.`);
    return hit.path;
  }

  function summary(m: MessageSummary) {
    const acc = accountById(m.accountId);
    const folder = host.folders().find((f) => f.accountId === m.accountId && f.path === m.folder);
    return {
      id: m.id,
      date: date(m.date),
      from: formatAddress(m.from),
      subject: m.subject || '(no subject)',
      account: acc?.email ?? m.accountId,
      folder: folder?.name ?? m.folder,
      unread: !m.seen,
      flagged: m.flagged || undefined,
      answered: m.answered || undefined,
      attachments: m.hasAttachments || undefined,
      thread_length: m.threadCount && m.threadCount > 1 ? m.threadCount : undefined,
      snippet: m.preview?.slice(0, 160)
    };
  }

  function message(full: FullMessage) {
    const text = full.body.text?.trim() || htmlToPlain(full.body.html ?? '');
    const invite = full.body.invite ? inviteSummary(full, host.inviteAnswer(full.id), date) : '';
    return [
      `Id: ${full.id}`,
      `From: ${formatAddress(full.from)}`,
      `To: ${full.to.map(formatAddress).join(', ')}`,
      full.cc.length ? `Cc: ${full.cc.map(formatAddress).join(', ')}` : '',
      full.body.replyTo.length ? `Reply-To: ${full.body.replyTo.map(formatAddress).join(', ')}` : '',
      `Date: ${date(full.date)}`,
      `Subject: ${full.subject}`,
      `Account: ${accountById(full.accountId)?.email ?? full.accountId}`,
      fileAttachments(full).length
        ? `Attachments (read with read_attachment, save with save_attachment): ${fileAttachments(full)
            .map((a, i) => `${i + 1}. ${a.filename || 'attachment'} (${Math.max(1, Math.round(a.size / 1024))} kB)`)
            .join(', ')}`
        : '',
      invite ? `\n${invite}` : '',
      '',
      text.length > 40000 ? `${text.slice(0, 40000)}\n[the text is truncated]` : text
    ]
      .filter((l, i) => l !== '' || i > 9)
      .join('\n');
  }

  function fileAttachments(full: FullMessage): AttachmentInfo[] {
    return full.body.attachments.filter((a) => !a.inline);
  }

  function pickAttachments(full: FullMessage, spec: string): AttachmentInfo[] {
    const files = fileAttachments(full);
    if (!files.length) throw new AgentError('The email has no attachments.');
    if (!spec) return files;
    const num = /^\d+$/.test(spec) ? Number(spec) : NaN;
    const q = spec.toLowerCase();
    const hit = Number.isFinite(num)
      ? files[num - 1]
      : (files.find((a) => a.filename?.toLowerCase() === q) ?? files.find((a) => a.filename?.toLowerCase().includes(q)));
    if (!hit) throw new AgentError(`No attachment "${spec}" found. Attachments: ${files.map((a, i) => `${i + 1}. ${a.filename}`).join(', ')}.`);
    return [hit];
  }

  // Bygger det utgående mejlet på samma sätt som svarsfönstret: signatur, citat och trådrubriker.
  async function compose(raw: AgentArgs): Promise<OutgoingMessage> {
    const args = normalizeArgs(raw);
    const text = removeDashes(s(args.text).replace(/\r/g, ''));
    if (!text) throw new AgentError('The text is empty.');
    const replyId = s(args.reply_to);
    const fwdId = s(args.forward);
    let source: FullMessage | undefined;
    let mode: 'new' | 'reply' | 'replyAll' | 'forward' = 'new';
    if (replyId) {
      source = await host.open(replyId, false);
      mode = args.reply_all ? 'replyAll' : 'reply';
    } else if (fwdId) {
      source = await host.open(fwdId, false);
      mode = 'forward';
    }
    const cfg = s(args.account) ? findAccount(s(args.account)) : source ? accountById(source.accountId) : host.accounts()[0];
    if (!cfg) throw new AgentError('There is no account to send from.');
    const d = buildDraft(mode, cfg, source);
    const to = s(args.to) || d.to;
    if (!to) throw new AgentError('Recipient missing (to).');
    const body = textToEditorHtml(text) + (cfg.signature?.trim() ? `<div><br></div>${signatureBlock(cfg.signature)}` : '');
    const sigText = d.text.trim();
    const plain = [text, sigText].filter(Boolean).join('\n\n');
    return {
      accountId: cfg.id,
      to,
      cc: s(args.cc) || d.cc,
      bcc: s(args.bcc),
      subject: s(args.subject) || d.subject,
      text: d.quote ? `${plain}\n\n${d.quote}` : plain,
      html: outgoingHtml(body, d.quoteHtml),
      inReplyTo: d.inReplyTo,
      references: d.references,
      attachments: localFiles(args.attachments),
      forwardOf: d.forwardOf
    };
  }

  function idList(v: unknown): string[] {
    const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : typeof v === 'string' && v ? [v] : [];
    if (!list.length) throw new AgentError('No emails given (ids).');
    return list;
  }

  async function forEach(ids: string[], fn: (id: string) => Promise<void>): Promise<string> {
    const failed: string[] = [];
    for (const id of ids) {
      if (!host.getMessage(id)) {
        failed.push(`${id}: does not exist (the list may have changed, fetch it again)`);
        continue;
      }
      await fn(id).catch((e: any) => failed.push(`${id}: ${e?.message ?? e}`));
    }
    const ok = ids.length - failed.length;
    return failed.length ? `${ok} of ${ids.length} done. Errors:\n${failed.join('\n')}` : `Done, ${ok} emails.`;
  }

  const tools: Record<string, (a: AgentArgs) => Promise<string>> = {
    async accounts() {
      const st = new Map(host.statuses().map((x) => [x.id, x]));
      const STATE: Record<string, string> = {
        online: 'connected',
        syncing: 'syncing',
        connecting: 'connecting',
        'needs-password': 'needs password',
        error: 'error',
        offline: 'offline'
      };
      const list = host.accounts().map((a) => ({
        name: a.name,
        address: a.email,
        sender_name: a.displayName,
        status: STATE[st.get(a.id)?.state ?? 'offline'] ?? st.get(a.id)?.state,
        error: st.get(a.id)?.error,
        unread: st.get(a.id)?.unread ?? 0,
        signature: a.signature?.trim() ? 'yes, added automatically' : 'none'
      }));
      return JSON.stringify({ accounts: list, writing_tone: host.settings().tone }, null, 1);
    },

    async list_emails(a) {
      const limit = n(a.limit, 25, 200);
      const mailbox = s(a.folder) || 'inbox';
      let items: MessageSummary[];
      if (s(a.account)) {
        const cfg = findAccount(s(a.account));
        items = host.listFolder(cfg.id, folderPath(cfg.id, mailbox), a.unread_only ? 2000 : limit);
      } else {
        const role = ROLE_WORDS[mailbox.toLowerCase()];
        if (!role) throw new AgentError('Give an account for a custom folder.');
        items = host.listUnified(role, a.unread_only ? 2000 : limit);
      }
      if (a.unread_only) items = items.filter((m) => !m.seen);
      items = items.slice(0, limit);
      if (!items.length) return 'No emails.';
      return JSON.stringify(items.map(summary), null, 1);
    },

    async search_emails(a) {
      const q = s(a.query);
      if (!q) throw new AgentError('The search query is empty.');
      const hits = (await host.search(q, n(a.limit, 25, 200))).slice(0, n(a.limit, 25, 200));
      return hits.length ? JSON.stringify(hits.map(summary), null, 1) : 'No results.';
    },

    async read_email(a) {
      const full = await host.open(s(a.id), a.mark_read === true);
      return message(full);
    },

    async read_attachment(a) {
      const id = s(a.id);
      const full = await host.open(id, false);
      const files = pickAttachments(full, s(a.attachment));
      if (files.length > 1) throw new AgentError(`The email has several attachments, say which one: ${files.map((x, i) => `${i + 1}. ${x.filename}`).join(', ')}.`);
      const att = await host.attachment(id, files[0].index);
      const name = att.filename || files[0].filename || 'attachment';
      const text = attachmentText(name, att.contentType || files[0].contentType || '', att.content);
      if (text !== null && text.trim()) {
        const t = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
        return `Attachment: ${name}\n\n${t.length > 60000 ? `${t.slice(0, 60000)}\n[the text is truncated]` : t}`;
      }
      const dir = join(host.tempDir(), String(Date.now()));
      mkdirSync(dir, { recursive: true });
      const path = join(dir, safeFileName(name));
      writeFileSync(path, att.content);
      return `The attachment ${name} (${att.contentType || 'unknown type'}) cannot be read as text here. It is saved as ${path}; read the file from there.`;
    },

    async save_attachment(a) {
      const id = s(a.id);
      const full = await host.open(id, false);
      const files = pickAttachments(full, s(a.attachment));
      const dir = s(a.folder) || host.downloadsDir();
      if (!isAbsolute(dir)) throw new AgentError('Give the full path to the folder.');
      mkdirSync(dir, { recursive: true });
      const saved: string[] = [];
      for (const f of files) {
        const att = await host.attachment(id, f.index);
        const path = freePath(dir, safeFileName(att.filename || f.filename || 'attachment'));
        writeFileSync(path, att.content);
        saved.push(path);
      }
      return `Saved:\n${saved.join('\n')}`;
    },

    async read_thread(a) {
      const id = s(a.id);
      if (!host.getMessage(id)) throw new AgentError('The email does not exist.');
      const list = host.thread(id);
      const ids = (list.length ? list : [host.getMessage(id)!]).sort((x, y) => x.date - y.date).map((m) => m.id);
      const parts: string[] = [];
      for (const mid of ids.slice(-15)) parts.push(message(await host.open(mid, false)));
      return parts.join('\n\n---\n\n');
    },

    async draft_email(a) {
      const msg = await compose(a);
      const id = await host.saveDraft(msg);
      if (id && a.open !== false) host.openDraft(id);
      return id
        ? `The draft is in Drafts${a.open !== false ? ` and open in ${APP_NAME}` : ''}. Id: ${id}\nTo: ${msg.to}${msg.cc ? `\nCc: ${msg.cc}` : ''}\nSubject: ${msg.subject}${msg.attachments.length ? `\nAttachments: ${msg.attachments.map((x) => x.filename).join(', ')}` : ''}`
        : `The draft is saved in Drafts but has no id yet. To: ${msg.to}, subject: ${msg.subject}`;
    },

    async send_email(a) {
      const at = s(a.send_at) ? parseWhen(s(a.send_at)) : 0;
      const msg = await compose(a);
      if (at) {
        await host.sendLater(msg, at);
        return `The email will be sent ${date(at)} from ${accountById(msg.accountId)?.email}. It waits in the outbox in ${APP_NAME} and can be undone there.\nTo: ${msg.to}\nSubject: ${msg.subject}`;
      }
      await host.send(msg);
      host.notifySent(msg.subject, msg.to);
      return `Sent from ${accountById(msg.accountId)?.email}.\nTo: ${msg.to}${msg.cc ? `\nCc: ${msg.cc}` : ''}\nSubject: ${msg.subject}${msg.attachments.length ? `\nAttachments: ${msg.attachments.map((x) => x.filename).join(', ')}` : ''}`;
    },

    async edit_draft(a) {
      const id = s(a.id);
      const m = host.getMessage(id);
      if (!m) throw new AgentError('The draft does not exist. Fetch the list again with list_emails folder: drafts.');
      if (host.rolePath(m.accountId, 'drafts') !== m.folder) throw new AgentError('The email is not in Drafts.');
      const cfg = accountById(m.accountId)!;
      const full = await host.open(id, false);
      const d = buildDraft('draft', cfg, full);
      let html = full.body.html ?? outgoingHtml(textToEditorHtml(full.body.text), '');
      let text = d.text;
      const newText = removeDashes(s(a.text).replace(/\r/g, ''));
      if (newText) {
        html = replaceOwnHtml(html, textToEditorHtml(newText));
        text = replaceOwnText(d.text, newText, cfg);
      }
      const msg: OutgoingMessage = {
        accountId: cfg.id,
        to: s(a.to) || d.to,
        cc: a.cc !== undefined ? s(a.cc) : d.cc,
        bcc: s(a.bcc),
        subject: s(a.subject) || d.subject,
        text,
        html,
        inReplyTo: d.inReplyTo,
        references: d.references,
        attachments: localFiles(a.attachments),
        forwardOf: d.forwardOf,
        draftOf: id
      };
      // Bilagor som ska bort: de som blir kvar hämtas och läggs till som filer i stället.
      const remove = Array.isArray(a.remove_attachments) ? a.remove_attachments.map((x) => String(x).trim()).filter(Boolean) : [];
      let kept = fileAttachments(full);
      if (remove.length) {
        const drop = new Set(remove.flatMap((r) => pickAttachments(full, r)));
        kept = kept.filter((x) => !drop.has(x));
        const dir = join(host.tempDir(), `draft-${Date.now()}`);
        mkdirSync(dir, { recursive: true });
        const files: OutgoingAttachment[] = [];
        for (const x of kept) {
          const att = await host.attachment(id, x.index);
          const path = freePath(dir, safeFileName(att.filename || x.filename || 'attachment'));
          writeFileSync(path, att.content);
          files.push({ filename: basename(path), path, size: att.content.length });
        }
        msg.attachments = [...files, ...msg.attachments];
        msg.forwardOf = undefined;
      }
      const newId = await host.saveDraft(msg);
      if (newId && a.open !== false) host.openDraft(newId);
      const files = msg.forwardOf ? [...kept.map((x) => x.filename), ...msg.attachments.map((x) => x.filename)] : msg.attachments.map((x) => x.filename);
      return [
        `The draft is updated${newId && a.open !== false ? ` and open in ${APP_NAME}` : ''}. Id: ${newId ?? '(none yet)'}`,
        `To: ${msg.to}`,
        msg.cc ? `Cc: ${msg.cc}` : '',
        `Subject: ${msg.subject}`,
        files.length ? `Attachments: ${files.join(', ')}` : ''
      ]
        .filter(Boolean)
        .join('\n');
    },

    async create_folder(a) {
      const cfg = findAccount(s(a.account));
      const name = s(a.name).replace(/[\\/]/g, ' ').trim();
      if (!name) throw new AgentError('The folder needs a name.');
      const parent = s(a.parent_folder) ? folderPath(cfg.id, s(a.parent_folder)) : undefined;
      const path = await host.createFolder(cfg.id, name, parent);
      return `The folder ${name} is created in ${cfg.email} (${path}).`;
    },

    async find_contact(a) {
      const q = s(a.query);
      if (!q) throw new AgentError('Give a name or part of the address.');
      const hits = host.contacts(q);
      return hits.length ? hits.map((c) => `${c.name ? `${c.name} <${c.address}>` : c.address} (${c.count} emails)`).join('\n') : 'No match.';
    },

    async remind(a) {
      const id = s(a.id);
      if (!host.getMessage(id)) throw new AgentError('The email does not exist.');
      const when = s(a.time);
      if (!when) {
        host.remind(id, null);
        return 'The reminder is removed.';
      }
      const due = parseWhen(when);
      host.remind(id, due);
      return `The email is hidden and will come back ${date(due)}.`;
    },

    async send_draft(a) {
      const id = s(a.id);
      const m = host.getMessage(id);
      if (!m) throw new AgentError('The draft does not exist. It may already be sent or deleted.');
      if (host.rolePath(m.accountId, 'drafts') !== m.folder) throw new AgentError('The email is not in Drafts.');
      const cfg = accountById(m.accountId)!;
      const full = await host.open(id, false);
      const d = buildDraft('draft', cfg, full);
      if (!d.to.trim()) throw new AgentError('The draft has no recipient.');
      const msg: OutgoingMessage = {
        accountId: cfg.id,
        to: d.to,
        cc: d.cc,
        bcc: '',
        subject: d.subject,
        text: d.text,
        html: full.body.html ?? outgoingHtml(textToEditorHtml(full.body.text), ''),
        inReplyTo: d.inReplyTo,
        references: d.references,
        attachments: [],
        forwardOf: d.forwardOf,
        draftOf: id
      };
      if (s(a.send_at)) {
        const at = parseWhen(s(a.send_at));
        await host.sendLater(msg, at);
        return `The draft will be sent ${date(at)} from ${cfg.email}. It waits in the outbox in ${APP_NAME} and can be undone there.\nTo: ${msg.to}\nSubject: ${msg.subject}`;
      }
      await host.send(msg);
      host.notifySent(msg.subject, msg.to);
      return `Sent from ${cfg.email}.\nTo: ${msg.to}\nSubject: ${msg.subject}`;
    },

    async archive(a) {
      return forEach(idList(a.ids), (id) => host.moveToRole(id, 'archive'));
    },

    async trash(a) {
      return forEach(idList(a.ids), (id) => host.moveToRole(id, 'trash'));
    },

    async mark(a) {
      if (typeof a.read !== 'boolean' && typeof a.flagged !== 'boolean') throw new AgentError('Give read or flagged.');
      return forEach(idList(a.ids), async (id) => {
        if (typeof a.read === 'boolean') await host.setFlag(id, 'seen', a.read);
        if (typeof a.flagged === 'boolean') await host.setFlag(id, 'flagged', a.flagged);
      });
    },

    async move(a) {
      const list = idList(a.ids);
      const spec = s(a.folder);
      if (!spec) throw new AgentError('Give a folder.');
      return forEach(list, async (id) => {
        const m = host.getMessage(id)!;
        await host.moveToPath(id, folderPath(m.accountId, spec));
      });
    },

    async senders(a) {
      const want = s(a.category).toLowerCase();
      const cat = want ? CATEGORY_WORDS[want] : undefined;
      if (want && !cat) throw new AgentError('Unknown category. Choose newsletters, notifications, receipts, social or personal.');
      const scope = s(a.account) ? findAccount(s(a.account)).id : undefined;
      const list = host
        .senders(scope)
        .filter((x) => !cat || x.category === cat)
        .slice(0, n(a.limit, 30, 300))
        .map((x) => ({
          address: x.address,
          name: x.name || undefined,
          emails: x.total,
          unread: x.unread,
          in_inbox: x.inInbox,
          last: date(x.last),
          category: CATEGORY_NAME[x.category],
          can_unsubscribe: x.unsubscribe || undefined,
          unsubscribed: x.unsubscribed ? date(x.unsubscribed) : undefined,
          rule: x.rule === 'archive' ? 'always archived' : x.rule === 'trash' ? 'always trashed' : undefined,
          latest_subject: x.subject || undefined
        }));
      return list.length ? JSON.stringify(list, null, 1) : 'No senders.';
    },

    async unsubscribe(a) {
      const addr = s(a.address);
      if (!addr) throw new AgentError('Give an address.');
      const r = await host.unsubscribe(addr);
      return r.method === 'browser' ? `The unsubscribe page for ${addr} is open in the browser, the user needs to confirm there.` : `Unsubscribed from ${addr}.`;
    },

    async clean_up(a) {
      const addr = s(a.address);
      const act = s(a.action).toLowerCase();
      const action: CleanAction | null = act === 'archive' || act === 'arkivera' ? 'archive' : act === 'trash' || act === 'radera' ? 'trash' : null;
      if (!addr || !action) throw new AgentError('Give address and action (archive or trash).');
      if (a.always === true) host.setRule(addr, action);
      const days = typeof a.older_than_days === 'number' ? a.older_than_days : undefined;
      const scope = s(a.account) ? findAccount(s(a.account)).id : undefined;
      const moved = await host.cleanBulk(addr, action, days, scope);
      return `${moved} emails from ${addr} ${action === 'archive' ? 'archived' : 'moved to the trash'}.${a.always === true ? ' New emails from the sender are handled the same way automatically.' : ''}`;
    },

    async respond_to_invite(a) {
      const id = s(a.id);
      if (!host.getMessage(id)) throw new AgentError('The email does not exist.');
      const response = responseFrom(a.response);
      if (!response) throw new AgentError('Give response: accept, tentative or decline.');
      const full = await host.open(id, false);
      const inv = full.body.invite;
      if (!inv) throw new AgentError('The email has no calendar invitation.');
      if (inv.method !== 'REQUEST') throw new AgentError(inv.method === 'CANCEL' ? 'The meeting is cancelled, there is nothing to answer.' : 'This calendar email cannot be answered.');
      const res = await host.respondInvite(id, response, s(a.comment) ? removeDashes(s(a.comment)) : undefined);
      const word = response === 'accept' ? 'Accepted' : response === 'tentative' ? 'Answered maybe to' : 'Declined';
      return `${word} "${inv.event.summary || '(no title)'}". The reply is sent to ${inv.event.organizer?.email ?? 'the organizer'}.${res.calendar ? ' The calendar is updated.' : ''}`;
    },

    async list_events(a) {
      if (!host.calendars().length) return 'No calendar is connected. The user can turn on the calendar for an account in the app.';
      const from = s(a.from) ? parseCalendarTime(s(a.from)).ms : new Date(new Date().setHours(0, 0, 0, 0)).getTime();
      const toSpec = s(a.to) ? parseCalendarTime(s(a.to)) : null;
      const to = toSpec ? (toSpec.dateOnly ? toSpec.ms + 86400000 : toSpec.ms) : from + 7 * 86400000;
      if (to <= from) throw new AgentError('"to" must be after "from".');
      const accountId = s(a.account) ? findAccount(s(a.account)).id : undefined;
      const list = (await host.calendarEvents(from, to, { accountId, calendar: s(a.calendar) || undefined, query: s(a.query) || undefined })).slice(0, n(a.limit, 50, 300));
      if (!list.length) return 'No events.';
      return JSON.stringify(list.map(eventSummary), null, 1);
    },

    async find_free_time(a) {
      if (!host.calendars().length) return 'No calendar is connected, so free time cannot be checked.';
      const dur = typeof a.duration_minutes === 'number' ? a.duration_minutes : Number(s(a.duration_minutes));
      if (!Number.isFinite(dur) || dur < 5 || dur > 24 * 60) throw new AgentError('Give duration_minutes, for example 30.');
      const from = s(a.from) ? parseCalendarTime(s(a.from)).ms : Date.now();
      const toSpec = s(a.to) ? parseCalendarTime(s(a.to)) : null;
      const to = toSpec ? (toSpec.dateOnly ? toSpec.ms + 86400000 : toSpec.ms) : from + 7 * 86400000;
      if (to <= from) throw new AgentError('"to" must be after "from".');
      const accountId = s(a.account) ? findAccount(s(a.account)).id : undefined;
      const slots = await host.freeSlots({ from, to, durationMin: dur, workStart: s(a.work_start) || '09:00', workEnd: s(a.work_end) || '17:00', weekends: a.include_weekends === true, accountId });
      if (!slots.length) return 'No free time of that length in the period.';
      return JSON.stringify(slots.map((x) => ({ start: date(x.start), end: date(x.end), minutes: Math.round((x.end - x.start) / 60000) })), null, 1);
    },

    async create_event(a) {
      const title = removeDashes(s(a.title));
      if (!title) throw new AgentError('The event needs a title.');
      if (!s(a.start)) throw new AgentError('Give start as YYYY-MM-DD HH:MM, or YYYY-MM-DD for an all day event.');
      const input = eventTimes(a, null);
      const attendees = a.attendees !== undefined ? attendeeList(a.attendees) : [];
      const accountId = s(a.account) ? findAccount(s(a.account)).id : undefined;
      const ev = await host.createEvent(
        { title, ...input, location: s(a.location) || undefined, description: s(a.description) ? removeDashes(s(a.description)) : undefined, attendees },
        s(a.calendar) || undefined,
        accountId
      );
      return `Created "${ev.title}" ${when(ev)}${attendees.length ? `, invitation sent to ${attendees.map((x) => x.email).join(', ')}` : ''}. Id: ${ev.id}`;
    },

    async update_event(a) {
      const id = s(a.id);
      const ev = host.getEvent(id);
      if (!ev) throw new AgentError('The event does not exist. Get the id with list_events.');
      const patch: Partial<EventInput> = {};
      if (a.title !== undefined) patch.title = removeDashes(s(a.title));
      if (a.location !== undefined) patch.location = s(a.location);
      if (a.description !== undefined) patch.description = removeDashes(s(a.description));
      if (a.start !== undefined || a.end !== undefined || a.all_day !== undefined) Object.assign(patch, eventTimes(a, ev));
      if (a.attendees !== undefined) patch.attendees = attendeeList(a.attendees);
      if (!Object.keys(patch).length) throw new AgentError('Nothing to change. Give title, start, end, all_day, location, description or attendees.');
      const updated = await host.updateEvent(id, patch);
      return `Updated "${updated.title}" ${when(updated)}${updated.attendees.length && updated.isOrganizer ? '. The attendees are told about the change' : ''}. Id: ${updated.id}`;
    },

    async delete_event(a) {
      const id = s(a.id);
      if (!host.getEvent(id)) throw new AgentError('The event does not exist. Get the id with list_events.');
      const ev = await host.deleteEvent(id);
      return `Deleted "${ev.title}" ${when(ev)}${ev.attendees.length && ev.isOrganizer ? '. The attendees are told it is cancelled' : ''}.`;
    },

    async show_in_app(a) {
      const id = s(a.id);
      const m = host.getMessage(id);
      if (!m) throw new AgentError('The email does not exist.');
      if (host.rolePath(m.accountId, 'drafts') === m.folder) host.openDraft(id);
      else host.showMessage(id);
      return `Shown in ${APP_NAME}.`;
    }
  };

  function when(ev: CalendarEvent): string {
    if (ev.allDay) {
      const last = ev.endDate ? addDays(ev.endDate, -1) : ev.startDate;
      return last && last !== ev.startDate ? `${ev.startDate} to ${last}, all day` : `${ev.startDate}, all day`;
    }
    return `${date(ev.start)} to ${date(ev.end).slice(localIso(ev.end) === localIso(ev.start) ? 11 : 0)}`;
  }

  function eventSummary(ev: CalendarEvent) {
    const cal = host.calendars().find((c) => c.accountId === ev.accountId && c.id === ev.calendarId);
    return {
      id: ev.id,
      title: ev.title || '(no title)',
      start: ev.allDay ? ev.startDate : date(ev.start),
      end: ev.allDay ? (ev.endDate ? addDays(ev.endDate, -1) : ev.startDate) : date(ev.end),
      all_day: ev.allDay || undefined,
      location: ev.location || undefined,
      join_link: ev.joinUrl,
      organizer: ev.organizer && !ev.isOrganizer ? formatAddress({ name: ev.organizer.name, address: ev.organizer.email }) : undefined,
      attendees: ev.attendees.length ? ev.attendees.map((x) => `${formatAddress({ name: x.name, address: x.email })}${x.status ? ` (${x.status})` : ''}`) : undefined,
      my_response: ev.myStatus,
      busy: ev.busy ? undefined : false,
      recurring: ev.recurring || undefined,
      calendar: cal?.name,
      account: accountById(ev.accountId)?.email ?? ev.accountId,
      description: ev.description ? ev.description.slice(0, 400) : undefined
    };
  }

  // Start och slut ur argumenten. Heldag: start och slut som datum, slutet räknas med.
  function eventTimes(a: AgentArgs, ev: CalendarEvent | null): Pick<EventInput, 'start' | 'end' | 'allDay' | 'startDate' | 'endDate'> {
    const startSpec = s(a.start) ? parseCalendarTime(s(a.start)) : null;
    const endSpec = s(a.end) ? parseCalendarTime(s(a.end)) : null;
    const allDay = typeof a.all_day === 'boolean' ? a.all_day : startSpec ? startSpec.dateOnly : !!ev?.allDay;
    if (allDay) {
      const sd = startSpec?.date ?? ev?.startDate ?? localIso(ev?.start ?? Date.now());
      const lastDay = endSpec?.date ?? (ev?.endDate && !startSpec ? addDays(ev.endDate, -1) : sd);
      if (lastDay < sd) throw new AgentError('The end date is before the start date.');
      const endDate = addDays(lastDay, 1);
      const [y, m, d] = sd.split('-').map(Number);
      const [y2, m2, d2] = endDate.split('-').map(Number);
      return { allDay: true, startDate: sd, endDate, start: new Date(y, m - 1, d).getTime(), end: new Date(y2, m2 - 1, d2).getTime() };
    }
    if (startSpec?.dateOnly) throw new AgentError('Give a start time (YYYY-MM-DD HH:MM), or set all_day: true.');
    const start = startSpec?.ms ?? ev?.start ?? NaN;
    if (!Number.isFinite(start)) throw new AgentError('Give start as YYYY-MM-DD HH:MM.');
    const keep = ev && !ev.allDay ? ev.end - ev.start : 3600000;
    const end = endSpec ? (endSpec.dateOnly ? NaN : endSpec.ms) : startSpec ? start + keep : (ev?.end ?? start + 3600000);
    if (!Number.isFinite(end)) throw new AgentError('Give end as YYYY-MM-DD HH:MM.');
    if (end <= start) throw new AgentError('The end must be after the start.');
    return { allDay: false, start, end };
  }

  const call = async (name: string, args: AgentArgs): Promise<string> => {
    const key = Object.prototype.hasOwnProperty.call(TOOL_ALIASES, name) ? TOOL_ALIASES[name] : name;
    const fn = Object.prototype.hasOwnProperty.call(tools, key) ? tools[key] : undefined;
    if (!fn) throw new AgentError(`Unknown tool: ${name}`);
    return fn(normalizeArgs(args && typeof args === 'object' ? args : {}));
  };
  // Bygger ett färdigt mejl (svar med citat och signatur) utan att skicka det, till exempel för svar från en notis.
  return Object.assign(call, { compose });
}

export { htmlToPlain as stripHtml } from '../shared/richtext';
