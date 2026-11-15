// iCalendar (RFC 5545) och iMIP (RFC 5546, 6047): tolkning av inbjudningar, tidszoner, återkommande
// händelser och svar. Utan beroenden, så att samma kod fungerar i huvudprocessen, fönstret och testerna.
import { locale, t } from './i18n';
import { APP_NAME } from './brand';

const PRODID = `-//${APP_NAME}//EN`;

export interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface IcsComponent {
  name: string;
  props: IcsProp[];
  children: IcsComponent[];
}

export interface IcsPerson {
  name: string;
  email: string;
}

export interface IcsAttendee extends IcsPerson {
  partstat: string;
  rsvp: boolean;
  role: string;
}

export interface IcsEvent {
  uid: string;
  sequence: number;
  summary: string;
  location: string;
  description: string;
  url: string;
  status: string;
  transparent: boolean;
  // Millisekunder UTC. Heldag: lokal midnatt, och datumen i startDate/endDate (endDate exklusivt).
  start: number;
  end: number;
  allDay: boolean;
  startDate?: string;
  endDate?: string;
  tzid?: string;
  rrule?: string;
  recurrenceId?: number;
  organizer?: IcsPerson;
  attendees: IcsAttendee[];
  joinUrl?: string;
  // Raderna som de stod, för svaret till organisatören.
  rawStart?: string;
  rawEnd?: string;
  rawRecurrenceId?: string;
}

export interface IcsCalendar {
  method: string;
  prodid: string;
  events: IcsEvent[];
}

// Radbrytning och vikning

export function unfold(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const l of lines) {
    if ((l.startsWith(' ') || l.startsWith('\t')) && out.length) out[out.length - 1] += l.slice(1);
    else if (l.trim()) out.push(l);
  }
  return out;
}

export function parseLine(line: string): IcsProp | null {
  let i = 0;
  let inQuote = false;
  // Namn och parametrar slutar vid första kolon utanför citattecken.
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ':' && !inQuote) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts: string[] = [];
  let cur = '';
  inQuote = false;
  for (const c of head) {
    if (c === '"') inQuote = !inQuote;
    if (c === ';' && !inQuote) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  const name = parts.shift()!.trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    params[p.slice(0, eq).trim().toUpperCase()] = p
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
  }
  return { name, params, value };
}

export function parseComponents(text: string): IcsComponent[] {
  const roots: IcsComponent[] = [];
  const stack: IcsComponent[] = [];
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      const c: IcsComponent = { name: p.value.trim().toUpperCase(), props: [], children: [] };
      if (stack.length) stack[stack.length - 1].children.push(c);
      else roots.push(c);
      stack.push(c);
    } else if (p.name === 'END') {
      const name = p.value.trim().toUpperCase();
      // Tål felaktig nästling: stäng ned till rätt komponent.
      const idx = stack.map((c) => c.name).lastIndexOf(name);
      if (idx >= 0) stack.length = idx;
    } else if (stack.length) stack[stack.length - 1].props.push(p);
  }
  return roots;
}

export function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

export function escapeText(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

const prop = (c: IcsComponent, name: string) => c.props.find((p) => p.name === name);
const props = (c: IcsComponent, name: string) => c.props.filter((p) => p.name === name);

// Tidszoner

// Vanliga Windows-namn (Outlook, Exchange) till IANA.
const WINDOWS_ZONES: Record<string, string> = {
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'FLE Standard Time': 'Europe/Kiev',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'Canada Central Standard Time': 'America/Regina',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Buenos_Aires',
  'Mexico Standard Time': 'America/Mexico_City',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  UTC: 'UTC',
  'Coordinated Universal Time': 'UTC'
};

// Städer i Outlooks visningsnamn, till exempel "(UTC+01:00) Amsterdam, Berlin, Bern, Rom, Stockholm, Wien".
const CITY_ZONES: [RegExp, string][] = [
  [/Stockholm/i, 'Europe/Stockholm'],
  [/Amsterdam|Berlin|Bern|Rome|Rom\b|Vienna|Wien/i, 'Europe/Berlin'],
  [/Brussels|Copenhagen|Madrid|Paris/i, 'Europe/Paris'],
  [/Helsinki|Kyiv|Kiev|Riga|Sofia|Tallinn|Vilnius/i, 'Europe/Helsinki'],
  [/Dublin|Edinburgh|Lisbon|London/i, 'Europe/London'],
  [/Belgrade|Bratislava|Budapest|Ljubljana|Prague/i, 'Europe/Budapest'],
  [/Sarajevo|Skopje|Warsaw|Zagreb/i, 'Europe/Warsaw'],
  [/Eastern Time/i, 'America/New_York'],
  [/Central Time/i, 'America/Chicago'],
  [/Mountain Time/i, 'America/Denver'],
  [/Pacific Time/i, 'America/Los_Angeles']
];

const validZones = new Map<string, boolean>();
export function isIanaZone(tz: string): boolean {
  let ok = validZones.get(tz);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      ok = true;
    } catch {
      ok = false;
    }
    validZones.set(tz, ok);
  }
  return ok;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
