// Google Calendar API v3 över fetch. Token kommer från kontots OAuth-inloggning.
import { eventId, localDate, type CalendarEvent, type CalendarInfo, type EventInput, type EventPerson } from '../../shared/calendar';
import { addDays, findJoinUrl, localMidnight } from '../../shared/ics';
import type { Invitation, InviteResponse } from '../../shared/types';
import { t } from '../../shared/i18n';
import { CalendarAuthError, CalendarHttpError, RESPONSE_STATUS, isoUtc, readJson, type CalendarProvider, type Fetch } from './provider';

export const GOOGLE_API = 'https://www.googleapis.com/calendar/v3';

const STATUS: Record<string, EventPerson['status']> = { accepted: 'accepted', tentative: 'tentative', declined: 'declined', needsAction: 'needs-action' };
const TO_GOOGLE: Record<string, string> = { accepted: 'accepted', tentative: 'tentative', declined: 'declined', 'needs-action': 'needsAction' };

export class GoogleCalendar implements CalendarProvider {
  kind = 'google' as const;
  sendsInvitations = true;

  constructor(
    private accountId: string,
    private token: () => Promise<string>,
    private fetchFn: Fetch = fetch,
    private base = GOOGLE_API
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.token()}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 204) return {};
    const data = await readJson(res);
    if (res.ok) return data;
    const reason = String(data?.error?.errors?.[0]?.reason ?? data?.error?.status ?? '');
    if (res.status === 401 || /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|PERMISSION_DENIED/i.test(reason) && /scope/i.test(String(data?.error?.message ?? ''))) {
      throw new CalendarAuthError();
    }
    if (/accessNotConfigured|SERVICE_DISABLED/i.test(reason) || /has not been used in project|is disabled/i.test(String(data?.error?.message ?? ''))) {
      throw new CalendarHttpError(res.status, t('Google Calendar API är inte aktiverat i ditt Google Cloud-projekt. Se docs/oauth.md.'));
    }
    throw new CalendarHttpError(res.status, t('Google svarade med ett fel ({detail}).', { detail: String(data?.error?.message ?? res.status) }));
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const data = await this.call('GET', '/users/me/calendarList?minAccessRole=reader&maxResults=100');
    return (data.items ?? [])
      .filter((c: any) => !c.deleted && !c.hidden)
      .map((c: any) => ({
        accountId: this.accountId,
        id: String(c.id),
        name: String(c.summaryOverride || c.summary || c.id),
        color: c.backgroundColor,
        primary: !!c.primary,
        readOnly: c.accessRole !== 'owner' && c.accessRole !== 'writer'
      }));
  }

  map(cal: CalendarInfo, e: any): CalendarEvent {
    const allDay = !!e.start?.date;
    const startDate = allDay ? String(e.start.date) : undefined;
    const endDate = allDay ? String(e.end?.date ?? addDays(startDate!, 1)) : undefined;
    const start = allDay ? localMidnight(startDate!) : Date.parse(e.start?.dateTime);
    const end = allDay ? localMidnight(endDate!) : Date.parse(e.end?.dateTime ?? e.start?.dateTime);
    const attendees: EventPerson[] = (e.attendees ?? []).filter((a: any) => !a.resource).map((a: any) => ({ name: a.displayName ?? '', email: String(a.email ?? '').toLowerCase(), status: STATUS[a.responseStatus] }));
    const self = (e.attendees ?? []).find((a: any) => a.self);
    const video = (e.conferenceData?.entryPoints ?? []).find((p: any) => p.entryPointType === 'video')?.uri;
    return {
      id: eventId(this.accountId, cal.id, e.id),
      accountId: this.accountId,
      calendarId: cal.id,
      remoteId: String(e.id),
      uid: String(e.iCalUID ?? e.id),
      title: String(e.summary ?? ''),
      location: String(e.location ?? ''),
      description: String(e.description ?? ''),
      joinUrl: e.hangoutLink ?? video ?? findJoinUrl(e.location, e.description),
      organizer: e.organizer?.email ? { name: e.organizer.displayName ?? '', email: String(e.organizer.email).toLowerCase() } : undefined,
      attendees,
      status: e.status === 'cancelled' ? 'cancelled' : e.status === 'tentative' ? 'tentative' : 'confirmed',
      busy: e.transparency !== 'transparent',
      recurring: !!e.recurringEventId,
      recurrenceStart: e.originalStartTime ? Date.parse(e.originalStartTime.dateTime ?? e.originalStartTime.date) : undefined,
      isOrganizer: !!e.organizer?.self || !e.organizer,
      myStatus: self ? STATUS[self.responseStatus] : undefined,
      etag: e.etag,
      link: e.htmlLink,
      start,
      end,
      allDay,
      startDate,
      endDate
    };
  }

  async listEvents(cal: CalendarInfo, from: number, to: number): Promise<CalendarEvent[]> {
    const out: CalendarEvent[] = [];
    let page = '';
    for (let i = 0; i < 10; i++) {
      const q = new URLSearchParams({ timeMin: isoUtc(from), timeMax: isoUtc(to), singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
      if (page) q.set('pageToken', page);
      const data = await this.call('GET', `/calendars/${encodeURIComponent(cal.id)}/events?${q}`);
      for (const e of data.items ?? []) if (e.status !== 'cancelled') out.push(this.map(cal, e));
      page = data.nextPageToken ?? '';
      if (!page) break;
    }
    return out;
  }

  private body(input: Partial<EventInput>) {
    const b: Record<string, unknown> = {};
    if (input.title !== undefined) b.summary = input.title;
    if (input.location !== undefined) b.location = input.location;
    if (input.description !== undefined) b.description = input.description;
    if (input.start !== undefined || input.allDay !== undefined) {
      if (input.allDay) {
        const sd = input.startDate ?? localDate(input.start!);
        b.start = { date: sd };
        b.end = { date: input.endDate ?? addDays(sd, 1) };
      } else {
        b.start = { dateTime: isoUtc(input.start!) };
        b.end = { dateTime: isoUtc(input.end ?? input.start!) };
      }
    }
    if (input.attendees !== undefined) b.attendees = input.attendees.map((a) => ({ email: a.email, ...(a.name ? { displayName: a.name } : {}) }));
    return b;
  }

  async createEvent(cal: CalendarInfo, input: EventInput): Promise<CalendarEvent> {
    const send = input.attendees?.length ? 'all' : 'none';
    const e = await this.call('POST', `/calendars/${encodeURIComponent(cal.id)}/events?sendUpdates=${send}`, this.body(input));
    return this.map(cal, e);
  }

  async updateEvent(cal: CalendarInfo, ev: CalendarEvent, patch: Partial<EventInput>): Promise<CalendarEvent> {
    const body = this.body(patch);
    // Behåll deltagarnas svar när listan skickas om.
    if (patch.attendees) {
      body.attendees = patch.attendees.map((a) => {
        const old = ev.attendees.find((x) => x.email === a.email.toLowerCase());
        return { email: a.email, ...(a.name || old?.name ? { displayName: a.name || old?.name } : {}), ...(old?.status ? { responseStatus: TO_GOOGLE[old.status] } : {}) };
      });
    }
    const send = ev.attendees.length || patch.attendees?.length ? 'all' : 'none';
    const e = await this.call('PATCH', `/calendars/${encodeURIComponent(cal.id)}/events/${encodeURIComponent(ev.remoteId)}?sendUpdates=${send}`, body);
    return this.map(cal, e);
  }

  async deleteEvent(cal: CalendarInfo, ev: CalendarEvent): Promise<void> {
    const send = ev.isOrganizer && ev.attendees.length ? 'all' : 'none';
    await this.call('DELETE', `/calendars/${encodeURIComponent(cal.id)}/events/${encodeURIComponent(ev.remoteId)}?sendUpdates=${send}`);
  }

  async saveInvite(cal: CalendarInfo, inv: Invitation, me: EventPerson, response: InviteResponse | null): Promise<void> {
    const ev = inv.event;
    const found = await this.call('GET', `/calendars/${encodeURIComponent(cal.id)}/events?iCalUID=${encodeURIComponent(ev.uid)}&maxResults=5`);
    const existing = (found.items ?? []).find((e: any) => !e.recurringEventId) ?? found.items?.[0];
    const status = response ? TO_GOOGLE[RESPONSE_STATUS[response]] : 'needsAction';
    if (existing) {
      if (!response) return;
      const attendees = (existing.attendees ?? []).map((a: any) => (a.self || String(a.email).toLowerCase() === me.email ? { ...a, responseStatus: status } : a));
      await this.call('PATCH', `/calendars/${encodeURIComponent(cal.id)}/events/${encodeURIComponent(existing.id)}?sendUpdates=none`, { attendees });
      return;
    }
    if (response === 'decline') return;
    const body: Record<string, unknown> = {
      iCalUID: ev.uid,
      summary: ev.summary,
      location: ev.location || undefined,
      description: ev.description || undefined,
      sequence: ev.sequence,
      ...(ev.allDay ? { start: { date: ev.startDate }, end: { date: ev.endDate } } : { start: { dateTime: isoUtc(ev.start) }, end: { dateTime: isoUtc(ev.end) } }),
      ...(ev.rrule ? { recurrence: [`RRULE:${ev.rrule}`] } : {}),
      organizer: ev.organizer ? { email: ev.organizer.email, displayName: ev.organizer.name || undefined } : undefined,
      attendees: [
        ...ev.attendees.filter((a) => a.email !== me.email).map((a) => ({ email: a.email, displayName: a.name || undefined })),
        { email: me.email, displayName: me.name || undefined, responseStatus: status }
      ]
    };
    await this.call('POST', `/calendars/${encodeURIComponent(cal.id)}/events/import`, body);
  }
}
