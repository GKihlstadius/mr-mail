// Startar den paketerade appen och kontrollerar att gränssnittet och förberedda konton laddas.
const SEED = JSON.stringify([
  ['alex.berg@gmail.com', 'gmail', 'Gmail', 'Alex Berg'],
  ['alex@nordljus.se', 'simply', 'Nordljus', 'Alex Berg'],
  ['hej@nordljus.se', 'simply', 'Nordljus hej', 'Nordljus']
]);
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Exe-namnet följer productName i package.json, utan å, ä och ö.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const fileName = pkg.productName.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^A-Za-z0-9-]/g, '');
const exe = resolve(process.argv[2] ?? `release/win-unpacked/${fileName}.exe`);
const data = mkdtempSync(join(tmpdir(), 'mr-mail-smoke-'));
const app = await electron.launch({ executablePath: exe, env: { ...process.env, MRMAIL_DATA: data, MRMAIL_SEED: SEED } });
try {
  const win = await app.firstWindow();
  await win.waitForSelector('.account', { timeout: 20000 });
  const names = await win.locator('.account-name .nav-label').allTextContents();
  const title = await win.title();
  const packaged = await app.evaluate(({ app }) => app.isPackaged);
  console.log(`Paketerad: ${packaged}, titel: ${title}, konton: ${names.join(', ')}`);
  if (names.length !== 3) process.exitCode = 1;
} finally {
  await app.close();
  rmSync(data, { recursive: true, force: true });
}
