// Gemensamt gränssnitt för kalenderleverantörerna (Google, Microsoft Graph och CalDAV).
import type { CalendarEvent, CalendarInfo, CalendarKind, EventInput, EventPerson } from '../../shared/calendar';
import type { Invitation, InviteResponse } from '../../shared/types';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

// Inloggningen saknar kalenderbehörighet eller har gått ut: användaren behöver logga in igen.
export class CalendarAuthError extends Error {
  constructor(message = 'needs login') {
    super(message);
  }
}

export class CalendarHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface CalendarProvider {
  kind: CalendarKind;
  // Skickar servern själv inbjudningar och ändringar till deltagarna?
  sendsInvitations: boolean;
  listCalendars(): Promise<CalendarInfo[]>;
  listEvents(cal: CalendarInfo, from: number, to: number): Promise<CalendarEvent[]>;
  createEvent(cal: CalendarInfo, input: EventInput, me: EventPerson): Promise<CalendarEvent>;
  updateEvent(cal: CalendarInfo, ev: CalendarEvent, patch: Partial<EventInput>, me: EventPerson): Promise<CalendarEvent>;
  deleteEvent(cal: CalendarInfo, ev: CalendarEvent): Promise<void>;
  // En inbjudan från ett mejl: lägg till eller uppdatera händelsen med det egna svaret, utan att skicka något.
  saveInvite(cal: CalendarInfo, inv: Invitation, me: EventPerson, response: InviteResponse | null): Promise<void>;
  // Kalenderfil att mejla till deltagarna när servern inte skickar inbjudningar själv.
  imip?(ev: CalendarEvent, method: 'REQUEST' | 'CANCEL'): Promise<string>;
}

export const STATUS_FROM_PARTSTAT: Record<string, EventPerson['status']> = {
  ACCEPTED: 'accepted',
  TENTATIVE: 'tentative',
  DECLINED: 'declined',
  'NEEDS-ACTION': 'needs-action'
};

export const RESPONSE_STATUS: Record<InviteResponse, NonNullable<EventPerson['status']>> = { accept: 'accepted', tentative: 'tentative', decline: 'declined' };

export async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

// ISO 8601 i UTC utan millisekunder.
export const isoUtc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function localZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
