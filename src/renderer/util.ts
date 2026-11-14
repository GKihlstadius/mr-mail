import { locale, t } from '../shared/i18n';
import type { Address } from '../shared/types';

const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale(), o);
const time = () => fmt({ hour: '2-digit', minute: '2-digit' });
const weekday = () => fmt({ weekday: 'long' });
const short = () => fmt({ day: 'numeric', month: 'short' });
const withYear = () => fmt({ day: 'numeric', month: 'short', year: 'numeric' });
const full = () => fmt({ dateStyle: 'full', timeStyle: 'short' });

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function listDate(ts: number, now = new Date()): string {
  const d = new Date(ts);
  const today = startOfDay(now);
  const day = startOfDay(d);
  const diff = Math.round((today - day) / 86400000);
  if (diff <= 0) return time().format(d);
  if (diff === 1) return t('Igår');
  if (diff < 7) return weekday().format(d);
  if (d.getFullYear() === now.getFullYear()) return short().format(d);
  return withYear().format(d);
}

export function fullDate(ts: number): string {
  const s = full().format(new Date(ts));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function senderName(a: Address): string {
  return a.name || a.address.split('@')[0] || t('(okänd)');
}

export function initials(a: Address): string {
  const base = (a.name || a.address).replace(/["'<>]/g, '').trim();
  const parts = (a.name ? base.split(/\s+/) : base.split(/[\s.@_-]+/)).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0] ?? '';
  const second = a.name && parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + second).toUpperCase();
}

const AVATAR = ['#8e8e93', '#6c8ebf', '#7fa67a', '#c48a5a', '#9a7fbf', '#bf7f8f', '#5fa3a8'];
export function avatarColor(seed: string): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR[h % AVATAR.length];
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', locale() === 'sv-SE' ? ',' : '.')} MB`;
}

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}
