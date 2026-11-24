import { app, BrowserWindow, ipcMain, type WebContents, nativeImage, nativeTheme, Notification, powerMonitor, safeStorage, shell, dialog, Menu, Tray, net } from 'electron';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AccountConfig,
  AccountInput,
  AccountState,
  AccountStatus,
  AiContextInfo,
  AiEngine,
  AiRequest,
  AiResult,
  ComposeInit,
  FolderRole,
  FullMessage,
  InviteResponse,
  MailboxSelection,
  MessageSummary,
  MessageBody,
  OutgoingMessage,
  OutboxInfo,
  OutboxItem,
  ReminderKind,
  Settings,
  SearchQuery,
  SetupInput,
  SetupOutcome,
  TestResult,
  TrustedSender
} from '../shared/types';
import { defaultAccounts, getProvider, guessProvider, isValidEmail, makeAccount, slugify, validateAccount } from '../shared/accounts';
import { buildDraft, formatAddress, removeDashes } from '../shared/compose';
import { buildMessages, buildTaskMessages, parseQuickReplies, taskCliPrompt, type ContextMail } from '../shared/prompts';
import { Store } from './db';
import { AccountSession, probeImap, testImap, type Credential } from './imap';
import { defaultDeps, discover, findWorkingConfig, type Candidate } from './discover';
import { buildRaw, sendRaw, testSmtp, type OutgoingPart, type SmtpSecret } from './smtp';
import { parseMessage, extractAttachment, isCalendarPart } from './parse';
import { inviteIdentity, inviteReplyMail, partstatToResponse } from './invite';
import { buildEvent, partstatOf, withoutMethod } from '../shared/ics';
import { runAi } from './ai';
import { clearModelCache, codexStatus, listOpenAiModels, OPENAI_URL, pickLatestGpt, resolveOpenAiModel } from './chatgpt';
import { ChatAborted, chatSystemPrompt, compactHistory, openAiCompleter, runChatLoop, type ApiMessage, type ChatEndpoint } from './chat';
import { chatSupported, findRefLinks, stepLabel, type ChatAnswer, type ChatRefs, type ChatStep } from '../shared/chat';
import { AGENT_TOOLS } from '../shared/agentTools';
import { authorize, withCalendar, ENDPOINTS, GRAPH_TOKEN_SCOPE, hasGoogleCalendarScope, OAuthError, providerFor, refreshAccessToken, type OAuthClient, type OAuthEndpoints, type OAuthProvider } from './oauth';
import { CalendarService } from './calendar/service';
import { CalendarAuthError, localZoneName, type CalendarProvider } from './calendar/provider';
import { GoogleCalendar, GOOGLE_API } from './calendar/google';
import { GraphCalendar, GRAPH_API } from './calendar/graph';
import { CalDavCalendar, caldavStarts, discoverCalDav } from './calendar/caldav';
import { resolveSrv } from 'node:dns/promises';
import type { EventInput, EventPerson } from '../shared/calendar';
import { isEmptyQuery, parseSearch } from '../shared/search';
import { createAgent, type AgentHost } from './agent';
import { categorize, findUnsubscribeLink, parseUnsubscribe, type CleanAction, type SenderStat } from '../shared/cleanup';
import { startAgentServer } from './agentServer';
import { newHttpToken, startAgentHttp } from './agentHttp';
import { guardAgent, type AskRequest } from './agentGuard';
import { McpClientError, clientStatus, connectClient, disconnectClient, envFromProcess, type McpEnv } from './mcpClients';
import { APP_FILE_NAME, APP_NAME, APP_VERSION, GITHUB_REPO, dataDirName, DB_FILE } from '../shared/brand';
import { getLang, resolveLang, setLang, t } from '../shared/i18n';
import { remoteImagePolicy, type RemoteImagePolicy } from '../shared/trust';
import { migrateSignatures, parseSparkExport, resolveSignature, type SparkSignature } from '../shared/signatures';

const here = dirname(fileURLToPath(import.meta.url));
const isDev = !!process.env.VITE_DEV_URL;

if (process.env.MRMAIL_DATA) app.setPath('userData', process.env.MRMAIL_DATA);
// Ett eget id för oinstallerade körningar (utveckling, tester), annars tar Windows aktivitetsfält Electrons ikon.
app.setAppUserModelId(app.isPackaged ? 'io.github.gkihlstadius.mrmail' : 'io.github.gkihlstadius.mrmail.dev');
app.setName(APP_NAME);
if (!process.env.MRMAIL_DATA) app.setPath('userData', join(app.getPath('appData'), dataDirName((n) => existsSync(join(app.getPath('appData'), n, DB_FILE)))));

if (!process.env.MRMAIL_DATA && !app.requestSingleInstanceLock()) {
  app.quit();
}

let store: Store;
let mainWindow: BrowserWindow | null = null;
const sessions = new Map<string, AccountSession>();
const statuses = new Map<string, { state: AccountState; error?: string; lastSync?: number }>();
const composeInits = new Map<number, ComposeInit>();
const closingAllowed = new Set<number>();

function log(msg: string) {
  if (process.env.MRMAIL_LOG) console.log(msg);
}

// Lösenord
function encrypt(password: string): Uint8Array {
  if (!safeStorage.isEncryptionAvailable()) throw new Error(t('Windows kryptering (DPAPI) är inte tillgänglig.'));
  return safeStorage.encryptString(password);
}

function decrypt(blob: Uint8Array | null): string | null {
  if (!blob || !blob.length) return null;
  try {
    return safeStorage.decryptString(Buffer.from(blob));
  } catch {
    return null;
  }
}

// Inloggning. Lösenord sparas som text, OAuth som JSON med förnyelsenyckeln, båda krypterade med safeStorage.
interface OAuthSecret {
  oauth: OAuthProvider;
  refreshToken: string;
  // Godkända behörigheter vid inloggningen (Google), och om kalendern i Graph begärdes (Microsoft).
  scope?: string;
  graph?: boolean;
}

function readOAuthSecret(raw: string | null): OAuthSecret | null {
  if (!raw || !raw.startsWith('{')) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v.refreshToken === 'string' && (v.oauth === 'google' || v.oauth === 'microsoft') ? v : null;
  } catch {
    return null;
  }
}

function oauthClient(provider: OAuthProvider): OAuthClient {
  const s = store.getSettings();
  if (provider === 'google') return { clientId: s.googleClientId.trim(), clientSecret: decrypt(store.getAppSecret('googleClientSecret')) ?? undefined };
  return { clientId: s.microsoftClientId.trim() };
}

// Tester kan peka om inloggningstjänsten till en låtsad server på den egna datorn.
function endpointsFor(provider: OAuthProvider): OAuthEndpoints {
  const raw = process.env.MRMAIL_OAUTH_TEST;
  if (!raw) return ENDPOINTS[provider];
  const over = JSON.parse(raw)[provider] ?? {};
  return { ...ENDPOINTS[provider], ...over };
}

function openLoginPage(url: string) {
  // I testläge följs omdirigeringen direkt i stället för att öppna webbläsaren.
  if (process.env.MRMAIL_OAUTH_TEST) return fetch(url).then(() => undefined);
  return shell.openExternal(url);
}

let oauthAbort: AbortController | null = null;

const accessTokens = new Map<string, { token: string; expiresAt: number }>();

// Färsk åtkomsttoken för ett OAuth-konto. Förnyas en minut innan den går ut.
async function accessToken(accountId: string): Promise<string> {
  const cached = accessTokens.get(accountId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const secret = readOAuthSecret(decrypt(store.getSecret(accountId)));
  if (!secret) throw new OAuthError('no_token', t('Logga in igen med knappen under Konton.'));
  const tok = await refreshAccessToken(endpointsFor(secret.oauth), oauthClient(secret.oauth), secret.refreshToken);
  accessTokens.set(accountId, { token: tok.accessToken, expiresAt: tok.expiresAt });
  if (tok.refreshToken && tok.refreshToken !== secret.refreshToken) {
    store.setSecret(accountId, encrypt(JSON.stringify({ ...secret, refreshToken: tok.refreshToken })));
  }
  return tok.accessToken;
}

// Lösenordet, eller en funktion som ger en token. null om inget är sparat.
function credentialFor(cfg: AccountConfig): Credential | null {
  const raw = decrypt(store.getSecret(cfg.id));
  if (!raw) return null;
  if (cfg.auth === 'oauth') return readOAuthSecret(raw) ? () => accessToken(cfg.id) : null;
  return raw;
}

// Åtkomsttoken för Microsoft Graph (kalendern): samma förnyelsenyckel, annan resurs.
const graphTokens = new Map<string, { token: string; expiresAt: number }>();
async function graphToken(accountId: string): Promise<string> {
  const cached = graphTokens.get(accountId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const secret = readOAuthSecret(decrypt(store.getSecret(accountId)));
  if (!secret?.graph) throw new CalendarAuthError();
  let tok;
  try {
    tok = await refreshAccessToken(endpointsFor('microsoft'), oauthClient('microsoft'), secret.refreshToken, GRAPH_TOKEN_SCOPE);
  } catch (e: any) {
    // Saknat medgivande eller utgången inloggning: användaren behöver logga in igen.
    if (e instanceof OAuthError && /invalid_grant|consent|interaction_required|invalid_scope|65001/i.test(`${e.code} ${e.message}`)) throw new CalendarAuthError();
    throw e;
  }
  graphTokens.set(accountId, { token: tok.accessToken, expiresAt: tok.expiresAt });
  if (tok.refreshToken && tok.refreshToken !== secret.refreshToken) store.setSecret(accountId, encrypt(JSON.stringify({ ...secret, refreshToken: tok.refreshToken })));
  return tok.accessToken;
}

// Tester kan peka om kalendrarnas API till en låtsad server på den egna datorn.
function calendarApi(kind: 'google' | 'graph'): string {
  const raw = process.env.MRMAIL_CALENDAR_TEST;
  const over = raw ? JSON.parse(raw)[kind] : undefined;
  return over || (kind === 'google' ? GOOGLE_API : GRAPH_API);
}

async function srvStarts(email: string): Promise<string[]> {
  const domain = email.split('@')[1];
  if (!domain || process.env.MRMAIL_NO_DNS) return [];
  try {
    const recs = await resolveSrv(`_caldavs._tcp.${domain}`);
    return recs.sort((a, b) => a.priority - b.priority).map((r) => `https://${r.name}${r.port === 443 ? '' : `:${r.port}`}/.well-known/caldav`);
  } catch {
    return [];
  }
}

// Kalendern för ett konto: Google och Microsoft via OAuth, övriga via CalDAV med kontots lösenord.
async function calendarProvider(cfg: AccountConfig): Promise<CalendarProvider | null> {
  const raw = decrypt(store.getSecret(cfg.id));
  if (!raw) return null;
  if (cfg.auth === 'oauth') {
    const secret = readOAuthSecret(raw);
    if (!secret) return null;
    if (secret.oauth === 'google') {
      if (!hasGoogleCalendarScope(secret.scope)) throw new CalendarAuthError();
      return new GoogleCalendar(cfg.id, () => accessToken(cfg.id), fetch, calendarApi('google'));
    }
    if (!secret.graph) throw new CalendarAuthError();
    return new GraphCalendar(cfg.id, () => graphToken(cfg.id), fetch, calendarApi('graph'), localZoneName());
  }
  // Gmail och Outlook med lösenord har ingen CalDAV med lösenord, där krävs inloggning med OAuth.
  if ((cfg.provider === 'gmail' || cfg.provider === 'outlook') && !cfg.caldavUrl) return null;
  const starts = caldavStarts(cfg.email, cfg.imap.host, cfg.provider, cfg.caldavUrl, await srvStarts(cfg.email));
  const creds = { username: cfg.username || cfg.email, password: raw };
  const found = await discoverCalDav(starts, creds);
  if (!found) return null;
  return new CalDavCalendar(cfg.id, found.home, creds, cfg.email, fetch, found.autoSchedule);
}

// Inbjudan eller inställt möte som mejl, när kalenderservern inte skickar dem själv.
async function sendCalendarMail(cfg: AccountConfig, to: EventPerson[], method: 'REQUEST' | 'CANCEL', ics: string, title: string) {
  const s = session(cfg.id);
  const subject = method === 'CANCEL' ? t('Inställt: {title}', { title }) : t('Inbjudan: {title}', { title });
  const text = method === 'CANCEL' ? t('Mötet "{title}" är inställt.', { title }) : t('Du är inbjuden till "{title}".', { title });
  const { raw, recipients } = await buildRaw(cfg, {
    to: to.map((p) => formatAddress({ name: p.name, address: p.email })).join(', '),
    cc: '',
    bcc: '',
    subject,
    text,
    attachments: [],
    icalEvent: { method, content: ics, filename: 'invite.ics' }
  });
  await sendRaw(cfg, await smtpSecret(s.credentialValue), raw, recipients);
  if (cfg.provider !== 'gmail') await s.append('sent', raw, ['\\Seen']).catch((e) => log(`kunde inte spara i Skickat: ${e?.message}`));
}

const calendar = new CalendarService({
  accounts: () => store.listAccounts(),
  provider: calendarProvider,
  get cache() {
    return store;
  },
  sendInvite: sendCalendarMail,
  onChange: () => scheduleCalendarBroadcast(),
  log
});

let calendarBroadcastTimer: NodeJS.Timeout | null = null;
function scheduleCalendarBroadcast() {
  if (calendarBroadcastTimer) return;
  calendarBroadcastTimer = setTimeout(() => {
    calendarBroadcastTimer = null;
    broadcast('calendar');
  }, 150);
}

async function smtpSecret(cred: Credential): Promise<SmtpSecret> {
  return typeof cred === 'string' ? cred : { accessToken: await cred() };
}

async function oauthLogin(input: AccountInput): Promise<{ ok: boolean; email?: string; error?: string; cancelled?: boolean }> {
  const cfg = { ...input.config };
  const provider = providerFor(cfg.provider);
  if (!provider) throw new Error(t('Kontot stöder inte inloggning med OAuth.'));
  oauthAbort?.abort();
  const abort = (oauthAbort = new AbortController());
  // Kalenderbehörigheten behålls vid ny inloggning om kontot redan hade den.
  const hadGraph = !!(cfg.id && readOAuthSecret(decrypt(store.getSecret(cfg.id)))?.graph);
  const wantCalendar = provider === 'microsoft' && (!!input.calendar || hadGraph);
  let tokens;
  try {
    tokens = await authorize(provider, oauthClient(provider), openLoginPage, {
      loginHint: cfg.email || undefined,
      endpoints: wantCalendar ? withCalendar(provider, endpointsFor(provider)) : endpointsFor(provider),
      signal: abort.signal
    });
  } catch (err: any) {
    if (err?.code === 'cancelled') return { ok: false, cancelled: true, error: err.message };
    throw err;
  } finally {
    if (oauthAbort === abort) oauthAbort = null;
  }
  const email = tokens.email ?? cfg.email;
  if (cfg.email && tokens.email && tokens.email !== cfg.email.trim().toLowerCase()) {
    return { ok: false, error: t('Du loggade in som {email}, men kontot gäller {account}. Logga in med rätt konto.', { email: tokens.email, account: cfg.email }) };
  }
  if (!cfg.email) {
    // Ett klick på Logga in med Google: adress och namn kommer från Google.
    if (!email) return { ok: false, error: t('{provider} skickade ingen e-postadress. Försök igen.', { provider: provider === 'google' ? 'Google' : 'Microsoft' }) };
    const same = store.listAccounts().find((a) => a.email.toLowerCase() === email.toLowerCase());
    if (same) Object.assign(cfg, { ...same, imap: cfg.imap, smtp: cfg.smtp, provider: cfg.provider });
    else {
      const label = provider === 'google' ? 'Gmail' : 'Outlook';
      cfg.id = uniqueId(email);
      cfg.name = store.listAccounts().some((a) => a.name === label) ? email : label;
    }
    cfg.email = email;
    cfg.username = email;
  }
  if (!cfg.displayName?.trim()) cfg.displayName = tokens.name ?? store.listAccounts().find((a) => a.displayName.trim())?.displayName ?? '';
  cfg.auth = 'oauth';
  const testServers = process.env.MRMAIL_OAUTH_TEST ? JSON.parse(process.env.MRMAIL_OAUTH_TEST).servers : null;
  if (testServers) Object.assign(cfg, { imap: testServers.imap, smtp: testServers.smtp });
  if (provider === 'microsoft') cfg.username = cfg.email;
  const errors = validateAccount(cfg);
  if (errors.length) return { ok: false, error: errors.join(' ') };
  store.saveAccount(cfg);
  store.setSecret(
    cfg.id,
    encrypt(JSON.stringify({ oauth: provider, refreshToken: tokens.refreshToken!, scope: tokens.scope, graph: wantCalendar || undefined } satisfies OAuthSecret))
  );
  accessTokens.set(cfg.id, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
  graphTokens.delete(cfg.id);
  calendar.invalidate(cfg.id);
  startSession(cfg);
  void calendar.refresh(cfg.id).catch(() => undefined);
  notifyChanged();
  return { ok: true, email: cfg.email };
}

function account(id: string): AccountConfig {
  const a = store.listAccounts().find((x) => x.id === id);
  if (!a) throw new Error(t('Kontot finns inte.'));
  return a;
}

function session(id: string): AccountSession {
  const s = sessions.get(id);
  if (!s) throw new Error(t('Kontot är inte anslutet. Fyll i lösenordet under Konton.'));
  return s;
}

// Status och händelser
function broadcast(channel: string, ...args: unknown[]) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
}

let changeTimer: NodeJS.Timeout | null = null;
function notifyChanged() {
  if (changeTimer) return;
  changeTimer = setTimeout(() => {
    changeTimer = null;
    broadcast('changed');
    updateBadge();
  }, 120);
}

function updateBadge() {
  const unread = store.listAccounts().reduce((n, a) => n + store.unreadCount(a.id), 0);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(unread ? `${APP_NAME} (${unread})` : APP_NAME);
  tray?.setToolTip(unread ? t('{app}, {n} olästa', { app: APP_NAME, n: unread }) : APP_NAME);
  (globalThis as any).__mrmailUnread = unread;
}

// Märket i aktivitetsfältet. Windows saknar räknare, så renderaren ritar en liten bild med antalet.
function setBadgeImage(dataUrl: string | null, count: number) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!dataUrl || count <= 0) mainWindow.setOverlayIcon(null, '');
  else mainWindow.setOverlayIcon(nativeImage.createFromDataURL(dataUrl), t('{n} olästa', { n: count }));
  (globalThis as any).__mrmailBadge = count;
}

