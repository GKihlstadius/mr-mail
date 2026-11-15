import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { rankFuzzy } from '../../shared/fuzzy';
import { APP_NAME } from '../../shared/brand';
import { t } from '../../shared/i18n';
import { cx } from '../util';
import * as I from './Icons';

export type PaletteGroup = 'action' | 'place' | 'contact' | 'mail';

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  label: string;
  hint?: string;
  shortcut?: string;
  // Extra ord som sökningen ska hitta, till exempel engelska och svenska namn.
  keywords?: string;
  icon?: (p: { size?: number }) => ReactElement;
  run(): void;
}

interface Props {
  items: PaletteItem[];
  // Träffar som hämtas när användaren skriver, till exempel kontakter.
  search?(query: string): Promise<PaletteItem[]>;
  onClose(): void;
}

const groupLabel = (g: PaletteGroup) => (g === 'action' ? t('Åtgärder') : g === 'place' ? t('Gå till') : g === 'contact' ? t('Kontakter') : t('Mejl'));

// Kommandopaletten (Ctrl+K): skriv några bokstäver, välj med pilarna och Enter.
export function CommandPalette({ items, search, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [extra, setExtra] = useState<PaletteItem[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setExtra([]);
    if (!search || query.trim().length < 2) return;
    let live = true;
    const timer = setTimeout(() => {
      void search(query.trim())
        .then((list) => live && setExtra(list))
        .catch(() => undefined);
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);

  const shown = useMemo(() => {
    const base = query.trim() ? items : items.filter((i) => i.group === 'action' || i.group === 'place');
    const ranked = rankFuzzy([...base, ...extra.filter((x) => !base.some((b) => b.id === x.id))], query, (i) => `${i.label} ${i.hint ?? ''} ${i.keywords ?? ''}`, 40);
    // Utan sökord visas grupperna i sin ordning, med sökord de bästa träffarna först.
    return query.trim() ? ranked : ranked.slice(0, 40);
  }, [items, extra, query]);

  useEffect(() => setActive(0), [query, extra.length]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label={t('Kommandon')}>
        <div className="palette-search">
          <I.Search size={17} />
          <input
            id="palette-input"
            autoFocus
            value={query}
            spellCheck={false}
            placeholder={t('Sök efter åtgärder, mappar, personer och mejl')}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={shown[active] ? `palette-${active}` : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(shown.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(shown[active]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {!shown.length && <div className="palette-empty">{t('Inga träffar.')}</div>}
          {shown.map((item, i) => {
            const Icon = item.icon;
            const head = !query.trim() && (i === 0 || shown[i - 1].group !== item.group);
            return (
              <div key={item.id}>
                {head && <div className="palette-group">{groupLabel(item.group)}</div>}
                <div
                  id={`palette-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  className={cx('palette-item', i === active && 'active')}
                  onMouseMove={() => i !== active && setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(item)}
                >
                  <span className="palette-icon">{Icon ? <Icon size={16} /> : null}</span>
                  <span className="palette-label">{item.label}</span>
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                  {item.shortcut && <kbd>{item.shortcut}</kbd>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export interface ShortcutGroup {
  title: string;
  rows: [string, string][];
}

export function shortcutGroups(): ShortcutGroup[] {
  return [
    {
      title: t('Allmänt'),
      rows: [
        ['Ctrl+K', t('Kommandopaletten')],
        ['Ctrl+J', t('Fråga {app}', { app: APP_NAME })],
        ['Ctrl+N', t('Nytt mejl')],
        ['Ctrl+F', t('Sök')],
        ['Ctrl+Z', t('Ångra senaste flytten')],
        ['Ctrl+/', t('Kortkommandon')]
      ]
    },
    {
      title: t('Listan'),
      rows: [
        ['↑ ↓', t('Föregående och nästa mejl')],
        ['Shift+↑ ↓', t('Markera flera')],
        ['Home End', t('Första och sista mejlet')],
        ['Ctrl+A', t('Markera alla')],
        ['Esc', t('Avsluta sökningen eller markeringen')]
      ]
    },
    {
      title: t('Mejlet'),
      rows: [
        ['Ctrl+R', t('Svara')],
        ['Ctrl+Shift+R', t('Svara alla')],
        ['Ctrl+Shift+F', t('Vidarebefordra')],
        ['E', t('Arkivera')],
        ['Delete', t('Flytta till papperskorgen')],
        ['Ctrl+Shift+U', t('Markera som oläst eller läst')],
        ['Ctrl+Shift+L', t('Flagga')],
        ['Ctrl+P', t('Skriv ut')],
        ['Enter', t('Öppna utkastet')]
      ]
    },
    {
      title: t('Skriva'),
      rows: [
        ['Ctrl+Enter', t('Skicka')],
        ['Ctrl+S', t('Spara utkast')],
        ['Ctrl+B', t('Fet stil')],
        ['Ctrl+I', t('Kursiv')],
        ['Ctrl+K', t('Lägg till länk')]
      ]
    }
  ];
}

export function ShortcutsDialog({ onClose }: { onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal shortcuts-modal" role="dialog" aria-label={t('Kortkommandon')}>
        <header className="modal-head">
          <h2>{t('Kortkommandon')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('Stäng')}>
            <I.Close size={16} />
          </button>
        </header>
        <div className="modal-body shortcuts-body">
          {shortcutGroups().map((g) => (
            <section key={g.title}>
              <div className="section-title">{g.title}</div>
              {g.rows.map(([key, what]) => (
                <div className="shortcut-row" key={key + what}>
                  <span>{what}</span>
                  <kbd>{key}</kbd>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
