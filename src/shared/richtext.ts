import { escapeHtml } from './sanitize';

// Hjälpare för rik text i svarsfönstret: signaturer, citat och textalternativ till HTML.

export const SIGNATURE_CLASS = 'brevlada-signature';
export const QUOTE_STYLE = 'margin:0 0 0 .8ex;padding-left:1.2ex;border-left:2px solid #0a66d9;color:#3a3a3c';

// HTML till ren text utan DOM, för signaturer och textdelen av mejl som byggs i huvudprocessen.
export function htmlToPlain(html: string): string {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d|blockquote|table)>/gi, '\n')
    .replace(/<\/td>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function looksLikeHtml(s: string): boolean {
  return /<\/?[a-z][a-z0-9]*[\s>/]/i.test(s);
}

// Gör om ren text till redigerarens radformat: en div per rad, tomma rader som <div><br></div>.
export function textToEditorHtml(text: string): string {
  const lines = text.replace(/\r/g, '').split('\n');
  return lines.map((l) => (l ? `<div>${linkify(escapeHtml(l))}</div>` : '<div><br></div>')).join('');
}

function linkify(escaped: string): string {
  return escaped.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)"']/g, (u) => `<a href="${u}">${u}</a>`);
}

export function signatureHtml(signature: string | undefined): string {
  const s = signature?.trim() ?? '';
  if (!s) return '';
  return looksLikeHtml(s) ? s : textToEditorHtml(s);
}

// Signaturblocket i redigeraren. Det byts ut när avsändarkontot ändras.
export function signatureBlock(signature: string | undefined): string {
  const inner = signatureHtml(signature);
  return inner ? `<div class="${SIGNATURE_CLASS}">${inner}</div>` : '';
}

export function quoteBlockHtml(header: string, bodyText: string): string {
  return `<div>${escapeHtml(header)}</div><blockquote type="cite" style="${QUOTE_STYLE}">${textToEditorHtml(bodyText.replace(/\r/g, '').trimEnd())}</blockquote>`;
}

// Hela HTML-delen som skickas: brödtext plus eventuellt citat, i ett enkelt dokument.
export function outgoingHtml(bodyHtml: string, quoteHtml: string): string {
  const quote = quoteHtml ? `<div><br></div>${quoteHtml}` : '';
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><div style="font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1d1d1f">${bodyHtml}${quote}</div></body></html>`;
}

interface NodeLike {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<NodeLike>;
  getAttribute?(name: string): string | null;
}

const BLOCK = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE', 'TR', 'SECTION', 'ARTICLE']);

// Textalternativ till HTML-delen. Listor får streck eller siffror, citat får >.
export function htmlToText(root: NodeLike): string {
  const out: string[] = [];
  let line = '';
  const flush = () => {
    out.push(line);
    line = '';
  };
  const walk = (node: NodeLike, ctx: { quote: number; list: string[] }) => {
    if (node.nodeType === 3) {
      line += (node.textContent ?? '').replace(/\s+/g, ' ');
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.nodeName.toUpperCase();
    if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'HEAD') return;
    if (tag === 'BR') {
      flush();
      return;
    }
    const block = BLOCK.has(tag);
    if (block && line.trim()) flush();
    let next = ctx;
    if (tag === 'BLOCKQUOTE') next = { ...ctx, quote: ctx.quote + 1 };
    if (tag === 'UL' || tag === 'OL') next = { ...ctx, list: [...ctx.list, tag] };
    const start = out.length;
    if (tag === 'LI') {
      const kind = ctx.list[ctx.list.length - 1];
      const index = kind === 'OL' ? countPrevLi(node) + 1 : 0;
      line += kind === 'OL' ? `${index}. ` : '- ';
    }
    const kids = Array.from(node.childNodes);
    for (const k of kids) walk(k, next);
    if (tag === 'A') {
      const href = node.getAttribute?.('href') ?? '';
      const text = node.textContent ?? '';
      if (href && /^https?:/i.test(href) && href !== text.trim()) line += ` (${href})`;
    }
    if (block && line) flush();
    if (block && kids.length === 0 && tag !== 'UL' && tag !== 'OL') flush();
    if (tag === 'BLOCKQUOTE') {
      for (let i = start; i < out.length; i++) out[i] = out[i].startsWith('>') ? `>${out[i]}` : `> ${out[i]}`;
    }
  };
  walk(root, { quote: 0, list: [] });
  if (line) flush();
  return out
    .map((l) => l.replace(/[ \t]+$/g, '').replace(/^ (?=\S)/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function countPrevLi(node: any): number {
  let n = 0;
  let prev = node.previousSibling;
  while (prev) {
    if (prev.nodeName?.toUpperCase() === 'LI') n++;
    prev = prev.previousSibling;
  }
  return n;
}