// Systemfältet: Brevlåda kan stängas till systemfältet och fortsätta hämta mejl.
let tray: Tray | null = null;
let quitting = false;

// Språket i appen. Sätts vid start och när inställningen ändras, sedan laddas fönstren om.
function applyLanguage() {
  setLang(resolveLang(store.getSettings().language, app.getLocale()));
}

function createTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(join(here, '../../build/icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  trayMenu();
  tray.on('click', () => showMain());
  (globalThis as any).__mrmailTray = true;
}

function trayMenu() {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('Öppna {app}', { app: APP_NAME }), click: () => showMain() },
      {
        label: t('Nytt meddelande'),
        click: () => {
          const first = store.listAccounts()[0];
          if (first) openCompose({ mode: 'new', accountId: first.id });
        }
      },
      { type: 'separator' },
      {
        label: t('Avsluta'),
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
}

function applyLoginItem() {
  // Bara den installerade appen registreras, inte utvecklingsversionen.
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: store.getSettings().openAtLogin, args: ['--hidden'] });
}

// Påminnelser: kontrolleras varje halvminut. Snooze visar mejlet igen som oläst, uppföljning hör av sig
// om ingen annan har svarat i tråden.
function notifyReminder(m: MessageSummary, title: string) {
  (globalThis as any).__mrmailReminders = ((globalThis as any).__mrmailReminders ?? 0) + 1;
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: `${m.subject || t('(inget ämne)')}\n${senderLine(m)}`.slice(0, 240) });
  n.on('click', () => {
    showMain();
    mainWindow?.webContents.send('open-message', m.id);
  });
  n.show();
}

function senderLine(m: MessageSummary): string {
  const acc = store.listAccounts().find((a) => a.id === m.accountId);
  const own = acc && m.from.address === acc.email.toLowerCase();
  return own ? t('Till {name}', { name: m.to[0]?.name || m.to[0]?.address || '' }) : t('Från {name}', { name: m.from.name || m.from.address });
}

function checkReminders() {
  let changed = false;
  for (const r of store.listReminders().filter((x) => x.kind === 'followup')) {
    const m = store.reminderMessage(r);
    const acc = store.listAccounts().find((a) => a.id === r.accountId);
    if (m && acc && store.hasReplySince(m, r.created, acc.email)) {
      store.clearReminder(r.accountId, r.key, 'followup');
      changed = true;
    }
  }
  for (const r of store.dueReminders()) {
    const m = store.reminderMessage(r);
    changed = true;
    if (r.kind === 'snooze') {
      store.clearReminder(r.accountId, r.key, 'snooze');
      if (m) {
        void setFlag(m.id, 'seen', false).catch(() => undefined);
        notifyReminder(m, t('Påminnelse'));
      }
    } else {
      if (!m) {
        store.clearReminder(r.accountId, r.key, 'followup');
        continue;
      }
      store.setReminderState(r.accountId, r.key, 'followup', 'due');
      notifyReminder(m, t('Inget svar än'));
    }
  }
  if (changed) notifyChanged();
}

function remind(id: string, kind: ReminderKind, due: number) {
  const m = store.getMessage(id);
  if (!m) throw new Error(t('Meddelandet finns inte.'));
  if (!Number.isFinite(due)) throw new Error(t('Ogiltig tid.'));
  store.setReminder(m, kind, due);
  notifyChanged();
  setTimeout(checkReminders, Math.max(0, due - Date.now()) + 50);
}

function clearRemind(id: string) {
  const m = store.getMessage(id);
  if (!m) return;
  store.clearReminder(m.accountId, Store.reminderKey(m));
  notifyChanged();
}

// Utskrift och PDF. Renderaren bygger ett sanerat dokument med CSP, här skrivs det ut i ett dolt fönster.
async function printDocument(html: string, pdf: boolean, name: string): Promise<boolean> {
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    if (pdf) {
      const data = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
      const res = await dialog.showSaveDialog(mainWindow ?? win, {
        defaultPath: join(app.getPath('documents'), `${safeName(name || t('mejl'))}.pdf`),
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      });
      if (res.canceled || !res.filePath) return false;
      writeFileSync(res.filePath, data);
      return true;
    }
    return await new Promise<boolean>((resolve) => win.webContents.print({ printBackground: true }, (ok) => resolve(ok)));
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

function getStatuses(): AccountStatus[] {
  return store.listAccounts().map((a) => {
    const s = statuses.get(a.id) ?? { state: 'needs-password' as AccountState };
    return { id: a.id, state: s.state, error: s.error, unread: store.unreadCount(a.id), lastSync: s.lastSync };
  });
}

function startSession(cfg: AccountConfig) {
  const old = sessions.get(cfg.id);
  if (old) void old.stop();
  sessions.delete(cfg.id);
  const password = credentialFor(cfg);
  if (!password) {
    statuses.set(cfg.id, { state: 'needs-password' });
    notifyChanged();
    return;
  }
  const s = new AccountSession(
    cfg,
    password,
    store,
    {
      onStatus: (id, state, error) => {
        const prev = statuses.get(id);
        statuses.set(id, { state, error, lastSync: state === 'online' ? Date.now() : prev?.lastSync });
        notifyChanged();
      },
      onChanged: () => notifyChanged(),
      onNewMail: (accountId, ids) => showNotifications(accountId, ids),
      onArrived: (accountId, ids) => {
        applyCleanRules(accountId, ids);
        prefetchBodies(ids.slice(0, 40));
      },
      log
    },
    store.getSettings().syncLimit
  );
  sessions.set(cfg.id, s);
  s.start();
}

function showNotifications(accountId: string, ids: string[]) {
  if (!store.getSettings().notifications || !Notification.isSupported()) return;
  if (store.listAccounts().find((a) => a.id === accountId)?.notify === false) return;
  const msgs = (ids.map((id) => store.getMessage(id)).filter(Boolean) as NonNullable<ReturnType<Store['getMessage']>>[]).filter(
    (m) => !m.messageId || !restored.has(m.messageId)
  );
  if (!msgs.length) return;
  const acc = account(accountId);
  const show = msgs.slice(0, 3);
  for (const m of show) {
    const n = new Notification({
      title: m.from.name || m.from.address,
      subtitle: acc.name,
      body: `${m.subject || t('(inget ämne)')}\n${m.preview}`.slice(0, 240),
      silent: false,
      actions: [
        { type: 'button', text: t('Arkivera') },
        { type: 'button', text: t('Markera som läst') }
      ],
      hasReply: true,
      replyPlaceholder: t('Skriv ett svar')
    });
    n.on('click', () => {
      showMain();
      mainWindow?.webContents.send('open-message', m.id);
    });
    n.on('action', (e: any, legacyIndex?: number) => {
      const index = typeof e?.actionIndex === 'number' ? e.actionIndex : legacyIndex;
      void notificationAction(m.id, index === 0 ? 'archive' : 'read');
    });
    n.on('reply', (e: any, legacyReply?: string) => {
      const text = typeof e?.reply === 'string' ? e.reply : (legacyReply ?? '');
      void notificationReply(m.id, text);
    });
    keepNotification(n);
    n.show();
    (globalThis as any).__mrmailNotifications = ((globalThis as any).__mrmailNotifications ?? 0) + 1;
  }
  if (msgs.length > show.length) {
    new Notification({ title: APP_NAME, body: t('{n} nya mejl till i {account}', { n: msgs.length - show.length, account: acc.name }) }).show();
  }
}

// Notiser måste hållas kvar i minnet, annars försvinner knapparnas händelser.
const liveNotifications = new Set<Notification>();
function keepNotification(n: Notification) {
  liveNotifications.add(n);
  const drop = () => liveNotifications.delete(n);
  n.on('close', drop);
  setTimeout(drop, 24 * 3600_000);
}

async function notificationAction(id: string, action: 'archive' | 'read') {
  try {
    if (action === 'archive') await moveTo(id, 'archive');
    else await setFlag(id, 'seen', true);
  } catch (e: any) {
    log(`notis: ${e?.message}`);
    new Notification({ title: t('Det gick inte'), body: String(e?.message ?? e).slice(0, 200) }).show();
  }
}

// Svar skrivet direkt i notisen. Användaren har själv skrivit och skickat det, så det går iväg som ett vanligt svar.
async function notificationReply(id: string, text: string) {
  const body = text.trim();
  if (!body) return;
  try {
    const msg = await agentCall.compose({ svar_pa: id, text: body });
    await queueSend(msg);
    await setFlag(id, 'seen', true).catch(() => undefined);
    new Notification({ title: t('Svar skickat'), body: t('Till: {to}', { to: msg.to }).slice(0, 200) }).show();
  } catch (e: any) {
    log(`notissvar: ${e?.message}`);
    new Notification({ title: t('Svaret gick inte att skicka'), body: String(e?.message ?? e).slice(0, 200) }).show();
  }
}

// Uppdateringar: senaste versionen hämtas från GitHub Releases. Finns en nyare erbjuds den i appen,
// installationsfilen laddas ned och installeras tyst, sedan startar appen om. För utveckling och
// tester kan en mapp med installationsfiler anges i stället (inställningen updateDir eller MRMAIL_UPDATE_DIR).
let updateInfo: { version: string; file?: string; url?: string } | null = null;

function newerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

function updateDir(): string {
  return process.env.MRMAIL_UPDATE_DIR || store.getSettings().updateDir || '';
}

const SETUP_RE = () => new RegExp(`^${APP_FILE_NAME}-Setup-(\\d+\\.\\d+\\.\\d+)\\.exe$`);

async function latestRelease(): Promise<{ version: string; url: string } | null> {
  // Installerad med Scoop: Scoop sköter uppdateringen, annars hamnar en andra kopia under Programs.
  if (!GITHUB_REPO || !app.isPackaged || process.env.MRMAIL_DATA || /[\\/]scoop[\\/]apps[\\/]/i.test(process.execPath)) return null;
  const res = await net.fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': `${APP_FILE_NAME}/${APP_VERSION}` }
  });
  if (!res.ok) return null;
  const rel = (await res.json()) as { draft?: boolean; prerelease?: boolean; assets?: { name: string; browser_download_url: string }[] };
  if (rel.draft || rel.prerelease) return null;
  for (const a of rel.assets ?? []) {
    const m = SETUP_RE().exec(a.name);
    if (m && a.browser_download_url.startsWith('https://github.com/')) return { version: m[1], url: a.browser_download_url };
  }
  return null;
}

