// Kalendrarna för alla konton: synk till en lokal cache, och skapa, ändra och ta bort händelser.
import type { AccountConfig, Invitation, InviteResponse } from '../../shared/types';
import { findFreeSlots, type CalendarAccountState, type CalendarEvent, type CalendarInfo, type EventInput, type EventPerson } from '../../shared/calendar';
import { t } from '../../shared/i18n';
import { CalendarAuthError, type CalendarProvider } from './provider';

export const PAST_DAYS = 7;
export const AHEAD_DAYS = 60;
const DAY = 86400000;
// Ett konto utan kalender provas igen efter sex timmar, inte vid varje uppdatering.
const RETRY_UNAVAILABLE = 6 * 3600_000;

export interface CalendarCache {
  setCalendars(accountId: string, cals: CalendarInfo[]): void;
  listCalendars(): CalendarInfo[];
  replaceCalendarEvents(accountId: string, calendarId: string, from: number, to: number, events: CalendarEvent[]): void;
  putEvent(ev: CalendarEvent): void;
  removeEvent(id: string): void;
  getEvent(id: string): CalendarEvent | null;
  cachedEvents(from: number, to: number): CalendarEvent[];
  clearCalendarAccount(accountId: string): void;
}

export interface CalendarDeps {
  accounts(): AccountConfig[];
  // Leverantören för kontot, null om kontot saknar kalender. Kastar CalendarAuthError om inloggningen saknar behörighet.
  provider(cfg: AccountConfig): Promise<CalendarProvider | null>;
  cache: CalendarCache;
  // Mejlar en inbjudan (iMIP) när servern inte gör det själv.
  sendInvite(cfg: AccountConfig, to: EventPerson[], method: 'REQUEST' | 'CANCEL', ics: string, title: string): Promise<void>;
  now?(): number;
  onChange?(): void;
  log?(msg: string): void;
}

export interface EventFilter {
  accountIds?: string[];
  calendar?: string;
  query?: string;
}

export const calendarKey = (c: Pick<CalendarInfo, 'accountId' | 'id'>) => `${c.accountId}|${c.id}`;

export class CalendarService {
  private byAccount = new Map<string, CalendarAccountState>();
  private providers = new Map<string, CalendarProvider>();
  private unavailableUntil = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private synced = new Map<string, { from: number; to: number }>();

  constructor(private deps: CalendarDeps) {}

