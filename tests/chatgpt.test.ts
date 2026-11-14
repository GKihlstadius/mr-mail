import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../src/main/db';
import { clearModelCache, codexStatus, pickLatestGpt, runCodex, runOpenAiApi } from '../src/main/chatgpt';
import { runAi } from '../src/main/ai';
import type { ChatMessage } from '../src/shared/prompts';

const messages: ChatMessage[] = [
  { role: 'system', content: 'Du skriver svarsutkast åt Alex.' },
  { role: 'user', content: 'Från: Karin\nÄmne: Demo\n\nKan du visa Nordljus på tisdag?' }
];

describe('val av GPT-modell', () => {
  it('tar den senaste fullstora textmodellen', () => {
    const models = [
      { id: 'gpt-4o', created: 1 },
      { id: 'gpt-5.5', created: 3 },
      { id: 'gpt-5.5-mini', created: 4 },
      { id: 'gpt-realtime', created: 5 },
      { id: 'gpt-image-1', created: 6 },
      { id: 'gpt-5.5-2026-08-01', created: 7 },
      { id: 'text-embedding-3-large', created: 8 }
    ];
    expect(pickLatestGpt(models)).toBe('gpt-5.5');
    expect(pickLatestGpt([{ id: 'gpt-5-mini', created: 2 }])).toBe('gpt-5-mini');
    expect(pickLatestGpt([])).toBeNull();
  });
});

describe('ChatGPT via OpenAI:s API (låtsad server)', () => {
  let server: Server;
  let url = '';
  const seen: any[] = [];
  let mode: 'ok' | '429' = 'ok';

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.headers.authorization !== 'Bearer sk-test') {
          res.statusCode = 401;
          return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
        }
        if (req.method === 'GET' && req.url === '/v1/models') {
          return res.end(
            JSON.stringify({
              data: [
                { id: 'gpt-4.1', created: 10 },
                { id: 'gpt-5.5', created: 30 },
                { id: 'gpt-5.5-nano', created: 40 },
                { id: 'gpt-realtime-2', created: 50 }
              ]
            })
          );
        }
        if (req.method === 'POST' && req.url === '/v1/chat/completions') {
          const json = JSON.parse(body);
          seen.push(json);
          if (mode === '429') {
            res.statusCode = 429;
            return res.end(JSON.stringify({ error: { message: 'You exceeded your current quota' } }));
          }
          return res.end(JSON.stringify({ choices: [{ message: { content: 'Hej Karin!\n\nTisdag passar fint.\n\nVänliga hälsningar,\nAlex' } }] }));
        }
        res.statusCode = 404;
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => server.close());

  it('väljer senaste GPT-modellen och skickar rätt anrop', async () => {
    clearModelCache();
    const res = await runOpenAiApi({ ...DEFAULT_SETTINGS, openaiUrl: url }, 'sk-test', messages);
    expect(res).toMatchObject({ ok: true, engine: 'openai', model: 'gpt-5.5' });
    expect(res.text).toContain('Tisdag passar fint');
    const req = seen.at(-1);
    expect(req.model).toBe('gpt-5.5');
    expect(req.max_completion_tokens).toBeGreaterThan(0);
    expect(req).not.toHaveProperty('temperature');
    expect(req).not.toHaveProperty('max_tokens');
    expect(req.messages[1].content).toContain('visa Nordljus');
  });

  it('använder vald modell och går via runAi', async () => {
    const res = await runAi({ ...DEFAULT_SETTINGS, openaiUrl: url, openaiModel: 'gpt-4.1', aiEngine: 'openai' }, messages, { openaiKey: 'sk-test' });
    expect(res.ok).toBe(true);
    expect(seen.at(-1).model).toBe('gpt-4.1');
  });

  it('förklarar saknad nyckel, fel nyckel och slut på kredit', async () => {
    clearModelCache();
    expect((await runOpenAiApi({ ...DEFAULT_SETTINGS, openaiUrl: url }, null, messages)).error).toMatch(/API-nyckel/);
    expect((await runOpenAiApi({ ...DEFAULT_SETTINGS, openaiUrl: url }, 'sk-fel', messages)).error).toMatch(/godtog inte API-nyckeln/);
    mode = '429';
    expect((await runOpenAiApi({ ...DEFAULT_SETTINGS, openaiUrl: url, openaiModel: 'gpt-5.5' }, 'sk-test', messages)).error).toMatch(/krediten slut/);
    mode = 'ok';
  });

  it('säger tydligt när OpenAI inte nås', async () => {
    const res = await runOpenAiApi({ ...DEFAULT_SETTINGS, openaiUrl: 'http://127.0.0.1:9/v1', openaiModel: 'gpt-5.5' }, 'sk-test', messages);
    expect(res.error).toMatch(/Når inte OpenAI/);
  });
});

