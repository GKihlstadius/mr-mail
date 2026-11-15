// Bygger tillägget för Claude Desktop: release/MrMail-<version>.mcpb med manifest.json,
// server/mr-mail-mcp.cjs och icon.png. Kräver `pnpm build` först (dist/mcp).
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const server = join(root, 'dist', 'mcp', 'mr-mail-mcp.cjs');
if (!existsSync(server)) {
  console.error('dist/mcp/mr-mail-mcp.cjs saknas. Kör pnpm build först.');
  process.exit(1);
}

const out = await build({ entryPoints: [join(root, 'src/main/mcpb.ts')], bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent' });
const mod = { exports: {} };
new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, createRequire(import.meta.url));
const { mcpbManifest, zip, unzip, MCPB_ENTRY } = mod.exports;

const manifest = mcpbManifest(pkg);
const fileName = pkg.productName.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^A-Za-z0-9-]/g, '');
const target = join(root, 'release', `${fileName}-${pkg.version}.mcpb`);
const data = zip([
  { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
  { name: MCPB_ENTRY, data: readFileSync(server) },
  { name: 'icon.png', data: readFileSync(join(root, 'build', 'icon.png')) }
]);
unzip(data);
mkdirSync(join(root, 'release'), { recursive: true });
writeFileSync(target, data);
console.log(`Skrev ${target} (${Math.round(data.length / 1024)} kB, ${manifest.tools.length} verktyg)`);
