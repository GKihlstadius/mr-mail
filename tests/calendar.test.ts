import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/main/db';
import { CalendarService, calendarKey } from '../src/main/calendar/service';
import { CalendarAuthError, type CalendarProvider } from '../src/main/calendar/provider';
import { agenda, eventId, findFreeSlots, todaySummary, type CalendarEvent, type CalendarInfo, type EventInput } from '../src/shared/calendar';
import type { AccountConfig } from '../src/shared/types';

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();

function ev(p: Partial<CalendarEvent> & { start: number; end: number }): CalendarEvent {
  return {
    id: eventId(p.title ?? '', p.start),
    accountId: 'a',
    calendarId: 'c',
    remoteId: 'r',
    uid: 'u',
    title: 'Möte',
    location: '',
    description: '',
    attendees: [],
    status: 'confirmed',
    busy: true,
    recurring: false,
    isOrganizer: true,
    allDay: false,
    ...p
  };
}

describe('kalenderlogik', () => {
  it('hittar lediga tider inom arbetstiden', () => {
    const events = [
      ev({ title: 'A', start: at(16, 9), end: at(16, 10) }),
      ev({ title: 'B', start: at(16, 10, 30), end: at(16, 12) }),
      ev({ title: 'Ledig', start: at(16, 13), end: at(16, 14), busy: false }),
      ev({ title: 'Avböjt', start: at(16, 14), end: at(16, 15), myStatus: 'declined' }),
      ev({ title: 'Heldag', start: at(16, 0), end: at(17, 0), allDay: true }),
      ev({ title: 'C', start: at(16, 15, 10), end: at(16, 17) })
    ];
    const slots = findFreeSlots(events, { from: at(16, 0), to: at(17, 0), durationMin: 30 });
    expect(slots).toEqual([
      { start: at(16, 10), end: at(16, 10, 30) },
      { start: at(16, 12), end: at(16, 15, 10) }
    ]);
    // Helgen hoppas över, egen arbetstid.
    const weekend = findFreeSlots([], { from: at(14, 0), to: at(16, 0), durationMin: 60, workStart: '08:00', workEnd: '10:00' });
    expect(weekend).toEqual([]);
    expect(findFreeSlots([], { from: at(16, 0), to: at(17, 0), durationMin: 60, workStart: '08:00', workEnd: '10:00', now: at(16, 8, 20) })).toEqual([{ start: at(16, 8, 30), end: at(16, 10) }]);
  });

  it('grupperar dagar med heldagar först och sammanfattar dagen', () => {
    const list = [
      ev({ title: 'Demo', start: at(16, 14), end: at(16, 15) }),
      ev({ title: 'Frukost', start: at(16, 8), end: at(16, 9) }),
      ev({ title: 'Resa', start: at(15, 0), end: at(18, 0), allDay: true, startDate: '2026-11-15', endDate: '2026-11-18' })
    ];
    const days = agenda(list, '2026-11-16', 3);
    expect(days[0].allDay.map((e) => e.title)).toEqual(['Resa']);
    expect(days[0].timed.map((e) => e.title)).toEqual(['Frukost', 'Demo']);
    expect(days[2].allDay).toEqual([]);
    expect(todaySummary(list, at(16, 10)).text).toBe('2 möten i dag, nästa 14:00 Demo');
    expect(todaySummary(list, at(16, 8, 30)).text).toBe('2 möten i dag, nästa pågår Frukost');
    expect(todaySummary([], at(16, 10)).count).toBe(0);
  });
});

const acc = (id: string, extra: Partial<AccountConfig> = {}): AccountConfig => ({
  id,
  name: id,
  email: `${id}@exempel.se`,
  displayName: 'Alex',
  provider: 'manual',
  imap: { host: 'h', port: 993, security: 'ssl' },
  smtp: { host: 'h', port: 465, security: 'ssl' },
  username: id,
  color: '#000',
  ...extra
});

function fakeProvider(accountId: string, sendsInvitations = false) {
  const cal: CalendarInfo = { accountId, id: 'jobb', name: 'Jobb', primary: true, readOnly: false };
  const events: CalendarEvent[] = [];
  const log: string[] = [];
  const p: CalendarProvider = {
    kind: 'caldav',
    sendsInvitations,
    listCalendars: async () => [cal, { ...cal, id: 'helg', name: 'Helgdagar', primary: false, readOnly: true }],
    listEvents: async (c, from, to) => (log.push(`list:${c.id}:${from}:${to}`), events.filter((e) => e.calendarId === c.id && e.end > from && e.start < to)),
    createEvent: async (c, input: EventInput, me) => {
      const e = ev({ ...input, id: eventId(accountId, 'n', events.length), accountId, calendarId: c.id, remoteId: `n${events.length}`, organizer: me, attendees: (input.attendees ?? []).map((a) => ({ name: a.name ?? '', email: a.email })) });
      events.push(e);
      log.push(`create:${input.title}`);
      return e;
    },
    updateEvent: async (_c, e, patch) => {
      const u = { ...e, ...patch, attendees: e.attendees };
      log.push(`update:${u.title}`);
      return u as CalendarEvent;
    },
    deleteEvent: async (_c, e) => void log.push(`delete:${e.title}`),
    saveInvite: async (_c, inv, me, r) => void log.push(`invite:${inv.event.uid}:${me.email}:${r}`),
    imip: async (e, method) => `BEGIN:VCALENDAR\r\nMETHOD:${method}\r\nUID:${e.uid}\r\nEND:VCALENDAR\r\n`
  };
  return { p, events, log, cal };
}