// Skillnaden mellan väggklockan i zonen och UTC vid en viss tidpunkt, i millisekunder.
export function zoneOffset(ms: number, tz: string): number {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

// Väggklocka som "falsk UTC": Date.UTC av fälten, för ren kalenderräkning.
export interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const wallMs = (w: Wall) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
const toWall = (ms: number): Wall => {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
};

export function wallToUtcInZone(w: Wall, tz: string): number {
  const guess = wallMs(w);
  const off = zoneOffset(guess, tz);
  let utc = guess - off;
  const off2 = zoneOffset(utc, tz);
  if (off2 !== off) utc = guess - off2;
  return utc;
}

export function utcToWallInZone(ms: number, tz: string): Wall {
  return toWall(ms + zoneOffset(ms, tz));
}

type ZoneFn = (w: Wall) => number;

const localZone: ZoneFn = (w) => new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s).getTime();

function parseOffset(v: string | undefined): number | null {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec((v ?? '').trim());
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * ((Number(m[2]) * 60 + Number(m[3])) * 60 + Number(m[4] ?? 0)) * 1000;
}

const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// Dag i månaden för den n:te veckodagen (n negativt räknas från slutet). 0 om den inte finns.
function nthWeekday(y: number, mo: number, wd: number, n: number): number {
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (n > 0) {
    const first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
    const d = 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
    return d <= days ? d : 0;
  }
  const last = new Date(Date.UTC(y, mo - 1, days)).getUTCDay();
  const d = days - ((last - wd + 7) % 7) + (n + 1) * 7;
  return d >= 1 ? d : 0;
}

// Regler ur en VTIMEZONE: STANDARD och DAYLIGHT med början och årlig upprepning.
function vtimezoneFn(tz: IcsComponent): ZoneFn | null {
  const rules = tz.children
    .filter((c) => c.name === 'STANDARD' || c.name === 'DAYLIGHT')
    .map((c) => {
      const start = parseWall(prop(c, 'DTSTART')?.value ?? '');
      const to = parseOffset(prop(c, 'TZOFFSETTO')?.value);
      const rr = parseRrule(prop(c, 'RRULE')?.value ?? '');
      return start && to !== null ? { start: start.wall, to, rr } : null;
    })
    .filter((r): r is NonNullable<typeof r> => !!r);
  if (!rules.length) return null;
  const onset = (r: (typeof rules)[number], year: number): number | null => {
    const s = r.start;
    if (!r.rr) return year === s.y ? wallMs(s) : null;
    if (year < s.y) return null;
    const month = r.rr.bymonth[0] ?? s.mo;
    let day = s.d;
    if (r.rr.byday.length) day = nthWeekday(year, month, r.rr.byday[0].wd, r.rr.byday[0].n || 1);
    else if (r.rr.bymonthday.length) day = r.rr.bymonthday[0];
    if (!day) return null;
    return Date.UTC(year, month - 1, day, s.h, s.mi, s.s);
  };
  return (w) => {
    const target = wallMs(w);
    let best: { at: number; to: number } | null = null;
    for (const r of rules) {
      for (const y of [w.y - 1, w.y]) {
        const at = onset(r, y);
        if (at !== null && at <= target && (!best || at > best.at)) best = { at, to: r.to };
      }
      // Regler utan upprepning gäller från sitt startdatum och framåt.
      if (!r.rr && wallMs(r.start) <= target && (!best || wallMs(r.start) > best.at)) best = { at: wallMs(r.start), to: r.to };
    }
    const to = best?.to ?? rules[0].to;
    return target - to;
  };
}

