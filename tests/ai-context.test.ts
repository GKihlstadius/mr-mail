import { describe, expect, it } from 'vitest';
import { buildMessages, buildTaskMessages, contextText, parseQuickReplies, stripQuoted, type ContextMail } from '../src/shared/prompts';
import { runAi } from '../src/main/ai';
import { DEFAULT_SETTINGS } from '../src/main/db';
import type { FullMessage } from '../src/shared/types';

const msg: FullMessage = {
  id: 'x',
  accountId: 'a',
  folder: 'INBOX',
  uid: 1,
  subject: 'Re: Offert',
  from: { name: 'Anna Berg', address: 'anna@firma.se' },
  to: [{ name: 'Alex', address: 'alex@nordljus.se' }],
  cc: [],
  date: Date.UTC(2026, 10, 10, 9, 0),
  preview: '',
  seen: true,
  flagged: false,
  answered: false,
  hasAttachments: false,
  messageId: '<m3@firma.se>',
  body: { id: 'x', html: null, text: 'Låter bra, skicka avtalet.', attachments: [], inlineImages: {}, references: [], inReplyTo: null, replyTo: [], hasRemoteImages: false }
};

const thread: ContextMail[] = [
  { from: { name: 'Alex', address: 'alex@nordljus.se' }, to: [msg.from], date: Date.UTC(2026, 10, 9), subject: 'Offert', text: 'Priset blir 4 900 kr i månaden.\n\nDen 8 nov. skrev Anna:\n> Vad kostar det?' }
];
const earlier: ContextMail[] = [{ from: msg.from, to: msg.to, date: Date.UTC(2026, 9, 1), subject: 'Mässan', text: 'Trevligt att ses i Göteborg!' }];

describe('AI med hela tråden', () => {
  it('tar bort citerad text från tidigare mejl', () => {
    expect(stripQuoted(thread[0].text)).toBe('Priset blir 4 900 kr i månaden.');
    expect(stripQuoted('Hej\n> gammalt\nSlut')).toBe('Hej\nSlut');
  });

  it('lägger tråden och tidigare mejl med personen före mejlet', () => {
    const ctx = contextText({ message: msg, thread, earlier });
    expect(ctx).toContain('<tidigare_i_traden>');
    expect(ctx).toContain('4 900 kr');
    expect(ctx).not.toContain('Vad kostar det');
    expect(ctx).toContain('Andra mejl med Anna Berg <anna@firma.se>');
    expect(ctx).toContain('Trevligt att ses i Göteborg');
    const msgs = buildMessages({ message: msg, ownName: 'Alex', ownEmail: 'alex@nordljus.se', tone: 'Kort.', examples: [], history: [], thread, earlier });
    expect(msgs[1].content.indexOf('4 900 kr')).toBeLessThan(msgs[1].content.indexOf('skicka avtalet'));
    expect(contextText({ message: msg })).toBe('');
  });

  it('bygger sammanfattning, att göra och snabbsvar', () => {
    const base = { message: msg, ownName: 'Alex', ownEmail: 'alex@nordljus.se', tone: 'Kort.', examples: [], history: [], thread };
    expect(buildTaskMessages('summary', base)[0].content).toContain('sammanfattar');
    expect(buildTaskMessages('todo', base)[0].content).toContain('Inget behöver göras');
    const quick = buildTaskMessages('quick', base);
    expect(quick[0].content).toContain('exakt tre');
    expect(quick[1].content).toContain('4 900 kr');
  });

  it('tolkar tre snabbsvar ur modellens svar', () => {
    expect(parseQuickReplies('1. Hej Anna! Jag skickar avtalet i dag.\n2. Hej Anna! Vilken adress ska avtalet till?\n3) "Hej Anna! Tack, vi hörs."')).toEqual([
      'Hej Anna! Jag skickar avtalet i dag.',
      'Hej Anna! Vilken adress ska avtalet till?',
      'Hej Anna! Tack, vi hörs.'
    ]);
    expect(parseQuickReplies('- Ja\nfortsätter här\n- Nej')).toEqual(['Ja fortsätter här', 'Nej']);
  });

  it('säger tydligt när datorns modell inte är igång', async () => {
    const res = await runAi({ ...DEFAULT_SETTINGS, localUrl: 'http://127.0.0.1:1/v1' }, [{ role: 'user', content: 'hej' }], { engine: 'local' });
    expect(res.ok).toBe(false);
    expect(res.engine).toBe('local');
    expect(res.error).toMatch(/Datorns modell är inte igång/);
  });
});
