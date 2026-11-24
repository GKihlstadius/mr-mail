import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/main/db';
import { isJunk, normalizeAddress, remoteImagePolicy } from '../src/shared/trust';

const none = new Set<string>();

describe('normalizeAddress', () => {
  it('gör små bokstäver och tar bort blanktecken runt om', () => {
    expect(normalizeAddress('  Anna.Berg@Nordljus.SE ')).toBe('anna.berg@nordljus.se');
  });

  it('godtar inte något som inte är en adress', () => {
    expect(normalizeAddress('')).toBe('');
    expect(normalizeAddress(null)).toBe('');
    expect(normalizeAddress('Anna Berg')).toBe('');
    expect(normalizeAddress('anna@')).toBe('');
    expect(normalizeAddress('@nordljus.se')).toBe('');
    expect(normalizeAddress('Anna <anna@nordljus.se>')).toBe('');
    expect(normalizeAddress('anna@nordljus.se, bo@nordljus.se')).toBe('');
  });
});

describe('isJunk', () => {
  it('känner igen skräpposten på rollen', () => {
    expect(isJunk({ role: 'junk', folder: 'Vad som helst' })).toBe(true);
    expect(isJunk({ role: 'inbox', folder: 'INBOX' })).toBe(false);
  });

  it('känner igen vanliga mappnamn även utan roll', () => {
    expect(isJunk({ role: 'other', folder: '[Gmail]/Spam' })).toBe(true);
    expect(isJunk({ role: 'other', folder: 'INBOX.Junk' })).toBe(true);
    expect(isJunk({ role: null, folder: 'Skräppost' })).toBe(true);
    expect(isJunk({ role: 'other', folder: 'Junk E-mail' })).toBe(true);
    expect(isJunk({ role: 'other', folder: 'Spamfilter-rapporter' })).toBe(false);
  });

  it('känner igen etiketter för skräppost', () => {
    expect(isJunk({ role: 'archive', folder: 'All Mail', labels: ['\\Junk'] })).toBe(true);
    expect(isJunk({ role: 'archive', folder: 'All Mail', labels: ['Spam'] })).toBe(true);
    expect(isJunk({ role: 'archive', folder: 'All Mail', labels: ['Kvitton'] })).toBe(false);
  });
});

describe('remoteImagePolicy', () => {
  const trusted = new Set(['nyheter@butiken.se']);
  const sentTo = new Set(['anna@nordljus.se']);

  it('blockerar okända avsändare', () => {
    expect(remoteImagePolicy({ from: 'okand@exempel.se', role: 'inbox', trusted, sentTo })).toEqual({ auto: false, reason: null, junk: false });
  });

  it('visar bilder för en betrodd avsändare, oavsett skiftläge', () => {
    expect(remoteImagePolicy({ from: 'Nyheter@Butiken.SE', role: 'inbox', trusted, sentTo })).toEqual({ auto: true, reason: 'trusted', junk: false });
  });

  it('visar bilder för en adress användaren har skrivit till', () => {
    expect(remoteImagePolicy({ from: 'ANNA@nordljus.se', role: 'inbox', trusted, sentTo })).toEqual({ auto: true, reason: 'sent', junk: false });
  });

  it('kräver hela adressen, inte domänen eller en del av den', () => {
    expect(remoteImagePolicy({ from: 'reklam@butiken.se', role: 'inbox', trusted, sentTo }).auto).toBe(false);
    expect(remoteImagePolicy({ from: 'nyheter@butiken.se.bluff.example', role: 'inbox', trusted, sentTo }).auto).toBe(false);
    expect(remoteImagePolicy({ from: 'xnyheter@butiken.se', role: 'inbox', trusted, sentTo }).auto).toBe(false);
  });

  it('litar aldrig på visningsnamnet', () => {
    // Namnet är den betrodda adressen, men den riktiga adressen är en annan.
    const from = { name: 'nyheter@butiken.se', address: 'bluff@exempel.se' };
    expect(remoteImagePolicy({ from: from.address, role: 'inbox', trusted, sentTo }).auto).toBe(false);
    expect(remoteImagePolicy({ from: 'nyheter@butiken.se <bluff@exempel.se>', role: 'inbox', trusted, sentTo }).auto).toBe(false);
  });

  it('laddar aldrig bilder direkt i skräpposten', () => {
    expect(remoteImagePolicy({ from: 'nyheter@butiken.se', role: 'junk', trusted, sentTo })).toEqual({ auto: false, reason: null, junk: true });
    expect(remoteImagePolicy({ from: 'anna@nordljus.se', role: 'junk', trusted, sentTo })).toEqual({ auto: false, reason: null, junk: true });
    expect(remoteImagePolicy({ from: 'anna@nordljus.se', role: 'other', folder: 'Spam', trusted, sentTo }).auto).toBe(false);
    expect(remoteImagePolicy({ from: 'anna@nordljus.se', role: 'archive', labels: ['\\Junk'], trusted, sentTo }).auto).toBe(false);
  });

  it('visar inget direkt när avsändaren saknas', () => {
    expect(remoteImagePolicy({ from: '', role: 'inbox', trusted: new Set(['']), sentTo: new Set(['']) }).auto).toBe(false);
    expect(remoteImagePolicy({ from: undefined, role: 'inbox', trusted: none, sentTo: none }).auto).toBe(false);
  });
});

