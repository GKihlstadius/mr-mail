// Startar den byggda appen med Playwright, kör igenom flödet mot GreenMail och tar skärmbilder till docs/.
// Kräver GreenMail i Docker (imap 3143, smtp 3025, auth.disabled). Kör `pnpm build` först.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const root = resolve(import.meta.dirname, '..');
const docs = join(root, 'docs');
mkdirSync(docs, { recursive: true });

const HOST = '127.0.0.1';
const run = Date.now().toString(36);
const nordljus = `alex.${run}@nordljus.test`;
const gmail = `alex.${run}@gmail.test`;
const karin = `karin.${run}@exempelbolaget.test`;
const skipAi = process.argv.includes('--skip-ai');

const smtp = nodemailer.createTransport({ host: HOST, port: 3025, secure: false, ignoreTLS: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'OK  ' : 'FEL '} ${name}${extra ? `  (${extra})` : ''}`);
  if (!ok) process.exitCode = 1;
};

const day = 86400000;
const now = Date.now();
const at = (daysAgo, h, m) => {
  const d = new Date(now - daysAgo * day);
  d.setHours(h, m, 0, 0);
  return d;
};

async function seed() {
  const mails = [
    {
      from: `Karin Lund <${karin}>`,
      to: nordljus,
      subject: 'Demo av Nordljus nästa vecka?',
      date: at(0, 9, 12),
      text:
        'Hej Alex,\n\nVi pratade kort på mässan i Göteborg. Vi är ett team på tolv personer som tappar bort beslut från möten hela tiden, och Nordljus lät som precis det vi behöver.\n\nSkulle du kunna visa Nordljus för oss nästa vecka? Tisdag eller torsdag eftermiddag passar bäst.\n\nVänliga hälsningar,\nKarin Lund\nVerksamhetschef, Exempelbolaget AB'
    },
    {
      from: 'Johan Ek <johan@byggfirman.test>',
      to: nordljus,
      subject: 'Faktura för oktober',
      date: at(0, 7, 45),
      text: 'Hej!\n\nHär kommer fakturan för oktober. Betalningsvillkor 30 dagar som vanligt.\n\nHälsningar,\nJohan Ek\nByggfirman',
      attachments: [{ filename: 'Faktura-2026-1043.pdf', content: Buffer.from('%PDF-1.4\n%demo\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n') }]
    },
    {
      from: 'Simply.com <noreply@simply.test>',
      to: nordljus,
      subject: 'Din domän nordljus.se förnyas snart',
      date: at(1, 14, 3),
      html:
        '<html><head><style>.card{font-family:Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e5e5e5;border-radius:8px;padding:24px}.btn{display:inline-block;background:#1aa37a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none}</style></head>' +
        '<body><div class="card"><img src="https://www.simply.com/logo.png" width="120" alt="Simply.com"><h2>Din domän förnyas om 14 dagar</h2>' +
        '<p>Domänen <b>nordljus.se</b> förnyas automatiskt den 25 november. Kortet som slutar på 4242 debiteras 149 kr.</p>' +
        '<p><a class="btn" href="https://www.simply.com/se/controlpanel/">Gå till kontrollpanelen</a></p>' +
        '<img src="https://track.simply.test/open.gif" width="1" height="1"></div></body></html>'
    },
    {
      from: 'Lisa Berg <lisa@studio.test>',
      to: nordljus,
      subject: 'Re: Workshop i december',
      date: at(2, 16, 30),
      text: 'Toppen, då bokar vi den 4 december klockan 13. Jag tar med post-it och kaffe.\n\n/Lisa\n\nDen 9 nov. 2026 skrev Alex:\n> Passar första veckan i december?'
    },
    {
      from: 'Erik Holm <erik@nordljus.test>',
      to: nordljus,
      subject: 'Anteckningar från fredagens möte',
      date: at(4, 11, 0),
      text: 'Hej!\n\nKort sammanfattning: vi kör betan med fem kunder i december, Lisa tar onboarding och jag fixar exporten till PDF.\n\nErik'
    },
    {
      from: 'Mamma <mamma@familj.test>',
      to: gmail,
      subject: 'Middag på söndag?',
      date: at(0, 8, 20),
      text: 'Hej gubben! Kommer du på middag på söndag? Pappa gör sin lasagne. Kram'
    },
    {
      from: 'SJ <bokning@sj.test>',
      to: gmail,
      subject: 'Din bokning är bekräftad: Stockholm till Göteborg',
      date: at(1, 19, 41),
      html: '<div style="font-family:Arial"><h3>Tack för din bokning!</h3><p>Fredag 20 november, avgång 07.21 från Stockholm C, ankomst 10.25 Göteborg C. Vagn 4, plats 38.</p></div>'
    },
    {
      from: 'GitHub <notifications@github.test>',
      to: gmail,
      subject: '[app] CI gick igenom på main',
      date: at(3, 22, 5),
      text: 'Alla kontroller gick igenom för commit 3f2a91c på main.\n\nhttps://github.com/'
    }
  ];
  for (const m of mails) await smtp.sendMail(m);
}

// Skapar egna mappar med undermappar och lägger ett oläst mejl i en av dem, före appstart.
async function seedCustom(user) {
  const c = new ImapFlow({ host: HOST, port: 3143, secure: false, auth: { user, pass: 'x' }, logger: false });
  await c.connect();
  await c.mailboxCreate('Kunder');
  await c.mailboxCreate(['Kunder', 'Stockholm']);
  await c.mailboxCreate(['Kunder', 'Övrigt']);
  const raw = Buffer.from(
    [
      'From: Anna Kund <anna@kund.test>',
      `To: ${user}`,
      `Subject: =?UTF-8?B?${Buffer.from('Kundmöte Stockholm').toString('base64')}?=`,
      'Date: ' + new Date().toUTCString(),
      `Message-ID: <kund-${Date.now().toString(36)}@kund.test>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('Vi ses i Stockholm på torsdag.').toString('base64')
    ].join('\r\n')
  );
  await c.append(['Kunder', 'Stockholm'], raw, []);
  await c.logout();
}

async function imapFetchLatest(user, folder, subject, timeout = 15000) {
  const c = new ImapFlow({ host: HOST, port: 3143, secure: false, auth: { user, pass: 'x' }, logger: false });
  await c.connect();
  const start = Date.now();
  try {
    while (Date.now() - start < timeout) {
      const list = await c.list();
      const box = list.find((b) => b.path === folder || b.name === folder);
      if (box) {
        const lock = await c.getMailboxLock(box.path);
        try {
          for await (const m of c.fetch('1:*', { envelope: true, source: true })) {
            if (m.envelope?.subject?.includes(subject)) return m.source.toString();
          }
        } catch {
          /* tom mapp */
        } finally {
          lock.release();
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return null;
  } finally {
    await c.logout();
  }
}

async function imapCount(user, folder, subject) {
  const c = new ImapFlow({ host: HOST, port: 3143, secure: false, auth: { user, pass: 'x' }, logger: false });
  await c.connect();
  try {
    const box = (await c.list()).find((b) => b.path === folder || b.name === folder);
    if (!box) return 0;
    const lock = await c.getMailboxLock(box.path);
    try {
      let n = 0;
      for await (const m of c.fetch('1:*', { envelope: true })) if (m.envelope?.subject?.includes(subject)) n++;
      return n;
    } catch {
      return 0;
    } finally {
      lock.release();
    }
  } finally {
    await c.logout();
  }
}

async function waitUntil(fn, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

async function launch(dataDir, extraEnv = {}) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [root],
    cwd: root,
    env: { ...process.env, MRMAIL_DATA: dataDir, ...extraEnv }
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('.sidebar');
  return { app, win };
}

// Låtsad version av Mozillas databas: varje domän utom okand.test pekar på GreenMail.
const ispdb = createServer((req, res) => {
  if (req.url.includes('okand.test')) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': 'text/xml' }).end(
    `<clientConfig version="1.1"><emailProvider id="test"><incomingServer type="imap"><hostname>${HOST}</hostname><port>3143</port><socketType>plain</socketType><username>%EMAILADDRESS%</username></incomingServer><outgoingServer type="smtp"><hostname>${HOST}</hostname><port>3025</port><socketType>plain</socketType><username>%EMAILADDRESS%</username></outgoingServer></emailProvider></clientConfig>`
  );
});
await new Promise((r) => ispdb.listen(0, '127.0.0.1', r));
const discoveryEnv = { MRMAIL_ISPDB: `http://127.0.0.1:${ispdb.address().port}/`, MRMAIL_NO_DNS: '1' };

// Låtsad Google-inloggning: godkänner direkt och skickar tillbaka till Brevlådas loopback-adress.
const googleUser = `alex.${run}@gmail.test`;
const b64url = (s) => Buffer.from(s).toString('base64url');
const fakeGoogle = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/auth') {
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', 'kod');
    back.searchParams.set('state', url.searchParams.get('state'));
    return res.writeHead(302, { Location: back.toString() }).end();
  }
  if (url.pathname === '/token') {
    const idToken = `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ email: googleUser, name: 'Alex från Google' }))}.x`;
    return res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: idToken }));
  }
  res.writeHead(404).end();
});
await new Promise((r) => fakeGoogle.listen(0, '127.0.0.1', r));
const g = `http://127.0.0.1:${fakeGoogle.address().port}`;
const oauthEnv = {
  MRMAIL_OAUTH_TEST: JSON.stringify({
    google: { auth: `${g}/auth`, token: `${g}/token` },
    servers: { imap: { host: HOST, port: 3143, security: 'none' }, smtp: { host: HOST, port: 3025, security: 'none' } }
  })
};

// Låtsad OpenAI: modellista och chat/completions, kräver rätt nyckel.
const openaiCalls = [];
const fakeOpenAi = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'Bearer sk-test-e2e' && req.headers.authorization !== 'Bearer server-e2e') return res.writeHead(401).end('{"error":{"message":"bad key"}}');
    if (req.url === '/v1/models')
      return res.end(JSON.stringify({ data: [{ id: 'gpt-4.1', created: 1 }, { id: 'gpt-5.5', created: 3 }, { id: 'gpt-5.5-mini', created: 4 }, { id: 'gpt-realtime', created: 5 }] }));
    if (req.url === '/v1/chat/completions') {
      const call = JSON.parse(body);
      openaiCalls.push(call);
      // Svaret beror på uppgiften, så att alla AI-flöden kan provas utan riktig modell.
      const all = JSON.stringify(call.messages);
      const last = String(call.messages.at(-1)?.content ?? '');
      let content = 'Hej Karin!\n\nTisdag klockan 14 passar bra, jag skickar en inbjudan. Säg till om ni vill ha med något särskilt på demon.\n\nVänliga hälsningar,\nAlex';
      if (/snabbsvar/i.test(all)) content = '1. Hej Karin! Tisdag klockan 14 passar bra.\n2. Hej Karin! Vad vill ni helst se på demon?\n3. Hej Karin! Tack, men den veckan går tyvärr inte.';
      else if (/Sammanfatta/.test(last)) content = 'Karin vill se en demo av Nordljus nästa vecka, tisdag eller torsdag eftermiddag. Alex har svarat att tisdag klockan 14 passar.';
      else if (/göra/i.test(last)) content = '1. Skicka en kalenderinbjudan till Karin för tisdag klockan 14.';
      else if (/Kortare|kortare/.test(last)) content = 'Hej Karin!\n\nTisdag klockan 14 passar.\n\nAlex';
      return res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    }
    res.writeHead(404).end('{}');
  });
});
await new Promise((r) => fakeOpenAi.listen(0, '127.0.0.1', r));
const openaiUrl = `http://127.0.0.1:${fakeOpenAi.address().port}/v1`;

