import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../src/shared/i18n';
import { parseSearch } from '../src/shared/search';
import { quoteHeader, forwardHeaderLines, prefixSubject } from '../src/shared/compose';
import { buildMessages } from '../src/shared/prompts';
import { roleLabel } from '../src/renderer/folderTree';
import type { FullMessage } from '../src/shared/types';

const msg = {
  date: Date.UTC(2026, 0, 5, 10, 0),
  from: { name: 'Anna', address: 'anna@x.se' },
  to: [{ name: '', address: 'me@x.se' }],
  cc: [],
  subject: 'Hej',
  body: { text: 'Hej', attachments: [] }
} as unknown as FullMessage;

describe('engelska i delade moduler', () => {
  afterEach(() => setLang('sv'));

  it('citatrubrik och vidarebefordran följer språket', () => {
    expect(quoteHeader(msg)).toMatch(/^Den .* skrev Anna <anna@x.se>:$/);
    setLang('en');
    expect(quoteHeader(msg)).toMatch(/^On .*, Anna <anna@x.se> wrote:$/);
    const lines = forwardHeaderLines(msg);
    expect(lines[0]).toBe('---------- Forwarded message ---------');
    expect(lines[1]).toMatch(/^From: /);
    expect(prefixSubject('', 'Re')).toBe('Re: (no subject)');
    expect(roleLabel('inbox')).toBe('Inbox');
  });

  it('sökprefix fungerar på båda språken oavsett inställning', () => {
    for (const l of ['sv', 'en'] as const) {
      setLang(l);
      expect(parseSearch('from:anna subject:hej has:attachment is:unread is:flagged before:2026-02-01 after:2026-01-01')).toMatchObject({
        from: 'anna', subject: 'hej', hasAttachment: true, unread: true, flagged: true, before: '2026-02-01', after: '2026-01-01'
      });
      expect(parseSearch('från:anna är:oläst')).toMatchObject({ from: 'anna', unread: true });
    }
  });

  it('AI-prompten blir engelsk', () => {
    const input = { message: msg, ownName: 'Me', ownEmail: 'me@x.se', tone: 'kort', examples: [], history: [] };
    expect(buildMessages(input)[0].content).toMatch(/Du skriver/);
    setLang('en');
    expect(buildMessages(input)[0].content).toMatch(/same language as the email being answered/);
  });
});
