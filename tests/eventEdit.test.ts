import { describe, expect, it } from 'vitest';
import { canEditEvent, sameEmails } from '../src/shared/calendar';

describe('ändra händelse i appen', () => {
  const states = [
    {
      accountId: 'a',
      kind: 'caldav',
      state: 'ok',
      calendars: [
        { accountId: 'a', id: 'jobb', name: 'Jobb', primary: true, readOnly: false },
        { accountId: 'a', id: 'helg', name: 'Helgdagar', primary: false, readOnly: true }
      ]
    }
  ] as any;
  const ev = (o: Record<string, unknown>) => ({ accountId: 'a', calendarId: 'jobb', isOrganizer: false, attendees: [], ...o }) as any;

  it('egna och ensamma händelser i skrivbara kalendrar går att ändra', () => {
    expect(canEditEvent(ev({}), states)).toBe(true);
    expect(canEditEvent(ev({ isOrganizer: true, attendees: [{ name: '', email: 'k@x.se' }] }), states)).toBe(true);
  });

  it('inbjudningar från andra och skrivskyddade kalendrar går inte', () => {
    expect(canEditEvent(ev({ attendees: [{ name: '', email: 'k@x.se' }] }), states)).toBe(false);
    expect(canEditEvent(ev({ calendarId: 'helg' }), states)).toBe(false);
    expect(canEditEvent(ev({ accountId: 'b' }), states)).toBe(false);
  });

  it('jämför deltagare utan ordning och stora bokstäver', () => {
    expect(sameEmails(['Karin@x.se', 'erik@x.se'], ['erik@x.se', 'karin@x.se'])).toBe(true);
    expect(sameEmails(['karin@x.se'], ['karin@x.se', 'erik@x.se'])).toBe(false);
  });
});
