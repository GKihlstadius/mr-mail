import { useEffect, useRef, useState } from 'react';
import type { AiEngine, AiResult, MessageSummary } from '../../shared/types';
import { api } from '../api';
import { cx } from '../util';
import { t, locale } from '../../shared/i18n';
import * as I from './Icons';

// Getters, så att texten översätts när den läses och inte vid import.
export const ENGINE_LABEL: Record<AiEngine, string> = {
  get spark() {
    return t('Egen server');
  },
  get local() {
    return t('Datorns modell');
  },
  get claude() {
    return 'Claude';
  },
  get openai() {
    return 'ChatGPT';
  },
  get codex() {
    return t('ChatGPT (ditt abonnemang)');
  }
};

// Motorer som tas fram automatiskt. De andra kostar per anrop eller tar av ett abonnemang, och körs på begäran.
export const AUTO_ENGINES: AiEngine[] = ['spark', 'local'];

let codexCheck: Promise<boolean> | null = null;
// ChatGPT via abonnemanget visas bara när Codex CLI finns och är inloggat med ChatGPT-konto.
export function useCodexAvailable(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    codexCheck ??= api
      .codexStatus()
      .then((s) => s.chatgpt)
      .catch(() => false);
    let live = true;
    void codexCheck.then((v) => live && setOk(v));
    return () => {
      live = false;
    };
  }, []);
  return ok;
}

export function EngineSelect({ value, onChange, disabled }: { value: AiEngine; onChange(e: AiEngine): void; disabled?: boolean }) {
  const codex = useCodexAvailable();
  const engines = (Object.keys(ENGINE_LABEL) as AiEngine[]).filter((k) => k !== 'codex' || codex || value === 'codex');
  return (
    <select className="engine-select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as AiEngine)} aria-label={t('AI-motor')} title={t('AI-motor')}>
      {engines.map((k) => (
        <option key={k} value={k}>
          {ENGINE_LABEL[k]}
        </option>
      ))}
    </select>
  );
}

// Visar en förklaring när datorns modell tar tid på sig (första anropet startar den, cirka 25 s).
export function useSlowNotice(busy: boolean, engine: AiEngine): string | null {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!busy) return;
    const t = setTimeout(() => setSlow(true), engine === 'local' ? 2500 : 20000);
    return () => clearTimeout(t);
  }, [busy, engine]);
  if (!slow) return null;
  return engine === 'local' ? t('Datorns modell startar. Första svaret tar cirka 25 sekunder.') : t('Det tar längre tid än vanligt…');
}

