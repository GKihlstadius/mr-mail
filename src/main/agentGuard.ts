// Behörigheter och aktivitetslogg för AI-verktygens anrop. Varje anrop från båda bryggorna går hit:
// skicka, radera och avregistrera kan kräva att användaren säger ja, och allt loggas kort.
import { TOOL_ALIASES, type AgentArgs, type AgentCall } from '../shared/agentTools';
import type { AgentPermission, AgentPermissions } from '../shared/types';
import { t, tn } from '../shared/i18n';
import { AgentError, normalizeArgs } from './agent';

export type PermissionKind = keyof AgentPermissions;

export const DEFAULT_PERMISSIONS: AgentPermissions = { send: 'ask', delete: 'ask', unsubscribe: 'ask' };

export function canonicalTool(name: string): string {
  return Object.prototype.hasOwnProperty.call(TOOL_ALIASES, name) ? TOOL_ALIASES[name] : name;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const cleanAction = (a: AgentArgs) => {
  const act = str(a.action).toLowerCase();
  return act === 'trash' || act === 'radera' ? 'trash' : act === 'archive' || act === 'arkivera' ? 'archive' : '';
};

export interface EventLookup {
  (id: string): { title: string; attendees: number; isOrganizer: boolean; start: number } | null;
}

const hasAttendees = (a: AgentArgs) => (Array.isArray(a.attendees) ? a.attendees.length > 0 : typeof a.attendees === 'string' && a.attendees.trim() !== '');

// Vilka behörigheter ett anrop kräver. Städa som raderar kräver både radera och städa.
// Kalenderhändelser med deltagare räknas som att skicka, eftersom deltagarna får besked.
export function permissionKinds(tool: string, raw: AgentArgs, events?: EventLookup): PermissionKind[] {
  const args = normalizeArgs(raw && typeof raw === 'object' ? raw : {});
  const ev = typeof args.id === 'string' ? events?.(args.id.trim()) : null;
  const notifies = !!ev && ev.attendees > 0 && ev.isOrganizer;
  switch (canonicalTool(tool)) {
    case 'create_event':
      return hasAttendees(args) ? ['send'] : [];
    case 'update_event':
      return hasAttendees(args) || notifies ? ['send'] : [];
    case 'delete_event':
      return notifies ? ['delete', 'send'] : ['delete'];
    case 'send_email':
    case 'send_draft':
    case 'respond_to_invite':
      return ['send'];
    case 'trash':
      return ['delete'];
    case 'unsubscribe':
      return ['unsubscribe'];
    case 'clean_up':
      return cleanAction(args) === 'trash' ? ['unsubscribe', 'delete'] : ['unsubscribe'];
    default:
      return [];
  }
}

const RANK: Record<AgentPermission, number> = { allow: 0, ask: 1, never: 2 };

export function effectivePermission(kinds: PermissionKind[], perms: Partial<AgentPermissions> | undefined): AgentPermission {
  let level: AgentPermission = 'allow';
  for (const k of kinds) {
    const p = perms?.[k];
    const v: AgentPermission = p === 'allow' || p === 'never' || p === 'ask' ? p : DEFAULT_PERMISSIONS[k];
    if (RANK[v] > RANK[level]) level = v;
  }
  return level;
}

// Fält som visas i loggen. Texten, hemlig kopia och filernas innehåll tas aldrig med.
const SUMMARY_FIELDS = ['account', 'to', 'cc', 'subject', 'query', 'id', 'reply_to', 'forward', 'folder', 'address', 'action', 'send_at', 'name', 'time', 'attachment', 'category', 'response', 'title', 'from', 'start', 'end', 'calendar', 'duration_minutes'];

const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function summarizeCall(tool: string, raw: AgentArgs): string {
  const args = normalizeArgs(raw && typeof raw === 'object' ? raw : {});
  const parts: string[] = [];
  for (const k of SUMMARY_FIELDS) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) parts.push(`${k}: ${short(v.trim().replace(/\s+/g, ' '))}`);
    else if (typeof v === 'number') parts.push(`${k}: ${v}`);
  }
  if (Array.isArray(args.ids)) parts.push(`ids: ${args.ids.length}`);
  if (Array.isArray(args.attachments) && args.attachments.length) parts.push(`attachments: ${args.attachments.length}`);
  if (hasAttendees(args)) parts.push(`attendees: ${Array.isArray(args.attendees) ? args.attendees.length : String(args.attendees).split(',').length}`);
  if (args.unread_only === true) parts.push('unread_only');
  if (args.always === true) parts.push('always');
  return short(parts.join(', '), 240);
}

