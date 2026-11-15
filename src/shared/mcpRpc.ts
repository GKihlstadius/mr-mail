// JSON-RPC för MCP, gemensam för stdio-servern och HTTP-servern i appen. Transporten skickar in
// ett anrop och får tillbaka svaret, eller null för notifieringar.
import { AGENT_INSTRUCTIONS, type AgentArgs } from './agentTools';
import { APP_NAME, APP_VERSION } from './brand';

export const PROTOCOL_VERSION = '2025-06-18';

export interface McpSession {
  // Namnet på AI-verktyget, från clientInfo i initialize.
  client?: string;
}

export interface McpRpcDeps {
  listTools(): Promise<unknown[]> | unknown[];
  hasTool(name: string): Promise<boolean> | boolean;
  call(name: string, args: AgentArgs, session: McpSession): Promise<{ text?: string; error?: string }>;
  onInitialize?(): Promise<void> | void;
  listChanged?: boolean;
}

export interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: any;
}

export type RpcResponse = { jsonrpc: '2.0'; id: number | string | null; result?: unknown; error?: { code: number; message: string } };

// Kända verktyg får ett läsbart namn i frågor och i aktivitetslistan.
const CLIENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-ai': 'Claude Desktop',
  'claude desktop': 'Claude Desktop',
  'cursor-vscode': 'Cursor',
  cursor: 'Cursor',
  'visual studio code': 'VS Code',
  'visual studio code - insiders': 'VS Code',
  zed: 'Zed',
  windsurf: 'Windsurf',
  'gemini-cli-mcp-client': 'Gemini CLI',
  'codex-mcp-client': 'Codex CLI',
  'lm studio': 'LM Studio',
  opencode: 'opencode'
};

export function clientName(info: unknown): string | undefined {
  if (!info || typeof info !== 'object') return undefined;
  const i = info as { name?: unknown; title?: unknown };
  const raw = typeof i.title === 'string' && i.title.trim() ? i.title : typeof i.name === 'string' ? i.name : '';
  const name = raw.trim().slice(0, 60);
  if (!name) return undefined;
  return CLIENT_NAMES[name.toLowerCase()] ?? name;
}

const ok = (id: RpcResponse['id'], result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result });
const fail = (id: RpcResponse['id'], code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

export async function handleMcp(req: RpcRequest, deps: McpRpcDeps, session: McpSession): Promise<RpcResponse | null> {
  if (!req || typeof req !== 'object' || typeof req.method !== 'string') {
    // Svar från klienten (utan method) eller trasiga anrop. Svar besvaras inte.
    if (req && typeof req === 'object' && req.id !== undefined && ('result' in req || 'error' in req)) return null;
    return fail(req && typeof req === 'object' && req.id !== undefined ? (req.id ?? null) : null, -32600, 'Invalid request.');
  }
  const { id, method, params } = req;
  if (id === undefined || id === null) return null; // notifieringar
  try {
    switch (method) {
      case 'initialize': {
        const name = clientName(params?.clientInfo);
        if (name) session.client = name;
        await deps.onInitialize?.();
        return ok(id, {
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: !!deps.listChanged } },
          serverInfo: { name: 'mr-mail', title: APP_NAME, version: APP_VERSION },
          instructions: AGENT_INSTRUCTIONS
        });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: await deps.listTools() });
      case 'tools/call': {
        const name = String(params?.name ?? '');
        if (!(await deps.hasTool(name))) return fail(id, -32602, `Unknown tool: ${name}`);
        const args = params?.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
        let result: { text?: string; error?: string };
        try {
          result = await deps.call(name, args, session);
        } catch (e: any) {
          result = { error: e?.message ?? String(e) };
        }
        return ok(id, { content: [{ type: 'text', text: result.error ?? result.text ?? '' }], isError: !!result.error });
      }
      case 'resources/list':
        return ok(id, { resources: [] });
      case 'prompts/list':
        return ok(id, { prompts: [] });
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (e: any) {
    return fail(id, -32603, e?.message ?? String(e));
  }
}
