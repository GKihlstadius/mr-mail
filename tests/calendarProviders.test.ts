import { describe, expect, it } from 'vitest';
import { GoogleCalendar } from '../src/main/calendar/google';
import { GraphCalendar } from '../src/main/calendar/graph';
import { CalDavCalendar, caldavStarts, discoverCalDav } from '../src/main/calendar/caldav';
import { CalendarAuthError } from '../src/main/calendar/provider';
import { multistatus, parseXml, textOf, find } from '../src/main/calendar/xml';
import { mainEvent, parseIcs } from '../src/shared/ics';
import type { CalendarInfo } from '../src/shared/calendar';
import type { Invitation } from '../src/shared/types';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

// Låtsad fetch: varje anrop sparas och besvaras av routern.
type Reply = { status?: number; body?: unknown; headers?: Record<string, string | undefined> };
function fakeFetch(route: (c: Call) => Reply | undefined) {
  const calls: Call[] = [];
  const fn = async (url: string, init: RequestInit = {}) => {
    const c: Call = { method: init.method ?? 'GET', url, headers: Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {})), body: init.body as string | undefined };
    calls.push(c);
    const r = route(c) ?? { status: 404, body: '' };
    const body = typeof r.body === 'string' ? r.body : r.body === undefined ? '' : JSON.stringify(r.body);
    return new Response(r.status === 204 ? null : body, { status: r.status ?? 200, headers: Object.fromEntries(Object.entries(r.headers ?? {}).filter((e): e is [string, string] => typeof e[1] === "string")) });
  };
  return { fn, calls };
}

const gcal: CalendarInfo = { accountId: 'g', id: 'alex@gmail.com', name: 'Alex', primary: true, readOnly: false };

const invitation: Invitation = {
  method: 'REQUEST',
  count: 1,
  ics: null,
  event: {
    uid: 'demo-1@exempel.se',
    sequence: 0,
    summary: 'Demo',
    location: 'Rum 3',
    description: '',
    url: '',
    status: '',
    transparent: false,
    start: Date.UTC(2026, 10, 17, 13),
    end: Date.UTC(2026, 10, 17, 14),
    allDay: false,
    organizer: { name: 'Karin', email: 'karin@exempel.se' },
    attendees: [{ name: 'Alex', email: 'alex@gmail.com', partstat: 'NEEDS-ACTION', rsvp: true, role: 'REQ-PARTICIPANT' }]
  }
};

