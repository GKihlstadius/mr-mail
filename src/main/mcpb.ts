// Tillägget för Claude Desktop (.mcpb): manifest enligt MCPB-specen och en liten zip-skrivare.
// Används av scripts/build-mcpb.mjs och av testerna.
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { AGENT_TOOLS, type AgentTool } from '../shared/agentTools';
import { APP_NAME } from '../shared/brand';

export const MCPB_ENTRY = 'server/mr-mail-mcp.cjs';

export interface PackageInfo {
  version: string;
  description?: string;
  homepage?: string;
  repository?: { type?: string; url?: string } | string;
}

export function mcpbManifest(pkg: PackageInfo, tools: AgentTool[] = AGENT_TOOLS) {
  const repo = typeof pkg.repository === 'string' ? { type: 'git', url: pkg.repository } : { type: pkg.repository?.type ?? 'git', url: pkg.repository?.url ?? '' };
  return {
    manifest_version: '0.2',
    name: 'mr-mail',
    display_name: APP_NAME,
    version: pkg.version,
    description: pkg.description || `Read, sort and answer your email in ${APP_NAME}.`,
    long_description:
      `${APP_NAME} is a fast, private email client for Windows. This extension lets Claude read, search, sort and draft email in ${APP_NAME}. Nothing is sent unless you ask for it, and ${APP_NAME} can ask before sending or deleting. ${APP_NAME} must be installed; it is started hidden in the tray if it is not running.`,
    author: { name: 'GKihlstadius' },
    repository: repo,
    homepage: pkg.homepage ?? '',
    license: 'MIT',
    icon: 'icon.png',
    server: {
      type: 'node',
      entry_point: MCPB_ENTRY,
      mcp_config: { command: 'node', args: [`\${__dirname}/${MCPB_ENTRY}`] }
    },
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
    compatibility: { platforms: ['win32'] }
  };
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

// Fast tid i arkivet, så att samma innehåll ger samma fil: 2026-01-01 00:00.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
    const packed = deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// Läser ett arkiv via katalogen i slutet och kontrollerar CRC. För tester och kontroll efter bygget.
export function unzip(buf: Buffer): ZipEntry[] {
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('Not a zip file.');
  const count = buf.readUInt16LE(endAt + 10);
  let p = buf.readUInt32LE(endAt + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Broken central directory.');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('Broken local header.');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if ((crc32(data) >>> 0) !== crc) throw new Error(`Wrong checksum: ${name}`);
    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
