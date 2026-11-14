import createDOMPurify from 'dompurify';

export interface SanitizeOptions {
  allowRemote: boolean;
  inlineImages?: Record<string, string>;
  dark?: boolean;
}

export interface SanitizeResult {
  html: string;
  blocked: number;
}

const REMOTE_URL = /^\s*(https?:)?\/\//i;
const CSS_REMOTE = /url\(\s*(['"]?)\s*(?:https?:)?\/\/[^)]*\)/gi;
const CSS_IMPORT = /@import\s+[^;]+;?/gi;

const FORBID_TAGS = [
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'link', 'meta',
  'form', 'input', 'button', 'select', 'textarea', 'audio', 'video', 'source', 'track', 'portal'
];
const FORBID_ATTR = ['srcset', 'ping', 'formaction', 'action', 'background', 'poster', 'lowsrc', 'dynsrc'];

type WindowLike = Parameters<typeof createDOMPurify>[0];

export function createSanitizer(win: WindowLike) {
  const purify = createDOMPurify(win);

  return function sanitizeHtml(input: string, opts: SanitizeOptions): SanitizeResult {
    let blocked = 0;
    const inline = opts.inlineImages ?? {};

    const cleanCss = (css: string): string => {
      let out = css.replace(CSS_IMPORT, () => {
        blocked++;
        return '';
      });
      if (!opts.allowRemote) {
        out = out.replace(CSS_REMOTE, () => {
          blocked++;
          return 'none';
        });
      }
      out = out.replace(/expression\s*\(/gi, '(').replace(/javascript\s*:/gi, '');
      return out;
    };

    purify.addHook('uponSanitizeElement', (node: any, data: any) => {
      if (data.tagName === 'style' && node.textContent) node.textContent = cleanCss(node.textContent);
    });

    purify.addHook('afterSanitizeAttributes', (node: any) => {
      if (node.hasAttribute?.('style')) {
        node.setAttribute('style', cleanCss(node.getAttribute('style')));
      }
      if (node.tagName === 'IMG') {
        const src = node.getAttribute('src') ?? '';
        if (/^cid:/i.test(src)) {
          const cid = src.slice(4).replace(/^<|>$/g, '');
          if (inline[cid]) node.setAttribute('src', inline[cid]);
          else node.removeAttribute('src');
        } else if (REMOTE_URL.test(src)) {
          if (!opts.allowRemote) {
            blocked++;
            node.setAttribute('data-blocked-src', src);
            node.removeAttribute('src');
            node.setAttribute('alt', node.getAttribute('alt') ?? '');
          }
        } else if (!/^data:image\//i.test(src)) {
          node.removeAttribute('src');
        }
      }
      if (node.tagName === 'A') {
        const href = node.getAttribute('href') ?? '';
        if (href && !/^(https?:|mailto:|tel:|#)/i.test(href.trim())) node.removeAttribute('href');
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });

    try {
      const html = purify.sanitize(input, {
        WHOLE_DOCUMENT: true,
        FORBID_TAGS,
        FORBID_ATTR,
        ADD_TAGS: ['style'],
        ADD_ATTR: ['target'],
        ALLOW_UNKNOWN_PROTOCOLS: false
      }) as unknown as string;
      return { html, blocked };
    } finally {
      purify.removeAllHooks();
    }
  };
}

export function buildFrameDocument(sanitized: string, opts: { allowRemote: boolean; dark: boolean }): string {
  const img = opts.allowRemote ? 'data: https: http:' : 'data:';
  const csp = `default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; font-src data:${opts.allowRemote ? ' https:' : ''}`;
  const base = `<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
html{color-scheme:light}
body{margin:0;padding:24px 28px;font:15px/1.5 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;color:#1d1d1f;background:#fff;word-wrap:break-word;overflow-wrap:anywhere}
img{max-width:100%;height:auto}
img[data-blocked-src]{display:inline-block;min-width:1px;min-height:1px;background:#f2f2f4}
table{max-width:100%}
pre{white-space:pre-wrap}
blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:2px solid #d0d0d6;color:#555}
a{color:#0a66d9}
</style>`;
  if (/<head[^>]*>/i.test(sanitized)) return sanitized.replace(/<head[^>]*>/i, (m) => m + base);
  return `<!doctype html><html><head>${base}</head><body>${sanitized}</body></html>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function textToHtml(text: string): string {
  const escaped = escapeHtml(text.replace(/\r/g, ''));
  const linked = escaped.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)"']/g, (u) => `<a href="${u}">${u}</a>`);
  const lines = linked.split('\n');
  const out: string[] = [];
  let depth = 0;
  for (const raw of lines) {
    const m = raw.match(/^((?:&gt;\s?)+)/);
    const d = m ? (m[1].match(/&gt;/g) ?? []).length : 0;
    const line = m ? raw.slice(m[1].length) : raw;
    while (depth < d) {
      out.push('<blockquote>');
      depth++;
    }
    while (depth > d) {
      out.push('</blockquote>');
      depth--;
    }
    out.push(line + '<br>');
  }
  while (depth-- > 0) out.push('</blockquote>');
  return `<div style="white-space:pre-wrap;font-family:inherit">${out.join('')}</div>`.replace(/<br><\/div>$/, '</div>');
}
