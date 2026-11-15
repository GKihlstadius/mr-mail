import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AccountConfig } from '../../shared/types';
import { agenda, canEditEvent, dayLabel, localDate, timeText, type CalendarAccountState, type CalendarEvent } from '../../shared/calendar';
import { addDays, joinService, localMidnight } from '../../shared/ics';
import { APP_NAME } from '../../shared/brand';
import { locale, t, tn } from '../../shared/i18n';
import { api } from '../api';
import { cx } from '../util';
import * as I from './Icons';
import { EventDialog } from './EventDialog';

const DAYS = 14;

interface Props {
  accounts: AccountConfig[];
  onToast(text: string): void;
  onLogin(accountId: string): void;
  // Händelse att visa, till exempel från en länk i chatten.
  focusEvent?: string | null;
  onFocused?(): void;
  onAsk?(): void;
}

// Kalendern: i dag och de närmaste dagarna, grupperat per dag som en lugn agenda.
export function CalendarView({ accounts, onToast, onLogin, focusEvent, onFocused, onAsk }: Props) {
  const [states, setStates] = useState<CalendarAccountState[]>([]);
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [editing, setEditing] = useState<CalendarEvent | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const today = localDate(now);

  const load = useCallback(async () => {
    try {
      const from = localMidnight(today);
      const [st, list] = await Promise.all([api.calendarState(), api.calendarEvents(from, localMidnight(addDays(today, DAYS)))]);
      setStates(st);
      setEvents(list);
    } catch (e: any) {
      onToast(e.message);
    }
  }, [today, onToast]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      await api.calendarRefresh();
    } catch (e: any) {
      onToast(e.message);
    } finally {
      setBusy(false);
      void load();
    }
  }, [load, onToast]);

  useEffect(() => {
    void load();
    void refresh();
    const off = api.on('calendar', () => void load());
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      off();
      clearInterval(tick);
    };
  }, []);

  useEffect(() => void load(), [today]);

  // Länk från chatten: fäll ut händelsen och rulla fram den.
  useEffect(() => {
    if (!focusEvent || !events) return;
    const ev = events.find((x) => x.id === focusEvent);
    if (!ev) {
      onToast(t('Händelsen ligger utanför de närmaste två veckorna.'));
      onFocused?.();
      return;
    }
    const key = `${localDate(Math.max(ev.start, localMidnight(today)))}-${ev.id}`;
    setOpen(key);
    onFocused?.();
    setTimeout(() => document.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
  }, [focusEvent, events]);

  const colorOf = (ev: CalendarEvent) => states.find((s) => s.accountId === ev.accountId)?.calendars.find((c) => c.id === ev.calendarId)?.color ?? accounts.find((a) => a.id === ev.accountId)?.color ?? 'var(--accent)';
  const days = useMemo(() => (events ? agenda(events, today, DAYS) : []), [events, today]);
  const shown = days.filter((d, i) => i === 0 || d.allDay.length || d.timed.length);
  const needLogin = states.filter((s) => s.state === 'needs-login');
  const errors = states.filter((s) => s.state === 'error');
  const connected = states.some((s) => s.state === 'ok');
  const loading = states.some((s) => s.state === 'loading');
  const accName = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;

  const remove = async (ev: CalendarEvent) => {
    try {
      await api.calendarDelete(ev.id);
      onToast(ev.attendees.length && ev.isOrganizer ? t('Händelsen är borttagen och deltagarna får besked.') : t('Händelsen är borttagen.'));
      setOpen(null);
      setEditing(null);
      void load();
    } catch (e: any) {
      onToast(e.message);
    }
  };

  return (
    <section className="calendar-pane" aria-label={t('Kalender')}>
      <header className="clean-head drag">
        <div className="list-titles">
          <h1>{t('Kalender')}</h1>
          <div className="subtitle">{dayLabel(today, now)}, {new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'long' }).format(new Date(now))}</div>
        </div>
        <div className="no-drag calendar-tools">
          {onAsk && (
            <button className="icon-btn ask-btn" onClick={onAsk} title={t('Fråga {app} (Ctrl+J)', { app: APP_NAME })} aria-label={t('Fråga {app}', { app: APP_NAME })}>
              <I.Sparkle size={16} />
            </button>
          )}
          <button className="icon-btn" onClick={() => void refresh()} title={t('Uppdatera')} aria-label={t('Uppdatera')} disabled={busy}>
            <I.Refresh size={16} />
          </button>
          <button className="btn small primary" id="calendar-new" onClick={() => setCreating(today)} disabled={!connected}>
            <I.Plus size={14} /> {t('Ny händelse')}
          </button>
        </div>
      </header>

      <div className="calendar-scroll">
        {needLogin.map((s) => (
          <div className="calendar-note" key={s.accountId} data-account={s.accountId}>
            <I.Calendar size={16} />
            <span>
              <strong>{accName(s.accountId)}</strong> {s.error || t('Logga in igen för att visa kalendern.')}
            </span>
            <button className="btn small" onClick={() => onLogin(s.accountId)}>
              {t('Logga in igen')}
            </button>
          </div>
        ))}
        {errors.map((s) => (
          <div className="calendar-note subtle" key={s.accountId}>
            <span>
              <strong>{accName(s.accountId)}</strong> {s.error}
            </span>
          </div>
        ))}
        {!connected && !loading && !needLogin.length && (
          <div className="calendar-empty">
            <I.Calendar size={40} />
            <div>{t('Ingen kalender är ansluten.')}</div>
            <div className="subtle">{t('Gmail och Outlook visar kalendern när du loggar in med Google eller Microsoft. iCloud, Fastmail och andra hittas med kontots lösenord.')}</div>
          </div>
        )}
        {connected &&
          shown.map((d) => (
            <div className="agenda-day" key={d.date} data-date={d.date}>
              <div className={cx('agenda-date', d.date === today && 'today')}>{dayLabel(d.date, now)}</div>
              {d.allDay.map((ev) =>
                canEditEvent(ev, states) ? (
                  <button className="agenda-allday" key={`${d.date}-${ev.id}`} style={{ ['--ev' as any]: colorOf(ev) }} onClick={() => setEditing(ev)}>
                    {ev.title || t('(ingen titel)')}
                  </button>
                ) : (
                  <div className="agenda-allday" key={`${d.date}-${ev.id}`} style={{ ['--ev' as any]: colorOf(ev) }}>
                    {ev.title || t('(ingen titel)')}
                  </div>
                )
              )}
              {!d.allDay.length && !d.timed.length && <div className="agenda-free subtle">{t('Inget inbokat.')}</div>}
              {d.timed.map((ev) => {
                const isOpen = open === `${d.date}-${ev.id}`;
                const past = ev.end <= now;
                const current = ev.start <= now && ev.end > now;
                return (
                  <div key={`${d.date}-${ev.id}`} data-key={`${d.date}-${ev.id}`} className={cx('agenda-event', past && 'past', current && 'now', isOpen && 'open', ev.myStatus === 'declined' && 'declined')} style={{ ['--ev' as any]: colorOf(ev) }}>
                    <button
                      className="agenda-row"
                      // Egna händelser öppnas för ändring, andras fälls ut med detaljerna.
                      onClick={() => (canEditEvent(ev, states) ? setEditing(ev) : setOpen(isOpen ? null : `${d.date}-${ev.id}`))}
                      aria-expanded={isOpen}
                    >
                      <span className="agenda-time">
                        <span>{localDate(ev.start) < d.date ? '' : timeText(ev.start)}</span>
                        <span className="subtle">{localDate(ev.end) > d.date ? '' : timeText(ev.end)}</span>
                      </span>
                      <span className="agenda-bar" />
                      <span className="agenda-main">
                        <span className="agenda-title">{ev.title || t('(ingen titel)')}</span>
                        {ev.location && <span className="agenda-loc subtle">{ev.location}</span>}
                      </span>
                    </button>
                    {ev.joinUrl && ev.end > now && (
                      <button className="btn small primary agenda-join" onClick={() => void api.external(ev.joinUrl!).catch((e) => onToast(e.message))}>
                        <I.Video size={13} />
                        {joinService(ev.joinUrl) || t('Anslut till mötet')}
                      </button>
                    )}
                    {isOpen && (
                      <div className="agenda-detail">
                        {ev.organizer && !ev.isOrganizer && <div className="subtle">{t('Organisatör: {name}', { name: ev.organizer.name || ev.organizer.email })}</div>}
                        {ev.attendees.length > 0 && (
                          <div className="subtle" title={ev.attendees.map((a) => a.name || a.email).join(', ')}>
                            <I.People size={13} /> {tn(ev.attendees.length, 'En deltagare', '{n} deltagare')}
                          </div>
                        )}
                        {ev.description && <div className="agenda-desc">{ev.description.slice(0, 600)}</div>}
                        <div className="agenda-detail-actions">
                          <span className="subtle">{accName(ev.accountId)}</span>
                          {!states.find((s) => s.accountId === ev.accountId)?.calendars.find((c) => c.id === ev.calendarId)?.readOnly && (
                            <button className="link small danger-text" onClick={() => void remove(ev)}>
                              {t('Ta bort')}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
      </div>
      {editing && (
        <EventDialog
          date={localDate(editing.start)}
          event={editing}
          states={states}
          accounts={accounts}
          onClose={() => setEditing(null)}
          onDelete={(ev) => void remove(ev)}
          onSaved={(ev, notified) => {
            setEditing(null);
            onToast(notified ? t('Händelsen är ändrad och deltagarna får besked.') : t('Händelsen är ändrad.'));
            setEvents((list) => (list ? [...list.filter((x) => x.id !== editing.id && x.id !== ev.id), ev] : [ev]));
            void load();
          }}
        />
      )}
      {creating && (
        <EventDialog
          date={creating}
          states={states}
          accounts={accounts}
          onClose={() => setCreating(null)}
          onSaved={(ev, invited) => {
            setCreating(null);
            onToast(invited ? t('Händelsen är skapad och inbjudan skickad.') : t('Händelsen är skapad.'));
            setEvents((list) => (list ? [...list.filter((x) => x.id !== ev.id), ev] : [ev]));
            void load();
          }}
        />
      )}
    </section>
  );
}