export interface MessageLookup {
  (id: string): { subject: string; from: string; to: string } | null;
}

export interface AskRequest {
  tool: string;
  kinds: PermissionKind[];
  message: string;
  detail: string;
}

// Vad som ska hända, i klartext för frågan till användaren.
export function describeCall(tool: string, raw: AgentArgs, client: string | undefined, lookup?: MessageLookup, events?: EventLookup): { message: string; detail: string } {
  const a = normalizeArgs(raw && typeof raw === 'object' ? raw : {});
  const who = client?.trim() || t('Ett AI-verktyg');
  const name = canonicalTool(tool);
  const later = str(a.send_at) ? ` ${t('Det skickas {time}.', { time: str(a.send_at) })}` : '';
  if (name === 'send_email') {
    const src = str(a.reply_to) || str(a.forward) ? lookup?.(str(a.reply_to) || str(a.forward)) : null;
    const to = str(a.to) || (str(a.reply_to) && src ? src.from : '') || t('(okänd mottagare)');
    const subject = str(a.subject) || (src ? `${str(a.forward) ? 'Fwd' : 'Re'}: ${src.subject}` : '') || t('(inget ämne)');
    return {
      message: t('{client} vill skicka ett mejl till {to} med ämnet "{subject}".', { client: who, to: short(to, 120), subject: short(subject, 120) }),
      detail: `${str(a.cc) ? `${t('Kopia: {cc}', { cc: short(str(a.cc), 120) })}\n` : ''}${t('Tillåt bara om du har bett om det.')}${later}`
    };
  }
  if (name === 'send_draft') {
    const d = lookup?.(str(a.id));
    return {
      message: t('{client} vill skicka utkastet till {to} med ämnet "{subject}".', {
        client: who,
        to: short(d?.to || t('(okänd mottagare)'), 120),
        subject: short(d?.subject || t('(inget ämne)'), 120)
      }),
      detail: `${t('Tillåt bara om du har bett om det.')}${later}`
    };
  }
  if (name === 'create_event' || name === 'update_event' || name === 'delete_event') {
    const ev = str(a.id) ? events?.(str(a.id)) : null;
    const title = short(str(a.title) || ev?.title || t('(ingen titel)'), 120);
    const people = Array.isArray(a.attendees) ? a.attendees.map(String).join(', ') : str(a.attendees);
    if (name === 'delete_event') {
      return {
        message: t('{client} vill ta bort händelsen "{title}".', { client: who, title }),
        detail: ev && ev.attendees > 0 && ev.isOrganizer ? t('Deltagarna får besked om att mötet är inställt.') : ''
      };
    }
    if (name === 'create_event') {
      return {
        message: t('{client} vill skapa händelsen "{title}" och skicka en inbjudan till {to}.', { client: who, title, to: short(people, 160) }),
        detail: `${str(a.start) ? `${t('Tid: {time}', { time: str(a.start) })}\n` : ''}${t('Tillåt bara om du har bett om det.')}`
      };
    }
    return {
      message: t('{client} vill ändra händelsen "{title}" och meddela deltagarna.', { client: who, title }),
      detail: t('Tillåt bara om du har bett om det.')
    };
  }
  if (name === 'respond_to_invite') {
    const m = lookup?.(str(a.id));
    const resp = str(a.response).toLowerCase();
    const title = short(m?.subject || t('(inget ämne)'), 120);
    const message =
      resp === 'decline' || resp === 'nej'
        ? t('{client} vill tacka nej till "{title}" och skicka svaret till {to}.', { client: who, title, to: short(m?.from || t('(okänd mottagare)'), 120) })
        : resp === 'tentative' || resp === 'kanske'
          ? t('{client} vill svara kanske på "{title}" och skicka svaret till {to}.', { client: who, title, to: short(m?.from || t('(okänd mottagare)'), 120) })
          : t('{client} vill tacka ja till "{title}" och skicka svaret till {to}.', { client: who, title, to: short(m?.from || t('(okänd mottagare)'), 120) });
    return { message, detail: t('Tillåt bara om du har bett om det.') };
  }
  if (name === 'trash') {
    const ids = Array.isArray(a.ids) ? a.ids.filter((x): x is string => typeof x === 'string') : str(a.ids) ? [str(a.ids)] : [];
    const subjects = ids
      .slice(0, 5)
      .map((id) => lookup?.(id))
      .filter((m): m is NonNullable<typeof m> => !!m)
      .map((m) => `${short(m.subject || t('(inget ämne)'), 70)} (${short(m.from, 40)})`);
    return {
      message: tn(ids.length, '{client} vill flytta ett mejl till papperskorgen.', '{client} vill flytta {n} mejl till papperskorgen.', { client: who }),
      detail: [...subjects, ids.length > 5 ? t('och {n} till.', { n: ids.length - 5 }) : ''].filter(Boolean).join('\n')
    };
  }
  if (name === 'unsubscribe') {
    return { message: t('{client} vill avregistrera dig från utskicken från {address}.', { client: who, address: short(str(a.address), 120) }), detail: '' };
  }
  if (name === 'clean_up') {
    const address = short(str(a.address), 120);
    return {
      message:
        cleanAction(a) === 'trash'
          ? t('{client} vill flytta alla mejl från {address} till papperskorgen.', { client: who, address })
          : t('{client} vill arkivera alla mejl från {address}.', { client: who, address }),
      detail: a.always === true ? t('Även nya mejl från avsändaren, från och med nu.') : ''
    };
  }
  return { message: t('{client} vill använda {tool}.', { client: who, tool: name }), detail: '' };
}