export function resolveZone(tzid: string | undefined, zones: Map<string, IcsComponent>): ZoneFn {
  if (!tzid) return localZone;
  const id = tzid.trim().replace(/^"|"$/g, '');
  if (/^(UTC|GMT|Z|Etc\/UTC)$/i.test(id)) return (w) => wallMs(w);
  if (isIanaZone(id) && id.includes('/')) return (w) => wallToUtcInZone(w, id);
  const tail = /([A-Za-z]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/.exec(id)?.[1];
  if (tail && isIanaZone(tail)) return (w) => wallToUtcInZone(w, tail);
  const win = WINDOWS_ZONES[id];
  if (win) return (w) => wallToUtcInZone(w, win);
  const vt = zones.get(id);
  const fn = vt ? vtimezoneFn(vt) : null;
  if (fn) return fn;
  const city = CITY_ZONES.find(([re]) => re.test(id))?.[1];
  if (city) return (w) => wallToUtcInZone(w, city);
  const fixed = /\(UTC([+-]\d{2}):?(\d{2})\)/.exec(id);
  if (fixed) {
    const off = (Number(fixed[1]) * 60 + Math.sign(Number(fixed[1]) || 1) * Number(fixed[2])) * 60000;
    return (w) => wallMs(w) - off;
  }
  return localZone;
}

export function ianaFor(tzid: string | undefined): string | undefined {
  if (!tzid) return undefined;
  const id = tzid.trim();
  if (isIanaZone(id) && id.includes('/')) return id;
  return WINDOWS_ZONES[id] ?? CITY_ZONES.find(([re]) => re.test(id))?.[1];
}

// Datum och tid

function parseWall(v: string): { wall: Wall; utc: boolean; dateOnly: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v.trim());
  if (!m) return null;
  return {
    wall: { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), h: Number(m[4] ?? 0), mi: Number(m[5] ?? 0), s: Number(m[6] ?? 0) },
    utc: !!m[7],
    dateOnly: !m[4]
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export const isoDate = (w: Pick<Wall, 'y' | 'mo' | 'd'>) => `${w.y}-${pad(w.mo)}-${pad(w.d)}`;

// Lokal midnatt för ett datum "YYYY-MM-DD".
export function localMidnight(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(y, mo - 1, d).getTime();
}

export function addDays(date: string, n: number): string {
  const [y, mo, d] = date.split('-').map(Number);
  return isoDate(toWall(Date.UTC(y, mo - 1, d + n)));
}

interface ParsedTime {
  utc: number;
  allDay: boolean;
  date?: string;
  wall: Wall;
  zone: ZoneFn;
}

function parseTime(p: IcsProp | undefined, zones: Map<string, IcsComponent>): ParsedTime | null {
  if (!p) return null;
  const w = parseWall(p.value.split(',')[0]);
  if (!w) return null;
  if (w.dateOnly || p.params.VALUE === 'DATE') {
    const date = isoDate(w.wall);
    return { utc: localMidnight(date), allDay: true, date, wall: w.wall, zone: localZone };
  }
  const zone: ZoneFn = w.utc ? (x) => wallMs(x) : resolveZone(p.params.TZID, zones);
  return { utc: zone(w.wall), allDay: false, wall: w.wall, zone };
}

export function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const ms = (((Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * 24 + Number(m[4] ?? 0)) * 60 + Number(m[5] ?? 0)) * 60000 + Number(m[6] ?? 0) * 1000;
  return m[1] === '-' ? -ms : ms;
}

export const formatUtc = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};

// Personer och länkar

export function mailtoAddress(v: string): string {
  return v.trim().replace(/^mailto:/i, '').toLowerCase();
}

function person(p: IcsProp): IcsPerson {
  const email = mailtoAddress(p.value) || (p.params.EMAIL ?? '').toLowerCase();
  return { name: unescapeText(p.params.CN ?? '').trim(), email };
}

const JOIN_RE =
  /https:\/\/(?:teams\.microsoft\.com\/l\/meetup-join\/[^\s"'<>]+|teams\.live\.com\/meet\/[^\s"'<>]+|meet\.google\.com\/[a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4}[^\s"'<>]*|(?:[\w-]+\.)?zoom\.us\/(?:j|my|w|s)\/[^\s"'<>]+|[\w-]+\.webex\.com\/[^\s"'<>]+|whereby\.com\/[^\s"'<>]+|meet\.jit\.si\/[^\s"'<>]+)/i;

export function findJoinUrl(...texts: (string | undefined)[]): string | undefined {
  for (const text of texts) {
    const m = text ? JOIN_RE.exec(text) : null;
    if (m) return m[0].replace(/[)>\].,;]+$/, '');
  }
  return undefined;
}