async function checkUpdate(): Promise<{ version: string } | null> {
  const dir = updateDir();
  let best: { version: string; file?: string; url?: string } | null = null;
  try {
    if (dir) {
      if (existsSync(dir)) {
        for (const f of readdirSync(dir)) {
          const m = SETUP_RE().exec(f);
          if (m && newerVersion(m[1], best?.version ?? APP_VERSION)) best = { version: m[1], file: join(dir, f) };
        }
      }
    } else {
      const rel = await latestRelease();
      if (rel && newerVersion(rel.version, APP_VERSION)) best = rel;
    }
  } catch (e: any) {
    log(`uppdatering: ${e?.message}`);
  }
  const changed = best?.version !== updateInfo?.version;
  updateInfo = best;
  if (changed) broadcast('update', best ? { version: best.version } : null);
  return best ? { version: best.version } : null;
}

async function installUpdate(): Promise<boolean> {
  await checkUpdate();
  const u = updateInfo;
  if (!u) throw new Error(t('Det finns ingen nyare version.'));
  if (process.env.MRMAIL_UPDATE_DRYRUN) {
    (globalThis as any).__mrmailUpdateRun = u.file ?? u.url;
    return true;
  }
  if (!app.isPackaged) throw new Error(t('Uppdatering fungerar bara i den installerade appen.'));
  let file = u.file;
  if (!file && u.url) {
    const res = await net.fetch(u.url);
    if (!res.ok) throw new Error(t('Uppdateringen gick inte att hämta ({status}).', { status: res.status }));
    const dir = join(app.getPath('temp'), 'mr-mail-update');
    mkdirSync(dir, { recursive: true });
    file = join(dir, basename(new URL(u.url).pathname));
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  if (!file) throw new Error(t('Det finns ingen nyare version.'));
  spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
  quitting = true;
  setTimeout(() => app.quit(), 300);
  return true;
}

// För e2e: samma vägar som knapparna i notisen.
(globalThis as any).__mrmailNotifyAction = notificationAction;
(globalThis as any).__mrmailNotifyReply = notificationReply;

// Fönster
function applyTheme() {
  const t = store.getSettings().theme;
  nativeTheme.themeSource = t === 'light' || t === 'dark' ? t : 'system';
}

function themeColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return dark ? { bg: '#1e1e20', symbol: '#e8e8ea' } : { bg: '#f5f5f7', symbol: '#1d1d1f' };
}

function loadRenderer(win: BrowserWindow, hash = '') {
  if (isDev) void win.loadURL(process.env.VITE_DEV_URL + (hash ? `#${hash}` : ''));
  else void win.loadFile(join(here, '../renderer/index.html'), { hash });
}

function secureWindow(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const current = win.webContents.getURL();
    if (url.split('#')[0] !== current.split('#')[0]) {
      e.preventDefault();
      if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
    }
  });
}

function webPrefs() {
  return {
    preload: join(here, '../preload/preload.cjs'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    spellcheck: true
  };
}

function createMainWindow() {
  const c = themeColors();
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 900,
    minHeight: 560,
    title: APP_NAME,
    backgroundColor: c.bg,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: c.bg, symbolColor: c.symbol, height: 44 },
    icon: join(here, '../../build/icon.png'),
    show: false,
    webPreferences: webPrefs()
  });
  secureWindow(mainWindow);
  mainWindow.once('ready-to-show', () => {
    if (!process.env.MRMAIL_HIDDEN && !process.argv.includes('--hidden')) mainWindow?.show();
  });
  mainWindow.on('close', (e) => {
    if (!quitting && tray && store.getSettings().closeToTray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // Kolla inkorgarna när fönstret får fokus, högst en gång i halvminuten.
  let lastFocusCheck = 0;
  mainWindow.on('focus', () => {
    if (Date.now() - lastFocusCheck < 30_000) return;
    lastFocusCheck = Date.now();
    for (const s of sessions.values()) s.checkInbox();
  });
  loadRenderer(mainWindow);
}

function showMain() {
  if (!mainWindow) createMainWindow();
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function openCompose(init: ComposeInit) {
  const c = themeColors();
  const win = new BrowserWindow({
    width: init.sourceId && init.mode !== 'forward' && init.mode !== 'draft' ? 1080 : 760,
    height: 740,
    minWidth: 520,
    minHeight: 420,
    title: t('Nytt meddelande'),
    backgroundColor: c.bg,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: c.bg, symbolColor: c.symbol, height: 44 },
    icon: join(here, '../../build/icon.png'),
    show: false,
    webPreferences: webPrefs()
  });
  secureWindow(win);
  composeInits.set(win.webContents.id, init);
  const wcId = win.webContents.id;
  win.on('closed', () => {
    composeInits.delete(wcId);
    closingAllowed.delete(wcId);
  });
  // Låt fönstret spara utkastet innan det stängs. Svarar det inte inom 8 s stängs det ändå.
  win.on('close', (e) => {
    if (closingAllowed.has(wcId)) return;
    e.preventDefault();
    if (win.webContents.isCrashed() || win.webContents.isLoading()) {
      closingAllowed.add(wcId);
      win.destroy();
      return;
    }
    win.webContents.send('before-close');
    setTimeout(() => {
      if (!win.isDestroyed()) {
        closingAllowed.add(wcId);
        win.destroy();
      }
    }, 8000);
  });
  win.once('ready-to-show', () => {
    if (!process.env.MRMAIL_HIDDEN) win.show();
  });
  loadRenderer(win, 'compose');
  return win;
}

nativeTheme.on('updated', () => {
  const c = themeColors();
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.setTitleBarOverlay({ color: c.bg, symbolColor: c.symbol, height: 44 });
      w.setBackgroundColor(c.bg);
    } catch {
      /* fönstret saknar overlay */
    }
  }
  broadcast('theme', nativeTheme.shouldUseDarkColors);
});

// Meddelanden
// Listan som visas, med en extra rad för att veta om cachen har fler mejl att visa.
function listMessages(sel: MailboxSelection, limit = 300): { items: MessageSummary[]; more: boolean } {
  if (sel.kind === 'reminders') {
    const items: MessageSummary[] = [];
    for (const r of store.listReminders()) {
      const m = store.reminderMessage(r);
      if (m) items.push({ ...m, reminder: { kind: r.kind, due: r.due, state: r.state } });
    }
    return { items, more: false };
  }
  const n = limit + 1;
  const raw =
    sel.kind === 'search'
      ? store.search(sel.search, n)
      : sel.kind === 'unified'
        ? store.listRoleMessages(sel.role, n)
        : sel.kind === 'label'
          ? store.listLabelMessages(sel.accountId, sel.label, n)
          : store.listFolderMessages(sel.accountId, sel.path, n);
  const more = raw.length > limit;
  const list = personalOverrides(raw.slice(0, limit));
  return { items: sel.kind !== 'search' && store.getSettings().threads ? store.groupThreads(list) : list, more };
}

// Avsändare användaren har skrivit till eller valt att behålla räknas alltid som personliga.
let sentToCache: { at: number; set: Set<string> } | null = null;
function sentTo(): Set<string> {
  if (!sentToCache || Date.now() - sentToCache.at > 60_000) sentToCache = { at: Date.now(), set: store.sentToAddresses() };
  return sentToCache.set;
}

function personalOverrides(list: MessageSummary[]): MessageSummary[] {
  const keep = new Set(store.getSettings().cleanKeep);
  const sent = sentTo();
  for (const m of list) {
    const a = m.from.address.toLowerCase();
    if (m.category !== 'personal' && (keep.has(a) || sent.has(a))) m.category = 'personal';
  }
  return list;
}

// Hämtar äldre mejl från servern för listan som visas. Returnerar antal nya i cachen.
async function loadOlder(sel: MailboxSelection): Promise<number> {
  const targets: { accountId: string; path: string }[] = [];
  if (sel.kind === 'folder') targets.push({ accountId: sel.accountId, path: sel.path });
  else if (sel.kind === 'unified') {
    for (const a of store.listAccounts()) {
      const path = sessions.get(a.id)?.rolePath(sel.role);
      if (path) targets.push({ accountId: a.id, path });
    }
  }
  let added = 0;
  for (const t of targets) {
    const s = sessions.get(t.accountId);
    if (s) added += await s.fetchOlder(t.path).catch((e) => (log(`äldre: ${e?.message}`), 0));
  }
  if (added) notifyChanged();
  return added;
}

// Söker på alla anslutna konton samtidigt. Träffarna läggs i cachen och skickas tillbaka.
async function searchServer(q: SearchQuery) {
  if (isEmptyQuery(q)) return [];
  const results = await Promise.all(
    [...sessions.values()].map((s) => s.searchServer(q).catch((e) => (log(`sök: ${e?.message}`), [] as string[])))
  );
  return results
    .flat()
    .map((id) => store.getMessage(id))
    .filter((m): m is NonNullable<typeof m> => !!m)
    .sort((a, b) => b.date - a.date)
    .slice(0, 300);
}

// Brödtext som hämtas just nu, så att ett klick på ett mejl som förhämtas inte hämtar det två gånger.
const bodyInflight = new Map<string, Promise<MessageBody>>();

function loadBody(id: string, background = false): Promise<MessageBody> {
  const cached = store.getBody(id);
  // Cache från före kalenderstödet saknar inbjudan: hämta om mejl med en kalenderdel.
  const stale = cached && cached.invite === undefined && cached.attachments.some((a) => isCalendarPart(a.contentType, a.filename));
  if (cached && !stale) return Promise.resolve(cached);
  let p = bodyInflight.get(id);
  if (!p) {
    p = fetchBody(id, background).finally(() => bodyInflight.delete(id));
    bodyInflight.set(id, p);
  }
  return p;
}

// Förhämtar brödtexten för mejl som troligen öppnas snart, ett i taget och utan stora bilagor.
const prefetchQueue: string[] = [];
let prefetching = false;
function prefetchBodies(ids: string[]) {
  for (const id of ids) {
    if (prefetchQueue.length >= 60) break;
    const m = store.getMessage(id);
    if (!m || m.hasAttachments || !sessions.has(m.accountId) || store.getBody(id) || prefetchQueue.includes(id)) continue;
    prefetchQueue.push(id);
  }
  if (prefetching || !prefetchQueue.length) return;
  prefetching = true;
  void (async () => {
    while (prefetchQueue.length) {
      const id = prefetchQueue.shift()!;
      if (!store.getBody(id)) await loadBody(id, true).catch(() => undefined);
    }
    prefetching = false;
  })();
}

async function fetchBody(id: string, background = false): Promise<MessageBody> {
  const m = store.getMessage(id);
  if (!m) throw new Error(t('Meddelandet finns inte.'));
  const s = session(m.accountId);
  const source = background ? await s.fetchSourceBackground(m.folder, m.uid) : await s.fetchSource(m.folder, m.uid);
  const parsed = await parseMessage(source);
  const body: MessageBody = { id, ...parsed.body };
  store.saveBody(body);
  store.setPreview(id, parsed.preview || m.preview, parsed.body.attachments.some((a) => !a.inline));
  return body;
}