const fmtMs = (ms: number) => `${(ms / 1000).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;

function contextLine(r: AiResult): string {
  const c = r.context;
  if (!c) return '';
  const parts = [c.thread > 1 ? t('tråden ({n} mejl)', { n: c.thread }) : t('mejlet')];
  if (c.earlier) parts.push(t('{n} tidigare mejl med {person}', { n: c.earlier, person: c.person }));
  return t('Läste {what}', { what: parts.join(` ${t('och')} `) });
}

interface Props {
  message: MessageSummary;
  threadSize: number;
  engine: AiEngine;
  ownEmail?: string;
  isDraft: boolean;
  onEngine(e: AiEngine): void;
  onQuickReply(text: string): void;
}

// Knappar och resultat ovanför mejlet.
export function AiTools({ message, threadSize, engine, onEngine }: Pick<Props, 'message' | 'threadSize' | 'engine' | 'onEngine'>) {
  const [busy, setBusy] = useState<'summary' | 'todo' | null>(null);
  const [result, setResult] = useState<{ task: 'summary' | 'todo'; res: AiResult } | null>(null);
  const seq = useRef(0);
  const slow = useSlowNotice(!!busy, engine);

  useEffect(() => {
    seq.current++;
    setBusy(null);
    setResult(null);
  }, [message.id]);

  const run = async (task: 'summary' | 'todo') => {
    const n = ++seq.current;
    setBusy(task);
    setResult(null);
    try {
      const res = await api.aiTask(message.id, task, engine);
      if (n === seq.current) setResult({ task, res });
    } catch (e: any) {
      if (n === seq.current) setResult({ task, res: { ok: false, error: e.message, engine, ms: 0 } });
    } finally {
      if (n === seq.current) setBusy(null);
    }
  };

  return (
    <div className="ai-tools">
      <div className="ai-tools-row">
        <I.Sparkle size={14} className="ai-tools-icon" />
        <button className={cx('pill', busy === 'summary' && 'on')} disabled={!!busy} onClick={() => run('summary')}>
          {threadSize > 1 ? t('Sammanfatta tråd') : t('Sammanfatta')}
        </button>
        <button className={cx('pill', busy === 'todo' && 'on')} disabled={!!busy} onClick={() => run('todo')}>
          {t('Vad behöver jag göra?')}
        </button>
        <span className="grow" />
        <EngineSelect value={engine} onChange={onEngine} disabled={!!busy} />
      </div>
      {busy && (
        <div className="ai-result busy">
          <span className="pulse" />
          <span>{slow ?? (busy === 'summary' ? t('Sammanfattar…') : t('Letar efter det du behöver göra…'))}</span>
        </div>
      )}
      {result && (
        <div className={cx('ai-result', !result.res.ok && 'error')} role="status">
          <div className="ai-result-head">
            <span>{result.task === 'summary' ? t('Sammanfattning') : t('Att göra')}</span>
            <span className="muted">
              {result.res.ok ? `${contextLine(result.res)} · ${ENGINE_LABEL[result.res.engine]} ${fmtMs(result.res.ms)}` : ''}
            </span>
            <button className="chip-x" onClick={() => setResult(null)} aria-label={t('Stäng')}>
              <I.Close size={11} />
            </button>
          </div>
          <div className="ai-result-body">{result.res.ok ? result.res.text : result.res.error}</div>
        </div>
      )}
    </div>
  );
}

const AUTOMATED = /no-?reply|noreply|notifications?@|mailer-daemon|bounce|nyhetsbrev|newsletter/i;

// Tre snabbsvar under mejlet. Tas fram automatiskt med egen server och datorns modell, på begäran med Claude och ChatGPT.
export function QuickReplies({ message, engine, ownEmail, isDraft, onQuickReply }: Omit<Props, 'threadSize' | 'onEngine'>) {
  const [res, setRes] = useState<AiResult | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const slow = useSlowNotice(busy, engine);
  const fromSelf = !!ownEmail && message.from.address === ownEmail.toLowerCase();
  const skip = isDraft || fromSelf || AUTOMATED.test(message.from.address);

  const load = async () => {
    const n = ++seq.current;
    setBusy(true);
    setRes(null);
    try {
      const r = await api.aiTask(message.id, 'quick', engine);
      if (n === seq.current) setRes(r);
    } catch (e: any) {
      if (n === seq.current) setRes({ ok: false, error: e.message, engine, ms: 0 });
    } finally {
      if (n === seq.current) setBusy(false);
    }
  };

  useEffect(() => {
    seq.current++;
    setRes(null);
    setBusy(false);
    if (skip || !AUTO_ENGINES.includes(engine)) return;
    const t = setTimeout(() => void load(), 700);
    return () => clearTimeout(t);
  }, [message.id, engine, skip]);

  if (skip) return null;
  return (
    <div className="quick-replies" aria-label={t('Snabbsvar')}>
      <div className="quick-head">
        <I.Sparkle size={13} />
        <span>{t('Snabbsvar')}</span>
        {res?.ok && <span className="muted">{ENGINE_LABEL[res.engine]}</span>}
      </div>
      {busy && (
        <div className="quick-busy">
          <span className="pulse" />
          {slow ?? t('Tar fram förslag…')}
        </div>
      )}
      {!busy && !res && (
        <button className="pill" onClick={() => void load()}>
          {t('Föreslå snabbsvar')}
        </button>
      )}
      {res && !res.ok && (
        <div className="quick-error">
          {res.error}{' '}
          <button className="link small" onClick={() => void load()}>
            {t('Försök igen')}
          </button>
        </div>
      )}
      {res?.ok && (
        <div className="quick-list">
          {res.options!.map((o) => (
            <button key={o} className="quick-reply" onClick={() => onQuickReply(o)} title={t('Öppna som svar, inget skickas förrän du trycker Skicka')}>
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
