import { DatabaseSync } from 'node:sqlite';
import { queryDates } from '../shared/search';
import type { OutboxItem, Reminder, ReminderKind } from '../shared/types';
import { categorize, type ListHeaders, type SenderStat } from '../shared/cleanup';
import type { CalendarEvent, CalendarInfo } from '../shared/calendar';
import type { AccountConfig, Address, AgentLogEntry, Contact, ContactDetail, ContactRow, Folder, FolderRole, MessageBody, MessageSummary, Settings, SearchQuery, TrustedSender } from '../shared/types';
import { normalizeAddress } from '../shared/trust';

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  aiEngine: 'openai',
  sparkUrl: '',
  sparkModel: '',
  sparkKey: '',
  claudePath: 'claude',
  localUrl: 'http://127.0.0.1:11434/v1',
  localModel: '',
  localKey: '',
  tone: 'Kort, vänligt och rakt på sak. Inga floskler, inga emojis.',
  notifications: true,
  syncLimit: 200,
  threads: true,
  openAtLogin: false,
  closeToTray: true,
  googleClientId: '',
  microsoftClientId: '',
  openaiUrl: 'https://api.openai.com/v1',
  openaiModel: '',
  codexPath: '',
  codexModel: '',
  signatures: [],
  sparkOffered: false,
  agentTools: true,
  agentHttp: false,
  agentHttpPort: 7337,
  agentHttpToken: '',
  agentPermissions: { send: 'ask', delete: 'ask', unsubscribe: 'ask' },
  cleanRules: [],
  cleanKeep: [],
  unsubscribed: {},
  undoSendSeconds: 10,
  cleanScanned: false,
  smartInbox: true,
  language: 'auto',
  templates: [],
  updateDir: ''
};

function rowToReminder(r: any): Reminder {
  return { accountId: r.account_id, key: r.message_key, kind: r.kind, due: r.due, created: r.created, state: r.state, subject: r.subject, messageId: r.message_id };
}

export interface StoredMessage extends MessageSummary {
  uidValidity: number;
}

