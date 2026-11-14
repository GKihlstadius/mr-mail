import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Folder } from '../src/shared/types';
import { buildFolderTree, folderLabel, isGmailInternal, moveTargets } from '../src/renderer/folderTree';
import { Store } from '../src/main/db';

const f = (path: string, role: Folder['role'] = 'other', parent = ''): Folder => ({
  accountId: 'a',
  path,
  name: path.split(/[./]/).pop()!,
  role,
  parent,
  unread: 0
});

describe('mappträd', () => {
  it('ordnar förälder före barn och sorterar syskon', () => {
    const tree = buildFolderTree([f('Kunder.Övrigt', 'other', 'Kunder'), f('Kunder'), f('Kunder.Stockholm', 'other', 'Kunder'), f('Arkiv 2025'), f('INBOX', 'inbox')]);
    expect(tree.map((n) => `${n.depth}:${n.folder.name}`)).toEqual(['0:Arkiv 2025', '0:Kunder', '1:Stockholm', '1:Övrigt']);
  });

  it('döljer Gmails interna mappar', () => {
    expect(isGmailInternal('[Gmail]/Viktigt')).toBe(true);
    expect(isGmailInternal('Kunder/Gmail')).toBe(false);
    expect(folderLabel('archive', '[Gmail]/Alla mejl')).toBe('Alla mejl');
    expect(folderLabel('archive', 'Archive')).toBe('Arkiv');
    const tree = buildFolderTree([f('[Gmail]/Stjärnmärkt', 'other', '[Gmail]'), f('Resor')]);
    expect(tree.map((n) => n.folder.path)).toEqual(['Resor']);
  });

  it('Flytta till listar specialmappar först', () => {
    const t = moveTargets([f('Kunder'), f('Trash', 'trash'), f('INBOX', 'inbox')]);
    expect(t.map((x) => x.label)).toEqual(['Inkorg', 'Papperskorg', 'Kunder']);
  });
});

describe('olästa per mapp och etiketter i cachen', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'brevlada-mappar-')), 'db.sqlite'));
  const msg = (uid: number, folder: string, seen: boolean, labels: string[] = []) => {
    const id = Store.messageId('a', folder, 1, uid);
    store.upsertMessage({
      id,
      accountId: 'a',
      folder,
      uid,
      uidValidity: 1,
      subject: `m${uid}`,
      from: { name: '', address: 'x@y.se' },
      to: [],
      cc: [],
      date: uid,
      preview: '',
      seen,
      flagged: false,
      answered: false,
      hasAttachments: false,
      messageId: `<${uid}@y.se>`
    });
    if (labels.length) store.setMessageLabels(id, labels);
    return id;
  };

  it('STATUS-räknaren följer lokala ändringar', () => {
    store.upsertFolder('a', 'Kunder', 'Kunder', 'other');
    const id = msg(1, 'Kunder', false);
    store.setFolderUnread('a', 'Kunder', 12);
    const unread = () => store.listFolders().find((x) => x.path === 'Kunder')!.unread;
    expect(unread()).toBe(12);
    store.setFlags(id, { seen: true });
    expect(unread()).toBe(11);
    store.setFlags(id, { seen: true });
    expect(unread()).toBe(11);
    store.setFlags(id, { seen: false });
    store.deleteMessages([id]);
    expect(unread()).toBe(11);
  });

  it('etiketter som redan är mappar listas inte två gånger', () => {
    store.upsertFolder('a', 'Resor', 'Resor', 'other');
    msg(2, 'INBOX', true, ['Resor', 'Kvitton', '\\Important']);
    expect(store.distinctLabels('a')).toEqual(['Kvitton']);
    expect(store.listLabelMessages('a', 'Kvitton').map((m) => m.subject)).toEqual(['m2']);
  });
});
