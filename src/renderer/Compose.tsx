import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountConfig, AiContextInfo, AiEngine, ChatTurn, ComposeDraft, ComposeInit, FullMessage, OutgoingAttachment, OutgoingMessage, Template } from '../shared/types';
import { htmlToText, outgoingHtml, signatureHtml, SIGNATURE_CLASS, textToEditorHtml, signatureBlock } from '../shared/richtext';
import { api } from './api';
import { t, locale } from '../shared/i18n';
import { cx, formatSize, senderName } from './util';
import * as I from './components/Icons';
import { RichEditor, cleanHtml, type RichEditorHandle } from './components/RichEditor';
import { AddressInput } from './components/AddressInput';
import { ENGINE_LABEL, EngineSelect, useSlowNotice } from './components/AiAssist';
import { PopMenu, snoozeTimes, whenText } from './components/PopMenu';

interface AiLogEntry {
  role: 'user' | 'assistant' | 'error';
  text: string;
  ms?: number;
}

const QUICK = ['Kortare', 'Mer formell', 'Mer personlig', 'Tacka extra', 'På engelska'];
const AUTOSAVE_MS = 10_000;
const timeFmt = (ts: number) => new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(ts);

export function Compose() {
  const [init, setInit] = useState<ComposeInit | null>(null);
  const [source, setSource] = useState<FullMessage | null>(null);
  const [accounts, setAccounts] = useState<AccountConfig[]>([]);
  const [engine, setEngine] = useState<AiEngine>('spark');
  const [draft, setDraft] = useState<ComposeDraft | null>(null);
  const [showCc, setShowCc] = useState(false);
  const [attachments, setAttachments] = useState<OutgoingAttachment[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiLog, setAiLog] = useState<AiLogEntry[]>([]);
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [instruction, setInstruction] = useState('');
  const [undo, setUndo] = useState<string | null>(null);
  const [aiContext, setAiContext] = useState<AiContextInfo | null>(null);
  const [followUp, setFollowUp] = useState(0);
  const [laterMenu, setLaterMenu] = useState<{ x: number; y: number } | null>(null);
  const [pickTime, setPickTime] = useState<string | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [tplMenu, setTplMenu] = useState<{ x: number; y: number } | null>(null);
  const [tplName, setTplName] = useState<string | null>(null);
  const caret = useRef<Range | null>(null);
  const followRef = useRef(0);
  followRef.current = followUp;
  const slow = useSlowNotice(aiBusy, engine);
  const editor = useRef<RichEditorHandle>(null);
  const engineRef = useRef<AiEngine>('spark');
  const started = useRef(false);
  const dirty = useRef(false);
  const draftKey = useRef<string | undefined>(undefined);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const done = useRef(false);
  const draftRef = useRef<ComposeDraft | null>(null);
  const attRef = useRef<OutgoingAttachment[]>([]);
  draftRef.current = draft;
  attRef.current = attachments;

  const markDirty = useCallback(() => {
    dirty.current = true;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [st, ci] = await Promise.all([api.state(), api.composeInit()]);
        setAccounts(st.accounts);
        setTemplates(st.settings.templates ?? []);
        setEngine(st.settings.aiEngine);
        engineRef.current = st.settings.aiEngine;
        setInit(ci.init);
        setSource(ci.source);
        const d = { ...ci.draft };
        if (ci.init.to) d.to = ci.init.to;
        // Eget utkast: länkade bilder (till exempel signaturens logotyp) behålls.
        if (ci.init.mode === 'draft') d.html = cleanHtml(d.html, { allowRemote: true });
        if (ci.init.prefill) {
          const acc = st.accounts.find((a) => a.id === d.accountId);
          const sig = signatureBlock(acc?.signature);
          d.html = textToEditorHtml(ci.init.prefill) + (sig ? `<div><br></div>${sig}` : '');
          d.text = ci.init.prefill;
        }
        setDraft(d);
        setShowCc(!!d.cc || !!d.bcc);
        setAiOpen(!!ci.source && ci.init.mode !== 'forward' && ci.init.mode !== 'draft');
        if (ci.init.prefill) dirty.current = true;
        document.title = windowTitle(ci.init, d);
        if (ci.init.suggest && !started.current) {
          started.current = true;
          void suggest(ci.init, d, [], undefined);
        } else {
          setTimeout(() => (ci.init.mode === 'new' && !d.to ? document.getElementById('to')?.focus() : editor.current?.focus()), 60);
        }
      } catch (e: any) {
        setError(e.message);
      }
    })();
  }, []);

  const bodyText = () => editor.current?.getText() ?? '';

  // Mallar: markören sparas innan menyn öppnas, så att texten hamnar där man skrev.
  const rememberCaret = () => {
    const sel = window.getSelection();
    const root = editor.current?.element();
    caret.current = sel && sel.rangeCount && root?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  };

  const insertTemplate = (t: Template) => {
    setTplMenu(null);
    const root = editor.current?.element();
    if (!root) return;
    root.focus();
    const sel = window.getSelection();
    let range = caret.current;
    if (!range || !root.contains(range.startContainer)) {
      range = document.createRange();
      range.setStart(root, 0);
      range.collapse(true);
    }
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.execCommand('insertHTML', false, textToEditorHtml(t.text));
    markDirty();
  };

  // Texten som mall, utan signaturen.
  const editorTextWithoutSignature = () => {
    const root = editor.current?.element();
    if (!root) return '';
    const clone = root.cloneNode(true) as HTMLElement;
    clone.querySelector(`.${SIGNATURE_CLASS}`)?.remove();
    return htmlToText(clone).replace(/\n{3,}/g, '\n\n').trim();
  };

  const saveTemplate = async () => {
    const name = (tplName ?? '').trim();
    const text = editorTextWithoutSignature();
    if (!name) return;
    if (!text) {
      setError(t('Skriv texten först, sedan kan den sparas som mall.'));
      setTplName(null);
      return;
    }
    const next = [...templates.filter((t) => t.name !== name), { id: `${Date.now().toString(36)}`, name, text }];
    try {
      await api.saveSettings({ templates: next });
      setTemplates(next);
      setTplName(null);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const removeTemplate = async (id: string) => {
    const next = templates.filter((t) => t.id !== id);
    try {
      await api.saveSettings({ templates: next });
      setTemplates(next);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const outgoing = (): OutgoingMessage => {
    const d = draftRef.current!;
    const body = editor.current?.getHtml() ?? '';
    const text = bodyText();
    return {
      accountId: d.accountId,
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      subject: d.subject,
      text: d.quote ? `${text.trimEnd()}\n\n${d.quote}` : text,
      html: outgoingHtml(body, d.quoteHtml),
      inReplyTo: d.inReplyTo,
      references: d.references,
      attachments: attRef.current,
      forwardOf: d.forwardOf,
      draftKey: draftKey.current,
      draftOf: d.draftOf,
      followUpDays: followRef.current || undefined
    };
  };

  // Har fönstret något värt att spara? En tom signatur räknas inte.
  const hasContent = () => {
    const d = draftRef.current;
    if (!d) return false;
    const sig = editor.current?.element()?.querySelector(`.${SIGNATURE_CLASS}`)?.textContent ?? '';
    const text = bodyText().replace(sig.trim(), '').trim();
    return !!(d.to.trim() || d.subject.trim() || text || attRef.current.length);
  };

  // Utkast sparas i tur och ordning så att två versioner aldrig skrivs samtidigt.
  const saveDraft = (silent: boolean) => {
    const run = async () => {
      if (done.current || !draftRef.current) return;
      if (!silent) setBusy('Sparar utkast…');
      dirty.current = false;
      try {
        draftKey.current = await api.saveDraft(outgoing());
        setSavedAt(Date.now());
        if (!silent) {
          setBusy('Utkastet är sparat');
          setTimeout(() => setBusy(null), 1500);
        }
      } catch (e: any) {
        dirty.current = true;
        if (!silent) {
          setError(e.message);
          setBusy(null);
        }
      }
    };
    const next = saving.current.then(run, run);
    saving.current = next;
    return next;
  };

  useEffect(() => {
    const t = setInterval(() => {
      if (dirty.current && !busy && !aiBusy && hasContent()) void saveDraft(true);
    }, AUTOSAVE_MS);
    return () => clearInterval(t);
  }, [busy, aiBusy]);

  useEffect(
    () =>
      api.on('before-close', async () => {
        if (!done.current && dirty.current && hasContent()) await saveDraft(true);
        done.current = true;
        api.closeWindow();
      }),
    []
  );

  const suggest = async (ci: ComposeInit, d: ComposeDraft, hist: ChatTurn[], instr?: string) => {
    if (!ci.sourceId) return;
    setAiOpen(true);
    setAiBusy(true);
    if (instr) setAiLog((l) => [...l, { role: 'user', text: instr }]);
    const before = editor.current?.getHtml() ?? d.html;
    try {
      const res = await api.ai({ sourceId: ci.sourceId, accountId: d.accountId, draft: instr ? bodyText() : undefined, history: hist, instruction: instr, engine: engineRef.current });
      if (res.context) setAiContext(res.context);
      if (res.ok && res.text) {
        setUndo(before);
        const acc = accounts.find((a) => a.id === (draftRef.current?.accountId ?? d.accountId));
        const sig = signatureBlock(acc?.signature);
        // Ett snabbt svar kan komma innan textfältet har ritats första gången: vänta in det,
        // annars skrivs förslaget över av starttexten.
        for (let i = 0; i < 100 && !editor.current; i++) await new Promise((r) => setTimeout(r, 20));
        await new Promise((r) => setTimeout(r, 0));
        editor.current?.setHtml(textToEditorHtml(res.text) + (sig ? `<div><br></div>${sig}` : ''));
        markDirty();
        const newHist: ChatTurn[] = instr
          ? [...hist, { role: 'user', content: `Ändra utkastet så här: ${instr}` }, { role: 'assistant', content: res.text }]
          : [{ role: 'assistant', content: res.text }];
        setHistory(newHist);
        setAiLog((l) => [...l, { role: 'assistant', text: instr ? t('Utkastet är ändrat.') : t('Utkastet är klart. Redigera fritt innan du skickar.'), ms: res.ms }]);
      } else {
        setAiLog((l) => [...l, { role: 'error', text: res.error ?? t('Något gick fel.') }]);
      }
    } catch (e: any) {
      setAiLog((l) => [...l, { role: 'error', text: e.message }]);
    } finally {
      setAiBusy(false);
    }
  };

  const ask = (text: string) => {
    if (!init || !draft || !text.trim() || aiBusy) return;
    setInstruction('');
    const hasDraft = history.length > 0 || bodyText().trim().length > 20;
    if (!hasDraft) void suggest(init, draft, [], undefined);
    else void suggest(init, draft, history, text.trim());
  };

  const send = async (at?: number) => {
    if (!draft || (busy && busy !== 'Utkastet är sparat')) return;
    if (at !== undefined && at < Date.now() + 60_000) {
      setError(t('Välj en tid minst en minut fram.'));
      return;
    }
    if (!draft.to.trim() && !draft.cc.trim() && !draft.bcc.trim()) {
      setError(t('Lägg till minst en mottagare.'));
      return;
    }
    setBusy(at ? 'Schemalägger…' : 'Skickar…');
    setError(null);
    try {
      await saving.current;
      done.current = true;
      await api.send(outgoing(), at);
      api.closeWindow();
    } catch (e: any) {
      done.current = false;
      setError(e.message);
      setBusy(null);
    }
  };

  const discard = async () => {
    done.current = true;
    try {
      await saving.current;
      if (draftKey.current || draft?.draftOf) await api.discardDraft(outgoing());
    } catch {
      /* utkastet finns kvar på servern, inget att göra */
    }
    api.closeWindow();
  };

  const addFiles = (files: OutgoingAttachment[]) => {
    setAttachments((a) => [...a, ...files.filter((f) => !a.some((x) => x.path === f.path))]);
    markDirty();
  };

  const attach = async () => addFiles(await api.pickFiles());

  const onDrop = async (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    try {
      const withPath = files.map((f) => ({ f, path: api.pathForFile(f) }));
      const onDisk = withPath.filter((x) => x.path).map((x) => x.path);
      const added = onDisk.length ? await api.fileInfo(onDisk) : [];
      for (const x of withPath.filter((x) => !x.path)) added.push(await api.fileFromData(x.f.name, new Uint8Array(await x.f.arrayBuffer())));
      addFiles(added);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const changeAccount = (accountId: string) => {
    const acc = accounts.find((a) => a.id === accountId);
    const root = editor.current?.element();
    if (root) {
      const block = root.querySelector(`.${SIGNATURE_CLASS}`);
      const html = signatureHtml(acc?.signature);
      if (block && html) block.innerHTML = html;
      else if (block) block.remove();
      else if (html) root.insertAdjacentHTML('beforeend', `<div><br></div>${signatureBlock(acc?.signature)}`);
    }
    set({ accountId });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        void send();
      } else if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveDraft(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!draft || !init) {
    return (
      <div className="compose">
        <div className="compose-head drag" />
        {error && <div className="compose-error">{error}</div>}
      </div>
    );
  }

  function set(patch: Partial<ComposeDraft>) {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    markDirty();
  }
  const canAi = !!source && init.mode !== 'new' && init.mode !== 'draft';

  return (
    <div
      className={cx('compose', aiOpen && canAi && 'with-ai')}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDropCapture={onDrop}
    >
      <header className="compose-head drag">
        <div className="compose-title">{windowTitle(init, draft)}</div>
        <div className="no-drag head-actions">
          {savedAt && !busy && <span className="saved-at">{t('Utkast sparat {time}', { time: timeFmt(savedAt) })}</span>}
          <select
            className="engine-select follow-select"
            value={followUp}
            onChange={(e) => setFollowUp(Number(e.target.value))}
            aria-label={t('Följ upp om inget svar')}
            title={t('Påminn mig om ingen svarar')}
          >
            <option value={0}>{t('Ingen uppföljning')}</option>
            <option value={1}>{t('Följ upp om 1 dag')}</option>
            <option value={3}>{t('Följ upp om 3 dagar')}</option>
            <option value={7}>{t('Följ upp om 1 vecka')}</option>
          </select>
          {canAi && (
            <button className={cx('icon-btn', aiOpen && 'on')} onClick={() => setAiOpen(!aiOpen)} title={t('AI-hjälp')} aria-label={t('AI-hjälp')}>
              <I.Sparkle size={17} />
            </button>
          )}
          <button
            className={cx('icon-btn', 'templates-btn', tplMenu && 'on')}
            title={t('Mallar')}
            aria-label={t('Mallar')}
            onMouseDown={rememberCaret}
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setTplMenu({ x: r.left, y: r.bottom + 4 });
            }}
          >
            <I.Stack size={17} />
          </button>
          <button className="icon-btn" onClick={attach} title={t('Bifoga fil')} aria-label={t('Bifoga fil')}>
            <I.Paperclip size={17} />
          </button>
          <button className="icon-btn" onClick={discard} title={t('Släng utkastet')} aria-label={t('Släng utkastet')}>
            <I.Trash size={17} />
          </button>
          <button className="btn ghost" onClick={() => saveDraft(false)} disabled={!!busy}>
            {t('Spara utkast')}
          </button>
          <div className="send-group">
            <button className="btn primary send" onClick={() => void send()} disabled={busy === 'Skickar…'} title={t('Skicka (Ctrl+Enter)')}>
              <I.Send size={15} />
              <span>{t('Skicka')}</span>
            </button>
            <button
              className="btn primary send-later"
              aria-label={t('Skicka senare')}
              title={t('Skicka senare')}
              disabled={busy === 'Skickar…'}
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setLaterMenu({ x: r.right - 240, y: r.bottom + 4 });
              }}
            >
              <I.Clock size={15} />
            </button>
          </div>
        </div>
      </header>
      {pickTime !== null && (
        <div className="pick-time no-drag">
          <span>{t('Skicka')}</span>
          <input type="datetime-local" value={pickTime} onChange={(e) => setPickTime(e.target.value)} aria-label={t('Datum och tid')} />
          <button className="btn small" onClick={() => setPickTime(null)}>
            {t('Avbryt')}
          </button>
          <button
            className="btn small primary"
            onClick={() => {
              const at = new Date(pickTime).getTime();
              if (Number.isFinite(at)) {
                setPickTime(null);
                void send(at);
              }
            }}
          >
            {t('Schemalägg')}
          </button>
        </div>
      )}
      {tplName !== null && (
        <div className="pick-time no-drag template-name">
          <span>{t('Spara som mall')}</span>
          <input
            id="template-name"
            value={tplName}
            placeholder={t('Namn, till exempel Tack för mejlet')}
            onChange={(e) => setTplName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveTemplate();
              if (e.key === 'Escape') setTplName(null);
            }}
            autoFocus
          />
          <button className="btn small" onClick={() => setTplName(null)}>
            {t('Avbryt')}
          </button>
          <button className="btn small primary" id="template-save" onClick={() => void saveTemplate()} disabled={!tplName.trim()}>
            {t('Spara')}
          </button>
        </div>
      )}
      {tplMenu && (
        <PopMenu
          x={tplMenu.x}
          y={tplMenu.y}
          label={t('Mallar')}
          onClose={() => setTplMenu(null)}
          sections={[
            ...(templates.length
              ? [{ title: t('Infoga mall'), items: templates.map((t) => ({ label: t.name, hint: t.text.split('\n')[0].slice(0, 40), onPick: () => insertTemplate(t) })) }]
              : [{ title: t('Inga mallar än'), items: [] }]),
            { items: [{ label: t('Spara texten som mall…'), onPick: () => setTplName('') }] },
            ...(templates.length
              ? [{ title: t('Ta bort'), items: templates.map((t) => ({ label: t.name, danger: true, onPick: () => void removeTemplate(t.id) })) }]
              : [])
          ]}
        />
      )}
      {laterMenu && (
        <PopMenu
          x={laterMenu.x}
          y={laterMenu.y}
          label={t('Skicka senare')}
          onClose={() => setLaterMenu(null)}
          sections={[
            {
              title: t('Skicka senare'),
              items: [
                ...snoozeTimes().map((t) => ({ label: t.label, hint: whenText(t.due), onPick: () => void send(t.due) })),
                {
                  label: t('Välj datum och tid…'),
                  onPick: () => {
                    const d = new Date(Date.now() + 3600_000);
                    d.setMinutes(0, 0, 0);
                    const pad = (n: number) => String(n).padStart(2, '0');
                    setPickTime(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`);
                  }
                }
              ]
            }
          ]}
        />
      )}

      <div className="compose-main">
        <div className="compose-form">
          {error && <div className="compose-error">{error}</div>}
          {busy && <div className="compose-busy">{t(busy)}</div>}
          <div className="hfield">
            <label htmlFor="from">{t('Från')}</label>
            <select id="from" value={draft.accountId} onChange={(e) => changeAccount(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName ? `${a.displayName} <${a.email}>` : a.email}
                </option>
              ))}
            </select>
          </div>
          <div className="hfield">
            <label htmlFor="to">{t('Till')}</label>
            <AddressInput id="to" value={draft.to} onChange={(to) => set({ to })} />
            {!showCc && (
              <button className="link small" onClick={() => setShowCc(true)}>
                {t('Kopia')}
              </button>
            )}
          </div>
          {showCc && (
            <>
              <div className="hfield">
                <label htmlFor="cc">{t('Kopia')}</label>
                <AddressInput id="cc" value={draft.cc} onChange={(cc) => set({ cc })} />
              </div>
              <div className="hfield">
                <label htmlFor="bcc">{t('Dold kopia')}</label>
                <AddressInput id="bcc" value={draft.bcc} onChange={(bcc) => set({ bcc })} />
              </div>
            </>
          )}
          <div className="hfield">
            <label htmlFor="subject">{t('Ämne')}</label>
            <input
              id="subject"
              value={draft.subject}
              onChange={(e) => {
                set({ subject: e.target.value });
                document.title = windowTitle(init, { ...draft, subject: e.target.value });
              }}
            />
          </div>
          {(attachments.length > 0 || draft.forwardAttachments.length > 0) && (
            <div className="compose-atts">
              {draft.forwardAttachments.map((a) => (
                <span className="chip" key={`f${a.index}`}>
                  <I.Paperclip size={13} /> {a.filename} <span className="muted">{formatSize(a.size)}</span>
                </span>
              ))}
              {attachments.map((a) => (
                <span className="chip" key={a.path}>
                  <I.Paperclip size={13} /> {a.filename} <span className="muted">{formatSize(a.size)}</span>
                  <button
                    className="chip-x"
                    onClick={() => {
                      setAttachments(attachments.filter((x) => x !== a));
                      markDirty();
                    }}
                    aria-label={t('Ta bort {name}', { name: a.filename })}
                  >
                    <I.Close size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="compose-body">
            <RichEditor ref={editor} initialHtml={draft.html} busy={aiBusy} placeholder={aiBusy ? t('AI skriver ett förslag…') : ''} onChange={markDirty} />
            {draft.quoteHtml && <div className="quote-view" dangerouslySetInnerHTML={{ __html: draft.quoteHtml }} />}
          </div>
          {dragging && (
            <div className="drop-overlay">
              <I.Paperclip size={22} />
              <span>{t('Släpp för att bifoga')}</span>
            </div>
          )}
        </div>

        {aiOpen && canAi && (
          <aside className="ai-panel">
            <div className="ai-head">
              <I.Sparkle size={15} />
              <span>{t('AI-hjälp')}</span>
              <EngineSelect
                value={engine}
                disabled={aiBusy}
                onChange={(e) => {
                  setEngine(e);
                  engineRef.current = e;
                  void api.saveSettings({ aiEngine: e }).catch(() => undefined);
                }}
              />
            </div>
            <div className="ai-context">
              {t('Svar till')} <strong>{source ? senderName(source.from) : ''}</strong>. {t('Inget skickas förrän du trycker Skicka.')}
              {aiContext && (
                <div className="ai-context-read">
                  {t('Läser {what}', { what: aiContext.thread > 1 ? t('hela tråden ({n} mejl)', { n: aiContext.thread }) : t('mejlet') })}
                  {aiContext.earlier ? ` ${t('och {n} tidigare mejl med {person}', { n: aiContext.earlier, person: aiContext.person })}` : ''}.
                </div>
              )}
            </div>
            <div className="ai-log">
              {aiLog.length === 0 && !aiBusy && (
                <button className="btn primary wide" onClick={() => suggest(init, draft, [], undefined)}>
                  <I.Sparkle size={15} /> {t('Föreslå svar')}
                </button>
              )}
              {aiLog.map((e, i) => (
                <div key={i} className={cx('bubble', e.role)}>
                  {e.text}
                  {e.ms !== undefined && <span className="ms"> {(e.ms / 1000).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s</span>}
                </div>
              ))}
              {aiBusy && (
                <div className="bubble assistant thinking">
                  <span className="pulse" />
                  {slow ?? (history.length ? t('Skriver om…') : t('Skriver ett förslag med {engine}…', { engine: ENGINE_LABEL[engine] }))}
                </div>
              )}
              {undo !== null && !aiBusy && (
                <button
                  className="link small undo"
                  onClick={() => {
                    editor.current?.setHtml(undo);
                    markDirty();
                    setUndo(null);
                  }}
                >
                  {t('Ångra senaste ändringen')}
                </button>
              )}
            </div>
            <div className="ai-quick">
              {QUICK.map((q) => (
                <button key={q} className="pill" disabled={aiBusy} onClick={() => ask(q)}>
                  {t(q)}
                </button>
              ))}
            </div>
            <form
              className="ai-input"
              onSubmit={(e) => {
                e.preventDefault();
                ask(instruction);
              }}
            >
              <input value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder={t('Be om en ändring…')} disabled={aiBusy} />
              <button className="icon-btn" type="submit" disabled={aiBusy || !instruction.trim()} aria-label={t('Skicka till AI')}>
                <I.Send size={15} />
              </button>
            </form>
          </aside>
        )}
      </div>
    </div>
  );
}

function windowTitle(init: ComposeInit, d: ComposeDraft): string {
  if (init.mode === 'new' || init.mode === 'draft') return d.subject || t('Nytt meddelande');
  return d.subject;
}
