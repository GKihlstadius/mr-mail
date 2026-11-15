// CalDAV (RFC 4791) med upptäckt enligt RFC 6764: iCloud, Fastmail och andra. Basic-inloggning med kontots lösenord.
import { randomUUID } from 'node:crypto';
import { eventId, type CalendarEvent, type CalendarInfo, type EventInput, type EventPerson } from '../../shared/calendar';
import {
  addDays,
  buildEvent,
  formatUtc,
  mainEvent,
  parseComponents,
  parseIcs,
  patchIcs,
  serializeComponent,
  withoutMethod,
  type IcsEvent
} from '../../shared/ics';
import type { Invitation, InviteResponse } from '../../shared/types';
import { t } from '../../shared/i18n';
import { CalendarAuthError, CalendarHttpError, STATUS_FROM_PARTSTAT, type CalendarProvider, type Fetch } from './provider';
import { child, escapeXml, find, findAll, multistatus, textOf } from './xml';
import { PARTSTAT } from '../invite';

export interface DavCreds {
  username: string;
  password: string;
}

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/" xmlns:cs="http://calendarserver.org/ns/"';

const auth = (c: DavCreds) => `Basic ${Buffer.from(`${c.username}:${c.password}`, 'utf8').toString('base64')}`;

const davTime = (ms: number) => formatUtc(ms);

async function dav(fetchFn: Fetch, creds: DavCreds, method: string, url: string, body?: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetchFn(url, {
    method,
    headers: {
      Authorization: auth(creds),
      ...(body ? { 'Content-Type': method === 'PUT' ? 'text/calendar; charset=utf-8' : 'application/xml; charset=utf-8' } : {}),
      ...headers
    },
    body,
    signal: AbortSignal.timeout(30_000)
  });
}

