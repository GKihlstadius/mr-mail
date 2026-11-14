import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_INSTRUCTIONS, AGENT_TOOLS, type AgentArgs } from '../shared/agentTools';
import { APP_VERSION } from '../shared/brand';

// Lokal brygga mellan MCP-servern (stdio) och appen. Lyssnar bara på 127.0.0.1, kräver en slumpad
// nyckel som står i mcp.json i appens datamapp och tar inte emot anrop från webbläsare.
export const AGENT_FILE = 'mcp.json';

export interface AgentEndpoint {
  port: number;
  token: string;
  pid: number;
}

export function startAgentServer(
  dataDir: string,
  call: (tool: string, args: AgentArgs) => Promise<string>,
  log: (msg: string) => void
): Promise<{ server: Server; stop: () => void }> {
  const token = randomBytes(24).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  const file = join(dataDir, AGENT_FILE);

  const server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const auth = Buffer.from(String(req.headers.authorization ?? ''));
    const host = String(req.headers.host ?? '');
    if (req.headers.origin || !/^127\.0\.0\.1(:\d+)?$/.test(host)) return reply(403, { error: 'Local calls only.' });
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return reply(401, { error: 'Wrong key.' });
    if (req.method === 'GET' && req.url === '/tools') return reply(200, { version: APP_VERSION, tools: AGENT_TOOLS, instructions: AGENT_INSTRUCTIONS });
    if (req.method !== 'POST' || req.url !== '/call') return reply(404, { error: 'Not found.' });
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2_000_000) req.destroy();
      else chunks.push(c);
    });
    req.on('end', async () => {
      let tool = '';
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        tool = String(body.tool ?? '');
        const text = await call(tool, body.args ?? {});
        reply(200, { text });
      } catch (e: any) {
        log(`mcp ${tool}: ${e?.message ?? e}`);
        reply(200, { error: e?.message ?? String(e) });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      const info: AgentEndpoint = { port, token, pid: process.pid };
      writeFileSync(file, JSON.stringify(info), { mode: 0o600 });
      resolve({
        server,
        stop: () => {
          server.close();
          try {
            rmSync(file, { force: true });
          } catch {
            /* redan borta */
          }
        }
      });
    });
  });
}
