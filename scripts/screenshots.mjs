// Engelska skärmbilder till README, med påhittade mejl mot GreenMail i Docker.
// Kör först `pnpm build`, starta GreenMail (se README) och sedan: node scripts/screenshots.mjs
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import nodemailer from 'nodemailer';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const root = resolve(import.meta.dirname, '..');
const out = join(root, 'docs', 'screenshots');
mkdirSync(out, { recursive: true });
const HOST = '127.0.0.1';
const run = Date.now().toString(36);
const me = `alex.${run}@nordlight.test`;

const smtp = nodemailer.createTransport({ host: HOST, port: 3025, secure: false, ignoreTLS: true });
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000);

const mails = [
  {
    from: 'Karin Lund <karin@brightside.test>',
    subject: 'Demo next week?',
    date: hoursAgo(0.3),
    text: 'Hi Alex,\n\nWe met briefly at the conference in Gothenburg. Our team of twelve keeps losing decisions made in meetings, and Nordlight sounded like exactly what we need.\n\nCould you give us a demo next week? Tuesday or Thursday afternoon works best.\n\nBest regards,\nKarin Lund\nHead of Operations, Brightside'
  },
  {
    from: 'GitHub <notifications@github.test>',
    subject: '[nordlight/app] CI passed on main',
    date: hoursAgo(1),
    text: 'All checks have passed on main.\n\nView the workflow run on GitHub.',
    headers: { 'List-Id': 'nordlight/app <app.nordlight.github.test>', Precedence: 'bulk' }
  },
  {
    from: 'Sam Patel <sam@nordlight.test>',
    subject: 'Slides for Friday',
    date: hoursAgo(2),
    text: 'Hey Alex,\n\nI put the slides for Friday in the shared folder. Could you take a look at the pricing page before lunch tomorrow?\n\nThanks!\nSam',
    attachments: [{ filename: 'Q4 pricing.pdf', content: Buffer.from('%PDF-1.4\n% demo\n') }]
  },
  {
    from: 'The Weekly Byte <news@weeklybyte.test>',
    subject: 'This week: local AI models get fast',
    date: hoursAgo(5),
    html: '<h2>The Weekly Byte</h2><p>Local models are now fast enough for everyday email. Here is what changed this week.</p>',
    headers: { 'List-Unsubscribe': '<mailto:unsubscribe@weeklybyte.test>', 'List-Id': 'weekly <weekly.weeklybyte.test>' }
  },
  {
    from: 'Linnea Berg <linnea@family.test>',
    subject: 'Dinner on Sunday',
    date: hoursAgo(8),
    text: 'Hi!\n\nAre you coming for dinner on Sunday? Dad is making lasagna. Bring Sam if he is free.\n\nHugs,\nLinnea'
  },
  {
    from: 'Cloud Hosting <billing@cloudhost.test>',
    subject: 'Your receipt for November',
    date: hoursAgo(20),
    text: 'Thanks for your payment. Amount: $12.00. Card ending in 4242.',
    headers: { 'Auto-Submitted': 'auto-generated' }
  },
  {
    from: 'Shopify Deals <deals@shopdeals.test>',
    subject: 'Black Week starts now: 40% off',
    date: hoursAgo(26),
    html: '<h1>Black Week</h1><p>Everything 40% off, only this week.</p>',
    headers: { 'List-Unsubscribe': '<mailto:stop@shopdeals.test>', 'List-Id': 'deals <deals.shopdeals.test>', Precedence: 'bulk' }
  },
  {
    from: 'Jonas Ek <jonas@brightside.test>',
    subject: 'Re: Contract draft',
    date: hoursAgo(30),
    text: 'Hi Alex,\n\nLooks good to me. One small change in section 4, then we can sign.\n\nJonas'
  }
];

for (const m of mails) await smtp.sendMail({ ...m, to: `Alex Berg <${me}>` });
smtp.close();

const data = mkdtempSync(join(tmpdir(), 'mr-mail-shots-'));
const app = await electron.launch({ executablePath: electronPath, args: [root], cwd: root, env: { ...process.env, MRMAIL_DATA: data } });
const shot = async (page, name) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, name) });
  console.log(`docs/screenshots/${name}`);
};
try {
  let win = await app.firstWindow();
  await win.waitForSelector('.sidebar');
  await win.evaluate(() => window.api.saveSettings({ language: 'en', smartInbox: true, undoSendSeconds: 0 }));
  await win.waitForTimeout(1500);
  win = app.windows()[0];
  await win.waitForSelector('.sidebar');
  await win.setViewportSize({ width: 1280, height: 800 });
  await win.evaluate(
    (email) =>
      window.api.saveAccount({
        config: {
          id: 'work',
          name: 'Work',
          email,
          displayName: 'Alex Berg',
          provider: 'manual',
          imap: { host: '127.0.0.1', port: 3143, security: 'none' },
          smtp: { host: '127.0.0.1', port: 3025, security: 'none' },
          username: email,
          color: '#4f7cff'
        },
        password: 'demo'
      }),
    me
  );
  await win.waitForSelector('.row:has-text("Demo next week?")', { timeout: 30000 });
  await win.click('.inbox-tab[data-tab="all"]').catch(() => undefined);
  await win.click('.row:has-text("Demo next week?")');
  await win.waitForSelector('.text-body');
  await shot(win, 'inbox.png');

  await win.click('.inbox-tab[data-tab="personal"]').catch(() => undefined);
  await win.click('.row:has-text("Slides for Friday")');
  await win.waitForSelector('.attachment');
  await shot(win, 'smart-inbox.png');

  await app.evaluate(({ nativeTheme }) => (nativeTheme.themeSource = 'dark'));
  await win.emulateMedia({ colorScheme: 'dark' });
  await win.click('.inbox-tab[data-tab="all"]').catch(() => undefined);
  await win.click('.row:has-text("Demo next week?")');
  await shot(win, 'dark.png');
  await app.evaluate(({ nativeTheme }) => (nativeTheme.themeSource = 'light'));
  await win.emulateMedia({ colorScheme: 'light' });

  await win.click('.nav-item:has-text("Clean Up")');
  await win.waitForTimeout(2500);
  await shot(win, 'clean-up.png');
} finally {
  await app.close();
  rmSync(data, { recursive: true, force: true });
}
