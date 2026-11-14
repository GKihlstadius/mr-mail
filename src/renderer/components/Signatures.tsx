import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccountConfig, Signature } from '../../shared/types';
import { buildFrameDocument, createSanitizer } from '../../shared/sanitize';
import { newSignatureId, suggestAccount, suggestName } from '../../shared/signatures';
import { api, type SparkExport } from '../api';
import { cx } from '../util';
import { RichEditor, cleanHtml, type RichEditorHandle } from './RichEditor';
import { t, tn, getLang } from '../../shared/i18n';
import * as I from './Icons';

const sanitize = createSanitizer(window as any);

// Signaturen som den ser ut i ett mejl: en kort hälsning och signaturen under, i samma låsta ram som läsvyn.
export function SignaturePreview({ html, compact }: { html: string; compact?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(compact ? 96 : 150);
  const doc = useMemo(() => {
    const body = compact ? html : `<div>${t('Hej!')}</div><div><br></div><div>${t('Tack för i dag, vi hörs snart.')}</div><div><br></div>${html}`;
    const clean = sanitize(body || `<div style="color:#8a8a8e">${t('Ingen signatur')}</div>`, { allowRemote: true }).html;
    return buildFrameDocument(clean, { allowRemote: true, dark: false }).replace('padding:24px 28px', compact ? 'padding:12px 14px' : 'padding:16px 20px');
  }, [html, compact, getLang()]);
  const measure = () => {
    const d = frame.current?.contentDocument;
    if (d?.body) setHeight(Math.min(compact ? 200 : 360, Math.max(compact ? 60 : 110, d.body.scrollHeight + 2)));
  };
  useEffect(() => {
    // Bilder och typsnitt kan ändra höjden efter första mätningen.
    const timers = [150, 600, 1500].map((ms) => window.setTimeout(measure, ms));
    return () => timers.forEach(clearTimeout);
  }, [doc]);
  return (
    <iframe
      ref={frame}
      className="signature-preview"
      title={t('Förhandsvisning')}
      sandbox="allow-same-origin"
      srcDoc={doc}
      style={{ height }}
      onLoad={() => {
        measure();
        // Bilder laddar efter dokumentet, mät igen när de är på plats.
        frame.current?.contentDocument?.querySelectorAll('img').forEach((img) => img.addEventListener('load', measure));
      }}
    />
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
}

interface ImportProps {
  data: SparkExport;
  accounts: AccountConfig[];
  signatures: Signature[];
  onClose(): void;
  onDone(count: number): void;
}

// Import av signaturer från Spark: förhandsvisning, namn och konto per signatur.
export function SparkImportDialog({ data, accounts, signatures, onClose, onDone }: ImportProps) {
  const [rows, setRows] = useState(() =>
    data.signatures.map((s) => {
      const already = signatures.some((x) => x.sparkId === s.sparkId);
      return { sig: s, name: suggestName(s, accounts), accountId: already ? '' : suggestAccount(s, accounts), include: !already, already };
    })
  );
  const [busy, setBusy] = useState(false);
  useEscape(onClose);
  const file = data.path.split(/[\\/]/).pop();

  const run = async () => {
    setBusy(true);
    const added: Signature[] = [];
    const assign: [string, string][] = [];
    for (const r of rows) {
      if (!r.include) continue;
      const sig: Signature = { id: newSignatureId(), name: r.name.trim() || t('Signatur från Spark'), html: cleanHtml(r.sig.html, { allowRemote: true }), sparkId: r.sig.sparkId };
      added.push(sig);
      if (r.accountId) assign.push([r.accountId, sig.id]);
    }
    // Färska signaturer från huvudprocessen, ifall de nyss sparats i redigeraren.
    const current = (await api.state()).settings.signatures;
    await api.saveSettings({ signatures: [...current, ...added], sparkOffered: true });
    for (const [acc, sig] of assign) await api.setAccountSignature(acc, sig);
    setBusy(false);
    onDone(added.length);
  };

  const skip = async () => {
    await api.saveSettings({ sparkOffered: true });
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal spark-import" role="dialog" aria-modal="true" aria-label={t('Signaturer från Spark')}>
        <header className="modal-head">
          <h2>{t('Signaturer från Spark')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('Stäng')}>
            <I.Close size={16} />
          </button>
        </header>
        <div className="modal-body">
          <p className="muted">
            {t('Hittade {count} i {file}. Välj vilket konto som ska använda vilken. Bilder är länkade och följer med som de är.', {
              count: rows.length === 1 ? t('en signatur') : tn(rows.length, '{n} signatur', '{n} signaturer'),
              file: file ?? ''
            })}
          </p>
          {rows.map((r, i) => (
            <div className={cx('import-card', !r.include && 'off')} key={r.sig.sparkId}>
              <label className="check import-include">
                <input type="checkbox" checked={r.include} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))} />
                <span>{r.already ? t('Redan importerad, importera igen') : t('Importera')}</span>
              </label>
              <SignaturePreview html={r.sig.html} compact />
              <div className="field-pair">
                <label className="field">
                  <span>{t('Namn')}</span>
                  <input value={r.name} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                </label>
                <label className="field">
                  <span>{t('Standard för konto')}</span>
                  <select value={r.accountId} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, accountId: e.target.value } : x)))}>
                    <option value="">{t('Inget konto')}</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.email})
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          ))}
        </div>
        <footer className="modal-foot">
          <span className="grow" />
          <button className="btn" onClick={() => void skip()} disabled={busy}>
            {t('Hoppa över')}
          </button>
          <button className="btn primary" onClick={() => void run()} disabled={busy || !rows.some((r) => r.include)}>
            {t('Importera')}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface EditorProps {
  accounts: AccountConfig[];
  signatures: Signature[];
  onClose(): void;
  onImport(data: SparkExport): void;
}

