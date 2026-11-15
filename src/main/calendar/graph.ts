// Microsoft Graph (Outlook, Microsoft 365). Token för graph.microsoft.com, skild från e-postens token.
import { eventId, localDate, type CalendarEvent, type CalendarInfo, type EventInput, type EventPerson } from '../../shared/calendar';
import { addDays, findJoinUrl, localMidnight } from '../../shared/ics';
import type { Invitation, InviteResponse } from '../../shared/types';
import { t } from '../../shared/i18n';
import { CalendarAuthError, CalendarHttpError, readJson, type CalendarProvider, type Fetch } from './provider';
import { htmlToText } from '../parse';

export const GRAPH_API = 'https://graph.microsoft.com/v1.0';

const STATUS: Record<string, EventPerson['status']> = {
  accepted: 'accepted',
  organizer: 'accepted',
  tentativelyAccepted: 'tentative',
  declined: 'declined',
  notResponded: 'needs-action',
  none: 'needs-action'
};

// Graph vill ha väggklocka utan zon och zonen för sig: allt skickas i UTC.
const graphUtc = (ms: number) => new Date(ms).toISOString().replace(/Z$/, '').replace(/\.\d{3}$/, '');
const parseUtc = (s: string | undefined) => (s ? Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(s) ? s : `${s}Z`) : NaN);

export class GraphCalendar implements CalendarProvider {
  kind = 'microsoft' as const;
  sendsInvitations = true;