export function joinService(url: string): string {
  if (/teams\.(microsoft|live)\.com/i.test(url)) return 'Teams';
  if (/meet\.google\.com/i.test(url)) return 'Google Meet';
  if (/zoom\.us/i.test(url)) return 'Zoom';
  if (/webex\.com/i.test(url)) return 'Webex';
  if (/whereby\.com/i.test(url)) return 'Whereby';
  if (/jit\.si/i.test(url)) return 'Jitsi';
  return '';
}

// Återkommande

export interface Rrule {
  freq: string;
  interval: number;
  count?: number;
  until?: { wall: Wall; utc: boolean; dateOnly: boolean };
  byday: { n: number; wd: number }[];
  bymonthday: number[];
  bymonth: number[];
}

export function parseRrule(v: string): Rrule | null {
  if (!v.trim()) return null;
  const map: Record<string, string> = {};
  for (const part of v.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) map[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim();
  }
  if (!map.FREQ) return null;
  const byday = (map.BYDAY ?? '')
    .split(',')
    .map((s) => /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(s.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ n: Number(m[1] ?? 0), wd: WD.indexOf(m[2].toUpperCase()) }));
  const nums = (s?: string) => (s ?? '').split(',').map(Number).filter((n) => Number.isFinite(n) && n !== 0);
  return {
    freq: map.FREQ.toUpperCase(),
    interval: Math.max(1, Number(map.INTERVAL) || 1),
    count: map.COUNT ? Number(map.COUNT) : undefined,
    until: map.UNTIL ? (parseWall(map.UNTIL) ?? undefined) : undefined,
    byday,
    bymonthday: nums(map.BYMONTHDAY),
    bymonth: nums(map.BYMONTH)
  };
}

const weekdayName = (wd: number) => new Intl.DateTimeFormat(locale(), { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + wd)));

// Upprepningen i klartext för de vanliga fallen.
export function describeRrule(v: string | undefined): string {
  const r = v ? parseRrule(v) : null;
  if (!r) return '';
  const n = r.interval;
  let base: string;
  if (r.freq === 'DAILY') base = n === 1 ? t('Varje dag') : n === 2 ? t('Varannan dag') : t('Var {n}:e dag', { n });
  else if (r.freq === 'WEEKLY') {
    const days = [...new Set(r.byday.map((b) => b.wd))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    if (n === 1 && days.length === 5 && days.join() === '1,2,3,4,5') base = t('Varje vardag');
    else {
      base = n === 1 ? t('Varje vecka') : n === 2 ? t('Varannan vecka') : t('Var {n}:e vecka', { n });
      if (days.length) base = t('{rule} på {days}', { rule: base, days: days.map(weekdayName).join(', ') });
    }
  } else if (r.freq === 'MONTHLY') base = n === 1 ? t('Varje månad') : n === 2 ? t('Varannan månad') : t('Var {n}:e månad', { n });
  else if (r.freq === 'YEARLY') base = n === 1 ? t('Varje år') : n === 2 ? t('Vartannat år') : t('Var {n}:e år', { n });
  else return t('Återkommande');
  if (r.count) return t('{rule}, {n} gånger', { rule: base, n: r.count });
  if (r.until) {
    const d = new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(r.until.wall.y, r.until.wall.mo - 1, r.until.wall.d));
    return t('{rule}, till och med {date}', { rule: base, date: d });
  }
  return base;
}

const DAY = 86400000;

