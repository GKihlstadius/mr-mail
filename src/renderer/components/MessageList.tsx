import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent as RMouseEvent } from 'react';
import type { AccountConfig, Folder, MessageSummary, SearchQuery } from '../../shared/types';
import { cx, listDate, senderName } from '../util';
import { APP_NAME } from '../../shared/brand';
import { t } from '../../shared/i18n';
import * as I from './Icons';
import { MoveMenu } from './MoveMenu';
import { whenText } from './PopMenu';

interface Props {
  title: string;
  subtitle: string;
  messages: MessageSummary[];
  accounts: AccountConfig[];
  folders: Folder[];
  showAccount: boolean;
  selectedId: string | null;
  checked?: Set<string>;
  tabs?: { id: string; label: string; unread: number }[] | null;
  tab?: string;
  onTab?(id: string): void;
  query: string;
  empty: string;
  onQuery(q: string): void;
  onSelect(id: string, mod: { ctrl: boolean; shift: boolean }): void;
  onCompose(): void;
  onAsk?(): void;
  askOpen?: boolean;
  onRefresh(): void;
  onMove(id: string, path: string): void;
  onOpen?(m: MessageSummary): void;
  threads?: boolean;
  filters?: Partial<SearchQuery>;
  onFilters?(f: Partial<SearchQuery>): void;
  searching?: boolean;
  serverBusy?: boolean;
  olderBusy?: boolean;
  onEndReached?(): void;
}

function FilterPanel({ value, onChange }: { value: Partial<SearchQuery>; onChange(f: Partial<SearchQuery>): void }) {
  const set = (patch: Partial<SearchQuery>) => {
    const next = { ...value, ...patch };
    for (const k of Object.keys(next) as (keyof SearchQuery)[]) if (next[k] === '' || next[k] === false) delete next[k];
    onChange(next);
  };
  const toggle = (key: 'unread' | 'flagged' | 'hasAttachment', label: string) => (
    <button type="button" className={cx('pill', 'filter-pill', value[key] && 'on')} aria-pressed={!!value[key]} onClick={() => set({ [key]: !value[key] })}>
      {t(label)}
    </button>
  );
  return (
    <div className="filter-panel" role="group" aria-label={t('Sökfilter')}>
      <div className="filter-pills">
        {toggle('unread', 'Olästa')}
        {toggle('flagged', 'Flaggade')}
        {toggle('hasAttachment', 'Med bilaga')}
      </div>
      <div className="filter-grid">
        <label>
          <span>{t('Från')}</span>
          <input id="filter-from" value={value.from ?? ''} onChange={(e) => set({ from: e.target.value })} spellCheck={false} />
        </label>
        <label>
          <span>{t('Till')}</span>
          <input id="filter-to" value={value.to ?? ''} onChange={(e) => set({ to: e.target.value })} spellCheck={false} />
        </label>
        <label>
          <span>{t('Ämne')}</span>
          <input id="filter-subject" value={value.subject ?? ''} onChange={(e) => set({ subject: e.target.value })} />
        </label>
        <label>
          <span>{t('Efter')}</span>
          <input id="filter-after" type="date" value={value.after ?? ''} onChange={(e) => set({ after: e.target.value })} />
        </label>
        <label>
          <span>{t('Före')}</span>
          <input id="filter-before" type="date" value={value.before ?? ''} onChange={(e) => set({ before: e.target.value })} />
        </label>
      </div>
      {Object.keys(value).length > 0 && (
        <button type="button" className="link small" onClick={() => onChange({})}>
          {t('Rensa filter')}
        </button>
      )}
    </div>
  );
}

const MAX_CHIPS = 2;

