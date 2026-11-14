import { ImapFlow, type ListResponse, type FetchMessageObject, type FetchQueryObject } from 'imapflow';
import type { AccountConfig, AccountState, Address, FolderRole, SearchQuery } from '../shared/types';
import { parseListHeaders } from '../shared/cleanup';
import { gmailRaw, imapCriteria } from '../shared/search';
import { imapOptions } from '../shared/accounts';
import { APP_FILE_NAME, APP_VERSION } from '../shared/brand';
import { Store } from './db';
import { parseMessage } from './parse';
import { t } from '../shared/i18n';

export interface SessionHooks {
  onStatus(id: string, state: AccountState, error?: string): void;
  onChanged(accountId: string): void;
  onNewMail(accountId: string, messageIds: string[]): void;
  // Nya mejl i inkorgen (även lästa), för regler i Städa.
  onArrived?(accountId: string, messageIds: string[]): void;
  log?(msg: string): void;
}

const ROLE_BY_SPECIAL: Record<string, FolderRole> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Archive': 'archive',
  '\\All': 'archive',
  '\\Junk': 'junk'
};

export const ROLE_NAMES: Record<FolderRole, string> = {
  inbox: 'Inkorg',
  sent: 'Skickat',
  drafts: 'Utkast',
  trash: 'Papperskorg',
  archive: 'Arkiv',
  junk: 'Skräppost',
  other: 'Övrigt'
};

const CREATE_NAMES: Partial<Record<FolderRole, string>> = {
  sent: 'Sent',
  drafts: 'Drafts',
  trash: 'Trash',
  archive: 'Archive'
};

export const SYNC_ROLES: FolderRole[] = ['inbox', 'sent', 'drafts', 'trash', 'archive'];

export function friendlyError(err: any, cfg: AccountConfig): string {
  const code = err?.code ?? err?.cause?.code;
  if (isAuthError(err))
    return cfg.auth === 'oauth'
      ? t('Inloggningen misslyckades. Logga in igen med knappen under Konton.')
      : cfg.provider === 'gmail'
      ? t('Inloggningen misslyckades. Gmail kräver ett app-lösenord.')
      : t('Inloggningen misslyckades. Kontrollera användarnamn och lösenord.');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return t('Hittar inte servern {host}. Är du ansluten till internet?', { host: cfg.imap.host });
  if (code === 'ECONNREFUSED') return t('Servern {host}:{port} vägrade anslutningen.', { host: cfg.imap.host, port: cfg.imap.port });
  if (code === 'ETIMEDOUT' || code === 'CONNECT_TIMEOUT' || code === 'GREETING_TIMEOUT') return t('Ingen kontakt med {host}, tidsgränsen nåddes.', { host: cfg.imap.host });
  if (code === 'ECONNRESET' || code === 'NoConnection') return t('Anslutningen bröts.');
  if (/certificate|self.signed|CERT_/i.test(err?.message ?? '')) return t('Serverns certifikat kunde inte verifieras.');
  return err?.responseText || err?.message || t('Okänt fel.');
}

function roleFor(box: ListResponse): FolderRole {
  if (box.path.toUpperCase() === 'INBOX') return 'inbox';
  if (box.specialUse && ROLE_BY_SPECIAL[box.specialUse]) return ROLE_BY_SPECIAL[box.specialUse];
  return 'other';
}

// Hämtar föräldrasökvägen ur en mappsökväg med hjälp av klientens IMAP-delimiter.
function parentPathOf(path: string, delimiter: string): string {
  const d = delimiter || '/';
  const i = path.lastIndexOf(d);
  return i > 0 ? path.slice(0, i) : '';
}

// Message-ID:n ur rubriken References, i ordning från trådens början.
export function parseReferences(headers?: Buffer): string[] {
  if (!headers) return [];
  const text = headers.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  const m = text.match(/^references:\s*(.*)$/im);
  return m ? (m[1].match(/<[^<>\s]+>/g) ?? []) : [];
}

function mapAddr(list: { name?: string; address?: string }[] | undefined): Address[] {
  return (list ?? []).filter((a) => a.address).map((a) => ({ name: (a.name ?? '').trim(), address: a.address!.toLowerCase() }));
}

function hasAttachmentParts(node: any): boolean {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  if (node.disposition === 'inline' && node.dispositionParameters?.filename && !String(node.type).startsWith('image/')) return true;
  return Array.isArray(node.childNodes) && node.childNodes.some(hasAttachmentParts);
}

