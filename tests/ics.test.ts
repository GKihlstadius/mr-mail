import { afterEach, describe, expect, it } from 'vitest';
import {
  buildEvent,
  buildReply,
  describeRrule,
  findJoinUrl,
  foldLine,
  joinService,
  mainEvent,
  parseIcs,
  patchIcs,
  unfold,
  withoutMethod,
  wallToUtcInZone
} from '../src/shared/ics';
import { findInvitation } from '../src/main/parse';
import { setLang } from '../src/shared/i18n';

const crlf = (lines: string[]) => lines.join('\r\n') + '\r\n';

const outlook = crlf([
  'BEGIN:VCALENDAR',
  'METHOD:REQUEST',
  'PRODID:Microsoft Exchange Server 2010',
  'VERSION:2.0',
  'BEGIN:VTIMEZONE',
  'TZID:W. Europe Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16010101T030000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010101T020000',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'ORGANIZER;CN=Karin Lund:mailto:karin@exempel.se',
  'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Alex Berg:mailto:Alex@Nordljus.se',
  'ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=ACCEPTED;CN="Lund, Erik":mailto:erik@exempel.se',
  'DESCRIPTION;LANGUAGE=sv-SE:Hej!\\nVi går igenom demon\\, och sedan fika.\\n\\nAnslut: <https://teams.mic',
  ' rosoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d>',
  'UID:040000008200E00074C5B7101A82E00800000000',
  'SUMMARY;LANGUAGE=sv-SE:Demo av Nordljus',
  'DTSTART;TZID=W. Europe Standard Time:20261117T140000',
  'DTEND;TZID=W. Europe Standard Time:20261117T150000',
  'SEQUENCE:2',
  'LOCATION;LANGUAGE=sv-SE:Microsoft Teams-möte',
  'END:VEVENT',
  'END:VCALENDAR'
]);

