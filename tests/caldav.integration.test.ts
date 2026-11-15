// Mot en riktig CalDAV-server, Radicale i Docker:
//   docker run -d --name mr-mail-radicale --cpus 1 -p 5232:5232 tomsquest/docker-radicale
// Hoppas över när servern inte är igång. Stoppa den efteråt: docker stop mr-mail-radicale
import { beforeAll, describe, expect, it } from 'vitest';
import { CalDavCalendar, discoverCalDav } from '../src/main/calendar/caldav';
import { mainEvent, parseIcs } from '../src/shared/ics';
import type { Invitation } from '../src/shared/types';

const BASE = 'http://127.0.0.1:5232';
const up = await fetch(`${BASE}/.web/`, { signal: AbortSignal.timeout(1500) }).then(
  () => true,
  () => false
);

describe.skipIf(!up)('CalDAV mot Radicale', () => {
  const user = `alex${Date.now().toString(36)}`;
  const creds = { username: user, password: 'x' };
  const auth = `Basic ${Buffer.from(`${user}:x`).toString('base64')}`;
  const me = { name: 'Alex', email: `${user}@exempel.se` };

  beforeAll(async () => {
    // Radicale skapar hemmet vid första anropet; kalendern skapas med MKCALENDAR.
    await fetch(`${BASE}/${user}/`, { method: 'PROPFIND', headers: { Authorization: auth, Depth: '0' } });
    const res = await fetch(`${BASE}/${user}/jobb/`, {
      method: 'MKCALENDAR',
      headers: { Authorization: auth, 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:displayname>Jobb</d:displayname></d:prop></d:set></c:mkcalendar>'
    });
    expect(res.status).toBe(201);
  });

  it('hittar hemmet, skapar, listar, ändrar och tar bort', async () => {
    const found = await discoverCalDav([`${BASE}/.well-known/caldav`, `${BASE}/`], creds);
    expect(found?.home).toBe(`${BASE}/${user}/`);
    const p = new CalDavCalendar('r', found!.home, creds, me.email, fetch, found!.autoSchedule);
    const cals = await p.listCalendars();
    const cal = cals.find((c) => c.name === 'Jobb')!;
    expect(cal).toBeTruthy();
    const start = Date.UTC(2026, 10, 20, 9);
    const created = await p.createEvent(cal, { title: 'Planering', start, end: start + 3600_000, allDay: false, location: 'Rum 1', attendees: [{ email: 'karin@exempel.se', name: 'Karin' }] }, me);
    let list = await p.listEvents(cal, start - 86400_000, start + 86400_000);
    expect(list.map((e) => [e.title, e.location, e.start])).toEqual([['Planering', 'Rum 1', start]]);
    expect(list[0].attendees.map((a) => a.email)).toEqual(['karin@exempel.se']);
    const moved = await p.updateEvent(cal, list[0], { title: 'Planering Q1', start: start + 7200_000, end: start + 10800_000 }, me);
    expect(moved.title).toBe('Planering Q1');
    list = await p.listEvents(cal, start - 86400_000, start + 86400_000);
    expect(list.map((e) => [e.title, e.start])).toEqual([['Planering Q1', start + 7200_000]]);
    // En gammal ETag avvisas.
    await expect(p.deleteEvent(cal, { ...list[0], etag: created.etag })).rejects.toThrow(/ändrats/);
    await p.deleteEvent(cal, list[0]);
    expect(await p.listEvents(cal, start - 86400_000, start + 86400_000)).toEqual([]);
  });

  it('sparar en inbjudan med eget svar och hittar den igen på UID', async () => {
    const found = await discoverCalDav([`${BASE}/`], creds);
    const p = new CalDavCalendar('r', found!.home, creds, me.email);
    const cal = (await p.listCalendars()).find((c) => c.name === 'Jobb')!;
    const start = Date.UTC(2026, 10, 25, 13);
    const inv: Invitation = {
      method: 'REQUEST',
      count: 1,
      ics: null,
      event: {
        uid: `inbjudan-${user}@exempel.se`,
        sequence: 0,
        summary: 'Demo',
        location: '',
        description: '',
        url: '',
        status: '',
        transparent: false,
        start,
        end: start + 3600_000,
        allDay: false,
        organizer: { name: 'Karin', email: 'karin@exempel.se' },
        attendees: [{ name: 'Alex', email: me.email, partstat: 'NEEDS-ACTION', rsvp: true, role: 'REQ-PARTICIPANT' }]
      }
    };
    await p.saveInvite(cal, inv, me, 'tentative');
    let ev = (await p.listEvents(cal, start - 3600_000, start + 7200_000))[0];
    expect(ev).toMatchObject({ title: 'Demo', myStatus: 'tentative', isOrganizer: false });
    await p.saveInvite(cal, inv, me, 'accept');
    const all = await p.listEvents(cal, start - 3600_000, start + 7200_000);
    expect(all).toHaveLength(1);
    ev = all[0];
    expect(ev.myStatus).toBe('accepted');
    const res = await fetch(ev.remoteId, { headers: { Authorization: auth } });
    expect(mainEvent(parseIcs(await res.text())!)!.attendees[0].partstat).toBe('ACCEPTED');
    await p.deleteEvent(cal, ev);
  });
});
