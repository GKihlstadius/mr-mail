import { useState, type DragEvent, type ReactElement } from 'react';
import type { AccountStatus, Folder, FolderRole, MailboxSelection } from '../../shared/types';
import { api, type AppState } from '../api';
import { buildFolderTree, folderLabel, isGmailAllMail, SPECIAL_ROLES } from '../folderTree';
import { cx } from '../util';
import { t } from '../../shared/i18n';
import { APP_NAME } from '../../shared/brand';
import * as I from './Icons';

const ROLE_ICON: Record<string, (p: { size?: number }) => ReactElement> = {
  inbox: I.Inbox,
  sent: I.Send,
  drafts: I.Draft,
  trash: I.Trash,
  archive: I.Archive,
  junk: I.Junk
};

export function statusText(s?: AccountStatus): string {
  switch (s?.state) {
    case 'online':
      return t('Ansluten');
    case 'syncing':
      return t('Synkar');
    case 'connecting':
      return t('Ansluter…');
    case 'error':
      return s.error ?? t('Fel');
    case 'offline':
      return t('Frånkopplad');
    default:
      return t('Inte inloggad. Klicka för att logga in.');
  }
}

export function StatusDot({ status }: { status?: AccountStatus }) {
  const state = status?.state ?? 'needs-password';
  return <span className={cx('dot', `dot-${state}`)} title={statusText(status)} aria-label={statusText(status)} />;
}

interface Props {
  state: AppState;
  selection: MailboxSelection | null;
  onSelect(sel: MailboxSelection): void;
  onAddAccount(): void;
  onEditAccount(id: string, login?: boolean): void;
  onSettings(): void;
  onDropMessage(messageId: string, accountId: string, path: string): void;
  cleaning: boolean;
  onClean(): void;
  laterCount: number;
  onOutbox(): void;
}

