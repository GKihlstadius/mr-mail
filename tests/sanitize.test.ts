import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildFrameDocument, createSanitizer, escapeHtml, textToHtml } from '../src/shared/sanitize';

const { window } = new JSDOM('');
const sanitize = createSanitizer(window as any);

describe('sanering av HTML-mejl', () => {
  it('tar bort skript, händelseattribut och farliga taggar', () => {
    const { html } = sanitize(
      '<p onclick="alert(1)">Hej</p><script>alert(1)</script><iframe src="https://x"></iframe>' +
        '<form action="https://x"><input></form><a href="javascript:alert(1)">x</a><object data="x"></object>' +
        '<meta http-equiv="refresh" content="0;url=https://x"><svg><script>alert(1)</script></svg>',
      { allowRemote: false }
    );
    expect(html).toContain('<p>Hej</p>');
    expect(html).not.toMatch(/script|onclick|iframe|<form|<input|javascript:|<object|<meta/i);
  });

  it('blockerar fjärrbilder som standard och räknar dem', () => {
    const res = sanitize(
      '<img src="https://track.se/p.gif"><img src="//cdn.se/a.png" alt="logga"><div style="background-image:url(https://x.se/bg.png)">x</div>',
      { allowRemote: false }
    );
    expect(res.blocked).toBe(3);
    expect(res.html).not.toMatch(/ src="https?:| src="\/\//);
    expect(res.html).toContain('data-blocked-src="https://track.se/p.gif"');
    expect(res.html).not.toContain('bg.png');
  });

  it('visar fjärrbilder när användaren tillåter det', () => {
    const res = sanitize('<img src="https://cdn.se/a.png">', { allowRemote: true });
    expect(res.blocked).toBe(0);
    expect(res.html).toContain('src="https://cdn.se/a.png"');
  });

  it('ersätter cid-bilder med inbäddade data', () => {
    const res = sanitize('<img src="cid:logo@x"><img src="cid:saknas">', {
      allowRemote: false,
      inlineImages: { 'logo@x': 'data:image/png;base64,AAA' }
    });
    expect(res.html).toContain('src="data:image/png;base64,AAA"');
    expect(res.html).not.toContain('cid:saknas');
  });

  it('rensar @import och url() i stilblock men behåller resten', () => {
    const res = sanitize(
      '<html><head><style>@import url(https://x.se/a.css); .a{color:red;background:url("https://x.se/b.png")}</style></head><body><p class="a">x</p></body></html>',
      { allowRemote: false }
    );
    expect(res.html).toContain('color:red');
    expect(res.html).not.toContain('@import');
    expect(res.html).not.toContain('b.png');
  });

  it('gör länkar säkra och öppnar dem utanför appen', () => {
    const res = sanitize('<a href="https://nordljus.se">Nordljus</a><a href="file:///C:/x">fil</a>', { allowRemote: false });
    expect(res.html).toContain('target="_blank"');
    expect(res.html).toContain('rel="noopener noreferrer"');
    expect(res.html).not.toContain('file:');
  });

  it('lägger in en strikt CSP i ramdokumentet', () => {
    const doc = buildFrameDocument('<html><head></head><body>x</body></html>', { allowRemote: false, dark: false });
    expect(doc).toContain('img-src data:;');
    expect(doc).toContain("default-src 'none'");
    const open = buildFrameDocument('<p>x</p>', { allowRemote: true, dark: false });
    expect(open).toContain('img-src data: https: http:');
  });

  it('gör om vanlig text till säker HTML med citat och länkar', () => {
    const html = textToHtml('Hej <b>du</b>\nSe https://nordljus.se.\n> citat\n>> djupare');
    expect(html).toContain('&lt;b&gt;du&lt;/b&gt;');
    expect(html).toContain('<a href="https://nordljus.se">https://nordljus.se</a>.');
    expect((html.match(/<blockquote>/g) ?? []).length).toBe(2);
    expect(escapeHtml('"\'&')).toBe('&quot;&#39;&amp;');
  });
});
