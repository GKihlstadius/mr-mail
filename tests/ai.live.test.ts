import { describe, expect, it } from 'vitest';
import { runClaude, runSpark } from '../src/main/ai';
import { DEFAULT_SETTINGS } from '../src/main/db';
import { buildMessages } from '../src/shared/prompts';
import type { FullMessage } from '../src/shared/types';

// Körs bara med MRMAIL_LIVE_AI=1, eftersom de anropar Sparken och Claude på riktigt.
const live = process.env.MRMAIL_LIVE_AI === '1';

const mail: FullMessage = {
  id: 'demo',
  accountId: 'alex-nordljus-se',
  folder: 'INBOX',
  uid: 1,
  subject: 'Demo av Nordljus nästa vecka?',
  from: { name: 'Karin Lund', address: 'karin.lund@exempelbolaget.se' },
  to: [{ name: 'Alex Berg', address: 'alex@nordljus.se' }],
  cc: [],
  date: Date.UTC(2026, 10, 11, 8, 15),
  preview: '',
  seen: true,
  flagged: false,
  answered: false,
  hasAttachments: false,
  messageId: '<demo@exempelbolaget.se>',
  body: {
    id: 'demo',
    html: null,
    text:
      'Hej Alex,\n\nVi pratade kort på mässan i Göteborg. Vi är ett team på tolv personer som tappar bort beslut från möten hela tiden. ' +
      'Skulle du kunna visa Nordljus för oss nästa vecka? Tisdag eller torsdag eftermiddag passar bäst.\n\nVänliga hälsningar,\nKarin Lund\nExempelbolaget AB',
    attachments: [],
    inlineImages: {},
    references: [],
    inReplyTo: null,
    replyTo: [],
    hasRemoteImages: false
  }
};

const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

function messages(instruction?: string, draft?: string) {
  return buildMessages({
    message: mail,
    ownName: 'Alex Berg',
    ownEmail: 'alex@nordljus.se',
    tone: DEFAULT_SETTINGS.tone,
    examples: [],
    draft,
    history: draft ? [{ role: 'assistant', content: draft }] : [],
    instruction
  });
}

describe.runIf(live)('AI-förslag på riktigt', () => {
  it('Sparken skriver ett svarsutkast och kan göra det kortare', async () => {
    const first = await runSpark(DEFAULT_SETTINGS, messages());
    console.log(`\n--- Sparken (${first.ms} ms) ---\n${first.text ?? first.error}\n`);
    expect(first.ok).toBe(true);
    expect(first.text!).toMatch(/Karin/);
    expect(first.text!).not.toMatch(DASHES);
    expect(first.text!).not.toMatch(/<think>|reasoning/i);

    const shorter = await runSpark(DEFAULT_SETTINGS, messages('kortare', first.text));
    console.log(`\n--- Sparken, kortare (${shorter.ms} ms) ---\n${shorter.text ?? shorter.error}\n`);
    expect(shorter.ok).toBe(true);
    expect(shorter.text!.length).toBeLessThan(first.text!.length);
  }, 300_000);

  it('Claude via Claude Code svarar med ett utkast', async () => {
    const res = await runClaude(DEFAULT_SETTINGS, messages());
    console.log(`\n--- Claude (${res.ms} ms) ---\n${res.text ?? res.error}\n`);
    expect(res.ok).toBe(true);
    expect(res.text!).toMatch(/Karin/);
    expect(res.text!).not.toMatch(DASHES);
  }, 300_000);
});
