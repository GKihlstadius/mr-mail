import { t } from './i18n';
import type { AccountConfig, Signature } from './types';

// Signaturer exporterade ur Spark (JSON med fältet htmlContent), och appens signaturbibliotek.

export interface SparkSignature {
  sparkId: string;
  html: string;
  // E-postadresser som nämns i signaturen, till förslaget på konto.
  emails: string[];
}

function decodeEntities(s: string): string {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

// Sparks eget omslag kring egen HTML tas bort, resten lämnas orört (saneras när den visas och sparas).
export function unwrapSpark(html: string): string {
  const t = html.trim();
  const m = t.match(/^<div\s+data-spark-custom-html="true"\s*>([\s\S]*)<\/div>$/i);
  return (m ? m[1] : t).trim();
}

export function emailsIn(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/mailto:([^"'?\s>]+)/gi)) found.add(decodeEntities(decodeURIComponent(m[1])).toLowerCase());
  const text = decodeEntities(html.replace(/<[^>]+>/g, ' '));
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) found.add(m[0].toLowerCase());
  return [...found];
}

export function parseSparkExport(json: string): SparkSignature[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error(t('Filen är inte en signaturexport från Spark (ogiltig JSON).'));
  }
  const list = Array.isArray(data) ? data : Array.isArray((data as any)?.signatures) ? (data as any).signatures : null;
  if (!list) throw new Error(t('Filen innehåller inga signaturer från Spark.'));
  const out: SparkSignature[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || item.deleted === true) continue;
    const raw = typeof item.htmlContent === 'string' ? item.htmlContent : '';
    const html = unwrapSpark(raw);
    if (!html.replace(/<[^>]+>/g, '').trim() && !/<img/i.test(html)) continue;
    out.push({ sparkId: String(item.identifier ?? item.id ?? out.length), html, emails: emailsIn(html) });
  }
  return out;
}

// Föreslår konto för varje signatur: kontot vars adress står i signaturen.
export function suggestAccount(sig: { emails: string[] }, accounts: AccountConfig[]): string {
  for (const e of sig.emails) {
    const a = accounts.find((x) => x.email.toLowerCase() === e);
    if (a) return a.id;
  }
  return '';
}

export function suggestName(sig: SparkSignature, accounts: AccountConfig[]): string {
  const acc = accounts.find((a) => a.id === suggestAccount(sig, accounts));
  if (acc) return acc.name;
  return sig.emails[0] ?? t('Signatur från Spark');
}

// Kontots signatur: vald signatur ur biblioteket, ingen, eller (äldre konton) den som sparats på kontot.
export function resolveSignature(account: AccountConfig, signatures: Signature[]): string {
  if (account.signatureId === undefined) return account.signature ?? '';
  if (!account.signatureId) return '';
  return signatures.find((s) => s.id === account.signatureId)?.html ?? '';
}

export function newSignatureId(): string {
  return `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// Flyttar in signaturer som sparats direkt på konton (före 0.3) i biblioteket.
export function migrateSignatures(accounts: AccountConfig[], signatures: Signature[]): { accounts: AccountConfig[]; signatures: Signature[]; changed: boolean } {
  let changed = false;
  const sigs = [...signatures];
  const accs = accounts.map((a) => {
    if (a.signatureId !== undefined) return a;
    changed = true;
    const html = a.signature?.trim() ?? '';
    if (!html) return { ...a, signatureId: '' };
    const same = sigs.find((s) => s.html === html);
    if (same) return { ...a, signatureId: same.id };
    const sig: Signature = { id: newSignatureId(), name: a.name, html };
    sigs.push(sig);
    return { ...a, signatureId: sig.id };
  });
  return { accounts: accs, signatures: sigs, changed };
}
