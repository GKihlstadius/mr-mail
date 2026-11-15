import type { CleanAction, SenderStat } from '../shared/cleanup';
import type {
  AccountConfig,
  AgentLogEntry,
  OutboxInfo,
  AccountInput,
  AccountStatus,
  AiEngine,
  AiRequest,
  AiResult,
  ComposeDraft,
  ComposeInit,
  Contact,
  ContactDetail,
  ContactRow,
  Folder,
  FolderRole,
  FullMessage,
  InviteResponse,
  MailboxSelection,
  MessageSummary,
  OutgoingAttachment,
  OutgoingMessage,
  Reminder,
  ReminderKind,
  SearchQuery,
  Settings,
  SetupInput,
  SetupOutcome,
  TestResult
} from '../shared/types';
import type { SparkSignature } from '../shared/signatures';
import type { CalendarAccountState, CalendarEvent, EventInput } from '../shared/calendar';
import type { ChatAnswer } from '../shared/chat';

export interface SparkExport {
  path: string;
  signatures: SparkSignature[];
}

export interface OAuthConfig {
  googleClientId: string;
  microsoftClientId: string;
  hasGoogleSecret: boolean;
}

export interface AgentInfo {
  running: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
  http: { on: boolean; running: boolean; url: string; error: string };
}

export interface McpClientInfo {
  id: string;
  name: string;
  installed: boolean;
  connected: boolean;
  managed: boolean;
  path: string;
}

export interface AppState {
  accounts: AccountConfig[];
  statuses: AccountStatus[];
  folders: Folder[];
  labels: { accountId: string; label: string }[];
  reminders: Reminder[];
  settings: Settings;
  dark: boolean;
  encryption: boolean;
}