// Lösenord som sträng, eller en funktion som ger en färsk OAuth-åtkomsttoken (XOAUTH2).
export type Credential = string | (() => Promise<string>);

export async function imapAuth(cfg: AccountConfig, cred: Credential): Promise<{ user: string; pass: string } | { user: string; accessToken: string }> {
  return typeof cred === 'string' ? { user: cfg.username, pass: cred } : { user: cfg.username, accessToken: await cred() };
}

export function createClient(
  cfg: AccountConfig,
  auth: { user: string; pass: string } | { user: string; accessToken: string },
  opts: { autoIdle: boolean; timeoutMs?: number }
) {
  return new ImapFlow({
    ...imapOptions(cfg),
    auth,
    logger: false,
    disableAutoIdle: !opts.autoIdle,
    autoIdleDelay: 2000,
    maxIdleTime: 4 * 60 * 1000,
    connectionTimeout: opts.timeoutMs ?? 20000,
    greetingTimeout: opts.timeoutMs ?? 15000,
    clientInfo: { name: APP_FILE_NAME, version: APP_VERSION }
  });
}

export class AccountSession {
  cfg: AccountConfig;
  private credential: Credential;
  private store: Store;
  private hooks: SessionHooks;
  private main: ImapFlow | null = null;
  private ops: ImapFlow | null = null;
  private opsConnecting: Promise<ImapFlow> | null = null;
  private bg: ImapFlow | null = null;
  private bgConnecting: Promise<ImapFlow> | null = null;
  private stopped = false;
  private retry = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private inboxTimer: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private paths: Partial<Record<FolderRole, string>> = {};
  private initialDone = new Set<string>();
  state: AccountState = 'connecting';
  error?: string;
  syncLimit: number;

  constructor(cfg: AccountConfig, credential: Credential, store: Store, hooks: SessionHooks, syncLimit = 200) {
    this.cfg = cfg;
    this.credential = credential;
    this.store = store;
    this.hooks = hooks;
    this.syncLimit = syncLimit;
  }

  private setState(state: AccountState, error?: string) {
    this.state = state;
    this.error = error;
    this.hooks.onStatus(this.cfg.id, state, error);
  }

  private log(msg: string) {
    this.hooks.log?.(`[${this.cfg.id}] ${msg}`);
  }

  start() {
    this.stopped = false;
    void this.connect();
  }

