import type { SearchQuery } from './types';

// Sökfältet förstår prefix som i Apple Mail och Gmail: från:, till:, ämne:, har:bilaga, är:oläst, är:flaggad,
// efter:2026-01-01 och före:2026-02-01. Resten är fritext.
const KEYS: Record<string, keyof SearchQuery> = {
  från: 'from',
  from: 'from',
  till: 'to',
  to: 'to',
  ämne: 'subject',
  subject: 'subject',
  efter: 'after',
  after: 'after',
  före: 'before',
  before: 'before'
};

export function emptyQuery(): SearchQuery {
  return { text: '' };
}

export function parseSearch(input: string, base: Partial<SearchQuery> = {}): SearchQuery {
  const q: SearchQuery = { ...base, text: '' };
  const free: string[] = [];
  const re = /(\S+?):("([^"]*)"|\S+)|"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    if (m[1]) {
      const key = m[1].toLowerCase();
      const value = m[3] ?? m[2];
      const field = KEYS[key];
      if (field) {
        (q as any)[field] = value;
        continue;
      }
      if ((key === 'har' || key === 'has') && /^(bilaga|bilagor|attachment)$/i.test(value)) {
        q.hasAttachment = true;
        continue;
      }
      if (key === 'är' || key === 'is') {
        if (/^(oläst|olästa|unread)$/i.test(value)) q.unread = true;
        else if (/^(flaggad|flaggade|starred|flagged)$/i.test(value)) q.flagged = true;
        else free.push(m[0]);
        continue;
      }
      free.push(m[0]);
    } else free.push(m[4] ?? m[5]);
  }
  q.text = free.join(' ').trim();
  return q;
}

export function isEmptyQuery(q: SearchQuery): boolean {
  return !q.text.trim() && !q.from && !q.to && !q.subject && !q.hasAttachment && !q.unread && !q.flagged && !q.after && !q.before;
}

function validDate(s?: string): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function queryDates(q: SearchQuery): { after: Date | null; before: Date | null } {
  return { after: validDate(q.after), before: validDate(q.before) };
}

function gmailQuote(v: string): string {
  return /[\s"()]/.test(v) ? `"${v.replace(/"/g, '')}"` : v;
}

const pad = (n: number) => String(n).padStart(2, '0');
const gmDate = (d: Date) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;

// Gmails egen sökning (X-GM-RAW) klarar bilagor och söker som i webbläsaren.
export function gmailRaw(q: SearchQuery): string {
  const parts: string[] = [];
  if (q.from) parts.push(`from:${gmailQuote(q.from)}`);
  if (q.to) parts.push(`to:${gmailQuote(q.to)}`);
  if (q.subject) parts.push(`subject:${gmailQuote(q.subject)}`);
  if (q.hasAttachment) parts.push('has:attachment');
  if (q.unread) parts.push('is:unread');
  if (q.flagged) parts.push('is:starred');
  const { after, before } = queryDates(q);
  if (after) parts.push(`after:${gmDate(after)}`);
  if (before) parts.push(`before:${gmDate(before)}`);
  if (q.text.trim()) parts.push(q.text.trim());
  return parts.join(' ');
}

// Vanlig IMAP SEARCH. Bilagor går inte att söka på i IMAP, de filtreras efteråt.
export function imapCriteria(q: SearchQuery): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  if (q.from) c.from = q.from;
  if (q.to) c.to = q.to;
  if (q.subject) c.subject = q.subject;
  if (q.unread) c.seen = false;
  if (q.flagged) c.flagged = true;
  const { after, before } = queryDates(q);
  if (after) c.since = after;
  if (before) c.before = before;
  const words = q.text.trim().split(/\s+/).filter(Boolean).slice(0, 6);
  if (words.length === 1) c.text = words[0];
  else if (words.length > 1) c.text = q.text.trim();
  if (!Object.keys(c).length) c.all = true;
  return c;
}
