import { describe, expect, it } from 'vitest';
import { flattenAddresses, hasRemoteContent, htmlToText, makePreview, parseMessage } from '../src/main/parse';
import { htmlMail } from './fixtures';

const plain = [
  'From: "Anna Svensson" <Anna@Example.se>',
  'To: Alex <alex@nordljus.se>, hej@nordljus.se',
  'Subject: =?UTF-8?Q?M=C3=B6te_p=C3=A5_fredag?=',
  'Date: Tue, 10 Nov 2026 09:30:00 +0100',
  'Message-ID: <abc123@example.se>',
  'In-Reply-To: <prev@nordljus.se>',
  'References: <first@nordljus.se> <prev@nordljus.se>',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: 8bit',
  '',
  'Hej Alex!',
  '',
  'Kan vi ses på fredag klockan 10?',
  '',
  'Den 9 nov. 2026 kl. 14:00 skrev Alex <alex@nordljus.se>:',
  '> Hej Anna, när passar det?',
  ''
].join('\r\n');

describe('tolkning av mejl', () => {
  it('läser rubriker, adresser och trådinformation', async () => {
    const r = await parseMessage(plain);
    expect(r.subject).toBe('Möte på fredag');
    expect(r.from).toEqual({ name: 'Anna Svensson', address: 'anna@example.se' });
    expect(r.to.map((a) => a.address)).toEqual(['alex@nordljus.se', 'hej@nordljus.se']);
    expect(r.messageId).toBe('<abc123@example.se>');
    expect(r.body.inReplyTo).toBe('<prev@nordljus.se>');
    expect(r.body.references).toEqual(['<first@nordljus.se>', '<prev@nordljus.se>']);
    expect(r.date).toBe(Date.UTC(2026, 10, 10, 8, 30));
    expect(r.body.html).toBeNull();
    expect(r.body.attachments).toEqual([]);
  });

  it('gör en förhandsvisning utan citat', async () => {
    const r = await parseMessage(plain);
    expect(r.preview).toBe('Hej Alex! Kan vi ses på fredag klockan 10?');
  });

  it('hittar bilagor, inbäddade bilder och fjärrbilder i HTML', async () => {
    const r = await parseMessage(htmlMail);
    expect(r.body.html).toContain('<h1>Rea</h1>');
    expect(r.body.hasRemoteImages).toBe(true);
    const pdf = r.body.attachments.find((a) => a.filename === 'faktura.pdf')!;
    expect(pdf.inline).toBe(false);
    expect(pdf.contentType).toBe('application/pdf');
    const logo = r.body.attachments.find((a) => a.cid === 'logo@shop')!;
    expect(logo.inline).toBe(true);
    expect(r.body.inlineImages['logo@shop']).toMatch(/^data:image\/png;base64,/);
    expect(r.preview).toContain('Allt ska bort');
  });

  it('gör text av HTML när textdel saknas', () => {
    expect(htmlToText('<style>p{}</style><p>Hej&nbsp;du</p><p>Ja &#38; nej &amp; kanske</p>')).toBe('Hej du\nJa & nej & kanske');
  });

  it('kortar långa förhandsvisningar', () => {
    const p = makePreview('ord '.repeat(200), 50);
    expect(p.length).toBeLessThanOrEqual(50);
    expect(p.endsWith('…')).toBe(true);
  });

  it('upptäcker fjärrinnehåll i CSS', () => {
    expect(hasRemoteContent('<div style="background:url(https://x.se/a.png)">')).toBe(true);
    expect(hasRemoteContent('<img src="data:image/png;base64,AA">')).toBe(false);
    expect(hasRemoteContent(null)).toBe(false);
  });

  it('plattar ut grupper av adresser', () => {
    const out = flattenAddresses({
      value: [{ name: 'Team', group: [{ name: 'A', address: 'A@x.se' }, { name: '', address: 'b@x.se' }] } as any],
      html: '',
      text: ''
    });
    expect(out).toEqual([
      { name: 'A', address: 'a@x.se' },
      { name: '', address: 'b@x.se' }
    ]);
  });

  it('klarar ett avkortat meddelande (förhandsvisning från synk)', async () => {
    const r = await parseMessage(htmlMail.slice(0, 600));
    expect(r.subject).toBe('Erbjudande');
  });
});