interface Api {
  lang: string;
  state(): Promise<AppState>;
  list(sel: MailboxSelection, limit?: number): Promise<{ items: MessageSummary[]; more: boolean }>;
  thread(id: string): Promise<MessageSummary[]>;
  loadOlder(sel: MailboxSelection): Promise<number>;
  searchServer(q: SearchQuery): Promise<MessageSummary[]>;
  open(id: string): Promise<FullMessage>;
  flag(id: string, flag: 'seen' | 'flagged', value: boolean): Promise<void>;
  move(id: string, role: FolderRole): Promise<void>;
  moveTo(id: string, accountId: string, path: string): Promise<void>;
  moveMany(ids: string[], target: { role?: FolderRole; path?: string }): Promise<{ moved: number; undoId?: string; error?: string }>;
  undoMove(undoId?: string): Promise<number>;
  updateCheck(): Promise<{ version: string } | null>;
  updateInstall(): Promise<boolean>;
  saveAttachment(id: string, index: number): Promise<boolean>;
  openAttachment(id: string, index: number): Promise<boolean>;
  external(url: string): Promise<void>;
  compose(init: ComposeInit): Promise<void>;
  composeInit(): Promise<{ init: ComposeInit; draft: ComposeDraft; source: FullMessage | null }>;
  send(msg: OutgoingMessage, at?: number): Promise<{ queued: boolean; id?: string; due?: number }>;
  outbox(): Promise<OutboxInfo[]>;
  outboxSendNow(id: string): Promise<void>;
  outboxEdit(id: string): Promise<void>;
  saveDraft(msg: OutgoingMessage): Promise<string>;
  discardDraft(msg: OutgoingMessage): Promise<void>;
  inviteState(id: string): Promise<{ response: InviteResponse | null; outdated: boolean; calendar: boolean } | null>;
  inviteRespond(id: string, response: InviteResponse, comment?: string): Promise<{ response: InviteResponse; calendar: boolean }>;
  inviteAdd(id: string): Promise<'calendar' | 'file' | null>;
  calendarState(): Promise<CalendarAccountState[]>;
  calendarRefresh(accountId?: string): Promise<void>;
  calendarEvents(from: number, to: number): Promise<CalendarEvent[]>;
  calendarCreate(input: EventInput, calendarKey?: string): Promise<CalendarEvent>;
  calendarDelete(id: string): Promise<CalendarEvent>;
  calendarUpdate(id: string, patch: Partial<EventInput>): Promise<CalendarEvent>;
  chatSend(chatId: string, text: string): Promise<ChatAnswer>;
  chatCancel(chatId: string): Promise<void>;
  chatReset(chatId: string): Promise<void>;
  contactList(query: string, limit?: number): Promise<ContactRow[]>;
  contactDetail(address: string): Promise<ContactDetail>;
  contacts(query: string): Promise<Contact[]>;
  fileInfo(paths: string[]): Promise<OutgoingAttachment[]>;
  pathForFile(file: File): string;
  fileFromData(name: string, data: Uint8Array): Promise<OutgoingAttachment>;
  pickFiles(): Promise<OutgoingAttachment[]>;
  ai(req: AiRequest): Promise<AiResult>;
  remind(id: string, kind: ReminderKind, due: number): Promise<void>;
  remindClear(id: string): Promise<void>;
  setBadge(dataUrl: string | null, count: number): Promise<void>;
  print(html: string, pdf: boolean, name: string): Promise<boolean>;
  aiTask(sourceId: string, task: 'summary' | 'todo' | 'quick', engine?: AiEngine): Promise<AiResult>;
  openaiStatus(): Promise<{ hasKey: boolean }>;
  openaiKeySave(key: string): Promise<{ hasKey: boolean }>;
  openaiModels(): Promise<{ latest: string | null; models: string[] }>;
  codexStatus(fresh?: boolean): Promise<{ installed: boolean; chatgpt: boolean; detail: string }>;
  agentInfo(): Promise<AgentInfo>;
  mcpClients(): Promise<McpClientInfo[]>;
  agentHttpRotate(): Promise<string>;
  agentLog(): Promise<AgentLogEntry[]>;
  agentLogClear(): Promise<void>;
  mcpClientConnect(id: string): Promise<McpClientInfo[]>;
  mcpClientDisconnect(id: string): Promise<McpClientInfo[]>;
  cleanSenders(accountId?: string): Promise<SenderStat[]>;
  prefetch(ids: string[]): Promise<void>;
  cleanScan(): Promise<number>;
  cleanUnsubscribe(address: string, accountId?: string): Promise<{ method: 'oneclick' | 'mailto' | 'browser' }>;
  cleanBulk(address: string, action: CleanAction, olderThanDays?: number, accountId?: string): Promise<number>;
  cleanRule(address: string, action: CleanAction | null): Promise<number>;
  cleanKeep(address: string, keep: boolean): Promise<void>;
  saveAccount(input: AccountInput): Promise<{ ok: boolean; errors: string[] }>;
  testAccount(input: AccountInput): Promise<TestResult>;
  setupAccount(input: SetupInput): Promise<SetupOutcome>;
  deleteAccount(id: string): Promise<void>;
  hasPassword(id: string): Promise<boolean>;
  setAccountSignature(accountId: string, signatureId: string): Promise<void>;
  sparkFind(): Promise<SparkExport | null>;
  sparkPick(): Promise<SparkExport | null>;
  oauthLogin(input: AccountInput): Promise<{ ok: boolean; email?: string; error?: string; cancelled?: boolean }>;
  oauthCancel(): Promise<void>;
  oauthConfig(): Promise<OAuthConfig>;
  oauthConfigSave(cfg: { googleClientId: string; microsoftClientId: string; googleClientSecret?: string }): Promise<void>;
  reconnect(id?: string): Promise<void>;
  syncFolder(accountId: string, path: string): Promise<void>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  closeWindow(): void;
  on(channel: 'changed' | 'open-message' | 'theme' | 'before-close' | 'setup-progress' | 'clean-progress' | 'outbox' | 'update' | 'agent-log' | 'calendar' | 'chat-step', fn: (...args: any[]) => void): () => void;
}

export const api: Api = (window as any).api;
