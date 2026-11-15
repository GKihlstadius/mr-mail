import { describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';
import { inviteIdentity, inviteReplyMail, responseFrom } from '../src/main/invite';
import { buildRaw } from '../src/main/smtp';
import { findInvitation } from '../src/main/parse';
import { mainEvent, parseIcs } from '../src/shared/ics';
import type { AccountConfig, FullMessage } from '../src/shared/types';

const cfg: AccountConfig = {
  id: 'nordljus',
  name: 'Nordljus',
  email: 'alex@nordljus.se',
  displayName: 'Alex Berg',
  provider: 'simply',
  imap: { host: 'h', port: 993, security: 'ssl' },
  smtp: { host: 'h', port: 465, security: 'ssl' },
  username: 'alex@nordljus.se',
  color: '#000'
};

const ics = (method: string, extra: string[] = []) =>
  [
    'BEGIN:VCALENDAR',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    'UID:demo-1@exempel.se',
    'SEQUENCE:1',
    'DTSTART:20261117T130000Z',
    'DTEND:20261117T140000Z',
    'SUMMARY:Demo av Nordljus',
    'ORGANIZER;CN=Karin Lund:mailto:karin@exempel.se',
    'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:hej@nordljus.se',
    ...extra,
    'END:VEVENT',
    'END:VCALENDAR',
    ''
  ].join('\r\n');

function message(text: string): FullMessage {
  return {
    id: 'm1',
    accountId: 'nordljus',
    folder: 'INBOX',
    uid: 1,
    subject: 'Inbjudan: Demo',
    from: { name: 'Karin Lund', address: 'karin@exempel.se' },
    to: [{ name: '', address: 'hej@nordljus.se' }],
    cc: [],
    date: 0,
    preview: '',
    seen: true,
    flagged: false,
    answered: false,
    hasAttachments: true,
    messageId: '<inv-1@exempel.se>',
    body: {
      id: 'm1',
      html: null,
      text: '',
      attachments: [],
      inlineImages: {},
      references: ['<a@exempel.se>'],
      inReplyTo: null,
      replyTo: [],
      hasRemoteImages: false,
      invite: findInvitation([{ contentType: 'text/calendar', content: Buffer.from(text) }])
    }
  };
}

describe('svar på inbjudningar', () => {
  it('tolkar svaret på svenska och engelska', () => {
    expect(responseFrom('Ja')).toBe('accept');
    expect(responseFrom('maybe')).toBe('tentative');
    expect(responseFrom('declined')).toBe('decline');
    expect(responseFrom('kanske inte')).toBeNull();
  });

  it('svarar från adressen som bjöds in, även ett alias', () => {
    expect(inviteIdentity(cfg, message(ics('REQUEST')))).toEqual({ name: 'Alex Berg', email: 'hej@nordljus.se' });
  });

  it('bygger ett iMIP-svar till organisatören med PARTSTAT', async () => {
    const mail = inviteReplyMail(cfg, message(ics('REQUEST')), 'accept', 'Ses där', Date.UTC(2026, 10, 14));
    expect(mail.to).toBe('Karin Lund <karin@exempel.se>');
    expect(mail.subject).toBe('Accepterat: Demo av Nordljus');
    expect(mail.text).toContain('Alex Berg har tackat ja.');
    expect(mail.inReplyTo).toBe('<inv-1@exempel.se>');
    const { raw, recipients } = await buildRaw(cfg, mail);
    expect(recipients).toEqual(['karin@exempel.se']);
    const parsed = await simpleParser(raw);
    const cal = parsed.attachments.find((a) => a.contentType === 'text/calendar');
    expect(raw.toString()).toMatch(/Content-Type: text\/calendar; charset=utf-8; method=REPLY/);
    const reply = mainEvent(parseIcs(cal!.content.toString())!)!;
    expect(parseIcs(cal!.content.toString())!.method).toBe('REPLY');
    expect(reply.attendees).toMatchObject([{ email: 'hej@nordljus.se', partstat: 'ACCEPTED' }]);
    expect(reply.uid).toBe('demo-1@exempel.se');
    expect(reply.sequence).toBe(1);
  });

  it('vägrar svara på inställda möten och egna möten', () => {
    expect(() => inviteReplyMail(cfg, message(ics('CANCEL')), 'accept')).toThrow(/går inte att svara/);
    const own = ics('REQUEST').replace('mailto:karin@exempel.se', 'mailto:hej@nordljus.se');
    expect(() => inviteReplyMail(cfg, message(own), 'accept')).toThrow(/organisatör/);
  });
});
