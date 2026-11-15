import { afterEach, describe, expect, it } from 'vitest';
import { chatSupported, findRefLinks, parseChatText, parseInline, stepLabel } from '../src/shared/chat';
import { compactHistory, parseArgs, parseCompletion, runChatLoop, toOpenAiTools, ChatAborted, type ApiMessage, type Completer } from '../src/main/chat';
import { AGENT_TOOLS } from '../src/shared/agentTools';
import { setLang } from '../src/shared/i18n';

afterEach(() => setLang('sv'));

describe('stegen', () => {
  it('beskriver verktygen i klartext', () => {
    expect(stepLabel('search_emails', { query: 'karin' })).toBe('Söker i mejlen…');
    expect(stepLabel('read_email', { id: 'm1' }, (id) => (id === 'm1' ? 'Karin' : null))).toBe('Läser mejl från Karin');
    expect(stepLabel('read_email', { id: 'x' }, () => null)).toBe('Läser ett mejl…');
    expect(stepLabel('create_event', { title: 'Möte med Karin' })).toBe('Bokar Möte med Karin…');
    expect(stepLabel('okänt', {})).toBe('Använder okänt…');
  });
  it('följer språket', () => {
    setLang('en');
    expect(stepLabel('search_emails', {})).toBe('Searching your email…');
  });
  it('vet vilka motorer som klarar verktyg', () => {
    expect(['openai', 'local', 'spark'].every((e) => chatSupported(e as any))).toBe(true);
    expect(chatSupported('claude')).toBe(false);
    expect(chatSupported('codex')).toBe(false);
  });
});

describe('länkar i svaret', () => {
  const refs = { mail: { 'acc|INBOX|1|5': 'Demo' }, event: { ev1: 'Fika' } };
  it('hittar länkarna', () => {
    expect(findRefLinks('Se [Demo](mail:acc|INBOX|1|5) och [Fika](event:ev1).')).toEqual([
      { kind: 'mail', id: 'acc|INBOX|1|5', label: 'Demo' },
      { kind: 'event', id: 'ev1', label: 'Fika' }
    ]);
  });
  it('länkar bara kända id, okända blir text', () => {
    const parts = parseInline('**Viktigt:** [Demo](mail:acc|INBOX|1|5), [Påhittat](mail:nej)', refs);
    expect(parts).toEqual([
      { kind: 'bold', text: 'Viktigt:' },
      { kind: 'text', text: ' ' },
      { kind: 'ref', ref: 'mail', id: 'acc|INBOX|1|5', text: 'Demo' },
      { kind: 'text', text: ', Påhittat' }
    ]);
  });
  it('delar upp i stycken och listor', () => {
    const blocks = parseChatText('Två saker:\n\n- [Demo](mail:acc|INBOX|1|5)\n- Ring Karin\n\n1. Ett\n2. Två\n## Rubrik', refs);
    expect(blocks.map((b) => b.kind)).toEqual(['p', 'ul', 'ol', 'p']);
    expect(blocks[1].kind === 'ul' && blocks[1].items.length).toBe(2);
    expect(blocks[3]).toEqual({ kind: 'p', lines: [[{ kind: 'bold', text: 'Rubrik' }]] });
  });
});