export interface AgentLogInput {
  tool: string;
  summary: string;
  ok: boolean;
  error?: string;
  client?: string;
}

export interface GuardDeps {
  permissions(): Partial<AgentPermissions> | undefined;
  ask(req: AskRequest): Promise<boolean>;
  log(entry: AgentLogInput): void;
  lookup?: MessageLookup;
  events?: EventLookup;
}

function declined(name: string, never: boolean): string {
  const what =
    name === 'send_email' || name === 'send_draft' || name === 'respond_to_invite' || name === 'create_event' || name === 'update_event'
      ? 'sending'
      : name === 'trash' || name === 'delete_event'
        ? 'deleting'
        : 'this action';
  const how = never ? `The user has turned off ${what} for AI tools in the settings.` : 'The user declined this action.';
  const instead =
    name === 'send_email'
      ? ' Nothing was sent. Save it as a draft with draft_email instead, so the user can read and send it.'
      : name === 'send_draft'
        ? ' Nothing was sent. The draft is still in Drafts; the user can send it from there.'
        : name === 'create_event'
          ? ' Nothing was created or sent. Without attendees the event can be created without sending anything, or the user can invite people from the app.'
        : ' Nothing was changed. Do not try again unless the user asks.';
  return `${how}${instead}`;
}

// Lägger behörigheter och logg runt anropen. Okända och ofarliga verktyg körs direkt.
export function guardAgent(call: AgentCall, deps: GuardDeps): AgentCall {
  return async (tool, args, ctx) => {
    const safeArgs = args && typeof args === 'object' ? args : {};
    const name = canonicalTool(tool);
    const summary = summarizeCall(name, safeArgs);
    const kinds = permissionKinds(name, safeArgs, deps.events);
    const level = effectivePermission(kinds, deps.permissions());
    const client = ctx?.client;
    if (kinds.length && level !== 'allow') {
      let allowed = false;
      if (level === 'ask') {
        try {
          allowed = await deps.ask({ tool: name, kinds, ...describeCall(name, safeArgs, client, deps.lookup, deps.events) });
        } catch {
          allowed = false;
        }
      }
      if (!allowed) {
        deps.log({ tool: name, summary, ok: false, error: level === 'never' ? t('Avstängt i inställningarna') : t('Nekat av dig'), client });
        throw new AgentError(declined(name, level === 'never'));
      }
    }
    try {
      const text = await call(tool, safeArgs, ctx);
      deps.log({ tool: name, summary, ok: true, client });
      return text;
    } catch (e: any) {
      deps.log({ tool: name, summary, ok: false, error: short(String(e?.message ?? e), 300), client });
      throw e;
    }
  };
}
