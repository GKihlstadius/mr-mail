import { t } from './i18n';

// Städa: avsändare, kategorier och avregistrering via List-Unsubscribe (RFC 2369 och RFC 8058).

export type SenderCategory = 'newsletter' | 'notification' | 'receipt' | 'social' | 'personal';

// Svenska etiketter som data (agenten matchar på dem); visa med categoryLabel().
export const CATEGORY_LABEL: Record<SenderCategory, string> = {
  newsletter: 'Nyhetsbrev',
  notification: 'Aviseringar',
  receipt: 'Kvitton',
  social: 'Sociala',
  personal: 'Personligt'
};

export function categoryLabel(c: SenderCategory): string {
  return t(CATEGORY_LABEL[c]);
}

export interface SenderStat {
  address: string;
  name: string;
  total: number;
  unread: number;
  inInbox: number;
  last: number;
  subject: string;
  unsubscribe: boolean;
  bulk: boolean;
  category: SenderCategory;
  rule?: CleanAction;
  unsubscribed?: number;
}

export type CleanAction = 'archive' | 'trash';

export interface CleanRule {
  address: string;
  action: CleanAction;
}

export interface ListHeaders {
  unsubscribe: string;
  oneClick: boolean;
  bulk: boolean;
}

// Läser List-Unsubscribe, List-Unsubscribe-Post, List-Id och Precedence ur hämtade rubrikrader.
export function parseListHeaders(raw: string): ListHeaders {
  const text = raw.replace(/\r?\n[ \t]+/g, ' ');
  const get = (name: string) => text.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'))?.[1]?.trim() ?? '';
  const unsubscribe = get('List-Unsubscribe');
  const post = get('List-Unsubscribe-Post');
  return {
    unsubscribe,
    oneClick: /List-Unsubscribe=One-Click/i.test(post),
    bulk: !!get('List-Id') || /^(bulk|list|junk)$/i.test(get('Precedence')) || !!unsubscribe
  };
}

export interface UnsubscribeTarget {
  https?: string;
  http?: string;
  mailto?: { to: string; subject: string; body: string };
}

export function parseUnsubscribe(header: string): UnsubscribeTarget {
  const out: UnsubscribeTarget = {};
  for (const m of header.matchAll(/<([^>]+)>/g)) {
    const v = m[1].trim();
    if (/^https:\/\//i.test(v) && !out.https) out.https = v;
    else if (/^http:\/\//i.test(v) && !out.http) out.http = v;
    else if (/^mailto:/i.test(v) && !out.mailto) {
      const [addr, query = ''] = v.slice(7).split('?');
      const params = new URLSearchParams(query);
      const to = decodeURIComponent(addr).trim();
      if (to) out.mailto = { to, subject: params.get('subject') || 'unsubscribe', body: params.get('body') || 'unsubscribe' };
    }
  }
  return out;
}

const SOCIAL = /(^|\.)(facebook|facebookmail|linkedin|instagram|twitter|x|tiktok|youtube|pinterest|reddit|snapchat|threads|bsky|mastodon|meetup|strava)\.[a-z.]+$/i;
const RECEIPT = /\b(kvitto|kvittot|orderbekräftelse|order|beställning|faktura|invoice|receipt|betalning|payment|bokning|booking|biljett|ticket|leverans|delivery|skickad|shipped)\b/i;
const RECEIPT_SENDER = /(^|[.@-])(billing|invoice|receipts?|orders?|kvitto|faktura|payments?|klarna|paypal|stripe|swish)([.@-]|$)/i;
const BULK_SENDER = /^(news|newsletter|nyhetsbrev|nyheter|marketing|offers?|erbjudanden?|kampanj|promo|deals|info|hello|hej|team|kundservice|kundklubb|club|klubb)@/i;
const BULK_DOMAIN = /^(mail|email|e|em|news|nyheter|info|mailer|send|mkt|marketing|campaign|newsletter)\./i;
const NOTIFY = /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|noreply-[a-z0-9-]+|mailer-daemon|postmaster|security|account|accounts|support|updates?)@/i;

export function categorize(s: { address: string; subject: string; bulk: boolean; unsubscribe: boolean }): SenderCategory {
  const addr = s.address.toLowerCase();
  const domain = addr.split('@')[1] ?? '';
  if (SOCIAL.test(domain)) return 'social';
  if (RECEIPT_SENDER.test(addr) || RECEIPT.test(s.subject)) return 'receipt';
  if (NOTIFY.test(addr)) return 'notification';
  if (s.bulk || s.unsubscribe || BULK_SENDER.test(addr) || BULK_DOMAIN.test(domain)) return 'newsletter';
  return 'personal';
}

const UNSUB_WORDS = /unsubscribe|avregistr|avanmäl|avsluta (din |din e-?post|prenumeration|utskick)|sluta (få|ta emot)|opt.?out|abmelden|désinscri|e-?postinställningar|e-?mail preferences|manage (your )?(subscription|preferences|email)|hantera (prenumeration|utskick|e-?post)/i;

// Letar upp en avregistreringslänk i mejlets HTML när rubriken List-Unsubscribe saknas.
export function findUnsubscribeLink(html: string): string | null {
  const links: { href: string; score: number }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[2].replace(/&amp;/g, '&').trim();
    if (!/^https?:\/\//i.test(href)) continue;
    const text = m[3].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const score = (UNSUB_WORDS.test(text) ? 2 : 0) + (UNSUB_WORDS.test(href) || /unsub|optout|opt-out|avreg/i.test(href) ? 1 : 0);
    if (score) links.push({ href, score: score + (/^https:/i.test(href) ? 0.5 : 0) });
  }
  links.sort((a, b) => b.score - a.score);
  return links[0]?.href ?? null;
}