async function openMessage(id: string, markSeen = true): Promise<FullMessage> {
  const body = await loadBody(id);
  const m = store.getMessage(id)!;
  if (markSeen && !m.seen) {
    store.setFlags(id, { seen: true });
    m.seen = true;
    notifyChanged();
    session(m.accountId)
      .setFlag(m.folder, m.uid, '\\Seen', true)
      .catch((e) => log(`kunde inte markera läst: ${e?.message}`));
  }
  return { ...m, body, remoteImages: imagePolicy(m) };
}

// Bilder från internet visas direkt för betrodda avsändare och för adresser användaren själv har skrivit till,
// men aldrig i skräpposten.
function imagePolicy(m: MessageSummary): RemoteImagePolicy {
  return remoteImagePolicy({
    from: m.from.address,
    role: store.folderRole(m.accountId, m.folder),
    folder: m.folder,
    labels: m.labels,
    trusted: new Set(store.trustedSenders().map((s) => s.address)),
    sentTo: sentTo()
  });
}

function setTrustedSender(address: string, trusted: boolean): TrustedSender[] {
  if (!store.setTrustedSender(String(address ?? ''), !!trusted)) throw new Error(t('Ogiltig adress.'));
  notifyChanged();
  return store.trustedSenders();
}

// Kalenderinbjudningar: svaret skickas som iMIP till organisatören från kontot som bjöds in.
async function respondInvite(id: string, response: InviteResponse, comment?: string): Promise<{ response: InviteResponse; calendar: boolean }> {
  if (response !== 'accept' && response !== 'tentative' && response !== 'decline') throw new Error(t('Okänt svar.'));
  const full = await openMessage(id, false);
  const cfg = account(full.accountId);
  const s = session(full.accountId);
  const input = inviteReplyMail(cfg, full, response, comment);
  const { raw, recipients } = await buildRaw(cfg, input);
  await sendRaw(cfg, await smtpSecret(s.credentialValue), raw, recipients);
  if (cfg.provider !== 'gmail') await s.append('sent', raw, ['\\Seen']).catch((e) => log(`kunde inte spara i Skickat: ${e?.message}`));
  const ev = full.body.invite!.event;
  store.setInviteAnswer(cfg.id, ev.uid, response, ev.sequence);
  const calendar = await calendarAfterAnswer(cfg, full, response).catch((e) => {
    log(`kalender: kunde inte uppdatera efter svar: ${e?.message}`);
    return false;
  });
  notifyChanged();
  return { response, calendar };
}

function inviteState(id: string): { response: InviteResponse | null; outdated: boolean; calendar: boolean } | null {
  const m = store.getMessage(id);
  const ev = store.getBody(id)?.invite?.event;
  if (!m || !ev) return null;
  const cfg = store.listAccounts().find((a) => a.id === m.accountId);
  const saved = store.inviteAnswer(m.accountId, ev.uid);
  const fromFile = partstatToResponse(partstatOf(ev, cfg ? [cfg.email] : []));
  const outdated = !!saved && saved.sequence < ev.sequence && !fromFile;
  return { response: outdated ? null : ((saved?.response as InviteResponse | undefined) ?? fromFile), outdated, calendar: !!cfg && calendarConnected(cfg.id) };
}

// Lägg till i kalendern: i den anslutna kalendern om det finns en, annars som fil.
async function inviteAdd(id: string): Promise<'calendar' | 'file' | null> {
  const full = await openMessage(id, false);
  const inv = full.body.invite;
  if (!inv) throw new Error(t('Mejlet innehåller ingen inbjudan.'));
  const cfg = account(full.accountId);
  if (calendarConnected(cfg.id)) {
    await calendarAddInvite(cfg, full);
    return 'calendar';
  }
  const ev = inv.event;
  const ics = inv.ics
    ? withoutMethod(inv.ics)
    : buildEvent({ uid: ev.uid, title: ev.summary, start: ev.start, end: ev.end, allDay: ev.allDay, startDate: ev.startDate, endDate: ev.endDate, location: ev.location, description: ev.description });
  const res = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow() ?? mainWindow!, {
    defaultPath: join(app.getPath('downloads'), `${safeName(ev.summary || t('Händelse'))}.ics`),
    filters: [{ name: t('Kalenderfil'), extensions: ['ics'] }]
  });
  if (res.canceled || !res.filePath) return null;
  writeFileSync(res.filePath, ics);
  return 'file';
}

function calendarConnected(accountId: string): boolean {
  return calendar.connected(accountId);
}

async function calendarAfterAnswer(cfg: AccountConfig, msg: FullMessage, response: InviteResponse): Promise<boolean> {
  if (!msg.body.invite || !calendar.connected(cfg.id)) return false;
  return calendar.saveInvite(cfg.id, msg.body.invite, response, inviteIdentity(cfg, msg));
}

async function calendarAddInvite(cfg: AccountConfig, msg: FullMessage): Promise<void> {
  await calendar.saveInvite(cfg.id, msg.body.invite!, null, inviteIdentity(cfg, msg));
}

// Händelse från fönstret eller AI-verktygen, kontrollerad.
function eventInput(raw: any): EventInput {
  const title = String(raw?.title ?? '').trim();
  const start = Number(raw?.start);
  const end = Number(raw?.end);
  if (!title) throw new Error(t('Händelsen behöver en titel.'));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error(t('Sluttiden måste vara efter starttiden.'));
  const attendees = Array.isArray(raw?.attendees)
    ? raw.attendees.map((a: any) => ({ name: String(a?.name ?? '').trim(), email: String(a?.email ?? '').trim().toLowerCase() })).filter((a: { email: string }) => /^[^\s@]+@[^\s@]+$/.test(a.email))
    : undefined;
  return {
    title,
    start,
    end,
    allDay: !!raw?.allDay,
    startDate: typeof raw?.startDate === 'string' ? raw.startDate : undefined,
    endDate: typeof raw?.endDate === 'string' ? raw.endDate : undefined,
    location: typeof raw?.location === 'string' ? raw.location.trim() : undefined,
    description: typeof raw?.description === 'string' ? raw.description : undefined,
    attendees
  };
}

const FLAG_NAMES = { seen: '\\Seen', flagged: '\\Flagged' } as const;

async function setFlag(id: string, flag: keyof typeof FLAG_NAMES, value: boolean) {
  const m = store.getMessage(id);
  if (!m) return;
  store.setFlags(id, { [flag]: value });
  notifyChanged();
  try {
    await session(m.accountId).setFlag(m.folder, m.uid, FLAG_NAMES[flag], value);
  } catch (err) {
    store.setFlags(id, { [flag]: !value });
    notifyChanged();
    throw err;
  }
}

// Flytt av ett eller flera mejl. Varje flytt sparas så att den kan ångras, utom radering för gott.
interface UndoItem {
  accountId: string;
  source: string;
  dest: string;
  uid?: number;
  messageId: string;
}
const undoStack: { id: string; items: UndoItem[] }[] = [];
// Mejl som ångrats tillbaka till inkorgen ska inte ge en notis om nytt mejl.
const restored = new Set<string>();

async function moveMany(ids: string[], target: { role?: FolderRole; path?: string }): Promise<{ moved: number; undoId?: string; error?: string }> {
  const groups = new Map<string, MessageSummary[]>();
  for (const id of ids) {
    const m = store.getMessage(id);
    if (!m) continue;
    const key = `${m.accountId}|${m.folder}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  // Målmapparna kontrolleras först, så att inget flyttas om ett konto saknar mappen.
  const plan = [...groups.values()].map((msgs) => {
    const { accountId, folder } = msgs[0];
    const s = session(accountId);
    let dest: string;
    if (target.path) {
      if (store.folderRole(accountId, target.path) === null) throw new Error(t('Mappen finns inte i det här kontot.'));
      dest = target.path;
    } else dest = s.destFor(target.role!);
    return { msgs, accountId, folder, s, dest };
  });
  const undo: UndoItem[] = [];
  let moved = 0;
  let error: string | undefined;
  for (const { msgs, accountId, folder, s, dest } of plan) {
    if (dest === folder && target.role !== 'trash') continue;
    const uids = msgs.map((m) => m.uid);
    try {
      if (target.role === 'trash' && store.folderRole(accountId, folder) === 'trash') {
        await s.deleteUids(folder, uids);
      } else {
        const map = await s.moveUids(folder, uids, dest);
        for (const m of msgs) undo.push({ accountId, source: folder, dest, uid: map.get(m.uid), messageId: m.messageId ?? '' });
        void s.syncFolderNow(dest).catch(() => undefined);
      }
      store.deleteMessages(msgs.map((m) => m.id));
      moved += msgs.length;
    } catch (e: any) {
      error = e?.message ?? String(e);
      void s.syncFolderNow(folder).catch(() => undefined);
    }
  }
  notifyChanged();
  if (!moved && error) throw new Error(error);
  if (!undo.length) return { moved, error };
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  undoStack.push({ id, items: undo });
  if (undoStack.length > 20) undoStack.shift();
  return { moved, undoId: id, error };
}

async function moveTo(id: string, role: FolderRole) {
  return moveMany([id], { role });
}

async function moveToPath(id: string, destPath: string) {
  return moveMany([id], { path: destPath });
}

// Flyttar tillbaka mejlen från en tidigare flytt, den senaste om inget id anges.
async function undoMove(undoId?: string): Promise<number> {
  const idx = undoId ? undoStack.findIndex((u) => u.id === undoId) : undoStack.length - 1;
  if (idx < 0) throw new Error(t('Det finns inget att ångra.'));
  const [entry] = undoStack.splice(idx, 1);
  const groups = new Map<string, UndoItem[]>();
  for (const it of entry.items) {
    const key = `${it.accountId}|${it.dest}|${it.source}`;
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }
  let count = 0;
  for (const items of groups.values()) {
    const { accountId, dest, source } = items[0];
    const s = session(accountId);
    const uids: number[] = [];
    for (const it of items) {
      if (it.uid) uids.push(it.uid);
      else if (it.messageId) {
        const found = await s.searchHeader(dest, 'Message-ID', it.messageId).catch(() => []);
        if (found.length) uids.push(Math.max(...found));
      }
      if (it.messageId) restored.add(it.messageId);
    }
    if (!uids.length) continue;
    await s.moveUids(dest, uids, source);
    store.deleteMessages(uids.map((u) => store.messageIdFor(accountId, dest, u)).filter((x): x is string => !!x));
    count += uids.length;
    await s.syncFolderNow(source).catch(() => undefined);
    void s.syncFolderNow(dest).catch(() => undefined);
  }
  setTimeout(() => {
    for (const it of entry.items) restored.delete(it.messageId);
  }, 120_000);
  notifyChanged();
  if (!count) throw new Error(t('Mejlen gick inte att hitta längre.'));
  return count;
}

const BLOCKED_EXT = /\.(exe|bat|cmd|com|scr|pif|msi|msp|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|hta|lnk|reg|jar|cpl|dll|appref-ms|application|gadget|msc|iso|img|vhd|vhdx)$/i;

async function attachment(id: string, index: number) {
  const m = store.getMessage(id);
  if (!m) throw new Error(t('Meddelandet finns inte.'));
  const source = await session(m.accountId).fetchSource(m.folder, m.uid);
  const a = await extractAttachment(source, index);
  if (!a) throw new Error(t('Bilagan hittades inte.'));
  return a;
}

function safeName(name: string) {
  return basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180) || 'bilaga';
}

// Utkast. Varje svarsfönster har en nyckel i rubriken X-Brevlada-Draft (fast namn, äldre utkast känns igen), så att en ny version
// ersätter den förra och utkastet försvinner när mejlet skickas.
const DRAFT_HEADER = 'X-Brevlada-Draft';
const draftVersions = new Map<string, { accountId: string; path: string; uid: number }[]>();
const consumedDrafts = new Set<string>();

async function removeDraftVersions(msg: OutgoingMessage, key: string, keep: { accountId: string; path: string; uid?: number } | null) {
  const old = key ? (draftVersions.get(key) ?? []) : [];
  const targets = [...old];
  if (msg.draftOf && !consumedDrafts.has(msg.draftOf)) {
    const src = store.getMessage(msg.draftOf);
    if (src) targets.push({ accountId: src.accountId, path: src.folder, uid: src.uid });
  }
  // Versioner som inte hann registreras (till exempel om servern saknar UIDPLUS) hittas via rubriken.
  if (key) {
    for (const a of store.listAccounts()) {
      const s = sessions.get(a.id);
      const drafts = s?.rolePath('drafts');
      if (!s || !drafts) continue;
      const uids = await s.searchHeader(drafts, DRAFT_HEADER, key).catch(() => [] as number[]);
      for (const uid of uids) if (!targets.some((t) => t.accountId === a.id && t.path === drafts && t.uid === uid)) targets.push({ accountId: a.id, path: drafts, uid });
    }
  }
  // Utan UIDPLUS saknas UID för den nya versionen. UID växer alltid, så den högsta i mappen är den nya.
  if (keep && keep.uid === undefined) {
    const k = keep;
    const same = targets.filter((t) => t.accountId === k.accountId && t.path === k.path).map((t) => t.uid);
    keep = { ...k, uid: same.length ? Math.max(...same) : undefined };
  }
  const kept = keep;
  const safe = targets.filter((t) => !(kept && t.accountId === kept.accountId && t.path === kept.path && t.uid === kept.uid));
  const byFolder = new Map<string, { accountId: string; path: string; uids: number[] }>();
  for (const t of safe) {
    const k = `${t.accountId}|${t.path}`;
    const e = byFolder.get(k) ?? { accountId: t.accountId, path: t.path, uids: [] };
    e.uids.push(t.uid);
    byFolder.set(k, e);
  }
  for (const e of byFolder.values()) {
    const s = sessions.get(e.accountId);
    if (!s) continue;
    await s.deleteUids(e.path, e.uids);
    store.deleteMessages(e.uids.map((uid) => store.messageIdFor(e.accountId, e.path, uid)).filter((x): x is string => !!x));
  }
  if (msg.draftOf) consumedDrafts.add(msg.draftOf);
  if (key) {
    if (keep?.uid !== undefined) draftVersions.set(key, [{ accountId: keep.accountId, path: keep.path, uid: keep.uid }]);
    else draftVersions.delete(key);
  }
  if (byFolder.size) notifyChanged();
}

// Sändning
async function sendMessage(msg: OutgoingMessage, asDraft = false) {
  const cfg = account(msg.accountId);
  const s = session(msg.accountId);
  const parts: OutgoingPart[] = msg.attachments.map((a) => ({ filename: a.filename, path: a.path }));
  if (msg.forwardOf) {
    const src = store.getMessage(msg.forwardOf);
    if (src) {
      const source = await session(src.accountId).fetchSource(src.folder, src.uid);
      const parsed = await parseMessage(source);
      for (const att of parsed.parsed.attachments ?? []) {
        const inline = att.contentDisposition === 'inline' && att.cid;
        if (!inline) parts.push({ filename: att.filename || 'bilaga', content: att.content, contentType: att.contentType });
      }
    }
  }
  if (asDraft) {
    const key = msg.draftKey || `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
    const { raw } = await buildRaw(cfg, { ...msg, attachments: parts, headers: { [DRAFT_HEADER]: key } }, { draft: true });
    const res = await s.append('drafts', raw, ['\\Draft', '\\Seen']);
    if (!res) throw new Error(t('Kontot saknar mappen {folder}.', { folder: t('Utkast') }));
    // Den nya versionen ligger på servern, ta bort de föregående.
    await removeDraftVersions(msg, key, { accountId: cfg.id, path: res.path, uid: res.uid });
    void s.syncFolderNow(res.path).catch(() => undefined);
    return key;
  }
  const { raw, recipients } = await buildRaw(cfg, { ...msg, attachments: parts });
  await sendRaw(cfg, await smtpSecret(s.credentialValue), raw, recipients);
  await removeDraftVersions(msg, msg.draftKey ?? '', null).catch((e) => log(`kunde inte ta bort utkast: ${e?.message}`));
  if (cfg.provider !== 'gmail') {
    await s.append('sent', raw, ['\\Seen']).catch((e) => log(`kunde inte spara i Skickat: ${e?.message}`));
  }
  // Följ upp om inget svar: påminnelsen knyts till det skickade mejlets Message-ID.
  if (msg.followUpDays && msg.followUpDays > 0) {
    const mid = raw.toString('utf8', 0, Math.min(raw.length, 16384)).match(/^Message-ID:\s*(<[^>]+>)/im)?.[1];
    if (mid) {
      store.setReminder({ id: '', accountId: cfg.id, messageId: mid, subject: msg.subject } as MessageSummary, 'followup', Date.now() + msg.followUpDays * 86400000);
      notifyChanged();
    }
  }
  const sent = s.rolePath('sent');
  if (sent) void s.syncFolderNow(sent).catch(() => undefined);
  if (msg.inReplyTo) {
    const source = store.db
      .prepare('SELECT id FROM messages WHERE message_id = ? AND account_id = ? LIMIT 1')
      .get(msg.inReplyTo, msg.accountId) as { id: string } | undefined;
    if (source) {
      const m = store.getMessage(source.id)!;
      store.setFlags(m.id, { answered: true });
      s.setFlag(m.folder, m.uid, '\\Answered', true).catch(() => undefined);
      notifyChanged();
    }
  }
}

