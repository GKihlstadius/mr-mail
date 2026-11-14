import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiResult, Settings } from '../shared/types';
import { cleanAiText } from '../shared/compose';
import { flattenForCli, type ChatMessage } from '../shared/prompts';
import { t } from '../shared/i18n';

// ChatGPT på två sätt: OpenAI:s API med egen nyckel, eller abonnemanget via Codex CLI (codex exec).

const TIMEOUT_MS = 240_000;
export const OPENAI_URL = 'https://api.openai.com/v1';

function removeThinking(t: string): string {
  return t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

const SKIP_MODEL = /(audio|realtime|transcribe|tts|image|search|instruct|embedding|moderation|codex|computer|preview|oss)/i;

// Den senaste GPT-modellen för text: nyast först, fullstora före mini och nano.
export function pickLatestGpt(models: { id: string; created?: number }[]): string | null {
  const chat = models.filter((m) => /^(gpt-\d|chatgpt-)/i.test(m.id) && !SKIP_MODEL.test(m.id) && !/-\d{4}-\d{2}-\d{2}$/.test(m.id));
  const rank = (id: string) => (/(mini|nano)/i.test(id) ? 1 : 0);
  chat.sort((a, b) => rank(a.id) - rank(b.id) || (b.created ?? 0) - (a.created ?? 0) || a.id.length - b.id.length);
  return chat[0]?.id ?? null;
}

export async function listOpenAiModels(url: string, key: string): Promise<{ id: string; created?: number }[]> {
  const res = await fetch(url.replace(/\/+$/, '') + '/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
  if (res.status === 401) throw new Error(t('OpenAI godtog inte API-nyckeln.'));
  if (!res.ok) throw new Error(t('OpenAI svarade {status} på modellistan.', { status: res.status }));
  const data: any = await res.json();
  return Array.isArray(data?.data) ? data.data.map((m: any) => ({ id: String(m.id), created: Number(m.created) || 0 })) : [];
}

const latestCache = new Map<string, string>();

export async function resolveOpenAiModel(settings: Settings, key: string): Promise<string> {
  if (settings.openaiModel.trim()) return settings.openaiModel.trim();
  const url = settings.openaiUrl || OPENAI_URL;
  const cached = latestCache.get(url);
  if (cached) return cached;
  const latest = pickLatestGpt(await listOpenAiModels(url, key));
  if (!latest) throw new Error(t('Hittade ingen GPT-modell i kontot hos OpenAI.'));
  latestCache.set(url, latest);
  return latest;
}

export function clearModelCache() {
  latestCache.clear();
}

export async function runOpenAiApi(settings: Settings, key: string | null, messages: ChatMessage[], opts: { raw?: boolean } = {}): Promise<AiResult> {
  const started = Date.now();
  const fail = (error: string): AiResult => ({ ok: false, engine: 'openai', ms: Date.now() - started, error });
  if (!key) return fail(t('Lägg in din API-nyckel från OpenAI under Inställningar, AI-hjälp.'));
  try {
    const model = await resolveOpenAiModel(settings, key);
    const res = await fetch((settings.openaiUrl || OPENAI_URL).replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      // Nyare GPT-modeller vill ha max_completion_tokens och tar inte temperatur.
      body: JSON.stringify({ model, messages, max_completion_tokens: 4000 })
    });
    if (!res.ok) {
      const body: any = await res.json().catch(() => ({}));
      const msg = body?.error?.message ?? '';
      if (res.status === 401) return fail(t('OpenAI godtog inte API-nyckeln.'));
      if (res.status === 429) return fail(t('OpenAI: gränsen är nådd eller krediten slut. {msg}', { msg }).trim());
      return fail(t('OpenAI svarade {status}: {msg}', { status: res.status, msg: String(msg).slice(0, 200) }));
    }
    const data: any = await res.json();
    const content: string = data?.choices?.[0]?.message?.content ?? '';
    const text = opts.raw ? removeThinking(content) : cleanAiText(content);
    if (!text) return fail(t('ChatGPT gav ett tomt svar.'));
    return { ok: true, engine: 'openai', ms: Date.now() - started, text, model };
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return fail(t('ChatGPT svarade inte i tid.'));
    const code = err?.cause?.code;
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || err?.message === 'fetch failed') return fail(t('Når inte OpenAI. Är datorn ansluten till internet?'));
    return fail(err?.message ?? String(err));
  }
}

