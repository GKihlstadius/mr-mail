import type { FolderRole } from './types';

// Betrodda avsändare: bilder från internet visas direkt för dem. Jämförs på hela adressen i Från,
// utan hänsyn till skiftläge. Visningsnamnet räknas aldrig, det kan vem som helst skriva.

export type TrustReason = 'trusted' | 'sent';

export interface RemoteImagePolicy {
  // Bilderna visas utan att användaren behöver trycka.
  auto: boolean;
  // Varför: avsändaren är sparad som betrodd, eller användaren har själv skrivit till adressen.
  reason: TrustReason | null;
  // Mejlet ligger i skräpposten. Där laddas inget automatiskt och inget förtroende erbjuds.
  junk: boolean;
}

export function normalizeAddress(address: string | null | undefined): string {
  const a = (address ?? '').trim().toLowerCase();
  // En riktig adress har exakt ett snabel-a med text på båda sidor och inga blanktecken.
  return /^[^\s@<>"]+@[^\s@<>"]+$/.test(a) ? a : '';
}

const JUNK_NAME = /^(spam|junk|junk e-?mail|bulk mail|skräppost|skräp)$/i;
const JUNK_LABEL = /^(\\+junk|\$junk|junk|spam)$/i;

// Skräppost känns igen på mappens roll, och för säkerhets skull på mappnamn och etiketter.
export function isJunk(where: { role?: FolderRole | null; folder?: string; labels?: string[] }): boolean {
  if (where.role === 'junk') return true;
  const leaf = (where.folder ?? '').split(/[/.]/).pop() ?? '';
  if (JUNK_NAME.test(leaf.trim())) return true;
  return (where.labels ?? []).some((l) => JUNK_LABEL.test(l.trim()));
}

export function remoteImagePolicy(input: {
  from: string | null | undefined;
  role?: FolderRole | null;
  folder?: string;
  labels?: string[];
  trusted: ReadonlySet<string>;
  sentTo: ReadonlySet<string>;
}): RemoteImagePolicy {
  const junk = isJunk(input);
  const addr = normalizeAddress(input.from);
  if (junk || !addr) return { auto: false, reason: null, junk };
  if (input.trusted.has(addr)) return { auto: true, reason: 'trusted', junk };
  if (input.sentTo.has(addr)) return { auto: true, reason: 'sent', junk };
  return { auto: false, reason: null, junk };
}
