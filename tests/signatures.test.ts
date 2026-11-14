import { describe, expect, it } from 'vitest';
import { SEED } from './fixtures';
import { JSDOM } from 'jsdom';
import { defaultAccounts, makeAccount } from '../src/shared/accounts';
import { createSanitizer } from '../src/shared/sanitize';
import { emailsIn, migrateSignatures, parseSparkExport, resolveSignature, suggestAccount, suggestName, unwrapSpark } from '../src/shared/signatures';

const sig = (email: string, wrap = false) => {
  const inner = `<table><tr><td><a href="https://www.nordljus.se"><img src="https://www.nordljus.se/icons/signatur.png" width="48" alt="Nordljus"></a></td><td><div>Alex Berg</div><div><a href="mailto:${email}">${email}</a> | nordljus.se</div><div>M&ouml;ten samlade.</div></td></tr></table>`;
  return wrap ? `<div data-spark-custom-html="true">${inner}\n</div>` : inner;
};
export const fixture = JSON.stringify([
  { identifier: 'A', id: 'A', type: 1, deleted: false, htmlContent: sig('alex@nordljus.se') },
  { identifier: 'B', id: 'B', type: 1, deleted: false, htmlContent: sig('hej@nordljus.se', true) },
  { identifier: 'C', id: 'C', type: 1, deleted: true, htmlContent: sig('borta@nordljus.se') }
]);

describe('signaturer från Spark', () => {
  it('läser exporten, hoppar över raderade och tar bort Sparks omslag', () => {
    const list = parseSparkExport(fixture);
    expect(list.map((s) => s.sparkId)).toEqual(['A', 'B']);
    expect(list[1].html.startsWith('<table>')).toBe(true);
    expect(list[1].html).toContain('https://www.nordljus.se/icons/signatur.png');
  });

  it('föreslår konto utifrån adressen i signaturen', () => {
    const accounts = defaultAccounts(SEED);
    const [a, b] = parseSparkExport(fixture);
    expect(suggestAccount(a, accounts)).toBe('alex-nordljus-se');
    expect(suggestAccount(b, accounts)).toBe('hej-nordljus-se');
    expect(suggestName(b, accounts)).toBe('Nordljus hej');
    expect(suggestAccount({ emails: ['okand@x.se'] }, accounts)).toBe('');
  });

  it('hittar adresser i mailto och i text', () => {
    expect(emailsIn('<a href="mailto:Anna@Firma.se">x</a> eller bo@firma.se')).toEqual(['anna@firma.se', 'bo@firma.se']);
    expect(unwrapSpark('<div data-spark-custom-html="true"><b>x</b></div>')).toBe('<b>x</b>');
  });

  it('ger tydligt fel för fel sorts fil', () => {
    expect(() => parseSparkExport('inte json')).toThrow(/ogiltig JSON/);
    expect(() => parseSparkExport('{"a":1}')).toThrow(/inga signaturer/);
  });

  it('länkade bilder och tabeller överlever saneringen när signaturen sparas', () => {
    const sanitize = createSanitizer(new JSDOM('').window as any);
    const html = sanitize(parseSparkExport(fixture)[0].html, { allowRemote: true }).html;
    expect(html).toContain('src="https://www.nordljus.se/icons/signatur.png"');
    expect(html).toContain('<table>');
  });
});

describe('signaturbiblioteket', () => {
  it('kontot får vald signatur, ingen, eller sin gamla', () => {
    const sigs = [{ id: 's1', name: 'Jobb', html: '<b>Jobb</b>' }];
    const a = makeAccount('a@b.se', 'manual', { signature: '<i>gammal</i>' });
    expect(resolveSignature(a, sigs)).toBe('<i>gammal</i>');
    expect(resolveSignature({ ...a, signatureId: 's1' }, sigs)).toBe('<b>Jobb</b>');
    expect(resolveSignature({ ...a, signatureId: '' }, sigs)).toBe('');
    expect(resolveSignature({ ...a, signatureId: 'borta' }, sigs)).toBe('');
  });

  it('flyttar in gamla signaturer i biblioteket en gång', () => {
    const accs = [
      makeAccount('a@b.se', 'manual', { name: 'A', signature: '<b>Sig</b>' }),
      makeAccount('c@b.se', 'manual', { name: 'C', signature: '<b>Sig</b>' }),
      makeAccount('d@b.se', 'manual', { name: 'D' })
    ];
    const m = migrateSignatures(accs, []);
    expect(m.changed).toBe(true);
    expect(m.signatures).toHaveLength(1);
    expect(m.accounts[0].signatureId).toBe(m.signatures[0].id);
    expect(m.accounts[1].signatureId).toBe(m.signatures[0].id);
    expect(m.accounts[2].signatureId).toBe('');
    expect(migrateSignatures(m.accounts, m.signatures).changed).toBe(false);
  });
});
