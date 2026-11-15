// Kopplar Mr Mail till AI-verktyg med ett klick: lägger in, känner igen och tar bort MCP-servern i
// verktygens egna inställningsfiler. Kommentarer och formatering i filerna behålls (jsonc-parser).
// Alla sökvägar räknas fram från en McpEnv, så att testerna kan köra mot tillfälliga mappar.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// ESM-bygget, eftersom UMD-bygget laddar sina delar dynamiskt och inte går att bunta.
import { applyEdits, findNodeAtLocation, modify, parse, parseTree, type ParseError } from 'jsonc-parser/lib/esm/main.js';

export const SERVER_NAME = 'mr-mail';
export const SCRIPT_NAME = 'mr-mail-mcp.cjs';
// Poster som användaren lagt in för hand och som aldrig tas bort härifrån.
const PROTECTED = new Set(['brevlada']);

export class McpClientError extends Error {
  constructor(
    message: string,
    readonly code: 'not-installed' | 'unreadable' | 'unknown',
    readonly file?: string
  ) {
    super(message);
  }
}

export interface McpEnv {
  home: string;
  appData: string;
  localAppData: string;
}

export interface ServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpClientStatus {
  id: string;
  name: string;
  installed: boolean;
  connected: boolean;
  // Det finns en post som Mr Mail kan ta bort (inte bara en inlagd för hand).
  managed: boolean;
  path: string;
}

type Format = 'json' | 'toml';

interface ClientDef {
  id: string;
  name: string;
  format: Format;
  // Mappar som visar att verktyget är installerat.
  dirs(env: McpEnv): string[];
  // Filerna som ska ändras. Den första används när ingen av dem finns.
  files(env: McpEnv): string[];
  // Var servrarna ligger i JSON-filen.
  key?: string;
  entry?(spec: ServerSpec): Record<string, unknown>;
}

const plain = (spec: ServerSpec) => ({ command: spec.command, args: spec.args, env: spec.env });
const stdio = (spec: ServerSpec) => ({ type: 'stdio', command: spec.command, args: spec.args, env: spec.env });

