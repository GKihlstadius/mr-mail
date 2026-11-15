import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AiEngine } from '../../shared/types';
import { chatSupported, parseChatText, type ChatRefs, type ChatStep, type Inline } from '../../shared/chat';
import { APP_NAME } from '../../shared/brand';
import { t } from '../../shared/i18n';
import { api } from '../api';
import { cx } from '../util';
import * as I from './Icons';

type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; refs: ChatRefs; steps: ChatStep[] }
  | { role: 'error'; text: string };

interface Props {
  open: boolean;
  engine: AiEngine;
  onClose(): void;
  onOpenMail(id: string): void;
  onOpenEvent(id: string): void;
}

const newId = () => `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function Steps({ steps }: { steps: ChatStep[] }) {
  if (!steps.length) return null;
  return (
    <ul className="chat-steps">
      {steps.map((s) => (
        <li key={s.id} className={cx('chat-step', !s.done && 'busy', s.done && s.ok === false && 'failed')}>
          {s.done ? s.ok === false ? <I.Close size={11} /> : <I.Check size={11} /> : <span className="chat-spinner" aria-hidden="true" />}
          <span>{s.label}</span>
        </li>
      ))}
    </ul>
  );
}

// Svaret som text med klickbara mejl och händelser.
function Answer({ text, refs, onOpenMail, onOpenEvent }: { text: string; refs: ChatRefs; onOpenMail(id: string): void; onOpenEvent(id: string): void }) {
  const inline = (parts: Inline[]): ReactNode =>
    parts.map((p, i) =>
      p.kind === 'text' ? (
        <Fragment key={i}>{p.text}</Fragment>
      ) : p.kind === 'bold' ? (
        <strong key={i}>{p.text}</strong>
      ) : (
        <button
          key={i}
          className={cx('chat-ref', p.ref === 'event' && 'event')}
          data-ref={p.ref}
          onClick={() => (p.ref === 'mail' ? onOpenMail(p.id) : onOpenEvent(p.id))}
          title={p.ref === 'mail' ? t('Öppna mejlet') : t('Visa i kalendern')}
        >
          {p.ref === 'mail' ? <I.Envelope size={12} /> : <I.Calendar size={12} />}
          {p.text}
        </button>
      )
    );
  return (
    <div className="chat-answer">
      {parseChatText(text, refs).map((b, i) =>
        b.kind === 'p' ? (
          <p key={i}>
            {b.lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        ) : b.kind === 'ul' ? (
          <ul key={i}>
            {b.items.map((it, j) => (
              <li key={j}>{inline(it)}</li>
            ))}
          </ul>
        ) : (
          <ol key={i}>
            {b.items.map((it, j) => (
              <li key={j}>{inline(it)}</li>
            ))}
          </ol>
        )
      )}
    </div>
  );
}

// Fråga Mr Mail: en lugn chattpanel från höger. Samtalet finns kvar tills Ny chatt eller omstart.
export function ChatPanel({ open, engine, onClose, onOpenMail, onOpenEvent }: Props) {
  const [chatId, setChatId] = useState(newId);
  const current = useRef(chatId);
  current.current = chatId;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [live, setLive] = useState<ChatStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const supported = chatSupported(engine);

  useEffect(
    () =>
      api.on('chat-step', (id: string, step: ChatStep) => {
        if (id !== chatId) return;
        setLive((list) => {
          const i = list.findIndex((s) => s.id === step.id);
          return i >= 0 ? list.map((s, j) => (j === i ? step : s)) : [...list, step];
        });
      }),
    [chatId]
  );

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 60);
  }, [open]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, live, busy]);

  const send = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || busy || !supported) return;
    setInput('');
    setLive([]);
    setTurns((list) => [...list, { role: 'user', text }]);
    setBusy(true);
    const id = chatId;
    try {
      const res = await api.chatSend(id, text);
      if (current.current === id) setTurns((list) => [...list, { role: 'assistant', text: res.text, refs: res.refs, steps: res.steps }]);
    } catch (e: any) {
      if (current.current === id) setTurns((list) => [...list, { role: 'error', text: e.message }]);
    } finally {
      if (current.current === id) {
        setBusy(false);
        setLive([]);
      }
    }
  };

  const reset = () => {
    void api.chatReset(chatId).catch(() => undefined);
    setChatId(newId());
    setTurns([]);
    setLive([]);
    setBusy(false);
    setInput('');
    inputRef.current?.focus();
  };

  const suggestions = [t('Vad behöver jag svara på i dag?'), t('Vad har jag för möten i morgon?'), t('Sammanfatta mina olästa mejl')];

  return (
    <aside className={cx('chat-panel', open && 'open')} aria-label={t('Fråga {app}', { app: APP_NAME })} aria-hidden={!open} inert={!open}>
      <header className="chat-head">
        <div className="chat-title">
          <I.Sparkle size={16} />
          <span>{t('Fråga {app}', { app: APP_NAME })}</span>
        </div>
        <div className="chat-head-actions">
          <button className="btn small ghost" id="chat-new" onClick={reset} disabled={!turns.length && !busy}>
            {t('Ny chatt')}
          </button>
          <button className="icon-btn" onClick={onClose} aria-label={t('Stäng')} title={t('Stäng (Ctrl+J)')}>
            <I.Close size={15} />
          </button>
        </div>
      </header>
      <div className="chat-scroll" ref={scrollRef}>
        {!supported && (
          <div className="chat-note" role="note">
            {t('Chatten kräver ChatGPT med API-nyckel, en lokal modell eller en egen server.')}
          </div>
        )}
        {supported && !turns.length && !busy && (
          <div className="chat-empty">
            <div className="chat-empty-title">{t('Vad kan jag hjälpa till med?')}</div>
            <div className="subtle">{t('Jag kan söka och läsa i dina mejl, skriva utkast och boka i kalendern. Inget skickas utan att du säger ja.')}</div>
            <div className="chat-suggestions">
              {suggestions.map((s) => (
                <button key={s} className="pill" onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((turn, i) =>
          turn.role === 'user' ? (
            <div key={i} className="chat-msg user">
              {turn.text}
            </div>
          ) : turn.role === 'error' ? (
            <div key={i} className="chat-msg error" role="alert">
              {turn.text}
            </div>
          ) : (
            <div key={i} className="chat-msg assistant">
              <Steps steps={turn.steps} />
              <Answer text={turn.text} refs={turn.refs} onOpenMail={onOpenMail} onOpenEvent={onOpenEvent} />
            </div>
          )
        )}
        {busy && (
          <div className="chat-msg assistant thinking">
            <Steps steps={live} />
            {!live.some((s) => !s.done) && <span className="chat-dots" aria-label={t('Tänker…')}><span /><span /><span /></span>}
          </div>
        )}
      </div>
      <footer className="chat-foot">
        <textarea
          ref={inputRef}
          id="chat-input"
          rows={1}
          value={input}
          disabled={!supported}
          placeholder={t('Fråga om dina mejl eller kalendern')}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              onClose();
            }
          }}
        />
        {busy ? (
          <button className="icon-btn chat-send" onClick={() => void api.chatCancel(chatId).catch(() => undefined)} aria-label={t('Avbryt')} title={t('Avbryt')}>
            <span className="chat-stop" />
          </button>
        ) : (
          <button className="icon-btn chat-send" id="chat-send" onClick={() => void send()} disabled={!input.trim() || !supported} aria-label={t('Skicka')} title={t('Skicka')}>
            <I.Send size={15} />
          </button>
        )}
      </footer>
    </aside>
  );
}
