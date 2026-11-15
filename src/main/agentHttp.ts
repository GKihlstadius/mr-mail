import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AGENT_TOOLS, isKnownTool, type AgentCall } from '../shared/agentTools';
import { handleMcp, type McpRpcDeps, type McpSession, type RpcResponse } from '../shared/mcpRpc';

// MCP över Streamable HTTP för AI-verktyg som bara tar en adress. Lyssnar bara på 127.0.0.1,
// kräver nyckeln från inställningarna och tar inte emot anrop från webbläsare (Origin) eller
// via andra värdnamn (DNS rebinding). Svaren är vanlig JSON, ingen SSE.

export const DEFAULT_HTTP_PORT = 7337;

export function newHttpToken(): string {
  return `mrm_${randomBytes(24).toString('base64url')}`;
}

export interface AgentHttpOptions {
  port: number;
  token: () => string;
  call: AgentCall;
  log: (msg: string) => void;
}

const MAX_BODY = 2_000_000;
const MAX_SESSIONS = 200;

function sameSecret(got: string, want: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startAgentHttp(opts: AgentHttpOptions): Promise<{ server: Server; port: number; stop: () => void }> {
  const sessions = new Map<string, McpSession>();

  const deps: McpRpcDeps = {
    listTools: () => AGENT_TOOLS,
    hasTool: (name) => isKnownTool(name),
    async call(name, args, session) {
      try {
        return { text: await opts.call(name, args, { client: session.client, via: 'http' }) };
      } catch (e: any) {
        opts.log(`mcp http ${name}: ${e?.message ?? e}`);
        return { error: e?.message ?? String(e) };
      }
    }
  };

  const reply = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    if (body === undefined) {
      res.writeHead(status, headers);
      return res.end();
    }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
  };
  const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', id: null, error: { code, message } });

  async function onRequest(req: IncomingMessage, res: ServerResponse) {
    const host = String(req.headers.host ?? '');
    if (req.headers.origin !== undefined || !/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) return reply(res, 403, rpcError(-32000, 'Local calls only.'));
    const token = opts.token();
    const auth = String(req.headers.authorization ?? '');
    if (!token || !sameSecret(auth, `Bearer ${token}`)) return reply(res, 401, rpcError(-32001, 'Wrong key.'), { 'www-authenticate': 'Bearer' });
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/mcp') return reply(res, 404, rpcError(-32000, 'Not found.'));
    const sid = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : '';
    if (req.method === 'DELETE') {
      sessions.delete(sid);
      return reply(res, 200);
    }
    if (req.method !== 'POST') return reply(res, 405, rpcError(-32000, 'Method not allowed.'), { allow: 'POST, DELETE' });

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req as AsyncIterable<Buffer>) {
      size += c.length;
      if (size > MAX_BODY) return reply(res, 413, rpcError(-32600, 'Too large.'));
      chunks.push(c);
    }
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return reply(res, 400, rpcError(-32700, 'Invalid JSON.'));
    }
    const list = Array.isArray(body) ? body : [body];
    const isInit = list.some((r) => r && r.method === 'initialize');
    let sessionId = sid && sessions.has(sid) ? sid : '';
    if (isInit && !sessionId) {
      sessionId = randomUUID();
      sessions.set(sessionId, {});
      if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    }
    const session = sessions.get(sessionId) ?? {};
    const out: RpcResponse[] = [];
    for (const r of list) {
      const resp = await handleMcp(r, deps, session);
      if (resp) out.push(resp);
    }
    const headers: Record<string, string> = sessionId ? { 'mcp-session-id': sessionId } : {};
    if (!out.length) return reply(res, 202, undefined, headers);
    reply(res, 200, Array.isArray(body) ? out : out[0], headers);
  }

  const server = createServer((req, res) => {
    onRequest(req, res).catch((e) => {
      opts.log(`mcp http: ${e?.message ?? e}`);
      if (!res.headersSent) reply(res, 500, rpcError(-32603, 'Internal error.'));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', reject);
      server.on('error', (e) => opts.log(`mcp http: ${e.message}`));
      const port = (server.address() as { port: number }).port;
      resolve({
        server,
        port,
        stop: () => {
          server.close();
          server.closeAllConnections();
        }
      });
    });
  });
}
