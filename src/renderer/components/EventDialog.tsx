import { useEffect, useMemo, useState } from 'react';
import type { AccountConfig } from '../../shared/types';
import { localDate, sameEmails, type CalendarAccountState, type CalendarEvent, type EventInput } from '../../shared/calendar';
import { addDays, localMidnight } from '../../shared/ics';
import { formatAddress, parseAddressList } from '../../shared/compose';
import { t } from '../../shared/i18n';
import { api } from '../api';
import { AddressInput } from './AddressInput';
import * as I from './Icons';

interface Props {
  date: string;
  states: CalendarAccountState[];
  accounts: AccountConfig[];
  // Förifyllda inbjudna, till exempel från Kontakter.
  invitees?: string;
  // Händelsen som ändras. Utan den skapas en ny.
  event?: CalendarEvent;
  onClose(): void;
  onSaved(ev: CalendarEvent, invited: boolean): void;
  onDelete?(ev: CalendarEvent): void;
}

const clock = (v: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

const hhmm = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const timeOf = (ms: number) => {
  const d = new Date(ms);
  return hhmm(d.getHours() * 60 + d.getMinutes());
};
const dayDiff = (a: string, b: string) => Math.round((localMidnight(b) - localMidnight(a)) / 86400000);

function nextHalfHour(): string {
  const d = new Date(Date.now() + 30 * 60_000);
  const m = d.getMinutes() < 30 ? 30 : 0;
  const h = m === 0 ? d.getHours() + 1 : d.getHours();
  return hhmm(Math.min(h, 23) * 60 + m);
}

const plusHour = (v: string) => {
  const n = clock(v);
  return Number.isFinite(n) ? hhmm(Math.min(n + 60, 23 * 60 + 59)) : v;
};


// Ny eller ändrad händelse: titel, tid, plats och inbjudna. Inbjudningar och ändringar till
// deltagare skickas först efter en bekräftelse.
export function EventDialog({ date, states, accounts, invitees: initialInvitees, event, onClose, onSaved, onDelete }: Props) {
  const editing = !!event;
  const writable = useMemo(() => states.filter((s) => s.state === 'ok').flatMap((s) => s.calendars.filter((c) => !c.readOnly)), [states]);
  const startDay = event ? (event.allDay ? (event.startDate ?? localDate(event.start)) : localDate(event.start)) : date;
  // Hur många dagar händelsen spänner över behålls när datumet flyttas.
  const span = event ? (event.allDay ? Math.max(1, dayDiff(startDay, event.endDate ?? addDays(startDay, 1))) : dayDiff(startDay, localDate(event.end))) : 0;
  const [title, setTitle] = useState(event?.title ?? '');
  const [day, setDay] = useState(startDay);
  const [start, setStart] = useState(() => (event && !event.allDay ? timeOf(event.start) : nextHalfHour()));
  const [end, setEnd] = useState(() => (event && !event.allDay ? timeOf(event.end) : plusHour(nextHalfHour())));
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const [location, setLocation] = useState(event?.location ?? '');
  const originalPeople = event ? event.attendees.map((a) => formatAddress({ name: a.name, address: a.email })).join(', ') : '';
  const [invitees, setInvitees] = useState(event ? originalPeople : (initialInvitees ?? ''));
  const [description, setDescription] = useState(event?.description ?? '');
  const [cal, setCal] = useState(() => {
    const first = writable.find((c) => c.primary) ?? writable[0];
    return first ? `${first.accountId}|${first.id}` : '';
  });
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const people = parseAddressList(invitees).filter((a) => /^[^\s@]+@[^\s@]+$/.test(a.address));
  const accName = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
  const peopleChanged = editing && !sameEmails(people.map((p) => p.address), event!.attendees.map((a) => a.email));
  // Vid ändring får deltagarna besked när användaren organiserar mötet.
  const notified = editing ? (event!.isOrganizer || !event!.attendees.length ? people : []) : people;

  const save = async () => {
    setError('');
    if (!title.trim()) return setError(t('Händelsen behöver en titel.'));
    const base = localMidnight(day);
    let s = base;
    let e = localMidnight(addDays(day, allDay ? Math.max(1, span) : 1));
    if (!allDay) {
      const a = clock(start);
      const b = clock(end);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return setError(t('Skriv tiden som 14:00.'));
      const d = new Date(base);
      const endDay = new Date(localMidnight(addDays(day, Math.max(0, span))));
      s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, a).getTime();
      e = new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate(), 0, b).getTime();
      if (e <= s) return setError(t('Sluttiden måste vara efter starttiden.'));
    }
    const input: EventInput = {
      title: title.trim(),
      start: s,
      end: e,
      allDay,
      startDate: allDay ? day : undefined,
      endDate: allDay ? addDays(day, Math.max(1, span)) : undefined,
      location: location.trim() || undefined,
      description: description.trim() || undefined,
      attendees: people.map((p) => ({ name: p.name, email: p.address }))
    };
    // Vid ändring skickas bara det som ändrats, som i update_event. Tiden för en serie ändras inte i onödan.
    const patch: Partial<EventInput> = {};
    if (event) {
      if (input.title !== event.title) patch.title = input.title;
      if (s !== event.start || e !== event.end || allDay !== event.allDay) Object.assign(patch, { start: s, end: e, allDay, startDate: input.startDate, endDate: input.endDate });
      if (location.trim() !== event.location) patch.location = location.trim();
      if (description.trim() !== event.description) patch.description = description.trim();
      if (peopleChanged) patch.attendees = input.attendees;
      if (!Object.keys(patch).length) return onClose();
    }
    if (notified.length && !confirm) {
      setConfirm(true);
      return;
    }
    setSaving(true);
    try {
      if (event) {
        const ev = await api.calendarUpdate(event.id, patch);
        onSaved(ev, notified.length > 0);
      } else {
        const ev = await api.calendarCreate(input, cal || undefined);
        onSaved(ev, people.length > 0);
      }
    } catch (err: any) {
      setError(err.message);
      setConfirm(false);
    } finally {
      setSaving(false);
    }
  };

  const heading = editing ? t('Ändra händelse') : t('Ny händelse');
  const confirmText = editing
    ? t('Deltagarna får en uppdatering: {people}. Vill du skicka den?', { people: notified.map((p) => p.name || p.address).join(', ') })
    : t('Inbjudan skickas till {people}. Vill du skicka den?', { people: people.map((p) => p.name || p.address).join(', ') });
  const saveLabel = saving
    ? t('Sparar…')
    : notified.length
      ? confirm
        ? editing
          ? t('Skicka uppdatering')
          : t('Skicka inbjudan')
        : t('Fortsätt')
      : editing
        ? t('Spara')
        : t('Lägg till');

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal event-modal" role="dialog" aria-label={heading}>
        <header className="modal-head">
          <h2>{heading}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('Stäng')}>
            <I.Close size={16} />
          </button>
        </header>
        <div className="modal-body">
          <label className="field">
            <span>{t('Titel')}</span>
            <input id="event-title" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} />
          </label>
          <div className="event-when">
            <label className="field">
              <span>{t('Datum')}</span>
              <input id="event-date" type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
            </label>
            {!allDay && (
              <>
                <label className="field narrow">
                  <span>{t('Start')}</span>
                  <input
                    id="event-start"
                    type="time"
                    value={start}
                    onChange={(e) => {
                      const v = e.target.value;
                      // Sluttiden följer med när starten flyttas.
                      const dur = clock(end) - clock(start);
                      setStart(v);
                      if (Number.isFinite(dur) && dur > 0 && Number.isFinite(clock(v))) setEnd(hhmm(Math.min(clock(v) + dur, 23 * 60 + 59)));
                    }}
                  />
                </label>
                <label className="field narrow">
                  <span>{t('Slut')}</span>
                  <input id="event-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
                </label>
              </>
            )}
          </div>
          <label className="check">
            <input type="checkbox" id="event-allday" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
            <span>{t('Heldag')}</span>
          </label>
          <label className="field">
            <span>{t('Plats')}</span>
            <input id="event-location" value={location} onChange={(e) => setLocation(e.target.value)} />
          </label>
          <div className="field">
            <span>{t('Bjud in')}</span>
            <AddressInput id="event-invitees" value={invitees} onChange={setInvitees} />
          </div>
          <label className="field">
            <span>{t('Anteckningar')}</span>
            <textarea id="event-notes" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          {!editing && writable.length > 1 && (
            <label className="field">
              <span>{t('Kalender')}</span>
              <select id="event-calendar" value={cal} onChange={(e) => setCal(e.target.value)}>
                {writable.map((c) => (
                  <option key={`${c.accountId}|${c.id}`} value={`${c.accountId}|${c.id}`}>
                    {c.name} ({accName(c.accountId)})
                  </option>
                ))}
              </select>
            </label>
          )}
          {confirm && (
            <div className="event-confirm" role="alert">
              {confirmText}
            </div>
          )}
          {error && (
            <div className="form-errors" role="alert">
              {error}
            </div>
          )}
        </div>
        <footer className="modal-foot">
          {editing && onDelete && (
            <button className="btn ghost danger-text" id="event-delete" onClick={() => onDelete(event!)} disabled={saving}>
              {t('Ta bort')}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={confirm ? () => setConfirm(false) : onClose}>
            {confirm ? t('Tillbaka') : t('Avbryt')}
          </button>
          <button className="btn primary" id="event-save" onClick={() => void save()} disabled={saving || (!editing && !writable.length)}>
            {saveLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
