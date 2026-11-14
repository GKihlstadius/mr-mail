import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { makeAccount } from '../src/shared/accounts';
import { Store } from '../src/main/db';
import { AccountSession, testImap } from '../src/main/imap';
import { buildRaw, sendRaw, testSmtp } from '../src/main/smtp';
import { parseMessage } from '../src/main/parse';
import { htmlMail } from './fixtures';

// Kör mot GreenMail i Docker: imap 3143, smtp 3025, utan kryptering och med auth.disabled.
const HOST = process.env.GREENMAIL_HOST ?? '127.0.0.1';
const run = Date.now().toString(36);
const me = `alex-${run}@test.local`;
const other = `anna-${run}@test.local`;

const cfg = makeAccount(me, 'manual', {
  name: 'Test',
  displayName: 'Alex Test',
  imap: { host: HOST, port: 3143, security: 'none' },
  smtp: { host: HOST, port: 3025, security: 'none' }
});

async function reachable(port: number) {
  return new Promise<boolean>((resolve) => {
    const s = net.connect(port, HOST);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

const smtp = nodemailer.createTransport({ host: HOST, port: 3025, secure: false, ignoreTLS: true });

async function deliver(to: string, subject: string, text: string) {
  await smtp.sendMail({ from: 'Anna Andersson <anna@test.local>', to, subject, text });
}

async function waitFor<T>(fn: () => T | Promise<T>, label: string, timeout = 20000): Promise<NonNullable<T>> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Tidsgräns: ${label}`);
}

async function directClient(user: string) {
  const c = new ImapFlow({ host: HOST, port: 3143, secure: false, auth: { user, pass: 'x' }, logger: false });
  await c.connect();
  return c;
}

const available = await reachable(3143);

describe.runIf(available)('IMAP och SMTP mot GreenMail', () => {
  let dir: string;
  let store: Store;
  let session: AccountSession;
  const states: string[] = [];
  const newMail: string[][] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'brevlada-test-'));
    store = new Store(join(dir, 'test.db'));
    store.saveAccount(cfg);
    await deliver(me, 'Första mejlet', 'Hej Alex!\nDet här är det första mejlet.');
    await deliver(me, 'Andra mejlet', 'Två.');
    await smtp.sendMail({ envelope: { from: 'news@shop.se', to: [me] }, raw: htmlMail });
    session = new AccountSession(cfg, 'hemligt', store, {
      onStatus: (_id, s) => states.push(s),
      onChanged: () => undefined,
      onNewMail: (_id, ids) => newMail.push(ids)
    });
    session.start();
    await waitFor(() => states.includes('online'), 'ansluten');
  });

  afterAll(async () => {
    await session?.stop();
    store?.close();
    smtp.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('testar inloggning för IMAP och SMTP', async () => {
    expect(await testImap(cfg, 'x')).toBeNull();
    expect(await testSmtp(cfg, 'x')).toBeNull();
    const bad = { ...cfg, imap: { ...cfg.imap, port: 1 } };
    expect(await testImap(bad, 'x')).toMatch(/vägrade|kontakt|bröts/);
  });

  it('skapar standardmappar och synkar inkorgen med förhandsvisning', () => {
    expect(states.slice(0, 3)).toEqual(['connecting', 'syncing', 'online']);
    const roles = store.listFolders().map((f) => f.role).sort();
    expect(roles).toEqual(['archive', 'drafts', 'inbox', 'sent', 'trash']);
    const inbox = store.listFolderMessages(cfg.id, 'INBOX');
    expect(inbox.map((m) => m.subject).sort()).toEqual(['Andra mejlet', 'Erbjudande', 'Första mejlet']);
    const first = inbox.find((m) => m.subject === 'Första mejlet')!;
    expect(first.preview).toBe('Hej Alex! Det här är det första mejlet.');
    expect(first.from).toEqual({ name: 'Anna Andersson', address: 'anna@test.local' });
    expect(first.seen).toBe(false);
    expect(inbox.find((m) => m.subject === 'Erbjudande')!.hasAttachments).toBe(true);
    expect(store.unreadCount(cfg.id)).toBe(3);
  });

  it('hämtar hela meddelandet och bilagor', async () => {
    const m = store.listFolderMessages(cfg.id, 'INBOX').find((x) => x.subject === 'Erbjudande')!;
    const src = await session.fetchSource(m.folder, m.uid);
    const parsed = await parseMessage(src);
    expect(parsed.body.html).toContain('Allt ska bort');
    expect(parsed.body.attachments.find((a) => !a.inline)?.filename).toBe('faktura.pdf');
  });

  it('markerar läst och flaggar på servern', async () => {
    const m = store.listFolderMessages(cfg.id, 'INBOX').find((x) => x.subject === 'Andra mejlet')!;
    await session.setFlag(m.folder, m.uid, '\\Seen', true);
    await session.setFlag(m.folder, m.uid, '\\Flagged', true);
    const c = await directClient(me);
    const lock = await c.getMailboxLock('INBOX');
    const msg = await c.fetchOne(String(m.uid), { flags: true }, { uid: true });
    lock.release();
    await c.logout();
    expect(msg && [...msg.flags!].sort()).toEqual(['\\Flagged', '\\Seen']);
  });

  it('skapar egna mappar, även inuti en annan mapp', async () => {
    const top = await session.createFolder('Projekt');
    const sub = await session.createFolder('LinkedIn', top);
    const paths = store.listFolders().filter((f) => f.accountId === cfg.id).map((f) => f.path);
    expect(paths).toContain(top);
    expect(paths).toContain(sub);
    expect(store.listFolders().find((f) => f.path === sub)?.parent).toBe(top);
  });

  it('arkiverar och raderar', async () => {
    const inbox = store.listFolderMessages(cfg.id, 'INBOX');
    const a = inbox.find((x) => x.subject === 'Andra mejlet')!;
    const archive = await session.move(a.folder, a.uid, 'archive');
    await session.syncFolderNow(archive);
    await session.syncFolderNow('INBOX');
    expect(store.listFolderMessages(cfg.id, archive).map((m) => m.subject)).toEqual(['Andra mejlet']);
    expect(store.listFolderMessages(cfg.id, archive)[0].flagged).toBe(true);

    const b = store.listFolderMessages(cfg.id, 'INBOX').find((x) => x.subject === 'Erbjudande')!;
    const trash = await session.move(b.folder, b.uid, 'trash');
    await session.syncFolderNow(trash);
    const inTrash = store.listFolderMessages(cfg.id, trash)[0];
    expect(inTrash.subject).toBe('Erbjudande');
    await session.deletePermanently(trash, inTrash.uid);
    await session.syncFolderNow(trash);
    await session.syncFolderNow('INBOX');
    expect(store.listFolderMessages(cfg.id, trash)).toEqual([]);
    expect(store.listFolderMessages(cfg.id, 'INBOX').map((m) => m.subject)).toEqual(['Första mejlet']);
  });

  it('märker nya mejl direkt via IDLE', async () => {
    const before = newMail.length;
    await deliver(me, 'Kom precis', 'Nytt mejl under IDLE.');
    const ids = await waitFor(() => newMail[before], 'avisering om nytt mejl', 15000);
    expect(ids).toHaveLength(1);
    expect(store.getMessage(ids[0])!.subject).toBe('Kom precis');
  });

  it('skickar via SMTP, sparar i Skickat och kommer fram', async () => {
    const { raw, recipients } = await buildRaw(cfg, {
      to: `Anna <${other}>`,
      cc: '',
      bcc: 'dold@test.local',
      subject: 'Re: Första mejlet',
      text: 'Hej Anna!\n\nTack, det låter bra.\n\nVänliga hälsningar,\nAlex',
      inReplyTo: '<m1@test.local>',
      references: ['<m1@test.local>'],
      attachments: [{ filename: 'hej.txt', content: Buffer.from('hej') }]
    });
    expect(recipients).toEqual([other, 'dold@test.local']);
    expect(raw.toString()).not.toMatch(/^Bcc:/im);
    await sendRaw(cfg, 'x', raw, recipients);
    await session.append('sent', raw, ['\\Seen']);
    const sent = session.rolePath('sent')!;
    await session.syncFolderNow(sent);
    expect(store.listFolderMessages(cfg.id, sent)[0].subject).toBe('Re: Första mejlet');

    const c = await directClient(other);
    const got = await waitFor(async () => {
      const lock = await c.getMailboxLock('INBOX');
      try {
        const m = await c.fetchOne('*', { source: true });
        return m && m.source ? m.source : null;
      } finally {
        lock.release();
      }
    }, 'mottaget mejl');
    await c.logout();
    const parsed = await parseMessage(got);
    expect(parsed.subject).toBe('Re: Första mejlet');
    expect(parsed.from).toEqual({ name: 'Alex Test', address: me });
    expect(parsed.body.inReplyTo).toBe('<m1@test.local>');
    expect(parsed.body.attachments[0].filename).toBe('hej.txt');
    expect(parsed.body.text).toContain('Tack, det låter bra.');
  });

  it('söker lokalt i hämtade mejl', () => {
    expect(store.search({ text: 'första' }).map((m) => m.subject)).toContain('Första mejlet');
    expect(store.search({ text: 'anna kom' }).map((m) => m.subject)).toEqual(['Kom precis']);
    expect(store.search({ text: 'finnsinte' })).toEqual([]);
  });

  it('listar alla mappar som ett träd och flyttar till en egen mapp', async () => {
    const c = await directClient(me);
    await c.mailboxCreate('Kunder');
    const stockholm = await c.mailboxCreate(['Kunder', 'Stockholm']);
    const oevrigt = await c.mailboxCreate(['Kunder', 'Övrigt']);
    await c.logout();

    await session.syncNow();

    const folders = store.listFolders().filter((f) => f.accountId === cfg.id);
    const root = folders.find((f) => f.path === 'Kunder');
    const child = folders.find((f) => f.path === stockholm.path);
    expect(root?.name).toBe('Kunder');
    expect(root?.role).toBe('other');
    expect(root?.parent).toBe('');
    expect(child).toBeTruthy();
    expect(child?.name).toBe('Stockholm');
    expect(child?.role).toBe('other');
    expect(child?.parent).toBe('Kunder');
    expect(folders.some((f) => f.path === oevrigt.path && f.parent === 'Kunder')).toBe(true);

    const inbox = store.listFolderMessages(cfg.id, 'INBOX');
    const m = inbox.find((x) => x.subject === 'Första mejlet')!;
    expect(m).toBeTruthy();
    await session.moveToFolder(m.folder, m.uid, oevrigt.path);
    await session.syncFolderNow(oevrigt.path);
    await session.syncFolderNow('INBOX');
    expect(store.listFolderMessages(cfg.id, oevrigt.path).map((x) => x.subject)).toContain('Första mejlet');
    expect(store.listFolderMessages(cfg.id, 'INBOX').map((x) => x.subject)).not.toContain('Första mejlet');

    // Olästa-räknaren visas för den egna mappen i trädet.
    const target = store.listFolders().find((f) => f.path === oevrigt.path);
    expect(target?.unread).toBeGreaterThanOrEqual(1);
  });

  it('sparar utkast som HTML, hittar versioner via rubriken och tar bort dem', async () => {
    const key = `k${run}`;
    const make = async (text: string) =>
      (
        await buildRaw(
          cfg,
          { to: '', cc: '', bcc: 'dold@test.local', subject: 'Utkast', text, html: `<div><b>${text}</b></div>`, attachments: [], headers: { 'X-Brevlada-Draft': key } },
          { draft: true }
        )
      ).raw;
    const first = await session.append('drafts', await make('ett'), ['\\Draft', '\\Seen']);
    const second = await session.append('drafts', await make('två'), ['\\Draft', '\\Seen']);
    expect(first?.path).toBe(second?.path);
    const uids = await session.searchHeader(first!.path, 'X-Brevlada-Draft', key);
    expect(uids.length).toBe(2);
    const newest = second?.uid ?? Math.max(...uids);
    await session.deleteUids(first!.path, uids.filter((u) => u !== newest));
    expect(await session.searchHeader(first!.path, 'X-Brevlada-Draft', key)).toEqual([newest]);

    await session.syncFolderNow(first!.path);
    const saved = store.listFolderMessages(cfg.id, first!.path).find((m) => m.subject === 'Utkast')!;
    const parsed = await parseMessage(await session.fetchSource(saved.folder, saved.uid));
    expect(parsed.body.html).toContain('<b>två</b>');
    expect(parsed.body.text).toContain('två');
    expect(parsed.parsed.bcc).toBeTruthy();
  });

  it('föreslår kontakter från cachen', () => {
    const hits = store.contacts('anna', [me]);
    expect(hits[0]?.address).toBe('anna@test.local');
    expect(hits[0]?.name).toBe('Anna Andersson');
    expect(store.contacts('anna', ['anna@test.local']).some((c) => c.address === 'anna@test.local')).toBe(false);
  });

  it('ansluter och skickar med OAuth-token (XOAUTH2)', async () => {
    const user = `oauth-${run}@test.local`;
    await deliver(user, 'Via token', 'Hej');
    const acc = makeAccount(user, 'manual', { name: 'OAuth', imap: cfg.imap, smtp: cfg.smtp, auth: 'oauth' });
    const s3 = new Store(join(dir, 'oauth.db'));
    s3.saveAccount(acc);
    let calls = 0;
    const token = async () => {
      calls++;
      return 'token-abc';
    };
    expect(await testImap(acc, token)).toBeNull();
    expect(await testSmtp(acc, { accessToken: 'token-abc' })).toBeNull();
    const st: string[] = [];
    const s = new AccountSession(acc, token, s3, { onStatus: (_i, x) => st.push(x), onChanged: () => undefined, onNewMail: () => undefined });
    s.start();
    try {
      await waitFor(() => st.includes('online'), 'ansluten med token');
      expect(s3.listFolderMessages(acc.id, 'INBOX').map((m) => m.subject)).toEqual(['Via token']);
      expect(calls).toBeGreaterThanOrEqual(2);
      const { raw, recipients } = await buildRaw(acc, { to: other, cc: '', bcc: '', subject: 'Skickat med token', text: 'x', attachments: [] });
      await sendRaw(acc, { accessToken: await token() }, raw, recipients);
    } finally {
      await s.stop();
      s3.close();
    }
    // En token som inte går att förnya visas som fel i stället för att krascha.
    const s4 = new Store(join(dir, 'oauth2.db'));
    const failing = new AccountSession(acc, async () => Promise.reject(Object.assign(new Error('Inloggningen har gått ut eller dragits tillbaka. Logga in igen.'), { code: 'invalid_grant' })), s4, {
      onStatus: (_i, x, e) => st.push(`${x}:${e ?? ''}`),
      onChanged: () => undefined,
      onNewMail: () => undefined
    });
    failing.start();
    await waitFor(() => st.some((x) => x.startsWith('error:Inloggningen har gått ut')), 'fel visas');
    await failing.stop();
    s4.close();
  });

  it('grupperar svar i samma tråd via In-Reply-To och References', async () => {
    const root = `<rot-${run}@test.local>`;
    const reply = `<svar-${run}@test.local>`;
    await smtp.sendMail({ from: 'Erik <erik@test.local>', to: me, subject: 'Planering', text: 'Ses vi?', messageId: root });
    await smtp.sendMail({ from: 'Anna <anna@test.local>', to: me, subject: 'Re: Planering', text: 'Ja!', messageId: reply, inReplyTo: root, references: [root] });
    await smtp.sendMail({ from: 'Erik <erik@test.local>', to: me, subject: 'Re: Planering', text: 'Bra.', inReplyTo: reply, references: [root, reply] });
    await waitFor(async () => {
      await session.syncFolderNow('INBOX');
      return store.listFolderMessages(cfg.id, 'INBOX').filter((m) => m.subject.includes('Planering')).length === 3;
    }, 'tråden synkad');
    const msgs = store.listFolderMessages(cfg.id, 'INBOX').filter((m) => m.subject.includes('Planering'));
    expect(new Set(msgs.map((m) => m.threadId)).size).toBe(1);
    const grouped = store.groupThreads(store.listFolderMessages(cfg.id, 'INBOX'));
    const row = grouped.find((m) => m.subject.includes('Planering'))!;
    expect(row.threadCount).toBe(3);
    expect(grouped.filter((m) => m.subject.includes('Planering')).length).toBe(1);
    expect(store.thread(row.id).map((m) => m.from.name).sort()).toEqual(['Anna', 'Erik', 'Erik']);
  });

  it('hittar tidigare mejl med samma person utanför tråden', () => {
    const row = store.listFolderMessages(cfg.id, 'INBOX').find((m) => m.subject === 'Re: Planering')!;
    const earlier = store.mailsWith(cfg.id, 'anna@test.local', row.threadId!, 10);
    const subjects = earlier.map((e) => e.summary.subject);
    expect(subjects).toContain('Första mejlet');
    expect(subjects).not.toContain('Re: Planering');
    expect(earlier.find((e) => e.summary.subject === 'Första mejlet')!.text).toContain('första mejlet');
  });

  it('hämtar äldre mejl vid scroll och söker på servern utanför cachen', async () => {
    const user = `arkiv-${run}@test.local`;
    for (let i = 1; i <= 6; i++) await deliver(user, `Gammalt ${i}`, i === 2 ? 'Kvitto för hyran' : `Text ${i}`);
    const acc = makeAccount(user, 'manual', { name: 'Arkiv', imap: cfg.imap, smtp: cfg.smtp });
    const s2 = new Store(join(dir, 'arkiv.db'));
    s2.saveAccount(acc);
    const states2: string[] = [];
    const small = new AccountSession(acc, 'x', s2, { onStatus: (_i, st) => states2.push(st), onChanged: () => undefined, onNewMail: () => undefined }, 2);
    small.start();
    try {
      await waitFor(() => states2.includes('online'), 'ansluten');
      expect(s2.listFolderMessages(acc.id, 'INBOX').map((m) => m.subject).sort()).toEqual(['Gammalt 5', 'Gammalt 6']);

      const hits = await small.searchServer({ text: 'hyran' });
      expect(hits.map((id) => s2.getMessage(id)?.subject)).toEqual(['Gammalt 2']);

      expect(await small.fetchOlder('INBOX', 2)).toBe(2);
      expect(s2.listFolderMessages(acc.id, 'INBOX').length).toBe(5);

      // En vanlig synk raderar inte de äldre mejlen som hämtats vid scroll eller sökning.
      await small.syncNow();
      expect(s2.listFolderMessages(acc.id, 'INBOX').map((m) => m.subject).sort()).toEqual(['Gammalt 2', 'Gammalt 3', 'Gammalt 4', 'Gammalt 5', 'Gammalt 6']);

      // Raderas ett äldre mejl på servern försvinner det ur cachen vid nästa synk.
      const c = await directClient(user);
      const lock = await c.getMailboxLock('INBOX');
      await c.messageDelete({ subject: 'Gammalt 3' });
      lock.release();
      await c.logout();
      await small.syncNow();
      expect(s2.listFolderMessages(acc.id, 'INBOX').map((m) => m.subject)).not.toContain('Gammalt 3');
      expect(await small.fetchOlder('INBOX', 10)).toBe(1);
      expect(await small.fetchOlder('INBOX', 10)).toBe(0);
    } finally {
      await small.stop();
      s2.close();
    }
  });
  it('Städa: skannar avsändare med listrubriker, flyttar allt från en avsändare och kör regler', async () => {
    const user = `stada-${run}@test.local`;
    const news = `nyheter-${run}@butik.test`;
    const lookalike = `extra-nyheter-${run}@butik.test`;
    const raw = (from: string, subject: string) =>
      [
        `From: Butiken <${from}>`,
        `To: ${user}`,
        `Subject: ${subject}`,
        `Message-ID: <${subject.replace(/\W/g, '')}-${run}@butik.test>`,
        `Date: ${new Date().toUTCString()}`,
        'List-Unsubscribe: <https://butik.test/avreg?u=1>',
        'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Rea!'
      ].join('\r\n');
    for (let i = 1; i <= 5; i++) await smtp.sendMail({ envelope: { from: news, to: [user] }, raw: raw(news, `Rea ${i}`) });
    await smtp.sendMail({ envelope: { from: lookalike, to: [user] }, raw: raw(lookalike, 'Annan rea') });
    await deliver(user, 'Personligt', 'Hej!');
    const acc = makeAccount(user, 'manual', { name: 'Städa', imap: cfg.imap, smtp: cfg.smtp });
    const s3 = new Store(join(dir, 'stada.db'));
    s3.saveAccount(acc);
    const st: string[] = [];
    const arrived: string[][] = [];
    const sess = new AccountSession(acc, 'x', s3, { onStatus: (_i, x) => st.push(x), onChanged: () => undefined, onNewMail: () => undefined, onArrived: (_a, ids) => arrived.push(ids) }, 2);
    sess.start();
    try {
      await waitFor(() => st.includes('online'), 'ansluten');
      expect(arrived.flat().length).toBe(2);
      expect(await sess.scanFolder('INBOX', 100)).toBe(7);
      const stats = s3.senderStats([user]);
      const shop = stats.find((x) => x.address === news)!;
      expect(shop).toMatchObject({ total: 5, unread: 5, unsubscribe: true, bulk: true });
      expect(s3.latestUnsubscribe(news)).toMatchObject({ header: '<https://butik.test/avreg?u=1>', oneClick: true, accountId: acc.id });
      const archive = sess.rolePath('archive')!;
      // Bara exakt avsändare flyttas, inte adresser som innehåller den.
      expect(await sess.moveFrom('INBOX', news, archive)).toBe(5);
      await sess.syncFolderNow('INBOX');
      const left = s3.listFolderMessages(acc.id, 'INBOX').map((m) => m.subject).sort();
      expect(left).toEqual(['Annan rea', 'Personligt']);
      expect(await sess.moveFrom('INBOX', news, archive)).toBe(0);
    } finally {
      await sess.stop();
      s3.close();
    }
  });
});