// Låtsad avregistrering: tar emot ett-klicks-anrop (RFC 8058).
const unsubCalls = [];
const fakeUnsub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    unsubCalls.push({ method: req.method, url: req.url, body });
    res.writeHead(200).end('ok');
  });
});
await new Promise((r) => fakeUnsub.listen(0, '127.0.0.1', r));
const unsubUrl = `http://127.0.0.1:${fakeUnsub.address().port}/avreg`;

async function newsletter(from, to, subject, unsubHeader, post) {
  const raw = [
    `From: Butiken <${from}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@butiken.test>`,
    `Date: ${new Date().toUTCString()}`,
    `List-Unsubscribe: ${unsubHeader}`,
    ...(post ? ['List-Unsubscribe-Post: List-Unsubscribe=One-Click'] : []),
    'List-Id: Nyheter <nyheter.butiken.test>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Veckans erbjudanden.'
  ].join('\r\n');
  await smtp.sendMail({ envelope: { from, to: [to] }, raw });
}

async function openManual(win) {
  await win.click('text=Lägg till konto');
  await win.click('.provider-big:has-text("Annat konto")');
  await win.click('.manual-link');
  await win.waitForSelector('.server-row');
}

async function addTestAccount(win, email, name) {
  await openManual(win);
  await win.fill('input[placeholder="namn@exempel.se"]', email);
  await win.fill('input[type=password]', 'test');
  await win.fill('input[placeholder="Jobb"]', name);
  await win.fill('input[placeholder="Förnamn Efternamn"]', 'Alex Berg');
  const rows = win.locator('.server-row');
  await rows.nth(0).locator('input.grow').fill(HOST);
  await rows.nth(0).locator('input.port').fill('3143');
  await rows.nth(0).locator('select').selectOption('none');
  await rows.nth(1).locator('input.grow').fill(HOST);
  await rows.nth(1).locator('input.port').fill('3025');
  await rows.nth(1).locator('select').selectOption('none');
  await win.click('.modal-foot .btn.primary');
  await win.waitForSelector('.modal', { state: 'detached', timeout: 20000 });
}

// MCP-klient: startar den byggda stdio-servern med Node och pratar JSON-RPC med den.
function mcpClient(dataDir) {
  const proc = spawn(process.execPath, [join(root, 'dist/mcp/mr-mail-mcp.cjs')], { env: { ...process.env, MRMAIL_DATA: dataDir, MRMAIL_APP: join(dataDir, 'ingen-app.exe') } });
  const pending = new Map();
  let next = 1;
  let buf = '';
  proc.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg);
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}
`);
    });
  const tool = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return { error: r.result?.isError, text: r.result?.content?.[0]?.text ?? r.error?.message ?? '' };
  };
  return { rpc, tool, close: () => proc.kill() };
}

async function shot(page, name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(docs, name) });
  console.log(`     skärmbild docs/${name}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'brevlada-e2e-'));
// Signaturexporter i Sparks format. Bilden är länkad, som i Alex riktiga signaturer.
const sparkSig = (email, title) =>
  `<table cellpadding="0" cellspacing="0" border="0" style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;border-collapse:collapse;"><tr><td style="padding:0 14px 0 0;vertical-align:middle;"><a href="https://www.nordljus.se"><img src="https://www.nordljus.se/icons/signatur.png" width="48" height="48" alt="Nordljus" style="display:block;width:48px;height:48px;border:0;"></a></td><td style="padding:0 0 0 14px;border-left:1px solid #e3e3e3;vertical-align:middle;"><div style="font-size:15px;font-weight:600;line-height:20px;">Alex Berg</div><div style="font-size:13px;line-height:18px;color:#6b6b6b;">${title}</div><div style="font-size:13px;line-height:20px;padding-top:4px;"><a href="mailto:${email}" style="color:inherit;text-decoration:none;">${email}</a></div></td></tr></table>`;