  // Kalendrarna från förra körningen, så att vyn har något att visa innan första synken.
  load() {
    for (const c of this.deps.cache.listCalendars()) {
      const st = this.byAccount.get(c.accountId) ?? { accountId: c.accountId, kind: null, state: 'loading' as const, calendars: [] };
      st.calendars.push(c);
      this.byAccount.set(c.accountId, st);
    }
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  window(): { from: number; to: number } {
    const d = new Date(this.now());
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return { from: midnight - PAST_DAYS * DAY, to: midnight + AHEAD_DAYS * DAY };
  }

  private account(id: string): AccountConfig {
    const a = this.deps.accounts().find((x) => x.id === id);
    if (!a) throw new Error(t('Kontot finns inte.'));
    return a;
  }

  // Glöm leverantören, till exempel efter en ny inloggning eller ändrade inställningar.
  invalidate(accountId: string) {
    this.providers.delete(accountId);
    this.unavailableUntil.delete(accountId);
  }

  private setState(cfg: AccountConfig, patch: Partial<CalendarAccountState>) {
    const prev = this.byAccount.get(cfg.id) ?? { accountId: cfg.id, kind: null, state: 'loading' as const, calendars: [] };
    this.byAccount.set(cfg.id, { ...prev, ...patch });
    this.deps.onChange?.();
  }

  private async providerFor(cfg: AccountConfig): Promise<CalendarProvider | null> {
    const cached = this.providers.get(cfg.id);
    if (cached) return cached;
    if ((this.unavailableUntil.get(cfg.id) ?? 0) > this.now()) return null;
    const p = await this.deps.provider(cfg);
    if (p) this.providers.set(cfg.id, p);
    else this.unavailableUntil.set(cfg.id, this.now() + RETRY_UNAVAILABLE);
    return p;
  }

  // Uppdaterar ett eller alla konton, ett i taget.
  refresh(accountId?: string): Promise<void> {
    const run = this.queue.then(async () => {
      const list = this.deps.accounts().filter((a) => !accountId || a.id === accountId);
      for (const cfg of list) await this.refreshAccount(cfg);
      for (const id of [...this.byAccount.keys()]) if (!this.deps.accounts().some((a) => a.id === id)) this.byAccount.delete(id);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async refreshAccount(cfg: AccountConfig) {
    if (cfg.calendar === false) {
      this.providers.delete(cfg.id);
      this.synced.delete(cfg.id);
      this.deps.cache.clearCalendarAccount(cfg.id);
      this.setState(cfg, { state: 'off', calendars: [], error: undefined });
      return;
    }
    const { from, to } = this.window();
    this.setState(cfg, { state: 'loading' });
    try {
      const p = await this.providerFor(cfg);
      if (!p) {
        this.deps.cache.clearCalendarAccount(cfg.id);
        this.setState(cfg, { state: 'unavailable', kind: null, calendars: [], error: undefined });
        return;
      }
      const cals = await p.listCalendars();
      this.deps.cache.setCalendars(cfg.id, cals);
      for (const cal of cals) this.deps.cache.replaceCalendarEvents(cfg.id, cal.id, from, to, await p.listEvents(cal, from, to));
      this.synced.set(cfg.id, { from, to });
      this.setState(cfg, { state: 'ok', kind: p.kind, calendars: cals, error: undefined, lastSync: this.now() });
    } catch (e: any) {
      if (e instanceof CalendarAuthError) {
        this.providers.delete(cfg.id);
        this.setState(cfg, { state: 'needs-login', error: e.message === 'needs login' ? undefined : e.message });
      } else {
        this.deps.log?.(`kalender ${cfg.id}: ${e?.message}`);
        this.setState(cfg, { state: 'error', error: String(e?.message ?? e) });
      }
    }
  }

  states(): CalendarAccountState[] {
    return this.deps.accounts().map((a) => this.byAccount.get(a.id) ?? { accountId: a.id, kind: null, state: a.calendar === false ? 'off' : 'loading', calendars: [] });
  }

  connected(accountId: string): boolean {
    const st = this.byAccount.get(accountId);
    return st?.state === 'ok' && st.calendars.some((c) => !c.readOnly);
  }

  calendars(): CalendarInfo[] {
    return this.states().flatMap((s) => (s.state === 'ok' ? s.calendars : []));
  }

  // Kalendern att skriva i: given med nyckel, namn eller kontots adress, annars kontots eller förstas huvudkalender.
  pickCalendar(spec?: string, accountId?: string): CalendarInfo {
    const writable = this.calendars().filter((c) => !c.readOnly && (!accountId || c.accountId === accountId));
    if (!writable.length) throw new Error(t('Ingen kalender är ansluten. Slå på kalendern för ett konto under Konton.'));
    const q = spec?.trim().toLowerCase();
    if (q) {
      const accounts = this.deps.accounts();
      const hit =
        writable.find((c) => calendarKey(c).toLowerCase() === q || c.id.toLowerCase() === q) ??
        writable.find((c) => c.name.toLowerCase() === q) ??
        writable.find((c) => {
          const a = accounts.find((x) => x.id === c.accountId);
          return c.primary && (a?.email.toLowerCase() === q || a?.name.toLowerCase() === q);
        }) ??
        writable.find((c) => c.name.toLowerCase().includes(q));
      if (!hit) throw new Error(t('Kalendern "{name}" finns inte. Kalendrar: {list}', { name: spec!, list: writable.map((c) => c.name).join(', ') }));
      return hit;
    }
    return writable.find((c) => c.primary) ?? writable[0];
  }

  private filter(list: CalendarEvent[], f: EventFilter): CalendarEvent[] {
    const q = f.query?.trim().toLowerCase();
    let cal: CalendarInfo | undefined;
    if (f.calendar?.trim()) {
      const spec = f.calendar.trim().toLowerCase();
      cal = this.calendars().find((c) => calendarKey(c).toLowerCase() === spec || c.id.toLowerCase() === spec || c.name.toLowerCase() === spec);
      if (!cal) throw new Error(t('Kalendern "{name}" finns inte. Kalendrar: {list}', { name: f.calendar, list: this.calendars().map((c) => c.name).join(', ') }));
    }
    return list
      .filter((e) => !f.accountIds || f.accountIds.includes(e.accountId))
      .filter((e) => !cal || (e.accountId === cal.accountId && e.calendarId === cal.id))
      .filter((e) => !q || [e.title, e.location, e.description, e.organizer?.name, e.organizer?.email, ...e.attendees.map((a) => `${a.name} ${a.email}`)].some((x) => x?.toLowerCase().includes(q)))
      .sort((a, b) => a.start - b.start);
  }

  // Händelser i ett intervall. Inom cachens fönster svarar cachen, annars frågas leverantörerna.
  async events(from: number, to: number, f: EventFilter = {}): Promise<CalendarEvent[]> {
    const accounts = this.deps.accounts().filter((a) => this.byAccount.get(a.id)?.state === 'ok' && (!f.accountIds || f.accountIds.includes(a.id)));
    const inWindow = accounts.every((a) => {
      const w = this.synced.get(a.id);
      return !!w && w.from <= from && w.to >= to;
    });
    if (inWindow) return this.filter(this.deps.cache.cachedEvents(from, to), f);
    const out: CalendarEvent[] = [];
    for (const cfg of accounts) {
      const p = await this.providerFor(cfg).catch(() => null);
      if (!p) continue;
      for (const cal of this.byAccount.get(cfg.id)?.calendars ?? []) out.push(...(await p.listEvents(cal, from, to)));
    }
    for (const e of out) this.deps.cache.putEvent(e);
    return this.filter(out, f);
  }

  getEvent(id: string): CalendarEvent | null {
    return this.deps.cache.getEvent(id);
  }

  async freeSlots(o: { from: number; to: number; durationMin: number; workStart?: string; workEnd?: string; weekends?: boolean; accountIds?: string[] }) {
    const events = await this.events(o.from, o.to, { accountIds: o.accountIds });
    return findFreeSlots(events, { ...o, now: this.now() });
  }

  private me(cfg: AccountConfig): EventPerson {
    return { name: cfg.displayName?.trim() || '', email: cfg.email.toLowerCase() };
  }

  private async ready(accountId: string): Promise<{ cfg: AccountConfig; p: CalendarProvider }> {
    const cfg = this.account(accountId);
    const p = await this.providerFor(cfg);
    if (!p) throw new Error(t('Kontot har ingen ansluten kalender.'));
    return { cfg, p };
  }

  private calendarOf(ev: CalendarEvent): CalendarInfo {
    const cal = this.byAccount.get(ev.accountId)?.calendars.find((c) => c.id === ev.calendarId);
    if (!cal) throw new Error(t('Kalendern finns inte längre.'));
    return cal;
  }

  async create(input: EventInput, calendar?: string, accountId?: string): Promise<CalendarEvent> {
    const cal = this.pickCalendar(calendar, accountId);
    const { cfg, p } = await this.ready(cal.accountId);
    const ev = await p.createEvent(cal, input, this.me(cfg));
    this.deps.cache.putEvent(ev);
    if (input.attendees?.length && !p.sendsInvitations && p.imip) {
      await this.deps.sendInvite(cfg, input.attendees.map((a) => ({ name: a.name ?? '', email: a.email })), 'REQUEST', await p.imip(ev, 'REQUEST'), ev.title);
    }
    this.deps.onChange?.();
    return ev;
  }

  async update(id: string, patch: Partial<EventInput>): Promise<CalendarEvent> {
    const ev = this.getEvent(id);
    if (!ev) throw new Error(t('Händelsen finns inte. Hämta listan igen.'));
    const { cfg, p } = await this.ready(ev.accountId);
    const updated = await p.updateEvent(this.calendarOf(ev), ev, patch, this.me(cfg));
    this.deps.cache.putEvent(updated);
    if (updated.id !== id) this.deps.cache.removeEvent(id);
    const people = updated.attendees.length ? updated.attendees : (patch.attendees ?? []).map((a) => ({ name: a.name ?? '', email: a.email }));
    if (people.length && updated.isOrganizer && !p.sendsInvitations && p.imip) await this.deps.sendInvite(cfg, people, 'REQUEST', await p.imip(updated, 'REQUEST'), updated.title);
    this.deps.onChange?.();
    return updated;
  }

  async remove(id: string): Promise<CalendarEvent> {
    const ev = this.getEvent(id);
    if (!ev) throw new Error(t('Händelsen finns inte. Hämta listan igen.'));
    const { cfg, p } = await this.ready(ev.accountId);
    const notify = ev.isOrganizer && ev.attendees.length > 0 && !p.sendsInvitations && !!p.imip && ev.recurrenceStart === undefined;
    const cancel = notify ? await p.imip!(ev, 'CANCEL') : null;
    await p.deleteEvent(this.calendarOf(ev), ev);
    this.deps.cache.removeEvent(id);
    if (cancel) await this.deps.sendInvite(cfg, ev.attendees, 'CANCEL', cancel, ev.title);
    this.deps.onChange?.();
    return ev;
  }

  // Efter svaret på en inbjudan i ett mejl: händelsen läggs in eller får det nya svaret.
  async saveInvite(accountId: string, inv: Invitation, response: InviteResponse | null, me?: EventPerson): Promise<boolean> {
    if (!this.connected(accountId)) return false;
    const { cfg, p } = await this.ready(accountId);
    const cal = this.pickCalendar(undefined, accountId);
    await p.saveInvite(cal, inv, me ?? this.me(cfg), response);
    void this.refresh(accountId).catch(() => undefined);
    return true;
  }
}