function resolve(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

// Adresser att börja leta på för ett konto.
export function caldavStarts(email: string, imapHost: string, provider: string, manual?: string, srv?: string[]): string[] {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  const out: string[] = [];
  if (manual?.trim()) out.push(/^https?:\/\//i.test(manual.trim()) ? manual.trim() : `https://${manual.trim()}`);
  if (provider === 'icloud' || /(^|\.)(icloud|me|mac)\.com$/.test(domain) || /\.mail\.me\.com$/i.test(imapHost)) out.push('https://caldav.icloud.com/');
  if (/(^|\.)fastmail\.(com|fm)$/.test(domain) || /fastmail\.com$/i.test(imapHost)) out.push('https://caldav.fastmail.com/dav/');
  out.push(...(srv ?? []));
  if (domain && !/^(gmail|googlemail|outlook|hotmail|live|msn)\./.test(domain)) out.push(`https://${domain}/.well-known/caldav`);
  return [...new Set(out)];
}

export interface DavDiscovery {
  home: string;
  autoSchedule: boolean;
}

// Hittar kalenderhemmet: current-user-principal, sedan calendar-home-set.
export async function discoverCalDav(starts: string[], creds: DavCreds, fetchFn: Fetch = fetch): Promise<DavDiscovery | null> {
  let authFailed = false;
  for (const start of starts) {
    try {
      const propfind = async (url: string, props: string, depth = '0') => {
        const res = await dav(fetchFn, creds, 'PROPFIND', url, `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop>${props}</d:prop></d:propfind>`, { Depth: depth });
        if (res.status === 401) {
          authFailed = true;
          return null;
        }
        if (res.status !== 207) return null;
        return { base: res.url || url, list: multistatus(await res.text()) };
      };
      const p = await propfind(start, '<d:current-user-principal/><c:calendar-home-set/><d:resourcetype/>');
      if (!p) continue;
      const first = p.list[0]?.props;
      let home = textOf(find(find(first, 'calendar-home-set'), 'href'));
      let base = p.base;
      if (!home) {
        const principal = textOf(find(find(first, 'current-user-principal'), 'href'));
        if (principal) {
          const q = await propfind(resolve(principal, base), '<c:calendar-home-set/>');
          home = textOf(find(find(q?.list[0]?.props, 'calendar-home-set'), 'href'));
          if (q) base = q.base;
        }
      }
      // Pekar adressen direkt på ett kalenderhem eller en kalender används den.
      if (!home && find(first, 'resourcetype') && (find(find(first, 'resourcetype'), 'calendar') || p.list.length)) home = start;
      if (!home) continue;
      const homeUrl = resolve(home, base);
      let autoSchedule = false;
      try {
        const opt = await dav(fetchFn, creds, 'OPTIONS', homeUrl);
        autoSchedule = /calendar-auto-schedule/i.test(opt.headers.get('dav') ?? '');
      } catch {
        /* utan OPTIONS antas att servern inte skickar inbjudningar själv */
      }
      return { home: homeUrl.endsWith('/') ? homeUrl : `${homeUrl}/`, autoSchedule };
    } catch {
      continue;
    }
  }
  if (authFailed) throw new CalendarAuthError(t('Kalenderservern godtog inte lösenordet.'));
  return null;
}

const PRIV_WRITE = ['write', 'write-content', 'all', 'bind'];

export class CalDavCalendar implements CalendarProvider {
  kind = 'caldav' as const;
  sendsInvitations: boolean;

  constructor(
    private accountId: string,
    private home: string,
    private creds: DavCreds,
    private me: string,
    private fetchFn: Fetch = fetch,
    autoSchedule = false
  ) {
    this.sendsInvitations = autoSchedule;
  }

  private req(method: string, url: string, body?: string, headers?: Record<string, string>) {
    return dav(this.fetchFn, this.creds, method, url, body, headers);
  }

  private async check(res: Response, what: string): Promise<void> {
    if (res.ok || res.status === 207) return;
    if (res.status === 401) throw new CalendarAuthError(t('Kalenderservern godtog inte lösenordet.'));
    if (res.status === 412) throw new CalendarHttpError(412, t('Händelsen har ändrats på servern. Uppdatera kalendern och försök igen.'));
    throw new CalendarHttpError(res.status, t('Kalenderservern svarade med ett fel ({detail}).', { detail: `${what} ${res.status}` }));
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const res = await this.req(
      'PROPFIND',
      this.home,
      `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop><d:displayname/><d:resourcetype/><a:calendar-color/><c:supported-calendar-component-set/><d:current-user-privilege-set/></d:prop></d:propfind>`,
      { Depth: '1' }
    );
    await this.check(res, 'PROPFIND');
    const base = res.url || this.home;
    const out: CalendarInfo[] = [];
    for (const r of multistatus(await res.text())) {
      if (!find(find(r.props, 'resourcetype'), 'calendar')) continue;
      const comps = findAll(find(r.props, 'supported-calendar-component-set'), 'comp').map((c) => (c.attrs.name ?? '').toUpperCase());
      if (comps.length && !comps.includes('VEVENT')) continue;
      const privs = find(r.props, 'current-user-privilege-set');
      const readOnly = !!privs && !PRIV_WRITE.some((p) => find(privs, p));
      const color = textOf(find(r.props, 'calendar-color'));
      const id = resolve(r.href, base);
      out.push({
        accountId: this.accountId,
        id: id.endsWith('/') ? id : `${id}/`,
        name: textOf(find(r.props, 'displayname')) || decodeURIComponent(id.replace(/\/$/, '').split('/').pop() ?? '') || t('Kalender'),
        color: /^#[0-9a-f]{6}/i.test(color) ? color.slice(0, 7) : undefined,
        primary: false,
        readOnly
      });
    }
    if (out.length && !out.some((c) => c.primary)) (out.find((c) => !c.readOnly) ?? out[0]).primary = true;
    return out;
  }

  private toEvent(cal: CalendarInfo, href: string, etag: string | undefined, ev: IcsEvent): CalendarEvent {
    const me = this.me.toLowerCase();
    const mine = ev.attendees.find((a) => a.email === me);
    return {
      id: eventId(this.accountId, cal.id, href, ev.recurrenceId),
      accountId: this.accountId,
      calendarId: cal.id,
      remoteId: href,
      uid: ev.uid,
      title: ev.summary,
      location: ev.location,
      description: ev.description,
      joinUrl: ev.joinUrl,
      organizer: ev.organizer ? { name: ev.organizer.name, email: ev.organizer.email } : undefined,
      attendees: ev.attendees.map((a) => ({ name: a.name, email: a.email, status: STATUS_FROM_PARTSTAT[a.partstat] })),
      status: ev.status === 'CANCELLED' ? 'cancelled' : ev.status === 'TENTATIVE' ? 'tentative' : 'confirmed',
      busy: !ev.transparent,
      recurring: !!ev.rrule || ev.recurrenceId !== undefined,
      recurrenceStart: ev.recurrenceId,
      isOrganizer: !ev.organizer || ev.organizer.email === me,
      myStatus: mine ? STATUS_FROM_PARTSTAT[mine.partstat] : undefined,
      etag,
      start: ev.start,
      end: ev.end,
      allDay: ev.allDay,
      startDate: ev.startDate,
      endDate: ev.endDate
    };
  }

  private async query(cal: CalendarInfo, filter: string): Promise<{ href: string; etag?: string; ics: string }[]> {
    const res = await this.req(
      'REPORT',
      cal.id,
      `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${NS}><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">${filter}</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
      { Depth: '1' }
    );
    await this.check(res, 'REPORT');
    const base = res.url || cal.id;
    return multistatus(await res.text())
      .map((r) => ({ href: resolve(r.href, base), etag: textOf(child(r.props, 'getetag')) || undefined, ics: textOf(child(r.props, 'calendar-data')) }))
      .filter((r) => r.ics.includes('BEGIN:VCALENDAR'));
  }

  async listEvents(cal: CalendarInfo, from: number, to: number): Promise<CalendarEvent[]> {
    const rows = await this.query(cal, `<c:time-range start="${davTime(from)}" end="${davTime(to)}"/>`);
    const out: CalendarEvent[] = [];
    for (const r of rows) {
      const parsed = parseIcs(r.ics, { expand: { from, to } });
      for (const ev of parsed?.events ?? []) if (ev.end > from && ev.start < to && ev.status !== 'CANCELLED') out.push(this.toEvent(cal, r.href, r.etag, ev));
    }
    return out;
  }

  private async get(href: string): Promise<{ ics: string; etag?: string }> {
    const res = await this.req('GET', href);
    await this.check(res, 'GET');
    return { ics: await res.text(), etag: res.headers.get('etag') ?? undefined };
  }

  async createEvent(cal: CalendarInfo, input: EventInput, me: EventPerson): Promise<CalendarEvent> {
    const uid = `${randomUUID()}@mr-mail`;
    const href = `${cal.id}${encodeURIComponent(uid)}.ics`;
    const ics = buildEvent({
      uid,
      title: input.title,
      start: input.start,
      end: input.end,
      allDay: input.allDay,
      startDate: input.startDate,
      endDate: input.endDate,
      location: input.location,
      description: input.description,
      organizer: input.attendees?.length ? { name: me.name, email: me.email } : undefined,
      attendees: input.attendees?.map((a) => ({ name: a.name ?? '', email: a.email.toLowerCase() }))
    });
    const res = await this.req('PUT', href, ics, { 'If-None-Match': '*' });
    await this.check(res, 'PUT');
    return this.toEvent(cal, href, res.headers.get('etag') ?? undefined, mainEvent(parseIcs(ics)!)!);
  }

  async updateEvent(cal: CalendarInfo, ev: CalendarEvent, patch: Partial<EventInput>, me: EventPerson): Promise<CalendarEvent> {
    const cur = await this.get(ev.remoteId);
    if (ev.recurring && (patch.start !== undefined || patch.end !== undefined || patch.allDay !== undefined)) {
      throw new Error(t('Tiden för en återkommande händelse ändras i kalenderns egen app.'));
    }
    const next = patchIcs(cur.ics, ev.uid, {
      ...patch,
      organizer: { name: me.name, email: me.email },
      attendees: patch.attendees?.map((a) => ({ name: a.name ?? '', email: a.email.toLowerCase() }))
    });
    const res = await this.req('PUT', ev.remoteId, next, cur.etag ? { 'If-Match': cur.etag } : {});
    await this.check(res, 'PUT');
    const parsed = parseIcs(next)!;
    const updated = (ev.recurrenceStart !== undefined ? parsed.events.find((e) => e.recurrenceId === ev.recurrenceStart) : undefined) ?? mainEvent(parsed)!;
    const out = this.toEvent(cal, ev.remoteId, res.headers.get('etag') ?? undefined, updated);
    if (ev.recurrenceStart !== undefined && updated.recurrenceId === undefined) {
      // Ett tillfälle i en serie: behåll tiden för tillfället.
      return { ...out, id: ev.id, start: ev.start, end: ev.end, startDate: ev.startDate, endDate: ev.endDate, recurrenceStart: ev.recurrenceStart };
    }
    return out;
  }

  async deleteEvent(_cal: CalendarInfo, ev: CalendarEvent): Promise<void> {
    if (ev.recurring && ev.recurrenceStart !== undefined) {
      // Ett tillfälle i en serie tas bort med EXDATE på huvudhändelsen.
      const cur = await this.get(ev.remoteId);
      const cal = parseComponents(cur.ics).find((c) => c.name === 'VCALENDAR');
      const master = cal?.children.find((c) => c.name === 'VEVENT' && !c.props.some((p) => p.name === 'RECURRENCE-ID'));
      if (cal && master) {
        cal.children = cal.children.filter((c) => !(c.name === 'VEVENT' && c.props.some((p) => p.name === 'RECURRENCE-ID') && parseIcs(serializeComponent({ name: 'VCALENDAR', props: [], children: [c] }))?.events[0]?.recurrenceId === ev.recurrenceStart));
        master.props.push(ev.allDay ? { name: 'EXDATE', params: { VALUE: 'DATE' }, value: (ev.startDate ?? '').replace(/-/g, '') } : { name: 'EXDATE', params: {}, value: formatUtc(ev.recurrenceStart) });
        const res = await this.req('PUT', ev.remoteId, serializeComponent(cal), cur.etag ? { 'If-Match': cur.etag } : {});
        await this.check(res, 'PUT');
        return;
      }
    }
    const res = await this.req('DELETE', ev.remoteId, undefined, ev.etag ? { 'If-Match': ev.etag } : {});
    if (res.status === 404) return;
    await this.check(res, 'DELETE');
  }

  // Kalenderfil att skicka som inbjudan (REQUEST) eller inställt (CANCEL) när servern inte gör det själv.
  async imip(ev: CalendarEvent, method: 'REQUEST' | 'CANCEL'): Promise<string> {
    const cur = await this.get(ev.remoteId);
    const cal = parseComponents(cur.ics).find((c) => c.name === 'VCALENDAR')!;
    cal.props = cal.props.filter((p) => p.name !== 'METHOD');
    cal.props.push({ name: 'METHOD', params: {}, value: method });
    if (method === 'CANCEL') {
      for (const v of cal.children.filter((c) => c.name === 'VEVENT')) {
        v.props = v.props.filter((p) => p.name !== 'STATUS');
        v.props.push({ name: 'STATUS', params: {}, value: 'CANCELLED' });
        const seq = v.props.find((p) => p.name === 'SEQUENCE');
        if (seq) seq.value = String((Number(seq.value) || 0) + 1);
        else v.props.push({ name: 'SEQUENCE', params: {}, value: '1' });
      }
    }
    return serializeComponent(cal);
  }

  async saveInvite(cal: CalendarInfo, inv: Invitation, me: EventPerson, response: InviteResponse | null): Promise<void> {
    const uid = inv.event.uid;
    const rows = await this.query(cal, `<c:prop-filter name="UID"><c:text-match collation="i;octet">${escapeXml(uid)}</c:text-match></c:prop-filter>`).catch(() => []);
    const existing = rows[0];
    // Schedule-Reply: F, svaret har redan skickats som mejl (RFC 6638).
    const headers = { 'Schedule-Reply': 'F' };
    const partstat = response ? { email: me.email, partstat: PARTSTAT[response] } : undefined;
    if (existing) {
      if (!partstat) return;
      const next = patchIcs(existing.ics, uid, {}, { partstatFor: partstat });
      const res = await this.req('PUT', existing.href, next, { ...headers, ...(existing.etag ? { 'If-Match': existing.etag } : {}) });
      await this.check(res, 'PUT');
      return;
    }
    if (response === 'decline') return;
    const ev = inv.event;
    const base = inv.ics
      ? withoutMethod(inv.ics)
      : buildEvent({
          uid,
          sequence: ev.sequence,
          title: ev.summary,
          start: ev.start,
          end: ev.end,
          allDay: ev.allDay,
          startDate: ev.startDate,
          endDate: ev.endDate ?? (ev.startDate ? addDays(ev.startDate, 1) : undefined),
          location: ev.location,
          description: ev.description,
          organizer: ev.organizer,
          attendees: ev.attendees
        });
    const ics = partstat ? patchIcs(base, uid, {}, { partstatFor: partstat }) : base;
    const href = `${cal.id}${encodeURIComponent(uid.replace(/[/\\?#%]/g, '_'))}.ics`;
    const res = await this.req('PUT', href, ics, { ...headers, 'If-None-Match': '*' });
    await this.check(res, 'PUT');
  }
}

