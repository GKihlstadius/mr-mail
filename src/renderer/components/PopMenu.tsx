import { t, locale } from '../../shared/i18n';
import { useEffect, useRef, type ReactNode } from 'react';
import { cx } from '../util';

export interface PopItem {
  label: string;
  hint?: string;
  icon?: ReactNode;
  danger?: boolean;
  onPick(): void;
}

export interface PopSection {
  title?: string;
  items: PopItem[];
}

// Liten meny vid en knapp, i samma stil som Flytta till.
export function PopMenu({ x, y, sections, label, onClose }: { x: number; y: number; sections: PopSection[]; label: string; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  const count = sections.reduce((n, s) => n + s.items.length + (s.title ? 1 : 0), 0);
  const style = { left: Math.max(6, Math.min(x, window.innerWidth - 250)), top: Math.max(6, Math.min(y, window.innerHeight - count * 30 - 20)) };
  return (
    <div className="move-menu pop-menu" ref={ref} style={style} role="menu" aria-label={label}>
      {sections.map((s, i) => (
        <div key={i} className="pop-section">
          {s.title && <div className="move-menu-head">{s.title}</div>}
          {s.items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              className={cx('move-item', 'pop-item', it.danger && 'danger')}
              onClick={() => {
                it.onPick();
                onClose();
              }}
            >
              {it.icon}
              <span className="move-name">{it.label}</span>
              {it.hint && <span className="pop-hint">{it.hint}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
const at = (d: Date, h: number) => {
  const x = new Date(d);
  x.setHours(h, 0, 0, 0);
  return x;
};

// Förslag på tider för Påminn mig, som i Apple Mail.
export function snoozeTimes(now = new Date()): { label: string; due: number }[] {
  const out: { label: string; due: number }[] = [];
  const later = new Date(now.getTime() + 3 * 3600_000);
  if (later.getDate() === now.getDate() && later.getHours() < 21) out.push({ label: t('Om tre timmar'), due: later.getTime() });
  if (now.getHours() < 17) out.push({ label: t('I kväll'), due: at(now, 18).getTime() });
  const tomorrow = at(new Date(now.getTime() + 86400_000), 8);
  out.push({ label: t('I morgon'), due: tomorrow.getTime() });
  const monday = new Date(now);
  monday.setDate(now.getDate() + (((8 - now.getDay()) % 7) || 7));
  out.push({ label: t('Nästa vecka'), due: at(monday, 8).getTime() });
  return out;
}

export function whenText(ts: number, now = new Date()): string {
  const d = new Date(ts);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86400_000);
  if (diff === 0) return t('i dag {time}', { time });
  if (diff === 1) return t('i morgon {time}', { time });
  if (diff === -1) return t('i går {time}', { time });
  return `${d.toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}
