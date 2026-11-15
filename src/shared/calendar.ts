// Kalendern: typer och ren logik som delas av huvudprocessen, fönstret och AI-verktygen.
import { addDays, isoDate, localMidnight } from './ics';
import { locale, t } from './i18n';

export interface EventTime {
  start: number;
  end: number;
  allDay: boolean;
  startDate?: string;
  endDate?: string;
}

export type CalendarKind = 'google' | 'microsoft' | 'caldav';
export type AttendeeStatus = 'accepted' | 'tentative' | 'declined' | 'needs-action';

export interface EventPerson {
  name: string;
  email: string;
  status?: AttendeeStatus;
}

export interface CalendarInfo {
  accountId: string;
  id: string;
  name: string;
  color?: string;
  primary: boolean;
  readOnly: boolean;
}

export interface CalendarEvent extends EventTime {
  // Lokalt id, stabilt mellan synkningar.
  id: string;
  accountId: string;
  calendarId: string;
  // Id hos leverantören (Google, Graph) eller resursens adress (CalDAV).
  remoteId: string;
  uid: string;
  title: string;
  location: string;
  description: string;
  joinUrl?: string;
  organizer?: EventPerson;
  attendees: EventPerson[];
  status: 'confirmed' | 'tentative' | 'cancelled';
  busy: boolean;
  recurring: boolean;
  // Starttiden för just det här tillfället i en serie.
  recurrenceStart?: number;
  isOrganizer: boolean;
  myStatus?: AttendeeStatus;
  etag?: string;
  link?: string;
}

export interface EventInput {
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  startDate?: string;
  endDate?: string;
  location?: string;
  description?: string;
  attendees?: { name?: string; email: string }[];
}

export type CalendarStateKind = 'off' | 'unavailable' | 'needs-login' | 'ok' | 'error' | 'loading';

export interface CalendarAccountState {
  accountId: string;
  kind: CalendarKind | null;
  state: CalendarStateKind;
  error?: string;
  lastSync?: number;
  calendars: CalendarInfo[];
}

// Kort, stabilt id ur leverantörens id (FNV-1a, två varv).
export function eventId(...parts: (string | number | undefined)[]): string {
  const s = parts.map((p) => String(p ?? '')).join('\u0001');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `ev${h1.toString(36)}${h2.toString(36)}`;
}

const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale(), o);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function localDate(ms: number): string {
  const d = new Date(ms);
  return isoDate({ y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate() });
}

