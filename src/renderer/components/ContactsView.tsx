import { useEffect, useMemo, useState } from 'react';
import type { AccountConfig, ContactDetail, ContactRow } from '../../shared/types';
import { dayLabel, localDate, timeText, type CalendarAccountState } from '../../shared/calendar';
import { formatAddress } from '../../shared/compose';
import { APP_NAME } from '../../shared/brand';
import { t, tn } from '../../shared/i18n';
import { api } from '../api';
import { avatarColor, cx, initials, listDate } from '../util';
import { EventDialog } from './EventDialog';
import * as I from './Icons';

interface Props {
  accounts: AccountConfig[];
  onToast(text: string): void;
  onOpenMail(id: string): void;
  onCompose(to: string): void;
  onAsk?(): void;
}

const LIMIT = 400;

function Avatar({ name, address, size = 36 }: { name: string; address: string; size?: number }) {
  return (
    <span className="avatar contact-avatar" style={{ background: avatarColor(address), width: size, height: size, fontSize: size * 0.38 }} aria-hidden="true">
      {initials({ name, address })}
    </span>
  );
}

// Kontakter: alla som användaren mejlat med, med antal mejl och senaste kontakt. Detaljer till höger.
export function ContactsView({ accounts, onToast, onOpenMail, onCompose, onAsk }: Props) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<ContactRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ContactDetail | null>(null);
  const [states, setStates] = useState<CalendarAccountState[]>([]);
  const [creating, setCreating] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(
      () =>
        void api
          .contactList(query, LIMIT)
          .then((list) => live && setRows(list))
          .catch((e) => onToast(e.message)),
      query ? 150 : 0
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    void api.calendarState().then(setStates).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let live = true;
    void api
      .contactDetail(selected)
      .then((d) => live && setDetail(d))
      .catch((e) => onToast(e.message));
    return () => {
      live = false;
    };
  }, [selected]);

  // Första kontakten visas direkt, så att vyn aldrig är tom.
  useEffect(() => {
    if (rows?.length && (!selected || !rows.some((r) => r.address === selected))) setSelected(rows[0].address);
  }, [rows]);

  const row = useMemo(() => rows?.find((r) => r.address === selected) ?? null, [rows, selected]);
  const name = detail?.name || row?.name || '';
  const canBook = states.some((s) => s.state === 'ok' && s.calendars.some((c) => !c.readOnly));
  const now = Date.now();

  return (
    <section className="contacts-pane" aria-label={t('Kontakter')}>
      <div className="contacts-list-col">
        <header className="list-head drag">
          <div className="list-titles">
            <h1>{t('Kontakter')}</h1>
            <div className="subtitle">{rows ? (rows.length >= LIMIT ? t('De {n} vanligaste', { n: LIMIT }) : tn(rows.length, 'En kontakt', '{n} kontakter')) : ''}</div>
          </div>
          {onAsk && (
            <div className="no-drag head-actions">
              <button className="icon-btn ask-btn" onClick={onAsk} title={t('Fråga {app} (Ctrl+J)', { app: APP_NAME })} aria-label={t('Fråga {app}', { app: APP_NAME })}>
                <I.Sparkle size={17} />
              </button>
            </div>
          )}
        </header>
        <div className="search-wrap">
          <I.Search size={15} />
          <input id="contact-search" type="search" placeholder={t('Sök kontakter')} value={query} spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="contacts-list" role="listbox" aria-label={t('Kontakter')}>
          {rows && !rows.length && <div className="empty">{query ? t('Inga träffar.') : t('Inga kontakter än. De samlas från mejlen du skickar och tar emot.')}</div>}
          {rows?.map((r) => (
            <button
              key={r.address}
              role="option"
              aria-selected={r.address === selected}
              className={cx('contact-row', r.address === selected && 'active')}
              data-address={r.address}
              onClick={() => setSelected(r.address)}
            >
              <Avatar name={r.name} address={r.address} />
              <span className="contact-who">
                <span className="contact-name">{r.name || r.address}</span>
                {r.name && <span className="contact-addr">{r.address}</span>}
              </span>
              <span className="contact-meta">
                <span>{tn(r.count, 'Ett mejl', '{n} mejl')}</span>
                <span className="subtle">{listDate(r.last)}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="contact-detail">
        {!detail ? (
          <div className="empty">{rows?.length ? '' : t('Välj en kontakt.')}</div>
        ) : (
          <div className="contact-detail-scroll">
            <div className="contact-card">
              <Avatar name={name} address={detail.address} size={64} />
              <div className="contact-card-text">
                <h2>{name || detail.address}</h2>
                {name && <div className="subtle">{detail.address}</div>}
                <div className="contact-stats">
                  <span>{tn(detail.received, 'Ett mottaget', '{n} mottagna')}</span>
                  <span>{tn(detail.sent, 'Ett skickat', '{n} skickade')}</span>
                  {detail.last > 0 && <span>{t('Senast {when}', { when: listDate(detail.last) })}</span>}
                </div>
              </div>
            </div>
            <div className="contact-actions">
              <button className="btn primary" id="contact-write" onClick={() => onCompose(formatAddress({ name, address: detail.address }))}>
                <I.Compose size={15} /> {t('Skriv mejl')}
              </button>
              <button className="btn" id="contact-event" disabled={!canBook} title={canBook ? undefined : t('Ingen kalender är ansluten.')} onClick={() => setCreating(detail.address)}>
                <I.Calendar size={15} /> {t('Ny händelse')}
              </button>
            </div>

            {detail.events.length > 0 && (
              <>
                <div className="section-title">{t('Kommande möten')}</div>
                <div className="contact-events">
                  {detail.events.map((ev) => (
                    <div className="contact-event" key={ev.id}>
                      <I.Calendar size={14} />
                      <span className="contact-event-title">{ev.title || t('(ingen titel)')}</span>
                      <span className="subtle">
                        {dayLabel(localDate(ev.start), now)}
                        {ev.allDay ? '' : `, ${timeText(ev.start)}`}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="section-title">{t('Senaste mejlen')}</div>
            {!detail.recent.length && <div className="subtle contact-none">{t('Inga mejl i cachen.')}</div>}
            <div className="contact-mails">
              {detail.recent.map((m) => (
                <button key={m.id} className="contact-mail" data-id={m.id} onClick={() => onOpenMail(m.id)}>
                  <span className={cx('contact-dir', m.from.address.toLowerCase() === detail.address && 'in')} title={m.from.address.toLowerCase() === detail.address ? t('Från') : t('Till')}>
                    {m.from.address.toLowerCase() === detail.address ? <I.Inbox size={13} /> : <I.Send size={13} />}
                  </span>
                  <span className="contact-mail-main">
                    <span className={cx('contact-mail-subject', !m.seen && 'unread')}>{m.subject || t('(inget ämne)')}</span>
                    <span className="subtle contact-mail-preview">{m.from.address.toLowerCase() === detail.address ? m.preview : t('Du: {text}', { text: m.preview })}</span>
                  </span>
                  <span className="subtle contact-mail-date">{listDate(m.date)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {creating && (
        <EventDialog
          date={localDate(Date.now())}
          states={states}
          accounts={accounts}
          invitees={formatAddress({ name, address: creating })}
          onClose={() => setCreating(null)}
          onSaved={(_ev, invited) => {
            setCreating(null);
            onToast(invited ? t('Händelsen är skapad och inbjudan skickad.') : t('Händelsen är skapad.'));
            if (selected) void api.contactDetail(selected).then(setDetail).catch(() => undefined);
          }}
        />
      )}
    </section>
  );
}
