import { t, tn } from '../../shared/i18n';
import * as I from './Icons';

export type BulkAction = 'archive' | 'trash' | 'read' | 'unread' | 'flag' | 'unflag';

interface Props {
  count: number;
  onAction(a: BulkAction): void;
  onClear(): void;
}

// Läsvyn när flera mejl är markerade.
export function BulkPanel({ count, onAction, onClear }: Props) {
  return (
    <main className="reader empty-reader bulk-panel">
      <div className="reader-toolbar drag" />
      <div className="placeholder">
        <I.Stack size={42} />
        <div className="bulk-count">{tn(count, 'Ett mejl markerat', '{n} mejl markerade')}</div>
        <div className="bulk-actions">
          <button className="btn" id="bulk-archive" onClick={() => onAction('archive')}>
            <I.Archive size={15} /> {t('Arkivera')}
          </button>
          <button className="btn" id="bulk-trash" onClick={() => onAction('trash')}>
            <I.Trash size={15} /> {t('Radera')}
          </button>
          <button className="btn" id="bulk-read" onClick={() => onAction('read')}>
            <I.EnvelopeOpen size={15} /> {t('Markera som lästa')}
          </button>
          <button className="btn" id="bulk-unread" onClick={() => onAction('unread')}>
            <I.Envelope size={15} /> {t('Markera som olästa')}
          </button>
          <button className="btn" id="bulk-flag" onClick={() => onAction('flag')}>
            <I.Flag size={15} /> {t('Flagga')}
          </button>
          <button className="btn" id="bulk-unflag" onClick={() => onAction('unflag')}>
            <I.Flag size={15} /> {t('Ta bort flagga')}
          </button>
        </div>
        <button className="link small" onClick={onClear}>
          {t('Avmarkera (Esc)')}
        </button>
      </div>
    </main>
  );
}