// Startdagarna (väggklocka) för en upprepning, från början och framåt till och med "to".
function* occurrences(start: Wall, r: Rrule, limit: number): Generator<Wall> {
  const t0 = wallMs(start);
  const time = { h: start.h, mi: start.mi, s: start.s };
  const at = (y: number, mo: number, d: number): Wall => ({ y, mo, d, ...time });
  const days = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const monthDays = (y: number, mo: number): number[] => {
    if (r.byday.length) {
      const out: number[] = [];
      for (const b of r.byday) {
        if (b.n) {
          const d = nthWeekday(y, mo, b.wd, b.n);
          if (d) out.push(d);
        } else for (let d = 1; d <= days(y, mo); d++) if (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === b.wd) out.push(d);
      }
      return out.sort((a, b) => a - b);
    }
    if (r.bymonthday.length) return r.bymonthday.map((d) => (d > 0 ? d : days(y, mo) + d + 1)).filter((d) => d >= 1 && d <= days(y, mo)).sort((a, b) => a - b);
    return start.d <= days(y, mo) ? [start.d] : [];
  };
  for (let i = 0; i < 5000; i++) {
    let batch: Wall[] = [];
    if (r.freq === 'DAILY') {
      const w = toWall(t0 + i * r.interval * DAY);
      if (!r.byday.length || r.byday.some((b) => b.wd === new Date(wallMs(w)).getUTCDay())) batch = [w];
    } else if (r.freq === 'WEEKLY') {
      const dow = (new Date(t0).getUTCDay() + 6) % 7;
      const monday = t0 - dow * DAY + i * r.interval * 7 * DAY;
      const wds = r.byday.length ? r.byday.map((b) => (b.wd + 6) % 7) : [dow];
      batch = [...new Set(wds)].sort((a, b) => a - b).map((o) => toWall(monday + o * DAY));
    } else if (r.freq === 'MONTHLY') {
      const m0 = start.y * 12 + (start.mo - 1) + i * r.interval;
      const y = Math.floor(m0 / 12);
      const mo = (m0 % 12) + 1;
      batch = monthDays(y, mo).map((d) => at(y, mo, d));
    } else if (r.freq === 'YEARLY') {
      const y = start.y + i * r.interval;
      const months = r.bymonth.length ? r.bymonth : [start.mo];
      for (const mo of months) {
        const ds = r.byday.length || r.bymonthday.length ? monthDays(y, mo) : start.d <= days(y, mo) ? [start.d] : [];
        batch.push(...ds.map((d) => at(y, mo, d)));
      }
    } else return;
    for (const w of batch) {
      if (wallMs(w) < t0) continue;
      if (wallMs(w) > limit) return;
      yield w;
    }
    if (r.freq === 'DAILY' && t0 + i * r.interval * DAY > limit) return;
  }
}

// Tolkning av hela kalendern

export interface ParseOptions {
  // Bred ut återkommande händelser till enskilda tillfällen inom intervallet.
  expand?: { from: number; to: number };
}