// Claude Desktop från Microsoft Store lägger sina filer i paketmappen.
function storeClaudeDirs(env: McpEnv): string[] {
  const pk = join(env.localAppData, 'Packages');
  try {
    return readdirSync(pk)
      .filter((n) => /^Claude_/i.test(n))
      .map((n) => join(pk, n, 'LocalCache', 'Roaming', 'Claude'))
      .filter(isDir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const CLIENTS: ClientDef[] = [
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    format: 'json',
    key: 'mcpServers',
    dirs: (e) => [join(e.appData, 'Claude'), ...storeClaudeDirs(e)],
    files: (e) => [join(e.appData, 'Claude'), ...storeClaudeDirs(e)].filter((d, i) => i === 0 || isDir(d)).map((d) => join(d, 'claude_desktop_config.json')),
    entry: plain
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    format: 'json',
    key: 'mcpServers',
    dirs: (e) => [join(e.home, '.claude.json'), join(e.home, '.claude')],
    files: (e) => [join(e.home, '.claude.json')],
    entry: stdio
  },
  {
    id: 'cursor',
    name: 'Cursor',
    format: 'json',
    key: 'mcpServers',
    dirs: (e) => [join(e.home, '.cursor')],
    files: (e) => [join(e.home, '.cursor', 'mcp.json')],
    entry: plain
  },
  {
    id: 'vscode',
    name: 'VS Code (Copilot)',
    format: 'json',
    key: 'servers',
    dirs: (e) => [join(e.appData, 'Code', 'User')],
    files: (e) => [join(e.appData, 'Code', 'User', 'mcp.json')],
    entry: stdio
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    format: 'json',
    key: 'mcpServers',
    dirs: (e) => [join(e.home, '.codeium', 'windsurf')],
    files: (e) => [join(e.home, '.codeium', 'windsurf', 'mcp_config.json')],
    entry: plain
  },
  {
    id: 'zed',
    name: 'Zed',
    format: 'json',
    key: 'context_servers',
    dirs: (e) => [join(e.appData, 'Zed')],
    files: (e) => [join(e.appData, 'Zed', 'settings.json')],
    entry: (spec) => ({ source: 'custom', command: spec.command, args: spec.args, env: spec.env })
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    format: 'json',
    key: 'mcpServers',
    dirs: (e) => [join(e.home, '.gemini')],
    files: (e) => [join(e.home, '.gemini', 'settings.json')],
    entry: plain
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    format: 'json',
    key: 'mcpServers',
    dirs: (e) => [join(e.home, '.lmstudio')],
    files: (e) => [join(e.home, '.lmstudio', 'mcp.json')],
    entry: plain
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    format: 'toml',
    dirs: (e) => [join(e.home, '.codex')],
    files: (e) => [join(e.home, '.codex', 'config.toml')]
  }
];

export function envFromProcess(): McpEnv {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return {
    home,
    appData: process.env.APPDATA || join(home, 'AppData', 'Roaming'),
    localAppData: process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
  };
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const pointsAtUs = (v: unknown) => JSON.stringify(v ?? '').includes(SCRIPT_NAME);

// JSONC med kommentarer och avslutande kommatecken. Annat fel gör att filen inte rörs.
function parseJson(text: string, file: string): any {
  if (!text.trim()) return {};
  const errors: ParseError[] = [];
  const v = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || (v !== undefined && (typeof v !== 'object' || Array.isArray(v)))) throw new McpClientError(`Could not read ${file}, it is left unchanged.`, 'unreadable', file);
  return v ?? {};
}

function jsonServers(def: ClientDef, text: string | null, file: string): Record<string, unknown> {
  if (text === null) return {};
  const v = parseJson(text, file)[def.key!];
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// TOML: tabellerna [mcp_servers.namn] och deras undertabeller.
interface TomlSection {
  start: number;
  end: number;
  server: string | null;
  text: string;
}

function tomlSections(text: string): TomlSection[] {
  const lines = text.split(/(?<=\n)/);
  const out: TomlSection[] = [];
  let pos = 0;
  let cur: TomlSection = { start: 0, end: 0, server: null, text: '' };
  for (const line of lines) {
    const h = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line.replace(/\r?\n$/, ''));
    if (h) {
      cur.end = pos;
      out.push(cur);
      const m = /^mcp_servers\.("([^"]+)"|'([^']+)'|[A-Za-z0-9_-]+)/.exec(h[1]);
      const server = m ? (m[2] ?? m[3] ?? m[1]) : null;
      cur = { start: pos, end: 0, server, text: '' };
    }
    cur.text += line;
    pos += line.length;
  }
  cur.end = pos;
  out.push(cur);
  return out;
}

function tomlServers(text: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (text === null) return out;
  for (const s of tomlSections(text)) if (s.server) out[s.server] = (out[s.server] ?? '') + s.text;
  return out;
}

// Sträng i TOML: bakstreck och citattecken skyddas.
export function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

function tomlEntry(spec: ServerSpec): string {
  const env = Object.entries(spec.env);
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(spec.command)}`,
    `args = [${spec.args.map(tomlString).join(', ')}]`,
    ...(env.length ? [`env = { ${env.map(([k, v]) => `${k} = ${tomlString(v)}`).join(', ')} }`] : []),
    ''
  ].join('\n');
}

// Posterna i en fil: namn och om de pekar på Mr Mail.
function entries(def: ClientDef, file: string): { name: string; ours: boolean }[] {
  const text = readText(file);
  if (def.format === 'toml') return Object.entries(tomlServers(text)).map(([name, body]) => ({ name, ours: body.includes(SCRIPT_NAME) }));
  return Object.entries(jsonServers(def, text, file)).map(([name, v]) => ({ name, ours: pointsAtUs(v) }));
}

function existing(def: ClientDef, env: McpEnv): string[] {
  return def.files(env).filter((f) => existsSync(f));
}

function clientDef(id: string): ClientDef {
  const def = CLIENTS.find((c) => c.id === id);
  if (!def) throw new McpClientError(`Unknown client: ${id}`, 'unknown');
  return def;
}

export function clientStatus(env: McpEnv): McpClientStatus[] {
  return CLIENTS.map((def) => {
    const installed = def.dirs(env).some((d) => existsSync(d));
    const files = existing(def, env);
    let connected = false;
    let managed = false;
    for (const f of files) {
      try {
        for (const e of entries(def, f)) {
          if (e.name === SERVER_NAME || e.ours) connected = true;
          if (e.ours && !PROTECTED.has(e.name)) managed = true;
        }
      } catch {
        /* trasig fil räknas som ej ansluten */
      }
    }
    return { id: def.id, name: def.name, installed, connected, managed, path: files[0] ?? def.files(env)[0] };
  }).sort((a, b) => Number(b.installed) - Number(a.installed));
}

// Skriver via en tillfällig fil, så att en halvskriven fil aldrig blir kvar. Första gången sparas en kopia.
function writeSafely(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const backup = `${file}.mrmail-backup`;
  if (existsSync(file) && !existsSync(backup)) copyFileSync(file, backup);
  const tmp = `${file}.mrmail-tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

// Indrag som filen redan använder: tabb eller antal mellanslag.
function indentOf(text: string): { insertSpaces: boolean; tabSize: number } {
  const m = /\n([ \t]+)\S/.exec(text);
  if (m?.[1].startsWith('\t')) return { insertSpaces: false, tabSize: 1 };
  return { insertSpaces: true, tabSize: m ? Math.min(8, m[1].length) : 2 };
}

function eol(text: string) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

// Ny post läggs först i objektet, så att resten av filen står kvar som den var.
function jsonInsert(text: string, path: string[], value: unknown): string {
  const fmt = indentOf(text);
  return applyEdits(text, modify(text, path, value, { getInsertionIndex: () => 0, formattingOptions: { ...fmt, eol: eol(text) } }));
}

// Tar bort en egenskap utan att formatera om grannarna: raden, och kommatecknet efter eller före.
function jsonRemove(text: string, path: string[]): string {
  const tree = parseTree(text, [], { allowTrailingComma: true });
  const prop = tree ? findNodeAtLocation(tree, path)?.parent : undefined;
  if (!prop || prop.type !== 'property' || !prop.parent?.children) return text;
  const siblings = prop.parent.children;
  const idx = siblings.indexOf(prop);
  let start = prop.offset;
  let end = prop.offset + prop.length;
  const comma = /^[ \t]*,/.exec(text.slice(end));
  if (comma) end += comma[0].length;
  else if (idx > 0) {
    const prev = siblings[idx - 1];
    const c = text.slice(prev.offset + prev.length, start).indexOf(',');
    if (c >= 0) start = prev.offset + prev.length + c;
  }
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const rest = /^[ \t]*\r?\n/.exec(text.slice(end));
  if (/^[ \t]*$/.test(text.slice(lineStart, start)) && rest) {
    start = lineStart;
    end += rest[0].length;
  }
  return text.slice(0, start) + text.slice(end);
}

export function connectClient(id: string, env: McpEnv, spec: ServerSpec): void {
  const def = clientDef(id);
  if (!def.dirs(env).some((d) => existsSync(d))) throw new McpClientError(`${def.name} is not installed.`, 'not-installed');
  const files = existing(def, env);
  const all = def.files(env);
  const targets = files.length ? files : [all.find((f) => isDir(dirname(f))) ?? all[0]];
  for (const file of targets) {
    const text = readText(file) ?? '';
    // Redan ansluten, med egen post eller en inlagd för hand: inget dubbleras.
    if (entries(def, file).some((e) => e.name === SERVER_NAME || e.ours)) continue;
    if (def.format === 'toml') {
      const sep = text && !text.endsWith('\n') ? '\n\n' : text ? '\n' : '';
      writeSafely(file, `${text}${sep}${tomlEntry(spec).replace(/\n/g, eol(text || '\n'))}`);
    } else {
      parseJson(text, file);
      const base = text.trim() ? text : '{}\n';
      writeSafely(file, jsonInsert(base, [def.key!, SERVER_NAME], def.entry!(spec)));
    }
  }
}

export function disconnectClient(id: string, env: McpEnv): void {
  const def = clientDef(id);
  for (const file of existing(def, env)) {
    const remove = entries(def, file)
      .filter((e) => e.ours && !PROTECTED.has(e.name))
      .map((e) => e.name);
    if (!remove.length) continue;
    let text = readText(file) ?? '';
    if (def.format === 'toml') {
      const drop = new Set(remove);
      text = tomlSections(text)
        .filter((s) => !(s.server && drop.has(s.server)))
        .map((s) => s.text)
        .join('')
        .replace(/\n{3,}/g, '\n\n');
    } else {
      for (const name of remove) text = jsonRemove(text, [def.key!, name]);
    }
    writeSafely(file, text);
  }
}
