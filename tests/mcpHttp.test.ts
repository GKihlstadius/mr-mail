import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { clientName, handleMcp, type McpRpcDeps, type McpSession } from '../src/shared/mcpRpc';
import { newHttpToken, startAgentHttp } from '../src/main/agentHttp';
import { AGENT_INSTRUCTIONS, AGENT_TOOLS, type AgentArgs, type CallContext } from '../src/shared/agentTools';

describe('JSON-RPC för MCP', () => {
  const calls: { name: string; args: AgentArgs; client?: string }[] = [];
  const deps: McpRpcDeps = {
    listTools: () => [{ name: 'accounts' }],
    hasTool: (n) => n === 'accounts' || n === 'trash',
    async call(name, args, session) {
      calls.push({ name, args, client: session.client });
      if (name === 'trash') throw new Error('The user declined.');
      return { text: 'ok' };
    }
  };

  it('initialize sparar verktygets namn och svarar med instruktionerna', async () => {
    const session: McpSession = {};
    const r = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '2' } } }, deps, session);
    expect(r?.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'mr-mail' }, instructions: AGENT_INSTRUCTIONS });
    expect(session.client).toBe('Claude Code');
  });

  it('notifieringar och svar besvaras inte', async () => {
    expect(await handleMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps, {})).toBeNull();
    expect(await handleMcp({ jsonrpc: '2.0', id: 4, result: {} } as any, deps, {})).toBeNull();
  });

  it('ping, tools/list, okänd metod och trasigt anrop', async () => {
    expect((await handleMcp({ jsonrpc: '2.0', id: 2, method: 'ping' }, deps, {}))?.result).toEqual({});
    expect((await handleMcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, deps, {}))?.result).toEqual({ tools: [{ name: 'accounts' }] });
    expect((await handleMcp({ jsonrpc: '2.0', id: 5, method: 'x/y' }, deps, {}))?.error?.code).toBe(-32601);
    expect((await handleMcp({ jsonrpc: '2.0', id: 6 } as any, deps, {}))?.error?.code).toBe(-32600);
  });

  it('tools/call skickar vidare med verktygets namn, fel blir isError', async () => {
    const session = { client: 'Zed' };
    const r = await handleMcp({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'accounts', arguments: { a: 1 } } }, deps, session);
    expect(r?.result).toEqual({ content: [{ type: 'text', text: 'ok' }], isError: false });
    expect(calls.at(-1)).toEqual({ name: 'accounts', args: { a: 1 }, client: 'Zed' });
    const bad = await handleMcp({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'trash', arguments: {} } }, deps, session);
    expect(bad?.result).toEqual({ content: [{ type: 'text', text: 'The user declined.' }], isError: true });
    const unknown = await handleMcp({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope' } }, deps, session);
    expect(unknown?.error?.code).toBe(-32602);
  });

  it('läsbara namn på kända verktyg', () => {
    expect(clientName({ name: 'claude-ai' })).toBe('Claude Desktop');
    expect(clientName({ name: 'x', title: 'Mitt verktyg' })).toBe('Mitt verktyg');
    expect(clientName({})).toBeUndefined();
    expect(clientName(null)).toBeUndefined();
  });
});

describe('MCP över HTTP', () => {
  let port = 0;
  let token = newHttpToken();
  let stop = () => {};
  const seen: { tool: string; ctx?: CallContext }[] = [];

  beforeAll(async () => {
    const s = await startAgentHttp({
      port: 0,
      token: () => token,
      call: async (tool, _args, ctx) => {
        seen.push({ tool, ctx });
        return `ran ${tool}`;
      },
      log: () => undefined
    });
    port = s.port;
    stop = s.stop;
  });
  afterAll(() => stop());

  function send(opts: { method?: string; path?: string; headers?: Record<string, string>; body?: unknown }): Promise<{ status: number; headers: Record<string, any>; body: any }> {
    return new Promise((resolve, reject) => {
      const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method: opts.method ?? 'POST',
          path: opts.path ?? '/mcp',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...opts.headers }
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw ? JSON.parse(raw) : null }));
        }
      );
      req.on('error', reject);
      req.end(data);
    });
  }

  it('hela flödet: initialize, initialized, tools/list och tools/call', async () => {
    const init = await send({ body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'cursor-vscode' } } } });
    expect(init.status).toBe(200);
    expect(init.headers['content-type']).toMatch(/application\/json/);
    expect(init.body.result.serverInfo.name).toBe('mr-mail');
    const sid = init.headers['mcp-session-id'];
    expect(sid).toBeTruthy();
    const note = await send({ headers: { 'mcp-session-id': sid }, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    expect(note.status).toBe(202);
    const list = await send({ headers: { 'mcp-session-id': sid }, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    expect(list.body.result.tools.map((t: any) => t.name)).toEqual(AGENT_TOOLS.map((t) => t.name));
    const call = await send({ headers: { 'mcp-session-id': sid }, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'konton', arguments: {} } } });
    expect(call.body.result).toEqual({ content: [{ type: 'text', text: 'ran konton' }], isError: false });
    expect(seen.at(-1)).toEqual({ tool: 'konton', ctx: { client: 'Cursor', via: 'http' } });
    const batch = await send({ body: [{ jsonrpc: '2.0', id: 4, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }] });
    expect(batch.body).toEqual([{ jsonrpc: '2.0', id: 4, result: {} }]);
  });

  it('nekar fel nyckel, ingen nyckel och en gammal nyckel', async () => {
    expect((await send({ headers: { authorization: 'Bearer fel' }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status).toBe(401);
    expect((await send({ headers: { authorization: '' }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status).toBe(401);
    const old = token;
    token = newHttpToken();
    expect((await send({ headers: { authorization: `Bearer ${old}` }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status).toBe(401);
    expect((await send({ body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status).toBe(200);
  });

  it('nekar webbläsare (Origin) och andra värdnamn', async () => {
    expect((await send({ headers: { origin: 'https://evil.test' }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status).toBe(403);
    expect((await send({ headers: { origin: 'null' }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status).toBe(403);
    expect((await send({ headers: { host: `evil.test:${port}` }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status).toBe(403);
    expect((await send({ headers: { host: `localhost:${port}` }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status).toBe(200);
  });

  it('GET ger 405, fel sökväg 404 och trasig JSON 400', async () => {
    const get = await send({ method: 'GET' });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toContain('POST');
    expect((await send({ path: '/annat', body: {} })).status).toBe(404);
    const bad = await new Promise<number>((resolve) => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/mcp', headers: { authorization: `Bearer ${token}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.end('{trasig');
    });
    expect(bad).toBe(400);
  });
});