// Codex CLI: hittas på PATH eller där npm lägger globala program.
export function findCodex(settings: Settings): Promise<string | null> {
  if (settings.codexPath.trim()) return Promise.resolve(existsSync(settings.codexPath.trim()) ? settings.codexPath.trim() : null);
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFile(cmd, ['codex'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      const hits = String(stdout ?? '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const pick = hits.find((h) => /\.(exe|cmd)$/i.test(h)) ?? hits[0];
      if (!err && pick) return resolve(pick);
      const npm = process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'codex.cmd') : '';
      resolve(npm && existsSync(npm) ? npm : null);
    });
  });
}

function runCli(path: string, args: string[], stdin: string, timeoutMs: number): Promise<{ code: number | null; out: string; err: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    // .cmd-filer kräver skal på Windows. Argumenten är fasta flaggor och en sökväg, prompten går via stdin.
    const shell = /\.(cmd|bat)$/i.test(path);
    const quote = (a: string) => (/[\s"&|<>^%]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
    const opts = { cwd: tmpdir(), windowsHide: true, env: { ...process.env, NO_COLOR: '1' } };
    let child;
    try {
      child = shell ? spawn([`"${path}"`, ...args.map(quote)].join(' '), { ...opts, shell: true }) : spawn(path, args, opts);
    } catch (e: any) {
      resolve({ code: -1, out: '', err: e?.message ?? String(e), timedOut: false });
      return;
    }
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: e.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin, 'utf8');
  });
}

export interface CodexStatus {
  installed: boolean;
  chatgpt: boolean;
  detail: string;
}

let statusCache: { at: number; value: CodexStatus } | null = null;

// Inloggad med ChatGPT-konto? `codex login status` säger "Logged in using ChatGPT".
export async function codexStatus(settings: Settings, fresh = false): Promise<CodexStatus> {
  if (!fresh && statusCache && Date.now() - statusCache.at < 60_000) return statusCache.value;
  const path = await findCodex(settings);
  let value: CodexStatus;
  if (!path) value = { installed: false, chatgpt: false, detail: t('Codex CLI är inte installerat.') };
  else {
    const r = await runCli(path, ['login', 'status'], '', 15000);
    const text = `${r.out}\n${r.err}`;
    const chatgpt = r.code === 0 && /chatgpt/i.test(text);
    value = {
      installed: true,
      chatgpt,
      detail: chatgpt ? t('Inloggad med ditt ChatGPT-konto.') : /api key/i.test(text) ? t('Codex är inloggat med API-nyckel, inte ChatGPT-konto.') : t('Logga in med kommandot codex login.')
    };
  }
  statusCache = { at: Date.now(), value };
  return value;
}

export async function runCodex(settings: Settings, messages: ChatMessage[], opts: { raw?: boolean; prompt?: string } = {}): Promise<AiResult> {
  const started = Date.now();
  const fail = (error: string): AiResult => ({ ok: false, engine: 'codex', ms: Date.now() - started, error });
  const path = await findCodex(settings);
  if (!path) return fail(t('Codex CLI är inte installerat. Installera det och logga in med ditt ChatGPT-konto (codex login).'));
  const flat = flattenForCli(messages);
  const input = [flat.system, `INDATA:\n${flat.stdin}`, opts.prompt ?? flat.prompt].filter(Boolean).join('\n\n');
  const dir = mkdtempSync(join(tmpdir(), 'brevlada-codex-'));
  const outFile = join(dir, 'svar.txt');
  const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--output-last-message', outFile];
  if (settings.codexModel.trim()) args.push('--model', settings.codexModel.trim());
  args.push('-');
  try {
    const r = await runCli(path, args, input, TIMEOUT_MS);
    if (r.timedOut) return fail(t('ChatGPT svarade inte i tid.'));
    const last = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
    if (r.code !== 0 && !last.trim()) {
      const msg = `${r.err}\n${r.out}`.trim();
      if (/login|auth|401/i.test(msg)) return fail(t('Codex är inte inloggat. Kör codex login och välj ChatGPT-kontot.'));
      if (/usage limit|rate limit/i.test(msg)) return fail(t('Gränsen för ditt ChatGPT-abonnemang är nådd just nu.'));
      return fail(t('Codex avslutades (kod {code}). {msg}', { code: r.code ?? '', msg: msg.slice(-300) }).trim());
    }
    const text = opts.raw ? removeThinking(last) : cleanAiText(last);
    if (!text) return fail(t('ChatGPT gav ett tomt svar.'));
    return { ok: true, engine: 'codex', ms: Date.now() - started, text };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