  async stop() {
    this.stopped = true;
    for (const t of [this.retryTimer, this.pollTimer, this.inboxTimer]) if (t) clearTimeout(t);
    const clients = [this.main, this.ops, this.bg];
    this.main = null;
    this.ops = null;
    this.bg = null;
    await Promise.all(clients.map((c) => c?.logout().catch(() => c?.close())));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async connect() {
    if (this.stopped) return;
    this.setState('connecting');
    let auth: Awaited<ReturnType<typeof imapAuth>>;
    try {
      auth = await imapAuth(this.cfg, this.credential);
    } catch (err: any) {
      // Token gick inte att förnya. Försök igen senare, men visa felet direkt.
      const msg = err?.message ?? t('Inloggningen misslyckades.');
      this.setState('error', msg);
      this.scheduleReconnect(msg, err?.code === 'network' ? undefined : 10 * 60 * 1000);
      return;
    }
    const client = createClient(this.cfg, auth, { autoIdle: true });
    client.on('error', (err) => this.log(`fel: ${err?.message}`));
    client.on('close', () => {
      if (this.main !== client) return;
      this.main = null;
      if (!this.stopped) this.scheduleReconnect(t('Anslutningen stängdes.'));
    });
    client.on('exists', () => this.scheduleInboxSync());
    client.on('expunge', () => this.scheduleInboxSync());
    client.on('flags', () => this.scheduleInboxSync());
    try {
      await client.connect();
      if (this.stopped) {
        await client.logout().catch(() => undefined);
        return;
      }
      this.main = client;
      this.retry = 0;
      this.setState('syncing');
      await this.enqueue(() => this.discoverFolders());
      await this.enqueue(() => this.syncRoles(SYNC_ROLES));
      if (this.main === client) this.setState('online');
      this.schedulePoll();
    } catch (err: any) {
      this.log(`anslutning misslyckades: ${err?.message}`);
      client.close();
      if (this.main === client) this.main = null;
      const friendly = friendlyError(err, this.cfg);
      if (err?.authenticationFailed) {
        this.setState('error', friendly);
        this.scheduleReconnect(friendly, 10 * 60 * 1000);
      } else this.scheduleReconnect(friendly);
    }
  }

  private scheduleReconnect(error: string, delay?: number) {
    if (this.stopped) return;
    this.setState('error', error);
    const wait = delay ?? Math.min(5 * 60 * 1000, 5000 * 2 ** this.retry++);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), wait);
  }

  reconnectNow() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retry = 0;
    if (!this.main) void this.connect();
    else void this.syncNow();
  }

  private schedulePoll() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      await this.syncNow().catch(() => undefined);
      if (!this.stopped) this.schedulePoll();
    }, 5 * 60 * 1000);
  }

  // Snabb kontroll av inkorgen, till exempel när fönstret får fokus.
  checkInbox() {
    if (this.main?.usable) this.scheduleInboxSync();
  }

  private scheduleInboxSync() {
    if (this.inboxTimer) clearTimeout(this.inboxTimer);
    this.inboxTimer = setTimeout(() => {
      void this.enqueue(() => this.syncRoles(['inbox'])).catch((e) => this.log(`inkorg: ${e?.message}`));
    }, 400);
  }

  async syncNow() {
    if (!this.main) return;
    this.setState('syncing');
    try {
      await this.enqueue(() => this.discoverFolders());
      await this.enqueue(() => this.syncRoles(SYNC_ROLES));
      this.setState('online');
    } catch (err: any) {
      this.setState('error', friendlyError(err, this.cfg));
    }
  }

  async syncFolderNow(path: string) {
    if (!this.main) return;
    await this.enqueue(async () => {
      const client = this.main;
      if (!client) return;
      await this.syncFolder(client, path);
      await this.returnToInbox(client);
    });
  }

  private async discoverFolders() {
    const client = this.main;
    if (!client) return;
    let list = await client.list();
    const nsDelimiter = client.namespace?.delimiter ?? undefined;
    const found: Partial<Record<FolderRole, string>> = {};
    for (const box of list) {
      if (box.flags?.has('\\Noselect')) continue;
      const role = roleFor(box);
      if (role !== 'other' && !found[role]) found[role] = box.path;
    }
    let created = false;
    const ns = (client as any).namespace as { prefix?: string; delimiter?: string } | undefined;
    for (const role of ['sent', 'drafts', 'trash', 'archive'] as FolderRole[]) {
      if (found[role]) continue;
      const name = CREATE_NAMES[role]!;
      const byName = list.find((b) => b.name.toLowerCase() === name.toLowerCase() || b.path.toLowerCase() === `${ns?.prefix ?? ''}${name}`.toLowerCase());
      if (byName) {
        found[role] = byName.path;
        continue;
      }
      try {
        const res = await client.mailboxCreate(`${ns?.prefix ?? ''}${name}`);
        found[role] = res.path;
        created = true;
      } catch (err: any) {
        this.log(`kunde inte skapa ${name}: ${err?.message}`);
      }
    }
    if (created) list = await client.list();
    this.paths = found;
    // Roll per sökväg, så att mappar som matchats via namn får sin roll och inte blir "other".
    const roleByPath = new Map<string, FolderRole>();
    for (const role of Object.keys(found) as FolderRole[]) {
      const p = found[role];
      if (p) roleByPath.set(p, role);
    }
    // Lagra alla mappar (utom \Noselect) med roll och förälder, så att trädet kan ritas.
    const keep: string[] = [];
    for (const box of list) {
      if (box.flags?.has('\\Noselect')) continue;
      const role = roleByPath.get(box.path) ?? roleFor(box);
      const delimiter = box.delimiter || nsDelimiter || '/';
      keep.push(box.path);
      this.store.upsertFolder(this.cfg.id, box.path, box.name, role, parentPathOf(box.path, delimiter));
    }
    // Specialmappar som skapades ovan men saknades i listan, lägg till ändå.
    for (const role of SYNC_ROLES) {
      const path = found[role];
      if (!path || keep.includes(path)) continue;
      keep.push(path);
      this.store.upsertFolder(this.cfg.id, path, ROLE_NAMES[role], role, parentPathOf(path, nsDelimiter || '/'));
    }
    this.store.removeFoldersExcept(this.cfg.id, keep);
    // Olästa antal per mapp via STATUS, så att även mappar som inte synkas visar korrekt räknare.
    for (const path of keep) await this.updateUnreadStatus(client, path);
    this.hooks.onChanged(this.cfg.id);
  }

  private async updateUnreadStatus(client: ImapFlow, path: string) {
    try {
      const st = await client.status(path, { unseen: true });
      if (st && typeof st.unseen === 'number') this.store.setFolderUnread(this.cfg.id, path, st.unseen);
    } catch (err: any) {
      this.log(`status för ${path}: ${err?.message}`);
    }
  }

  private async syncRoles(roles: FolderRole[]) {
    const client = this.main;
    if (!client) return;
    for (const role of roles) {
      const path = this.paths[role];
      if (path) await this.syncFolder(client, path);
    }
    await this.returnToInbox(client);
  }

  private async returnToInbox(client: ImapFlow) {
    const inbox = this.paths.inbox ?? 'INBOX';
    if (client.mailbox && (client.mailbox as any).path === inbox) return;
    try {
      await client.mailboxOpen(inbox);
    } catch (err: any) {
      this.log(`kunde inte öppna inkorgen: ${err?.message}`);
    }
  }

  private static FETCH_QUERY: FetchQueryObject = {
    uid: true,
    flags: true,
    envelope: true,
    internalDate: true,
    bodyStructure: true,
    labels: true,
    threadId: true,
    headers: ['references', 'list-unsubscribe', 'list-unsubscribe-post', 'list-id', 'precedence']
  };

  // Sparar ett hämtat kuvert i cachen med flaggor, etiketter och tråd. Returnerar id.
  private storeFetched(path: string, uidValidity: number, msg: FetchMessageObject): string {
    const accountId = this.cfg.id;
    const flags = msg.flags ?? new Set<string>();
    const id = Store.messageId(accountId, path, uidValidity, msg.uid);
    const env = msg.envelope ?? ({} as any);
    const date = (env.date ? new Date(env.date) : msg.internalDate ? new Date(msg.internalDate) : new Date()).getTime();
    this.store.upsertMessage({
      id,
      accountId,
      folder: path,
      uid: msg.uid,
      uidValidity,
      subject: env.subject ?? '',
      from: mapAddr(env.from)[0] ?? mapAddr(env.sender)[0] ?? { name: '', address: '' },
      to: mapAddr(env.to),
      cc: mapAddr(env.cc),
      date: Number.isFinite(date) ? date : Date.now(),
      preview: '',
      seen: flags.has('\\Seen'),
      flagged: flags.has('\\Flagged'),
      answered: flags.has('\\Answered'),
      hasAttachments: hasAttachmentParts(msg.bodyStructure),
      messageId: env.messageId ?? ''
    });
    if (msg.labels) this.store.setMessageLabels(id, [...msg.labels].filter((l) => !l.startsWith('\\')));
    this.store.assignThread(id, accountId, env.messageId ?? '', env.inReplyTo ?? null, parseReferences(msg.headers), msg.threadId);
    if (msg.headers) {
      const info = parseListHeaders(msg.headers.toString('utf8'));
      if (info.unsubscribe || info.bulk) this.store.setListInfo(id, info);
    }
    return id;
  }

  // Hämtar början av varje nytt mejl för förhandsvisningen i listan.
  private async fetchPreviews(client: ImapFlow, path: string, uidValidity: number, uids: number[]) {
    const sorted = [...uids].sort((a, b) => b - a);
    for (let i = 0; i < sorted.length; i += 50) {
      const chunk = sorted.slice(i, i + 50);
      const partial: { uid: number; source: Buffer }[] = [];
      for await (const m of client.fetch(chunk.join(','), { uid: true, source: { start: 0, maxLength: 12288 } }, { uid: true })) {
        if (m.source) partial.push({ uid: m.uid, source: m.source });
      }
      for (const p of partial) {
        try {
          const parsed = await parseMessage(p.source);
          const id = Store.messageId(this.cfg.id, path, uidValidity, p.uid);
          const existing = this.store.getMessage(id);
          this.store.setPreview(id, parsed.preview, existing?.hasAttachments ?? false);
        } catch {
          /* förhandsvisning är frivillig */
        }
      }
      this.hooks.onChanged(this.cfg.id);
    }
  }

  private async syncFolder(client: ImapFlow, path: string) {
    const accountId = this.cfg.id;
    const role = this.store.folderRole(accountId, path) ?? 'other';
    const lock = await client.getMailboxLock(path);
    const newIds: string[] = [];
    const arrived: string[] = [];
    try {
      const mb = client.mailbox as any;
      const uidValidity = Number(mb.uidValidity ?? 0);
      if (this.store.getUidValidity(accountId, path) !== uidValidity) {
        this.store.clearFolder(accountId, path);
        this.store.setUidValidity(accountId, path, uidValidity);
      }
      const known = this.store.knownUids(accountId, path);
      const firstSync = !this.initialDone.has(path) && known.size === 0;
      const maxKnown = known.size ? Math.max(...known.keys()) : 0;
      const exists: number = mb.exists ?? 0;
      const present = new Set<number>();
      const fresh: number[] = [];
      let windowStart = Infinity;
      if (exists > 0) {
        const start = Math.max(1, exists - this.syncLimit + 1);
        // Bara flaggor för hela fönstret, kuvert och rubriker hämtas enbart för mejl som saknas i cachen.
        const missing: number[] = [];
        for await (const msg of client.fetch(`${start}:*`, { uid: true, flags: true, labels: true })) {
          present.add(msg.uid);
          windowStart = Math.min(windowStart, msg.uid);
          const prev = known.get(msg.uid);
          if (!prev) {
            missing.push(msg.uid);
            continue;
          }
          const flags = msg.flags ?? new Set<string>();
          const seen = flags.has('\\Seen');
          const flagged = flags.has('\\Flagged');
          const answered = flags.has('\\Answered');
          const id = Store.messageId(accountId, path, uidValidity, msg.uid);
          if (prev.seen !== seen || prev.flagged !== flagged || prev.answered !== answered) this.store.setFlags(id, { seen, flagged, answered });
          if (msg.labels) {
            const nu = [...msg.labels].filter((l) => !l.startsWith('\\'));
            const gammalt = this.store.getMessage(id)?.labels ?? [];
            if (gammalt.join('\u0000') !== nu.join('\u0000')) this.store.setMessageLabels(id, nu);
          }
        }
        missing.sort((a, b) => b - a);
        for (let i = 0; i < missing.length; i += 200) {
          const chunk = missing.slice(i, i + 200);
          for await (const msg of client.fetch(chunk.join(','), AccountSession.FETCH_QUERY, { uid: true })) {
            const id = this.storeFetched(path, uidValidity, msg);
            arrived.push(id);
            fresh.push(msg.uid);
            const seen = (msg.flags ?? new Set<string>()).has('\\Seen');
            if (!firstSync && role === 'inbox' && !seen && msg.uid > maxKnown) newIds.push(id);
          }
        }
      }
      // Mejl i fönstret som inte längre finns är borta. Äldre mejl i cachen (hämtade vid scroll eller
      // sökning) kontrolleras med en UID-sökning så att de inte raderas bara för att de ligger utanför fönstret.
      const older = [...known.keys()].filter((uid) => uid < windowStart);
      let olderAlive = new Set<number>();
      if (older.length && exists > 0) {
        const res = await client.search({ uid: `1:${Number.isFinite(windowStart) ? windowStart - 1 : '*'}` }, { uid: true });
        olderAlive = new Set(Array.isArray(res) ? res : []);
      }
      const gone = [...known.keys()]
        .filter((uid) => (uid >= windowStart ? !present.has(uid) : exists === 0 || !olderAlive.has(uid)))
        .map((uid) => Store.messageId(accountId, path, uidValidity, uid));
      if (gone.length) this.store.deleteMessages(gone);
      if (fresh.length) {
        // Visa de nya mejlen i listan direkt, förhandsvisningen fylls i strax efter.
        this.hooks.onChanged(accountId);
        await this.fetchPreviews(client, path, uidValidity, fresh);
      }
      this.initialDone.add(path);
    } finally {
      lock.release();
    }
    await this.updateUnreadStatus(client, path);
    this.hooks.onChanged(accountId);
    if (newIds.length) this.hooks.onNewMail(accountId, newIds);
    if (role === 'inbox' && arrived.length) this.hooks.onArrived?.(accountId, arrived);
  }

  // Hämtar nästa portion äldre mejl i en mapp, för oändlig scroll. Returnerar antal nya i cachen.
  async fetchOlder(path: string, count = 200): Promise<number> {
    return this.withFolder(path, async (c) => {
      const mb = c.mailbox as any;
      const uidValidity = Number(mb.uidValidity ?? 0);
      if (this.store.getUidValidity(this.cfg.id, path) !== uidValidity) return 0;
      // Luckor kan finnas (sökträffar ligger redan i cachen), så ta de högsta UID som saknas.
      const known = this.store.knownUids(this.cfg.id, path);
      const res = await c.search({ all: true }, { uid: true });
      const uids = (Array.isArray(res) ? res : [])
        .filter((u) => !known.has(u))
        .sort((a, b) => a - b)
        .slice(-count);
      if (!uids.length) return 0;
      const added: number[] = [];
      for await (const msg of c.fetch(uids.join(','), AccountSession.FETCH_QUERY, { uid: true })) {
        this.storeFetched(path, uidValidity, msg);
        added.push(msg.uid);
      }
      await this.fetchPreviews(c, path, uidValidity, added);
      return added.length;
    });
  }

  // Hämtar kuvert och listrubriker för de senaste mejlen i en mapp, utan förhandsvisning. Används av Städa.
  async scanFolder(path: string, max: number, onProgress?: (done: number, total: number) => void): Promise<number> {
    return this.withBgFolder(path, async (c) => {
      const mb = c.mailbox as any;
      const uidValidity = Number(mb.uidValidity ?? 0);
      const exists: number = mb.exists ?? 0;
      if (!exists) return 0;
      if (this.store.getUidValidity(this.cfg.id, path) !== uidValidity) {
        this.store.clearFolder(this.cfg.id, path);
        this.store.setUidValidity(this.cfg.id, path, uidValidity);
      }
      const start = Math.max(1, exists - max + 1);
      const total = exists - start + 1;
      let done = 0;
      for (let hi = exists; hi >= start; hi -= 500) {
        const lo = Math.max(start, hi - 499);
        for await (const msg of c.fetch(`${lo}:${hi}`, AccountSession.FETCH_QUERY)) {
          this.storeFetched(path, uidValidity, msg);
          done++;
        }
        onProgress?.(done, total);
      }
      return done;
    });
  }

  // Flyttar alla mejl från en avsändare i en mapp, även de som inte finns i cachen. Returnerar antal.
  async moveFrom(path: string, address: string, dest: string, beforeMs?: number): Promise<number> {
    if (path === dest) return 0;
    return this.withFolder(path, async (c) => {
      if (!(c.mailbox as any).exists) return 0;
      const criteria: Record<string, unknown> = { from: address };
      if (beforeMs) criteria.before = new Date(beforeMs);
      const res = await c.search(criteria as any, { uid: true });
      const found = Array.isArray(res) ? res : [];
      if (!found.length) return 0;
      // FROM matchar delar av adressen, så kontrollera att avsändaren stämmer exakt.
      const exact: number[] = [];
      const want = address.toLowerCase();
      for await (const m of c.fetch(found.join(','), { uid: true, envelope: true }, { uid: true })) {
        if (mapAddr(m.envelope?.from).some((a) => a.address === want)) exact.push(m.uid);
      }
      if (!exact.length) return 0;
      for (let i = 0; i < exact.length; i += 500) await c.messageMove(exact.slice(i, i + 500).join(','), dest, { uid: true });
      return exact.length;
    });
  }

  // Mappar att söka i på servern. Gmail har allt i Alla mejl, andra servrar söks mapp för mapp.
  private searchFolders(gmail: boolean): string[] {
    const folders = this.store.listFolders().filter((f) => f.accountId === this.cfg.id);
    if (gmail) {
      const all = folders.find((f) => f.role === 'archive' && /all/i.test(f.path)) ?? folders.find((f) => f.role === 'archive');
      const extra = folders.filter((f) => f.role === 'trash' || f.role === 'junk');
      return [...(all ? [all.path] : folders.filter((f) => f.role === 'inbox').map((f) => f.path)), ...extra.map((f) => f.path)].slice(0, 3);
    }
    const order: FolderRole[] = ['inbox', 'sent', 'archive', 'drafts', 'other', 'trash', 'junk'];
    return folders.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role)).map((f) => f.path).slice(0, 40);
  }

  // Söker på servern och lägger träffarna i cachen. Returnerar id för träffarna, nyast först.
  async searchServer(q: SearchQuery, perFolder = 60): Promise<string[]> {
    const client = await this.opsClient();
    const gmail = client.capabilities?.has('X-GM-EXT-1') ?? false;
    const criteria = gmail ? { gmraw: gmailRaw(q) } : imapCriteria(q);
    const ids: string[] = [];
    for (const path of this.searchFolders(gmail)) {
      try {
        await this.withFolder(path, async (c) => {
          const mb = c.mailbox as any;
          const uidValidity = Number(mb.uidValidity ?? 0);
          if (!mb.exists) return;
          const res = await c.search(criteria as any, { uid: true });
          const uids = (Array.isArray(res) ? res : []).sort((a, b) => a - b).slice(-perFolder);
          if (!uids.length) return;
          if (this.store.getUidValidity(this.cfg.id, path) !== uidValidity) {
            this.store.clearFolder(this.cfg.id, path);
            this.store.setUidValidity(this.cfg.id, path, uidValidity);
          }
          const missing: number[] = [];
          for (const uid of uids) {
            const id = Store.messageId(this.cfg.id, path, uidValidity, uid);
            if (!this.store.getMessage(id)) missing.push(uid);
            ids.push(id);
          }
          if (missing.length) {
            for await (const msg of c.fetch(missing.join(','), AccountSession.FETCH_QUERY, { uid: true })) this.storeFetched(path, uidValidity, msg);
            await this.fetchPreviews(c, path, uidValidity, missing);
          }
        });
      } catch (err: any) {
        this.log(`sök i ${path}: ${err?.message}`);
      }
    }
    let out = ids.map((id) => this.store.getMessage(id)).filter((m): m is NonNullable<typeof m> => !!m);
    if (q.hasAttachment && !gmail) out = out.filter((m) => m.hasAttachments);
    return out.sort((a, b) => b.date - a.date).map((m) => m.id);
  }

  // Separat anslutning för det användaren gör, så att synk inte blockerar.
  private async opsClient(): Promise<ImapFlow> {
    if (this.ops?.usable) return this.ops;
    if (this.opsConnecting) return this.opsConnecting;
    this.opsConnecting = (async () => {
      const c = createClient(this.cfg, await imapAuth(this.cfg, this.credential), { autoIdle: false });
      c.on('error', (err) => this.log(`ops-fel: ${err?.message}`));
      c.on('close', () => {
        if (this.ops === c) this.ops = null;
      });
      await c.connect();
      this.ops = c;
      return c;
    })();
    try {
      return await this.opsConnecting;
    } finally {
      this.opsConnecting = null;
    }
  }

  // Egen anslutning för förhämtning i bakgrunden, så att den aldrig står i vägen för det användaren gör.
  private async bgClient(): Promise<ImapFlow> {
    if (this.bg?.usable) return this.bg;
    if (this.bgConnecting) return this.bgConnecting;
    this.bgConnecting = (async () => {
      const c = createClient(this.cfg, await imapAuth(this.cfg, this.credential), { autoIdle: false });
      c.on('error', (err) => this.log(`bakgrund-fel: ${err?.message}`));
      c.on('close', () => {
        if (this.bg === c) this.bg = null;
      });
      await c.connect();
      this.bg = c;
      return c;
    })();
    try {
      return await this.bgConnecting;
    } finally {
      this.bgConnecting = null;
    }
  }

  private async withBgFolder<T>(path: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const client = await this.bgClient();
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  }

  async fetchSourceBackground(path: string, uid: number): Promise<Buffer> {
    const client = await this.bgClient();
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) throw new Error(t('Meddelandet finns inte längre på servern.'));
      return msg.source;
    } finally {
      lock.release();
    }
  }

  async withFolder<T>(path: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const client = await this.opsClient();
    const lock = await client.getMailboxLock(path);
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  }

  async fetchSource(path: string, uid: number): Promise<Buffer> {
    return this.withFolder(path, async (c) => {
      const msg = await c.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) throw new Error(t('Meddelandet finns inte längre på servern.'));
      return msg.source;
    });
  }

  async setFlag(path: string, uid: number, flag: string, value: boolean) {
    await this.withFolder(path, async (c) => {
      if (value) await c.messageFlagsAdd(String(uid), [flag], { uid: true });
      else await c.messageFlagsRemove(String(uid), [flag], { uid: true });
    });
  }

  rolePath(role: FolderRole): string | null {
    return this.paths[role] ?? this.store.folderByRole(this.cfg.id, role);
  }

  async move(path: string, uid: number, role: FolderRole): Promise<string> {
    const dest = this.rolePath(role);
    if (!dest) throw new Error(t('Kontot saknar mappen {folder}.', { folder: t(ROLE_NAMES[role]) }));
    return this.moveToFolder(path, uid, dest);
  }

  // Flyttar ett meddelande till en godtycklig mapp (för Flytta till och dra och släpp).
  async moveToFolder(path: string, uid: number, dest: string): Promise<string> {
    if (!dest) throw new Error(t('Ingen målmapp angiven.'));
    if (dest === path) return dest;
    const ok = await this.withFolder(path, async (c) => {
      return await c.messageMove(String(uid), dest, { uid: true });
    });
    if (ok === false) throw new Error(t('Flyttningen misslyckades. Målet finns kanske inte längre.'));
    return dest;
  }

  // Flyttar flera meddelanden på en gång. Returnerar de nya UID:erna i målmappen när servern uppger dem.
  async moveUids(path: string, uids: number[], dest: string): Promise<Map<number, number>> {
    if (!uids.length || dest === path) return new Map();
    return this.withFolder(path, async (c) => {
      const res: any = await c.messageMove(uids.join(','), dest, { uid: true });
      if (res === false) throw new Error(t('Flyttningen misslyckades. Målet finns kanske inte längre.'));
      return res?.uidMap instanceof Map ? (res.uidMap as Map<number, number>) : new Map();
    });
  }

  async createFolder(name: string, parent?: string): Promise<string> {
    const client = await this.opsClient();
    const ns = (client as any).namespace as { prefix?: string; delimiter?: string } | undefined;
    const path = parent ? `${parent}${ns?.delimiter || '/'}${name}` : `${ns?.prefix ?? ''}${name}`;
    const res = await client.mailboxCreate(path);
    await this.enqueue(() => this.discoverFolders());
    return res.path;
  }

  destFor(role: FolderRole): string {
    const dest = this.rolePath(role);
    if (!dest) throw new Error(t('Kontot saknar mappen {folder}.', { folder: t(ROLE_NAMES[role]) }));
    return dest;
  }

  async deletePermanently(path: string, uid: number) {
    await this.withFolder(path, async (c) => {
      await c.messageDelete(String(uid), { uid: true });
    });
  }

  async append(role: FolderRole, raw: Buffer, flags: string[]): Promise<{ path: string; uid?: number } | null> {
    const dest = this.rolePath(role);
    if (!dest) return null;
    const client = await this.opsClient();
    const res = await client.append(dest, raw, flags);
    return { path: dest, uid: res && typeof res.uid === 'number' ? res.uid : undefined };
  }

  // UID för meddelanden med en viss rubrik, till exempel alla versioner av ett utkast.
  async searchHeader(path: string, header: string, value: string): Promise<number[]> {
    return this.withFolder(path, async (c) => {
      const res = await c.search({ header: { [header]: value } }, { uid: true });
      return Array.isArray(res) ? res : [];
    });
  }

  async deleteUids(path: string, uids: number[]) {
    if (!uids.length) return;
    await this.withFolder(path, async (c) => {
      await c.messageDelete(uids.join(','), { uid: true });
    });
  }

  get credentialValue(): Credential {
    return this.credential;
  }
}