export function MessageList(p: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ id: string; accountId: string; x: number; y: number } | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterCount = Object.keys(p.filters ?? {}).length;

  // Virtualiserad lista: bara raderna som syns (plus marginal) finns i DOM, så att 10 000 mejl rullar jämnt.
  // Alla rader har samma höjd i en vy, den mäts på första raden.
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(800);
  const [rowH, setRowH] = useState(92);
  const OVERSCAN = 8;
  const n = p.messages.length;
  const first = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
  const last = Math.min(n, Math.ceil((scrollTop + viewport) / rowH) + OVERSCAN);
  const visible = p.messages.slice(first, last);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    setViewport(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Ny vy börjar överst.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [p.title, p.tab]);

  useLayoutEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('.row');
    if (row && Math.abs(row.offsetHeight - rowH) > 0.5) setRowH(row.offsetHeight);
  });

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 600) p.onEndReached?.();
  };

  useEffect(() => {
    if (!p.selectedId) return;
    const el = listRef.current;
    const idx = p.messages.findIndex((m) => m.id === p.selectedId);
    if (!el || idx < 0) return;
    const top = idx * rowH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight;
  }, [p.selectedId]);

  const accountMap = new Map(p.accounts.map((a) => [a.id, a]));
  const multi = p.accounts.length > 1;

  const onDragStart = (e: DragEvent, id: string) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-brevlada-message', id);
    e.dataTransfer.setData('text/plain', id);
  };

  const onContextMenu = (e: RMouseEvent, m: MessageSummary) => {
    e.preventDefault();
    setMenu({ id: m.id, accountId: m.accountId, x: e.clientX, y: e.clientY });
  };

  return (
    <section className="list-pane">
      <header className="list-head drag">
        <div className="list-titles">
          <h1>{p.title}</h1>
          <div className="subtitle">{p.subtitle}</div>
        </div>
        <div className="no-drag head-actions">
          {p.onAsk && (
            <button className={cx('icon-btn', 'ask-btn', p.askOpen && 'on')} id="ask-toggle" onClick={p.onAsk} title={t('Fråga {app} (Ctrl+J)', { app: APP_NAME })} aria-label={t('Fråga {app}', { app: APP_NAME })} aria-pressed={!!p.askOpen}>
              <I.Sparkle size={17} />
            </button>
          )}
          <button className="icon-btn" onClick={p.onRefresh} title={t('Hämta nya mejl')} aria-label={t('Hämta nya mejl')}>
            <I.Refresh size={17} />
          </button>
          <button className="icon-btn" onClick={p.onCompose} title={t('Nytt meddelande (Ctrl+N)')} aria-label={t('Nytt meddelande')}>
            <I.Compose size={18} />
          </button>
        </div>
      </header>
      <div className="search-wrap">
        <I.Search size={15} />
        <input
          id="search"
          type="search"
          placeholder={t('Sök')}
          value={p.query}
          spellCheck={false}
          onChange={(e) => p.onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') p.onQuery('');
          }}
        />
        {p.onFilters && (
          <button
            className={cx('filter-btn', (filtersOpen || filterCount > 0) && 'on')}
            onClick={() => setFiltersOpen(!filtersOpen)}
            title={t('Sökfilter')}
            aria-label={t('Sökfilter')}
            aria-expanded={filtersOpen}
          >
            <I.Filter size={15} />
            {filterCount > 0 && <span className="filter-count">{filterCount}</span>}
          </button>
        )}
      </div>
      {filtersOpen && p.onFilters && <FilterPanel value={p.filters ?? {}} onChange={p.onFilters} />}
      {p.tabs && (
        <div className="inbox-tabs" role="tablist" aria-label={t('Smart inkorg')}>
          {p.tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              data-tab={tab.id}
              aria-selected={p.tab === tab.id}
              className={cx('inbox-tab', p.tab === tab.id && 'on')}
              onClick={() => p.onTab?.(tab.id)}
            >
              {tab.label}
              {tab.unread > 0 && <span className="tab-count">{tab.unread}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="list" ref={listRef} role="listbox" aria-label={t('Meddelanden')} onScroll={onScroll}>
        {p.messages.length === 0 && <div className="empty">{p.empty}</div>}
        {first > 0 && <div className="list-spacer" style={{ height: first * rowH }} aria-hidden="true" />}
        {visible.map((m) => {
          const acc = accountMap.get(m.accountId);
          const isChecked = !!p.checked && p.checked.size > 1 && p.checked.has(m.id);
          const selected = isChecked || (m.id === p.selectedId && !(p.checked && p.checked.size > 1));
          const labels = (m.labels ?? []).filter(Boolean);
          return (
            <div
              key={m.id}
              data-id={m.id}
              role="option"
              aria-selected={selected}
              draggable
              onDragStart={(e) => onDragStart(e, m.id)}
              onContextMenu={(e) => onContextMenu(e, m)}
              className={cx('row', selected && 'selected', isChecked && 'checked', !m.seen && 'unread')}
              onClick={(e) => p.onSelect(m.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
              onDoubleClick={() => p.onOpen?.(m)}
            >
              <div className="row-gutter">
                {!m.seen && <span className="unread-dot" />}
                {m.seen && m.answered && <I.Reply size={12} className="answered" />}
              </div>
              <div className="row-main">
                <div className="row-line">
                  <span className="row-from">
                    {acc && m.from.address === acc.email.toLowerCase() && m.to[0] ? t('Till: {name}', { name: senderName(m.to[0]) }) : senderName(m.from)}
                  </span>
                  {m.hasAttachments && <I.Paperclip size={13} className="row-icon" />}
                  {m.flagged && <I.Flag size={13} filled className="row-flag" />}
                  {p.threads && (m.threadCount ?? 1) > 1 && <span className="thread-count" title={t('{n} mejl i konversationen', { n: m.threadCount ?? 0 })}>{m.threadCount}</span>}
                  <span className="row-date">{listDate(m.date)}</span>
                </div>
                <div className="row-subject-line">
                  <span className="row-subject">{m.subject || t('(inget ämne)')}</span>
                  {labels.length > 0 && (
                    <span className="row-labels">
                      {labels.slice(0, MAX_CHIPS).map((l) => (
                        <span className="label-chip" key={l}>
                          {l}
                        </span>
                      ))}
                      {labels.length > MAX_CHIPS && <span className="label-chip more">+{labels.length - MAX_CHIPS}</span>}
                    </span>
                  )}
                </div>
                <div className="row-preview">{m.preview || ' '}</div>
                {m.reminder && (
                  <div className={cx('row-reminder', m.reminder.state === 'due' && 'due')}>
                    <I.Clock size={12} />
                    {m.reminder.kind === 'snooze'
                      ? t('Visas igen {when}', { when: whenText(m.reminder.due) })
                      : m.reminder.state === 'due'
                        ? t('Inget svar än')
                        : t('Följ upp {when} om inget svar', { when: whenText(m.reminder.due) })}
                  </div>
                )}
                {p.showAccount && multi && acc && (
                  <div className="row-account">
                    <span className="acc-swatch" style={{ background: acc.color }} />
                    {acc.name}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {last < n && <div className="list-spacer" style={{ height: (n - last) * rowH }} aria-hidden="true" />}
        {(p.olderBusy || (p.searching && p.serverBusy)) && (
          <div className="list-foot">
            <span className="pulse" />
            {p.searching ? t('Söker på servern…') : t('Hämtar äldre mejl…')}
          </div>
        )}
      </div>
      {menu && (
        <MoveMenu
          folders={p.folders.filter((f) => f.accountId === menu.accountId)}
          x={menu.x}
          y={menu.y}
          onPick={(path) => {
            p.onMove(menu.id, path);
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  );
}