const sparkFile = (name, sigs) => {
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify(sigs.map(([email, title], i) => ({ identifier: `S${i}`, id: `S${i}`, type: 1, deleted: false, htmlContent: i ? `<div data-spark-custom-html="true">${sparkSig(email, title)}</div>` : sparkSig(email, title) }))));
  return path;
};
const sparkFirst = sparkFile('spark-forsta.json', [['alex@nordljus.se', 'Grundare, Nordljus'], ['hej@nordljus.se', 'Grundare, Nordljus']]);
const sparkFlow = sparkFile('spark-flode.json', [[nordljus, 'Nordljus AB']]);
let app;
try {
  // 1. Förstagångsstart med Alex tre förberedda konton.
  {
    const seed = JSON.stringify([
      ['alex.berg@gmail.com', 'gmail', 'Gmail', 'Alex Berg'],
      ['alex@nordljus.se', 'simply', 'Nordljus', 'Alex Berg'],
      ['hej@nordljus.se', 'simply', 'Nordljus hej', 'Nordljus']
    ]);
    const first = await launch(join(tmp, 'forsta'), { ...discoveryEnv, ...oauthEnv, MRMAIL_SPARK_EXPORT: sparkFirst, MRMAIL_SEED: seed });
    app = first.app;
    const { win } = first;
    await win.waitForSelector('.account');

    // Del 2: vid första start erbjuds signaturerna från Spark, med rätt konto föreslaget.
    await win.waitForSelector('.spark-import', { timeout: 10000 });
    const cards = win.locator('.import-card');
    check('Signaturerna från Spark erbjuds vid första start', (await cards.count()) === 2);
    const picks = await cards.locator('select').evaluateAll((els) => els.map((e) => e.value));
    check('Rätt konto föreslås för varje signatur', picks.join(',') === 'alex-nordljus-se,hej-nordljus-se', picks.join(','));
    await win.waitForTimeout(800);
    await shot(win, 'spark-import.png');
    await win.click('.spark-import .btn.primary');
    await win.waitForSelector('.spark-import', { state: 'detached' });
    const sigState = await win.evaluate(() => window.api.state());
    const accSig = (id) => sigState.accounts.find((a) => a.id === id)?.signature ?? '';
    check(
      'Signaturerna importeras och kopplas till kontona',
      sigState.settings.signatures.length === 2 && accSig('alex-nordljus-se').includes('mailto:alex@nordljus.se') && accSig('hej-nordljus-se').includes('mailto:hej@nordljus.se')
    );
    check('Länkade bilder behålls', accSig('alex-nordljus-se').includes('src="https://www.nordljus.se/icons/signatur.png"'));
    check('Gmail får ingen signatur', accSig('alex-berg-gmail-com') === '');
    await win.click('button[aria-label="Inställningar"]');
    await win.click('text=Redigera signaturer…');
    await win.waitForSelector('.signatures-modal .signature-preview');
    await win.waitForTimeout(800);
    check('Signaturlistan visar båda med sina konton', (await win.locator('.sig-item').allInnerTexts()).join(' ').includes('Nordljus hej'));
    await shot(win, 'signaturer.png');
    await win.click('.signatures-modal .segmented button:has-text("HTML")');
    check('Signaturen kan redigeras som HTML', (await win.locator('.sig-html').inputValue()).includes('<table'));
    await win.keyboard.press('Escape');
    await win.keyboard.press('Escape');
    await win.waitForSelector('.modal', { state: 'detached' });
    const names = await win.locator('.account-name .nav-label').allTextContents();
    check('Tre förberedda konton visas', names.join(',') === 'Gmail,Nordljus,Nordljus hej', names.join(', '));
    const hints = await win.locator('.login-hint').count();
    check('Konton utan lösenord ber om inloggning', hints === 3);
    await shot(win, 'forsta-start.png');

    // Gmail utan klient-id: tydlig ruta, guide och app-lösenord som reserv.
    await win.locator('.login-hint').first().click();
    await win.waitForSelector('.notice-box');
    check('Gmail öppnar Google-inloggningen direkt', (await win.locator('.add-account h2').textContent()) === 'Logga in på Gmail');
    check('Saknat klient-id ger tydlig ruta', (await win.locator('.notice-box h3').textContent()) === 'Google-inloggning är inte aktiverad än');
    await shot(win, 'kontodialog-gmail.png');
    await win.click('.notice-box button:has-text("Använd app-lösenord")');
    const help = await win.locator('.help-box').textContent();
    check('App-lösenord som reserv förklaras', /app-lösenord/i.test(help) && /Skapa app-lösenord/.test(help));
    const gmailAddr = win.locator('input[placeholder="namn@exempel.se"]');
    check('Gmail-adressen är förifylld och låst', (await gmailAddr.inputValue()) === 'alex.berg@gmail.com' && (await gmailAddr.isDisabled()));
    await shot(win, 'kontodialog-app-losenord.png');
    await win.keyboard.press('Escape');

    // Nordljus (Simply.com): bara lösenordet.
    await win.locator('.login-hint').nth(1).click();
    await win.waitForSelector('.simple-setup');
    check(
      'Nordljus öppnar lösenordsrutan för Simply.com',
      (await win.locator('.provider-head').textContent()) === 'Simply.com' && /redan inställda/.test(await win.locator('.simple-setup p.muted').textContent())
    );
    await win.keyboard.press('Escape');

    // Lägg till konto: stora knappar som i Apple Mail.
    await win.click('text=Lägg till konto');
    await win.waitForSelector('.provider-list');
    const choices = await win.locator('.provider-big').allTextContents();
    check('Lägg till konto visar fem val', choices.join(',') === 'Logga in med Google,Simply.com,iCloud,Outlook,Annat konto', choices.join(', '));
    await shot(win, 'kontodialog-lagg-till.png');
    await win.click('.provider-big:has-text("Simply.com")');
    check('Simply.com frågar bara efter adress och lösenord', (await win.locator('.simple-setup input').count()) === 3 && (await win.locator('.server-row').count()) === 0);
    check('Namnet hämtas från de andra kontona', (await win.locator('.simple-setup input').first().inputValue()) === 'Alex Berg');
    await shot(win, 'lagg-till-simply.png');
    await win.click('.back-btn');
    await win.click('.provider-big:has-text("Annat konto")');
    await win.fill('.simple-setup input[placeholder="namn@exempel.se"]', 'kalle@okand.test');
    await win.fill('.simple-setup input[type=password]', 'hemligt');
    await win.click('.setup-btn');
    await win.waitForSelector('.simple-setup .form-errors', { timeout: 60000 });
    const notFound = await win.locator('.simple-setup .form-errors').textContent();
    check('Okänd domän ger tydligt besked', /Hittade ingen e-postserver för okand\.test/.test(notFound), notFound);
    await shot(win, 'enkel-inloggning-fel.png');
    await win.click('.manual-link');
    check('Ställ in manuellt behåller adressen', (await win.locator('input[placeholder="namn@exempel.se"]').inputValue()) === 'kalle@okand.test');
    check('Ställ in manuellt öppnar servrarna', (await win.locator('.server-row').count()) === 2);
    await win.keyboard.press('Escape');

    // Google: guiden, sedan ett klick som lägger till kontot med namn och adress från Google.
    await win.click('text=Lägg till konto');
    await win.click('.provider-google');
    await win.click('text=Visa guiden');
    await shot(win, 'google-guide.png');
    await win.fill('input[placeholder="123-abc.apps.googleusercontent.com"]', '123-test.apps.googleusercontent.com');
    await win.fill('.guide input[type=password]', 'GOCSPX-test');
    await win.click('text=Spara och logga in');
    await win.waitForSelector('.modal', { state: 'detached', timeout: 20000 });
    const oauthCfg = await win.evaluate(() => window.api.oauthConfig());
    check('Klienthemligheten sparas krypterad och visas inte', oauthCfg.hasGoogleSecret && !JSON.stringify(oauthCfg).includes('GOCSPX'));
    const gAcc = await win.evaluate((e) => window.api.state().then((s) => s.accounts.find((a) => a.email === e)), googleUser);
    check('Google-kontot får adress och namn från Google', gAcc?.auth === 'oauth' && gAcc.displayName === 'Alex från Google' && gAcc.provider === 'gmail');
    await win.waitForFunction(
      (e) => [...document.querySelectorAll('.account-name')].some((n) => n.title.startsWith(e) && n.querySelector('.dot-online')),
      googleUser,
      { timeout: 20000 }
    );
    check('Google-kontot ansluter utan lösenord (XOAUTH2)', true);
    await win.click('text=Lägg till konto');
    await win.click('.provider-google');
    await win.waitForSelector('.modal', { state: 'detached', timeout: 20000 });
    const count = await win.evaluate(() => window.api.state().then((s) => s.accounts.filter((a) => a.provider === 'gmail').length));
    check('Ett klick till på Google dubblerar inte kontot', count === 2);
    // Förifyllda Gmail-kontot loggar in direkt nu när klient-id finns, och vägrar fel Google-konto.
    await win.locator('.login-hint').first().click();
    await win.waitForSelector('.add-account .form-errors', { timeout: 20000 });
    check('Fel Google-konto ger tydligt fel', /Du loggade in som/.test(await win.locator('.add-account .form-errors').textContent()));
    await win.keyboard.press('Escape');
    await win.locator('.account-name', { hasText: googleUser }).click();
    await win.waitForSelector('.method-switch');
    await shot(win, 'kontodialog-oauth.png');
    check('Inloggat Google-konto visar Google som inloggning', (await win.locator('.method-switch button.on').textContent()).includes('Google'));
    await win.keyboard.press('Escape');
    await app.close();
    app = null;
  }

  // 2. Riktigt flöde mot GreenMail.
  await seed();
  await seedCustom(nordljus);
  const second = await launch(join(tmp, 'flode'), { MRMAIL_NO_SEED: '1', ...discoveryEnv, MRMAIL_SPARK_EXPORT: sparkFlow, MRMAIL_TEST_HTTP_UNSUB: '1', MRMAIL_UPDATE_DRYRUN: '1' });
  app = second.app;
  const { win } = second;
  await addTestAccount(win, nordljus, 'Nordljus');
  // Annat konto: bara adress och lösenord, servrarna hittas via autoconfig.
  await win.click('text=Lägg till konto');
  await win.click('.provider-big:has-text("Annat konto")');
  await win.fill('.simple-setup input[placeholder="namn@exempel.se"]', gmail);
  await win.fill('.simple-setup input[type=password]', 'test');
  await win.click('.setup-btn');
  await win.waitForSelector('.modal', { state: 'detached', timeout: 60000 });
  const added = await win.evaluate(() => window.api.state().then((s) => s.accounts.find((a) => a.email.includes('@gmail.test'))));
  check('Enkel inloggning hittar servrarna och sparar kontot', added?.imap.port === 3143 && added?.smtp.port === 3025 && added?.displayName === 'Alex Berg');
  await win.evaluate((cfg) => window.api.saveAccount({ config: { ...cfg, name: 'Gmail' } }), added);
  await win.waitForSelector('.dot-online', { timeout: 20000 });
  await win.waitForFunction(() => document.querySelectorAll('.dot-online').length === 2, null, { timeout: 20000 });
  check('Båda testkontona är anslutna (grön prick)', true);
  await win.evaluate(() => window.api.saveSettings({ undoSendSeconds: 0, smartInbox: false }));
  // AI med egen server: den låtsade OpenAI-servern.
  await win.evaluate((u) => window.api.saveSettings({ aiEngine: 'spark', sparkUrl: u, sparkKey: 'server-e2e', sparkModel: 'test-model' }), openaiUrl);
  await win.waitForFunction(() => document.querySelectorAll('.row').length >= 8, null, { timeout: 20000 });
  const rows = await win.locator('.row').count();
  check('Samlad inkorg visar alla mejl', rows === 8, `${rows} rader`);
  const totalUnread = await win.locator('.nav-item.active .count').textContent();
  check('Olästa räknas', totalUnread === '8', totalUnread);

  // Läs ett mejl.
  await win.click('.row:has-text("Demo av Nordljus")');
  await win.waitForSelector('.text-body');
  const body = await win.locator('.text-body').textContent();
  check('Läsvyn visar brödtexten', body.includes('mässan i Göteborg'));
  await win.waitForFunction(() => document.querySelector('.nav-item.active .count')?.textContent === '7');
  check('Mejlet markeras som läst', true);
  await shot(win, 'huvudfonster.png');

  // HTML med blockerade bilder.
  await win.click('.row:has-text("förnyas snart")');
  await win.waitForSelector('.remote-banner');
  check('Fjärrbilder blockeras med knapp Visa bilder', (await win.locator('.remote-banner button').textContent()) === 'Visa bilder');
  const frame = win.frameLocator('.html-frame');
  const blockedImgs = await frame.locator('img[data-blocked-src]').count();
  check('Spårningspixel och logga är blockerade', blockedImgs === 2, `${blockedImgs} st`);
  await shot(win, 'html-mejl.png');

  // Bilaga och flagga.
  await win.click('.row:has-text("Faktura för oktober")');
  await win.waitForSelector('.attachment');
  check('Bilagan visas', (await win.locator('.att-name').textContent()) === 'Faktura-2026-1043.pdf');
  await win.click('button[aria-label="Flagga"]');
  await win.waitForSelector('.row.selected .row-flag');
  check('Flagga visas i listan', true);

  // Arkivera.
  await win.evaluate(() => {
    const w = window;
    w.__blink = 0;
    w.__blinkObs = new MutationObserver(() => {
      if ([...document.querySelectorAll('.row')].some((r) => r.textContent.includes('Faktura för oktober'))) w.__blink++;
    });
    w.__blinkObs.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await win.click('button[aria-label^="Arkivera"]');
  await win.waitForSelector('.toast', { timeout: 10000 }).catch(() => undefined);
  const archiveToast = await win.locator('.toast').textContent().catch(() => 'ingen notis');
  const archived = await imapFetchLatest(nordljus, 'Archive', 'Faktura för oktober');
  check('Arkivera flyttar mejlet på servern', !!archived);
  await win.waitForTimeout(1500);
  const blinks = await win.evaluate(() => {
    window.__blinkObs.disconnect();
    return window.__blink;
  });
  check('Arkiverat mejl blinkar inte tillbaka i listan', blinks === 0, `${blinks} gånger`);
  check('Notisen erbjuder Ångra efter arkivering', archiveToast.endsWith('Ångra'), archiveToast);
  await win.waitForSelector('.toast-action', { timeout: 10000 });
  const notesBefore = await app.evaluate(() => globalThis.__mrmailNotifications ?? 0);
  await win.click('.toast-action');
  await win.waitForSelector('.row:has-text("Faktura för oktober")', { timeout: 20000 }).catch(() => undefined);
  check(
    'Ångra lägger tillbaka mejlet i inkorgen',
    (await imapCount(nordljus, 'INBOX', 'Faktura för oktober')) === 1 && (await win.locator('.row', { hasText: 'Faktura för oktober' }).count()) === 1
  );
  await new Promise((r) => setTimeout(r, 1500));
  check('Ett ångrat mejl ger ingen ny avisering', (await app.evaluate(() => globalThis.__mrmailNotifications ?? 0)) === notesBefore);
  await win.click('.row:has-text("Faktura för oktober")');
  await win.waitForSelector('.attachment');
  await win.click('button[aria-label^="Arkivera"]');
  await waitUntil(async () => (await imapCount(nordljus, 'Archive', 'Faktura för oktober')) === 1, 15000);

  // Sök.
  await win.fill('#search', 'lasagne');
  await win.waitForFunction(() => document.querySelectorAll('.row').length === 1);
  check('Lokal sökning hittar mejlet', (await win.locator('.row-subject').textContent()) === 'Middag på söndag?');
  await win.fill('#search', '');

  // Nytt mejl via IDLE.
  await smtp.sendMail({ from: 'Anna Ny <anna@ny.test>', to: nordljus, subject: 'Helt nytt mejl', text: 'Kom just nu.' });
  const t0 = Date.now();
  await win.waitForSelector('.row:has-text("Helt nytt mejl")', { timeout: 15000 });
  check('Nytt mejl dyker upp direkt (IDLE)', true, `${Date.now() - t0} ms`);
  const notified = await app.evaluate(() => globalThis.__mrmailNotifications ?? 0);
  check('Windows-avisering visas för nytt mejl', notified >= 1, `${notified} st`);
  {
    const fresh = (await win.evaluate(() => window.api.list({ kind: 'unified', role: 'inbox' }, 50))).items.find((m) => m.subject === 'Helt nytt mejl');
    await app.evaluate((_e, id) => globalThis.__mrmailNotifyAction(id, 'read'), fresh.id);
    const seenNow = await waitUntil(async () => (await win.evaluate(() => window.api.list({ kind: 'unified', role: 'inbox' }, 50))).items.find((m) => m.subject === 'Helt nytt mejl')?.seen, 10000);
    check('Markera som läst i notisen markerar mejlet', !!seenNow);
    await app.evaluate((_e, id) => globalThis.__mrmailNotifyReply(id, 'Tack Anna, det passar bra.'), fresh.id);
    const reply = await imapFetchLatest('anna@ny.test', 'INBOX', 'Re: Helt nytt mejl', 20000);
    const replyText = reply ?? '';
    check('Svar skrivet i notisen skickas med citat', !!reply && replyText.includes('Tack Anna, det passar bra.') && replyText.includes('Kom just nu.'));
  }

  // Mörkt läge.
  await app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'dark';
  });
  await win.emulateMedia({ colorScheme: 'dark' });
  await win.click('.row:has-text("Demo av Nordljus")');
  await win.waitForSelector('.text-body');
  await shot(win, 'huvudfonster-morkt.png');
  await app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'light';
  });
  await win.emulateMedia({ colorScheme: 'light' });

  // AI-förslag i svarsfönstret.
  if (!skipAi) {
    const winPromise = app.waitForEvent('window');
    await win.click('.ai-btn');
    const compose = await winPromise;
    await compose.waitForLoadState('domcontentloaded');
    await compose.waitForSelector('.ai-panel');
    await compose.waitForSelector('.bubble.assistant:not(.thinking)', { timeout: 180000 });
    const draft = await compose.locator('.editor').innerText();
    check('Citerad originaltext visas under svaret', (await compose.locator('.quote-view blockquote').count()) === 1);
    check('AI skriver ett utkast i svarsfönstret', /Karin/.test(draft), `${draft.length} tecken`);
    const to = await compose.locator('#to').inputValue();
    check('Svaret går till avsändaren', to.includes(karin));
    check('Ämnet får Re:', (await compose.locator('#subject').inputValue()) === 'Re: Demo av Nordljus nästa vecka?');
    await compose.click('.pill:has-text("Kortare")');
    await compose.waitForFunction(() => document.querySelectorAll('.bubble.assistant:not(.thinking)').length === 2, null, { timeout: 180000 });
    const shorter = await compose.locator('.editor').innerText();
    check('Chattrutan gör utkastet kortare', shorter.length < draft.length, `${draft.length} till ${shorter.length} tecken`);
    await compose.setViewportSize({ width: 1080, height: 740 }).catch(() => undefined);
    await shot(compose, 'svarsfonster-ai.png');

    // Skicka och kontrollera att det kom fram och hamnade i Skickat.
    const closed = compose.waitForEvent('close', { timeout: 30000 });
    await compose.click('.btn.send');
    await closed;
    const got = await imapFetchLatest(karin, 'INBOX', 'Re: Demo av Nordljus');
    check('Svaret kom fram till mottagaren', !!got && got.includes('In-Reply-To:'));
    const sent = await imapFetchLatest(nordljus, 'Sent', 'Re: Demo av Nordljus');
    check('Svaret sparades i Skickat', !!sent);
    await win.waitForSelector('.row:has-text("Demo av Nordljus") .answered', { timeout: 10000 }).catch(() => undefined);
  }

  // Fas 5: AI i läsvyn ser hela tråden, sammanfattar och föreslår snabbsvar.
  if (!skipAi) {
    await win.click('.nav-item:has-text("Alla inkorgar")');
    await win.click('.row:has-text("Demo av Nordljus")');
    await win.waitForSelector('.ai-tools');
    await win.waitForFunction(() => document.querySelector('.thread-meta')?.textContent.includes('2 mejl'), null, { timeout: 15000 }).catch(() => undefined);
    check('Svaret syns i tråden', (await win.locator('.thread-meta').textContent().catch(() => '')).includes('2 mejl'));
    check('Motorn kan väljas direkt i läsvyn', (await win.locator('.ai-tools .engine-select option').allTextContents()).join(',') === 'Egen server,Datorns modell,Claude,ChatGPT');
    await win.click('.ai-tools .pill:has-text("Sammanfatta tråd")');
    await win.waitForSelector('.ai-result:not(.busy)', { timeout: 180000 });
    const summary = await win.locator('.ai-result-body').textContent();
    const sumHead = await win.locator('.ai-result-head').textContent();
    check('Sammanfatta tråd ger en sammanfattning', !(await win.locator('.ai-result.error').count()) && summary.length > 20, summary.slice(0, 80));
    check('Sammanfattningen läste hela tråden', /tråden \(2 mejl\)/.test(sumHead), sumHead);
    await win.waitForSelector('.quick-reply', { timeout: 180000 }).catch(() => undefined);
    const quick = await win.locator('.quick-reply').allTextContents();
    check('Tre snabbsvar visas under mejlet', quick.length === 3, quick.map((q) => q.slice(0, 30)).join(' | '));
    await win.click('.ai-tools .pill:has-text("Vad behöver jag göra?")');
    await win.waitForSelector('.ai-result-head:has-text("Att göra")', { timeout: 180000 });
    check('Vad behöver jag göra? svarar', (await win.locator('.ai-result-body').textContent()).length > 3);
    await shot(win, 'ai-lasvy.png');
    if (quick.length) {
      const p5 = app.waitForEvent('window');
      await win.locator('.quick-reply').first().click();
      const qc = await p5;
      await qc.waitForSelector('.editor');
      await qc.waitForFunction((t) => document.querySelector('.editor')?.innerText.includes(t.slice(0, 20)), quick[0], { timeout: 10000 }).catch(() => undefined);
      check('Snabbsvaret öppnas som utkast i svarsfönstret', (await qc.locator('.editor').innerText()).includes(quick[0].slice(0, 20)));
      check('Svarsfönstret har motorval', (await qc.locator('.ai-head .engine-select').count()) === 1);
      const gone = qc.waitForEvent('close', { timeout: 20000 });
      await qc.click('button[aria-label="Släng utkastet"]').catch(() => undefined);
      await gone;
    }
  }

  // Del 3: ChatGPT via OpenAI:s API, mot en låtsad server.
  await win.evaluate((u) => window.api.saveSettings({ openaiUrl: u }), openaiUrl);
  await win.waitForTimeout(600);
  await win.click('button[aria-label="Inställningar"]');
  await win.click('.segmented.engines button:has-text("ChatGPT")');
  check('ChatGPT finns bredvid egen server, datorns modell och Claude', (await win.locator('.segmented.engines button strong').allTextContents()).join(',') === 'Egen server,Datorns modell,Claude,ChatGPT,ChatGPT (ditt abonnemang)');
  await win.fill('#openai-key', 'sk-test-e2e');
  await win.locator('#openai-key').blur();
  await win.waitForFunction(() => document.querySelector('#openai-model option')?.textContent === 'Senaste (gpt-5.5)', null, { timeout: 10000 }).catch(() => undefined);
  check('Senaste GPT-modellen är förvald', (await win.locator('#openai-model option').first().textContent()) === 'Senaste (gpt-5.5)');
  check('Modellistan kommer från /v1/models', (await win.locator('#openai-model option').allTextContents()).includes('gpt-4.1'));
  check('Abonnemangsvägen förklarar att Codex CLI krävs', /Kräver Codex CLI/.test(await win.locator('.segmented.engines button.unavailable').textContent()));
  await shot(win, 'installningar-chatgpt.png');
  await win.click('.settings-modal .modal-foot .btn.primary');
  await win.waitForSelector('.modal', { state: 'detached' });
  const keyLeak = await win.evaluate(() => window.api.state().then((s) => JSON.stringify(s)));
  check('API-nyckeln syns inte i appens tillstånd', !keyLeak.includes('sk-test-e2e'));
  await win.click('.nav-item:has-text("Alla inkorgar")');
  await win.click('.row:has-text("Demo av Nordljus")');
  await win.waitForSelector('.quick-replies');
  check('Snabbsvar med ChatGPT tas fram på begäran', (await win.locator('.quick-replies .pill:has-text("Föreslå snabbsvar")').count()) === 1);
  const gptWin = app.waitForEvent('window');
  await win.click('.ai-btn');
  const gpt = await gptWin;
  await gpt.waitForSelector('.bubble.assistant:not(.thinking)', { timeout: 30000 });
  await gpt.waitForFunction(() => document.querySelector('.editor')?.innerText.includes('Tisdag klockan 14 passar bra'), null, { timeout: 10000 }).catch(() => undefined);
  check('ChatGPT skriver utkastet', (await gpt.locator('.editor').innerText()).includes('Tisdag klockan 14 passar bra'));
  check('Anropet gick till senaste GPT-modellen', openaiCalls.at(-1)?.model === 'gpt-5.5' && /Karin/.test(JSON.stringify(openaiCalls.at(-1)?.messages)));
  const gptGone = gpt.waitForEvent('close', { timeout: 20000 });
  await gpt.click('button[aria-label="Släng utkastet"]').catch(() => undefined);
  await gptGone;
  await win.evaluate(() => window.api.saveSettings({ aiEngine: 'spark' }));

  // Nytt meddelande utan AI.
  const p2 = app.waitForEvent('window');
  await win.click('button[aria-label="Nytt meddelande"]');
  const blank = await p2;
  await blank.waitForSelector('#to');
  check('Nytt meddelande har ingen AI-panel', (await blank.locator('.ai-panel').count()) === 0);
  await blank.close();

  // Fas 1: mappträd med undermappar, olästa räknare och Flytta till.
  const kunder = await win.locator('.nav-item', { hasText: 'Kunder' }).count();
  check('Föräldermappen Kunder visas i trädet', kunder === 1, `${kunder} st`);
  check('Undermappen Stockholm visas i trädet', (await win.locator('.nav-item', { hasText: 'Stockholm' }).count()) === 1);
  check('Undermappen Övrigt visas i trädet', (await win.locator('.nav-item', { hasText: 'Övrigt' }).count()) === 1);

  await win.locator('.nav-item', { hasText: 'Stockholm' }).click();
  await win.waitForFunction(() => [...document.querySelectorAll('.row-subject')].some((e) => e.textContent.includes('Stockholm')), null, { timeout: 20000 });
  const stockholmUnread = await win.locator('.nav-item', { hasText: 'Stockholm' }).locator('.count').textContent().catch(() => null);
  check('Olästa räknaren visas för en egen mapp', stockholmUnread === '1', String(stockholmUnread));
  check('Listan har mappens namn som rubrik', (await win.locator('.list-head h1, .list-title').first().textContent()) === 'Stockholm');
  await shot(win, 'mapptrad.png');

  await win.click('.nav-item:has-text("Alla inkorgar")');
  await win.waitForSelector('.row:has-text("Helt nytt mejl")', { timeout: 20000 });
  await win.click('.row:has-text("Helt nytt mejl")');
  await win.waitForSelector('.text-body');
  await win.click('button[aria-label="Flytta till mapp"]');
  await win.waitForSelector('.move-menu');
  check('Flytta till-menyen visar den egna mappen', (await win.locator('.move-item', { hasText: 'Övrigt' }).count()) === 1);
  await shot(win, 'flytta-till.png');
  await win.locator('.move-item', { hasText: 'Övrigt' }).click();
  await win.waitForSelector('.move-menu', { state: 'detached', timeout: 10000 });
  const moved = await imapFetchLatest(nordljus, 'Kunder.Övrigt', 'Helt nytt mejl');
  check('Mejlet hamnar i den egna mappen på servern', !!moved, moved ? 'hittades' : 'hittades inte');

  // Fas 2: signatur, adressförslag, rik text, bifoga med drag, autospara och fortsätt på utkast.
  // Del 2: egen signatur i rik text, import från Spark och standard per konto, inifrån redigeraren.
  await win.click('button[aria-label="Inställningar"]');
  await win.click('text=Redigera signaturer…');
  await win.click('text=Ny signatur');
  await win.locator('.sig-title').fill('Kort');
  await win.locator('.sig-edit .editor').click();
  await win.keyboard.type('Alex / Gmail');
  await win.locator('.sig-default', { hasText: 'Gmail' }).locator('select').selectOption({ label: 'Kort' });
  await win.click('.spark-import-btn');
  await win.waitForSelector('.spark-import');
  const nordljusId = await win.evaluate((e) => window.api.state().then((s) => s.accounts.find((a) => a.email === e).id), nordljus);
  check('Importen föreslår Nordljus-kontot', (await win.locator('.import-card select').first().inputValue()) === nordljusId);
  await win.click('.spark-import .btn.primary');
  await win.waitForSelector('.spark-import', { state: 'detached' });
  await win.keyboard.press('Escape');
  await win.waitForSelector('.modal', { state: 'detached' });
  const flowSigs = await win.evaluate(() => window.api.state());
  check('Egen signatur sparas före importen', /Alex \/ Gmail/.test(flowSigs.accounts.find((a) => a.email.includes('@gmail.test'))?.signature ?? ''));
  check('Spark-signaturen blir standard för Nordljus', /Nordljus AB/.test(flowSigs.accounts.find((a) => a.email === nordljus)?.signature ?? ''));
  await win.waitForFunction(() => document.querySelectorAll('.dot-online').length === 2, null, { timeout: 20000 });
  await win.click('.nav-item:has-text("Alla inkorgar")');
  await win.click('.row:has-text("Demo av Nordljus")');
  const p3 = app.waitForEvent('window');
  await win.click('button[aria-label="Nytt meddelande"]');
  const rich = await p3;
  await rich.waitForSelector('.editor');
  check('Signaturen läggs in för avsändarkontot', (await rich.locator('.editor .brevlada-signature').innerText()).includes('Nordljus AB'));
  check('Signaturens länkade bild finns i svarsfönstret', (await rich.locator('.editor .brevlada-signature img').getAttribute('src')) === 'https://www.nordljus.se/icons/signatur.png');
  await rich.click('#to');
  await rich.keyboard.type('karin');
  await rich.waitForSelector('.addr-item', { timeout: 5000 }).catch(() => undefined);
  const suggestion = await rich.locator('.addr-item').first().innerText().catch(() => '');
  check('Adressfältet föreslår kontakter från cachen', suggestion.includes(karin), suggestion.replace(/\s+/g, ' '));
  await shot(rich, 'adressforslag.png');
  await rich.keyboard.press('Enter');
  check('Förslaget fylls i som adress', (await rich.locator('#to').inputValue()).includes(`<${karin}>`));
  const subject = `Offert ${run}`;
  await rich.fill('#subject', subject);
  await rich.locator('.editor').click({ position: { x: 20, y: 12 } });
  await rich.keyboard.press('Control+Home');
  await rich.keyboard.type('Hej Karin! ');
  await rich.keyboard.press('Control+b');
  await rich.keyboard.type('Viktigt:');
  await rich.keyboard.press('Control+b');
  await rich.keyboard.type(' offerten kommer i morgon.');
  check('Fet stil i redigeraren', (await rich.locator('.editor b, .editor strong').count()) >= 1);
  await rich.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['Pris: 4 900 kr'], 'offert.txt', { type: 'text/plain' }));
    const target = document.querySelector('.compose');
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await rich.waitForSelector('.chip:has-text("offert.txt")', { timeout: 5000 }).catch(() => undefined);
  check('Fil som dras in bifogas', (await rich.locator('.chip:has-text("offert.txt")').count()) === 1);
  await rich.waitForSelector('.saved-at', { timeout: 25000 }).catch(() => undefined);
  const firstSave = await waitUntil(() => imapCount(nordljus, 'Drafts', subject), 15000);
  check('Utkastet autosparas till Utkast', firstSave === 1, `${firstSave ?? 0} st`);
  await shot(rich, 'svarsfonster-rik-text.png');
  await rich.keyboard.type(' Ring mig gärna.');
  await rich.keyboard.press('Control+s');
  await rich.waitForSelector('.compose-busy:has-text("sparat")', { timeout: 15000 }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 800));
  const versions = await imapCount(nordljus, 'Drafts', subject);
  check('Ny version ersätter den förra på servern', versions === 1, `${versions} st`);
  await rich.close();

  await win.locator('.account', { hasText: 'Nordljus' }).locator('.nav-item', { hasText: 'Utkast' }).click();
  await win.waitForSelector(`.row:has-text("${subject}")`, { timeout: 20000 });
  await win.click(`.row:has-text("${subject}")`);
  await win.waitForSelector('.continue-draft');
  await shot(win, 'utkast.png');
  const p4 = app.waitForEvent('window');
  await win.click('.continue-draft');
  const again = await p4;
  await again.waitForSelector('.editor');
  await again.waitForFunction(() => document.querySelector('.editor')?.textContent.includes('Ring mig'), null, { timeout: 10000 });
  check('Utkastet öppnas med texten kvar', true);
  check('Utkastet har kvar mottagaren', (await again.locator('#to').inputValue()).includes(karin));
  check('Utkastet har kvar bilagan', (await again.locator('.chip:has-text("offert.txt")').count()) === 1);
  const closedAgain = again.waitForEvent('close', { timeout: 30000 });
  await again.click('.btn.send');
  await closedAgain;
  const delivered = await imapFetchLatest(karin, 'INBOX', subject);
  const parsedMail = delivered ? await simpleParser(delivered) : null;
  check('Mejlet skickas som HTML med textalternativ', !!parsedMail?.html && /offerten kommer/.test(parsedMail?.text ?? ''));
  check('Fet stil följer med i HTML-delen', /<(b|strong)>Viktigt:<\/(b|strong)>/.test(String(parsedMail?.html ?? '')));
  check('Signaturen följer med', /Nordljus AB/.test(parsedMail?.text ?? ''));
  check('Signaturens bild skickas som länk', String(parsedMail?.html ?? '').includes('src="https://www.nordljus.se/icons/signatur.png"'));
  check('Bilagan följer med', !!parsedMail?.attachments.some((a) => a.filename === 'offert.txt'));
  const left = await waitUntil(async () => ((await imapCount(nordljus, 'Drafts', subject)) === 0 ? 'tomt' : null), 10000);
  check('Utkastet tas bort när mejlet skickas', left === 'tomt');

  // Fas 3: trådar, sök med filter och på servern, tangentbordsgenvägar.
  await win.click('.nav-item:has-text("Alla inkorgar")');
  const rootId = `<lunch-${run}@nordljus.test>`;
  await smtp.sendMail({ from: 'Erik Holm <erik@nordljus.test>', to: nordljus, subject: 'Lunch på fredag?', text: 'Ska vi äta lunch på fredag?', messageId: rootId, date: at(0, 7, 0) });
  await smtp.sendMail({ from: 'Erik Holm <erik@nordljus.test>', to: nordljus, subject: 'Re: Lunch på fredag?', text: 'Jag bokar bord klockan tolv.', inReplyTo: rootId, references: [rootId], date: at(0, 7, 5) });
  await win.waitForFunction(() => document.querySelector('.row:has(.thread-count)')?.textContent.includes('Lunch'), null, { timeout: 20000 }).catch(() => undefined);
  const lunchRows = await win.locator('.row', { hasText: 'Lunch på fredag' }).count();
  check('Svar och original visas som en rad (tråd)', lunchRows === 1, `${lunchRows} rader`);
  check('Raden visar antal mejl i tråden', (await win.locator('.row', { hasText: 'Lunch på fredag' }).locator('.thread-count').textContent().catch(() => '')) === '2');
  await win.locator('.row', { hasText: 'Lunch på fredag' }).click();
  await win.waitForSelector('.thread-head');
  await win.waitForFunction(() => document.querySelectorAll('.reader .msg').length === 2, null, { timeout: 10000 }).catch(() => undefined);
  check('Läsvyn visar hela tråden', (await win.locator('.reader .msg').count()) === 2, (await win.locator('.thread-meta').textContent()) ?? '');
  await shot(win, 'trad.png');

  await win.fill('#search', 'från:karin');
  await win.waitForFunction(() => [...document.querySelectorAll('.row-subject')].some((e) => e.textContent.includes('Demo av Nordljus')), null, { timeout: 10000 });
  check('Sökprefix från: hittar avsändaren', (await win.locator('.row', { hasText: 'Middag på söndag' }).count()) === 0);
  await win.fill('#search', '');
  await win.click('button[aria-label="Sökfilter"]');
  await win.click('.filter-pill:has-text("Med bilaga")');
  await win.waitForSelector('.row:has-text("Faktura för oktober")', { timeout: 10000 });
  check('Filtret Med bilaga hittar fakturan i Arkiv', (await win.locator('.row', { hasText: 'Middag på söndag' }).count()) === 0);
  await shot(win, 'sokfilter.png');
  await win.click('.filter-panel .link:has-text("Rensa filter")');
  await win.click('button[aria-label="Sökfilter"]');

  {
    const c = new ImapFlow({ host: HOST, port: 3143, secure: false, auth: { user: nordljus, pass: 'x' }, logger: false });
    await c.connect();
    const raw = ['From: Arkivet <arkiv@nordljus.test>', `To: ${nordljus}`, 'Subject: Gammalt avtal', `Date: ${at(400, 10, 0).toUTCString()}`, 'Message-ID: <avtal-' + run + '@nordljus.test>', '', 'Avtalet med kodordet zebrakod.'].join('\r\n');
    await c.append('Kunder', Buffer.from(raw), ['\\Seen']);
    await c.logout();
  }
  await win.fill('#search', 'zebrakod');
  await win.waitForSelector('.row:has-text("Gammalt avtal")', { timeout: 20000 }).catch(() => undefined);
  check('Sök på servern hittar mejl som inte finns i cachen', (await win.locator('.row', { hasText: 'Gammalt avtal' }).count()) === 1);
  await win.fill('#search', '');

  await win.click('.nav-item:has-text("Alla inkorgar")');
  await win.waitForSelector('.row:has-text("Middag på söndag")');
  await win.click('.row:has-text("Middag på söndag")');
  await win.waitForSelector('.text-body');
  const before = await win.locator('.row.selected .row-subject').textContent();
  await win.keyboard.press('ArrowDown');
  await win.waitForFunction((b) => document.querySelector('.row.selected .row-subject')?.textContent !== b, before, { timeout: 5000 }).catch(() => undefined);
  check('Pil ned väljer nästa mejl', (await win.locator('.row.selected .row-subject').textContent()) !== before);
  const target = await win.locator('.row.selected .row-subject').textContent();
  await win.keyboard.press('Control+Shift+L');
  await win.waitForSelector('.row.selected .row-flag', { timeout: 5000 }).catch(() => undefined);
  check('Ctrl+Skift+L flaggar', (await win.locator('.row.selected .row-flag').count()) === 1);
  await win.keyboard.press('e');
  await win.waitForFunction((t) => ![...document.querySelectorAll('.row-subject')].some((e) => e.textContent === t), target, { timeout: 10000 }).catch(() => undefined);
  check('E arkiverar det valda mejlet', (await win.locator('.row-subject', { hasText: target }).count()) === 0, target);

  // Del 1 i 0.5: flera mejl på en gång, och ångra.
  {
    const clearToast = async () => {
      if (await win.locator('.toast').count()) await win.locator('.toast span').first().click().catch(() => undefined);
      await win.waitForSelector('.toast', { state: 'detached', timeout: 10000 }).catch(() => undefined);
    };
    await clearToast();
    // Två mejl i Nordljus-kontot (testkontot för Gmail saknar arkivmapp).
    const rowsNow = win.locator('.row').filter({ has: win.locator('.row-account', { hasText: /^Nordljus$/ }) });
    await rowsNow.nth(0).click();
    await rowsNow.nth(1).click({ modifiers: ['Control'] });
    await win.waitForSelector('.bulk-panel', { timeout: 5000 }).catch(() => undefined);
    check('Ctrl-klick markerar flera mejl', (await win.locator('.bulk-count').textContent().catch(() => '')) === '2 mejl markerade');
    const subjects = await win.locator('.row.checked .row-subject').allTextContents();
    await shot(win, 'flera-markerade.png');
    await win.click('#bulk-archive');
    await win.waitForSelector('.toast:has-text("2 mejl arkiverade") .toast-action', { timeout: 15000 }).catch(() => undefined);
    const bulkToast = await win.locator('.toast').textContent();
    check('Flera mejl arkiveras på en gång', bulkToast.includes('2 mejl arkiverade'), bulkToast);
    const present = (s) => s.every((t) => [...document.querySelectorAll('.row-subject')].some((e) => e.textContent === t));
    await win.click('.toast:has-text("2 mejl arkiverade") .toast-action');
    await win.waitForFunction(present, subjects, { timeout: 20000 }).catch(() => undefined);
    check('Ångra lägger tillbaka båda mejlen', await win.evaluate(present, subjects), subjects.join(', '));
    await clearToast();
    await rowsNow.nth(0).click();
    const one = await win.locator('.row.selected .row-subject').textContent();
    await win.keyboard.press('e');
    await win.waitForFunction((t) => ![...document.querySelectorAll('.row-subject')].some((e) => e.textContent === t), one, { timeout: 10000 }).catch(() => undefined);
    await win.keyboard.press('Control+z');
    await win.waitForFunction((t) => [...document.querySelectorAll('.row-subject')].some((e) => e.textContent === t), one, { timeout: 20000 }).catch(() => undefined);
    check('Ctrl+Z ångrar senaste arkiveringen', (await win.locator('.row-subject', { hasText: one }).count()) >= 1, one);
    await win.locator('.row').nth(0).click();
    await win.keyboard.press('Shift+ArrowDown');
    await win.waitForSelector('.bulk-panel', { timeout: 5000 }).catch(() => undefined);
    check('Skift+pil markerar flera', (await win.locator('.row.checked').count()) === 2);
    await win.keyboard.press('Escape');
    await win.waitForSelector('.bulk-panel', { state: 'detached', timeout: 5000 }).catch(() => undefined);
    check('Esc avmarkerar', (await win.locator('.bulk-panel').count()) === 0);
  }

  // Fas 4: kontoinställningar och statusvy.
  await win.locator('.account-name', { hasText: 'Nordljus' }).click();
  await win.waitForSelector('.status-box');
  check('Statusvyn visar senaste synk', /Senast synkad i dag/.test(await win.locator('.status-sub').textContent()));
  await win.locator('.color-swatch').nth(3).click();
  await win.locator('.check', { hasText: 'Aviseringar för nya mejl' }).locator('input').uncheck();
  const sigSelect = win.locator('select[aria-label="Signatur"]');
  check('Kontot visar vald signatur med förhandsvisning', (await sigSelect.locator('option:checked').textContent()) !== 'Ingen' && (await win.locator('.account-modal .signature-preview').count()) === 1);
  await shot(win, 'kontoinstallningar.png');
  await sigSelect.selectOption('');
  await win.click('.modal-foot .btn.primary');
  await win.waitForSelector('.modal', { state: 'detached', timeout: 20000 });
  const savedCfg = await win.evaluate(async (email) => (await window.api.state()).accounts.find((a) => a.email === email), nordljus);
  check('Färg och aviseringar sparas per konto', savedCfg.color === '#a56cf0' && savedCfg.notify === false, `${savedCfg.color} ${savedCfg.notify}`);
  check('Ingen signatur går att välja per konto', savedCfg.signatureId === '' && !savedCfg.signature);

  await openManual(win);
  await win.fill('input[placeholder="namn@exempel.se"]', `trasig.${run}@nordljus.test`);
  await win.fill('input[type=password]', 'test');
  await win.fill('input[placeholder="Jobb"]', 'Trasigt');
  const rowsBad = win.locator('.server-row');
  await rowsBad.nth(0).locator('input.grow').fill(HOST);
  await rowsBad.nth(0).locator('input.port').fill('3999');
  await rowsBad.nth(0).locator('select').selectOption('none');
  await rowsBad.nth(1).locator('input.grow').fill(HOST);
  await rowsBad.nth(1).locator('input.port').fill('3025');
  await rowsBad.nth(1).locator('select').selectOption('none');
  await win.click('.modal-foot .btn.primary');
  await win.waitForSelector('text=Spara ändå', { timeout: 20000 });
  check('Felet visas i klartext vid test', /vägrade anslutningen/.test(await win.locator('.form-errors').textContent()));
  await win.click('text=Spara ändå');
  await win.waitForSelector('.modal', { state: 'detached' });
  await win.waitForSelector('.account-error', { timeout: 20000 });
  check('Sidopanelen visar fel med Försök igen', (await win.locator('.account-error button:has-text("Försök igen")').count()) === 1);
  await shot(win, 'kontostatus.png');
  await win.locator('.account-name', { hasText: 'Trasigt' }).click();
  await win.waitForSelector('.status-box.error');
  check('Kontodialogen visar felet och Försök igen', (await win.locator('.status-box button:has-text("Försök igen")').count()) === 1);
  await win.click('text=Ta bort konto');
  await win.click('text=Ta bort på riktigt');
  await win.waitForSelector('.modal', { state: 'detached' });
  check('Kontot kan tas bort', (await win.locator('.account-name', { hasText: 'Trasigt' }).count()) === 0);

  // Fas 6: påminnelser, uppföljning, utskrift, märke och systemfält.
  await win.click('.nav-item:has-text("Alla inkorgar")');
  await win.waitForSelector('.row:has-text("Din domän nordljus.se")');
  await win.click('.row:has-text("Din domän nordljus.se")');
  await win.waitForSelector('.html-frame');
  await win.click('button[aria-label="Påminn mig"]');
  await win.waitForSelector('.pop-menu');
  await shot(win, 'paminn-mig.png');
  await win.click('.pop-item:has-text("I morgon")');
  await win.waitForFunction(() => ![...document.querySelectorAll('.row-subject')].some((e) => e.textContent.includes('Din domän nordljus.se')), null, { timeout: 10000 }).catch(() => undefined);
  check('Påminn mig döljer mejlet i inkorgen', (await win.locator('.row', { hasText: 'Din domän nordljus.se' }).count()) === 0);
  await win.click('.nav-item:has-text("Påminnelser")');
  await win.waitForSelector('.row:has-text("Din domän nordljus.se")');
  check('Mejlet syns under Påminnelser med tid', /Visas igen i morgon 08:00/.test(await win.locator('.row', { hasText: 'Din domän nordljus.se' }).locator('.row-reminder').textContent()));
  await shot(win, 'paminnelser.png');

  // Kort påminnelse: mejlet kommer tillbaka som oläst och en avisering visas.
  const before6 = await app.evaluate(() => globalThis.__mrmailReminders ?? 0);
  const snoozeId = await win.evaluate(async () => {
    const list = await window.api.list({ kind: 'reminders' }, 50);
    const m = list.items.find((x) => x.subject.includes('Din domän'));
    await window.api.remind(m.id, 'snooze', Date.now() + 1500);
    return m.id;
  });
  await win.click('.nav-item:has-text("Alla inkorgar")');
  await win.waitForSelector('.row:has-text("Din domän nordljus.se").unread', { timeout: 15000 }).catch(() => undefined);
  check('Mejlet kommer tillbaka som oläst när tiden är inne', (await win.locator('.row.unread', { hasText: 'Din domän nordljus.se' }).count()) === 1, snoozeId);
  check('Påminnelsen visas som avisering', (await app.evaluate(() => globalThis.__mrmailReminders ?? 0)) > before6);

  // Följ upp om inget svar, vald i svarsfönstret.
  const p6 = app.waitForEvent('window');
  await win.click('button[aria-label="Nytt meddelande"]');
  const fc = await p6;
  await fc.waitForSelector('.editor');
  await fc.fill('#to', karin);
  await fc.fill('#subject', `Uppföljning ${run}`);
  await fc.locator('.editor').click();
  await fc.keyboard.type('Hej Karin, hann du titta på offerten?');
  await fc.selectOption('.follow-select', '3');
  const fcClosed = fc.waitForEvent('close', { timeout: 30000 });
  await fc.click('.btn.send');
  await fcClosed;
  const rem = await win.evaluate(async (s) => (await window.api.state()).reminders.find((r) => r.subject === s), `Uppföljning ${run}`);
  check('Följ upp om inget svar sparas vid sändning', !!rem && rem.kind === 'followup' && rem.due > Date.now() + 2.9 * 86400000);

  // Spara som PDF.
  const pdfPath = join(tmp, 'mejl.pdf');
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, pdfPath);
  await win.click('.row:has-text("Middag på söndag")');
  await win.waitForSelector('.text-body');
  await win.click('button[aria-label="Skriv ut eller spara som PDF"]');
  await win.click('.pop-item:has-text("Spara som PDF")');
  const pdfOk = await waitUntil(async () => {
    try {
      return readFileSync(pdfPath).subarray(0, 5).toString() === '%PDF-';
    } catch {
      return false;
    }
  }, 20000);
  check('Spara som PDF skriver en PDF-fil', !!pdfOk);

  // Del 2: AI-verktyg via MCP, som Claude Code och Zed använder.
  {
    const mcp = mcpClient(join(tmp, 'flode'));
    try {
      const init = await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
      const tools = await mcp.rpc('tools/list');
      check('MCP-servern startar och listar verktygen', init.result?.serverInfo?.name === 'mr-mail' && tools.result?.tools?.length >= 13, `${tools.result?.tools?.length} verktyg`);
      const konton = await mcp.tool('accounts');
      check('MCP: accounts visar kontona och skrivtonen', !konton.error && konton.text.includes(nordljus) && konton.text.includes('writing_tone'));
      const hits = await mcp.tool('search_emails', { query: 'från:karin Demo' });
      const demo = hits.error ? null : JSON.parse(hits.text).find((m) => m.subject.includes('Demo av Nordljus'));
      check('MCP: sök hittar mejlet', !!demo, hits.text.slice(0, 80));
      const read = await mcp.tool('read_email', { id: demo?.id });
      check('MCP: läs ger hela texten', read.text.includes('mässan i Göteborg'));
      const winsBefore = app.windows().length;
      const utkast = await mcp.tool('skriv_utkast', { svar_pa: demo?.id, text: 'Hej Karin!\n\nTisdag klockan 14 passar fint.\n\nVänliga hälsningar,\nAlex' });
      const draftId = utkast.text.match(/Id: (\S+)/)?.[1];
      check('MCP: utkast sparas i Utkast och får ett id', !utkast.error && !!draftId && !!(await imapFetchLatest(nordljus, 'Drafts', 'Re: Demo av Nordljus')), utkast.text.split('\n')[0]);
      const opened = await waitUntil(async () => app.windows().length > winsBefore, 8000);
      check('MCP: utkastet öppnas i appen', !!opened);
      if (opened) {
        const cw = app.windows()[app.windows().length - 1];
        await cw.waitForSelector('.editor');
        check('MCP: utkastet har svaret och citatet', (await cw.locator('.editor').innerText()).includes('Tisdag klockan 14'));
        await shot(cw, 'mcp-utkast.png');
        await cw.close();
      }
      const sendDraft = await mcp.tool('send_draft', { id: draftId });
      const got = await imapFetchLatest(karin, 'INBOX', 'Re: Demo av Nordljus', 20000);
      check('MCP: send_draft skickar svaret', !sendDraft.error && !!got && got.includes('In-Reply-To'), sendDraft.text.split('\n')[0]);
      check('MCP: utkastet tas bort när det skickats', (await waitUntil(async () => (await imapCount(nordljus, 'Drafts', 'Re: Demo av Nordljus')) === 0, 10000)) === true);
      const direct = await mcp.tool('send_email', { account: nordljus, to: karin, subject: `Direkt ${run}`, text: 'Hej Karin, här kommer offerten i morgon.' });
      const got2 = await imapFetchLatest(karin, 'INBOX', `Direkt ${run}`, 20000);
      check('MCP: send_email skickar direkt med signatur', !direct.error && !!got2, direct.text.split('\n')[0]);
      const ci = JSON.parse((await mcp.tool('list_emails', { account: gmail })).text).find((m) => m.subject.includes('CI gick igenom'));
      const arch = await mcp.tool('archive', { ids: [ci?.id] });
      check('MCP: arkivera flyttar mejlet', !arch.error && !!(await imapFetchLatest(gmail, 'Archive', 'CI gick igenom')), arch.text);
      const bad = await mcp.tool('send_email', { account: nordljus, text: 'Ingen mottagare' });
      check('MCP: fel returneras som fel', bad.error === true && bad.text.includes('Recipient'));
    } finally {
      mcp.close();
    }
  }

  // Del 1: ljust, mörkt eller som Windows.
  {
    await win.click('button[aria-label="Inställningar"]');
    await win.waitForSelector('#theme-choice');
    await win.click('#theme-choice button:has-text("Mörkt")');
    await win.click('.modal-foot .btn.primary');
    await win.waitForSelector('.modal', { state: 'detached' });
    check('Mörkt läge kan väljas i inställningarna', (await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)) === 'dark');
    await win.click('button[aria-label="Inställningar"]');
    await win.click('#theme-choice button:has-text("Ljust")');
    await win.locator('#agent-tools').scrollIntoViewIfNeeded();
    await shot(win, 'installningar-ai-verktyg.png');
    await win.locator('#theme-choice').scrollIntoViewIfNeeded();
    await win.waitForTimeout(200);
    await shot(win, 'installningar-utseende.png');
    await win.click('.modal-foot .btn.primary');
    await win.waitForSelector('.modal', { state: 'detached' });
    check('Ljust läge gäller oavsett Windows', (await app.evaluate(({ nativeTheme }) => [nativeTheme.themeSource, nativeTheme.shouldUseDarkColors].join())) === 'light,false');
  }

  // Del 3: Städa.
  {
    const shop = `nyheter.${run}@butiken.test`;
    const club = `klubben.${run}@butiken.test`;
    const unsubBox = `avreg.${run}@butiken.test`;
    for (let i = 1; i <= 3; i++) await newsletter(shop, nordljus, `Veckans rea ${i}`, `<${unsubUrl}?u=${run}>`, true);
    await newsletter(club, nordljus, 'Klubbnytt 1', `<mailto:${unsubBox}?subject=avsluta>`, false);
    await win.waitForSelector('.row:has-text("Klubbnytt 1")', { timeout: 20000 });

    // Smart inkorg.
    await win.evaluate(() => window.api.saveSettings({ smartInbox: true }));
    await win.waitForSelector('.inbox-tabs', { timeout: 10000 });
    await win.click('.inbox-tab[data-tab="personal"]');
    await win.waitForSelector('.row:has-text("Klubbnytt 1")', { state: 'detached', timeout: 5000 }).catch(() => undefined);
    check(
      'Smart inkorg: nyhetsbrev syns inte bland personliga',
      (await win.locator('.row', { hasText: 'Veckans rea' }).count()) === 0 && (await win.locator('.row', { hasText: 'Klubbnytt' }).count()) === 0 && (await win.locator('.row').count()) >= 1
    );
    await shot(win, 'smart-inkorg.png');
    await win.click('.inbox-tab[data-tab="newsletter"]');
    await win.waitForSelector('.row:has-text("Veckans rea 1")', { timeout: 5000 }).catch(() => undefined);
    check(
      'Smart inkorg: nyhetsbrev under Nyhetsbrev',
      (await win.locator('.row', { hasText: 'Veckans rea' }).count()) === 3 && (await win.locator('.row', { hasText: 'Demo av Nordljus' }).count()) === 0
    );
    check('Fliken visar antal olästa', Number(await win.locator('.inbox-tab[data-tab="newsletter"] .tab-count').textContent()) >= 4);
    await win.click('.inbox-tab[data-tab="all"]');
    await win.evaluate(() => window.api.saveSettings({ smartInbox: false }));
    await win.waitForSelector('.inbox-tabs', { state: 'detached', timeout: 10000 });
    await win.click('#nav-clean');
    await win.waitForSelector(`.clean-row[data-address="${shop}"]`, { timeout: 10000 });
    const shopRow = win.locator(`.clean-row[data-address="${shop}"]`);
    check('Städa visar avsändaren med antal och kategori', (await shopRow.locator('.clean-stats strong').textContent()) === '3 mejl' && (await shopRow.locator('.clean-tag').first().textContent()) === 'Nyhetsbrev');
    check('Personliga avsändare hamnar under Personligt', (await win.locator(`.clean-row[data-address="${karin}"] .clean-tag`).first().textContent()) === 'Personligt');
    const gmailId = (await win.evaluate(() => window.api.state())).accounts.find((a) => a.name === 'Gmail').id;
    await win.selectOption('#clean-account', gmailId);
    await win.waitForSelector(`.clean-row[data-address="${shop}"]`, { state: 'detached', timeout: 10000 });
    check('Städa kan visas för ett konto i taget', (await win.locator('.clean-row[data-address="mamma@familj.test"]').count()) === 1);
    await win.selectOption('#clean-account', '');
    await win.waitForSelector(`.clean-row[data-address="${shop}"]`, { timeout: 10000 });
    await shot(win, 'stada.png');
    await win.click('.clean-filter:has-text("Nyhetsbrev")');
    check('Filtret visar bara nyhetsbrev', (await win.locator('.clean-row').count()) === 2, String(await win.locator('.clean-row').count()));
    await shopRow.locator('button:has-text("Avregistrera")').click();
    await win.waitForSelector(`.clean-row[data-address="${shop}"] .tag-done`, { timeout: 15000 });
    const call = unsubCalls.find((c) => c.url.includes(run));
    check('Avregistrera skickar ett-klicks-anropet', call?.method === 'POST' && call.body === 'List-Unsubscribe=One-Click', JSON.stringify(call));
    const clubRow = win.locator(`.clean-row[data-address="${club}"]`);
    await clubRow.locator('button:has-text("Avregistrera")').click();
    check('Avregistrera via mejl när det bara finns mailto', !!(await imapFetchLatest(unsubBox, 'INBOX', 'avsluta', 20000)));
    await shopRow.locator('button[aria-label^="Radera alla"]').click();
    await shot(win, 'stada-radera.png');
    await shopRow.locator('.btn.danger').click();
    const trashed = await waitUntil(async () => (await imapCount(nordljus, 'Trash', 'Veckans rea')) === 3, 20000);
    check('Radera alla flyttar allt från avsändaren på servern', !!trashed);
    await clubRow.locator('.more-btn').click();
    await win.click('.pop-item:has-text("Arkivera alltid")');
    await win.waitForSelector(`.clean-row[data-address="${club}"] .tag-rule`, { timeout: 15000 });
    check('Regeln arkiverar befintliga mejl', !!(await imapFetchLatest(nordljus, 'Archive', 'Klubbnytt 1', 15000)));
    await newsletter(club, nordljus, 'Klubbnytt 2', `<mailto:${unsubBox}>`, false);
    check('Regeln arkiverar nya mejl automatiskt', !!(await imapFetchLatest(nordljus, 'Archive', 'Klubbnytt 2', 25000)));
    await win.click('.clean-filter:has-text("Alla")');
    await win.emulateMedia({ colorScheme: 'dark' });
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark';
    });
    await shot(win, 'stada-morkt.png');
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'light';
    });
    await win.emulateMedia({ colorScheme: 'light' });
    await win.click('.nav-item:has-text("Alla inkorgar")');
    await win.waitForSelector('.list-pane');
  }

  // Del 4: ångra skicka och skicka senare.
  {
    await win.evaluate(() => window.api.saveSettings({ undoSendSeconds: 4 }));
    const pu = app.waitForEvent('window');
    await win.click('button[aria-label="Nytt meddelande"]');
    const cu = await pu;
    await cu.waitForSelector('.editor');
    await cu.fill('#to', karin);
    await cu.fill('#subject', `Ångra ${run}`);
    await cu.locator('.editor').click();
    await cu.keyboard.type('Det här ska inte iväg.');
    await cu.click('.btn.send');
    await win.waitForSelector('.undo-send', { timeout: 10000 });
    await shot(win, 'angra-skicka.png');
    const reopen = app.waitForEvent('window');
    await win.click('.undo-btn:has-text("Ångra")');
    const back = await reopen;
    await back.waitForSelector('.editor');
    await back.waitForFunction(() => document.querySelector('.editor')?.innerText.includes('Det här ska inte iväg'), null, { timeout: 15000 });
    check('Ångra öppnar mejlet igen med texten kvar', true);
    await new Promise((r) => setTimeout(r, 5000));
    check('Ett ångrat mejl skickas inte', (await imapCount(karin, 'INBOX', `Ångra ${run}`)) === 0);
    const backClosed = back.waitForEvent('close', { timeout: 15000 });
    await back.click('.btn.send');
    await backClosed;
    check('Mejlet skickas när tiden gått ut', !!(await imapFetchLatest(karin, 'INBOX', `Ångra ${run}`, 20000)));

    const pl = app.waitForEvent('window');
    await win.click('button[aria-label="Nytt meddelande"]');
    const cl = await pl;
    await cl.waitForSelector('.editor');
    await cl.fill('#to', karin);
    await cl.fill('#subject', `Senare ${run}`);
    await cl.locator('.editor').click();
    await cl.keyboard.type('Skickas i morgon bitti.');
    await cl.click('.send-later');
    await cl.waitForSelector('.pop-menu');
    await shot(cl, 'skicka-senare.png');
    const clClosed = cl.waitForEvent('close', { timeout: 15000 });
    await cl.click('.pop-item:has-text("I morgon")');
    await clClosed;
    await win.waitForSelector('#nav-outbox', { timeout: 10000 });
    check('Schemalagt mejl visas under Skickas senare', (await win.locator('#nav-outbox .count').textContent()) === '1');
    await win.click('#nav-outbox');
    await win.waitForSelector('.outbox-row');
    check('Listan visar tiden', /i morgon 08:00/.test(await win.locator('.outbox-when').textContent()));
    await shot(win, 'skickas-senare.png');
    check('Schemalagt mejl skickas inte direkt', (await imapCount(karin, 'INBOX', `Senare ${run}`)) === 0);
    await win.click('.outbox-row .btn.primary');
    check('Skicka nu skickar det schemalagda mejlet', !!(await imapFetchLatest(karin, 'INBOX', `Senare ${run}`, 20000)));
    await win.waitForSelector('#nav-outbox', { state: 'detached', timeout: 10000 });
    await win.evaluate(() => window.api.saveSettings({ undoSendSeconds: 0 }));
  }

  // Mallar i svarsfönstret.
  {
    const pt = app.waitForEvent('window');
    await win.click('button[aria-label="Nytt meddelande"]');
    const ct = await pt;
    await ct.waitForSelector('.editor');
    await ct.fill('#to', karin);
    await ct.locator('.editor').click();
    await ct.keyboard.press('Control+Home');
    await ct.keyboard.type('Hej! Tack för ditt mejl, jag återkommer i veckan.');
    await ct.click('.templates-btn');
    await ct.click('.pop-item:has-text("Spara texten som mall")');
    await ct.fill('#template-name', 'Återkommer');
    await ct.click('#template-save');
    await ct.waitForSelector('#template-name', { state: 'detached' });
    const saved = (await win.evaluate(() => window.api.state())).settings.templates;
    check('Texten sparas som mall utan signaturen', saved.length === 1 && saved[0].name === 'Återkommer' && saved[0].text === 'Hej! Tack för ditt mejl, jag återkommer i veckan.', JSON.stringify(saved));
    await ct.evaluate(() => {
      const ed = document.querySelector('.editor');
      ed.innerHTML = '<div><br></div>';
    });
    await ct.locator('.editor').click();
    await ct.click('.templates-btn');
    await ct.waitForSelector('.pop-menu');
    await shot(ct, 'mallar.png');
    await ct.click('.pop-item:has-text("Återkommer") >> nth=0');
    await ct.waitForFunction(() => document.querySelector('.editor')?.innerText.includes('jag återkommer i veckan'), null, { timeout: 5000 }).catch(() => undefined);
    check('Mallen infogas i mejlet', (await ct.locator('.editor').innerText()).includes('jag återkommer i veckan'));
    const ctClosed = ct.waitForEvent('close', { timeout: 10000 }).catch(() => undefined);
    await ct.click('button[aria-label="Släng utkastet"]').catch(() => undefined);
    await ctClosed;
  }

  // Uppdatering från mappen med installationsfiler.
  {
    const dir = join(tmp, 'uppdatering');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MrMail-Setup-99.0.0.exe'), 'x');
    writeFileSync(join(dir, 'MrMail-Setup-0.0.1.exe'), 'x');
    await win.evaluate((d) => window.api.saveSettings({ updateDir: d }), dir);
    await win.evaluate(() => window.api.updateCheck());
    await win.waitForSelector('.update-banner', { timeout: 10000 }).catch(() => undefined);
    check('Ny version visas i appen', ((await win.locator('.update-banner').textContent().catch(() => '')) ?? '').includes('99.0.0'));
    await shot(win, 'uppdatering.png');
    await win.click('#update-install');
    await waitUntil(async () => !!(await app.evaluate(() => globalThis.__mrmailUpdateRun)), 5000);
    check('Installera startar den nya installationsfilen', ((await app.evaluate(() => globalThis.__mrmailUpdateRun)) ?? '').endsWith('MrMail-Setup-99.0.0.exe'));
    await win.evaluate(() => window.api.saveSettings({ updateDir: '' }));
  }

  // Märke i aktivitetsfältet och systemfältet.
  const unreadNow = await win.evaluate(async () => (await window.api.state()).statuses.reduce((n, s) => n + s.unread, 0));
  await waitUntil(async () => (await app.evaluate(() => globalThis.__mrmailBadge)) === unreadNow, 5000);
  check('Märket i aktivitetsfältet visar antal olästa', (await app.evaluate(() => globalThis.__mrmailBadge)) === unreadNow, String(unreadNow));
  check('Ikonen finns i systemfältet', await app.evaluate(() => globalThis.__mrmailTray === true));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await new Promise((r) => setTimeout(r, 500));
  const hidden = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()));
  check('Stäng gömmer fönstret i systemfältet', hidden.length >= 1 && hidden[0] === false, JSON.stringify(hidden));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await app.close();
  app = null;

  // 3. Prestanda: 10 000 mejl i cachen, listan ska rulla jämnt.
  {
    const dir = join(tmp, 'prestanda');
    const boot = await launch(dir, { MRMAIL_NO_SEED: '1' });
    await boot.app.close();
    const db = new DatabaseSync(join(dir, 'brevlada.db'));
    const cfg = { id: 'perf', name: 'Arkivet', email: 'perf@nordljus.test', displayName: 'Alex', provider: 'manual', imap: { host: '127.0.0.1', port: 1, security: 'none' }, smtp: { host: '127.0.0.1', port: 1, security: 'none' }, username: 'perf', color: '#4f7cff' };
    db.prepare('INSERT INTO accounts (id, position, config) VALUES (?, 0, ?)').run('perf', JSON.stringify(cfg));
    db.prepare("INSERT INTO folders (account_id, path, name, role, parent) VALUES ('perf', 'INBOX', 'Inkorg', 'inbox', '')").run();
    const ins = db.prepare(
      `INSERT INTO messages (id, account_id, folder, uid, uid_validity, subject, from_name, from_addr, recipients, date, preview, seen, flagged, answered, has_attachments, message_id, labels, thread_id)
       VALUES (?, 'perf', 'INBOX', ?, 1, ?, ?, ?, '{"to":[],"cc":[]}', ?, ?, ?, 0, 0, 0, ?, '[]', ?)`
    );
    db.exec('BEGIN');
    for (let i = 0; i < 10000; i++) {
      const mid = `<p${i}@nordljus.test>`;
      ins.run(`perf|INBOX|1|${i + 1}`, i + 1, `Mejl nummer ${i}`, `Avsändare ${i % 97}`, `a${i % 97}@nordljus.test`, now - i * 600000, `Förhandsvisning av mejl ${i} med lite text som fyller två rader i listan.`, i % 3 ? 1 : 0, mid, mid);
    }
    db.exec('COMMIT');
    db.close();
    const perf = await launch(dir, { MRMAIL_NO_SEED: '1' });
    app = perf.app;
    const pw = perf.win;
    await pw.waitForSelector('.row');
    const t0 = Date.now();
    // Rulla ned genom listan: 300 bildrutor med 300 pixlar var, och mät tiden mellan bildrutorna.
    const stats = await pw.evaluate(async () => {
      const list = document.querySelector('.list');
      const frames = [];
      let last = performance.now();
      let maxRows = 0;
      for (let i = 0; i < 300; i++) {
        list.scrollTop += 300;
        await new Promise((r) => requestAnimationFrame(r));
        const t = performance.now();
        frames.push(t - last);
        last = t;
        maxRows = Math.max(maxRows, document.querySelectorAll('.list .row').length);
      }
      frames.sort((a, b) => a - b);
      return { p95: frames[Math.floor(frames.length * 0.95)], median: frames[Math.floor(frames.length / 2)], maxRows, total: list.scrollHeight };
    });
    const loaded = await pw.evaluate(async () => (await window.api.list({ kind: 'unified', role: 'inbox' }, 20000)).items.length);
    check('Cachen har 10 000 mejl', loaded === 10000, String(loaded));
    check('Listan ritar bara synliga rader (virtualiserad)', stats.maxRows < 80, `${stats.maxRows} rader i DOM`);
    check('Listan rullar jämnt', stats.p95 < 34, `median ${stats.median.toFixed(1)} ms, p95 ${stats.p95.toFixed(1)} ms per bildruta, ${Date.now() - t0} ms totalt`);
    await shot(pw, 'prestanda-10000.png');
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => undefined);
  smtp.close();
  ispdb.close();
  fakeGoogle.close();
  fakeOpenAi.close();
  fakeUnsub.close();
  rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} av ${results.length} kontroller gick igenom.`);
}
