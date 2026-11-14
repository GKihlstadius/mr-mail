import { useEffect, useRef } from 'react';
import type { Folder } from '../../shared/types';
import { moveTargets } from '../folderTree';
import { t } from '../../shared/i18n';
import * as I from './Icons';

interface Props {
  folders: Folder[];
  x: number;
  y: number;
  onPick(path: string): void;
  onClose(): void;
}

export function MoveMenu({ folders, x, y, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const targets = moveTargets(folders);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const style: React.CSSProperties = {
    left: Math.max(6, Math.min(x, window.innerWidth - 232)),
    top: Math.max(6, Math.min(y, window.innerHeight - Math.min(targets.length, 12) * 30 - 16))
  };

  return (
    <div className="move-menu" ref={ref} style={style} role="menu" aria-label={t('Flytta till mapp')}>
      <div className="move-menu-head">{t('Flytta till')}</div>
      <div className="move-menu-list">
        {targets.length === 0 && <div className="move-empty">{t('Inga mappar')}</div>}
        {targets.map((tg) => (
          <button
            key={tg.path}
            role="menuitem"
            className="move-item"
            style={{ paddingLeft: 10 + tg.depth * 14 }}
            onClick={() => onPick(tg.path)}
          >
            {tg.role ? <RoleGlyph role={tg.role} /> : <I.Folder size={15} />}
            <span className="move-name">{tg.role ? t(tg.label) : tg.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function RoleGlyph({ role }: { role: string }) {
  if (role === 'inbox') return <I.Inbox size={15} />;
  if (role === 'sent') return <I.Send size={15} />;
  if (role === 'drafts') return <I.Draft size={15} />;
  if (role === 'trash') return <I.Trash size={15} />;
  if (role === 'archive') return <I.Archive size={15} />;
  if (role === 'junk') return <I.Junk size={15} />;
  return <I.Folder size={15} />;
}