// AI. Modellen får hela tråden och tidigare mejl med samma person ur cachen.
async function aiContext(full: FullMessage, cfg: AccountConfig): Promise<{ thread: ContextMail[]; earlier: ContextMail[]; info: AiContextInfo }> {
  const others = store
    .thread(full.id)
    .filter((m) => m.id !== full.id && m.messageId !== full.messageId)
    .sort((a, b) => a.date - b.date)
    .slice(-8);
  const thread: ContextMail[] = [];
  let fetched = 0;
  for (const m of others) {
    let text = store.getBody(m.id)?.text;
    // Hämta brödtexten för de senaste mejlen i tråden om den inte finns i cachen.
    if (!text && fetched < 4 && m.date >= (others[Math.max(0, others.length - 4)]?.date ?? 0)) {
      fetched++;
      text = await loadBody(m.id).then((b) => b.text).catch(() => undefined);
    }
    thread.push({ from: m.from, to: m.to, date: m.date, subject: m.subject, text: text || m.preview });
  }
  const own = cfg.email.toLowerCase();
  const person = full.from.address.toLowerCase() === own ? (full.to[0] ?? full.from) : full.from;
  const earlier = store.mailsWith(cfg.id, person.address, full.threadId ?? '', 5).map(({ summary, text }) => ({
    from: summary.from,
    to: summary.to,
    date: summary.date,
    subject: summary.subject,
    text
  }));
  return { thread, earlier, info: { thread: thread.length + 1, earlier: earlier.length, person: person.name || person.address } };
}

async function promptInput(sourceId: string, accountId: string) {
  const settings = store.getSettings();
  const full = await openMessage(sourceId, false);
  const cfg = account(accountId);
  const ctx = await aiContext(full, cfg);
  return {
    settings,
    ctx,
    input: {
      message: full,
      ownName: cfg.displayName,
      ownEmail: cfg.email,
      tone: settings.tone,
      examples: store.recentSentTexts(cfg.id, 3),
      history: [] as AiRequest['history'],
      thread: ctx.thread,
      earlier: ctx.earlier
    }
  };
}

function openaiKey(): string | null {
  return decrypt(store.getAppSecret('openaiKey')) || null;
}

async function aiSuggest(req: AiRequest) {
  const { settings, ctx, input } = await promptInput(req.sourceId, req.accountId);
  const messages = buildMessages({ ...input, draft: req.draft, history: req.history, instruction: req.instruction });
  const res = await runAi(settings, messages, { engine: req.engine, openaiKey: openaiKey() });
  return { ...res, context: ctx.info };
}

const quickCache = new Map<string, AiResult>();

// Sammanfatta tråd, Vad behöver jag göra? och snabbsvar i läsvyn.
async function aiTask(sourceId: string, task: 'summary' | 'todo' | 'quick', engine?: AiEngine): Promise<AiResult> {
  const m = store.getMessage(sourceId);
  if (!m) throw new Error(t('Meddelandet finns inte.'));
  const settings = store.getSettings();
  const key = `${sourceId}|${engine ?? settings.aiEngine}`;
  if (task === 'quick' && quickCache.has(key)) return quickCache.get(key)!;
  const { ctx, input } = await promptInput(sourceId, m.accountId);
  const res = await runAi(settings, buildTaskMessages(task, input), { engine, raw: true, cliPrompt: taskCliPrompt(task), openaiKey: openaiKey() });
  const out: AiResult = { ...res, context: ctx.info };
  if (task !== 'quick' || !res.ok) return { ...out, text: res.text ? removeDashes(res.text) : res.text };
  const options = parseQuickReplies(res.text ?? '').map(removeDashes);
  if (options.length < 2) return { ...out, ok: false, error: t('Modellen gav inga användbara snabbsvar. Försök igen.') };
  const done = { ...out, options };
  quickCache.set(key, done);
  if (quickCache.size > 200) quickCache.delete(quickCache.keys().next().value!);
  return done;
}

// Konton
async function testAccount(input: AccountInput): Promise<TestResult> {
  const cfg = input.config;
  const stored = store.listAccounts().find((a) => a.id === cfg.id);
  const cred: Credential | null = input.password || (stored ? credentialFor({ ...cfg, auth: stored.auth }) : null);
  if (!cred) return { ok: false, imap: cfg.auth === 'oauth' ? t('Logga in med knappen ovan.') : t('Fyll i lösenordet.') };
  let secret: SmtpSecret;
  try {
    secret = await smtpSecret(cred);
  } catch (err: any) {
    return { ok: false, imap: err?.message ?? t('Inloggningen misslyckades.') };
  }
  const [imap, smtp] = await Promise.all([testImap(cfg, cred), testSmtp(cfg, secret)]);
  return { ok: !imap && !smtp, imap: imap ?? undefined, smtp: smtp ?? undefined };
}

function uniqueId(email: string): string {
  const taken = new Set(store.listAccounts().map((a) => a.id));
  let id = slugify(email);
  for (let n = 2; taken.has(id); n++) id = `${slugify(email)}-${n}`;
  return id;
}

// Enkel inloggning: bara adress och lösenord. Servrarna letas upp och provas, första som fungerar sparas.
async function autoSetup(input: SetupInput): Promise<SetupOutcome> {
  const email = String(input?.email ?? '').trim();
  const password = String(input?.password ?? '');
  const displayName = String(input?.displayName ?? '').trim();
  if (!isValidEmail(email)) return { ok: false, reason: 'invalid', message: t('Ange en giltig e-postadress.'), provider: 'manual' };
  if (!password) return { ok: false, reason: 'invalid', message: t('Fyll i lösenordet.'), provider: guessProvider(email) };
  const existing = input.accountId ? store.listAccounts().find((a) => a.id === input.accountId) : undefined;
  if (!existing && store.listAccounts().some((a) => a.email.toLowerCase() === email.toLowerCase()))
    return { ok: false, reason: 'invalid', message: t('Kontot finns redan i {app}.', { app: APP_NAME }), provider: guessProvider(email) };
  const progress = (text: string) => mainWindow?.webContents.send('setup-progress', text);
  progress(t('Letar efter servrar…'));
  const index = store.listAccounts().length;
  const toCfg = (c: Candidate): AccountConfig =>
    existing
      ? { ...existing, email, provider: c.provider, imap: c.imap, smtp: c.smtp, username: c.username, displayName: displayName || existing.displayName, auth: 'password' }
      : makeAccount(email, c.provider, { id: uniqueId(email), imap: c.imap, smtp: c.smtp, username: c.username, displayName }, index);
  // Vald leverantör: servrarna är kända och provas direkt. Annars letas de upp.
  const preset = input.provider && input.provider !== 'manual' ? getProvider(input.provider) : null;
  const candidates = preset
    ? [{ provider: preset.id, imap: { ...preset.imap }, smtp: { ...preset.smtp }, username: email, source: 'leverantör' as const }]
    : await discover(email, defaultDeps());
  log(`Inställning för ${email.split('@')[1]}: ${candidates.map((c) => `${c.source} ${c.imap.host}`).join(', ') || 'inga förslag'}`);
  const res = await findWorkingConfig(
    email,
    password,
    candidates,
    { imap: (c, pw) => probeImap(toCfg(c), pw), smtp: (c, pw) => testSmtp(toCfg(c), pw, 8000) },
    progress
  );
  if (!res.ok) {
    const cfg = 'candidate' in res ? toCfg(res.candidate) : null;
    return { ok: false, reason: res.reason, message: res.message, provider: cfg?.provider ?? guessProvider(email), config: cfg ?? undefined };
  }
  const cfg = toCfg(res.candidate);
  const saved = saveAccount({ config: cfg, password });
  if (!saved.ok) return { ok: false, reason: 'invalid', message: saved.errors.join(' '), provider: cfg.provider, config: cfg };
  return { ok: true, account: cfg };
}

// Kontots signatur räknas fram ur biblioteket, så att svarsfönster och utkast bara läser account.signature.
function withSignature(cfg: AccountConfig): AccountConfig {
  return { ...cfg, signature: resolveSignature(cfg, store.getSettings().signatures) };
}

function applySignatures() {
  const sigs = store.getSettings().signatures;
  for (const a of store.listAccounts()) {
    const html = resolveSignature(a, sigs);
    if ((a.signature ?? '') !== html) store.saveAccount({ ...a, signature: html });
  }
  notifyChanged();
}

function migrateOldSignatures() {
  const m = migrateSignatures(store.listAccounts(), store.getSettings().signatures);
  if (!m.changed) return;
  store.saveSettings({ signatures: m.signatures });
  for (const a of m.accounts) store.saveAccount(a);
}

