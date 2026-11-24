import type { CleanRule } from './cleanup';
import type { IcsEvent } from './ics';
import type { RemoteImagePolicy } from './trust';

export type Security = 'ssl' | 'starttls' | 'none';

export interface ServerConfig {
  host: string;
  port: number;
  security: Security;
}

export interface AccountConfig {
  id: string;
  name: string;
  email: string;
  displayName: string;
  provider: ProviderId;
  imap: ServerConfig;
  smtp: ServerConfig;
  username: string;
  color: string;
  allowInsecureTls?: boolean;
  // Kontots signatur i HTML. Räknas fram ur signaturbiblioteket via signatureId.
  signature?: string;
  // Vald signatur i biblioteket, tom sträng betyder ingen. Saknas på konton från före 0.3.
  signatureId?: string;
  // Inloggning med OAuth (Gmail, Outlook) i stället för lösenord.
  auth?: 'password' | 'oauth';
  // Aviseringar för nya mejl i just det här kontot.
  notify?: boolean;
  // Visa kontots kalender. Saknas betyder på när kontot har en kalender.
  calendar?: boolean;
  // Egen CalDAV-adress, när den inte hittas automatiskt.
  caldavUrl?: string;
}

export type ProviderId = 'gmail' | 'icloud' | 'outlook' | 'simply' | 'manual';

export type AccountState = 'needs-password' | 'connecting' | 'online' | 'syncing' | 'error' | 'offline';

export interface AccountStatus {
  id: string;
  state: AccountState;
  error?: string;
  unread: number;
  lastSync?: number;
}

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'archive' | 'junk' | 'other';

export interface Folder {
  accountId: string;
  path: string;
  name: string;
  role: FolderRole;
  parent: string;
  unread: number;
  statusUnread?: number;
}

export interface Address {
  name: string;
  address: string;
}

export interface MessageSummary {
  id: string;
  accountId: string;
  folder: string;
  uid: number;
  subject: string;
  from: Address;
  to: Address[];
  cc: Address[];
  date: number;
  preview: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  hasAttachments: boolean;
  messageId: string;
  labels?: string[];
  threadId?: string;
  // Antal mejl i konversationen när listan visas som trådar.
  threadCount?: number;
  // Smart inkorg: personligt, nyhetsbrev, aviseringar, kvitton eller sociala.
  category?: 'personal' | 'newsletter' | 'notification' | 'receipt' | 'social';
  // Satt i vyn Påminnelser.
  reminder?: { kind: ReminderKind; due: number; state: 'waiting' | 'due' };
}

export type ReminderKind = 'snooze' | 'followup';

// Sparad text att infoga i ett mejl.
export interface Template {
  id: string;
  name: string;
  text: string;
}

export interface Reminder {
  accountId: string;
  key: string;
  kind: ReminderKind;
  due: number;
  created: number;
  state: 'waiting' | 'due';
  subject: string;
  // Id för mejlet när påminnelsen sattes.
  messageId: string;
}

export interface SearchQuery {
  text: string;
  from?: string;
  to?: string;
  subject?: string;
  hasAttachment?: boolean;
  unread?: boolean;
  flagged?: boolean;
  after?: string;
  before?: string;
}

export interface AttachmentInfo {
  index: number;
  filename: string;
  contentType: string;
  size: number;
  cid?: string;
  inline: boolean;
}

export interface MessageBody {
  id: string;
  html: string | null;
  text: string;
  attachments: AttachmentInfo[];
  inlineImages: Record<string, string>;
  references: string[];
  inReplyTo: string | null;
  replyTo: Address[];
  hasRemoteImages: boolean;
  // Kalenderinbjudan i mejlet (text/calendar eller .ics). null om ingen finns; saknas i äldre cache.
  invite?: Invitation | null;
}

export interface Invitation {
  method: string;
  event: IcsEvent;
  // Antal händelser i filen, till exempel undantag i en serie.
  count: number;
  // Kalenderfilen som den kom, när den är rimligt stor.
  ics: string | null;
}

export type InviteResponse = 'accept' | 'tentative' | 'decline';

export interface FullMessage extends MessageSummary {
  body: MessageBody;
  // Om bilder från internet får visas direkt. Sätts när mejlet öppnas, sparas inte.
  remoteImages?: RemoteImagePolicy;
}

export interface TrustedSender {
  address: string;
  added: number;
}

export type MailboxSelection =
  | { kind: 'unified'; role: 'inbox' }
  | { kind: 'folder'; accountId: string; role: FolderRole; path: string }
  | { kind: 'label'; accountId: string; label: string }
  | { kind: 'reminders' }
  | { kind: 'search'; search: SearchQuery };

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward' | 'draft';

export interface ComposeInit {
  mode: ComposeMode;
  accountId: string;
  sourceId?: string;
  suggest?: boolean;
  to?: string;
  // Text att börja svaret med, till exempel ett valt snabbsvar.
  prefill?: string;
}

export interface OutgoingAttachment {
  filename: string;
  path: string;
  size: number;
}

export interface OutgoingMessage {
  accountId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  attachments: OutgoingAttachment[];
  forwardOf?: string;
  html?: string;
  // Nyckel för fönstrets utkast, så att varje ny version ersätter den förra på servern.
  draftKey?: string;
  // Utkastet i Utkast-mappen som fönstret öppnades från, tas bort när en ny version sparas.
  draftOf?: string;
  // Påminn om ingen svarat inom så här många dagar.
  followUpDays?: number;
}