export function parseIcs(text: string, opts: ParseOptions = {}): IcsCalendar | null {
  const cal = parseComponents(text).find((c) => c.name === 'VCALENDAR');
  if (!cal) return null;
  const zones = new Map<string, IcsComponent>();
  for (const z of cal.children.filter((c) => c.name === 'VTIMEZONE')) {
    const id = prop(z, 'TZID')?.value.trim();
    if (id) zones.set(id, z);
  }
  const events: IcsEvent[] = [];
  const masters: { ev: IcsEvent; start: ParsedTime; rr: Rrule; exdates: Set<number> }[] = [];
  const overrides: IcsEvent[] = [];
  for (const c of cal.children.filter((x) => x.name === 'VEVENT')) {
    const start = parseTime(prop(c, 'DTSTART'), zones);
    if (!start) continue;
    const endProp = prop(c, 'DTEND');
    const endTime = parseTime(endProp, zones);
    let end: number;
    let endDate: string | undefined;
    if (endTime) {
      end = endTime.utc;
      endDate = endTime.date;
    } else {
      const dur = parseDuration(prop(c, 'DURATION')?.value ?? '');
      if (start.allDay) {
        const n = dur !== null ? Math.max(1, Math.round(dur / DAY)) : 1;
        endDate = addDays(start.date!, n);
        end = localMidnight(endDate);
      } else end = start.utc + (dur ?? 0);
    }
    if (start.allDay && !endDate) endDate = addDays(start.date!, 1);
    if (end < start.utc) end = start.utc;
    const text = (n: string) => unescapeText(prop(c, n)?.value ?? '').trim();
    const description = text('DESCRIPTION');
    const location = text('LOCATION');
    const url = (prop(c, 'URL')?.value ?? '').trim();
    const conference = [prop(c, 'X-GOOGLE-CONFERENCE')?.value, prop(c, 'X-MICROSOFT-SKYPETEAMSMEETINGURL')?.value, ...props(c, 'CONFERENCE').map((p) => p.value)];
    const org = prop(c, 'ORGANIZER');
    const rid = prop(c, 'RECURRENCE-ID');
    const ridTime = parseTime(rid, zones);
    const ev: IcsEvent = {
      uid: (prop(c, 'UID')?.value ?? '').trim(),
      sequence: Number(prop(c, 'SEQUENCE')?.value) || 0,
      summary: text('SUMMARY'),
      location,
      description,
      url,
      status: (prop(c, 'STATUS')?.value ?? '').trim().toUpperCase(),
      transparent: (prop(c, 'TRANSP')?.value ?? '').trim().toUpperCase() === 'TRANSPARENT',
      start: start.utc,
      end,
      allDay: start.allDay,
      startDate: start.date,
      endDate: start.allDay ? endDate : undefined,
      tzid: prop(c, 'DTSTART')?.params.TZID,
      rrule: prop(c, 'RRULE')?.value.trim() || undefined,
      recurrenceId: ridTime?.utc,
      organizer: org ? person(org) : undefined,
      attendees: props(c, 'ATTENDEE').map((p) => ({
        ...person(p),
        partstat: (p.params.PARTSTAT ?? 'NEEDS-ACTION').toUpperCase(),
        rsvp: (p.params.RSVP ?? '').toUpperCase() === 'TRUE',
        role: (p.params.ROLE ?? 'REQ-PARTICIPANT').toUpperCase()
      })),
      joinUrl: findJoinUrl(...conference, location, url, description),
      rawStart: rawLine(prop(c, 'DTSTART')),
      rawEnd: endProp ? rawLine(endProp) : undefined,
      rawRecurrenceId: rid ? rawLine(rid) : undefined
    };
    const rr = ev.rrule ? parseRrule(ev.rrule) : null;
    if (opts.expand && rr && !ev.recurrenceId) {
      const ex = new Set<number>();
      for (const p of props(c, 'EXDATE')) for (const v of p.value.split(',')) {
        const tm = parseTime({ ...p, value: v }, zones);
        if (tm) ex.add(tm.utc);
      }
      masters.push({ ev, start, rr, exdates: ex });
    } else if (opts.expand && ev.recurrenceId !== undefined) overrides.push(ev);
    else events.push(ev);
  }
  if (opts.expand) {
    const { from, to } = opts.expand;
    for (const m of masters) {
      const dur = m.ev.end - m.ev.start;
      const dayCount = m.ev.allDay && m.ev.startDate && m.ev.endDate ? Math.max(1, Math.round((localMidnight(m.ev.endDate) - localMidnight(m.ev.startDate)) / DAY)) : 0;
      const untilUtc = m.rr.until ? (m.rr.until.utc ? wallMs(m.rr.until.wall) : m.rr.until.dateOnly ? wallMs({ ...m.rr.until.wall, h: 23, mi: 59, s: 59 }) : m.start.zone(m.rr.until.wall)) : Infinity;
      const toW = wallMs(toWall(to)) + 2 * DAY;
      let n = 0;
      for (const w of occurrences(m.start.wall, m.rr, toW)) {
        n++;
        if (m.rr.count && n > m.rr.count) break;
        const date = m.ev.allDay ? isoDate(w) : undefined;
        const s = m.ev.allDay ? localMidnight(date!) : m.start.zone(w);
        if ((m.rr.until?.dateOnly ? wallMs(w) : s) > untilUtc) break;
        if (m.exdates.has(s)) continue;
        if (overrides.some((o) => o.uid === m.ev.uid && o.recurrenceId === s)) continue;
        const endDate = date ? addDays(date, dayCount) : undefined;
        const e = date ? localMidnight(endDate!) : s + dur;
        if (e <= from || s >= to) continue;
        events.push({ ...m.ev, start: s, end: e, startDate: date, endDate, recurrenceId: s });
      }
    }
    for (const o of overrides) if (o.end > from && o.start < to) events.push(o);
  }
  return {
    method: (prop(cal, 'METHOD')?.value ?? '').trim().toUpperCase(),
    prodid: (prop(cal, 'PRODID')?.value ?? '').trim(),
    events
  };
}

function rawLine(p: IcsProp | undefined): string | undefined {
  if (!p) return undefined;
  const params = Object.entries(p.params)
    .map(([k, v]) => `;${k}=${/[;:,]/.test(v) ? `"${v}"` : v}`)
    .join('');
  return `${p.name}${params}:${p.value}`;
}

// Huvudhändelsen i en inbjudan: den utan RECURRENCE-ID, annars den första.
export function mainEvent(cal: IcsCalendar): IcsEvent | null {
  return cal.events.find((e) => e.recurrenceId === undefined) ?? cal.events[0] ?? null;
}

// Skrivning

const encoder = new TextEncoder();

// Viker raden till högst 75 oktetter, utan att dela ett tecken.
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let size = 0;
  const limit = () => (out.length ? 74 : 75);
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (size + n > limit()) {
      out.push(cur);
      cur = '';
      size = 0;
    }
    cur += ch;
    size += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function serializeComponent(c: IcsComponent): string {
  const lines: string[] = [`BEGIN:${c.name}`];
  const write = (comp: IcsComponent) => {
    for (const p of comp.props) lines.push(foldLine(rawLine(p)!));
    for (const child of comp.children) {
      lines.push(`BEGIN:${child.name}`);
      write(child);
      lines.push(`END:${child.name}`);
    }
  };
  write(c);
  lines.push(`END:${c.name}`);
  return lines.join('\r\n') + '\r\n';
}

