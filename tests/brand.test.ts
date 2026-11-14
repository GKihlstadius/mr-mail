import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { APP_FILE_NAME, APP_NAME, APP_VERSION, asciiName } from '../src/shared/brand';

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('appnamnet på ett ställe', () => {
  it('kommer från productName i package.json', () => {
    expect(APP_NAME).toBe(pkg.productName);
    expect(APP_VERSION).toBe(pkg.version);
    expect(asciiName('Brevlåda')).toBe('Brevlada');
    expect(asciiName('Mejl Över Allt')).toBe('MejlOverAllt');
    expect(APP_FILE_NAME).toBe(asciiName(pkg.productName));
  });

  it('paketeringen räknar fram exe, genvägar och installationsfil ur samma namn', () => {
    const cfg = require(join(root, 'electron-builder.config.cjs'));
    expect(cfg.productName).toBe(pkg.productName);
    expect(cfg.executableName).toBe(APP_FILE_NAME);
    expect(cfg.nsis.shortcutName).toBe(pkg.productName);
    expect(cfg.win.artifactName.startsWith(`${APP_FILE_NAME}-Setup-`)).toBe(true);
    expect(pkg.build).toBeUndefined();
  });

  it('inget visat namn är hårdkodat i koden', () => {
    const hits = files(join(root, 'src'))
      .filter((f) => /\.(ts|tsx|html)$/.test(f) && !f.endsWith('brand.ts'))
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .filter((l) => l.includes(APP_NAME) && !l.trim().startsWith('//'))
          .map((l) => `${f}: ${l.trim()}`)
      );
    expect(hits).toEqual([]);
  });
});