// Signaturexporten från Spark. I testläge bara den fil testet pekar ut, annars några vanliga platser.
function sparkExportPath(): string | null {
  if (process.env.MRMAIL_SPARK_EXPORT) return existsSync(process.env.MRMAIL_SPARK_EXPORT) ? process.env.MRMAIL_SPARK_EXPORT : null;
  if (process.env.MRMAIL_DATA) return null;
  const name = 'spark-signaturer.json';
  const candidates = [
    join(app.getPath('documents'), name),
    join(app.getPath('downloads'), name),
    join(app.getPath('userData'), name)
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

function readSparkExport(path: string): { path: string; signatures: SparkSignature[] } {
  if (statSync(path).size > 5 * 1024 * 1024) throw new Error(t('Filen är för stor för att vara en signaturexport.'));
  return { path, signatures: parseSparkExport(readFileSync(path, 'utf8')) };
}

function saveAccount(input: AccountInput) {
  const errors = validateAccount(input.config);
  if (errors.length) return { ok: false, errors };
  const cfg = withSignature({ ...input.config });
  // Nytt lösenord betyder att kontot går över till lösenordsinloggning.
  if (input.password) {
    cfg.auth = 'password';
    accessTokens.delete(cfg.id);
  }
  store.saveAccount(cfg);
  if (input.password) store.setSecret(cfg.id, encrypt(input.password));
  calendar.invalidate(cfg.id);
  startSession(cfg);
  void calendar.refresh(cfg.id).catch(() => undefined);
  notifyChanged();
  return { ok: true, errors: [] };
}

function handle(channel: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err: any) {
      log(`${channel}: ${err?.message}`);
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
}

function registerIpc() {
  handle('state', () => ({
    accounts: store.listAccounts(),
    statuses: getStatuses(),
    folders: store.listFolders(),
    labels: store.listAccounts().flatMap((a) => store.distinctLabels(a.id).map((label) => ({ accountId: a.id, label }))),
    reminders: store.listReminders(),
    settings: store.getSettings(),
    dark: nativeTheme.shouldUseDarkColors,
    encryption: safeStorage.isEncryptionAvailable()
  }));
  handle('list', (sel: MailboxSelection, limit?: number) => listMessages(sel, limit));
  handle('thread', (id: string) => store.thread(id));
  handle('load-older', (sel: MailboxSelection) => loadOlder(sel));
  handle('search-server', (q: SearchQuery) => searchServer(q));
  handle('open', (id: string) => openMessage(id));
  handle('flag', (id: string, flag: 'seen' | 'flagged', value: boolean) => setFlag(id, flag, value));
  handle('move', (id: string, role: FolderRole) => moveTo(id, role));
  handle('move-to', (id: string, accountId: string, path: string) => moveToPath(id, path));
  handle('move-many', (ids: string[], target: { role?: FolderRole; path?: string }) => moveMany(ids, target));
  handle('undo-move', (undoId?: string) => undoMove(undoId));
  handle('update-check', () => checkUpdate());
  handle('update-install', () => installUpdate());
  handle('attachment-save', async (id: string, index: number) => {
    const a = await attachment(id, index);
    const res = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow() ?? mainWindow!, {
      defaultPath: join(app.getPath('downloads'), safeName(a.filename || t('bilaga')))
    });
    if (res.canceled || !res.filePath) return false;
    writeFileSync(res.filePath, a.content);
    return true;
  });
  handle('attachment-open', async (id: string, index: number) => {
    const a = await attachment(id, index);
    const name = safeName(a.filename || t('bilaga'));
    if (BLOCKED_EXT.test(name)) throw new Error(t('Filtypen kan vara farlig och öppnas inte direkt. Spara den i stället.'));
    const dir = join(app.getPath('temp'), 'mr-mail', String(Date.now()));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, a.content);
    const err = await shell.openPath(file);
    if (err) throw new Error(err);
    return true;
  });
  handle('external', (url: string) => {
    if (!/^(https?|mailto):/i.test(url)) throw new Error(t('Länken öppnas inte.'));
    return shell.openExternal(url);
  });
  handle('compose', (init: ComposeInit) => {
    openCompose(init);
  });
  handle('compose-init', async (wcId: number) => {
    const init = composeInits.get(wcId);
    if (!init) throw new Error(t('Fönstret saknar uppgifter.'));
    const cfg = account(init.accountId);
    const msg = init.sourceId ? await openMessage(init.sourceId, false) : undefined;
    return { init, draft: buildDraft(init.mode, cfg, msg), source: msg ?? null };
  });
  handle('send', (msg: OutgoingMessage, at?: number) => queueSend(msg, at));
  handle('outbox', () => outboxInfo());
  handle('outbox-send-now', (id: string) => flushOutbox(id));
  handle('outbox-edit', (id: string) => editOutbox(id));
  handle('save-draft', (msg: OutgoingMessage) => sendMessage(msg, true));
  handle('pick-files', async () => {
    const res = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() ?? mainWindow!, {
      properties: ['openFile', 'multiSelections']
    });
    if (res.canceled) return [];
    return res.filePaths.map((p) => ({ filename: basename(p), path: p, size: statSync(p).size }));
  });
  handle('ai', (req: AiRequest) => aiSuggest(req));
  handle('remind', (id: string, kind: ReminderKind, due: number) => remind(id, kind, due));
  handle('remind-clear', (id: string) => clearRemind(id));
  handle('badge', (dataUrl: string | null, count: number) => setBadgeImage(dataUrl, count));
  handle('print', (html: string, pdf: boolean, name: string) => printDocument(String(html), !!pdf, String(name ?? '')));
  handle('openai-status', () => ({ hasKey: !!openaiKey() }));
  handle('openai-key-save', (key: string) => {
    const k = String(key ?? '').trim();
    if (k) store.setAppSecret('openaiKey', encrypt(k));
    else store.deleteAppSecret('openaiKey');
    clearModelCache();
    return { hasKey: !!k };
  });
  // Modellerna i kontot, för valet i inställningarna. Den senaste GPT-modellen är standard.
  handle('openai-models', async () => {
    const key = openaiKey();
    if (!key) throw new Error(t('Lägg in API-nyckeln först.'));
    const models = await listOpenAiModels(store.getSettings().openaiUrl || OPENAI_URL, key);
    const gpt = models.filter((m) => /^(gpt-|chatgpt-|o\d)/i.test(m.id)).sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
    return { latest: pickLatestGpt(models), models: gpt.map((m) => m.id) };
  });
  handle('agent-info', () => agentInfo());
  handle('agent-log', () => store.listAgentLog(50));
  handle('agent-log-clear', () => store.clearAgentLog());
  handle('agent-http-rotate', () => {
    store.saveSettings({ agentHttpToken: newHttpToken() });
    return store.getSettings().agentHttpToken;
  });
  handle('mcp-clients', () => clientStatus(clientEnv()));
  handle('mcp-client-connect', (id: string) => {
    clientChange(String(id), () => connectClient(String(id), clientEnv(), agentSpec()));
    return clientStatus(clientEnv());
  });
  handle('mcp-client-disconnect', (id: string) => {
    clientChange(String(id), () => disconnectClient(String(id), clientEnv()));
    return clientStatus(clientEnv());
  });
  handle('clean-senders', (accountId?: string) => senderList(accountId));
  handle('prefetch', (ids: string[]) => prefetchBodies(Array.isArray(ids) ? ids.slice(0, 30) : []));
  handle('clean-scan', () => scanForCleanup());
  handle('clean-unsubscribe', (address: string, accountId?: string) => unsubscribe(address, accountId));
  handle('clean-bulk', (address: string, action: CleanAction, olderThanDays?: number, accountId?: string) => cleanBulk(address, action, olderThanDays, accountId));
  handle('clean-rule', (address: string, action: CleanAction | null) => {
    setCleanRule(address, action);
    return action ? cleanBulk(address, action) : 0;
  });
  handle('clean-keep', (address: string, keep: boolean) => setCleanKeep(address, keep));
  handle('trusted-senders', () => store.trustedSenders());
  handle('trusted-sender-set', (address: string, trusted: boolean) => setTrustedSender(address, trusted));
  handle('codex-status', (fresh?: boolean) => codexStatus(store.getSettings(), !!fresh));
  handle('ai-task', (sourceId: string, task: 'summary' | 'todo' | 'quick', engine?: AiEngine) => aiTask(sourceId, task, engine));
  handle('account-save', (input: AccountInput) => saveAccount(input));
  handle('account-test', (input: AccountInput) => testAccount(input));
  handle('account-setup', (input: SetupInput) => autoSetup(input));
  handle('calendar-state', () => calendar.states());
  handle('calendar-refresh', (accountId?: string) => calendar.refresh(typeof accountId === 'string' ? accountId : undefined));
  handle('calendar-events', (from: number, to: number) => calendar.events(Number(from), Number(to)));
  handle('calendar-create', (raw: unknown, calendarKey?: string) => calendar.create(eventInput(raw), typeof calendarKey === 'string' ? calendarKey : undefined));
  handle('calendar-delete', (id: string) => calendar.remove(String(id)));
  handle('calendar-update', (id: string, patch: Partial<EventInput>) => calendar.update(String(id), patch && typeof patch === 'object' ? patch : {}));
  handle('account-delete', async (id: string) => {
    await sessions.get(id)?.stop();
    sessions.delete(id);
    statuses.delete(id);
    store.deleteAccount(id);
    notifyChanged();
  });
  handle('account-signature', (accountId: string, signatureId: string) => {
    store.saveAccount(withSignature({ ...account(accountId), signatureId: String(signatureId ?? '') }));
    notifyChanged();
  });
  handle('spark-find', () => {
    const path = sparkExportPath();
    return path ? readSparkExport(path) : null;
  });
  handle('spark-pick', async () => {
    const res = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() ?? mainWindow!, {
      title: t('Välj signaturexporten från Spark'),
      filters: [{ name: t('Spark-signaturer'), extensions: ['json'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return readSparkExport(res.filePaths[0]);
  });
  handle('account-has-password', (id: string) => !!store.getSecret(id)?.length);
  handle('oauth-login', (input: AccountInput) => oauthLogin(input));
  handle('oauth-cancel', () => oauthAbort?.abort());
  handle('oauth-config', () => {
    const s = store.getSettings();
    return { googleClientId: s.googleClientId, microsoftClientId: s.microsoftClientId, hasGoogleSecret: !!store.getAppSecret('googleClientSecret')?.length };
  });
  handle('oauth-config-save', (cfg: { googleClientId: string; microsoftClientId: string; googleClientSecret?: string }) => {
    store.saveSettings({ googleClientId: String(cfg.googleClientId ?? '').trim(), microsoftClientId: String(cfg.microsoftClientId ?? '').trim() });
    if (cfg.googleClientSecret) store.setAppSecret('googleClientSecret', encrypt(cfg.googleClientSecret.trim()));
    accessTokens.clear();
  });
  handle('reconnect', (id?: string) => {
    for (const [sid, s] of sessions) if (!id || sid === id) s.reconnectNow();
  });
  handle('sync-folder', async (accountId: string, path: string) => {
    await sessions.get(accountId)?.syncFolderNow(path);
  });
  handle('settings-save', (raw: Partial<Settings>) => {
    // Nyckeln för HTTP byts bara med agent-http-rotate, så att en gammal kopia i fönstret inte skriver över den.
    const { agentHttpToken: _token, ...patch } = raw ?? {};
    store.saveSettings(patch);
    if ('signatures' in patch) applySignatures();
    if ('openAtLogin' in patch) applyLoginItem();
    if ('theme' in patch) applyTheme();
    if ('language' in patch) {
      const before = getLang();
      applyLanguage();
      if (getLang() !== before) {
        trayMenu();
        for (const w of BrowserWindow.getAllWindows()) w.webContents.reload();
      }
    }
    if ('agentTools' in patch || 'agentHttp' in patch || 'agentHttpPort' in patch) void applyAgentServer();
    notifyChanged();
    return store.getSettings();
  });
  ipcMain.on('ui-lang', (e) => {
    e.returnValue = getLang();
  });
  ipcMain.on('web-contents-id', (e) => {
    e.returnValue = e.sender.id;
  });
  ipcMain.on('close-window', (e) => {
    closingAllowed.add(e.sender.id);
    BrowserWindow.fromWebContents(e.sender)?.close();
  });
  handle('contacts', (query: string) => {
    const own = store.listAccounts().map((a) => a.email);
    return store.contacts(query, own);
  });
  handle('contact-list', (query: string, limit?: number) => {
    const n = Number.isInteger(limit) && limit! > 0 ? Math.min(limit!, 2000) : 400;
    return store.contactList(String(query ?? ''), store.listAccounts().map((a) => a.email), n);
  });
  handle('contact-detail', (address: string) => {
    const d = store.contactDetail(String(address ?? ''));
    // Kommande möten med personen, ur kalenderns cache för de närmaste 60 dagarna.
    const now = Date.now();
    const events = store.cachedEvents(now, now + 60 * 86400_000)
      .filter((ev) => ev.status !== 'cancelled' && (ev.organizer?.email.toLowerCase() === d.address || ev.attendees.some((a) => a.email.toLowerCase() === d.address)))
      .slice(0, 10);
    return { ...d, events };
  });
  handle('file-info', (paths: string[]) =>
    paths
      .filter((p) => typeof p === 'string' && p)
      .map((p) => {
        const st = statSync(p);
        if (!st.isFile()) throw new Error(t('{name} är ingen fil.', { name: basename(p) }));
        return { filename: basename(p), path: p, size: st.size };
      })
  );
  // Filer som dras in utan sökväg på disk (till exempel från en webbläsare) sparas i en tillfällig mapp.
  handle('file-from-data', (name: string, data: Uint8Array) => {
    if (!(data instanceof Uint8Array) || data.byteLength > 50 * 1024 * 1024) throw new Error(t('Filen är för stor att bifoga.'));
    const dir = join(app.getPath('temp'), 'mr-mail', `bifoga-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, safeName(name || 'bilaga'));
    writeFileSync(file, data);
    return { filename: basename(file), path: file, size: data.byteLength };
  });
  handle('invite-state', (id: string) => inviteState(String(id)));
  handle('invite-respond', (id: string, response: InviteResponse, comment?: string) => respondInvite(String(id), response, typeof comment === 'string' ? comment : undefined));
  handle('invite-add', (id: string) => inviteAdd(String(id)));
  handle('discard-draft', (msg: OutgoingMessage) => removeDraftVersions(msg, msg.draftKey ?? '', null));
}

// Städa: avsändare, avregistrering, massflytt och regler.
function senderList(accountId?: string): SenderStat[] {
  const st = store.getSettings();
  const keep = new Set(st.cleanKeep);
  const rules = new Map(st.cleanRules.map((r) => [r.address, r.action]));
  return store
    .senderStats(store.listAccounts().map((a) => a.email), 1000, accountId || undefined)
    .filter((x) => !keep.has(x.address))
    .map((x) => ({ ...x, category: categorize(x), rule: rules.get(x.address), unsubscribed: st.unsubscribed[x.address] }));
}

let scanning = false;
async function scanForCleanup(): Promise<number> {
  if (scanning) throw new Error(t('Skanningen pågår redan.'));
  scanning = true;
  try {
    const targets: { s: AccountSession; path: string }[] = [];
    for (const s of sessions.values()) {
      for (const role of ['inbox', 'archive'] as FolderRole[]) {
        const path = s.rolePath(role);
        if (path) targets.push({ s, path });
      }
    }
    let total = 0;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      total += await t.s
        .scanFolder(t.path, 2000, (done, of) => broadcast('clean-progress', { step: i + 1, steps: targets.length, done, of }))
        .catch((e) => (log(`städa: ${e?.message}`), 0));
      notifyChanged();
    }
    store.saveSettings({ cleanScanned: true });
    return total;
  } finally {
    scanning = false;
    broadcast('clean-progress', null);
  }
}

async function unsubscribe(address: string, accountId?: string): Promise<{ method: 'oneclick' | 'mailto' | 'browser' }> {
  const addr = address.toLowerCase().trim();
  const u = store.latestUnsubscribe(addr, accountId) ?? store.latestUnsubscribe(addr);
  if (!u) {
    // Ingen List-Unsubscribe: leta efter en avregistreringslänk i det senaste mejlet.
    const latest = store.db.prepare('SELECT id FROM messages WHERE from_addr = ? COLLATE NOCASE ORDER BY date DESC LIMIT 1').get(addr) as { id: string } | undefined;
    const body = latest ? await loadBody(latest.id).catch(() => null) : null;
    const link = body?.html ? findUnsubscribeLink(body.html) : null;
    if (!link) throw new Error(t('Hittar ingen avregistreringslänk i mejlen. Välj Radera alltid i menyn i stället.'));
    await shell.openExternal(link);
    const st0 = store.getSettings();
    store.saveSettings({ unsubscribed: { ...st0.unsubscribed, [addr]: Date.now() } });
    notifyChanged();
    return { method: 'browser' };
  }
  const unsub = parseUnsubscribe(u.header);
  let method: 'oneclick' | 'mailto' | 'browser' | null = null;
  const oneClickUrl = unsub.https ?? (process.env.MRMAIL_TEST_HTTP_UNSUB ? unsub.http : undefined);
  if (oneClickUrl && u.oneClick) {
    const res = await fetch(oneClickUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      signal: AbortSignal.timeout(15000)
    }).catch(() => null);
    if (res && res.ok) method = 'oneclick';
  }
  if (!method && unsub.mailto && sessions.has(u.accountId)) {
    await sendMessage({ accountId: u.accountId, to: unsub.mailto.to, cc: '', bcc: '', subject: unsub.mailto.subject, text: unsub.mailto.body, attachments: [] });
    method = 'mailto';
  }
  if (!method) {
    const url = unsub.https ?? unsub.http;
    if (!url) throw new Error(t('Avregistreringen gick inte att göra automatiskt.'));
    await shell.openExternal(url);
    method = 'browser';
  }
  const st = store.getSettings();
  store.saveSettings({ unsubscribed: { ...st.unsubscribed, [addr]: Date.now() } });
  log(`städa: avregistrerad (${method})`);
  notifyChanged();
  return { method };
}

// Flyttar alla mejl från en avsändare till arkivet eller papperskorgen, i alla konton.
async function cleanBulk(address: string, action: CleanAction, olderThanDays?: number, accountId?: string): Promise<number> {
  const addr = address.toLowerCase().trim();
  const before = olderThanDays && olderThanDays > 0 ? Date.now() - olderThanDays * 86400000 : undefined;
  let moved = 0;
  for (const [sid, s] of sessions) {
    if (accountId && sid !== accountId) continue;
    const dest = s.rolePath(action);
    if (!dest) continue;
    const sources = (action === 'archive' ? ['inbox'] : ['inbox', 'archive']) as FolderRole[];
    let any = false;
    for (const role of sources) {
      const path = s.rolePath(role);
      if (!path || path === dest) continue;
      const n = await s.moveFrom(path, addr, dest, before);
      if (n) {
        moved += n;
        any = true;
        await s.syncFolderNow(path).catch(() => undefined);
      }
    }
    if (any) void s.syncFolderNow(dest).catch(() => undefined);
  }
  notifyChanged();
  return moved;
}

function setCleanRule(address: string, action: CleanAction | null) {
  const addr = address.toLowerCase().trim();
  const rules = store.getSettings().cleanRules.filter((r) => r.address !== addr);
  if (action) rules.push({ address: addr, action });
  store.saveSettings({ cleanRules: rules });
  notifyChanged();
}

function setCleanKeep(address: string, keep: boolean) {
  const addr = address.toLowerCase().trim();
  const list = store.getSettings().cleanKeep.filter((a) => a !== addr);
  if (keep) list.push(addr);
  store.saveSettings({ cleanKeep: list });
  notifyChanged();
}

// Regler körs på nya mejl i inkorgen.
function applyCleanRules(_accountId: string, ids: string[]) {
  const rules = store.getSettings().cleanRules;
  if (!rules.length) return;
  const byAddr = new Map(rules.map((r) => [r.address, r.action]));
  for (const id of ids) {
    const m = store.getMessage(id);
    if (m?.messageId && restored.has(m.messageId)) continue;
    const action = m && byAddr.get(m.from.address.toLowerCase());
    if (action) void moveTo(id, action).catch((e) => log(`regel: ${e?.message}`));
  }
}

// Utkorg: ångra skicka och skicka senare. Ligger i databasen så att schemalagda mejl klarar en omstart.
const outboxTimers = new Map<string, NodeJS.Timeout>();
const outboxSending = new Set<string>();

function outboxInfo(): OutboxInfo[] {
  return store.listOutbox().map((i) => ({ id: i.id, due: i.due, kind: i.kind, subject: i.msg.subject, to: i.msg.to, accountId: i.msg.accountId }));
}

function broadcastOutbox() {
  broadcast('outbox', outboxInfo());
}

function scheduleOutbox(item: OutboxItem) {
  const t = outboxTimers.get(item.id);
  if (t) clearTimeout(t);
  outboxTimers.delete(item.id);
  const ms = item.due - Date.now();
  // Långt fram i tiden sköts av kontrollen var 30:e sekund.
  if (ms < 6 * 3600_000) outboxTimers.set(item.id, setTimeout(() => void flushOutbox(item.id), Math.max(0, ms)));
}

async function queueSend(msg: OutgoingMessage, at?: number): Promise<{ queued: boolean; id?: string; due?: number }> {
  const undo = Math.max(0, Math.min(60, store.getSettings().undoSendSeconds || 0));
  const later = !!at && at > Date.now() + 30_000;
  if (!later && !undo) {
    await sendMessage(msg);
    return { queued: false };
  }
  account(msg.accountId);
  const item: OutboxItem = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    due: later ? at! : Date.now() + undo * 1000,
    kind: later ? 'later' : 'undo',
    created: Date.now(),
    msg
  };
  store.addOutbox(item);
  // Utkastet behövs inte medan mejlet väntar. Ångras det sparas ett nytt.
  if (later) await removeDraftVersions(msg, msg.draftKey ?? '', null).catch((e) => log(`utkorg: ${e?.message}`));
  scheduleOutbox(item);
  broadcastOutbox();
  return { queued: true, id: item.id, due: item.due };
}

async function flushOutbox(id: string) {
  const timer = outboxTimers.get(id);
  if (timer) clearTimeout(timer);
  outboxTimers.delete(id);
  const item = store.getOutbox(id);
  if (!item || outboxSending.has(id)) return;
  outboxSending.add(id);
  broadcastOutbox();
  try {
    await sendMessage(item.msg);
    store.removeOutbox(id);
    if (item.kind === 'later' && Notification.isSupported() && store.getSettings().notifications) {
      new Notification({ title: t('Skickat'), body: `${item.msg.subject || t('(inget ämne)')}\n${t('Till: {to}', { to: item.msg.to })}`.slice(0, 240) }).show();
    }
  } catch (e: any) {
    // Går det inte att skicka nu, prova igen om en stund. Efter en dag läggs mejlet i Utkast.
    log(`utkorg: ${e?.message}`);
    if (Date.now() - item.due > 86400_000) {
      store.removeOutbox(id);
      await sendMessage({ ...item.msg, draftKey: undefined }, true).catch(() => undefined);
      if (Notification.isSupported()) new Notification({ title: t('Kunde inte skicka'), body: t('{subject}: {error}. Mejlet ligger i Utkast.', { subject: item.msg.subject, error: e?.message }).slice(0, 240) }).show();
    } else {
      store.addOutbox({ ...item, due: Date.now() + 60_000 });
      scheduleOutbox({ ...item, due: Date.now() + 60_000 });
    }
  } finally {
    outboxSending.delete(id);
    broadcastOutbox();
  }
}

// Ångra eller ändra: mejlet tas ur utkorgen, sparas som utkast och öppnas igen.
async function editOutbox(id: string) {
  if (outboxSending.has(id)) throw new Error(t('Mejlet skickas redan.'));
  const item = store.getOutbox(id);
  if (!item) throw new Error(t('Mejlet är redan skickat.'));
  const timer = outboxTimers.get(id);
  if (timer) clearTimeout(timer);
  outboxTimers.delete(id);
  store.removeOutbox(id);
  broadcastOutbox();
  const draftId = await agentHost.saveDraft(item.msg);
  if (draftId) openCompose({ mode: 'draft', accountId: item.msg.accountId, sourceId: draftId });
  else throw new Error(t('Mejlet ligger i Utkast.'));
}

function checkOutbox() {
  for (const item of store.listOutbox()) {
    if (item.due <= Date.now()) void flushOutbox(item.id);
    else if (!outboxTimers.has(item.id)) scheduleOutbox(item);
  }
}

// Hur AI-verktygen startar MCP-servern: med appens exe som Node i installerad app, annars med node.
function agentSpec(): { command: string; args: string[]; env: Record<string, string> } {
  const packaged = app.isPackaged;
  const script = packaged ? join(process.resourcesPath, 'mr-mail-mcp.cjs') : join(here, '../mcp/mr-mail-mcp.cjs');
  return { command: packaged ? process.execPath : 'node', args: [script], env: packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
}

// AI-verktygens inställningsfiler. MRMAIL_CLIENT_HOME pekar om allt till en testmapp.
function clientEnv(): McpEnv {
  const base = process.env.MRMAIL_CLIENT_HOME;
  if (base) return { home: join(base, 'home'), appData: join(base, 'roaming'), localAppData: join(base, 'local') };
  return envFromProcess();
}

function clientChange(id: string, fn: () => void) {
  try {
    fn();
  } catch (e: any) {
    const name = clientStatus(clientEnv()).find((c) => c.id === id)?.name ?? id;
    if (e instanceof McpClientError && e.code === 'not-installed') throw new Error(t('{name} är inte installerat.', { name }));
    if (e instanceof McpClientError && e.code === 'unreadable') throw new Error(t('Filen {file} gick inte att läsa och har inte ändrats.', { file: e.file ?? '' }));
    throw new Error(t('Det gick inte att ändra inställningarna för {name}: {error}', { name, error: e?.message ?? String(e) }));
  }
}

// AI-agenter via MCP. Bryggan startas när inställningen är på och stängs när den slås av.
let agentServer: { stop: () => void } | null = null;
let agentStarting = false;
let agentHttp: { port: number; stop: () => void } | null = null;
let agentHttpError = '';

function agentInfo() {
  const s = store.getSettings();
  return {
    running: !!agentServer,
    ...agentSpec(),
    http: {
      on: s.agentTools && s.agentHttp,
      running: !!agentHttp,
      url: `http://127.0.0.1:${agentHttp?.port ?? s.agentHttpPort}/mcp`,
      error: agentHttpError
    }
  };
}

function httpPort(p: number): number {
  return Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : 7337;
}

const agentHost: AgentHost = {
  attachment: async (id, index) => {
    const a = await attachment(id, index);
    return { filename: a.filename ?? '', contentType: a.contentType ?? '', content: a.content };
  },
  downloadsDir: () => app.getPath('downloads'),
  inviteAnswer: (id) => inviteState(id)?.response ?? null,
  calendars: () => calendar.calendars(),
  calendarEvents: (from, to, f) => calendar.events(from, to, { accountIds: f.accountId ? [f.accountId] : undefined, calendar: f.calendar, query: f.query }),
  freeSlots: (o) => calendar.freeSlots({ ...o, accountIds: o.accountId ? [o.accountId] : undefined }),
  createEvent: (input, cal, accountId) => calendar.create(eventInput(input), cal, accountId),
  updateEvent: (id, patch) => calendar.update(id, patch),
  deleteEvent: (id) => calendar.remove(id),
  getEvent: (id) => calendar.getEvent(id),
  respondInvite: (id, response, comment) => respondInvite(id, response, comment),
  contacts: (query) => store.contacts(query, store.listAccounts().map((a) => a.email), 15),
  sendLater: async (msg, at) => {
    await queueSend(msg, at);
  },
  createFolder: async (accountId, name, parent) => {
    const path = await session(accountId).createFolder(name, parent);
    notifyChanged();
    return path;
  },
  remind: (id, due) => (due === null ? clearRemind(id) : remind(id, 'snooze', due)),
  tempDir: () => join(app.getPath('temp'), 'mr-mail', 'bilagor'),
  accounts: () => store.listAccounts().map(withSignature),
  statuses: getStatuses,
  settings: () => store.getSettings(),
  folders: () => store.listFolders(),
  rolePath: (accountId, role) => sessions.get(accountId)?.rolePath(role) ?? null,
  listFolder: (accountId, path, limit) => store.listFolderMessages(accountId, path, limit),
  listUnified: (role, limit) => store.listRoleMessages(role, limit),
  async search(query, limit) {
    const q = parseSearch(query);
    if (isEmptyQuery(q)) return [];
    const local = store.search(q, limit);
    const remote = await searchServer(q).catch(() => []);
    const seen = new Set<string>();
    return [...local, ...remote]
      .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
      .sort((a, b) => b.date - a.date)
      .slice(0, limit);
  },
  getMessage: (id) => store.getMessage(id),
  open: (id, markSeen) => openMessage(id, markSeen),
  thread: (id) => store.thread(id),
  send: async (msg) => {
    await sendMessage(msg);
  },
  async saveDraft(msg) {
    const key = await sendMessage(msg, true);
    const v = key ? draftVersions.get(key)?.[0] : undefined;
    if (!v) return null;
    await sessions.get(v.accountId)?.syncFolderNow(v.path).catch(() => undefined);
    return store.messageIdFor(v.accountId, v.path, v.uid);
  },
  setFlag: (id, flag, value) => setFlag(id, flag, value),
  moveToRole: async (id, role) => {
    await moveTo(id, role);
  },
  moveToPath: async (id, path) => {
    await moveToPath(id, path);
  },
  showMessage(id) {
    showMain();
    const send = () => mainWindow?.webContents.send('open-message', id);
    if (mainWindow?.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', send);
    else send();
  },
  openDraft(id) {
    const m = store.getMessage(id);
    if (m) openCompose({ mode: 'draft', accountId: m.accountId, sourceId: id });
  },
  senders: (accountId) => senderList(accountId),
  unsubscribe: (address) => unsubscribe(address),
  cleanBulk: (address, action, days, accountId) => cleanBulk(address, action, days, accountId),
  setRule: (address, action) => setCleanRule(address, action),
  notifySent(subject, to) {
    log('mcp: mejl skickat');
    if (store.getSettings().notifications && Notification.isSupported()) {
      new Notification({ title: t('Skickat åt dig'), body: `${subject || t('(inget ämne)')}\n${t('Till: {to}', { to })}`.slice(0, 240) }).show();
    }
  }
};
const agentCall = createAgent(agentHost);

// Frågor om lov visas en i taget, med huvudfönstret framme.
let askChain: Promise<unknown> = Promise.resolve();
function askAgentPermission(req: AskRequest): Promise<boolean> {
  const run = askChain.then(() => showAgentAsk(req));
  askChain = run.catch(() => undefined);
  return run;
}

async function showAgentAsk(req: AskRequest): Promise<boolean> {
  // Testkrok för e2e: svara direkt i stället för att visa dialogen.
  const test = process.env.MRMAIL_TEST_ASK;
  if (test === 'allow' || test === 'deny') {
    (globalThis as any).__mrmailAsked = [...((globalThis as any).__mrmailAsked ?? []), req.message];
    return test === 'allow';
  }
  const hidden = !mainWindow || !mainWindow.isVisible() || mainWindow.isMinimized();
  showMain();
  const win = mainWindow;
  if (!win) return false;
  if (hidden && Notification.isSupported()) new Notification({ title: t('{app} behöver ditt svar', { app: APP_NAME }), body: req.message.slice(0, 240) }).show();
  win.moveTop();
  win.flashFrame(true);
  try {
    const res = await dialog.showMessageBox(win, {
      type: 'question',
      title: APP_NAME,
      message: req.message,
      detail: req.detail || undefined,
      buttons: [t('Tillåt'), t('Neka')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      // Svarar ingen inom tre minuter räknas det som nej, så att verktyget inte väntar för evigt.
      signal: AbortSignal.timeout(170_000)
    });
    return res.response === 0;
  } finally {
    win.flashFrame(false);
  }
}

const agentGuarded = guardAgent(agentCall, {
  permissions: () => store.getSettings().agentPermissions,
  ask: askAgentPermission,
  log(entry) {
    store.addAgentLog(entry);
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('agent-log');
  },
  events(id) {
    const ev = calendar.getEvent(id);
    return ev ? { title: ev.title, attendees: ev.attendees.length, isOrganizer: ev.isOrganizer, start: ev.start } : null;
  },
  lookup(id) {
    const m = store.getMessage(id);
    return m ? { subject: m.subject, from: formatAddress(m.from), to: m.to.map(formatAddress).join(', ') } : null;
  }
});

// Fråga Mr Mail: chatten i appen. Samtalet finns bara i minnet, per fönster och chatt.
const chats = new Map<string, { history: ApiMessage[]; abort?: AbortController }>();

async function chatEndpoint(): Promise<ChatEndpoint> {
  const s = store.getSettings();
  if (!chatSupported(s.aiEngine)) throw new Error(t('Chatten kräver ChatGPT med API-nyckel, en lokal modell eller en egen server.'));
  if (s.aiEngine === 'openai') {
    const key = openaiKey();
    if (!key) throw new Error(t('Lägg in din API-nyckel från OpenAI under Inställningar, AI-hjälp.'));
    return { url: s.openaiUrl || OPENAI_URL, key, model: await resolveOpenAiModel(s, key), label: 'ChatGPT', openai: true };
  }
  const local = s.aiEngine === 'local';
  const url = local ? s.localUrl : s.sparkUrl;
  if (!url.trim()) throw new Error(t('Ange serverns adress under Inställningar, AI-hjälp.'));
  return { url, key: local ? s.localKey : s.sparkKey, model: local ? s.localModel : s.sparkModel, label: local ? t('Datorns modell') : t('Egen server'), openai: false };
}

function senderName(id: string): string | null {
  const m = store.getMessage(id);
  return m ? m.from.name || m.from.address || null : null;
}

async function chatSend(sender: WebContents, chatId: string, text: string): Promise<ChatAnswer> {
  const ep = await chatEndpoint();
  const system: ApiMessage = { role: 'system', content: chatSystemPrompt(new Date(), localZoneName()) };
  let chat = chats.get(chatId);
  if (!chat) {
    chat = { history: [system] };
    chats.set(chatId, chat);
    while (chats.size > 12) chats.delete(chats.keys().next().value!);
  } else chat.history[0] = system;
  chat.abort?.abort();
  const ctrl = new AbortController();
  chat.abort = ctrl;
  const before = chat.history.length;
  const steps: ChatStep[] = [];
  chat.history.push({ role: 'user', content: text.slice(0, 8000) });
  let answer: string;
  try {
    answer = await runChatLoop({
      history: chat.history,
      complete: openAiCompleter(ep, AGENT_TOOLS, ctrl.signal),
      call: (tool, args) => agentGuarded(tool, args, { client: APP_NAME }),
      signal: ctrl.signal,
      onStep(s) {
        const step: ChatStep = { id: s.id, label: stepLabel(s.tool, s.args, senderName), done: s.done, ok: s.ok };
        const i = steps.findIndex((x) => x.id === step.id);
        if (i >= 0) steps[i] = step;
        else steps.push(step);
        if (!sender.isDestroyed()) sender.send('chat-step', chatId, step);
      }
    });
  } catch (e) {
    // Ett avbrutet eller misslyckat varv tas bort, så att nästa fråga börjar från ett helt samtal.
    chat.history.length = before;
    throw e;
  } finally {
    if (chat.abort === ctrl) chat.abort = undefined;
  }
  compactHistory(chat.history);
  if (!answer) throw new Error(t('{label} gav ett tomt svar.', { label: ep.label }));
  const refs: ChatRefs = { mail: {}, event: {} };
  for (const l of findRefLinks(answer)) {
    if (l.kind === 'mail' && store.getMessage(l.id)) refs.mail[l.id] = l.label;
    else if (l.kind === 'event' && calendar.getEvent(l.id)) refs.event[l.id] = l.label;
  }
  return { text: answer, refs, steps };
}

function registerChatIpc() {
  ipcMain.handle('chat-send', async (e, chatId: string, text: string) => {
    try {
      return { ok: true, value: await chatSend(e.sender, String(chatId), String(text ?? '')) };
    } catch (err: any) {
      // Felet loggas utan text, eftersom svaret från servern kan citera mejlen.
      if (!(err instanceof ChatAborted)) log('chat-send: misslyckades');
      return { ok: false, error: err instanceof ChatAborted ? t('Avbrutet.') : (err?.message ?? String(err)) };
    }
  });
  handle('chat-cancel', (chatId: string) => chats.get(String(chatId))?.abort?.abort());
  handle('chat-reset', (chatId: string) => {
    const chat = chats.get(String(chatId));
    chat?.abort?.abort();
    chats.delete(String(chatId));
  });
}

let agentAgain = false;
async function applyAgentServer() {
  if (agentStarting) {
    agentAgain = true;
    return;
  }
  agentStarting = true;
  try {
    const s = store.getSettings();
    if (!s.agentTools && agentServer) {
      agentServer.stop();
      agentServer = null;
    } else if (s.agentTools && !agentServer) {
      try {
        agentServer = await startAgentServer(app.getPath('userData'), agentGuarded, log);
      } catch (e: any) {
        log(`mcp: kunde inte starta: ${e?.message}`);
      }
    }
    const wantHttp = s.agentTools && s.agentHttp;
    const port = httpPort(s.agentHttpPort);
    if (agentHttp && (!wantHttp || agentHttp.port !== port)) {
      agentHttp.stop();
      agentHttp = null;
    }
    agentHttpError = '';
    if (wantHttp && !agentHttp) {
      if (!store.getSettings().agentHttpToken) store.saveSettings({ agentHttpToken: newHttpToken() });
      try {
        agentHttp = await startAgentHttp({ port, token: () => store.getSettings().agentHttpToken, call: agentGuarded, log });
      } catch (e: any) {
        agentHttpError = e?.code === 'EADDRINUSE' ? t('Porten {port} används redan av ett annat program.', { port }) : String(e?.message ?? e);
        log(`mcp http: kunde inte starta: ${e?.message}`);
      }
    }
  } finally {
    agentStarting = false;
    if (agentAgain) {
      agentAgain = false;
      void applyAgentServer();
    }
  }
}

app.on('second-instance', () => showMain());

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  mkdirSync(app.getPath('userData'), { recursive: true });
  store = new Store(join(app.getPath('userData'), DB_FILE));
  if (!store.listAccounts().length && !process.env.MRMAIL_NO_SEED) {
    for (const a of defaultAccounts(process.env.MRMAIL_SEED)) store.saveAccount(a);
  }
  migrateOldSignatures();
  calendar.load();
  applyLanguage();
  applyTheme();
  registerIpc();
  registerChatIpc();
  createMainWindow();
  createTray();
  applyLoginItem();
  for (const a of store.listAccounts()) startSession(a);
  void applyAgentServer();
  // Kalendern uppdateras strax efter start och var femtonde minut.
  setTimeout(() => void calendar.refresh().catch(() => undefined), 6000);
  setInterval(() => void calendar.refresh().catch(() => undefined), 15 * 60_000);
  setInterval(() => {
    checkReminders();
    checkOutbox();
  }, 30_000);
  setTimeout(checkOutbox, 5000);
  setTimeout(checkReminders, 3000);
  setTimeout(() => void checkUpdate(), 15_000);
  setInterval(() => void checkUpdate(), 3 * 3600_000);
  // Efter vila är anslutningarna ofta döda utan att det märks. Anslut på nytt när datorn vaknar.
  powerMonitor.on('resume', () => {
    setTimeout(() => {
      for (const a of store.listAccounts()) startSession(a);
    }, 3000);
  });
});

app.on('before-quit', () => {
  quitting = true;
  agentServer?.stop();
  agentServer = null;
  agentHttp?.stop();
  agentHttp = null;
});

app.on('window-all-closed', async () => {
  await Promise.all([...sessions.values()].map((s) => s.stop()));
  store?.close();
  app.quit();
});