  constructor(
    private accountId: string,
    private token: () => Promise<string>,
    private fetchFn: Fetch = fetch,
    private base = GRAPH_API,
    private zone = 'UTC'
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const url = path.startsWith('http') ? path : `${this.base}${path}`;
    const res = await this.fetchFn(url, {
      method,
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        Accept: 'application/json',
        Prefer: 'outlook.timezone="UTC"',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 204 || res.status === 202) return {};
    const data = await readJson(res);
    if (res.ok) return data;
    const code = String(data?.error?.code ?? '');
    if (res.status === 401 || /InvalidAuthenticationToken|AccessDenied|ErrorAccessDenied/i.test(code)) throw new CalendarAuthError();
    throw new CalendarHttpError(res.status, t('Microsoft svarade med ett fel ({detail}).', { detail: String(data?.error?.message ?? res.status) }));
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const data = await this.call('GET', '/me/calendars?$top=50');
    return (data.value ?? []).map((c: any) => ({
      accountId: this.accountId,
      id: String(c.id),
      name: String(c.name ?? ''),
      color: typeof c.hexColor === 'string' && c.hexColor ? c.hexColor : undefined,
      primary: !!c.isDefaultCalendar,
      readOnly: c.canEdit === false
    }));
  }

  map(cal: CalendarInfo, e: any): CalendarEvent {
    const allDay = !!e.isAllDay;
    const s = parseUtc(e.start?.dateTime);
    const en = parseUtc(e.end?.dateTime);
    // Heldagar kommer som midnatt i händelsens zon, datumdelen räcker.
    const startDate = allDay ? String(e.start?.dateTime ?? '').slice(0, 10) : undefined;
    const endDate = allDay ? String(e.end?.dateTime ?? '').slice(0, 10) || addDays(startDate!, 1) : undefined;
    const body = e.body?.contentType === 'html' ? htmlToText(String(e.body?.content ?? '')) : String(e.body?.content ?? e.bodyPreview ?? '');
    const join = e.onlineMeeting?.joinUrl ?? e.onlineMeetingUrl ?? undefined;
    return {
      id: eventId(this.accountId, cal.id, e.id),
      accountId: this.accountId,
      calendarId: cal.id,
      remoteId: String(e.id),
      uid: String(e.iCalUId ?? e.id),
      title: String(e.subject ?? ''),
      location: String(e.location?.displayName ?? ''),
      description: body.trim(),
      joinUrl: join ?? findJoinUrl(e.location?.displayName, body),
      organizer: e.organizer?.emailAddress?.address ? { name: e.organizer.emailAddress.name ?? '', email: String(e.organizer.emailAddress.address).toLowerCase() } : undefined,
      attendees: (e.attendees ?? [])
        .filter((a: any) => a.type !== 'resource')
        .map((a: any) => ({ name: a.emailAddress?.name ?? '', email: String(a.emailAddress?.address ?? '').toLowerCase(), status: STATUS[a.status?.response ?? 'none'] })),
      status: e.isCancelled ? 'cancelled' : e.showAs === 'tentative' ? 'tentative' : 'confirmed',
      busy: e.showAs !== 'free' && e.showAs !== 'workingElsewhere',
      recurring: e.type === 'occurrence' || e.type === 'exception',
      recurrenceStart: e.originalStart ? Date.parse(e.originalStart) : undefined,
      isOrganizer: !!e.isOrganizer,
      myStatus: e.isOrganizer ? undefined : STATUS[e.responseStatus?.response ?? 'none'],
      etag: e.changeKey,
      link: e.webLink,
      start: allDay ? localMidnight(startDate!) : s,
      end: allDay ? localMidnight(endDate!) : en,
      allDay,
      startDate,
      endDate
    };
  }

  async listEvents(cal: CalendarInfo, from: number, to: number): Promise<CalendarEvent[]> {
    const out: CalendarEvent[] = [];
    const q = new URLSearchParams({ startDateTime: new Date(from).toISOString(), endDateTime: new Date(to).toISOString(), $top: '250' });
    let next: string = `/me/calendars/${encodeURIComponent(cal.id)}/calendarView?${q}`;
    for (let i = 0; i < 10 && next; i++) {
      const data = await this.call('GET', next);
      for (const e of data.value ?? []) if (!e.isCancelled) out.push(this.map(cal, e));
      next = data['@odata.nextLink'] ?? '';
    }
    return out;
  }

  private body(input: Partial<EventInput>) {
    const b: Record<string, unknown> = {};
    if (input.title !== undefined) b.subject = input.title;
    if (input.location !== undefined) b.location = { displayName: input.location };
    if (input.description !== undefined) b.body = { contentType: 'text', content: input.description };
    if (input.start !== undefined || input.allDay !== undefined) {
      if (input.allDay) {
        const sd = input.startDate ?? localDate(input.start!);
        b.isAllDay = true;
        b.start = { dateTime: `${sd}T00:00:00`, timeZone: this.zone };
        b.end = { dateTime: `${input.endDate ?? addDays(sd, 1)}T00:00:00`, timeZone: this.zone };
      } else {
        b.isAllDay = false;
        b.start = { dateTime: graphUtc(input.start!), timeZone: 'UTC' };
        b.end = { dateTime: graphUtc(input.end ?? input.start!), timeZone: 'UTC' };
      }
    }
    if (input.attendees !== undefined) b.attendees = input.attendees.map((a) => ({ emailAddress: { address: a.email, name: a.name || a.email }, type: 'required' }));
    return b;
  }

  async createEvent(cal: CalendarInfo, input: EventInput): Promise<CalendarEvent> {
    return this.map(cal, await this.call('POST', `/me/calendars/${encodeURIComponent(cal.id)}/events`, this.body(input)));
  }

  async updateEvent(cal: CalendarInfo, ev: CalendarEvent, patch: Partial<EventInput>): Promise<CalendarEvent> {
    return this.map(cal, await this.call('PATCH', `/me/events/${encodeURIComponent(ev.remoteId)}`, this.body(patch)));
  }

  async deleteEvent(_cal: CalendarInfo, ev: CalendarEvent): Promise<void> {
    // Organisatören ställer in mötet, så att deltagarna får besked. Annars tas händelsen bara bort.
    if (ev.isOrganizer && ev.attendees.length) await this.call('POST', `/me/events/${encodeURIComponent(ev.remoteId)}/cancel`, { comment: '' });
    else await this.call('DELETE', `/me/events/${encodeURIComponent(ev.remoteId)}`);
  }

  async saveInvite(cal: CalendarInfo, inv: Invitation, _me: EventPerson, response: InviteResponse | null): Promise<void> {
    const ev = inv.event;
    const uid = ev.uid.replace(/'/g, "''");
    const found = await this.call('GET', `/me/events?$filter=${encodeURIComponent(`iCalUId eq '${uid}'`)}&$top=5`);
    const existing = found.value?.[0];
    if (existing) {
      if (!response) return;
      const action = response === 'accept' ? 'accept' : response === 'tentative' ? 'tentativelyAccept' : 'decline';
      // Svaret har redan skickats som mejl, Exchange ska inte skicka ett till.
      await this.call('POST', `/me/events/${encodeURIComponent(existing.id)}/${action}`, { sendResponse: false });
      return;
    }
    if (response === 'decline') return;
    // Utan deltagare, annars skickar Exchange nya inbjudningar.
    const who = ev.organizer ? `${ev.organizer.name || ev.organizer.email} <${ev.organizer.email}>` : '';
    await this.call('POST', `/me/calendars/${encodeURIComponent(cal.id)}/events`, {
      ...this.body({ title: ev.summary, start: ev.start, end: ev.end, allDay: ev.allDay, startDate: ev.startDate, endDate: ev.endDate, location: ev.location }),
      body: { contentType: 'text', content: [who ? t('Organisatör: {name}', { name: who }) : '', ev.joinUrl ?? '', ev.description].filter(Boolean).join('\n\n') },
      showAs: response === 'tentative' ? 'tentative' : 'busy'
    });
  }
}
