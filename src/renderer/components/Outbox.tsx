import { useEffect, useState } from 'react';
import type { AccountConfig, OutboxInfo } from '../../shared/types';
import { api } from '../api';
import { t } from '../../shared/i18n';
import { whenText } from './PopMenu';
import * as I from './Icons';

// Ruta längst ned medan ett skickat mejl kan ångras.
export function UndoSend({ items, onError }: { items: OutboxInfo[]; onError(text: string): void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!items.length) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [items.length]);
  if (!items.length) return null;
  return (
    <div className="undo-stack" role="status">
      {items.map((o) => {
        const left = Math.max(0, Math.ceil((o.due - now) / 1000));
        return (
          <div className="undo-send" key={o.id}>
            <I.Send size={15} />
            <span className="undo-text">
              {left > 0 ? t('Skickar om {s} s', { s: left }) : t('Skickar…')}
              <span className="undo-subject">{o.subject || t('(inget ämne)')}</span>
            </span>
            {left > 0 && (
              <>
                <button className="undo-btn" onClick={() => void api.outboxSendNow(o.id).catch((e) => onError(e.message))}>
                  {t('Skicka nu')}
                </button>
                <button className="undo-btn strong" onClick={() => void api.outboxEdit(o.id).catch((e) => onError(e.message))}>
                  {t('Ångra')}
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Schemalagda mejl, med Skicka nu och Ändra.
export function OutboxDialog({ items, accounts, onError, onClose }: { items: OutboxInfo[]; accounts: AccountConfig[]; onError(text: string): void; onClose(): void }) {
  useEffect(() => {
    if (!items.length) onClose();
  }, [items.length, onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal outbox-modal" role="dialog" aria-label={t('Skickas senare')}>
        <header className="modal-head">
          <h2>{t('Skickas senare')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('Stäng')}>
            <I.Close size={16} />
          </button>
        </header>
        <div className="modal-body outbox-list">
          {items.map((o) => (
            <div className="outbox-row" key={o.id}>
              <div className="outbox-what">
                <strong>{o.subject || t('(inget ämne)')}</strong>
                <span className="muted small">
                  {t('Till {to} · från {from}', { to: o.to, from: accounts.find((a) => a.id === o.accountId)?.email ?? o.accountId })}
                </span>
              </div>
              <span className="outbox-when">{whenText(o.due)}</span>
              <button className="btn small" onClick={() => void api.outboxEdit(o.id).catch((e) => onError(e.message))}>
                {t('Ändra')}
              </button>
              <button className="btn small primary" onClick={() => void api.outboxSendNow(o.id).catch((e) => onError(e.message))}>
                {t('Skicka nu')}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