describe('kalendertjänsten', () => {
  function setup(accounts: AccountConfig[], providers: Record<string, CalendarProvider | null | 'auth'>) {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'kalender-')), 'db.sqlite'));
    const sent: string[] = [];
    let changes = 0;
    const svc = new CalendarService({
      accounts: () => accounts,
      provider: async (cfg) => {
        const p = providers[cfg.id];
        if (p === 'auth') throw new CalendarAuthError();
        return p ?? null;
      },
      cache: store,
      sendInvite: async (_cfg, to, method, ics) => void sent.push(`${method}:${to.map((x) => x.email).join(',')}:${ics.includes(`METHOD:${method}`)}`),
      now: () => at(16, 10),
      onChange: () => void changes++
    });
    return { svc, store, sent, changes: () => changes };
  }

  it('synkar till cachen och svarar från cachen inom fönstret', async () => {
    const a = fakeProvider('a');
    a.events.push(ev({ title: 'Demo', accountId: 'a', calendarId: 'jobb', start: at(17, 14), end: at(17, 15), attendees: [{ name: 'Karin', email: 'karin@x.se' }] }));
    const { svc, store } = setup([acc('a'), acc('b'), acc('c', { calendar: false }), acc('d')], { a: a.p, b: null, d: 'auth' });
    await svc.refresh();
    const states = Object.fromEntries(svc.states().map((s) => [s.accountId, s.state]));
    expect(states).toEqual({ a: 'ok', b: 'unavailable', c: 'off', d: 'needs-login' });
    expect(svc.connected('a')).toBe(true);
    expect(store.listCalendars().map((c) => c.name)).toEqual(['Jobb', 'Helgdagar']);
    const before = a.log.length;
    const found = await svc.events(at(16, 0), at(20, 0), { query: 'karin' });
    expect(found.map((e) => e.title)).toEqual(['Demo']);
    expect(a.log.length).toBe(before);
    // Utanför fönstret frågas leverantören direkt.
    await svc.events(at(16, 0) + 200 * 86400000, at(16, 0) + 201 * 86400000);
    expect(a.log.length).toBeGreaterThan(before);
    expect(svc.pickCalendar('Jobb').id).toBe('jobb');
    expect(() => svc.pickCalendar('Helgdagar')).toThrow(/finns inte/);
    expect(calendarKey(svc.pickCalendar())).toBe('a|jobb');
  });

  it('mejlar inbjudan och inställt när servern inte gör det själv', async () => {
    const a = fakeProvider('a', false);
    const { svc, sent, store } = setup([acc('a')], { a: a.p });
    await svc.refresh();
    const created = await svc.create({ title: 'Planering', start: at(18, 9), end: at(18, 10), allDay: false, attendees: [{ email: 'karin@x.se' }] });
    expect(sent).toEqual(['REQUEST:karin@x.se:true']);
    expect(store.getEvent(created.id)?.title).toBe('Planering');
    await svc.create({ title: 'Fokus', start: at(18, 11), end: at(18, 12), allDay: false });
    expect(sent).toHaveLength(1);
    await svc.update(created.id, { title: 'Planering Q1' });
    expect(sent[1]).toBe('REQUEST:karin@x.se:true');
    await svc.remove(created.id);
    expect(sent[2]).toBe('CANCEL:karin@x.se:true');
    expect(store.getEvent(created.id)).toBeNull();
    expect(a.log).toContain('delete:Planering Q1');
  });

  it('skickar inget själv när servern sköter inbjudningarna', async () => {
    const a = fakeProvider('a', true);
    const { svc, sent } = setup([acc('a')], { a: a.p });
    await svc.refresh();
    await svc.create({ title: 'Möte', start: at(18, 9), end: at(18, 10), allDay: false, attendees: [{ email: 'karin@x.se' }] });
    expect(sent).toEqual([]);
  });

  it('lägger in svaret på en inbjudan i den anslutna kalendern', async () => {
    const a = fakeProvider('a');
    const { svc } = setup([acc('a'), acc('b')], { a: a.p, b: null });
    await svc.refresh();
    const inv = { method: 'REQUEST', count: 1, ics: null, event: { uid: 'x1', sequence: 0, summary: 'S', location: '', description: '', url: '', status: '', transparent: false, start: 0, end: 0, allDay: false, attendees: [] } };
    expect(await svc.saveInvite('a', inv, 'accept', { name: 'A', email: 'hej@exempel.se' })).toBe(true);
    expect(a.log).toContain('invite:x1:hej@exempel.se:accept');
    expect(await svc.saveInvite('b', inv, 'accept')).toBe(false);
  });

  it('avstängd kalender tömmer cachen', async () => {
    const a = fakeProvider('a');
    a.events.push(ev({ title: 'Demo', accountId: 'a', calendarId: 'jobb', start: at(17, 14), end: at(17, 15) }));
    const accounts = [acc('a')];
    const { svc, store } = setup(accounts, { a: a.p });
    await svc.refresh();
    expect(store.cachedEvents(at(16, 0), at(20, 0))).toHaveLength(1);
    accounts[0] = { ...accounts[0], calendar: false };
    await svc.refresh('a');
    expect(store.cachedEvents(at(16, 0), at(20, 0))).toHaveLength(0);
    expect(svc.states()[0].state).toBe('off');
  });
});