// Mejl som väntar på att skickas: ångra skicka (några sekunder) eller skicka senare.
export interface OutboxItem {
  id: string;
  due: number;
  kind: 'undo' | 'later';
  created: number;
  msg: OutgoingMessage;
}

export interface OutboxInfo {
  id: string;
  due: number;
  kind: 'undo' | 'later';
  subject: string;
  to: string;
  accountId: string;
}

export interface ComposeDraft {
  accountId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  html: string;
  quote: string;
  quoteHtml: string;
  inReplyTo?: string;
  references?: string[];
  forwardAttachments: AttachmentInfo[];
  forwardOf?: string;
  draftOf?: string;
}

export interface Contact {
  name: string;
  address: string;
  count: number;
}

// En rad i Kontakter: antal mejl åt båda hållen och senaste kontakten.
export interface ContactRow extends Contact {
  last: number;
}

export interface ContactDetail {
  address: string;
  name: string;
  received: number;
  sent: number;
  last: number;
  recent: MessageSummary[];
  events: import('./calendar').CalendarEvent[];
}

export interface Signature {
  id: string;
  name: string;
  html: string;
  // Importerad från Spark, så att samma signatur inte läggs in två gånger.
  sparkId?: string;
}

export type AiEngine = 'spark' | 'local' | 'claude' | 'openai' | 'codex';
export type AiTask = 'reply' | 'summary' | 'todo' | 'quick';

export type ThemeChoice = 'system' | 'light' | 'dark';

export type AgentPermission = 'allow' | 'ask' | 'never';

export interface AgentPermissions {
  send: AgentPermission;
  delete: AgentPermission;
  unsubscribe: AgentPermission;
}

// Ett anrop från ett AI-verktyg, för listan Aktivitet i inställningarna.
export interface AgentLogEntry {
  id: number;
  at: number;
  tool: string;
  summary: string;
  ok: boolean;
  error: string;
  client: string;
}

export interface Settings {
  // Ljust, mörkt eller som Windows.
  theme: ThemeChoice;
  aiEngine: AiEngine;
  sparkUrl: string;
  sparkModel: string;
  sparkKey: string;
  claudePath: string;
  localUrl: string;
  localModel: string;
  localKey: string;
  tone: string;
  notifications: boolean;
  syncLimit: number;
  threads: boolean;
  openAtLogin: boolean;
  closeToTray: boolean;
  googleClientId: string;
  microsoftClientId: string;
  // ChatGPT via OpenAI:s API. Tom modell betyder senaste GPT-modellen.
  openaiUrl: string;
  openaiModel: string;
  // ChatGPT via abonnemanget och Codex CLI. Tom sökväg letas upp på PATH.
  codexPath: string;
  codexModel: string;
  signatures: Signature[];
  // Har importen från Spark erbjudits vid start.
  sparkOffered: boolean;
  // AI-verktyg (Claude Code, Zed) får läsa, skriva och skicka via MCP.
  agentTools: boolean;
  // MCP över HTTP på 127.0.0.1 för verktyg som bara tar en adress. Nyckeln skapas en gång.
  agentHttp: boolean;
  agentHttpPort: number;
  agentHttpToken: string;
  // Vad AI-verktygen får göra utan att fråga: skicka, radera och avregistrera eller städa.
  agentPermissions: AgentPermissions;
  // Städa: regler per avsändare, avsändare som ska behållas och när avregistrering gjordes.
  cleanRules: CleanRule[];
  cleanKeep: string[];
  unsubscribed: Record<string, number>;
  // Har Städa gått igenom mejlen en första gång.
  cleanScanned: boolean;
  smartInbox: boolean;
  // Språk i appen: auto följer Windows.
  language: 'auto' | 'sv' | 'en';
  templates: Template[];
  updateDir: string;
  // Sekunder att kunna ångra ett skickat mejl, 0 skickar direkt.
  undoSendSeconds: number;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
  sourceId: string;
  accountId: string;
  draft?: string;
  history: ChatTurn[];
  instruction?: string;
  engine?: AiEngine;
}

export interface AiContextInfo {
  thread: number;
  earlier: number;
  person: string;
}

export interface AiResult {
  ok: boolean;
  text?: string;
  error?: string;
  engine: AiEngine;
  ms: number;
  // Modellen som svarade, när den valts automatiskt.
  model?: string;
  context?: AiContextInfo;
  // Snabbsvar: tre korta förslag.
  options?: string[];
}

export interface AccountInput {
  config: AccountConfig;
  password?: string;
  // Inloggning från kalendern: be även om kalenderbehörighet (Microsoft Graph).
  calendar?: boolean;
}

export interface SetupInput {
  email: string;
  password: string;
  displayName?: string;
  // Vald leverantör i Lägg till konto. Utan den letas servrarna upp.
  provider?: ProviderId;
  // Ett befintligt konto som ska få lösenord, till exempel ett förifyllt.
  accountId?: string;
}

export type SetupOutcome =
  | { ok: true; account: AccountConfig }
  | { ok: false; reason: 'invalid' | 'auth' | 'smtp' | 'notfound'; message: string; provider: ProviderId; config?: AccountConfig };

export interface TestResult {
  ok: boolean;
  imap?: string;
  smtp?: string;
}
