// MCP-server för Brevlåda över stdio. Startas av Claude Code, Zed eller opencode, antingen med
// Node eller med appens exe och ELECTRON_RUN_AS_NODE=1. Anropen skickas vidare till appen,
// som startas dold i systemfältet om den inte redan körs.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { AGENT_INSTRUCTIONS, AGENT_TOOLS, TOOL_ALIASES, type AgentArgs } from '../shared/agentTools';
import { APP_FILE_NAME, APP_NAME, APP_VERSION, dataDirName } from '../shared/brand';

const appData = process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
const dataDir = process.env.MRMAIL_DATA || join(appData, dataDirName((n) => existsSync(join(appData, n))));
const endpointFile = join(dataDir, 'mcp.json');

interface Endpoint {
  port: number;
  token: string;
}

function readEndpoint(): Endpoint | null {
  try {
    const e = JSON.parse(readFileSync(endpointFile, 'utf8'));
    return typeof e.port === 'number' && typeof e.token === 'string' ? e : null;
  } catch {
    return null;
  }
}

async function post(ep: Endpoint, tool: string, args: AgentArgs): Promise<{ text?: string; error?: string }> {
  const res = await fetch(`http://127.0.0.1:${ep.port}/call`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ep.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tool, args }),
    signal: AbortSignal.timeout(180_000)
  });
  if (res.status === 401) throw Object.assign(new Error('stale'), { stale: true });
  return (await res.json()) as { text?: string; error?: string };
}

// Verktygslistan hämtas från appen som körs, så att nya verktyg syns direkt efter en uppdatering
// utan att Claude Code eller Zed behöver startas om. Listan som byggdes in är reserv.
let tools: unknown[] = AGENT_TOOLS;
let toolsKey = JSON.stringify(AGENT_TOOLS);

async function refreshTools(): Promise<boolean> {
  const ep = readEndpoint();
  if (!ep) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${ep.port}/tools`, {
      headers: { authorization: `Bearer ${ep.token}` },
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { tools?: unknown[] };
    if (!Array.isArray(body.tools) || !body.tools.length) return false;
    const key = JSON.stringify(body.tools);
    if (key === toolsKey) return false;
    tools = body.tools;
    toolsKey = key;
    return true;
  } catch {
    return false;
  }
}

const knownTool = (name: string) => Object.prototype.hasOwnProperty.call(TOOL_ALIASES, name) || tools.some((t: any) => t?.name === name);

let watching = false;
function watchTools() {
  if (watching) return;
  watching = true;
  setInterval(async () => {
    if (await refreshTools()) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }, 15_000).unref();
}

function appCommand(): string | null {
  if (process.env.MRMAIL_APP) return process.env.MRMAIL_APP;
  if (process.versions.electron) return process.execPath;
  const installed = join(process.env.LOCALAPPDATA || '', 'Programs', 'mr-mail', `${APP_FILE_NAME}.exe`);
  return existsSync(installed) ? installed : null;
}

let starting: Promise<void> | null = null;

function startApp(): Promise<void> {
  if (starting) return starting;
  starting = (async () => {
    const cmd = appCommand();
    if (!cmd) throw new Error(`${APP_NAME} is not installed. Start the app first.`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const before = readEndpoint()?.token;
    let failed: Error | null = null;
    const child = spawn(cmd, ['--hidden'], { detached: true, stdio: 'ignore', env });
    child.on('error', (e) => (failed = e));
    child.unref();
    const until = Date.now() + 45_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 400));
      if (failed) throw new Error(`Could not start ${APP_NAME}: ${(failed as Error).message}`);
      const ep = readEndpoint();
      if (ep && ep.token !== before) return;
    }
    throw new Error(`${APP_NAME} did not start within 45 seconds.`);
  })().finally(() => {
    starting = null;
  });
  return starting;
}

async function callApp(tool: string, args: AgentArgs): Promise<{ text?: string; error?: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ep = readEndpoint();
    if (ep) {
      try {
        return await post(ep, tool, args);
      } catch (e: any) {
        if (attempt === 1 || !(e?.stale || e?.cause?.code === 'ECONNREFUSED' || /fetch failed/.test(e?.message))) throw e;
      }
    }
    await startApp();
  }
  throw new Error(`Could not reach ${APP_NAME}.`);
}

function send(msg: unknown) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(req: { id?: number | string; method: string; params?: any }) {
  const { id, method, params } = req;
  if (id === undefined || id === null) return; // notifieringar
  try {
    switch (method) {
      case 'initialize':
        await refreshTools();
        watchTools();
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: 'mr-mail', title: APP_NAME, version: APP_VERSION },
            instructions: AGENT_INSTRUCTIONS
          }
        });
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list':
        await refreshTools();
        return send({ jsonrpc: '2.0', id, result: { tools } });
      case 'tools/call': {
        const name = String(params?.name ?? '');
        if (!knownTool(name)) await refreshTools();
        if (!knownTool(name)) {
          return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } });
        }
        let result: { text?: string; error?: string };
        try {
          result = await callApp(name, params?.arguments ?? {});
        } catch (e: any) {
          result = { error: e?.message ?? String(e) };
        }
        return send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: result.error ?? result.text ?? '' }], isError: !!result.error }
        });
      }
      case 'resources/list':
        return send({ jsonrpc: '2.0', id, result: { resources: [] } });
      case 'prompts/list':
        return send({ jsonrpc: '2.0', id, result: { prompts: [] } });
      default:
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e: any) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: e?.message ?? String(e) } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req: any;
  try {
    req = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } });
  }
  for (const r of Array.isArray(req) ? req : [req]) void handle(r);
});
rl.on('close', () => process.exit(0));
