// Fråga Mr Mail: ren logik som delas av huvudprocessen och fönstret. Steg i klartext,
// länkar till mejl och händelser i svaret, och vilka motorer som klarar verktygsanrop.
import type { AiEngine } from './types';
import { t } from './i18n';

export interface ChatStep {
  id: string;
  label: string;
  done: boolean;
  ok?: boolean;
}

export type RefKind = 'mail' | 'event';

// Mejl och händelser som svaret får länka till, med id som finns i appen.
export interface ChatRefs {
  mail: Record<string, string>;
  event: Record<string, string>;
}

export interface ChatAnswer {
  text: string;
  refs: ChatRefs;
  steps: ChatStep[];
}

export function chatSupported(engine: AiEngine): boolean {
  return engine === 'openai' || engine === 'local' || engine === 'spark';
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

// Steget i klartext, till exempel "Söker i mejlen…" eller "Läser mejl från Karin".
export function stepLabel(tool: string, args: Record<string, unknown>, sender?: (id: string) => string | null): string {
  const id = str(args.id);
  switch (tool) {
    case 'search_emails':
      return t('Söker i mejlen…');
    case 'list_emails':
      return t('Tittar i inkorgen…');
    case 'read_email': {
      const who = id && sender ? sender(id) : null;
      return who ? t('Läser mejl från {name}', { name: who }) : t('Läser ett mejl…');
    }
    case 'read_thread':
      return t('Läser konversationen…');
    case 'read_attachment':
      return t('Läser bilagan…');
    case 'save_attachment':
      return t('Sparar bilagan…');
    case 'draft_email':
    case 'edit_draft':
      return t('Skriver ett utkast…');
    case 'send_email':
    case 'send_draft':
      return t('Skickar mejlet…');
    case 'archive':
      return t('Arkiverar…');
    case 'trash':
      return t('Flyttar till papperskorgen…');
    case 'mark':
      return t('Markerar mejl…');
    case 'move':
      return t('Flyttar mejl…');
    case 'create_folder':
      return t('Skapar en mapp…');
    case 'senders':
      return t('Tittar på avsändarna…');
    case 'unsubscribe':
      return t('Avregistrerar…');
    case 'clean_up':
      return t('Städar…');
    case 'find_contact':
      return str(args.query) ? t('Letar efter {name}…', { name: str(args.query).slice(0, 40) }) : t('Letar i kontakterna…');
    case 'remind':
      return t('Lägger en påminnelse…');
    case 'respond_to_invite':
      return t('Svarar på inbjudan…');
    case 'list_events':
      return t('Tittar i kalendern…');
    case 'find_free_time':
      return t('Letar efter ledig tid…');
    case 'create_event':
      return str(args.title) ? t('Bokar {title}…', { title: str(args.title).slice(0, 50) }) : t('Skapar en händelse…');
    case 'update_event':
      return t('Ändrar händelsen…');
    case 'delete_event':
      return t('Tar bort händelsen…');
    case 'accounts':
      return t('Tittar på kontona…');
    case 'show_in_app':
      return t('Visar i appen…');
    default:
      return t('Använder {tool}…', { tool });
  }
}

const LINK = /\[([^\]\n]{1,200})\]\((mail|event):([^)\n]{1,300})\)/g;

// Alla länkar av formen [text](mail:ID) och [text](event:ID) i svaret.
export function findRefLinks(text: string): { kind: RefKind; id: string; label: string }[] {
  const out: { kind: RefKind; id: string; label: string }[] = [];
  for (const m of text.matchAll(LINK)) out.push({ kind: m[2] as RefKind, id: m[3].trim(), label: m[1] });
  return out;
}

export type Inline = { kind: 'text'; text: string } | { kind: 'bold'; text: string } | { kind: 'ref'; ref: RefKind; id: string; text: string };

export type Block = { kind: 'p'; lines: Inline[][] } | { kind: 'ul' | 'ol'; items: Inline[][] };

// Fetstil och länkar på en rad. Länkar till id som inte finns blir vanlig text.
export function parseInline(line: string, refs: ChatRefs): Inline[] {
  const out: Inline[] = [];
  const push = (text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last?.kind === 'text') last.text += text;
    else out.push({ kind: 'text', text });
  };
  const pattern = /\[([^\]\n]{1,200})\]\((mail|event):([^)\n]{1,300})\)|\*\*([^*\n]+)\*\*/g;
  let at = 0;
  for (const m of line.matchAll(pattern)) {
    push(line.slice(at, m.index));
    at = (m.index ?? 0) + m[0].length;
    if (m[4] !== undefined) {
      out.push({ kind: 'bold', text: m[4] });
      continue;
    }
    const kind = m[2] as RefKind;
    const id = m[3].trim();
    const label = m[1].replace(/\*\*/g, '');
    if (Object.prototype.hasOwnProperty.call(refs[kind], id)) out.push({ kind: 'ref', ref: kind, id, text: label });
    else push(label);
  }
  push(line.slice(at));
  return out;
}

// Svaret som stycken och listor. Rubriker blir fetstil, annan markdown lämnas som text.
export function parseChatText(text: string, refs: ChatRefs): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r/g, '').split('\n');
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      blocks.push({ kind: 'p', lines: [] });
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    const last = blocks[blocks.length - 1];
    if (bullet || num) {
      const kind = bullet ? 'ul' : 'ol';
      const item = parseInline((bullet ?? num)![1], refs);
      if (last && last.kind === kind) last.items.push(item);
      else blocks.push({ kind, items: [item] });
      continue;
    }
    const inline = heading ? [{ kind: 'bold' as const, text: heading[1].replace(/\*\*/g, '') }] : parseInline(line.trim(), refs);
    if (last && last.kind === 'p' && last.lines.length) last.lines.push(inline);
    else blocks.push({ kind: 'p', lines: [inline] });
  }
  return blocks.filter((b) => (b.kind === 'p' ? b.lines.length > 0 : b.items.length > 0));
}
