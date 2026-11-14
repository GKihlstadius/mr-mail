import { inflateRawSync } from 'node:zlib';

// Plockar ut texten ur en bilaga så att en AI-agent kan läsa den: vanlig text, HTML och
// Office-filer (docx, xlsx, pptx). Andra filtyper ger null, då får agenten läsa den sparade filen själv.

const TEXT_EXT = /\.(txt|md|csv|tsv|json|xml|ics|vcf|log|ya?ml|ini|eml)$/i;

function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    try {
      if (method === 0) out.set(name, Buffer.from(data));
      else if (method === 8) out.set(name, inflateRawSync(data));
    } catch {
      /* trasig post hoppas över */
    }
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function wordText(xml: string): string {
  return decode(
    xml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
  );
}

function slideText(xml: string): string {
  return decode(xml.replace(/<\/a:p>/g, '\n').replace(/<[^>]+>/g, ''));
}

function sheetText(files: Map<string, Buffer>): string {
  const shared = [...(files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    decode(m[1].replace(/<[^>]+>/g, ''))
  );
  const sheets = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const out: string[] = [];
  for (const k of sheets) {
    out.push(`# ${k.replace(/^.*\//, '').replace('.xml', '')}`);
    const xml = files.get(k)!.toString('utf8');
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [...row[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => {
        const v = /<v>([\s\S]*?)<\/v>/.exec(c[2] ?? '')?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(c[2] ?? '')?.[1] ?? '';
        return /t="s"/.test(c[1]) ? (shared[Number(v)] ?? '') : decode(v);
      });
      out.push(cells.join('\t'));
    }
  }
  return out.join('\n');
}

export function attachmentText(filename: string, contentType: string, content: Buffer): string | null {
  const name = filename.toLowerCase();
  if (contentType.startsWith('text/html') || /\.html?$/.test(name)) {
    return decode(
      content
        .toString('utf8')
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
    );
  }
  if (contentType.startsWith('text/') || TEXT_EXT.test(name) || contentType === 'application/json') return content.toString('utf8');
  if (/\.(docx|docm|dotx)$/.test(name) || contentType.includes('wordprocessingml')) {
    const files = unzip(content);
    const doc = files.get('word/document.xml');
    return doc ? wordText(doc.toString('utf8')) : null;
  }
  if (/\.(pptx)$/.test(name) || contentType.includes('presentationml')) {
    const files = unzip(content);
    const slides = [...files.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    return slides.length ? slides.map((k, i) => `# Bild ${i + 1}\n${slideText(files.get(k)!.toString('utf8'))}`).join('\n\n') : null;
  }
  if (/\.(xlsx|xlsm)$/.test(name) || contentType.includes('spreadsheetml')) return sheetText(unzip(content));
  return null;
}
