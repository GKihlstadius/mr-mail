import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { AiEngine, AiResult, Settings } from '../shared/types';
import { cleanAiText } from '../shared/compose';
import { flattenForCli, type ChatMessage } from '../shared/prompts';
import { runCodex, runOpenAiApi } from './chatgpt';
import { t } from '../shared/i18n';

const TIMEOUT_MS = 240_000;

interface Endpoint {
  engine: AiEngine;
  label: string;
  url: string;
  model: string;
  key: string;
}

function endpoint(settings: Settings, engine: 'spark' | 'local'): Endpoint {
  return engine === 'local'
    ? { engine, label: t('Datorns modell'), url: settings.localUrl, model: settings.localModel, key: settings.localKey }
    : { engine, label: t('Egen server'), url: settings.sparkUrl, model: settings.sparkModel, key: settings.sparkKey };
}

export function runSpark(settings: Settings, messages: ChatMessage[], opts: { raw?: boolean } = {}): Promise<AiResult> {
  return runOpenAi(endpoint(settings, 'spark'), messages, opts);
}

export function runLocal(settings: Settings, messages: ChatMessage[], opts: { raw?: boolean } = {}): Promise<AiResult> {
  return runOpenAi(endpoint(settings, 'local'), messages, opts);
}

// OpenAI-kompatibelt anrop, används för egen server och för modellen på datorns grafikkort.
async function runOpenAi(ep: Endpoint, messages: ChatMessage[], opts: { raw?: boolean }): Promise<AiResult> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const url = ep.url.replace(/\/+$/, '') + '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(ep.key ? { Authorization: `Bearer ${ep.key}` } : {})
      },
      body: JSON.stringify({
        model: ep.model,
        messages,
        temperature: 0.5,
        max_tokens: 2000,
        chat_template_kwargs: { enable_thinking: false }
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, engine: ep.engine, ms: Date.now() - started, error: t('{label} svarade {status}: {body}', { label: ep.label, status: res.status, body: body.slice(0, 200) }) };
    }
    const data: any = await res.json();
    const content: string = data?.choices?.[0]?.message?.content ?? '';
    const text = opts.raw ? removeThinking(content) : cleanAiText(content);
    if (!text) return { ok: false, engine: ep.engine, ms: Date.now() - started, error: t('{label} gav ett tomt svar.', { label: ep.label }) };
    return { ok: true, engine: ep.engine, ms: Date.now() - started, text };
  } catch (err: any) {
    const code = err?.cause?.code ?? err?.cause?.errors?.[0]?.code ?? (err?.message === 'fetch failed' ? 'ECONNREFUSED' : undefined);
    const msg =
      err?.name === 'AbortError'
        ? t('{label} svarade inte i tid.', { label: ep.label })
        : code === 'ENOTFOUND' || code === 'ECONNREFUSED'
          ? ep.engine === 'local'
            ? t('Datorns modell är inte igång. Starta den lokala servern och försök igen.')
            : t('Når inte servern. Är den igång och nåbar från datorn?')
          : t('Fel mot {label}: {error}', { label: ep.label, error: err?.message ?? err });
    return { ok: false, engine: ep.engine, ms: Date.now() - started, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function removeThinking(t: string): string {
  return t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export function runClaude(settings: Settings, messages: ChatMessage[], opts: { raw?: boolean; prompt?: string } = {}): Promise<AiResult> {
  const started = Date.now();
  const flat = flattenForCli(messages);
  const { system, stdin } = flat;
  const prompt = opts.prompt ?? flat.prompt;
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDECODE;
    const args = [
      '-p',
      '--output-format',
      'json',
      '--tools',
      '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--system-prompt',
      system,
      prompt
    ];
    let child;
    try {
      child = spawn(settings.claudePath, args, { cwd: tmpdir(), env, windowsHide: true });
    } catch (err: any) {
      resolve({ ok: false, engine: 'claude', ms: 0, error: t('Kunde inte starta Claude: {error}', { error: err?.message ?? err }) });
      return;
    }
    let out = '';
    let errOut = '';
    const timer = setTimeout(() => {
      child.kill();
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (errOut += d.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, engine: 'claude', ms: Date.now() - started, error: t('Kunde inte starta Claude: {error}', { error: err.message }) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      try {
        const data = JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? '{}');
        if (data.is_error || data.subtype?.startsWith?.('error')) {
          resolve({ ok: false, engine: 'claude', ms, error: t('Claude: {detail}', { detail: String(data.result ?? data.subtype).slice(0, 300) }) });
          return;
        }
        const text = opts.raw ? removeThinking(String(data.result ?? '')) : cleanAiText(String(data.result ?? ''));
        if (!text) resolve({ ok: false, engine: 'claude', ms, error: t('Claude gav ett tomt svar.') });
        else resolve({ ok: true, engine: 'claude', ms, text });
      } catch {
        resolve({
          ok: false,
          engine: 'claude',
          ms,
          error: t('Claude avslutades (kod {code}). {detail}', { code: code ?? '', detail: (errOut || out).slice(0, 300) }).trim()
        });
      }
    });
    child.stdin.end(stdin, 'utf8');
  });
}

export function runAi(
  settings: Settings,
  messages: ChatMessage[],
  opts: { engine?: AiEngine; raw?: boolean; cliPrompt?: string; openaiKey?: string | null } = {}
): Promise<AiResult> {
  const engine = opts.engine ?? settings.aiEngine;
  if (engine === 'openai') return runOpenAiApi(settings, opts.openaiKey ?? null, messages, { raw: opts.raw });
  if (engine === 'codex') return runCodex(settings, messages, { raw: opts.raw, prompt: opts.cliPrompt });
  if (engine === 'claude') return runClaude(settings, messages, { raw: opts.raw, prompt: opts.cliPrompt });
  if (engine === 'local') return runLocal(settings, messages, opts);
  return runSpark(settings, messages, opts);
}
