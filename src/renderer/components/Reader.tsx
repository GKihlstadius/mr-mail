import { useEffect, useMemo, useRef, useState, type ReactNode, type MouseEvent as RMouseEvent } from 'react';
import type { AccountConfig, AiEngine, Folder, FullMessage, MessageSummary, Reminder, ReminderKind } from '../../shared/types';
import { createSanitizer, buildFrameDocument, textToHtml } from '../../shared/sanitize';
import { formatAddress } from '../../shared/compose';
import { api } from '../api';
import { t } from '../../shared/i18n';
import { avatarColor, cx, formatSize, fullDate, initials, listDate, senderName } from '../util';
import * as I from './Icons';
import { MoveMenu } from './MoveMenu';
import { ENGINE_LABEL } from './AiAssist';
import { PopMenu, snoozeTimes, whenText, type PopSection } from './PopMenu';

const sanitize = createSanitizer(window as any);

interface Props {
  message: FullMessage | null;
  summary: MessageSummary | null;
  thread: MessageSummary[];
  loading: boolean;
  error: string | null;
  account?: AccountConfig;
  folders: Folder[];
  engine: AiEngine;
  onAction(action: string, msg: MessageSummary): void;
  onMove(id: string, path: string): void;
  onMailto(to: string): void;
  onError(msg: string): void;
  children?: ReactNode;
  after?: ReactNode;
  reminders?: Reminder[];
  ownEmail?: string;
  onRemind?(id: string, kind: ReminderKind, due: number): void;
  onClearRemind?(id: string): void;
  onPrint?(pdf: boolean): void;
}

function ToolButton(props: {
  label: string;
  onClick(e: RMouseEvent<HTMLButtonElement>): void;
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={cx('icon-btn', props.active && 'on')}
      onClick={props.onClick}
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled}
    >
      {props.children}
    </button>
  );
}

