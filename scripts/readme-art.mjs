// Bilder till README: banner, AI-flödet och bildrutor till demon.
// Kör efter scripts/screenshots.mjs: node scripts/readme-art.mjs, sedan python scripts/demo-gif.py
import { chromium } from 'playwright-core';
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const shots = join(root, 'docs', 'screenshots');
const frames = join(root, 'release', 'demo-frames');
const img = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;
const icon = img(join(root, 'build', 'icon-1024.png'));
const chrome = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find((p) => p && existsSync(p));

const base = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif; color: #f4f1e8; overflow: hidden;
    background: radial-gradient(1200px 700px at 12% 18%, #22356b 0%, transparent 60%),
                radial-gradient(900px 600px at 95% 110%, #6b4a10 0%, transparent 60%), #0a1122; }
  .grain { position: absolute; inset: 0; background-image: radial-gradient(rgba(255,255,255,.035) 1px, transparent 1px); background-size: 4px 4px; }
  .window { border-radius: 14px; overflow: hidden; background: #fff;
    box-shadow: 0 0 0 1px rgba(255,255,255,.08), 0 30px 80px rgba(0,0,0,.55), 0 8px 24px rgba(0,0,0,.35); }
  .bar { height: 30px; background: #eceef2; display: flex; align-items: center; gap: 7px; padding: 0 12px; }
  .bar i { width: 11px; height: 11px; border-radius: 50%; background: #d4d7dd; display: block; }
  .window img { display: block; width: 100%; }
  .pill { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 999px;
    background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.14); font-size: 18px; color: #e9e4d6; }
  .pill b { color: #f2c14e; font-weight: 600; }
`;

const banner = (w, h) => `<style>${base}
  .wrap { position: relative; width: ${w}px; height: ${h}px; }
  .left { position: absolute; left: 72px; top: 50%; transform: translateY(-50%); width: 560px; }
  .logo { width: 132px; height: 132px; border-radius: 30px; box-shadow: 0 18px 40px rgba(0,0,0,.45); }
  h1 { font-size: 88px; font-weight: 700; letter-spacing: -2px; margin-top: 22px; line-height: 1; }
  h1 span { color: #f2c14e; }
  .tag { font-size: 30px; line-height: 1.3; margin-top: 18px; color: #fffaf0; font-weight: 600; }
  .sub { font-size: 20px; color: #b8bfd3; margin-top: 12px; }
  .pills { display: flex; gap: 10px; margin-top: 28px; flex-wrap: wrap; }
  .shot { position: absolute; left: ${w * 0.5}px; top: ${h * 0.14}px; width: ${w * 0.62}px;
    transform: perspective(1800px) rotateY(-16deg) rotateX(4deg); transform-origin: left center; }
</style>
<div class="wrap"><div class="grain"></div>
  <div class="shot window"><div class="bar"><i></i><i></i><i></i></div><img src="${img(join(shots, 'inbox.png'))}"></div>
  <div class="left">
    <img class="logo" src="${icon}">
    <h1>Mr <span>Mail</span></h1>
    <div class="tag">The email client your AI agent can drive.</div>
    <div class="sub">Fast, private and local first. Free for Windows.</div>
    <div class="pills"><span class="pill"><b>MCP</b> 28 tools</span><span class="pill"><b>Local</b> first</span><span class="pill"><b>MIT</b> open source</span></div>
  </div>
</div>`;

const agent = `<style>${base}
  .wrap { position: relative; width: 1600px; height: 820px; display: flex; align-items: center; gap: 56px; padding: 0 70px; }
  .term { width: 640px; border-radius: 14px; background: #0d1117; border: 1px solid rgba(255,255,255,.12);
    box-shadow: 0 30px 80px rgba(0,0,0,.55); font-family: 'Cascadia Code', Consolas, monospace; font-size: 19px; line-height: 1.6; }
  .term .bar { background: #161b22; } .term .bar i { background: #30363d; }
  .term .t { padding: 22px 26px 28px; color: #c9d1d9; white-space: pre-wrap; }
  .p { color: #f2c14e; } .d { color: #7d8590; } .k { color: #79c0ff; } .g { color: #7ee787; } .u { color: #fff; font-weight: 600; }
  .arrow { font-size: 64px; color: #f2c14e; }
  .right { width: 780px; }
  .cap { position: absolute; left: 70px; top: 54px; font-size: 34px; font-weight: 700; }
  .cap span { color: #f2c14e; }
  .note { position: absolute; left: 70px; bottom: 50px; font-size: 20px; color: #b8bfd3; }
</style>
<div class="wrap"><div class="grain"></div>
  <div class="cap">Ask in Claude Code or Zed. <span>Review in Mr Mail.</span></div>
  <div class="term"><div class="bar"><i></i><i></i><i></i></div><div class="t"><span class="p">&gt;</span> <span class="u">Karin wants a demo. Draft a reply
  saying Tuesday at 2 works.</span>

<span class="g">●</span> <span class="k">mr-mail</span> search_emails <span class="d">"Demo next week"</span>
  <span class="d">Karin Lund · Demo next week? · 1 hit</span>

<span class="g">●</span> <span class="k">mr-mail</span> draft_email <span class="d">reply_to: Karin</span>
  <span class="d">Draft saved and opened in Mr Mail.</span>

The draft is open in Mr Mail. Nothing
has been sent, so you can edit it first.</div></div>
  <div class="arrow">→</div>
  <div class="right window"><div class="bar"><i></i><i></i><i></i></div><img src="${img(join(shots, 'agent-draft.png'))}"></div>
  <div class="note">Agents never send unless you explicitly ask. Everything else becomes a draft.</div>
</div>`;

const frame = (file, caption) => `<style>${base}
  .wrap { position: relative; width: 1100px; height: 760px; display: flex; flex-direction: column; align-items: center; }
  .cap { margin-top: 26px; font-size: 26px; font-weight: 600; display: flex; align-items: center; gap: 12px; }
  .cap img { width: 34px; height: 34px; border-radius: 8px; }
  .window { margin-top: 22px; width: ${file.includes('05') ? 820 : 1000}px; }
</style>
<div class="wrap"><div class="grain"></div>
  <div class="cap"><img src="${icon}">${caption}</div>
  <div class="window"><div class="bar"><i></i><i></i><i></i></div><img src="${img(file)}"></div>
</div>`;

const browser = await chromium.launch({ executablePath: chrome });
const render = async (html, w, h, out) => {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.waitForTimeout(300);
  await page.screenshot({ path: out });
  await page.close();
  console.log(out.replace(root, '').slice(1));
};
try {
  await render(banner(1280, 640), 1280, 640, join(shots, 'banner.png'));
  await render(agent, 1600, 820, join(shots, 'agent.png'));
  if (existsSync(frames)) {
    const out = join(frames, 'cards');
    mkdirSync(out, { recursive: true });
    for (const f of readdirSync(frames).filter((n) => /^\d+\.png$/.test(n))) {
      const caption = readFileSync(join(frames, f.replace('.png', '.txt')), 'utf8');
      await render(frame(join(frames, f), caption), 1100, 760, join(out, f));
    }
  }
} finally {
  await browser.close();
}
