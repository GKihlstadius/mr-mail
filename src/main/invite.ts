// Svar på kalenderinbjudningar (iMIP REPLY, RFC 6047): vem som svarar, ämne, text och kalenderdelen.
import type { AccountConfig, FullMessage, InviteResponse } from '../shared/types';
import { buildReply, type IcsPerson, type PartStat } from '../shared/ics';
import { formatAddress } from '../shared/compose';
import { APP_NAME, APP_VERSION } from '../shared/brand';
import { t } from '../shared/i18n';
import type { SendInput } from './smtp';

export const PARTSTAT: Record<InviteResponse, PartStat> = { accept: 'ACCEPTED', tentative: 'TENTATIVE', decline: 'DECLINED' };

export function responseFrom(v: unknown): InviteResponse | null {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (['accept', 'accepted', 'yes', 'ja'].includes(s)) return 'accept';
  if (['tentative', 'maybe', 'kanske'].includes(s)) return 'tentative';
  if (['decline', 'declined', 'no', 'nej'].includes(s)) return 'decline';
  return null;
}

export function partstatToResponse(p: string | undefined): InviteResponse | null {
  return p === 'ACCEPTED' ? 'accept' : p === 'TENTATIVE' ? 'tentative' : p === 'DECLINED' ? 'decline' : null;
}

// Den inbjudna: kontots adress, eller en adress i To/Cc som står bland deltagarna (till exempel ett alias).
export function inviteIdentity(cfg: AccountConfig, msg: FullMessage): IcsPerson {
  const ev = msg.body.invite?.event;
  const own = cfg.email.toLowerCase();
  const hit = ev?.attendees.find((a) => a.email === own) ?? ev?.attendees.find((a) => [...msg.to, ...msg.cc].some((x) => x.address === a.email));
  return { name: cfg.displayName?.trim() || hit?.name || '', email: hit?.email ?? own };
}

export function replySubject(response: InviteResponse, title: string): string {
  const s = title || t('(inget ämne)');
  if (response === 'accept') return t('Accepterat: {title}', { title: s });
  if (response === 'tentative') return t('Preliminärt: {title}', { title: s });
  return t('Avböjt: {title}', { title: s });
}

export function replyText(response: InviteResponse, name: string, comment?: string): string {
  const who = name || t('Mottagaren');
  const line = response === 'accept' ? t('{name} har tackat ja.', { name: who }) : response === 'tentative' ? t('{name} kommer kanske.', { name: who }) : t('{name} har tackat nej.', { name: who });
  return comment?.trim() ? `${line}\n\n${comment.trim()}` : line;
}

// Hela svarsmejlet till organisatören. Kastar ett begripligt fel om inbjudan inte går att svara på.
export function inviteReplyMail(cfg: AccountConfig, msg: FullMessage, response: InviteResponse, comment?: string, now = Date.now()): SendInput {
  const inv = msg.body.invite;
  if (!inv) throw new Error(t('Mejlet innehåller ingen inbjudan.'));
  if (inv.method !== 'REQUEST') throw new Error(t('Inbjudan går inte att svara på.'));
  const ev = inv.event;
  const org = ev.organizer;
  if (!org?.email) throw new Error(t('Inbjudan saknar organisatör.'));
  const me = inviteIdentity(cfg, msg);
  if (org.email === me.email) throw new Error(t('Du är själv organisatör för mötet.'));
  const ics = buildReply(ev, me, PARTSTAT[response], { comment, prodid: `-//${APP_NAME}//${APP_VERSION}//EN`, now });
  return {
    to: formatAddress({ name: org.name, address: org.email }),
    cc: '',
    bcc: '',
    subject: replySubject(response, ev.summary),
    text: replyText(response, me.name, comment),
    inReplyTo: msg.messageId || undefined,
    references: [...msg.body.references, ...(msg.messageId ? [msg.messageId] : [])],
    attachments: [],
    icalEvent: { method: 'REPLY', content: ics, filename: 'reply.ics' }
  };
}

// Kort text om inbjudan, för AI-verktygen.
export function inviteSummary(msg: FullMessage, answered: InviteResponse | null, fmt: (ms: number) => string): string {
  const inv = msg.body.invite;
  if (!inv) return '';
  const ev = inv.event;
  const when = ev.allDay
    ? `${ev.startDate}${ev.endDate && ev.endDate !== ev.startDate ? ` to ${ev.endDate} (exclusive)` : ''}, all day`
    : `${fmt(ev.start)} to ${fmt(ev.end)}`;
  const kind = inv.method === 'CANCEL' ? 'Cancelled meeting' : inv.method === 'REQUEST' ? 'Meeting invitation' : inv.method === 'REPLY' ? 'Reply to a meeting' : 'Calendar event';
  const lines = [
    `${kind}: ${ev.summary || '(no title)'}`,
    `When: ${when}${ev.rrule ? ` (repeats: ${ev.rrule})` : ''}`,
    ev.location ? `Where: ${ev.location}` : '',
    ev.organizer ? `Organizer: ${formatAddress({ name: ev.organizer.name, address: ev.organizer.email })}` : '',
    ev.attendees.length ? `Attendees: ${ev.attendees.length}` : '',
    ev.joinUrl ? `Join link: ${ev.joinUrl}` : '',
    inv.method === 'REQUEST'
      ? answered
        ? `The user has answered: ${answered}. Answer again with respond_to_invite to change it.`
        : 'Not answered yet. Answer with respond_to_invite (accept, tentative or decline) when the user asks.'
      : ''
  ];
  return lines.filter(Boolean).join('\n');
}