// Ett mejl med rubrik, bilagor och brödtext. Används både ensamt och i en tråd.
function MessageView({
  message,
  account,
  showSubject,
  onMailto,
  onError,
  onCollapse
}: {
  message: FullMessage;
  account?: AccountConfig;
  showSubject: boolean;
  onMailto(to: string): void;
  onError(msg: string): void;
  onCollapse?(): void;
}) {
  const [allowRemote, setAllowRemote] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frameHeight, setFrameHeight] = useState(200);
  const m = message;
  const isOwn = !!account && m.from.address === account.email.toLowerCase();
  const visibleAttachments = m.body.attachments.filter((a) => !a.inline);

  useEffect(() => {
    setAllowRemote(false);
    setFrameHeight(200);
  }, [m.id]);

  const rendered = useMemo(() => {
    if (!m.body.html) return null;
    const res = sanitize(m.body.html, { allowRemote, inlineImages: m.body.inlineImages });
    return { doc: buildFrameDocument(res.html, { allowRemote, dark: false }), blocked: res.blocked };
  }, [m.id, m.body.html, allowRemote]);

  const onFrameLoad = () => {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    const measure = () => setFrameHeight(Math.max(120, doc.documentElement.scrollHeight));
    measure();
    doc.querySelectorAll('img').forEach((img) => img.addEventListener('load', measure));
    setTimeout(measure, 300);
    doc.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href') ?? '';
      if (/^mailto:/i.test(href)) onMailto(decodeURIComponent(href.slice(7).split('?')[0]));
      else if (/^https?:/i.test(href)) void api.external(href).catch((err) => onError(err.message));
    });
  };

  const textClick = (e: RMouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') ?? '';
    if (/^https?:/i.test(href)) void api.external(href).catch((err) => onError(err.message));
  };

  return (
    <article className="msg" data-id={m.id}>
      <div className={cx('msg-header', onCollapse && 'clickable')} onClick={onCollapse}>
        <div className="avatar" style={{ background: avatarColor(m.from.address) }}>
          {initials(m.from)}
        </div>
        <div className="msg-meta">
          <div className="msg-from-line">
            <span className="msg-from" title={m.from.address}>
              {senderName(m.from)}
              {m.from.name && m.from.address && senderName(m.from) !== m.from.address && <span className="msg-addr">{m.from.address}</span>}
            </span>
            <span className="msg-date">{fullDate(m.date)}</span>
          </div>
          {showSubject && <div className="msg-subject">{m.subject || t('(inget ämne)')}</div>}
          <div className="msg-to">
            <span className="label">{t('Till:')}</span> {m.to.map((a) => (isOwn || !a.name ? formatAddress(a) : a.name)).join(', ') || t('(ingen)')}
            {m.cc.length > 0 && (
              <>
                <span className="label"> {t('Kopia:')}</span> {m.cc.map(senderName).join(', ')}
              </>
            )}
          </div>
          {(m.labels?.length ?? 0) > 0 && (
            <div className="msg-labels">
              {m.labels!.map((l) => (
                <span className="label-chip" key={l}>
                  {l}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {visibleAttachments.length > 0 && (
        <div className="attachments">
          {visibleAttachments.map((a) => (
            <div className="attachment" key={a.index}>
              <button className="att-open" onClick={() => api.openAttachment(m.id, a.index).catch((e) => onError(e.message))} title={t('Öppna')}>
                <I.Paperclip size={14} />
                <span className="att-name">{a.filename}</span>
                <span className="att-size">{formatSize(a.size)}</span>
              </button>
              <button
                className="att-save"
                onClick={() => api.saveAttachment(m.id, a.index).catch((e) => onError(e.message))}
                title={t('Spara')}
                aria-label={t('Spara {name}', { name: a.filename })}
              >
                <I.Download size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {rendered && rendered.blocked > 0 && !allowRemote && (
        <div className="remote-banner">
          <I.Image size={15} />
          <span>{t('Bilder från internet visas inte, för att skydda dig mot spårning.')}</span>
          <button onClick={() => setAllowRemote(true)}>{t('Visa bilder')}</button>
        </div>
      )}

      <div className="msg-body">
        {rendered ? (
          <iframe
            key={`${m.id}-${allowRemote}`}
            ref={frameRef}
            className="html-frame"
            title={t('Meddelande')}
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            srcDoc={rendered.doc}
            style={{ height: frameHeight }}
            onLoad={onFrameLoad}
          />
        ) : (
          <div className="text-body" onClick={textClick} dangerouslySetInnerHTML={{ __html: textToHtml(m.body.text) }} />
        )}
      </div>
    </article>
  );
}

// Ett mejl i tråden som inte är det valda. Hopfällt visas bara avsändare och början av texten.
function ThreadItem({
  summary,
  initiallyOpen,
  account,
  onMailto,
  onError
}: {
  summary: MessageSummary;
  initiallyOpen: boolean;
  account?: AccountConfig;
  onMailto(to: string): void;
  onError(msg: string): void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [full, setFull] = useState<FullMessage | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!open || full) return;
    let live = true;
    api
      .open(summary.id)
      .then((m) => live && setFull(m))
      .catch((e) => live && setFailed(e.message));
    return () => {
      live = false;
    };
  }, [open, summary.id]);

  if (open && full) return <MessageView message={full} account={account} showSubject={false} onMailto={onMailto} onError={onError} onCollapse={() => setOpen(false)} />;
  return (
    <button className={cx('thread-item', !summary.seen && 'unread')} onClick={() => setOpen(true)} aria-expanded={open}>
      <div className="avatar small" style={{ background: avatarColor(summary.from.address) }}>
        {initials(summary.from)}
      </div>
      <div className="thread-item-main">
        <div className="thread-item-top">
          <span className="thread-item-from">{senderName(summary.from)}</span>
          <span className="thread-item-date">{listDate(summary.date)}</span>
        </div>
        <div className="thread-item-preview">{open ? (failed ?? t('Hämtar…')) : summary.preview || t('(ingen text)')}</div>
      </div>
    </button>
  );
}

export function Reader({
  message,
  summary,
  thread,
  loading,
  error,
  account,
  folders,
  engine,
  onAction,
  onMove,
  onMailto,
  onError,
  children,
  after,
  reminders = [],
  onRemind,
  onClearRemind,
  onPrint
}: Props) {
  const [moveMenu, setMoveMenu] = useState<{ id: string; accountId: string; x: number; y: number } | null>(null);
  const [pop, setPop] = useState<{ kind: 'remind' | 'print'; x: number; y: number } | null>(null);

  useEffect(() => {
    setMoveMenu(null);
    setPop(null);
  }, [message?.id]);

  if (!summary && !message) {
    return (
      <main className="reader empty-reader">
        <div className="reader-toolbar drag" />
        <div className="placeholder">
          <I.Envelope size={42} />
          <div>{t('Inget meddelande valt')}</div>
        </div>
      </main>
    );
  }

  const m = (message ?? summary)!;
  const isDraft = folders.find((f) => f.accountId === m.accountId && f.path === m.folder)?.role === 'drafts';
  const inThread = thread.length > 1;
  const key = m.messageId || m.id;
  const active = reminders.filter((r) => r.accountId === m.accountId && r.key === key);
  const fromSelf = !!account && m.from.address === account.email.toLowerCase();
  const openPop = (kind: 'remind' | 'print') => (e: RMouseEvent<HTMLButtonElement>) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPop({ kind, x: r.left, y: r.bottom + 4 });
  };
  const remindSections = (): PopSection[] => {
    const sections: PopSection[] = [];
    if (!fromSelf)
      sections.push({ title: t('Påminn mig'), items: snoozeTimes().map((t) => ({ label: t.label, hint: whenText(t.due), onPick: () => onRemind?.(m.id, 'snooze', t.due) })) });
    sections.push({
      title: t('Följ upp om inget svar'),
      items: [1, 3, 7].map((d) => ({
        label: d === 1 ? t('Om en dag') : d === 7 ? t('Om en vecka') : t('Om {n} dagar', { n: d }),
        onPick: () => onRemind?.(m.id, 'followup', Date.now() + d * 86400_000)
      }))
    });
    if (active.length) sections.push({ items: [{ label: t('Ta bort påminnelse'), danger: true, onPick: () => onClearRemind?.(m.id) }] });
    return sections;
  };
  const newestId = thread[0]?.id;

  const body = (
    <div className="msg-body-wrap">
      {loading && !message && <div className="body-loading">{t('Hämtar meddelandet…')}</div>}
      {error && <div className="body-error">{error}</div>}
      {message && <MessageView message={message} account={account} showSubject={!inThread} onMailto={onMailto} onError={onError} />}
    </div>
  );

  return (
    <main className="reader">
      <div className="reader-toolbar drag">
        <div className="no-drag tool-group">
          {isDraft && (
            <button className="btn primary small continue-draft" onClick={() => onAction('editDraft', m)}>
              <I.Compose size={14} /> {t('Fortsätt skriva')}
            </button>
          )}
          <ToolButton label={t('Svara (Ctrl+R)')} onClick={() => onAction('reply', m)}>
            <I.Reply />
          </ToolButton>
          <ToolButton label={t('Svara alla (Ctrl+Skift+R)')} onClick={() => onAction('replyAll', m)}>
            <I.ReplyAll />
          </ToolButton>
          <ToolButton label={t('Vidarebefordra (Ctrl+Skift+F)')} onClick={() => onAction('forward', m)}>
            <I.Forward />
          </ToolButton>
          <span className="tool-sep" />
          <ToolButton label={t('Arkivera (E)')} onClick={() => onAction('archive', m)}>
            <I.Archive />
          </ToolButton>
          <ToolButton label={t('Radera (Delete)')} onClick={() => onAction('trash', m)}>
            <I.Trash />
          </ToolButton>
          <ToolButton label={m.flagged ? t('Ta bort flagga') : t('Flagga')} onClick={() => onAction('flag', m)} active={m.flagged}>
            <I.Flag filled={m.flagged} />
          </ToolButton>
          <ToolButton label={m.seen ? t('Markera som oläst') : t('Markera som läst')} onClick={() => onAction('unread', m)}>
            {m.seen ? <I.Envelope /> : <I.EnvelopeOpen />}
          </ToolButton>
          <ToolButton
            label={t('Flytta till mapp')}
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMoveMenu({ id: m.id, accountId: m.accountId, x: r.left, y: r.bottom + 4 });
            }}
          >
            <I.MoveTo />
          </ToolButton>
          {onRemind && (
            <ToolButton label={active.length ? t('Påminnelse {when}', { when: whenText(active[0].due) }) : t('Påminn mig')} onClick={openPop('remind')} active={active.length > 0}>
              <I.Clock />
            </ToolButton>
          )}
          {onPrint && message && (
            <ToolButton label={t('Skriv ut eller spara som PDF')} onClick={openPop('print')}>
              <I.Printer />
            </ToolButton>
          )}
        </div>
        <div className="no-drag tool-group right">
          {!isDraft && (
            <button className="ai-btn" onClick={() => onAction('suggest', m)} title={t('Skriv ett svarsutkast med {engine}', { engine: ENGINE_LABEL[engine] })}>
              <I.Sparkle size={16} />
              <span>{t('Föreslå svar')}</span>
            </button>
          )}
        </div>
      </div>

      <div className="reader-scroll">
        {inThread && (
          <div className="thread-head">
            <div className="thread-subject">{m.subject || t('(inget ämne)')}</div>
            <div className="thread-meta">{t('{n} mejl i konversationen', { n: thread.length })}</div>
          </div>
        )}
        {children}
        {!inThread && body}
        {inThread &&
          thread.map((t) =>
            t.id === m.id ? (
              <div key={t.id} className="thread-current">
                {body}
              </div>
            ) : (
              <ThreadItem key={t.id} summary={t} initiallyOpen={!t.seen || t.id === newestId} account={account} onMailto={onMailto} onError={onError} />
            )
          )}
        {after}
      </div>
      {pop && (
        <PopMenu
          x={pop.x}
          y={pop.y}
          label={pop.kind === 'remind' ? t('Påminn mig') : t('Skriv ut')}
          sections={
            pop.kind === 'remind'
              ? remindSections()
              : [
                  {
                    items: [
                      { label: t('Skriv ut…'), hint: 'Ctrl+P', onPick: () => onPrint?.(false) },
                      { label: t('Spara som PDF…'), onPick: () => onPrint?.(true) }
                    ]
                  }
                ]
          }
          onClose={() => setPop(null)}
        />
      )}
      {moveMenu && (
        <MoveMenu
          folders={folders.filter((f) => f.accountId === moveMenu.accountId)}
          x={moveMenu.x}
          y={moveMenu.y}
          onPick={(path) => {
            onMove(moveMenu.id, path);
            setMoveMenu(null);
          }}
          onClose={() => setMoveMenu(null)}
        />
      )}
    </main>
  );
}
