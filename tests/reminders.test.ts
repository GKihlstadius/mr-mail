import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/main/db';
import { snoozeTimes, whenText } from '../src/renderer/components/PopMenu';

function fresh() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'brevlada-paminn-')), 'db.sqlite'));
  store.upsertFolder('a', 'INBOX', 'Inkorg', 'inbox');
  store.upsertFolder('a', 'Sent', 'Skickat', 'sent');
  return store;
}

function add(store: Store, uid: number, folder: string, from: string, subject: string, date: number, mid: string, inReplyTo: string | null = null) {
  const id = Store.messageId('a', folder, 1, uid);
  store.upsertMessage({
    id,
    accountId: 'a',
    folder,
    uid,
    uidValidity: 1,
    subject,
    from: { name: '', address: from },
    to: [],
    cc: [],
    date,
    preview: '',
    seen: true,
    flagged: false,
    answered: false,
    hasAttachments: false,
    messageId: mid
  });
  store.assignThread(id, 'a', mid, inReplyTo, inReplyTo ? [inReplyTo] : []);
  return id;
}

describe('påminnelser', () => {
  it('snooze döljer mejlet i inkorgen tills det tas bort', () => {
    const store = fresh();
    const id = add(store, 1, 'INBOX', 'anna@x.se', 'Hej', 1000, '<a@x>');
    const m = store.getMessage(id)!;
    store.setReminder(m, 'snooze', Date.now() + 60_000);
    expect(store.listRoleMessages('inbox')).toEqual([]);
    expect(store.dueReminders()).toEqual([]);
    expect(store.dueReminders(Date.now() + 120_000).map((r) => r.subject)).toEqual(['Hej']);
    expect(store.reminderMessage(store.listReminders()[0])?.id).toBe(id);
    store.clearReminder('a', Store.reminderKey(m), 'snooze');
    expect(store.listRoleMessages('inbox').map((x) => x.id)).toEqual([id]);
  });

  it('uppföljning ser svar från någon annan i tråden', () => {
    const store = fresh();
    const sent = add(store, 1, 'Sent', 'alex@nordljus.se', 'Offert', 1000, '<s@nordljus.se>');
    const m = store.getMessage(sent)!;
    expect(store.hasReplySince(m, 500, 'alex@nordljus.se')).toBe(false);
    add(store, 2, 'INBOX', 'alex@nordljus.se', 'Re: Offert', 2000, '<s2@nordljus.se>', '<s@nordljus.se>');
    expect(store.hasReplySince(m, 500, 'alex@nordljus.se')).toBe(false);
    add(store, 3, 'INBOX', 'anna@x.se', 'Re: Offert', 3000, '<r@x>', '<s@nordljus.se>');
    expect(store.hasReplySince(m, 500, 'alex@nordljus.se')).toBe(true);
    expect(store.hasReplySince(m, 5000, 'alex@nordljus.se')).toBe(false);
  });

  it('påminnelse via Message-ID hittar mejlet även efter flytt', () => {
    const store = fresh();
    store.setReminder({ id: '', accountId: 'a', messageId: '<flytt@x>', subject: 'Flytt' } as any, 'followup', 1);
    add(store, 9, 'Sent', 'alex@nordljus.se', 'Flytt', 1000, '<flytt@x>');
    expect(store.reminderMessage(store.listReminders()[0])?.subject).toBe('Flytt');
  });

  it('föreslår tider och skriver dem läsbart', () => {
    const now = new Date(2026, 10, 11, 10, 0);
    const t = snoozeTimes(now);
    expect(t.map((x) => x.label)).toEqual(['Om tre timmar', 'I kväll', 'I morgon', 'Nästa vecka']);
    expect(new Date(t[3].due).getDay()).toBe(1);
    expect(whenText(t[2].due, now)).toBe('i morgon 08:00');
    expect(snoozeTimes(new Date(2026, 10, 11, 20, 0)).map((x) => x.label)).toEqual(['I morgon', 'Nästa vecka']);
  });
});

describe('prestanda med 10 000 mejl', () => {
  it('listar och grupperar inkorgen snabbt', () => {
    const store = fresh();
    store.db.exec('BEGIN');
    for (let i = 0; i < 10_000; i++) add(store, i + 1, 'INBOX', `p${i % 300}@x.se`, `Ämne ${i}`, i * 1000, `<m${i}@x>`, i % 5 === 0 && i > 0 ? `<m${i - 1}@x>` : null);
    store.db.exec('COMMIT');
    const t0 = performance.now();
    const list = store.listRoleMessages('inbox', 10_001);
    const grouped = store.groupThreads(list);
    const ms = performance.now() - t0;
    expect(list.length).toBe(10_000);
    expect(grouped.length).toBeLessThan(10_000);
    expect(ms).toBeLessThan(1500);
  });
});