export function timeText(ms: number): string {
  return fmt({ hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}

// "Tisdag 17 november, 14:00 till 15:00" eller "Torsdag 24 december, heldag".
export function eventWhen(ev: EventTime): string {
  const dayFmt = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
  if (ev.allDay) {
    const sd = ev.startDate ?? localDate(ev.start);
    const last = ev.endDate ? addDays(ev.endDate, -1) : sd;
    const first = cap(dayFmt.format(new Date(localMidnight(sd))));
    if (last <= sd) return t('{day}, heldag', { day: first });
    return t('{from} till {to}', { from: first, to: dayFmt.format(new Date(localMidnight(last))) });
  }
  const day = cap(dayFmt.format(new Date(ev.start)));
  if (localDate(ev.start) === localDate(ev.end) || ev.end - ev.start < 60_000) {
    return t('{day}, {from} till {to}', { day, from: timeText(ev.start), to: timeText(ev.end) });
  }
  return t('{from} till {to}', { from: `${day} ${timeText(ev.start)}`, to: `${dayFmt.format(new Date(ev.end))} ${timeText(ev.end)}` });
}

// Upptagen tid: avböjda, inställda och lediga händelser räknas inte, inte heller heldagar.
export function blocksTime(ev: Pick<CalendarEvent, 'allDay' | 'busy' | 'status' | 'myStatus'>): boolean {
  return !ev.allDay && ev.busy && ev.status !== 'cancelled' && ev.myStatus !== 'declined';
}

function parseClock(v: string | undefined, def: number): number {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec((v ?? '').trim());
  if (!m) return def;
  const h = Number(m[1]);
  const mi = Number(m[2] ?? 0);
  return h > 24 || mi > 59 ? def : h * 60 + mi;
}

export interface FreeSlotOptions {
  from: number;
  to: number;
  durationMin: number;
  workStart?: string;
  workEnd?: string;
  weekends?: boolean;
  now?: number;
  max?: number;
  // Lediga tider börjar på jämna kvartar.
  stepMin?: number;
}

// Lediga tider inom arbetstiden, i lokal tid. Varje lucka som rymmer mötet blir en träff.
export function findFreeSlots(events: Pick<CalendarEvent, 'start' | 'end' | 'allDay' | 'busy' | 'status' | 'myStatus'>[], o: FreeSlotOptions): { start: number; end: number }[] {
  const dur = Math.max(5, o.durationMin) * 60_000;
  const step = (o.stepMin ?? 15) * 60_000;
  const ws = parseClock(o.workStart, 9 * 60);
  const we = parseClock(o.workEnd, 17 * 60);
  const lower = Math.max(o.from, o.now ?? o.from);
  const busy = events
    .filter(blocksTime)
    .map((e) => [e.start, e.end] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const out: { start: number; end: number }[] = [];
  let day = localMidnight(localDate(o.from));
  for (let guard = 0; day < o.to && guard < 400; guard++) {
    const d = new Date(day);
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const wd = d.getDay();
    if (o.weekends || (wd !== 0 && wd !== 6)) {
      const winStart = Math.max(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, ws).getTime(), lower);
      const winEnd = Math.min(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, we).getTime(), o.to);
      let cursor = Math.ceil(winStart / step) * step;
      for (const [bs, be] of busy) {
        if (be <= cursor || bs >= winEnd) continue;
        if (bs - cursor >= dur) out.push({ start: cursor, end: bs });
        cursor = Math.max(cursor, Math.ceil(be / step) * step);
      }
      if (winEnd - cursor >= dur) out.push({ start: cursor, end: winEnd });
      if (out.length >= (o.max ?? 20)) return out.slice(0, o.max ?? 20);
    }
    day = next;
  }
  return out;
}

export interface AgendaDay {
  date: string;
  allDay: CalendarEvent[];
  timed: CalendarEvent[];
}

// Händelserna dag för dag. Heldagar och händelser över flera dagar visas varje dag de pågår.
export function agenda(events: CalendarEvent[], fromDate: string, days: number): AgendaDay[] {
  const out: AgendaDay[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(fromDate, i);
    const s = localMidnight(date);
    const e = localMidnight(addDays(date, 1));
    const on = events.filter((ev) => ev.status !== 'cancelled' && (ev.allDay ? (ev.startDate ?? localDate(ev.start)) <= date && (ev.endDate ?? addDays(ev.startDate ?? localDate(ev.start), 1)) > date : ev.start < e && (ev.end > s || (ev.end === ev.start && ev.start >= s))));
    out.push({
      date,
      allDay: on.filter((x) => x.allDay).sort((a, b) => a.title.localeCompare(b.title, locale())),
      timed: on.filter((x) => !x.allDay).sort((a, b) => a.start - b.start || a.end - b.end)
    });
  }
  return out;
}

// "3 möten i dag, nästa 14:00 Demo".
export function todaySummary(events: CalendarEvent[], now: number): { count: number; next?: CalendarEvent; text: string } {
  const today = localDate(now);
  const list = agenda(events, today, 1)[0].timed.filter((e) => e.myStatus !== 'declined');
  const next = list.find((e) => e.end > now);
  if (!list.length) return { count: 0, text: '' };
  const head = list.length === 1 ? t('Ett möte i dag') : t('{n} möten i dag', { n: list.length });
  if (!next) return { count: list.length, text: head };
  const when = next.start <= now ? t('pågår') : timeText(next.start);
  return { count: list.length, next, text: t('{head}, nästa {when} {title}', { head, when, title: next.title || t('(ingen titel)') }) };
}

export function dayLabel(date: string, now: number): string {
  const today = localDate(now);
  if (date === today) return t('I dag');
  if (date === addDays(today, 1)) return t('I morgon');
  return cap(fmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(localMidnight(date))));
}

// Om en händelse går att ändra i appen: skrivbar kalender, och egen händelse om den har deltagare.
export function canEditEvent(ev: CalendarEvent, states: CalendarAccountState[]): boolean {
  const cal = states.find((s) => s.accountId === ev.accountId)?.calendars.find((c) => c.id === ev.calendarId);
  return !!cal && !cal.readOnly && (ev.isOrganizer || !ev.attendees.length);
}

// Samma adresser, oavsett ordning och stora bokstäver.
export function sameEmails(a: string[], b: string[]): boolean {
  const x = [...new Set(a.map((s) => s.toLowerCase()))].sort();
  const y = [...new Set(b.map((s) => s.toLowerCase()))].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
