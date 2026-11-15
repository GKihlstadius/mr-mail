import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { clientStatus, connectClient, disconnectClient, tomlString, type McpEnv, type ServerSpec } from '../src/main/mcpClients';

const spec: ServerSpec = {
  command: 'C:\\Users\\Alex\\AppData\\Local\\Programs\\mr-mail\\MrMail.exe',
  args: ['C:\\Users\\Alex\\AppData\\Local\\Programs\\mr-mail\\resources\\mr-mail-mcp.cjs'],
  env: { ELECTRON_RUN_AS_NODE: '1' }
};

let root: string;
let env: McpEnv;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mrmail-clients-'));
  env = { home: join(root, 'home'), appData: join(root, 'roaming'), localAppData: join(root, 'local') };
  for (const d of Object.values(env)) mkdirSync(d, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const status = (id: string) => clientStatus(env).find((c) => c.id === id)!;
const json = (file: string) => parse(readFileSync(file, 'utf8'), [], { allowTrailingComma: true });

describe('AI-verktyg', () => {
  it('visar inget som installerat i en tom hemmapp, och installerade först', () => {
    expect(clientStatus(env).every((c) => !c.installed && !c.connected)).toBe(true);
    mkdirSync(join(env.home, '.cursor'));
    const list = clientStatus(env);
    expect(list[0].id).toBe('cursor');
    expect(list[0].installed).toBe(true);
  });

  it('vägrar ansluta ett verktyg som inte är installerat', () => {
    expect(() => connectClient('cursor', env, spec)).toThrow(/not installed/);
  });

  it('Claude Desktop: skapar filen och tar bort posten igen', () => {
    mkdirSync(join(env.appData, 'Claude'));
    connectClient('claude-desktop', env, spec);
    const file = join(env.appData, 'Claude', 'claude_desktop_config.json');
    expect(json(file).mcpServers['mr-mail']).toEqual({ command: spec.command, args: spec.args, env: spec.env });
    expect(status('claude-desktop')).toMatchObject({ installed: true, connected: true, managed: true, path: file });
    disconnectClient('claude-desktop', env);
    expect(json(file).mcpServers['mr-mail']).toBeUndefined();
    expect(status('claude-desktop').connected).toBe(false);
  });

  it('Claude Desktop från Microsoft Store', () => {
    const dir = join(env.localAppData, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
    mkdirSync(dir, { recursive: true });
    expect(status('claude-desktop').installed).toBe(true);
    connectClient('claude-desktop', env, spec);
    expect(json(join(dir, 'claude_desktop_config.json')).mcpServers['mr-mail'].command).toBe(spec.command);
    expect(existsSync(join(env.appData, 'Claude'))).toBe(false);
  });

  it('Claude Code: befintlig "brevlada" räknas som ansluten och rörs aldrig', () => {
    const file = join(env.home, '.claude.json');
    const before = JSON.stringify(
      { numStartups: 5, mcpServers: { brevlada: { type: 'stdio', command: 'node', args: ['C:/x/dist/mcp/mr-mail-mcp.cjs'], env: {} }, other: { command: 'x' } }, projects: { a: { mcpServers: {} } } },
      null,
      2
    );
    writeFileSync(file, before);
    expect(status('claude-code')).toMatchObject({ installed: true, connected: true, managed: false });
    connectClient('claude-code', env, spec);
    expect(readFileSync(file, 'utf8')).toBe(before);
    disconnectClient('claude-code', env);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(existsSync(`${file}.mrmail-backup`)).toBe(false);
  });

  it('Claude Code: lägger till typ stdio och behåller andra servrar, med en kopia', () => {
    const file = join(env.home, '.claude.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }, null, 2));
    connectClient('claude-code', env, spec);
    const v = json(file);
    expect(v.mcpServers['mr-mail']).toEqual({ type: 'stdio', command: spec.command, args: spec.args, env: spec.env });
    expect(v.mcpServers.other).toEqual({ command: 'x' });
    expect(v.theme).toBe('dark');
    expect(JSON.parse(readFileSync(`${file}.mrmail-backup`, 'utf8')).mcpServers['mr-mail']).toBeUndefined();
    connectClient('claude-code', env, spec);
    expect(Object.keys(json(file).mcpServers)).toEqual(['mr-mail', 'other']);
    disconnectClient('claude-code', env);
    expect(readFileSync(file, 'utf8')).toBe(readFileSync(`${file}.mrmail-backup`, 'utf8'));
  });

  it('Claude Code känns igen på mappen ~/.claude', () => {
    mkdirSync(join(env.home, '.claude'));
    expect(status('claude-code').installed).toBe(true);
    connectClient('claude-code', env, spec);
    expect(json(join(env.home, '.claude.json')).mcpServers['mr-mail'].type).toBe('stdio');
  });

  it('VS Code använder servers', () => {
    mkdirSync(join(env.appData, 'Code', 'User'), { recursive: true });
    connectClient('vscode', env, spec);
    const v = json(join(env.appData, 'Code', 'User', 'mcp.json'));
    expect(v.servers['mr-mail']).toEqual({ type: 'stdio', command: spec.command, args: spec.args, env: spec.env });
    expect(status('vscode').connected).toBe(true);
  });

  it.each([
    ['cursor', ['.cursor'], 'mcp.json'],
    ['windsurf', ['.codeium', 'windsurf'], 'mcp_config.json'],
    ['gemini', ['.gemini'], 'settings.json'],
    ['lmstudio', ['.lmstudio'], 'mcp.json']
  ])('%s använder mcpServers', (id, dir, name) => {
    const d = join(env.home, ...dir);
    mkdirSync(d, { recursive: true });
    connectClient(id, env, spec);
    expect(json(join(d, name)).mcpServers['mr-mail'].args).toEqual(spec.args);
    expect(status(id).connected).toBe(true);
    disconnectClient(id, env);
    expect(status(id).connected).toBe(false);
    expect(json(join(d, name)).mcpServers).toEqual({});
  });

  it('tar bort den sista posten och kommatecknet före', () => {
    const dir = join(env.home, '.cursor');
    mkdirSync(dir);
    const file = join(dir, 'mcp.json');
    writeFileSync(file, '{\n  "mcpServers": {\n    "a": { "command": "x" },\n    "mine": { "command": "MrMail.exe", "args": ["mr-mail-mcp.cjs"] }\n  }\n}\n');
    disconnectClient('cursor', env);
    expect(readFileSync(file, 'utf8')).toBe('{\n  "mcpServers": {\n    "a": { "command": "x" }\n  }\n}\n');
  });

  it('Zed: kommentarer och avslutande kommatecken överlever', () => {
    const dir = join(env.appData, 'Zed');
    mkdirSync(dir);
    const file = join(dir, 'settings.json');
    const before = [
      '// Zed settings',
      '{',
      '  // Tema',
      '  "theme": "One Dark",',
      '  "context_servers": {',
      '    "other": { "source": "custom", "command": "x", }, // annan server',
      '  },',
      '  "ui_font_size": 16,',
      '}',
      ''
    ].join('\n');
    writeFileSync(file, before);
    connectClient('zed', env, spec);
    const after = readFileSync(file, 'utf8');
    expect(after).toContain('// Zed settings');
    expect(after).toContain('// Tema');
    expect(after).toContain('// annan server');
    expect(json(file).context_servers['mr-mail']).toEqual({ source: 'custom', command: spec.command, args: spec.args, env: spec.env });
    expect(json(file).ui_font_size).toBe(16);
    expect(readFileSync(`${file}.mrmail-backup`, 'utf8')).toBe(before);
    disconnectClient('zed', env);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('rör inte en fil som inte går att läsa', () => {
    const dir = join(env.home, '.cursor');
    mkdirSync(dir);
    writeFileSync(join(dir, 'mcp.json'), '{ "mcpServers": { oops');
    expect(() => connectClient('cursor', env, spec)).toThrow(/Could not read/);
    expect(readFileSync(join(dir, 'mcp.json'), 'utf8')).toBe('{ "mcpServers": { oops');
  });

  it('Codex: TOML med bakstreck, och bara vår tabell tas bort', () => {
    const dir = join(env.home, '.codex');
    mkdirSync(dir);
    const file = join(dir, 'config.toml');
    const before = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.other.env]\nA = "1"\n';
    writeFileSync(file, before);
    expect(status('codex').connected).toBe(false);
    connectClient('codex', env, spec);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('[mcp_servers.mr-mail]');
    expect(text).toContain('command = "C:\\\\Users\\\\Alex\\\\AppData\\\\Local\\\\Programs\\\\mr-mail\\\\MrMail.exe"');
    expect(text).toContain('env = { ELECTRON_RUN_AS_NODE = "1" }');
    expect(status('codex')).toMatchObject({ connected: true, managed: true });
    connectClient('codex', env, spec);
    expect(readFileSync(file, 'utf8').match(/\[mcp_servers\.mr-mail\]/g)).toHaveLength(1);
    disconnectClient('codex', env);
    expect(readFileSync(file, 'utf8').trimEnd()).toBe(before.trimEnd());
    expect(status('codex').connected).toBe(false);
  });

  it('Codex: skapar filen och tar bort undertabeller', () => {
    mkdirSync(join(env.home, '.codex'));
    const file = join(env.home, '.codex', 'config.toml');
    connectClient('codex', env, spec);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n[mcp_servers.mr-mail.extra]\nx = 1\n\n[tools]\ny = 2\n`);
    disconnectClient('codex', env);
    expect(readFileSync(file, 'utf8').trim()).toBe('[tools]\ny = 2');
  });

  it('TOML-strängar skyddas', () => {
    expect(tomlString('C:\\a "b"')).toBe('"C:\\\\a \\"b\\""');
  });
});

describe('Bygget', () => {
  it('jsonc-parser går att bunta med esbuild som appen gör', async () => {
    const { build } = await import('esbuild');
    const out = await build({ entryPoints: ['src/main/mcpClients.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const code = out.outputFiles[0].text;
    expect(code).not.toContain('./impl/format');
    const mod: any = { exports: {} };
    new Function('module', 'exports', 'require', code)(mod, mod.exports, createRequire(import.meta.url));
    expect(typeof mod.exports.connectClient).toBe('function');
  });
});