// Signaturer: lista, redigering i rik text eller HTML, förhandsvisning som i mejlet och standard per konto.
export function SignaturesDialog({ accounts, signatures, onClose, onImport }: EditorProps) {
  const [list, setList] = useState<Signature[]>(signatures);
  const [selected, setSelected] = useState<string | null>(signatures[0]?.id ?? null);
  const [mode, setMode] = useState<'rich' | 'html'>('rich');
  const [defaults, setDefaults] = useState<Record<string, string>>(() => Object.fromEntries(accounts.map((a) => [a.id, a.signatureId ?? ''])));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editor = useRef<RichEditorHandle>(null);
  useEscape(onClose);

  const current = list.find((s) => s.id === selected) ?? null;
  const update = (patch: Partial<Signature>) => current && setList(list.map((s) => (s.id === current.id ? { ...s, ...patch } : s)));

  const add = () => {
    const sig: Signature = { id: newSignatureId(), name: t('Signatur {n}', { n: list.length + 1 }), html: '' };
    setList([...list, sig]);
    setSelected(sig.id);
    setMode('rich');
  };

  const remove = () => {
    if (!current) return;
    const rest = list.filter((s) => s.id !== current.id);
    setList(rest);
    setDefaults(Object.fromEntries(Object.entries(defaults).map(([a, s]) => [a, s === current.id ? '' : s])));
    setSelected(rest[0]?.id ?? null);
  };

  const persist = async () => {
    const clean = list.map((s) => ({ ...s, name: s.name.trim() || t('Namnlös'), html: cleanHtml(s.html, { allowRemote: true }) }));
    await api.saveSettings({ signatures: clean });
    for (const a of accounts) if ((a.signatureId ?? '') !== defaults[a.id] || a.signatureId === undefined) await api.setAccountSignature(a.id, defaults[a.id]);
  };

  // Sparar det som redigerats innan importen öppnas, så att inget går förlorat.
  const importSpark = async () => {
    setError(null);
    try {
      const data = (await api.sparkFind()) ?? (await api.sparkPick());
      if (!data) return;
      setBusy(true);
      await persist();
      setBusy(false);
      onImport(data);
    } catch (e: any) {
      setBusy(false);
      setError(e.message);
    }
  };

  const save = async () => {
    setBusy(true);
    await persist();
    setBusy(false);
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal signatures-modal" role="dialog" aria-modal="true" aria-label={t('Signaturer')}>
        <header className="modal-head">
          <h2>{t('Signaturer')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('Stäng')}>
            <I.Close size={16} />
          </button>
        </header>
        <div className="sig-layout">
          <aside className="sig-list">
            <div className="sig-items" role="listbox" aria-label={t('Signaturer')}>
              {list.map((s) => (
                <button key={s.id} role="option" aria-selected={s.id === selected} className={cx('sig-item', s.id === selected && 'on')} onClick={() => setSelected(s.id)}>
                  <span className="sig-name">{s.name || t('Namnlös')}</span>
                  <span className="sig-used">
                    {accounts
                      .filter((a) => defaults[a.id] === s.id)
                      .map((a) => a.name)
                      .join(', ') || t('Inget konto')}
                  </span>
                </button>
              ))}
              {list.length === 0 && <p className="muted small sig-empty">{t('Inga signaturer än.')}</p>}
            </div>
            <div className="sig-list-actions">
              <button className="btn small" onClick={add}>
                {t('Ny signatur')}
              </button>
              <button className="btn small ghost spark-import-btn" onClick={() => void importSpark()}>
                {t('Importera från Spark')}
              </button>
            </div>
          </aside>
          <section className="sig-edit">
            {current ? (
              <>
                <div className="sig-edit-head">
                  <input className="sig-title" value={current.name} onChange={(e) => update({ name: e.target.value })} aria-label={t('Signaturens namn')} />
                  <div className="segmented small" role="radiogroup" aria-label={t('Redigera som')}>
                    <button className={cx(mode === 'rich' && 'on')} role="radio" aria-checked={mode === 'rich'} onClick={() => setMode('rich')}>
                      {t('Rik text')}
                    </button>
                    <button className={cx(mode === 'html' && 'on')} role="radio" aria-checked={mode === 'html'} onClick={() => setMode('html')}>
                      HTML
                    </button>
                  </div>
                  <button className="icon-btn" onClick={remove} aria-label={t('Ta bort signaturen')} title={t('Ta bort signaturen')}>
                    <I.Trash size={15} />
                  </button>
                </div>
                {mode === 'rich' ? (
                  <div className="signature-editor">
                    <RichEditor
                      key={current.id}
                      ref={editor}
                      initialHtml={current.html}
                      allowRemote
                      label={t('Signatur')}
                      placeholder={t('Skriv signaturen, eller klistra in den')}
                      onChange={() => update({ html: editor.current?.getHtml() ?? '' })}
                    />
                  </div>
                ) : (
                  <textarea
                    key={current.id}
                    className="sig-html"
                    value={current.html}
                    onChange={(e) => update({ html: e.target.value })}
                    spellCheck={false}
                    aria-label={t('Signaturens HTML')}
                    placeholder="<table>…</table>"
                  />
                )}
                <div className="section-title">{t('Som i mejlet')}</div>
                <SignaturePreview html={current.html} />
              </>
            ) : (
              <p className="muted sig-empty">{t('Skapa en signatur eller importera dina från Spark.')}</p>
            )}
          </section>
        </div>
        <div className="sig-defaults">
          <div className="section-title">{t('Standardsignatur per konto')}</div>
          {accounts.map((a) => (
            <label className="sig-default" key={a.id}>
              <span className="account-swatch" style={{ background: a.color }} />
              <span className="grow">
                {a.name} <span className="muted small">{a.email}</span>
              </span>
              <select value={defaults[a.id] ?? ''} onChange={(e) => setDefaults({ ...defaults, [a.id]: e.target.value })} aria-label={t('Signatur för {name}', { name: a.name })}>
                <option value="">{t('Ingen')}</option>
                {list.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || t('Namnlös')}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {error && (
            <div className="form-errors" role="alert">
              {error}
            </div>
          )}
        </div>
        <footer className="modal-foot">
          <span className="grow" />
          <button className="btn" onClick={onClose} disabled={busy}>
            {t('Avbryt')}
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={busy}>
            {t('Spara')}
          </button>
        </footer>
      </div>
    </div>
  );
}