export function isAuthError(err: any): boolean {
  return !!err?.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|authentication failed|LOGIN failed/i.test(err?.responseText ?? err?.message ?? '');
}

export type ProbeResult = { kind: 'ok' } | { kind: 'auth'; message: string } | { kind: 'unreachable'; message: string };

// Snabbt prov vid automatisk inställning: svarar servern, och godtas lösenordet?
export async function probeImap(cfg: AccountConfig, password: string, timeoutMs = 8000): Promise<ProbeResult> {
  const client = createClient(cfg, { user: cfg.username, pass: password }, { autoIdle: false, timeoutMs });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.logout().catch(() => undefined);
    return { kind: 'ok' };
  } catch (err: any) {
    client.close();
    return isAuthError(err) ? { kind: 'auth', message: friendlyError(err, cfg) } : { kind: 'unreachable', message: friendlyError(err, cfg) };
  }
}

export async function testImap(cfg: AccountConfig, credential: Credential): Promise<string | null> {
  let auth: Awaited<ReturnType<typeof imapAuth>>;
  try {
    auth = await imapAuth(cfg, credential);
  } catch (err: any) {
    return err?.message ?? t('Inloggningen misslyckades.');
  }
  const client = createClient(cfg, auth, { autoIdle: false });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.logout();
    return null;
  } catch (err: any) {
    client.close();
    return friendlyError(err, cfg);
  }
}
