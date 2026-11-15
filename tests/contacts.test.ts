import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/main/db';
import type { Address } from '../src/shared/types';

function fresh() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'brevlada-kontakter-')), 'db.sqlite'));
  store.upsertFolder('a', 'INBOX', 'Inkorg', 'inbox');
  store.upsertFolder('a', 'Sent', 'Skickat', 'sent');
  store.upsertFolder('a', 'Archive', 'Arkiv', 'archive');
  store.upsertFolder('a', 'Trash', 'Papperskorg', 'trash');
  return store;
}

let uid = 0;
function add(store: Store, folder: string, from: Address, to: Address[], subject: string, date: number, mid: string) {
  uid++;
  store.upsertMessage({
    id: Store.messageId('a', folder, 1, uid),
    accountId: 'a',
    folder,
    uid,
    uidValidity: 1,
    subject,
    from,
    to,
    cc: [],
    date,
    preview: subject,
    seen: true,
    flagged: false,
    answered: false,
    hasAttachments: false,
    messageId: mid
  });
}

const me = { name: 'Alex', address: 'alex@nordljus.se' };
const karin = { name: 'Karin Lund', address: 'Karin@Exempel.se' };
const erik = { name: 'Erik', address: 'erik@exempel.se' };

describe('kontakter', () => {
  it('listar flest mejl först, utan de egna adresserna', () => {
    const s = fresh();
    add(s, 'INBOX', karin, [me], 'Demo', 1000, '<1@x>');
    add(s, 'Sent', me, [karin], 'Re: Demo', 2000, '<2@x>');
    add(s, 'INBOX', erik, [me], 'Hej', 1500, '<3@x>');
    const list = s.contactList('', [me.address]);
    expect(list.map((c) => c.address)).toEqual(['karin@exempel.se', 'erik@exempel.se']);
    expect(list[0]).toMatchObject({ name: 'Karin Lund', count: 2, last: 2000 });
    expect(s.contactList('lund', [me.address]).map((c) => c.address)).toEqual(['karin@exempel.se']);
    expect(s.contactList('100%', [me.address])).toEqual([]);
  });

  it('räknar åt båda hållen och visar de senaste mejlen en gång', () => {
    const s = fresh();
    add(s, 'INBOX', karin, [me], 'Demo', 1000, '<1@x>');
    add(s, 'Archive', karin, [me], 'Demo', 1000, '<1@x>');
    add(s, 'Sent', me, [karin], 'Re: Demo', 2000, '<2@x>');
    add(s, 'Trash', karin, [me], 'Gammalt', 500, '<4@x>');
    add(s, 'INBOX', erik, [me], 'Hej', 1500, '<3@x>');
    const d = s.contactDetail('karin@exempel.se');
    expect(d.received).toBe(1);
    expect(d.sent).toBe(1);
    expect(d.name).toBe('Karin Lund');
    expect(d.recent.map((m) => m.subject)).toEqual(['Re: Demo', 'Demo']);
  });
});
