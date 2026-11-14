import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CATEGORY_LABEL, type CleanAction, type SenderCategory, type SenderStat } from '../../shared/cleanup';
import { api } from '../api';
import type { AccountConfig } from '../../shared/types';
import { avatarColor, cx, initials, listDate } from '../util';
import { PopMenu } from './PopMenu';
import { t, tn, locale } from '../../shared/i18n';
import * as I from './Icons';

type Filter = 'all' | SenderCategory;
type Sort = 'total' | 'unread' | 'last';

const FILTERS: Filter[] = ['all', 'newsletter', 'notification', 'receipt', 'social', 'personal'];
let nfCache: { loc: string; f: Intl.NumberFormat } | null = null;
const nf = {
  format(n: number): string {
    const loc = locale();
    if (!nfCache || nfCache.loc !== loc) nfCache = { loc, f: new Intl.NumberFormat(loc) };
    return nfCache.f.format(n);
  }
};

interface Props {
  accounts: AccountConfig[];
  version: number;
  autoScan: boolean;
  onShowMail(address: string): void;
  onToast(text: string): void;
}

// Städa: avsändare sorterade efter hur mycket de skickar, med avregistrering och massåtgärder.
export function CleanView({ accounts, version, autoScan, onShowMail, onToast }: Props) {
  const [accountId, setAccountId] = useState<string>(() => {
    try {
      return localStorage.getItem('stada-konto') ?? '';
    } catch {
      return '';
    }
  });
  const scope = accounts.some((a) => a.id === accountId) ? accountId : '';
  const chooseAccount = (id: string) => {
    setAccountId(id);
    try {
      localStorage.setItem('stada-konto', id);
    } catch {
      /* valet sparas bara när det går */
    }
  };
  const [senders, setSenders] = useState<SenderStat[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('total');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ s: SenderStat; x: number; y: number } | null>(null);
  const [progress, setProgress] = useState<{ step: number; steps: number; done: number; of: number } | null>(null);
  const [scanning, setScanning] = useState(false);

  const load = useCallback(() => {
    void api.cleanSenders(scope || undefined).then(setSenders).catch((e) => onToast(e.message));
  }, [onToast, scope]);

  useEffect(load, [version, scope]);
  useEffect(() => api.on('clean-progress', (p) => setProgress(p)), []);
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoScan && !autoStarted.current) {
      autoStarted.current = true;
      void scan();
    }
  }, [autoScan]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: senders?.length ?? 0 };
    for (const s of senders ?? []) c[s.category] = (c[s.category] ?? 0) + 1;
    return c;
  }, [senders]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (senders ?? []).filter(
      (s) => (filter === 'all' || s.category === filter) && (!needle || s.address.includes(needle) || s.name.toLowerCase().includes(needle))
    );
    const key: Record<Sort, (s: SenderStat) => number> = { total: (s) => s.total, unread: (s) => s.unread, last: (s) => s.last };
    return list.sort((a, b) => key[sort](b) - key[sort](a));
  }, [senders, filter, sort, q]);

  const totalMails = useMemo(() => (senders ?? []).reduce((n, s) => n + s.total, 0), [senders]);

  const run = async (s: SenderStat, label: string, fn: () => Promise<string>) => {
    setBusy((b) => ({ ...b, [s.address]: label }));
    try {
      onToast(await fn());
    } catch (e: any) {
      onToast(e.message);
    } finally {
      setBusy((b) => {
        const { [s.address]: _, ...rest } = b;
        return rest;
      });
      load();
    }
  };

  const who = (s: SenderStat) => s.name || s.address;
  const mails = (n: number) => tn(n, 'ett mejl', '{count} mejl', { count: nf.format(n) });

  const unsubscribe = (s: SenderStat) =>
    run(s, t('Avregistrerar…'), async () => {
      const r = await api.cleanUnsubscribe(s.address, scope || undefined);
      return r.method === 'browser' ? t('Avregistreringssidan för {who} är öppnad i webbläsaren.', { who: who(s) }) : t('Avregistrerad från {who}.', { who: who(s) });
    });

  const bulk = (s: SenderStat, action: CleanAction) =>
    run(s, action === 'archive' ? t('Arkiverar…') : t('Raderar…'), async () => {
      const n = await api.cleanBulk(s.address, action, undefined, scope || undefined);
      return n
        ? action === 'archive'
          ? t('{mails} från {who} arkiverade.', { mails: mails(n), who: who(s) })
          : t('{mails} från {who} flyttade till papperskorgen.', { mails: mails(n), who: who(s) })
        : t('Inga mejl att flytta.');
    });

  const rule = (s: SenderStat, action: CleanAction | null) =>
    run(s, t('Sparar…'), async () => {
      const n = await api.cleanRule(s.address, action);
      if (!action) return t('Regeln för {who} är borttagen.', { who: who(s) });
      const base = action === 'archive' ? t('Nya mejl från {who} arkiveras automatiskt', { who: who(s) }) : t('Nya mejl från {who} raderas automatiskt', { who: who(s) });
      return n ? `${base}, ${t('{mails} flyttade nu', { mails: mails(n) })}.` : `${base}.`;
    });

  const scan = async () => {
    setScanning(true);
    try {
      const n = await api.cleanScan();
      onToast(t('{count} mejl genomgångna.', { count: nf.format(n) }));
    } catch (e: any) {
      onToast(e.message);
    } finally {
      setScanning(false);
      load();
    }
  };

  return (
    <section className="clean-pane">
      <header className="clean-head drag">
        <div className="list-titles">
          <h1>{t('Städa')}</h1>
          <div className="subtitle">
            {senders ? t('{senders} avsändare, {mails} mejl i inkorg och arkiv', { senders: nf.format(senders.length), mails: nf.format(totalMails) }) : t('Räknar…')}
            {scope && ` ${t('i {account}', { account: accounts.find((a) => a.id === scope)?.email ?? '' })}`}
          </div>
        </div>
        <div className="clean-scan no-drag">
          {scanning && progress && (
            <span className="muted small">
              {t('Går igenom mapp {step} av {steps}: {done} av {of}', { step: progress.step, steps: progress.steps, done: nf.format(progress.done), of: nf.format(progress.of) })}
            </span>
          )}
          <button className="btn small" onClick={() => void scan()} disabled={scanning} title={t('Hämtar avsändare för de 2 000 senaste mejlen i varje inkorg och arkiv')}>
            <I.Refresh size={14} /> {scanning ? t('Går igenom…') : t('Gå igenom fler mejl')}
          </button>
        </div>
      </header>

      <div className="clean-tools">
        <div className="clean-filters" role="tablist" aria-label={t('Kategori')}>
          {FILTERS.map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} className={cx('clean-filter', filter === f && 'on')} onClick={() => setFilter(f)}>
              {f === 'all' ? t('Alla') : t(CATEGORY_LABEL[f])}
              <span className="clean-count">{counts[f] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="clean-tools-right">
          {accounts.length > 1 && (
            <select id="clean-account" className="clean-sort" value={scope} onChange={(e) => chooseAccount(e.target.value)} aria-label={t('Konto')}>
              <option value="">{t('Alla konton')}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          <div className="search-wrap clean-search">
            <I.Search size={14} />
            <input type="search" placeholder={t('Sök avsändare')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select className="clean-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t('Sortera')}>
            <option value="total">{t('Flest mejl')}</option>
            <option value="unread">{t('Flest olästa')}</option>
            <option value="last">{t('Senast')}</option>
          </select>
        </div>
      </div>

      <div className="clean-list">
        {senders && shown.length === 0 && <div className="empty">{q ? t('Inga avsändare matchar.') : t('Inget att städa här.')}</div>}
        {shown.map((s) => {
          const unreadPct = s.total ? Math.round((s.unread / s.total) * 100) : 0;
          const working = busy[s.address];
          return (
            <div key={s.address} className="clean-row" data-address={s.address}>
              <div className="avatar" style={{ background: avatarColor(s.address) }}>
                {initials({ name: s.name, address: s.address })}
              </div>
              <div className="clean-who">
                <div className="clean-name">
                  <span className="clean-title">{who(s)}</span>
                  <span className={cx('clean-tag', `tag-${s.category}`)}>{t(CATEGORY_LABEL[s.category])}</span>
                  {s.rule && <span className="clean-tag tag-rule">{s.rule === 'archive' ? t('Arkiveras automatiskt') : t('Raderas automatiskt')}</span>}
                  {s.unsubscribed && <span className="clean-tag tag-done">{t('Avregistrerad')}</span>}
                </div>
                <div className="clean-sub">
                  {s.name && <span>{s.address}</span>}
                  {s.subject && <span className="clean-subject">{s.subject}</span>}
                </div>
              </div>
              <div className="clean-stats">
                <strong>{mails(s.total)}</strong>
                <span>
                  {t('{pct}\u00a0% olästa', { pct: unreadPct })} · {listDate(s.last)}
                </span>
              </div>
              <div className="clean-actions">
                {working ? (
                  <span className="muted small">{working}</span>
                ) : confirm === s.address ? (
                  <>
                    <span className="small">{t('Flytta {mails} till papperskorgen?', { mails: mails(s.total) })}</span>
                    <button className="btn small" onClick={() => setConfirm(null)}>
                      {t('Avbryt')}
                    </button>
                    <button
                      className="btn small danger"
                      onClick={() => {
                        setConfirm(null);
                        void bulk(s, 'trash');
                      }}
                    >
                      {t('Radera')}
                    </button>
                  </>
                ) : (
                  <>
                    {(s.unsubscribe || s.category !== 'personal') && !s.unsubscribed && (
                      <button className="btn small primary" onClick={() => void unsubscribe(s)}>
                        {t('Avregistrera')}
                      </button>
                    )}
                    <button className="icon-btn" aria-label={t('Arkivera alla från {who}', { who: who(s) })} title={t('Arkivera alla')} onClick={() => void bulk(s, 'archive')}>
                      <I.Archive size={17} />
                    </button>
                    <button className="icon-btn" aria-label={t('Radera alla från {who}', { who: who(s) })} title={t('Radera alla')} onClick={() => setConfirm(s.address)}>
                      <I.Trash size={17} />
                    </button>
                    <button
                      className="icon-btn more-btn"
                      aria-label={t('Fler val för {who}', { who: who(s) })}
                      onClick={(e) => {
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        setMenu({ s, x: r.right - 240, y: r.bottom + 4 });
                      }}
                    >
                      <span className="dots">···</span>
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {menu && (
        <PopMenu
          x={menu.x}
          y={menu.y}
          label={t('Fler val')}
          onClose={() => setMenu(null)}
          sections={[
            {
              title: t('Nya mejl'),
              items: [
                { label: t('Arkivera alltid'), hint: menu.s.rule === 'archive' ? t('På') : undefined, onPick: () => void rule(menu.s, 'archive') },
                { label: t('Radera alltid'), danger: true, hint: menu.s.rule === 'trash' ? t('På') : undefined, onPick: () => void rule(menu.s, 'trash') },
                ...(menu.s.rule ? [{ label: t('Ta bort regeln'), onPick: () => void rule(menu.s, null) }] : [])
              ]
            },
            {
              items: [
                ...(menu.s.unsubscribed ? [] : [{ label: t('Avregistrera'), onPick: () => void unsubscribe(menu.s) }]),
                { label: t('Visa mejlen'), onPick: () => onShowMail(menu.s.address) },
                {
                  label: t('Behåll, visa inte här'),
                  onPick: () => void run(menu.s, t('Sparar…'), async () => (await api.cleanKeep(menu.s.address, true), t('{who} visas inte längre i Städa.', { who: who(menu.s) })))
                }
              ]
            }
          ]}
        />
      )}
    </section>
  );
}
