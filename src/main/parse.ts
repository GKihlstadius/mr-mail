import { simpleParser, type AddressObject, type ParsedMail, type Attachment } from 'mailparser';
import type { Address, AttachmentInfo, Invitation, MessageBody } from '../shared/types';
import { mainEvent, parseIcs } from '../shared/ics';

export function flattenAddresses(input: AddressObject | AddressObject[] | undefined): Address[] {
  if (!input) return [];
  const list = Array.isArray(input) ? input : [input];
  const out: Address[] = [];
  const walk = (entries: { name?: string; address?: string; group?: any[] }[]) => {
    for (const e of entries) {
      if (e.group) walk(e.group);
      else if (e.address) out.push({ name: decodeName(e.name ?? ''), address: e.address.toLowerCase() });
    }
  };
  for (const obj of list) walk(obj.value as any);
  return out;
}

function decodeName(name: string): string {
  return name.replace(/^["']|["']$/g, '').trim();
}

export function makePreview(text: string, max = 220): string {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => !/^\s*>/.test(l));
  const cut: string[] = [];
  for (const l of lines) {
    if (/^(On|Den|På|Am|Le)\b.{4,200}\b(wrote|skrev|schrieb|écrit)\b.*:\s*$/i.test(l.trim())) break;
    if (/^-{2,}\s*(Original Message|Ursprungligt meddelande|Vidarebefordrat)/i.test(l.trim())) break;
    cut.push(l);
  }
  const collapsed = cut
    .join(' ')
    .replace(/\[(?:cid|image)[^\]]*\]/gi, '')
    .replace(/https?:\/\/\S{40,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return collapsed.length > max ? collapsed.slice(0, max - 1).trimEnd() + '…' : collapsed;
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const REMOTE_RE = /<img[^>]+src\s*=\s*["']?\s*(https?:)?\/\//i;
const REMOTE_CSS_RE = /url\(\s*["']?\s*(https?:)?\/\//i;

export function hasRemoteContent(html: string | null): boolean {
  if (!html) return false;
  return REMOTE_RE.test(html) || REMOTE_CSS_RE.test(html);
}

function isInline(a: Attachment): boolean {
  return a.contentDisposition === 'inline' && !!a.cid && a.contentType.startsWith('image/');
}

export function attachmentInfos(attachments: Attachment[]): AttachmentInfo[] {
  return attachments.map((a, index) => ({
    index,
    filename: a.filename || fallbackName(a.contentType, index),
    contentType: a.contentType,
    size: a.size ?? a.content?.length ?? 0,
    cid: a.cid || undefined,
    inline: isInline(a) || (!!a.cid && a.related === true)
  }));
}

function fallbackName(contentType: string, index: number): string {
  const ext = contentType.split('/')[1]?.split(/[;+]/)[0] ?? 'bin';
  return `bilaga-${index + 1}.${ext}`;
}

export function isCalendarPart(contentType: string, filename?: string): boolean {
  return /^(text\/calendar|application\/ics|text\/x-vcalendar)$/i.test(contentType) || /\.ics$/i.test(filename ?? '');
}

const MAX_ICS = 256 * 1024;

// Inbjudan i mejlet: text/calendar-delen går före en bifogad .ics-fil.
export function findInvitation(attachments: { contentType: string; filename?: string; content: Buffer }[]): Invitation | null {
  const parts = attachments.filter((a) => isCalendarPart(a.contentType, a.filename));
  parts.sort((a, b) => Number(!/calendar/i.test(a.contentType)) - Number(!/calendar/i.test(b.contentType)));
  for (const a of parts) {
    if (a.content.length > 2 * 1024 * 1024) continue;
    const text = a.content.toString('utf8');
    const cal = parseIcs(text);
    const event = cal ? mainEvent(cal) : null;
    if (!cal || !event) continue;
    return { method: cal.method || 'PUBLISH', event, count: cal.events.length, ics: text.length <= MAX_ICS ? text : null };
  }
  return null;
}

export interface ParsedResult {
  parsed: ParsedMail;
  subject: string;
  from: Address;
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  date: number;
  messageId: string;
  preview: string;
  body: Omit<MessageBody, 'id'>;
}

const MAX_INLINE_BYTES = 3 * 1024 * 1024;

export async function parseMessage(source: Buffer | string): Promise<ParsedResult> {
  const parsed = await simpleParser(source, { skipTextToHtml: true, skipImageLinks: true, skipHtmlToText: true });
  const html = typeof parsed.html === 'string' ? parsed.html : null;
  const text = parsed.text?.trim() ? parsed.text : html ? htmlToText(html) : '';
  const attachments = attachmentInfos(parsed.attachments ?? []);
  const inlineImages: Record<string, string> = {};
  let inlineBytes = 0;
  for (const a of parsed.attachments ?? []) {
    if (a.cid && a.contentType.startsWith('image/') && html?.includes(`cid:${a.cid}`)) {
      inlineBytes += a.content.length;
      if (inlineBytes > MAX_INLINE_BYTES) break;
      inlineImages[a.cid] = `data:${a.contentType};base64,${a.content.toString('base64')}`;
    }
  }
  const references = Array.isArray(parsed.references)
    ? parsed.references
    : parsed.references
      ? parsed.references.split(/\s+/).filter(Boolean)
      : [];
  return {
    parsed,
    subject: parsed.subject?.trim() || '',
    from: flattenAddresses(parsed.from)[0] ?? { name: '', address: '' },
    to: flattenAddresses(parsed.to),
    cc: flattenAddresses(parsed.cc),
    replyTo: flattenAddresses(parsed.replyTo),
    date: parsed.date?.getTime() ?? Date.now(),
    messageId: parsed.messageId ?? '',
    preview: makePreview(html ? htmlToText(html) : text),
    body: {
      html,
      text,
      attachments,
      inlineImages,
      references,
      inReplyTo: parsed.inReplyTo ?? null,
      replyTo: flattenAddresses(parsed.replyTo),
      hasRemoteImages: hasRemoteContent(html),
      invite: findInvitation(parsed.attachments ?? [])
    }
  };
}

export async function extractAttachment(source: Buffer, index: number): Promise<Attachment | null> {
  const parsed = await simpleParser(source, { skipTextToHtml: true, skipImageLinks: true });
  return parsed.attachments?.[index] ?? null;
}