export class Store {
  db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, position INTEGER NOT NULL, config TEXT NOT NULL, secret BLOB
      );
      CREATE TABLE IF NOT EXISTS folders (
        account_id TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
        parent TEXT NOT NULL DEFAULT '', uid_validity INTEGER NOT NULL DEFAULT 0,
        unread_status INTEGER NOT NULL DEFAULT -1,
        PRIMARY KEY (account_id, path)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL, uid_validity INTEGER NOT NULL,
        subject TEXT NOT NULL, from_name TEXT NOT NULL, from_addr TEXT NOT NULL,
        recipients TEXT NOT NULL, date INTEGER NOT NULL, preview TEXT NOT NULL,
        seen INTEGER NOT NULL, flagged INTEGER NOT NULL, answered INTEGER NOT NULL,
        has_attachments INTEGER NOT NULL, message_id TEXT NOT NULL, labels TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS messages_folder ON messages (account_id, folder, date DESC);
      CREATE INDEX IF NOT EXISTS messages_date ON messages (date DESC);
      CREATE INDEX IF NOT EXISTS messages_account ON messages (account_id, date DESC);
      CREATE TABLE IF NOT EXISTS bodies (
        id TEXT PRIMARY KEY, body TEXT NOT NULL, text TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_secrets (key TEXT PRIMARY KEY, value BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS reminders (
        account_id TEXT NOT NULL, message_key TEXT NOT NULL, kind TEXT NOT NULL,
        due INTEGER NOT NULL, created INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'waiting',
        subject TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (account_id, message_key, kind)
      );
    `);
    this.migrate();
  }

  // Lägger till kolumner som kommit till senare versioner, befintliga databaser uppgraderas.
  private migrate() {
    const columns = (table: string): Set<string> => {
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      return new Set(rows.map((r) => r.name));
    };
    if (!columns('folders').has('parent')) this.db.prepare("ALTER TABLE folders ADD COLUMN parent TEXT NOT NULL DEFAULT ''").run();
    if (!columns('folders').has('unread_status')) this.db.prepare('ALTER TABLE folders ADD COLUMN unread_status INTEGER NOT NULL DEFAULT -1').run();
    if (!columns('messages').has('labels')) this.db.prepare("ALTER TABLE messages ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'").run();
    if (!columns('messages').has('thread_id')) {
      this.db.prepare("ALTER TABLE messages ADD COLUMN thread_id TEXT NOT NULL DEFAULT ''").run();
      this.db.prepare("UPDATE messages SET thread_id = CASE WHEN message_id <> '' THEN message_id ELSE id END").run();
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS messages_thread ON messages (account_id, thread_id)');
    if (!columns('messages').has('list_unsub')) {
      this.db.prepare("ALTER TABLE messages ADD COLUMN list_unsub TEXT NOT NULL DEFAULT ''").run();
      this.db.prepare('ALTER TABLE messages ADD COLUMN list_post INTEGER NOT NULL DEFAULT 0').run();
      this.db.prepare('ALTER TABLE messages ADD COLUMN bulk INTEGER NOT NULL DEFAULT 0').run();
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS messages_from ON messages (from_addr COLLATE NOCASE)');
    this.db.exec(`CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY, due INTEGER NOT NULL, kind TEXT NOT NULL, created INTEGER NOT NULL, msg TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, tool TEXT NOT NULL, summary TEXT NOT NULL,
      ok INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '', client TEXT NOT NULL DEFAULT ''
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS invite_answers (
      account_id TEXT NOT NULL, uid TEXT NOT NULL, response TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL,
      PRIMARY KEY (account_id, uid)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS cal_calendars (
      account_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (account_id, id)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS cal_events (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, calendar_id TEXT NOT NULL,
      start INTEGER NOT NULL, end INTEGER NOT NULL, data TEXT NOT NULL
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS cal_events_time ON cal_events (start, end)');
    this.db.exec('CREATE TABLE IF NOT EXISTS trusted_senders (address TEXT PRIMARY KEY, added INTEGER NOT NULL)');
    const hasContacts = !!this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contacts'").get();
    if (!hasContacts) {
      this.db.exec(`CREATE TABLE contacts (
        address TEXT PRIMARY KEY, name TEXT NOT NULL, count INTEGER NOT NULL, last INTEGER NOT NULL
      )`);
      const rows = this.db.prepare('SELECT from_name, from_addr, recipients, date FROM messages').all() as any[];
      for (const r of rows) {
        const rec = JSON.parse(r.recipients) as { to: Address[]; cc: Address[] };
        this.addContacts([{ name: r.from_name, address: r.from_addr }, ...rec.to, ...rec.cc], r.date);
      }
    }
  }

  // Kontakter för adressförslag, samlade från avsändare och mottagare i cachen.
  private addContacts(list: Address[], date: number) {
    const stmt = this.db.prepare(
      `INSERT INTO contacts (address, name, count, last) VALUES (?, ?, 1, ?)
       ON CONFLICT(address) DO UPDATE SET count = count + 1, last = MAX(last, excluded.last),
         name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE contacts.name END`
    );
    for (const a of list) {
      const addr = a.address?.toLowerCase().trim();
      if (!addr || !addr.includes('@') || /no-?reply|mailer-daemon|notifications?@/i.test(addr)) continue;
      stmt.run(addr, (a.name ?? '').trim(), date);
    }
  }

  contacts(query: string, exclude: string[] = [], limit = 8): Contact[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const rows = this.db
      .prepare(
        `SELECT address, name, count FROM contacts
         WHERE (address LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\')
         ORDER BY (CASE WHEN address LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END), count DESC, last DESC
         LIMIT ?`
      )
      .all(like, like, `${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`, `${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`, limit + exclude.length) as unknown as Contact[];
    const skip = new Set(exclude.map((e) => e.toLowerCase()));
    return rows.filter((r) => !skip.has(r.address)).slice(0, limit);
  }

  // Kontakter: alla personer användaren mejlat med, flest mejl först. Söker i namn och adress.
  contactList(query: string, exclude: string[] = [], limit = 300): ContactRow[] {
    const q = query.trim().toLowerCase();
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const skip = exclude.map((e) => e.toLowerCase());
    const rows = this.db
      .prepare(
        `SELECT address, name, count, last FROM contacts
         WHERE (? = '' OR address LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\')
         ORDER BY count DESC, last DESC LIMIT ?`
      )
      .all(q, like, like, limit + skip.length) as unknown as ContactRow[];
    const own = new Set(skip);
    return rows.filter((r) => !own.has(r.address)).slice(0, limit);
  }

  // En kontakt: antal mejl åt båda hållen och de senaste mejlen, ett mejl en gång även om det finns i flera mappar.
  contactDetail(address: string, limit = 25): Omit<ContactDetail, 'events'> {
    const addr = address.toLowerCase().trim();
    const like = `%"${addr.replace(/[\\%_"]/g, (c) => '\\' + c)}"%`;
    const contact = this.db.prepare('SELECT name, last FROM contacts WHERE address = ?').get(addr) as { name: string; last: number } | undefined;
    const key = "CASE WHEN m.message_id <> '' THEN m.message_id ELSE m.id END";
    const received = (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT m.account_id || ${key}) AS c FROM messages m JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
           WHERE m.from_addr = ? COLLATE NOCASE AND f.role NOT IN ('sent', 'drafts', 'trash', 'junk')`
        )
        .get(addr) as { c: number }
    ).c;
    const sent = (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT m.account_id || ${key}) AS c FROM messages m JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
           WHERE f.role = 'sent' AND lower(m.recipients) LIKE ? ESCAPE '\\'`
        )
        .get(like) as { c: number }
    ).c;
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
         WHERE (m.from_addr = ? COLLATE NOCASE OR lower(m.recipients) LIKE ? ESCAPE '\\') AND f.role NOT IN ('drafts', 'trash', 'junk')
         ORDER BY m.date DESC LIMIT ?`
      )
      .all(addr, like, limit * 3) as any[];
    const seen = new Set<string>();
    const recent: MessageSummary[] = [];
    for (const r of rows) {
      const k = `${r.account_id}|${r.message_id || r.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      recent.push(this.rowToSummary(r));
      if (recent.length >= limit) break;
    }
    return { address: addr, name: contact?.name ?? '', received, sent, last: contact?.last ?? recent[0]?.date ?? 0, recent };
  }

  close() {
    this.db.close();
  }

  // Konton
  listAccounts(): AccountConfig[] {
    const rows = this.db.prepare('SELECT config FROM accounts ORDER BY position').all() as { config: string }[];
    return rows.map((r) => JSON.parse(r.config));
  }

  saveAccount(cfg: AccountConfig) {
    const exists = this.db.prepare('SELECT position FROM accounts WHERE id = ?').get(cfg.id) as { position: number } | undefined;
    if (exists) {
      this.db.prepare('UPDATE accounts SET config = ? WHERE id = ?').run(JSON.stringify(cfg), cfg.id);
    } else {
      const max = this.db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM accounts').get() as { m: number };
      this.db.prepare('INSERT INTO accounts (id, position, config) VALUES (?, ?, ?)').run(cfg.id, max.m + 1, JSON.stringify(cfg));
    }
  }

  deleteAccount(id: string) {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM bodies WHERE id IN (SELECT id FROM messages WHERE account_id = ?)').run(id);
    this.db.prepare('DELETE FROM messages WHERE account_id = ?').run(id);
    this.db.prepare('DELETE FROM folders WHERE account_id = ?').run(id);
    this.clearCalendarAccount(id);
    this.db.prepare('DELETE FROM invite_answers WHERE account_id = ?').run(id);
  }

  getSecret(id: string): Uint8Array | null {
    const row = this.db.prepare('SELECT secret FROM accounts WHERE id = ?').get(id) as { secret: Uint8Array | null } | undefined;
    return row?.secret ?? null;
  }

  setSecret(id: string, secret: Uint8Array | null) {
    this.db.prepare('UPDATE accounts SET secret = ? WHERE id = ?').run(secret, id);
  }

  // Krypterade värden som inte hör till ett konto, till exempel klienthemligheten för Google.
  getAppSecret(key: string): Uint8Array | null {
    const row = this.db.prepare('SELECT value FROM app_secrets WHERE key = ?').get(key) as { value: Uint8Array } | undefined;
    return row?.value ?? null;
  }

  setAppSecret(key: string, value: Uint8Array) {
    this.db.prepare('INSERT INTO app_secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  deleteAppSecret(key: string) {
    this.db.prepare('DELETE FROM app_secrets WHERE key = ?').run(key);
  }

  // Mappar
  upsertFolder(accountId: string, path: string, name: string, role: FolderRole, parent = '') {
    this.db
      .prepare(
        `INSERT INTO folders (account_id, path, name, role, parent) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id, path) DO UPDATE SET name = excluded.name, role = excluded.role, parent = excluded.parent`
      )
      .run(accountId, path, name, role, parent);
  }

  removeFoldersExcept(accountId: string, paths: string[]) {
    const existing = this.db.prepare('SELECT path FROM folders WHERE account_id = ?').all(accountId) as { path: string }[];
    for (const f of existing) {
      if (!paths.includes(f.path)) {
        this.db.prepare('DELETE FROM folders WHERE account_id = ? AND path = ?').run(accountId, f.path);
        this.db.prepare('DELETE FROM messages WHERE account_id = ? AND folder = ?').run(accountId, f.path);
      }
    }
  }

  listFolders(): Folder[] {
    const rows = this.db
      .prepare(
         `SELECT f.account_id, f.path, f.name, f.role, f.parent, f.unread_status,
          (SELECT COUNT(*) FROM messages m WHERE m.account_id = f.account_id AND m.folder = f.path AND m.seen = 0) AS unread
         FROM folders f`
      )
      .all() as any[];
    // STATUS från servern räknar hela mappen, cachen bara de senast hämtade. Lokala ändringar
    // justerar STATUS-värdet direkt (se setFlags och deleteMessages) så att räknaren följer med.
    return rows.map((r) => ({
      accountId: r.account_id,
      path: r.path,
      name: r.name,
      role: r.role,
      parent: r.parent ?? '',
      unread: r.unread_status >= 0 ? Math.max(r.unread_status, r.unread) : r.unread,
      statusUnread: r.unread_status
    }));
  }

  // Senaste olästaantalet från STATUS, används för mappar som inte synkas löpande.
  setFolderUnread(accountId: string, path: string, unseen: number) {
    this.db.prepare('UPDATE folders SET unread_status = ? WHERE account_id = ? AND path = ?').run(unseen, accountId, path);
  }

  folderByRole(accountId: string, role: FolderRole): string | null {
    const row = this.db.prepare('SELECT path FROM folders WHERE account_id = ? AND role = ? LIMIT 1').get(accountId, role) as
      | { path: string }
      | undefined;
    return row?.path ?? null;
  }

  folderRole(accountId: string, path: string): FolderRole | null {
    const row = this.db.prepare('SELECT role FROM folders WHERE account_id = ? AND path = ?').get(accountId, path) as { role: FolderRole } | undefined;
    return row?.role ?? null;
  }

  getUidValidity(accountId: string, path: string): number {
    const row = this.db.prepare('SELECT uid_validity FROM folders WHERE account_id = ? AND path = ?').get(accountId, path) as
      | { uid_validity: number }
      | undefined;
    return row?.uid_validity ?? 0;
  }

  setUidValidity(accountId: string, path: string, v: number) {
    this.db.prepare('UPDATE folders SET uid_validity = ? WHERE account_id = ? AND path = ?').run(v, accountId, path);
  }

  // Meddelanden
  static messageId(accountId: string, folder: string, uidValidity: number, uid: number) {
    return `${accountId}|${folder}|${uidValidity}|${uid}`;
  }

  knownUids(accountId: string, folder: string): Map<number, { seen: boolean; flagged: boolean; answered: boolean }> {
    const rows = this.db.prepare('SELECT uid, seen, flagged, answered FROM messages WHERE account_id = ? AND folder = ?').all(accountId, folder) as any[];
    return new Map(rows.map((r) => [r.uid, { seen: !!r.seen, flagged: !!r.flagged, answered: !!r.answered }]));
  }

  upsertMessage(m: StoredMessage) {
    // Kontakterna räknas bara när mejlet är nytt i cachen, inte när det uppdateras.
    const known = !!this.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(m.id);
    this.db
      .prepare(
        `INSERT INTO messages (id, account_id, folder, uid, uid_validity, subject, from_name, from_addr, recipients, date, preview,
          seen, flagged, answered, has_attachments, message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET seen = excluded.seen, flagged = excluded.flagged, answered = excluded.answered,
           preview = CASE WHEN excluded.preview <> '' THEN excluded.preview ELSE messages.preview END`
      )
      .run(
        m.id, m.accountId, m.folder, m.uid, m.uidValidity, m.subject, m.from.name, m.from.address,
        JSON.stringify({ to: m.to, cc: m.cc }), m.date, m.preview,
        m.seen ? 1 : 0, m.flagged ? 1 : 0, m.answered ? 1 : 0, m.hasAttachments ? 1 : 0, m.messageId
      );
    if (!known) this.addContacts([m.from, ...m.to, ...m.cc], m.date);
  }

  private adjustFolderUnread(id: string, delta: number) {
    this.db
      .prepare(
        `UPDATE folders SET unread_status = MAX(0, unread_status + ?)
         WHERE unread_status >= 0 AND (account_id, path) = (SELECT account_id, folder FROM messages WHERE id = ?)`
      )
      .run(delta, id);
  }

  setFlags(id: string, flags: { seen?: boolean; flagged?: boolean; answered?: boolean }) {
    if (flags.seen !== undefined) {
      const row = this.db.prepare('SELECT seen FROM messages WHERE id = ?').get(id) as { seen: number } | undefined;
      if (row && !!row.seen !== flags.seen) this.adjustFolderUnread(id, flags.seen ? -1 : 1);
    }
    if (flags.seen !== undefined) this.db.prepare('UPDATE messages SET seen = ? WHERE id = ?').run(flags.seen ? 1 : 0, id);
    if (flags.flagged !== undefined) this.db.prepare('UPDATE messages SET flagged = ? WHERE id = ?').run(flags.flagged ? 1 : 0, id);
    if (flags.answered !== undefined) this.db.prepare('UPDATE messages SET answered = ? WHERE id = ?').run(flags.answered ? 1 : 0, id);
  }

  setPreview(id: string, preview: string, hasAttachments: boolean) {
    this.db.prepare('UPDATE messages SET preview = ?, has_attachments = ? WHERE id = ?').run(preview, hasAttachments ? 1 : 0, id);
  }

  setMessageLabels(id: string, labels: string[]) {
    this.db.prepare('UPDATE messages SET labels = ? WHERE id = ?').run(JSON.stringify(labels), id);
  }

  // Distinkta Gmail-etiketter för ett konto, samlade från cachen. Etiketter som redan finns
  // som IMAP-mapp (Gmail visar användaretiketter som mappar) listas inte en gång till.
  distinctLabels(accountId: string): string[] {
    const folderPaths = new Set(
      (this.db.prepare('SELECT path FROM folders WHERE account_id = ?').all(accountId) as { path: string }[]).map((r) => r.path)
    );
    const rows = this.db
      .prepare("SELECT labels FROM messages WHERE account_id = ? AND labels IS NOT NULL AND labels <> '' AND labels <> '[]'")
      .all(accountId) as { labels: string }[];
    const set = new Set<string>();
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.labels);
        // Gmail skickar med systemetiketter som \Starred och \Important, de visas inte.
        if (Array.isArray(parsed)) for (const x of parsed) if (typeof x === 'string' && x && !x.startsWith('\\') && !folderPaths.has(x)) set.add(x);
      } catch {
        /* strunta på trasig JSON */
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'sv'));
  }

  // Meddelanden som bär en given etikett. Samma mejl kan finnas i flera mappar, dedupliceras.
  listLabelMessages(accountId: string, label: string, limit = 500): MessageSummary[] {
    const needle = JSON.stringify(label).replace(/[\\%_]/g, (c) => '\\' + c);
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE account_id = ? AND labels LIKE ? ESCAPE '\\' ORDER BY date DESC LIMIT ?")
      .all(accountId, `%${needle}%`, limit * 3) as any[];
    const seen = new Set<string>();
    const out: MessageSummary[] = [];
    for (const r of rows) {
      const key = r.message_id || r.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(this.rowToSummary(r));
      if (out.length >= limit) break;
    }
    return out;
  }

  deleteMessages(ids: string[]) {
    const del = this.db.prepare('DELETE FROM messages WHERE id = ?');
    const delBody = this.db.prepare('DELETE FROM bodies WHERE id = ?');
    const unseen = this.db.prepare('SELECT seen FROM messages WHERE id = ?');
    for (const id of ids) {
      const row = unseen.get(id) as { seen: number } | undefined;
      if (row && !row.seen) this.adjustFolderUnread(id, -1);
      del.run(id);
      delBody.run(id);
    }
  }

  clearFolder(accountId: string, folder: string) {
    this.db.prepare('DELETE FROM bodies WHERE id IN (SELECT id FROM messages WHERE account_id = ? AND folder = ?)').run(accountId, folder);
    this.db.prepare('DELETE FROM messages WHERE account_id = ? AND folder = ?').run(accountId, folder);
  }

  private rowToSummary(r: any): MessageSummary {
    const rec = JSON.parse(r.recipients) as { to: Address[]; cc: Address[] };
    let labels: string[] = [];
    if (r.labels) {
      try {
        const parsed = JSON.parse(r.labels);
        if (Array.isArray(parsed)) labels = parsed.filter((x) => typeof x === 'string' && !x.startsWith('\\'));
      } catch {
        labels = [];
      }
    }
    return {
      id: r.id,
      accountId: r.account_id,
      folder: r.folder,
      uid: r.uid,
      subject: r.subject,
      from: { name: r.from_name, address: r.from_addr },
      to: rec.to,
      cc: rec.cc,
      date: r.date,
      preview: r.preview,
      seen: !!r.seen,
      flagged: !!r.flagged,
      answered: !!r.answered,
      hasAttachments: !!r.has_attachments,
      messageId: r.message_id,
      labels,
      threadId: r.thread_id || undefined,
      category: categorize({ address: r.from_addr ?? '', subject: r.subject ?? '', bulk: !!r.bulk, unsubscribe: !!r.list_unsub })
    };
  }

  // Adresser användaren har skrivit till, från Skickat i cachen.
  sentToAddresses(): Set<string> {
    const rows = this.db
      .prepare("SELECT m.recipients FROM messages m JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder WHERE f.role = 'sent'")
      .all() as { recipients: string }[];
    const out = new Set<string>();
    for (const r of rows) {
      try {
        const rec = JSON.parse(r.recipients) as { to: Address[]; cc: Address[] };
        for (const a of [...rec.to, ...rec.cc]) if (a.address) out.add(a.address.toLowerCase());
      } catch {
        /* trasig rad hoppas över */
      }
    }
    return out;
  }

  messageIdFor(accountId: string, folder: string, uid: number): string | null {
    const r = this.db.prepare('SELECT id FROM messages WHERE account_id = ? AND folder = ? AND uid = ?').get(accountId, folder, uid) as { id: string } | undefined;
    return r?.id ?? null;
  }

  getMessage(id: string): StoredMessage | null {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any;
    return r ? { ...this.rowToSummary(r), uidValidity: r.uid_validity } : null;
  }

  listFolderMessages(accountId: string, folder: string, limit = 500): MessageSummary[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages m WHERE account_id = ? AND folder = ? AND ${this.snoozedFilter('m')} ORDER BY date DESC LIMIT ?`)
      .all(accountId, folder, limit) as any[];
    return rows.map((r) => this.rowToSummary(r));
  }

  folderCount(accountId: string, folder: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE account_id = ? AND folder = ?').get(accountId, folder) as { c: number }).c;
  }

  minUid(accountId: string, folder: string): number {
    const r = this.db.prepare('SELECT MIN(uid) AS u FROM messages WHERE account_id = ? AND folder = ?').get(accountId, folder) as { u: number | null };
    return r.u ?? 0;
  }

  listRoleMessages(role: FolderRole, limit = 500): MessageSummary[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
         WHERE f.role = ? AND ${this.snoozedFilter('m')} ORDER BY m.date DESC LIMIT ?`
      )
      .all(role, limit) as any[];
    return rows.map((r) => this.rowToSummary(r));
  }

  // Trådar: Gmail ger X-GM-THRID, annars följs References och In-Reply-To till ett känt mejl.
  assignThread(id: string, accountId: string, messageId: string, inReplyTo: string | null, references: string[], gmThread?: string) {
    let thread = gmThread ? `gm:${gmThread}` : '';
    if (!thread) {
      const related = [...references, ...(inReplyTo ? [inReplyTo] : [])].filter(Boolean);
      if (related.length) {
        const marks = related.map(() => '?').join(',');
        const hit = this.db
          .prepare(`SELECT thread_id FROM messages WHERE account_id = ? AND message_id IN (${marks}) AND thread_id <> '' LIMIT 1`)
          .get(accountId, ...related) as { thread_id: string } | undefined;
        thread = hit?.thread_id ?? related[0];
      }
    }
    if (!thread) thread = messageId || id;
    this.db.prepare('UPDATE messages SET thread_id = ? WHERE id = ?').run(thread, id);
    // Svar som kom före sitt original pekar redan på originalets Message-ID, de hör till samma tråd.
    if (messageId && messageId !== thread) {
      this.db.prepare('UPDATE messages SET thread_id = ? WHERE account_id = ? AND thread_id = ?').run(thread, accountId, messageId);
    }
  }

  // Samlar listan till en rad per konversation med antal mejl i tråden (utom papperskorg och skräppost).
  groupThreads(list: MessageSummary[]): MessageSummary[] {
    const out: MessageSummary[] = [];
    const seen = new Map<string, MessageSummary>();
    for (const m of list) {
      const key = `${m.accountId}|${m.threadId || m.id}`;
      const first = seen.get(key);
      if (first) {
        if (!m.seen) first.seen = false;
        if (m.flagged) first.flagged = true;
        continue;
      }
      const row = { ...m };
      seen.set(key, row);
      out.push(row);
    }
    // En fråga per konto och 400 trådar åt gången, så att långa listor (10 000 mejl) går snabbt.
    const byAccount = new Map<string, string[]>();
    for (const row of out) if (row.threadId) (byAccount.get(row.accountId) ?? byAccount.set(row.accountId, []).get(row.accountId)!).push(row.threadId);
    const counts = new Map<string, number>();
    for (const [acc, ids] of byAccount) {
      for (let i = 0; i < ids.length; i += 400) {
        const chunk = ids.slice(i, i + 400);
        const rows = this.db
          .prepare(
            `SELECT m.thread_id AS t, COUNT(DISTINCT CASE WHEN m.message_id <> '' THEN m.message_id ELSE m.id END) AS c
             FROM messages m JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
             WHERE m.account_id = ? AND m.thread_id IN (${chunk.map(() => '?').join(',')}) AND f.role NOT IN ('trash', 'junk')
             GROUP BY m.thread_id`
          )
          .all(acc, ...chunk) as { t: string; c: number }[];
        for (const r of rows) counts.set(`${acc}|${r.t}`, r.c);
      }
    }
    for (const row of out) if (row.threadId) row.threadCount = counts.get(`${row.accountId}|${row.threadId}`) ?? 1;
    return out;
  }

  // Hela konversationen för ett mejl, nyast först, en rad per Message-ID.
  thread(id: string): MessageSummary[] {
    const m = this.db.prepare('SELECT account_id, thread_id FROM messages WHERE id = ?').get(id) as any;
    if (!m || !m.thread_id) return [];
    const rows = this.db
      .prepare(
        `SELECT m.*, f.role AS folder_role FROM messages m JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
         WHERE m.account_id = ? AND m.thread_id = ? ORDER BY m.date DESC LIMIT 100`
      )
      .all(m.account_id, m.thread_id) as any[];
    const out: MessageSummary[] = [];
    const byKey = new Map<string, number>();
    for (const r of rows) {
      const hidden = (r.folder_role === 'trash' || r.folder_role === 'junk') && r.id !== id;
      if (hidden) continue;
      const key = r.message_id || r.id;
      const at = byKey.get(key);
      if (at !== undefined) {
        if (r.id === id) out[at] = this.rowToSummary(r);
        continue;
      }
      byKey.set(key, out.length);
      out.push(this.rowToSummary(r));
    }
    return out;
  }

  // Tidigare mejl till eller från en person, utanför en given tråd, nyast först. Text från cachen.
  mailsWith(accountId: string, address: string, excludeThread: string, limit = 5): { summary: MessageSummary; text: string }[] {
    const addr = address.toLowerCase();
    if (!addr) return [];
    const like = `%"${addr.replace(/[\\%_"]/g, (c) => '\\' + c)}"%`;
    const rows = this.db
      .prepare(
        `SELECT m.*, b.text AS body_text FROM messages m LEFT JOIN bodies b ON b.id = m.id
         JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
         WHERE m.account_id = ? AND (m.from_addr = ? OR m.recipients LIKE ? ESCAPE '\\') AND m.thread_id <> ?
           AND f.role NOT IN ('trash', 'junk')
         ORDER BY m.date DESC LIMIT ?`
      )
      .all(accountId, addr, like, excludeThread, limit * 3) as any[];
    const seen = new Set<string>();
    const out: { summary: MessageSummary; text: string }[] = [];
    for (const r of rows) {
      const key = r.message_id || r.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ summary: this.rowToSummary(r), text: r.body_text || r.preview || '' });
      if (out.length >= limit) break;
    }
    return out;
  }

  // Påminnelser: snooze döljer mejlet tills tiden är inne, uppföljning hör av sig om ingen svarat.
  // Nyckeln är Message-ID så att påminnelsen överlever flytt mellan mappar.
  static reminderKey(m: { id: string; messageId: string }): string {
    return m.messageId || m.id;
  }

  setReminder(m: MessageSummary, kind: ReminderKind, due: number) {
    this.db
      .prepare(
        `INSERT INTO reminders (account_id, message_key, kind, due, created, state, subject, message_id) VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?)
         ON CONFLICT(account_id, message_key, kind) DO UPDATE SET due = excluded.due, state = 'waiting', created = excluded.created`
      )
      .run(m.accountId, Store.reminderKey(m), kind, due, Date.now(), m.subject, m.id);
  }

  clearReminder(accountId: string, key: string, kind?: ReminderKind) {
    if (kind) this.db.prepare('DELETE FROM reminders WHERE account_id = ? AND message_key = ? AND kind = ?').run(accountId, key, kind);
    else this.db.prepare('DELETE FROM reminders WHERE account_id = ? AND message_key = ?').run(accountId, key);
  }

  setReminderState(accountId: string, key: string, kind: ReminderKind, state: 'waiting' | 'due') {
    this.db.prepare('UPDATE reminders SET state = ? WHERE account_id = ? AND message_key = ? AND kind = ?').run(state, accountId, key, kind);
  }

  dueReminders(now = Date.now()): Reminder[] {
    return (this.db.prepare("SELECT * FROM reminders WHERE state = 'waiting' AND due <= ? ORDER BY due").all(now) as any[]).map(rowToReminder);
  }

  listReminders(): Reminder[] {
    return (this.db.prepare('SELECT * FROM reminders ORDER BY due').all() as any[]).map(rowToReminder);
  }

  // Mejlet bakom en påminnelse: helst samma rad som när den sattes, annars samma Message-ID i någon mapp.
  reminderMessage(r: Reminder): MessageSummary | null {
    const direct = this.getMessage(r.messageId);
    if (direct) return direct;
    const row = this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
         WHERE m.account_id = ? AND m.message_id = ? ORDER BY CASE f.role WHEN 'inbox' THEN 0 WHEN 'sent' THEN 1 ELSE 2 END LIMIT 1`
      )
      .get(r.accountId, r.key) as any;
    return row ? this.rowToSummary(row) : null;
  }

  // Svar från någon annan i tråden efter en viss tid, för Följ upp om inget svar.
  hasReplySince(m: MessageSummary, since: number, ownEmail: string): boolean {
    if (!m.threadId) return false;
    const row = this.db
      .prepare('SELECT 1 FROM messages WHERE account_id = ? AND thread_id = ? AND date > ? AND from_addr <> ? LIMIT 1')
      .get(m.accountId, m.threadId, since, ownEmail.toLowerCase());
    return !!row;
  }

  private snoozedFilter(alias: string): string {
    return `NOT EXISTS (SELECT 1 FROM reminders r WHERE r.account_id = ${alias}.account_id AND r.kind = 'snooze' AND r.state = 'waiting'
      AND r.message_key = CASE WHEN ${alias}.message_id <> '' THEN ${alias}.message_id ELSE ${alias}.id END)`;
  }

  search(q: SearchQuery, limit = 300): MessageSummary[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const esc = (t: string) => `%${t.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    for (const t of q.text.trim().split(/\s+/).filter(Boolean).slice(0, 6)) {
      where.push(
        `(lower(m.subject) LIKE ? ESCAPE '\\' OR lower(m.from_name) LIKE ? ESCAPE '\\' OR lower(m.from_addr) LIKE ? ESCAPE '\\'
          OR lower(m.recipients) LIKE ? ESCAPE '\\' OR lower(m.preview) LIKE ? ESCAPE '\\' OR lower(COALESCE(b.text, '')) LIKE ? ESCAPE '\\')`
      );
      const like = esc(t);
      params.push(like, like, like, like, like, like);
    }
    if (q.from) {
      where.push(`(lower(m.from_name) LIKE ? ESCAPE '\\' OR lower(m.from_addr) LIKE ? ESCAPE '\\')`);
      params.push(esc(q.from), esc(q.from));
    }
    if (q.to) {
      where.push(`lower(m.recipients) LIKE ? ESCAPE '\\'`);
      params.push(esc(q.to));
    }
    if (q.subject) {
      where.push(`lower(m.subject) LIKE ? ESCAPE '\\'`);
      params.push(esc(q.subject));
    }
    if (q.hasAttachment) where.push('m.has_attachments = 1');
    if (q.unread) where.push('m.seen = 0');
    if (q.flagged) where.push('m.flagged = 1');
    const { after, before } = queryDates(q);
    if (after) {
      where.push('m.date >= ?');
      params.push(after.getTime());
    }
    if (before) {
      where.push('m.date < ?');
      params.push(before.getTime());
    }
    if (!where.length) return [];
    const rows = this.db
      .prepare(`SELECT m.* FROM messages m LEFT JOIN bodies b ON b.id = m.id WHERE ${where.join(' AND ')} ORDER BY m.date DESC LIMIT ?`)
      .all(...params, limit) as any[];
    return rows.map((r) => this.rowToSummary(r));
  }

  setListInfo(id: string, info: ListHeaders) {
    this.db.prepare('UPDATE messages SET list_unsub = ?, list_post = ?, bulk = ? WHERE id = ?').run(info.unsubscribe, info.oneClick ? 1 : 0, info.bulk ? 1 : 0, id);
  }

  // Avsändare i inkorg, arkiv och egna mappar, ett mejl räknas en gång även om Gmail har det i flera mappar.
  senderStats(own: string[], limit = 1000, accountId?: string): Omit<SenderStat, 'category' | 'rule' | 'unsubscribed'>[] {
    const ownSet = new Set(own.map((a) => a.toLowerCase()));
    const rows = this.db
      .prepare(
        `WITH d AS (
           SELECT lower(m.from_addr) AS addr, m.from_name, m.date, m.seen, m.subject, m.list_unsub, m.bulk, f.role,
             ROW_NUMBER() OVER (PARTITION BY m.account_id, CASE WHEN m.message_id <> '' THEN m.message_id ELSE m.id END
                                ORDER BY CASE f.role WHEN 'inbox' THEN 0 ELSE 1 END) AS rn
           FROM messages m JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
           WHERE f.role IN ('inbox', 'archive', 'other') AND m.from_addr <> '' AND (? = '' OR m.account_id = ?)
         )
         SELECT addr, COUNT(*) AS total, SUM(seen = 0) AS unread, SUM(role = 'inbox') AS in_inbox, MAX(date) AS last,
           MAX(list_unsub <> '') AS unsub, MAX(bulk) AS bulk,
           (SELECT from_name FROM d d2 WHERE d2.addr = d.addr AND d2.from_name <> '' ORDER BY d2.date DESC LIMIT 1) AS name,
           (SELECT subject FROM d d3 WHERE d3.addr = d.addr ORDER BY d3.date DESC LIMIT 1) AS subject
         FROM d WHERE rn = 1 GROUP BY addr ORDER BY total DESC, last DESC LIMIT ?`
      )
      .all(accountId ?? '', accountId ?? '', limit + ownSet.size) as any[];
    return rows
      .filter((r) => !ownSet.has(r.addr))
      .slice(0, limit)
      .map((r) => ({
        address: r.addr,
        name: r.name ?? '',
        total: r.total,
        unread: r.unread ?? 0,
        inInbox: r.in_inbox ?? 0,
        last: r.last,
        subject: r.subject ?? '',
        unsubscribe: !!r.unsub,
        bulk: !!r.bulk
      }));
  }

  // Senaste List-Unsubscribe från en avsändare, med kontot som tog emot mejlet.
  latestUnsubscribe(address: string, accountId?: string): { header: string; oneClick: boolean; accountId: string } | null {
    const r = this.db
      .prepare("SELECT list_unsub, list_post, account_id FROM messages WHERE from_addr = ? COLLATE NOCASE AND list_unsub <> '' AND (? = '' OR account_id = ?) ORDER BY date DESC LIMIT 1")
      .get(address, accountId ?? '', accountId ?? '') as any;
    return r ? { header: r.list_unsub, oneClick: !!r.list_post, accountId: r.account_id } : null;
  }

  // Mejl i cachen från en avsändare i mappar med vissa roller.
  messagesFrom(address: string, roles: FolderRole[]): { id: string; accountId: string; folder: string; uid: number; date: number }[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.account_id, m.folder, m.uid, m.date FROM messages m JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
         WHERE m.from_addr = ? COLLATE NOCASE AND f.role IN (${roles.map(() => '?').join(',')})`
      )
      .all(address, ...roles) as any[];
    return rows.map((r) => ({ id: r.id, accountId: r.account_id, folder: r.folder, uid: r.uid, date: r.date }));
  }

  addOutbox(item: OutboxItem) {
    this.db.prepare('INSERT OR REPLACE INTO outbox (id, due, kind, created, msg) VALUES (?, ?, ?, ?, ?)').run(item.id, item.due, item.kind, item.created, JSON.stringify(item.msg));
  }

  getOutbox(id: string): OutboxItem | null {
    const r = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as any;
    return r ? { id: r.id, due: r.due, kind: r.kind, created: r.created, msg: JSON.parse(r.msg) } : null;
  }

  listOutbox(): OutboxItem[] {
    return (this.db.prepare('SELECT * FROM outbox ORDER BY due').all() as any[]).map((r) => ({ id: r.id, due: r.due, kind: r.kind, created: r.created, msg: JSON.parse(r.msg) }));
  }

  removeOutbox(id: string) {
    this.db.prepare('DELETE FROM outbox WHERE id = ?').run(id);
  }

  unreadCount(accountId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM messages m JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
         WHERE m.account_id = ? AND f.role = 'inbox' AND m.seen = 0`
      )
      .get(accountId) as { c: number };
    return row.c;
  }

  getBody(id: string): MessageBody | null {
    const row = this.db.prepare('SELECT body FROM bodies WHERE id = ?').get(id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : null;
  }

  saveBody(body: MessageBody) {
    this.db
      .prepare('INSERT INTO bodies (id, body, text) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, text = excluded.text')
      .run(body.id, JSON.stringify(body), body.text.slice(0, 20000));
  }

  recentSentTexts(accountId: string, limit = 3): string[] {
    const rows = this.db
      .prepare(
        `SELECT b.text FROM messages m JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
         JOIN bodies b ON b.id = m.id WHERE m.account_id = ? AND f.role = 'sent' ORDER BY m.date DESC LIMIT ?`
      )
      .all(accountId, limit) as { text: string }[];
    return rows.map((r) => r.text);
  }

  // Aktivitetsloggen för AI-verktygen. Bara de senaste 500 anropen sparas.
  addAgentLog(e: { tool: string; summary: string; ok: boolean; error?: string; client?: string; at?: number }) {
    this.db
      .prepare('INSERT INTO agent_log (at, tool, summary, ok, error, client) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.at ?? Date.now(), e.tool, e.summary, e.ok ? 1 : 0, e.error ?? '', e.client ?? '');
    this.db.prepare('DELETE FROM agent_log WHERE id <= (SELECT id FROM agent_log ORDER BY id DESC LIMIT 1 OFFSET 500)').run();
  }

  listAgentLog(limit = 50): AgentLogEntry[] {
    const rows = this.db.prepare('SELECT * FROM agent_log ORDER BY id DESC LIMIT ?').all(limit) as any[];
    return rows.map((r) => ({ id: r.id, at: r.at, tool: r.tool, summary: r.summary, ok: !!r.ok, error: r.error, client: r.client }));
  }

  clearAgentLog() {
    this.db.prepare('DELETE FROM agent_log').run();
  }

  // Kalendercachen: kalendrar och händelser för de närmaste veckorna.
  setCalendars(accountId: string, cals: CalendarInfo[]) {
    this.db.prepare('DELETE FROM cal_calendars WHERE account_id = ?').run(accountId);
    const ins = this.db.prepare('INSERT INTO cal_calendars (account_id, id, position, data) VALUES (?, ?, ?, ?)');
    cals.forEach((c, i) => ins.run(accountId, c.id, i, JSON.stringify(c)));
    const ids = new Set(cals.map((c) => c.id));
    for (const r of this.db.prepare('SELECT DISTINCT calendar_id AS c FROM cal_events WHERE account_id = ?').all(accountId) as { c: string }[]) {
      if (!ids.has(r.c)) this.db.prepare('DELETE FROM cal_events WHERE account_id = ? AND calendar_id = ?').run(accountId, r.c);
    }
  }

  listCalendars(): CalendarInfo[] {
    return (this.db.prepare('SELECT data FROM cal_calendars ORDER BY account_id, position').all() as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  replaceCalendarEvents(accountId: string, calendarId: string, from: number, to: number, events: CalendarEvent[]) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM cal_events WHERE account_id = ? AND calendar_id = ? AND end > ? AND start < ?').run(accountId, calendarId, from, to);
      for (const e of events) this.putEvent(e);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  putEvent(e: CalendarEvent) {
    this.db
      .prepare('INSERT INTO cal_events (id, account_id, calendar_id, start, end, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, calendar_id = excluded.calendar_id, start = excluded.start, end = excluded.end, data = excluded.data')
      .run(e.id, e.accountId, e.calendarId, e.start, e.end, JSON.stringify(e));
  }

  removeEvent(id: string) {
    this.db.prepare('DELETE FROM cal_events WHERE id = ?').run(id);
  }

  getEvent(id: string): CalendarEvent | null {
    const r = this.db.prepare('SELECT data FROM cal_events WHERE id = ?').get(id) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : null;
  }

  cachedEvents(from: number, to: number): CalendarEvent[] {
    return (this.db.prepare('SELECT data FROM cal_events WHERE end > ? AND start < ? OR (start = end AND start >= ? AND start < ?) ORDER BY start').all(from, to, from, to) as { data: string }[]).map((r) =>
      JSON.parse(r.data)
    );
  }

  clearCalendarAccount(accountId: string) {
    this.db.prepare('DELETE FROM cal_events WHERE account_id = ?').run(accountId);
    this.db.prepare('DELETE FROM cal_calendars WHERE account_id = ?').run(accountId);
  }

  // Svar på kalenderinbjudningar, per konto och händelse.
  setInviteAnswer(accountId: string, uid: string, response: string, sequence: number) {
    this.db
      .prepare('INSERT INTO invite_answers (account_id, uid, response, sequence, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, uid) DO UPDATE SET response = excluded.response, sequence = excluded.sequence, at = excluded.at')
      .run(accountId, uid, response, sequence, Date.now());
  }

  inviteAnswer(accountId: string, uid: string): { response: string; sequence: number; at: number } | null {
    const r = this.db.prepare('SELECT response, sequence, at FROM invite_answers WHERE account_id = ? AND uid = ?').get(accountId, uid) as any;
    return r ? { response: r.response, sequence: r.sequence, at: r.at } : null;
  }

  // Betrodda avsändare: bilder från internet visas direkt. Adressen sparas med små bokstäver.
  trustedSenders(): TrustedSender[] {
    return this.db.prepare('SELECT address, added FROM trusted_senders ORDER BY address').all() as unknown as TrustedSender[];
  }

  isTrustedSender(address: string): boolean {
    const addr = normalizeAddress(address);
    return !!addr && !!this.db.prepare('SELECT 1 FROM trusted_senders WHERE address = ?').get(addr);
  }

  setTrustedSender(address: string, trusted: boolean, at = Date.now()): boolean {
    const addr = normalizeAddress(address);
    if (!addr) return false;
    if (trusted) this.db.prepare('INSERT INTO trusted_senders (address, added) VALUES (?, ?) ON CONFLICT(address) DO NOTHING').run(addr, at);
    else this.db.prepare('DELETE FROM trusted_senders WHERE address = ?').run(addr);
    return true;
  }

  getSettings(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const s: any = { ...DEFAULT_SETTINGS };
    for (const r of rows) if (r.key in s) s[r.key] = JSON.parse(r.value);
    return s;
  }

  saveSettings(patch: Partial<Settings>) {
    const stmt = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS) stmt.run(k, JSON.stringify(v));
  }
}
