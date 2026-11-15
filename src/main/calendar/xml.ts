// Liten XML-läsare för WebDAV-svar (multistatus). Namnrymder ignoreras, element matchas på lokalt namn.

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const local = (n: string) => n.slice(n.indexOf(':') + 1).toLowerCase();

export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[6] !== undefined) top.text += decodeEntities(m[6]);
    else if (m[3]) {
      const name = local(m[3]);
      if (m[2]) {
        const idx = stack.map((n) => n.name).lastIndexOf(name);
        if (idx > 0) stack.length = idx;
        continue;
      }
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[local(a[1])] = decodeEntities(a[2] ?? a[3] ?? '');
      const node: XmlNode = { name, attrs, children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    }
  }
  return root;
}

export function child(n: XmlNode | undefined, name: string): XmlNode | undefined {
  return n?.children.find((c) => c.name === name);
}

export function children(n: XmlNode | undefined, name: string): XmlNode[] {
  return n?.children.filter((c) => c.name === name) ?? [];
}

// Första elementet med namnet var som helst under noden.
export function find(n: XmlNode | undefined, name: string): XmlNode | undefined {
  if (!n) return undefined;
  for (const c of n.children) {
    if (c.name === name) return c;
    const hit = find(c, name);
    if (hit) return hit;
  }
  return undefined;
}

export function findAll(n: XmlNode | undefined, name: string, out: XmlNode[] = []): XmlNode[] {
  if (!n) return out;
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

export function textOf(n: XmlNode | undefined): string {
  if (!n) return '';
  return (n.text + n.children.map(textOf).join('')).trim();
}

// Svaren i ett multistatus, med egenskaperna från propstat med status 200.
export interface DavResponse {
  href: string;
  props: XmlNode;
}

export function multistatus(xml: string): DavResponse[] {
  const root = parseXml(xml);
  return findAll(root, 'response').map((r) => {
    const props: XmlNode = { name: 'prop', attrs: {}, children: [], text: '' };
    for (const ps of children(r, 'propstat')) {
      const status = textOf(child(ps, 'status'));
      if (status && !/\s2\d\d\s/.test(` ${status} `)) continue;
      for (const p of children(ps, 'prop')) props.children.push(...p.children);
    }
    return { href: textOf(child(r, 'href')), props };
  });
}
