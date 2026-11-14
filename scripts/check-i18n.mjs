// Kontrollerar översättningarna: varje t('...') i koden ska ha en engelsk text, samma svenska
// nyckel ska ha samma engelska text i alla ordlistor, och inga tankestreck får finnas.
import { build } from 'esbuild';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const out = await build({ entryPoints: ['src/shared/i18n/en.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent' });
const mod = { exports: {} };
new Function('module', 'exports', out.outputFiles[0].text)(mod, mod.exports);
const EN = mod.exports.EN;

const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(f)) files.push(p);
  }
};
walk('src');

// Krockar: samma nyckel med olika engelska i olika filer.
const seen = new Map();
const conflicts = [];
for (const f of files.filter((p) => p.includes(join('i18n', 'en')))) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/^\s*(['"])((?:\\.|(?!\1).)*)\1\s*:\s*(['"`])((?:\\.|(?!\3).)*)\3/gm)) {
    const prev = seen.get(m[2]);
    if (prev && prev.v !== m[4]) conflicts.push(`${m[2]}: "${prev.v}" (${prev.f}) / "${m[4]}" (${f})`);
    seen.set(m[2], { v: m[4], f });
  }
}

const missing = [];
const unescape = (s) => s.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c);
for (const f of files.filter((p) => !p.includes('i18n'))) {
  const src = readFileSync(f, 'utf8');
  const keys = [];
  for (const m of src.matchAll(/\bt\(\s*'((?:\\.|[^'\\])*)'/g)) keys.push(m[1]);
  for (const m of src.matchAll(/\btn\([^,()]+,\s*'((?:\\.|[^'\\])*)'\s*,\s*'((?:\\.|[^'\\])*)'/g)) keys.push(m[1], m[2]);
  for (const k of keys) {
    const key = unescape(k);
    if (/[a-zåäö]/i.test(key) && !(key in EN)) missing.push(`${f}: ${key}`);
  }
}

const dashes = files.filter((f) => /[\u2013\u2014]/.test(readFileSync(f, 'utf8')));

console.log(`Engelska nycklar: ${Object.keys(EN).length}`);
if (conflicts.length) console.log(`Krockar (${conflicts.length}):\n  ${conflicts.join('\n  ')}`);
if (missing.length) console.log(`Saknar engelska (${missing.length}):\n  ${[...new Set(missing)].join('\n  ')}`);
if (dashes.length) console.log(`Tankestreck i: ${dashes.join(', ')}`);
if (conflicts.length || missing.length || dashes.length) process.exit(1);
console.log('Allt är översatt.');
