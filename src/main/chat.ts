// Fråga Mr Mail: chatten i appen. En agentslinga mot en OpenAI-kompatibel modell med samma
// verktyg som MCP. Verktygen anropas genom samma behörigheter och logg som AI-verktygen.
// Mejlens innehåll loggas aldrig.
import { AGENT_INSTRUCTIONS, type AgentTool } from '../shared/agentTools';
import { APP_NAME } from '../shared/brand';
import { removeDashes } from '../shared/compose';
import { t } from '../shared/i18n';

export const MAX_TOOL_ROUNDS = 8;
const RESULT_LIMIT = 12_000;
const OLD_RESULT_LIMIT = 1_500;
const TIMEOUT_MS = 180_000;

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ApiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface Completion {
  content: string;
  toolCalls: ToolCall[];
}

export type Completer = (messages: ApiMessage[], opts: { toolChoice: 'auto' | 'none' }) => Promise<Completion>;

export function toOpenAiTools(tools: AgentTool[]) {
  return tools.map((tool) => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number) => String(n).padStart(2, '0');

export function chatSystemPrompt(now: Date, zone: string): string {
  const stamp = `${WEEKDAYS[now.getDay()]} ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return [
    `You are the assistant inside ${APP_NAME}, the user's email client. You help with email and the calendar by calling the tools.`,
    AGENT_INSTRUCTIONS,
    `Now it is ${stamp} local time (${zone}). Work out dates like "tomorrow" or "on Tuesday" from this.`,
    'Look things up with the tools instead of guessing. Answer in the language the user writes in, short and calm: plain sentences, "- " lists and **bold** only when it helps. No headings, no tables.',
    'When you mention a specific email, link it as [subject](mail:ID), and an event as [title](event:ID), with the exact id from a tool result. Never make up ids.',
    'To book a meeting with someone, find the address with find_contact, and a time with find_free_time when none is given. Invitations, sending and deleting need the user\'s approval, which the app asks for; only do them when the user asked.'
  ].join('\n');
}

// Verktygsanrop ur svaret. Lokala modeller skriver ibland anropet som <tool_call>{...}</tool_call> i texten.
export function parseCompletion(data: any): Completion {
  const msg = data?.choices?.[0]?.message ?? {};
  let content = typeof msg.content === 'string' ? msg.content : '';
  const toolCalls: ToolCall[] = [];
  if (Array.isArray(msg.tool_calls)) {
    for (const [i, tc] of msg.tool_calls.entries()) {
      const name = tc?.function?.name;
      if (typeof name !== 'string' || !name) continue;
      const args = tc.function.arguments;
      toolCalls.push({ id: String(tc.id || `call_${i}`), name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) });
    }
  }
  if (!toolCalls.length && content.includes('<tool_call>')) {
    content = content.replace(/<tool_call>([\s\S]*?)<\/tool_call>/g, (_: string, body: string) => {
      try {
        const v = JSON.parse(body.trim());
        if (typeof v?.name === 'string') toolCalls.push({ id: `call_${toolCalls.length}`, name: v.name, arguments: JSON.stringify(v.arguments ?? {}) });
      } catch {
        /* trasigt anrop hoppas över */
      }
      return '';
    });
  }
  content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return { content, toolCalls };
}

export function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[truncated]` : s);

export interface StepEvent {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  done: boolean;
  ok?: boolean;
}

export interface LoopInput {
  history: ApiMessage[];
  complete: Completer;
  call(tool: string, args: Record<string, unknown>): Promise<string>;
  onStep?(step: StepEvent): void;
  maxRounds?: number;
  signal?: AbortSignal;
}

// Agentslingan: modellen anropar verktyg i upp till åtta varv, sedan måste den svara.
export async function runChatLoop(o: LoopInput): Promise<string> {
  const max = o.maxRounds ?? MAX_TOOL_ROUNDS;
  for (let round = 0; ; round++) {
    if (o.signal?.aborted) throw new ChatAborted();
    const last = round >= max;
    const res = await o.complete(o.history, { toolChoice: last ? 'none' : 'auto' });
    if (o.signal?.aborted) throw new ChatAborted();
    if (!res.toolCalls.length || last) {
      const text = removeDashes(res.content).trim();
      o.history.push({ role: 'assistant', content: text });
      return text;
    }
    o.history.push({
      role: 'assistant',
      content: res.content || null,
      tool_calls: res.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }))
    });
    for (const [i, tc] of res.toolCalls.entries()) {
      const id = `${round}-${i}`;
      const args = parseArgs(tc.arguments);
      o.onStep?.({ id, tool: tc.name, args, done: false });
      let result: string;
      let ok = true;
      if (o.signal?.aborted) {
        result = 'Cancelled by the user.';
        ok = false;
      } else {
        try {
          result = await o.call(tc.name, args);
        } catch (e: any) {
          ok = false;
          result = `Error: ${String(e?.message ?? e)}`;
        }
      }
      o.onStep?.({ id, tool: tc.name, args, done: true, ok });
      o.history.push({ role: 'tool', tool_call_id: tc.id, content: clip(result, RESULT_LIMIT) });
    }
  }
}

export class ChatAborted extends Error {
  constructor() {
    super('aborted');
  }
}

// Äldre verktygssvar kortas, så att en lång chatt inte växer utan gräns.
export function compactHistory(history: ApiMessage[]) {
  for (const m of history) if (m.role === 'tool' && m.content.length > OLD_RESULT_LIMIT) m.content = clip(m.content, OLD_RESULT_LIMIT);
  const turns = history.filter((m) => m.role === 'user').length;
  if (turns > 20) {
    const firstUser = history.findIndex((m, i) => i > 0 && m.role === 'user');
    const secondUser = history.findIndex((m, i) => i > firstUser && m.role === 'user');
    if (firstUser > 0 && secondUser > firstUser) history.splice(firstUser, secondUser - firstUser);
  }
}

export interface ChatEndpoint {
  url: string;
  key: string;
  model: string;
  label: string;
  // OpenAI:s API vill ha max_completion_tokens och ingen temperatur.
  openai: boolean;
}

export function openAiCompleter(ep: ChatEndpoint, tools: AgentTool[], signal?: AbortSignal): Completer {
  const defs = toOpenAiTools(tools);
  return async (messages, opts) => {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const body = ep.openai
      ? { model: ep.model, messages, tools: defs, tool_choice: opts.toolChoice, max_completion_tokens: 4000 }
      : { model: ep.model, messages, tools: defs, tool_choice: opts.toolChoice, temperature: 0.3, max_tokens: 2000, chat_template_kwargs: { enable_thinking: false } };
    let res: Response;
    try {
      res = await fetch(ep.url.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { 'Content-Type': 'application/json', ...(ep.key ? { Authorization: `Bearer ${ep.key}` } : {}) },
        body: JSON.stringify(body)
      });
    } catch (err: any) {
      if (signal?.aborted) throw new ChatAborted();
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new Error(t('{label} svarade inte i tid.', { label: ep.label }));
      throw new Error(t('Når inte {label}. Är den igång och nåbar från datorn?', { label: ep.label }));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = text;
      try {
        msg = JSON.parse(text)?.error?.message ?? text;
      } catch {
        /* svaret var inte JSON */
      }
      if (res.status === 401) throw new Error(t('{label} godtog inte nyckeln.', { label: ep.label }));
      throw new Error(t('{label} svarade {status}: {body}', { label: ep.label, status: res.status, body: String(msg).slice(0, 200) }));
    }
    return parseCompletion(await res.json());
  };
}