describe('Google Calendar', () => {
  it('listar kalendrar och händelser med token och sidor', async () => {
    const f = fakeFetch((c) => {
      if (c.url.includes('/users/me/calendarList'))
        return { body: { items: [{ id: 'alex@gmail.com', summary: 'Alex', primary: true, accessRole: 'owner', backgroundColor: '#4f7cff' }, { id: 'helg', summary: 'Helgdagar', accessRole: 'reader' }] } };
      if (c.url.includes('/events?') && !c.url.includes('pageToken'))
        return {
          body: {
            items: [
              {
                id: 'e1',
                iCalUID: 'u1@google.com',
                summary: 'Demo',
                start: { dateTime: '2026-11-17T13:00:00Z' },
                end: { dateTime: '2026-11-17T14:00:00Z' },
                hangoutLink: 'https://meet.google.com/abc-defg-hij',
                organizer: { email: 'karin@exempel.se', displayName: 'Karin' },
                attendees: [{ email: 'alex@gmail.com', self: true, responseStatus: 'tentative' }, { email: 'karin@exempel.se', responseStatus: 'accepted', organizer: true }]
              }
            ],
            nextPageToken: 'p2'
          }
        };
      if (c.url.includes('pageToken=p2')) return { body: { items: [{ id: 'e2', summary: 'Julafton', start: { date: '2026-12-24' }, end: { date: '2026-12-25' }, transparency: 'transparent' }] } };
    });
    const g = new GoogleCalendar('g', async () => 'tok', f.fn, 'https://google.test/v3');
    const cals = await g.listCalendars();
    expect(cals).toEqual([
      { accountId: 'g', id: 'alex@gmail.com', name: 'Alex', color: '#4f7cff', primary: true, readOnly: false },
      { accountId: 'g', id: 'helg', name: 'Helgdagar', color: undefined, primary: false, readOnly: true }
    ]);
    expect(f.calls[0].headers.Authorization).toBe('Bearer tok');
    const evs = await g.listEvents(cals[0], Date.UTC(2026, 10, 1), Date.UTC(2027, 0, 1));
    expect(f.calls[1].url).toContain('singleEvents=true');
    expect(f.calls[1].url).toContain('timeMin=2026-11-01T00%3A00%3A00Z');
    expect(evs).toHaveLength(2);
    expect(evs[0]).toMatchObject({ title: 'Demo', uid: 'u1@google.com', start: Date.UTC(2026, 10, 17, 13), joinUrl: 'https://meet.google.com/abc-defg-hij', myStatus: 'tentative', isOrganizer: false, busy: true });
    expect(evs[1]).toMatchObject({ allDay: true, startDate: '2026-12-24', endDate: '2026-12-25', busy: false });
    expect(evs[0].id).not.toBe(evs[1].id);
  });

  it('skickar inbjudningar bara när det finns deltagare', async () => {
    const f = fakeFetch((c) => ({ body: { id: 'n1', summary: JSON.parse(c.body ?? '{}').summary, start: { dateTime: '2026-11-20T09:00:00Z' }, end: { dateTime: '2026-11-20T10:00:00Z' } } }));
    const g = new GoogleCalendar('g', async () => 'tok', f.fn, 'https://google.test/v3');
    await g.createEvent(gcal, { title: 'Fokus', start: Date.UTC(2026, 10, 20, 9), end: Date.UTC(2026, 10, 20, 10), allDay: false });
    expect(f.calls[0].url).toBe('https://google.test/v3/calendars/alex%40gmail.com/events?sendUpdates=none');
    await g.createEvent(gcal, { title: 'Möte', start: Date.UTC(2026, 10, 20, 9), end: Date.UTC(2026, 10, 20, 10), allDay: false, attendees: [{ email: 'karin@exempel.se', name: 'Karin' }] });
    expect(f.calls[1].url).toContain('sendUpdates=all');
    expect(JSON.parse(f.calls[1].body!)).toEqual({
      summary: 'Möte',
      start: { dateTime: '2026-11-20T09:00:00Z' },
      end: { dateTime: '2026-11-20T10:00:00Z' },
      attendees: [{ email: 'karin@exempel.se', displayName: 'Karin' }]
    });
    await g.createEvent(gcal, { title: 'Ledig', start: 0, end: 0, allDay: true, startDate: '2026-12-24', endDate: '2026-12-27' });
    expect(JSON.parse(f.calls[2].body!)).toMatchObject({ start: { date: '2026-12-24' }, end: { date: '2026-12-27' } });
  });

  it('uppdaterar svaret på en befintlig inbjudan utan att skicka', async () => {
    const f = fakeFetch((c) => {
      if (c.method === 'GET') return { body: { items: [{ id: 'x1', attendees: [{ email: 'alex@gmail.com', self: true, responseStatus: 'needsAction' }, { email: 'karin@exempel.se', responseStatus: 'accepted' }] }] } };
      return { body: {} };
    });
    const g = new GoogleCalendar('g', async () => 'tok', f.fn, 'https://google.test/v3');
    await g.saveInvite(gcal, invitation, { name: 'Alex', email: 'alex@gmail.com' }, 'accept');
    expect(f.calls[0].url).toContain('iCalUID=demo-1%40exempel.se');
    expect(f.calls[1].method).toBe('PATCH');
    expect(f.calls[1].url).toContain('/events/x1?sendUpdates=none');
    expect(JSON.parse(f.calls[1].body!).attendees[0]).toEqual({ email: 'alex@gmail.com', self: true, responseStatus: 'accepted' });
  });

  it('importerar en ny inbjudan med eget svar', async () => {
    const f = fakeFetch((c) => (c.method === 'GET' ? { body: { items: [] } } : { body: {} }));
    const g = new GoogleCalendar('g', async () => 'tok', f.fn, 'https://google.test/v3');
    await g.saveInvite(gcal, invitation, { name: 'Alex', email: 'alex@gmail.com' }, 'tentative');
    expect(f.calls[1].url).toBe('https://google.test/v3/calendars/alex%40gmail.com/events/import');
    const body = JSON.parse(f.calls[1].body!);
    expect(body).toMatchObject({ iCalUID: 'demo-1@exempel.se', summary: 'Demo', organizer: { email: 'karin@exempel.se' } });
    expect(body.attendees).toEqual([{ email: 'alex@gmail.com', displayName: 'Alex', responseStatus: 'tentative' }]);
  });

  it('saknad behörighet betyder logga in igen, avstängt API ger en förklaring', async () => {
    const scope = fakeFetch(() => ({ status: 403, body: { error: { message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } } }));
    await expect(new GoogleCalendar('g', async () => 't', scope.fn).listCalendars()).rejects.toBeInstanceOf(CalendarAuthError);
    const off = fakeFetch(() => ({ status: 403, body: { error: { message: 'Google Calendar API has not been used in project 1 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } } }));
    await expect(new GoogleCalendar('g', async () => 't', off.fn).listCalendars()).rejects.toThrow(/inte aktiverat/);
  });
});

describe('Microsoft Graph', () => {
  const mcal: CalendarInfo = { accountId: 'm', id: 'AAA=', name: 'Kalender', primary: true, readOnly: false };

  it('läser kalenderns vy i UTC och följer nästa sida', async () => {
    const f = fakeFetch((c) => {
      if (c.url.endsWith('/me/calendars?$top=50')) return { body: { value: [{ id: 'AAA=', name: 'Kalender', isDefaultCalendar: true, canEdit: true, hexColor: '' }] } };
      if (c.url.includes('calendarView'))
        return {
          body: {
            value: [
              {
                id: 'm1',
                iCalUId: 'u-ms',
                subject: 'Styrelsemöte',
                start: { dateTime: '2026-11-18T08:00:00.0000000', timeZone: 'UTC' },
                end: { dateTime: '2026-11-18T09:30:00.0000000', timeZone: 'UTC' },
                isOrganizer: false,
                responseStatus: { response: 'accepted' },
                organizer: { emailAddress: { name: 'Erik', address: 'Erik@Bolag.se' } },
                attendees: [{ type: 'required', emailAddress: { name: 'Alex', address: 'alex@outlook.com' }, status: { response: 'accepted' } }],
                onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
                showAs: 'busy',
                body: { contentType: 'html', content: '<p>Agenda</p>' }
              }
            ],
            '@odata.nextLink': 'https://graph.test/v1.0/next'
          }
        };
      if (c.url === 'https://graph.test/v1.0/next') return { body: { value: [{ id: 'm2', subject: 'Ledig', isAllDay: true, start: { dateTime: '2026-12-24T00:00:00.0000000' }, end: { dateTime: '2026-12-25T00:00:00.0000000' }, showAs: 'free' }] } };
    });
    const g = new GraphCalendar('m', async () => 'gtok', f.fn, 'https://graph.test/v1.0');
    expect(await g.listCalendars()).toEqual([{ accountId: 'm', id: 'AAA=', name: 'Kalender', color: undefined, primary: true, readOnly: false }]);
    const evs = await g.listEvents(mcal, Date.UTC(2026, 10, 1), Date.UTC(2027, 0, 1));
    expect(f.calls[1].headers.Prefer).toBe('outlook.timezone="UTC"');
    expect(f.calls[1].headers.Authorization).toBe('Bearer gtok');
    expect(evs[0]).toMatchObject({ title: 'Styrelsemöte', start: Date.UTC(2026, 10, 18, 8), end: Date.UTC(2026, 10, 18, 9, 30), myStatus: 'accepted', joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc', description: 'Agenda' });
    expect(evs[0].organizer).toEqual({ name: 'Erik', email: 'erik@bolag.se' });
    expect(evs[1]).toMatchObject({ allDay: true, startDate: '2026-12-24', endDate: '2026-12-25', busy: false });
  });

  it('svarar på en inbjudan utan att Exchange skickar ett andra svar', async () => {
    const f = fakeFetch((c) => (c.method === 'GET' ? { body: { value: [{ id: 'ev9' }] } } : { status: 202 }));
    const g = new GraphCalendar('m', async () => 'gtok', f.fn, 'https://graph.test/v1.0');
    await g.saveInvite(mcal, invitation, { name: 'Alex', email: 'alex@outlook.com' }, 'decline');
    expect(decodeURIComponent(f.calls[0].url)).toContain("iCalUId eq 'demo-1@exempel.se'");
    expect(f.calls[1]).toMatchObject({ method: 'POST', url: 'https://graph.test/v1.0/me/events/ev9/decline' });
    expect(JSON.parse(f.calls[1].body!)).toEqual({ sendResponse: false });
  });

  it('organisatören ställer in mötet i stället för att bara ta bort det', async () => {
    const f = fakeFetch(() => ({ status: 202 }));
    const g = new GraphCalendar('m', async () => 'gtok', f.fn, 'https://graph.test/v1.0');
    const base = { id: 'x', accountId: 'm', calendarId: 'AAA=', remoteId: 'R1', uid: 'u', title: 'T', location: '', description: '', status: 'confirmed' as const, busy: true, recurring: false, start: 0, end: 0, allDay: false };
    await g.deleteEvent(mcal, { ...base, isOrganizer: true, attendees: [{ name: '', email: 'k@x.se' }] });
    await g.deleteEvent(mcal, { ...base, isOrganizer: true, attendees: [] });
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST https://graph.test/v1.0/me/events/R1/cancel', 'DELETE https://graph.test/v1.0/me/events/R1']);
  });

  it('skapar heldag i lokal zon och möten i UTC', async () => {
    const f = fakeFetch((c) => ({ body: { id: 'n', ...JSON.parse(c.body!) } }));
    const g = new GraphCalendar('m', async () => 'gtok', f.fn, 'https://graph.test/v1.0', 'Europe/Stockholm');
    await g.createEvent(mcal, { title: 'Möte', start: Date.UTC(2026, 10, 20, 9), end: Date.UTC(2026, 10, 20, 10), allDay: false, attendees: [{ email: 'k@x.se' }] });
    expect(JSON.parse(f.calls[0].body!)).toMatchObject({ subject: 'Möte', isAllDay: false, start: { dateTime: '2026-11-20T09:00:00', timeZone: 'UTC' }, attendees: [{ emailAddress: { address: 'k@x.se', name: 'k@x.se' }, type: 'required' }] });
    await g.createEvent(mcal, { title: 'Jul', start: 0, end: 0, allDay: true, startDate: '2026-12-24' });
    expect(JSON.parse(f.calls[1].body!)).toMatchObject({ isAllDay: true, start: { dateTime: '2026-12-24T00:00:00', timeZone: 'Europe/Stockholm' }, end: { dateTime: '2026-12-25T00:00:00' } });
  });
});

describe('CalDAV', () => {
  it('läser multistatus med namnrymder, CDATA och entiteter', () => {
    const list = multistatus(
      `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>/cal/a%20b/</D:href><D:propstat><D:prop><D:displayname>Jobb &amp; fritid</D:displayname><C:calendar-data><![CDATA[BEGIN:VCALENDAR]]></C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat><D:propstat><D:prop><D:getctag/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response></D:multistatus>`
    );
    expect(list).toHaveLength(1);
    expect(list[0].href).toBe('/cal/a%20b/');
    expect(textOf(find(list[0].props, 'displayname'))).toBe('Jobb & fritid');
    expect(textOf(find(list[0].props, 'calendar-data'))).toBe('BEGIN:VCALENDAR');
    expect(find(list[0].props, 'getctag')).toBeUndefined();
    expect(parseXml('<a><b x="1"/><c>t</c></a>').children[0].children.map((c) => c.name)).toEqual(['b', 'c']);
  });

  it('väljer startadresser för iCloud, Fastmail och övriga', () => {
    expect(caldavStarts('alex@icloud.com', 'imap.mail.me.com', 'icloud')).toEqual(['https://caldav.icloud.com/', 'https://icloud.com/.well-known/caldav']);
    expect(caldavStarts('a@fastmail.com', 'imap.fastmail.com', 'manual')[0]).toBe('https://caldav.fastmail.com/dav/');
    expect(caldavStarts('a@nordljus.se', 'mail.simply.com', 'simply', 'dav.nordljus.se/cal')).toEqual(['https://dav.nordljus.se/cal', 'https://nordljus.se/.well-known/caldav']);
    expect(caldavStarts('a@gmail.com', 'imap.gmail.com', 'gmail')).toEqual([]);
  });

  // En liten CalDAV-server i minnet: principal, hem, en kalender och resurser.
  function fakeDav(opts: { auth?: string; autoSchedule?: boolean } = {}) {
    const store = new Map<string, { ics: string; etag: number }>();
    let n = 1;
    const ms = (inner: string) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">${inner}</d:multistatus>`;
    const resp = (href: string, prop: string) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
    const f = fakeFetch((c) => {
      if (opts.auth && c.headers.Authorization !== opts.auth) return { status: 401 };
      const path = new URL(c.url).pathname;
      if (c.method === 'PROPFIND' && path === '/.well-known/caldav') return { status: 207, body: ms(resp('/.well-known/caldav', '<d:current-user-principal><d:href>/p/alex/</d:href></d:current-user-principal>')) };
      if (c.method === 'PROPFIND' && path === '/p/alex/') return { status: 207, body: ms(resp('/p/alex/', '<c:calendar-home-set><d:href>/home/alex/</d:href></c:calendar-home-set>')) };
      if (c.method === 'OPTIONS') return { status: 200, headers: { DAV: opts.autoSchedule ? '1, 2, calendar-access, calendar-auto-schedule' : '1, 2, calendar-access' } };
      if (c.method === 'PROPFIND' && path === '/home/alex/')
        return {
          status: 207,
          body: ms(
            resp('/home/alex/', '<d:resourcetype><d:collection/></d:resourcetype>') +
              resp('/home/alex/jobb/', '<d:displayname>Jobb</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><a:calendar-color>#FF2968FF</a:calendar-color><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>') +
              resp('/home/alex/uppgifter/', '<d:displayname>Uppgifter</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>')
          )
        };
      if (c.method === 'REPORT') {
        const uidFilter = /<c:text-match[^>]*>([^<]+)</.exec(c.body ?? '')?.[1];
        const rows = [...store.entries()].filter(([, v]) => !uidFilter || v.ics.includes(`UID:${uidFilter}`));
        return { status: 207, body: ms(rows.map(([href, v]) => resp(href, `<d:getetag>"${v.etag}"</d:getetag><c:calendar-data>${v.ics.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</c:calendar-data>`)).join('')) };
      }
      if (c.method === 'PUT') {
        const cur = store.get(path);
        if (c.headers['If-None-Match'] === '*' && cur) return { status: 412 };
        if (c.headers['If-Match'] && (!cur || c.headers['If-Match'] !== `"${cur.etag}"`)) return { status: 412 };
        const etag = n++;
        store.set(path, { ics: c.body!, etag });
        return { status: cur ? 204 : 201, headers: { ETag: `"${etag}"` } };
      }
      if (c.method === 'GET') {
        const cur = store.get(path);
        return cur ? { body: cur.ics, headers: { ETag: `"${cur.etag}"` } } : { status: 404 };
      }
      if (c.method === 'DELETE') {
        const cur = store.get(path);
        if (c.headers['If-Match'] && cur && c.headers['If-Match'] !== `"${cur.etag}"`) return { status: 412 };
        store.delete(path);
        return { status: 204 };
      }
    });
    return { ...f, store };
  }

  const creds = { username: 'alex@exempel.se', password: 'app-lösen' };

  it('hittar kalenderhemmet via well-known, principal och home-set', async () => {
    const d = fakeDav({ auth: `Basic ${Buffer.from('alex@exempel.se:app-lösen').toString('base64')}`, autoSchedule: true });
    const found = await discoverCalDav(['https://dav.test/.well-known/caldav'], creds, d.fn);
    expect(found).toEqual({ home: 'https://dav.test/home/alex/', autoSchedule: true });
    expect(d.calls[0].headers.Depth).toBe('0');
    await expect(discoverCalDav(['https://dav.test/.well-known/caldav'], { ...creds, password: 'fel' }, d.fn)).rejects.toBeInstanceOf(CalendarAuthError);
    expect(await discoverCalDav(['https://dav.test/finns-inte'], creds, d.fn)).toBeNull();
  });

  it('listar kalendrar, skapar, ändrar och tar bort med ETag', async () => {
    const d = fakeDav();
    const p = new CalDavCalendar('c', 'https://dav.test/home/alex/', creds, 'alex@exempel.se', d.fn, false);
    const cals = await p.listCalendars();
    expect(cals).toEqual([{ accountId: 'c', id: 'https://dav.test/home/alex/jobb/', name: 'Jobb', color: '#FF2968', primary: true, readOnly: false }]);
    expect(p.sendsInvitations).toBe(false);
    const ev = await p.createEvent(cals[0], { title: 'Planering', start: Date.UTC(2026, 10, 20, 9), end: Date.UTC(2026, 10, 20, 10), allDay: false, attendees: [{ email: 'Karin@Exempel.se' }] }, { name: 'Alex', email: 'alex@exempel.se' });
    const put = d.calls.find((c) => c.method === 'PUT')!;
    expect(put.headers['If-None-Match']).toBe('*');
    expect(put.headers['Content-Type']).toBe('text/calendar; charset=utf-8');
    expect(ev).toMatchObject({ title: 'Planering', isOrganizer: true, etag: '"1"' });
    expect(ev.attendees).toEqual([{ name: '', email: 'karin@exempel.se', status: 'needs-action' }]);
    const listed = await p.listEvents(cals[0], Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1));
    expect(listed.map((e) => e.title)).toEqual(['Planering']);
    expect(d.calls.find((c) => c.method === 'REPORT')!.body).toContain('<c:time-range start="20261101T000000Z" end="20261201T000000Z"/>');
    const invite = await p.imip(listed[0], 'REQUEST');
    expect(invite).toContain('METHOD:REQUEST');
    const moved = await p.updateEvent(cals[0], listed[0], { title: 'Planering Q1', start: Date.UTC(2026, 10, 21, 9), end: Date.UTC(2026, 10, 21, 10) }, { name: 'Alex', email: 'alex@exempel.se' });
    expect(d.calls.filter((c) => c.method === 'PUT')[1].headers['If-Match']).toBe('"1"');
    expect(moved).toMatchObject({ title: 'Planering Q1', start: Date.UTC(2026, 10, 21, 9) });
    const stored = mainEvent(parseIcs([...d.store.values()][0].ics)!)!;
    expect(stored.sequence).toBe(1);
    const cancel = await p.imip(moved, 'CANCEL');
    expect(cancel).toContain('STATUS:CANCELLED');
    await p.deleteEvent(cals[0], moved);
    expect(d.store.size).toBe(0);
  });

  it('sparar en inbjudan med eget svar och utan att servern svarar en gång till', async () => {
    const d = fakeDav();
    const p = new CalDavCalendar('c', 'https://dav.test/home/alex/', creds, 'alex@exempel.se', d.fn, true);
    const cal = (await p.listCalendars())[0];
    const inv: Invitation = { ...invitation, event: { ...invitation.event, attendees: [{ name: 'Alex', email: 'alex@exempel.se', partstat: 'NEEDS-ACTION', rsvp: true, role: 'REQ-PARTICIPANT' }] } };
    await p.saveInvite(cal, inv, { name: 'Alex', email: 'alex@exempel.se' }, 'accept');
    const put = d.calls.find((c) => c.method === 'PUT')!;
    expect(put.headers['Schedule-Reply']).toBe('F');
    expect(put.body).not.toContain('METHOD');
    expect(mainEvent(parseIcs(put.body!)!)!.attendees[0].partstat).toBe('ACCEPTED');
    await p.saveInvite(cal, inv, { name: 'Alex', email: 'alex@exempel.se' }, 'decline');
    expect(d.store.size).toBe(1);
    expect(mainEvent(parseIcs([...d.store.values()][0].ics)!)!.attendees[0].partstat).toBe('DECLINED');
  });

  it('breder ut återkommande händelser och tar bort ett tillfälle med EXDATE', async () => {
    const d = fakeDav();
    d.store.set('/home/alex/jobb/serie.ics', {
      etag: 50,
      ics: ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:serie', 'DTSTART:20261102T080000Z', 'DTEND:20261102T083000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Stå-upp', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
    });
    const p = new CalDavCalendar('c', 'https://dav.test/home/alex/', creds, 'alex@exempel.se', d.fn);
    const cal = (await p.listCalendars())[0];
    const evs = await p.listEvents(cal, Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 30));
    expect(evs.map((e) => new Date(e.start).toISOString().slice(0, 10))).toEqual(['2026-11-02', '2026-11-03', '2026-11-04']);
    expect(new Set(evs.map((e) => e.id)).size).toBe(3);
    await p.deleteEvent(cal, evs[1]);
    const after = await p.listEvents(cal, Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 30));
    expect(after.map((e) => new Date(e.start).toISOString().slice(0, 10))).toEqual(['2026-11-02', '2026-11-04']);
    await expect(p.updateEvent(cal, after[0], { start: 1, end: 2 }, { name: '', email: 'alex@exempel.se' })).rejects.toThrow(/återkommande/);
  });
});