export function Sidebar({ state, selection, onSelect, onAddAccount, onEditAccount, onSettings, onDropMessage, cleaning, onClean, laterCount, onOutbox }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [dragOver, setDragOver] = useState<string | null>(null);
  const totalUnread = state.statuses.reduce((n, s) => n + s.unread, 0);
  const isSel = (sel: MailboxSelection) => JSON.stringify(sel) === JSON.stringify(selection);
  const unifiedSel: MailboxSelection = { kind: 'unified', role: 'inbox' };

  // Hämtar meddelande-id ur en släpp-händelse, för drag och släpp till en mapp.
  const readDragId = (e: DragEvent): string | null => {
    const id = e.dataTransfer.getData('application/x-brevlada-message') || e.dataTransfer.getData('text/plain');
    return id && id.includes('|') ? id : null;
  };
  const dropHandlers = (key: string, accountId: string, path: string) => ({
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragOver !== key) setDragOver(key);
    },
    onDragLeave: () => {
      if (dragOver === key) setDragOver(null);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDragOver(null);
      const id = readDragId(e);
      if (id) onDropMessage(id, accountId, path);
    }
  });

  const renderFolder = (p: { sel: MailboxSelection; key: string; dropPath: string; depth?: number; icon: ReactElement; label: string; unread: number }) => (
    <button
      key={p.key}
      className={cx('nav-item', 'folder', isSel(p.sel) && 'active', dragOver === p.key && 'drop-target')}
      style={{ paddingLeft: 26 + (p.depth ?? 0) * 14 }}
      onClick={() => onSelect(p.sel)}
      {...dropHandlers(p.key, p.sel.kind === 'folder' ? p.sel.accountId : '', p.dropPath)}
    >
      {p.icon}
      <span className="nav-label">{p.label}</span>
      {p.unread > 0 && <span className="count">{p.unread}</span>}
    </button>
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-top drag">
        <span className="app-title">{APP_NAME}</span>
      </div>
      <nav className="sidebar-scroll">
        <div className="section-label">{t('Favoriter')}</div>
        <button className={cx('nav-item', isSel(unifiedSel) && 'active')} onClick={() => onSelect(unifiedSel)}>
          <I.Stack size={17} />
          <span className="nav-label">{t('Alla inkorgar')}</span>
          {totalUnread > 0 && <span className="count">{totalUnread}</span>}
        </button>
        <button
          className={cx('nav-item', isSel({ kind: 'reminders' }) && 'active')}
          onClick={() => onSelect({ kind: 'reminders' })}
        >
          <I.Clock size={17} />
          <span className="nav-label">{t('Påminnelser')}</span>
          {state.reminders.length > 0 && (
            <span className={cx('count', state.reminders.some((r) => r.state === 'due') && 'alert')}>{state.reminders.length}</span>
          )}
        </button>
        {laterCount > 0 && (
          <button className="nav-item" onClick={onOutbox} id="nav-outbox">
            <I.Send size={17} />
            <span className="nav-label">{t('Skickas senare')}</span>
            <span className="count">{laterCount}</span>
          </button>
        )}
        <button className={cx('nav-item', cleaning && 'active')} onClick={onClean} id="nav-clean">
          <I.Broom size={17} />
          <span className="nav-label">{t('Städa')}</span>
        </button>

        {state.accounts.map((acc) => {
          const status = state.statuses.find((s) => s.id === acc.id);
          const folders = state.folders.filter((f) => f.accountId === acc.id);
          const labels = state.labels.filter((l) => l.accountId === acc.id);
          const isCollapsed = collapsed[acc.id];
          const needsLogin = status?.state === 'needs-password' || (status?.state === 'error' && /lösenord|inloggning/i.test(status.error ?? ''));
          const tree = buildFolderTree(folders);
          const special = SPECIAL_ROLES.map((role) => ({ role, folder: folders.find((f) => f.role === role) })).filter(
            (x): x is { role: FolderRole; folder: Folder } => !!x.folder
          );
          return (
            <div className="account" key={acc.id}>
              <div className="account-head">
                <button
                  className={cx('collapse', isCollapsed && 'collapsed')}
                  onClick={() => setCollapsed({ ...collapsed, [acc.id]: !isCollapsed })}
                  aria-label={isCollapsed ? t('Visa mappar') : t('Dölj mappar')}
                >
                  <I.Chevron size={12} />
                </button>
                <button className="account-name" onClick={() => (needsLogin && status?.state === 'needs-password' ? onEditAccount(acc.id, true) : onEditAccount(acc.id))} title={`${acc.email}\n${statusText(status)}`}>
                  <StatusDot status={status} />
                  <span className="nav-label">{acc.name}</span>
                </button>
                {isCollapsed && status && status.unread > 0 && <span className="count subtle">{status.unread}</span>}
              </div>
              {needsLogin && (
                <button className="login-hint" onClick={() => onEditAccount(acc.id, true)}>
                  {status?.state === 'needs-password' ? (acc.auth === 'oauth' ? t('Logga in igen') : t('Logga in')) : t('Inloggningen misslyckades')}
                </button>
              )}
              {!needsLogin && status?.state === 'error' && (
                <div className="account-error" role="alert">
                  <span>{status.error ?? t('Fel vid synk.')}</span>
                  <button className="link small" onClick={() => void api.reconnect(acc.id)}>
                    {t('Försök igen')}
                  </button>
                </div>
              )}
              {!isCollapsed && (
                <>
                  {special.map(({ role, folder }) => {
                    const sel: MailboxSelection = { kind: 'folder', accountId: acc.id, role, path: folder.path };
                    const Icon = ROLE_ICON[role] ?? I.Folder;
                    return renderFolder({
                      key: `sp-${role}`,
                      sel,
                      dropPath: folder.path,
                      icon: <Icon size={16} />,
                      label: t(folderLabel(role, folder.path)),
                      unread: role === 'sent' || role === 'trash' || isGmailAllMail(role, folder.path) ? 0 : folder.unread
                    });
                  })}

                  {tree.length > 0 && <div className="section-label">{t('Mappar')}</div>}
                  {tree.map(({ folder, depth }) => {
                    const sel: MailboxSelection = { kind: 'folder', accountId: acc.id, role: 'other', path: folder.path };
                    return renderFolder({
                      key: folder.path,
                      sel,
                      dropPath: folder.path,
                      depth,
                      icon: <I.Folder size={16} />,
                      label: folder.name,
                      unread: folder.unread
                    });
                  })}

                  {labels.length > 0 && <div className="section-label">{t('Etiketter')}</div>}
                  {labels.map((l) => {
                    const sel: MailboxSelection = { kind: 'label', accountId: acc.id, label: l.label };
                    return (
                      <button key={`lb-${l.label}`} className={cx('nav-item', 'folder', isSel(sel) && 'active')} onClick={() => onSelect(sel)}>
                        <I.Tag size={16} />
                        <span className="nav-label">{l.label}</span>
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          );
        })}
      </nav>
      <div className="sidebar-foot">
        <button className="foot-btn" onClick={onAddAccount}>
          <I.Plus size={16} />
          <span>{t('Lägg till konto')}</span>
        </button>
        <button className="icon-btn" onClick={onSettings} title={t('Inställningar')} aria-label={t('Inställningar')}>
          <I.Gear size={17} />
        </button>
      </div>
    </aside>
  );
}
