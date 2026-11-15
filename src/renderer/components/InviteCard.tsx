import { useEffect, useState } from 'react';
import type { FullMessage, InviteResponse } from '../../shared/types';
import { describeRrule, joinService } from '../../shared/ics';
import { eventWhen } from '../../shared/calendar';
import { locale, t, tn } from '../../shared/i18n';
import { api } from '../api';
import { cx } from '../util';
import * as I from './Icons';

interface State {
  response: InviteResponse | null;
  outdated: boolean;
  calendar: boolean;
}

const answerText = (r: InviteResponse) => (r === 'accept' ? t('Du har tackat ja') : r === 'tentative' ? t('Du har svarat kanske') : t('Du har tackat nej'));

const partstatText = (p: string, name: string) =>
  p === 'ACCEPTED' ? t('{name} har tackat ja', { name }) : p === 'TENTATIVE' ? t('{name} har svarat kanske', { name }) : p === 'DECLINED' ? t('{name} har tackat nej', { name }) : '';

// Kort för en kalenderinbjudan ovanför brödtexten, som i Apple Mail.
export function InviteCard({ message, onError, onToast }: { message: FullMessage; onError(msg: string): void; onToast?(msg: string): void }) {
  const inv = message.body.invite!;
  const ev = inv.event;
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState<InviteResponse | 'add' | null>(null);

  useEffect(() => {
    let live = true;
    setState(null);
    void api
      .inviteState(message.id)
      .then((s) => live && setState(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [message.id]);

  const cancelled = inv.method === 'CANCEL' || ev.status === 'CANCELLED';
  const canAnswer = inv.method === 'REQUEST' && !cancelled && !!ev.organizer?.email;
  const canAdd = !cancelled && inv.method !== 'REPLY' && !canAnswer;
  const start = new Date(ev.allDay && ev.startDate ? ev.startDate + 'T12:00:00' : ev.start);
  const month = new Intl.DateTimeFormat(locale(), { month: 'short' }).format(start).replace('.', '');
  const repeat = describeRrule(ev.rrule);
  const service = ev.joinUrl ? joinService(ev.joinUrl) : '';
  const replier = inv.method === 'REPLY' ? ev.attendees[0] : undefined;

  const answer = async (r: InviteResponse) => {
    setBusy(r);
    try {
      const res = await api.inviteRespond(message.id, r);
      setState((s) => ({ calendar: s?.calendar ?? false, outdated: false, response: res.response }));
      onToast?.(res.calendar ? t('Svaret är skickat och kalendern uppdaterad.') : t('Svaret är skickat till {name}.', { name: ev.organizer?.name || ev.organizer?.email || '' }));
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    setBusy('add');
    try {
      const res = await api.inviteAdd(message.id);
      if (res === 'calendar') onToast?.(t('Händelsen är tillagd i kalendern.'));
      else if (res === 'file') onToast?.(t('Kalenderfilen är sparad.'));
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={cx('invite-card', cancelled && 'cancelled')} aria-label={t('Kalenderinbjudan')}>
      <div className="invite-tile" aria-hidden="true">
        <span className="invite-month">{month}</span>
        <span className="invite-day">{start.getDate()}</span>
      </div>
      <div className="invite-main">
        {cancelled && <div className="invite-flag">{t('Inställt')}</div>}
        <div className="invite-title">{ev.summary || t('(ingen titel)')}</div>
        <div className="invite-when">{eventWhen(ev)}</div>
        {repeat && <div className="invite-line subtle">{repeat}</div>}
        {ev.location && !(ev.joinUrl && /^(microsoft teams|google meet|zoom)/i.test(ev.location)) && (
          <div className="invite-line">
            <I.Pin size={13} />
            <span>{ev.location}</span>
          </div>
        )}
        {ev.organizer && (ev.organizer.name || ev.organizer.email) && (
          <div className="invite-line subtle">
            {t('Organisatör: {name}', { name: ev.organizer.name || ev.organizer.email })}
            {ev.attendees.length > 0 && <> · {tn(ev.attendees.length, 'En deltagare', '{n} deltagare')}</>}
          </div>
        )}
        {replier && partstatText(replier.partstat, replier.name || replier.email) && <div className="invite-status">{partstatText(replier.partstat, replier.name || replier.email)}</div>}
        {canAnswer && state?.response && <div className="invite-status">{answerText(state.response)}</div>}
        {canAnswer && state?.outdated && <div className="invite-status subtle">{t('Mötet har ändrats sedan du svarade.')}</div>}
        <div className="invite-actions">
          {ev.joinUrl && !cancelled && (
            <button className="btn small primary invite-join" onClick={() => void api.external(ev.joinUrl!).catch((e) => onError(e.message))}>
              <I.Video size={14} />
              {service ? t('Anslut till {service}', { service }) : t('Anslut till mötet')}
            </button>
          )}
          {canAnswer && (
            <div className="invite-rsvp" role="group" aria-label={t('Svara på inbjudan')}>
              {(['accept', 'tentative', 'decline'] as InviteResponse[]).map((r) => (
                <button key={r} className={cx(state?.response === r && 'on')} data-response={r} disabled={!!busy} onClick={() => void answer(r)}>
                  {busy === r ? t('Skickar…') : r === 'accept' ? t('Ja') : r === 'tentative' ? t('Kanske') : t('Nej')}
                </button>
              ))}
            </div>
          )}
          {canAdd && (
            <button className="btn small invite-add" disabled={!!busy} onClick={() => void add()}>
              <I.Calendar size={14} />
              {t('Lägg till i kalender')}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