describe('iCalendar', () => {
  afterEach(() => setLang('sv'));

  it('viker ihop rader och tolkar en Outlook-inbjudan', () => {
    expect(unfold('A:1\r\n  B\r\n\tC\r\nD:2')).toEqual(['A:1 BC', 'D:2']);
    const cal = parseIcs(outlook)!;
    expect(cal.method).toBe('REQUEST');
    const ev = mainEvent(cal)!;
    expect(ev.summary).toBe('Demo av Nordljus');
    expect(ev.sequence).toBe(2);
    expect(ev.description).toContain('Vi går igenom demon, och sedan fika.\n');
    expect(ev.start).toBe(Date.UTC(2026, 10, 17, 13, 0));
    expect(ev.end - ev.start).toBe(3600_000);
    expect(ev.organizer).toEqual({ name: 'Karin Lund', email: 'karin@exempel.se' });
    expect(ev.attendees).toHaveLength(2);
    expect(ev.attendees[0]).toMatchObject({ email: 'alex@nordljus.se', partstat: 'NEEDS-ACTION', rsvp: true, name: 'Alex Berg' });
    expect(ev.attendees[1].name).toBe('Lund, Erik');
    expect(ev.joinUrl).toBe('https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d');
    expect(joinService(ev.joinUrl!)).toBe('Teams');
  });

  it('räknar sommartid med VTIMEZONE och okända zonnamn', () => {
    const summer = outlook.replace(/20261117/g, '20260617').replace(/W\. Europe Standard Time/g, 'Egen zon');
    expect(mainEvent(parseIcs(summer)!)!.start).toBe(Date.UTC(2026, 5, 17, 12, 0));
    const winter = outlook.replace(/W\. Europe Standard Time/g, 'Egen zon');
    expect(mainEvent(parseIcs(winter)!)!.start).toBe(Date.UTC(2026, 10, 17, 13, 0));
  });

  it('tolkar IANA, UTC, heldag och varaktighet', () => {
    const cal = parseIcs(
      crlf([
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:a',
        'DTSTART;TZID=America/New_York:20260310T090000',
        'DURATION:PT1H30M',
        'SUMMARY:NY',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:b',
        'DTSTART:20261120T071500Z',
        'DTEND:20261120T080000Z',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:c',
        'DTSTART;VALUE=DATE:20261224',
        'DTEND;VALUE=DATE:20261227',
        'SUMMARY:Jul',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:d',
        'DTSTART;TZID=/mozilla.org/20050126_1/Europe/Stockholm:20260701T100000',
        'END:VEVENT',
        'END:VCALENDAR'
      ])
    )!;
    const [a, b, c, d] = cal.events;
    expect(a.start).toBe(Date.UTC(2026, 2, 10, 13, 0));
    expect(a.end - a.start).toBe(90 * 60_000);
    expect(b.start).toBe(Date.UTC(2026, 10, 20, 7, 15));
    expect(c.allDay).toBe(true);
    expect(c.startDate).toBe('2026-12-24');
    expect(c.endDate).toBe('2026-12-27');
    expect(c.start).toBe(new Date(2026, 11, 24).getTime());
    expect(d.start).toBe(Date.UTC(2026, 6, 1, 8, 0));
    expect(wallToUtcInZone({ y: 2026, mo: 3, d: 29, h: 3, mi: 0, s: 0 }, 'Europe/Stockholm')).toBe(Date.UTC(2026, 2, 29, 1, 0));
  });

  it('hittar möteslänkar för Teams, Meet och Zoom', () => {
    expect(findJoinUrl('Länk: https://meet.google.com/abc-defg-hij.')).toBe('https://meet.google.com/abc-defg-hij');
    expect(findJoinUrl(undefined, 'https://acme.zoom.us/j/123456789?pwd=x')).toBe('https://acme.zoom.us/j/123456789?pwd=x');
    expect(findJoinUrl('https://exempel.se/inte-ett-mote')).toBeUndefined();
    const g = parseIcs(crlf(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:g', 'DTSTART:20261120T071500Z', 'X-GOOGLE-CONFERENCE:https://meet.google.com/xyz-abcd-efg', 'END:VEVENT', 'END:VCALENDAR']))!;
    expect(g.events[0].joinUrl).toBe('https://meet.google.com/xyz-abcd-efg');
  });

  it('beskriver upprepning i klartext', () => {
    expect(describeRrule('FREQ=WEEKLY;BYDAY=MO')).toBe('Varje vecka på måndag');
    expect(describeRrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH')).toBe('Varannan vecka på tisdag, torsdag');
    expect(describeRrule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBe('Varje vardag');
    expect(describeRrule('FREQ=DAILY;COUNT=5')).toBe('Varje dag, 5 gånger');
    expect(describeRrule('FREQ=MONTHLY;UNTIL=20270101T000000Z')).toBe('Varje månad, till och med 1 januari 2027');
    setLang('en');
    expect(describeRrule('FREQ=YEARLY')).toBe('Every year');
    expect(describeRrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR')).toBe('Every other week on Friday');
  });

  it('breder ut återkommande händelser i väggklocka, med undantag', () => {
    const text = crlf([
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:serie',
      'DTSTART;TZID=Europe/Stockholm:20261019T090000',
      'DTEND;TZID=Europe/Stockholm:20261019T093000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4',
      'EXDATE;TZID=Europe/Stockholm:20261102T090000',
      'SUMMARY:Veckomöte',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:serie',
      'RECURRENCE-ID;TZID=Europe/Stockholm:20261109T090000',
      'DTSTART;TZID=Europe/Stockholm:20261109T100000',
      'DTEND;TZID=Europe/Stockholm:20261109T103000',
      'SUMMARY:Veckomöte (flyttat)',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:man',
      'DTSTART;VALUE=DATE:20261130',
      'RRULE:FREQ=MONTHLY;BYDAY=-1MO',
      'SUMMARY:Sista måndagen',
      'END:VEVENT',
      'END:VCALENDAR'
    ]);
    const cal = parseIcs(text, { expand: { from: Date.UTC(2026, 9, 1), to: Date.UTC(2027, 1, 1) } })!;
    const weekly = cal.events.filter((e) => e.uid === 'serie').sort((a, b) => a.start - b.start);
    // 19 okt (sommartid), 26 okt (vintertid), 2 nov struken, 9 nov flyttad till 10.
    expect(weekly.map((e) => new Date(e.start).toISOString())).toEqual(['2026-10-19T07:00:00.000Z', '2026-10-26T08:00:00.000Z', '2026-11-09T09:00:00.000Z']);
    expect(weekly[2].summary).toBe('Veckomöte (flyttat)');
    const monthly = cal.events.filter((e) => e.uid === 'man').map((e) => e.startDate);
    expect(monthly).toEqual(['2026-11-30', '2026-12-28', '2027-01-25']);
  });

  it('skriver svaret till organisatören', () => {
    const ev = mainEvent(parseIcs(outlook)!)!;
    const reply = buildReply(ev, { name: 'Alex Berg', email: 'alex@nordljus.se' }, 'ACCEPTED', { comment: 'Ses då, tack!', now: Date.UTC(2026, 10, 14, 12) });
    expect(reply).toContain('METHOD:REPLY');
    expect(reply).toContain('UID:040000008200E00074C5B7101A82E00800000000');
    expect(reply).toContain('SEQUENCE:2');
    expect(reply).toContain('ATTENDEE;CN=Alex Berg;PARTSTAT=ACCEPTED:mailto:alex@nordljus.se');
    expect(reply).toContain('DTSTART;TZID=W. Europe Standard Time:20261117T140000');
    expect(reply).toContain('COMMENT:Ses då\\, tack!');
    expect(reply).toContain('DTSTAMP:20261114T120000Z');
    expect(reply.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    // Svaret kan läsas tillbaka.
    const back = mainEvent(parseIcs(reply)!)!;
    expect(back.attendees).toEqual([{ name: 'Alex Berg', email: 'alex@nordljus.se', partstat: 'ACCEPTED', rsvp: false, role: 'REQ-PARTICIPANT' }]);
    expect(back.start).toBe(ev.start);
  });

  it('viker långa rader utan att dela tecken', () => {
    const line = `SUMMARY:${'å'.repeat(80)}`;
    const folded = foldLine(line);
    expect(folded.split('\r\n ').join('')).toBe(line);
    expect(folded.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
  });

  it('skapar och ändrar händelser', () => {
    const ics = buildEvent(
      {
        uid: 'ny-1',
        title: 'Fika; med team',
        start: Date.UTC(2026, 10, 20, 13),
        end: Date.UTC(2026, 10, 20, 14),
        allDay: false,
        location: 'Köket',
        organizer: { name: 'Alex', email: 'alex@nordljus.se' },
        attendees: [{ name: 'Karin', email: 'karin@exempel.se' }]
      },
      { method: 'REQUEST', now: 0 }
    );
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('SUMMARY:Fika\\; med team');
    expect(ics).toContain('ORGANIZER;CN=Alex:mailto:alex@nordljus.se');
    expect(unfold(ics)).toContain('ATTENDEE;CN=Karin;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:karin@exempel.se');
    const ev = mainEvent(parseIcs(ics)!)!;
    expect(ev.summary).toBe('Fika; med team');
    const patched = patchIcs(withoutMethod(outlook), ev.uid === 'ny-1' ? '040000008200E00074C5B7101A82E00800000000' : '', { title: 'Ny titel', start: Date.UTC(2026, 10, 18, 9), end: Date.UTC(2026, 10, 18, 10) }, { now: 0 });
    expect(patched).not.toContain('METHOD');
    expect(patched).toContain('BEGIN:VTIMEZONE');
    const p = mainEvent(parseIcs(patched)!)!;
    expect(p.summary).toBe('Ny titel');
    expect(p.start).toBe(Date.UTC(2026, 10, 18, 9));
    expect(p.sequence).toBe(3);
    expect(p.attendees).toHaveLength(2);
    const allDay = mainEvent(parseIcs(buildEvent({ uid: 'h', title: 'Ledig', start: 0, end: 0, allDay: true, startDate: '2026-12-24', endDate: '2026-12-25' }))!)!;
    expect(allDay).toMatchObject({ allDay: true, startDate: '2026-12-24', endDate: '2026-12-25' });
  });

  it('hittar inbjudan bland bilagorna i mejlet', () => {
    const inv = findInvitation([
      { contentType: 'application/pdf', filename: 'a.pdf', content: Buffer.from('%PDF') },
      { contentType: 'application/ics', filename: 'invite.ics', content: Buffer.from(outlook.replace('METHOD:REQUEST', 'METHOD:PUBLISH')) },
      { contentType: 'text/calendar', content: Buffer.from(outlook) }
    ]);
    expect(inv?.method).toBe('REQUEST');
    expect(inv?.event.summary).toBe('Demo av Nordljus');
    expect(inv?.ics).toContain('BEGIN:VCALENDAR');
    expect(findInvitation([{ contentType: 'text/calendar', content: Buffer.from('trasig') }])).toBeNull();
  });
});