// Låtsad Codex CLI: login status och exec som skriver svaret till --output-last-message.
describe('ChatGPT via abonnemanget (låtsad codex)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brevlada-codex-test-'));
  const log = join(dir, 'anrop.json');
  const fake = join(dir, 'fake.mjs');
  writeFileSync(
    fake,
    `import { writeFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'login') { console.log(process.env.FAKE_CODEX_LOGIN ?? 'Logged in using ChatGPT'); process.exit(process.env.FAKE_CODEX_LOGIN === 'Not logged in' ? 1 : 0); }
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input }));
  if (process.env.FAKE_CODEX_FAIL) { console.error('Error: not logged in, run codex login'); process.exit(1); }
  const out = args[args.indexOf('--output-last-message') + 1];
  writeFileSync(out, 'Hej Karin!\\n\\nTisdag klockan 14 passar bra.\\n\\nVänliga hälsningar,\\nAlex');
  console.log('lots of progress output');
});
`
  );
  const isWin = process.platform === 'win32';
  const bin = join(dir, isWin ? 'codex.cmd' : 'codex');
  writeFileSync(bin, isWin ? `@echo off\r\nnode "%~dp0fake.mjs" %*\r\n` : `#!/bin/sh\nexec node "$(dirname "$0")/fake.mjs" "$@"\n`, { mode: 0o755 });
  const settings = { ...DEFAULT_SETTINGS, codexPath: bin, aiEngine: 'codex' as const };
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('ser att Codex är inloggat med ChatGPT-kontot', async () => {
    expect(await codexStatus(settings, true)).toMatchObject({ installed: true, chatgpt: true });
    process.env.FAKE_CODEX_LOGIN = 'Logged in using an API key - sk-***';
    expect(await codexStatus(settings, true)).toMatchObject({ installed: true, chatgpt: false });
    delete process.env.FAKE_CODEX_LOGIN;
    expect(await codexStatus({ ...settings, codexPath: join(dir, 'finns-inte.cmd') }, true)).toMatchObject({ installed: false });
  });

  it('skriver utkast via codex exec med prompten på stdin', async () => {
    const res = await runAi(settings, messages);
    expect(res).toMatchObject({ ok: true, engine: 'codex' });
    expect(res.text).toContain('Tisdag klockan 14');
    const call = JSON.parse(readFileSync(log, 'utf8'));
    expect(call.args.slice(0, 2)).toEqual(['exec', '--skip-git-repo-check']);
    expect(call.args).toContain('read-only');
    expect(call.args.at(-1)).toBe('-');
    expect(call.input).toContain('Du skriver svarsutkast åt Alex.');
    expect(call.input).toContain('Kan du visa Nordljus på tisdag?');
  });

  it('förklarar när Codex inte är inloggat', async () => {
    process.env.FAKE_CODEX_FAIL = '1';
    try {
      expect((await runCodex(settings, messages)).error).toMatch(/codex login/);
    } finally {
      delete process.env.FAKE_CODEX_FAIL;
    }
  });
});
