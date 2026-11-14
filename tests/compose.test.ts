import { describe, expect, it } from 'vitest';
import { buildDraft, cleanAiText, formatAddress, parseAddressList, prefixSubject, removeDashes } from '../src/shared/compose';
import { buildMessages, flattenForCli, systemPrompt } from '../src/shared/prompts';
import { makeAccount } from '../src/shared/accounts';
import type { FullMessage } from '../src/shared/types';

const account = makeAccount('alex@nordljus.se', 'simply', { displayName: 'Alex Berg' });

const msg: FullMessage = {
  id: 'x',
  accountId: account.id,
  folder: 'INBOX',
  uid: 1,
  subject: 'Offert',
  from: { name: 'Anna', address: 'anna@firma.se' },
  to: [
    { name: 'Alex', address: 'alex@nordljus.se' },
    { name: 'Erik', address: 'erik@firma.se' }
  ],
  cc: [{ name: '', address: 'kontor@firma.se' }],
  date: Date.UTC(2026, 10, 10, 9, 0),
  preview: '',
  seen: true,
  flagged: false,
  answered: false,
  hasAttachments: false,
  messageId: '<m2@firma.se>',
  body: {
    id: 'x',
    html: null,
    text: 'Hej!\nKan ni skicka en offert?\n> gammalt',
    attachments: [{ index: 0, filename: 'underlag.pdf', contentType: 'application/pdf', size: 100, inline: false }],
    inlineImages: {},
    references: ['<m1@firma.se>'],
    inReplyTo: '<m1@firma.se>',
    replyTo: [],
    hasRemoteImages: false
  }
};

describe('svar och vidarebefordran', () => {
  it('lägger till Re och Fwd en gång', () => {
    expect(prefixSubject('Offert', 'Re')).toBe('Re: Offert');
    expect(prefixSubject('SV: Offert', 'Re')).toBe('SV: Offert');
    expect(prefixSubject('VB: x', 'Fwd')).toBe('VB: x');
    expect(prefixSubject('', 'Re')).toBe('Re: (inget ämne)');
  });

  it('svarar avsändaren med rätt trådrubriker', () => {
    const d = buildDraft('reply', account, msg);
    expect(d.to).toBe('Anna <anna@firma.se>');
    expect(d.cc).toBe('');
    expect(d.subject).toBe('Re: Offert');
    expect(d.inReplyTo).toBe('<m2@firma.se>');
    expect(d.references).toEqual(['<m1@firma.se>', '<m2@firma.se>']);
    expect(d.quote).toMatch(/skrev Anna <anna@firma.se>:/);
    expect(d.quote).toContain('> Kan ni skicka en offert?');
    expect(d.quote).toContain('>> gammalt');
    expect(d.quoteHtml).toContain('<blockquote type="cite"');
    expect(d.quoteHtml).toContain('Kan ni skicka en offert?');
  });

  it('lägger signaturen i ett eget block', () => {
    const d = buildDraft('new', { ...account, signature: 'Alex\nNordljus AB' });
    expect(d.html).toContain('<div class="brevlada-signature"><div>Alex</div><div>Nordljus AB</div></div>');
  });

  it('öppnar ett sparat utkast igen med mottagare och tråd', () => {
    const saved = { ...msg, to: [{ name: 'Erik', address: 'erik@firma.se' }], subject: 'Re: Offert', body: { ...msg.body, html: '<div>Hej <b>Erik</b></div>' } };
    const d = buildDraft('draft', account, saved);
    expect(d.to).toBe('Erik <erik@firma.se>');
    expect(d.subject).toBe('Re: Offert');
    expect(d.html).toBe('<div>Hej <b>Erik</b></div>');
    expect(d.quoteHtml).toBe('');
    expect(d.inReplyTo).toBe('<m1@firma.se>');
    expect(d.draftOf).toBe('x');
  });

  it('svara alla tar med alla utom mig själv', () => {
    const d = buildDraft('replyAll', account, msg);
    expect(d.to).toBe('Anna <anna@firma.se>');
    expect(d.cc).toBe('Erik <erik@firma.se>, kontor@firma.se');
  });

  it('respekterar Reply-To', () => {
    const d = buildDraft('reply', account, { ...msg, body: { ...msg.body, replyTo: [{ name: 'Support', address: 'help@firma.se' }] } });
    expect(d.to).toBe('Support <help@firma.se>');
  });

  it('vidarebefordrar med bilagor', () => {
    const d = buildDraft('forward', account, msg);
    expect(d.to).toBe('');
    expect(d.subject).toBe('Fwd: Offert');
    expect(d.quote).toContain('Vidarebefordrat meddelande');
    expect(d.forwardAttachments.map((a) => a.filename)).toEqual(['underlag.pdf']);
    expect(d.forwardOf).toBe('x');
  });

  it('tolkar och formaterar adresslistor', () => {
    expect(parseAddressList('Anna <Anna@x.se>, "Berg, Erik" <erik@x.se>; c@x.se')).toEqual([
      { name: 'Anna', address: 'anna@x.se' },
      { name: 'Berg, Erik', address: 'erik@x.se' },
      { name: '', address: 'c@x.se' }
    ]);
    expect(formatAddress({ name: 'Berg, Erik', address: 'erik@x.se' })).toBe('"Berg, Erik" <erik@x.se>');
    expect(formatAddress({ name: '', address: 'a@x.se' })).toBe('a@x.se');
  });
});

describe('AI-text', () => {
  const em = String.fromCharCode(0x2014);
  const en = String.fromCharCode(0x2013);

  it('tar bort tankestreck', () => {
    expect(removeDashes(`Hej ${em} tack för mejlet`)).toBe('Hej, tack för mejlet');
    expect(removeDashes(`Vi ses 10${en}12 på fredag`)).toBe('Vi ses 10 till 12 på fredag');
    expect(removeDashes(`Klart${em}.`)).toBe('Klart.');
    expect(removeDashes('vanligt-bindestreck')).toBe('vanligt-bindestreck');
  });

  it('städar modellens svar', () => {
    expect(cleanAiText(`<think>tänker</think>\nÄmne: Re: x\n\nHej Anna ${em} absolut!`)).toBe('Hej Anna, absolut!');
  });

  it('bygger meddelanden med ton, exempel och ändringar', () => {
    const sys = systemPrompt({ ownName: 'Alex', ownEmail: 'g@s.se', tone: 'Kort.', examples: ['x'.repeat(60)] });
    expect(sys).toContain('Ton och stil: Kort.');
    expect(sys).toContain('Exempel 1');
    const msgs = buildMessages({
      message: msg,
      ownName: 'Alex',
      ownEmail: 'alex@nordljus.se',
      tone: 'Kort.',
      examples: [],
      draft: 'Hej Anna!',
      history: [{ role: 'assistant', content: 'Hej Anna!' }],
      instruction: 'kortare'
    });
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(msgs[1].content).toContain('Kan ni skicka en offert?');
    expect(msgs[1].content).toContain('Bilagor: underlag.pdf');
    expect(msgs[3].content).toContain('kortare');
    const cli = flattenForCli(msgs);
    expect(cli.stdin).toContain('Kan ni skicka en offert?');
    expect(cli.prompt).toContain('kortare');
    expect(cli.system).toContain('Alex');
  });
});
