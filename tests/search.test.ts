import { describe, expect, it } from 'vitest';
import { gmailRaw, imapCriteria, isEmptyQuery, parseSearch } from '../src/shared/search';

describe('sökfältet', () => {
  it('tolkar prefix och fritext', () => {
    const q = parseSearch('från:anna ämne:"möte i morgon" har:bilaga är:oläst offert 2026');
    expect(q).toEqual({ text: 'offert 2026', from: 'anna', subject: 'möte i morgon', hasAttachment: true, unread: true });
    expect(parseSearch('till:erik@x.se efter:2026-01-01 före:2026-02-01')).toMatchObject({ to: 'erik@x.se', after: '2026-01-01', before: '2026-02-01', text: '' });
    expect(parseSearch('http://x.se')).toMatchObject({ text: 'http://x.se' });
  });

  it('filter från panelen följer med', () => {
    expect(parseSearch('', { flagged: true })).toEqual({ text: '', flagged: true });
    expect(isEmptyQuery(parseSearch(''))).toBe(true);
    expect(isEmptyQuery(parseSearch('', { unread: true }))).toBe(false);
  });

  it('bygger Gmail- och IMAP-sökningar', () => {
    const q = parseSearch('från:"Anna Berg" har:bilaga är:flaggad efter:2026-03-05 faktura');
    expect(gmailRaw(q)).toBe('from:"Anna Berg" has:attachment is:starred after:2026/03/05 faktura');
    const c = imapCriteria(q);
    expect(c).toMatchObject({ from: 'Anna Berg', flagged: true, text: 'faktura' });
    expect((c.since as Date).getDate()).toBe(5);
    expect(imapCriteria(parseSearch('är:oläst'))).toEqual({ seen: false });
  });
});