const P = (name: string, value: string, params: Record<string, string> = {}): IcsProp => ({ name, params, value });

function personProp(name: string, p: IcsPerson, extra: Record<string, string> = {}): IcsProp {
  const params: Record<string, string> = {};
  if (p.name) params.CN = p.name.replace(/"/g, "'");
  return P(name, `mailto:${p.email}`, { ...params, ...extra });
}

function rawToProp(raw: string | undefined): IcsProp | null {
  return raw ? parseLine(raw) : null;
}

export type PartStat = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED';

// Svaret till organisatören (METHOD:REPLY) med bara den egna deltagaren.
export function buildReply(ev: IcsEvent, me: IcsPerson, partstat: PartStat, opts: { comment?: string; prodid?: string; now?: number } = {}): string {
  const vevent: IcsComponent = { name: 'VEVENT', props: [], children: [] };
  vevent.props.push(P('UID', ev.uid));
  vevent.props.push(P('SEQUENCE', String(ev.sequence)));
  vevent.props.push(P('DTSTAMP', formatUtc(opts.now ?? Date.now())));
  vevent.props.push(rawToProp(ev.rawStart) ?? (ev.allDay ? P('DTSTART', ev.startDate!.replace(/-/g, ''), { VALUE: 'DATE' }) : P('DTSTART', formatUtc(ev.start))));
  const end = rawToProp(ev.rawEnd);
  if (end) vevent.props.push(end);
  else if (!ev.allDay) vevent.props.push(P('DTEND', formatUtc(ev.end)));
  const rid = rawToProp(ev.rawRecurrenceId);
  if (rid) vevent.props.push(rid);
  if (ev.summary) vevent.props.push(P('SUMMARY', escapeText(ev.summary)));
  if (ev.organizer) vevent.props.push(personProp('ORGANIZER', ev.organizer));
  vevent.props.push(personProp('ATTENDEE', me, { PARTSTAT: partstat }));
  if (opts.comment?.trim()) vevent.props.push(P('COMMENT', escapeText(opts.comment.trim())));
  const cal: IcsComponent = {
    name: 'VCALENDAR',
    props: [P('PRODID', opts.prodid ?? PRODID), P('VERSION', '2.0'), P('CALSCALE', 'GREGORIAN'), P('METHOD', 'REPLY')],
    children: [vevent]
  };
  return serializeComponent(cal);
}

export interface OutEvent {
  uid: string;
  sequence?: number;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  startDate?: string;
  endDate?: string;
  location?: string;
  description?: string;
  organizer?: IcsPerson;
  attendees?: (IcsPerson & { partstat?: string; rsvp?: boolean })[];
  status?: string;
}

function eventProps(ev: OutEvent, now: number): IcsProp[] {
  const out: IcsProp[] = [P('UID', ev.uid), P('DTSTAMP', formatUtc(now)), P('SEQUENCE', String(ev.sequence ?? 0))];
  if (ev.allDay) {
    const sd = ev.startDate ?? isoDate(toWall(ev.start - new Date(ev.start).getTimezoneOffset() * 60000));
    const ed = ev.endDate ?? addDays(sd, 1);
    out.push(P('DTSTART', sd.replace(/-/g, ''), { VALUE: 'DATE' }), P('DTEND', ed.replace(/-/g, ''), { VALUE: 'DATE' }));
  } else out.push(P('DTSTART', formatUtc(ev.start)), P('DTEND', formatUtc(ev.end)));
  out.push(P('SUMMARY', escapeText(ev.title)));
  if (ev.location) out.push(P('LOCATION', escapeText(ev.location)));
  if (ev.description) out.push(P('DESCRIPTION', escapeText(ev.description)));
  if (ev.status) out.push(P('STATUS', ev.status));
  if (ev.organizer && ev.attendees?.length) out.push(personProp('ORGANIZER', ev.organizer));
  for (const a of ev.attendees ?? []) {
    const params: Record<string, string> = { ROLE: 'REQ-PARTICIPANT', PARTSTAT: a.partstat ?? 'NEEDS-ACTION' };
    if (a.rsvp !== false) params.RSVP = 'TRUE';
    out.push(personProp('ATTENDEE', a, params));
  }
  return out;
}

// En ny händelse som kalenderfil, med METHOD när den skickas som inbjudan.
export function buildEvent(ev: OutEvent, opts: { method?: 'REQUEST' | 'CANCEL' | 'PUBLISH'; now?: number; prodid?: string } = {}): string {
  const cal: IcsComponent = {
    name: 'VCALENDAR',
    props: [P('PRODID', opts.prodid ?? PRODID), P('VERSION', '2.0'), P('CALSCALE', 'GREGORIAN')],
    children: [{ name: 'VEVENT', props: eventProps(ev, opts.now ?? Date.now()), children: [] }]
  };
  if (opts.method) cal.props.push(P('METHOD', opts.method));
  return serializeComponent(cal);
}

// Byter fälten i en befintlig kalenderfil och behåller resten (larm, tidszoner, upprepning).
export function patchIcs(original: string, uid: string, patch: Partial<OutEvent>, opts: { now?: number; partstatFor?: { email: string; partstat: string } } = {}): string {
  const roots = parseComponents(original);
  const cal = roots.find((c) => c.name === 'VCALENDAR');
  if (!cal) throw new Error('Not a calendar file');
  cal.props = cal.props.filter((p) => p.name !== 'METHOD');
  const now = opts.now ?? Date.now();
  for (const ev of cal.children.filter((c) => c.name === 'VEVENT' && (prop(c, 'UID')?.value.trim() ?? '') === uid)) {
    const isMaster = !prop(ev, 'RECURRENCE-ID');
    const set = (name: string, value: IcsProp | IcsProp[] | null) => {
      const list = Array.isArray(value) ? value : value ? [value] : [];
      const idx = ev.props.findIndex((p) => p.name === name);
      ev.props = ev.props.filter((p) => p.name !== name);
      ev.props.splice(idx < 0 ? ev.props.length : idx, 0, ...list);
    };
    const changed = Object.keys(patch).length > 0;
    if (changed) {
      set('DTSTAMP', P('DTSTAMP', formatUtc(now)));
      set('SEQUENCE', P('SEQUENCE', String((Number(prop(ev, 'SEQUENCE')?.value) || 0) + (patch.start !== undefined || patch.end !== undefined || patch.allDay !== undefined ? 1 : 0))));
    }
    if (patch.title !== undefined) set('SUMMARY', P('SUMMARY', escapeText(patch.title)));
    if (patch.location !== undefined) set('LOCATION', patch.location ? P('LOCATION', escapeText(patch.location)) : null);
    if (patch.description !== undefined) set('DESCRIPTION', patch.description ? P('DESCRIPTION', escapeText(patch.description)) : null);
    if (isMaster && (patch.start !== undefined || patch.end !== undefined || patch.allDay !== undefined)) {
      const full = eventProps({ uid, title: '', start: patch.start ?? 0, end: patch.end ?? 0, allDay: !!patch.allDay, startDate: patch.startDate, endDate: patch.endDate }, now);
      set('DURATION', null);
      set('DTSTART', full.find((p) => p.name === 'DTSTART')!);
      set('DTEND', full.find((p) => p.name === 'DTEND')!);
    }
    if (patch.attendees !== undefined) {
      const org = patch.organizer;
      if (org && !prop(ev, 'ORGANIZER') && patch.attendees.length) set('ORGANIZER', personProp('ORGANIZER', org));
      const old = props(ev, 'ATTENDEE');
      set(
        'ATTENDEE',
        patch.attendees.map((a) => {
          const prev = old.find((p) => mailtoAddress(p.value) === a.email.toLowerCase());
          return prev ?? personProp('ATTENDEE', a, { ROLE: 'REQ-PARTICIPANT', PARTSTAT: a.partstat ?? 'NEEDS-ACTION', RSVP: 'TRUE' });
        })
      );
    }
    if (opts.partstatFor) {
      const me = opts.partstatFor.email.toLowerCase();
      for (const p of props(ev, 'ATTENDEE')) if (mailtoAddress(p.value) === me) p.params.PARTSTAT = opts.partstatFor.partstat;
    }
  }
  return serializeComponent(cal);
}

// Hela kalendern utan METHOD, till exempel för att spara en inbjudan i en CalDAV-kalender.
export function withoutMethod(text: string): string {
  const cal = parseComponents(text).find((c) => c.name === 'VCALENDAR');
  if (!cal) return text;
  cal.props = cal.props.filter((p) => p.name !== 'METHOD');
  return serializeComponent(cal);
}

// Svaret i inbjudan för en viss adress.
export function partstatOf(ev: IcsEvent, emails: string[]): string | undefined {
  const set = new Set(emails.map((e) => e.toLowerCase()));
  return ev.attendees.find((a) => set.has(a.email))?.partstat;
}