describe('betrodda avsändare i databasen', () => {
  const file = () => join(mkdtempSync(join(tmpdir(), 'brevlada-betrodda-')), 'db.sqlite');

  it('sparar med små bokstäver, utan dubbletter, och tar bort', () => {
    const store = new Store(file());
    expect(store.trustedSenders()).toEqual([]);
    expect(store.setTrustedSender(' Nyheter@Butiken.se ', true, 100)).toBe(true);
    expect(store.setTrustedSender('nyheter@butiken.se', true, 200)).toBe(true);
    expect(store.setTrustedSender('anna@nordljus.se', true, 300)).toBe(true);
    expect(store.trustedSenders().map((s) => ({ ...s }))).toEqual([
      { address: 'anna@nordljus.se', added: 300 },
      { address: 'nyheter@butiken.se', added: 100 }
    ]);
    expect(store.isTrustedSender('NYHETER@butiken.se')).toBe(true);
    expect(store.isTrustedSender('reklam@butiken.se')).toBe(false);
    expect(store.setTrustedSender('Nyheter@butiken.se', false)).toBe(true);
    expect(store.trustedSenders().map((s) => s.address)).toEqual(['anna@nordljus.se']);
    store.close();
  });

  it('vägrar spara något som inte är en adress', () => {
    const store = new Store(file());
    expect(store.setTrustedSender('Anna Berg', true)).toBe(false);
    expect(store.setTrustedSender('', true)).toBe(false);
    expect(store.trustedSenders()).toEqual([]);
    store.close();
  });

  it('finns kvar när databasen öppnas igen', () => {
    const f = file();
    const first = new Store(f);
    first.setTrustedSender('nyheter@butiken.se', true, 1);
    first.close();
    const again = new Store(f);
    expect(again.isTrustedSender('nyheter@butiken.se')).toBe(true);
    again.close();
  });

  it('räknar mottagare i Skickat som betrodda, men inte avsändare i inkorgen', () => {
    const store = new Store(file());
    store.upsertFolder('a', 'INBOX', 'Inkorg', 'inbox');
    store.upsertFolder('a', 'Sent', 'Skickat', 'sent');
    store.upsertFolder('a', 'Junk', 'Skräppost', 'junk');
    const base = { accountId: 'a', uidValidity: 1, cc: [], date: 1, preview: '', seen: true, flagged: false, answered: false, hasAttachments: false };
    store.upsertMessage({ ...base, id: Store.messageId('a', 'Sent', 1, 1), folder: 'Sent', uid: 1, subject: 'Hej', from: { name: 'Alex', address: 'alex@nordljus.se' }, to: [{ name: 'Anna', address: 'Anna@Nordljus.se' }], messageId: '<1@x>' });
    store.upsertMessage({ ...base, id: Store.messageId('a', 'INBOX', 1, 2), folder: 'INBOX', uid: 2, subject: 'Rea', from: { name: 'Butiken', address: 'reklam@butiken.se' }, to: [{ name: 'Alex', address: 'alex@nordljus.se' }], messageId: '<2@x>' });
    const sentTo = store.sentToAddresses();
    const trusted = new Set(store.trustedSenders().map((s) => s.address));
    expect(remoteImagePolicy({ from: 'anna@nordljus.se', role: store.folderRole('a', 'INBOX'), folder: 'INBOX', trusted, sentTo })).toMatchObject({ auto: true, reason: 'sent' });
    expect(remoteImagePolicy({ from: 'reklam@butiken.se', role: store.folderRole('a', 'INBOX'), folder: 'INBOX', trusted, sentTo }).auto).toBe(false);
    expect(remoteImagePolicy({ from: 'anna@nordljus.se', role: store.folderRole('a', 'Junk'), folder: 'Junk', trusted, sentTo })).toMatchObject({ auto: false, junk: true });
    store.close();
  });
});