describe('modellens svar', () => {
  it('läser verktygsanrop', () => {
    const c = parseCompletion({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_emails', arguments: '{"query":"karin"}' } }] } }] });
    expect(c).toEqual({ content: '', toolCalls: [{ id: 'c1', name: 'search_emails', arguments: '{"query":"karin"}' }] });
  });
  it('läser anrop som lokala modeller skriver i texten', () => {
    const c = parseCompletion({ choices: [{ message: { content: '<think>hm</think>Jag söker.<tool_call>\n{"name":"list_events","arguments":{"from":"2026-11-16"}}\n</tool_call>' } }] });
    expect(c.content).toBe('Jag söker.');
    expect(c.toolCalls).toEqual([{ id: 'call_0', name: 'list_events', arguments: '{"from":"2026-11-16"}' }]);
  });
  it('tål trasiga argument', () => {
    expect(parseArgs('{trasig')).toEqual({});
    expect(parseArgs('[1]')).toEqual({});
    expect(parseArgs('{"a":1}')).toEqual({ a: 1 });
  });
  it('gör verktygen till funktioner', () => {
    const tools = toOpenAiTools(AGENT_TOOLS);
    expect(tools.length).toBe(AGENT_TOOLS.length);
    expect(tools[0]).toMatchObject({ type: 'function', function: { name: 'accounts' } });
    expect(tools.every((x) => /^[a-z_]+$/.test(x.function.name))).toBe(true);
  });
});

describe('agentslingan', () => {
  const sys = (): ApiMessage[] => [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Vad behöver jag svara på?' }];

  it('anropar verktyg och svarar sedan', async () => {
    const history = sys();
    const calls: string[] = [];
    const steps: string[] = [];
    let n = 0;
    const complete: Completer = async () =>
      n++ === 0 ? { content: '', toolCalls: [{ id: 'a', name: 'search_emails', arguments: '{"query":"is:unread"}' }] } : { content: 'Svara Karin – i dag.', toolCalls: [] };
    const text = await runChatLoop({
      history,
      complete,
      call: async (tool, args) => {
        calls.push(`${tool}:${args.query}`);
        return '[{"id":"m1"}]';
      },
      onStep: (s) => steps.push(`${s.tool}:${s.done ? (s.ok ? 'ok' : 'fel') : 'start'}`)
    });
    expect(text).toBe('Svara Karin, i dag.');
    expect(calls).toEqual(['search_emails:is:unread']);
    expect(steps).toEqual(['search_emails:start', 'search_emails:ok']);
    expect(history.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
  });

  it('skickar fel tillbaka till modellen', async () => {
    const history = sys();
    let n = 0;
    const complete: Completer = async () => (n++ === 0 ? { content: '', toolCalls: [{ id: 'a', name: 'send_email', arguments: '{}' }] } : { content: 'Det gick inte.', toolCalls: [] });
    await runChatLoop({
      history,
      complete,
      call: async () => {
        throw new Error('The user declined this action.');
      }
    });
    expect(history[3]).toEqual({ role: 'tool', tool_call_id: 'a', content: 'Error: The user declined this action.' });
  });

  it('slutar efter åtta varv och kräver ett svar', async () => {
    const history = sys();
    const choices: string[] = [];
    const complete: Completer = async (_m, o) => {
      choices.push(o.toolChoice);
      return o.toolChoice === 'none' ? { content: 'Klart.', toolCalls: [] } : { content: '', toolCalls: [{ id: 'x', name: 'accounts', arguments: '{}' }] };
    };
    let calls = 0;
    const text = await runChatLoop({ history, complete, call: async () => (calls++, 'ok') });
    expect(text).toBe('Klart.');
    expect(calls).toBe(8);
    expect(choices.filter((c) => c === 'auto').length).toBe(8);
    expect(choices.at(-1)).toBe('none');
  });

  it('kan avbrytas', async () => {
    const ctrl = new AbortController();
    const complete: Completer = async () => {
      ctrl.abort();
      return { content: '', toolCalls: [{ id: 'a', name: 'accounts', arguments: '{}' }] };
    };
    let called = false;
    await expect(runChatLoop({ history: sys(), complete, signal: ctrl.signal, call: async () => ((called = true), '') })).rejects.toBeInstanceOf(ChatAborted);
    expect(called).toBe(false);
  });

  it('kortar gamla verktygssvar', () => {
    const history: ApiMessage[] = [{ role: 'system', content: 's' }, { role: 'tool', tool_call_id: 'a', content: 'x'.repeat(5000) }];
    compactHistory(history);
    expect((history[1] as any).content.length).toBeLessThan(1600);
  });
});
