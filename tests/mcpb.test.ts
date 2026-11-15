import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { MCPB_ENTRY, mcpbManifest, unzip, zip } from '../src/main/mcpb';
import { AGENT_TOOLS } from '../src/shared/agentTools';
import pkg from '../package.json';

describe('Tillägget för Claude Desktop', () => {
  it('manifestet följer MCPB 0.2', () => {
    const m = mcpbManifest(pkg);
    expect(m).toMatchObject({
      manifest_version: '0.2',
      name: 'mr-mail',
      display_name: 'Mr Mail',
      version: pkg.version,
      author: { name: 'GKihlstadius' },
      license: 'MIT',
      icon: 'icon.png',
      homepage: pkg.homepage,
      repository: { type: 'git', url: pkg.repository.url },
      server: { type: 'node', entry_point: 'server/mr-mail-mcp.cjs', mcp_config: { command: 'node', args: ['${__dirname}/server/mr-mail-mcp.cjs'] } },
      compatibility: { platforms: ['win32'] }
    });
    expect(m.description.length).toBeGreaterThan(10);
    expect(m.tools).toEqual(AGENT_TOOLS.map((t) => ({ name: t.name, description: t.description })));
    expect(JSON.stringify(m)).not.toMatch(/[–—]/);
  });

  it('zip-arkivet går att läsa tillbaka, med rätt struktur', () => {
    const files = [
      { name: 'manifest.json', data: Buffer.from('{"a":1}') },
      { name: MCPB_ENTRY, data: Buffer.from('console.log("hej");\n'.repeat(200)) },
      { name: 'icon.png', data: Buffer.alloc(0) }
    ];
    const buf = zip(files);
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    expect(buf.readUInt32LE(buf.length - 22)).toBe(0x06054b50);
    expect(buf.readUInt16LE(buf.length - 12)).toBe(3);
    // Första filen packas upp direkt från det lokala huvudet, oberoende av unzip().
    const nameLen = buf.readUInt16LE(26);
    expect(buf.subarray(30, 30 + nameLen).toString()).toBe('manifest.json');
    expect(inflateRawSync(buf.subarray(30 + nameLen, 30 + nameLen + buf.readUInt32LE(18))).toString()).toBe('{"a":1}');
    const back = unzip(buf);
    expect(back.map((e) => e.name)).toEqual(['manifest.json', 'server/mr-mail-mcp.cjs', 'icon.png']);
    expect(back.map((e) => e.data.toString())).toEqual(files.map((f) => f.data.toString()));
    expect(zip(files).equals(buf)).toBe(true);
  });

  it('upptäcker trasiga arkiv', () => {
    const buf = zip([{ name: 'a.txt', data: Buffer.from('abc') }]);
    buf[buf.indexOf('a.txt') + 5] ^= 0xff;
    expect(() => unzip(buf)).toThrow();
    expect(() => unzip(Buffer.from('nej'))).toThrow(/zip/);
  });

  it.skipIf(!existsSync(join(import.meta.dirname, '..', 'dist', 'mcp', 'mr-mail-mcp.cjs')))('bygget skriver en giltig .mcpb', () => {
    const root = join(import.meta.dirname, '..');
    execFileSync(process.execPath, [join(root, 'scripts', 'build-mcpb.mjs')], { cwd: root });
    const file = join(root, 'release', `MrMail-${pkg.version}.mcpb`);
    const entries = unzip(readFileSync(file));
    expect(entries.map((e) => e.name).sort()).toEqual(['icon.png', 'manifest.json', 'server/mr-mail-mcp.cjs']);
    const manifest = JSON.parse(entries.find((e) => e.name === 'manifest.json')!.data.toString());
    expect(manifest.version).toBe(pkg.version);
    expect(entries.find((e) => e.name === 'icon.png')!.data.subarray(1, 4).toString()).toBe('PNG');
    const server = entries.find((e) => e.name === MCPB_ENTRY)!.data.toString();
    expect(server).not.toMatch(/require\(["']electron["']\)/);
  });
});
