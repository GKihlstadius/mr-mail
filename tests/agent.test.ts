import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { attachmentText } from '../src/main/filetext';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createAgent, replaceOwnHtml, stripHtml, type AgentHost } from '../src/main/agent';
import { outgoingHtml } from '../src/shared/richtext';
import { startAgentServer } from '../src/main/agentServer';
import { AGENT_INSTRUCTIONS, AGENT_TOOLS } from '../src/shared/agentTools';
import type { AccountConfig, FullMessage, MessageSummary, OutgoingMessage } from '../src/shared/types';
import { findFreeSlots, type CalendarEvent, type EventInput } from '../src/shared/calendar';
import { permissionKinds, describeCall } from '../src/main/agentGuard';

const acc = (id: string, email: string, name: string): AccountConfig => ({
  id,
  name,
  email,
  displayName: 'Alex Berg',
  provider: 'simply',
  imap: { host: 'h', port: 993, security: 'ssl' },
  smtp: { host: 'h', port: 465, security: 'ssl' },
  username: email,
  color: '#000',
  signature: '<b>Alex</b>'
});

const karin: MessageSummary = {
  id: 'm1',
  accountId: 'nordljus',
  folder: 'INBOX',
  uid: 1,
  subject: 'Demo nästa vecka?',
  from: { name: 'Karin Lund', address: 'karin@ex.se' },
  to: [{ name: '', address: 'alex@nordljus.se' }],
  cc: [{ name: 'Erik', address: 'erik@ex.se' }],
  date: Date.UTC(2026, 10, 10, 9, 0),
  preview: 'Skulle du kunna visa Nordljus?',
  seen: false,
  flagged: false,
  answered: false,
  hasAttachments: false,
  messageId: '<k1@ex.se>'
};
const invite: MessageSummary = { ...karin, id: 'inv1', uid: 5, subject: 'Inbjudan: Demo', messageId: '<inv1@ex.se>' };
const draft: MessageSummary = { ...karin, id: 'd1', folder: 'Drafts', uid: 9, subject: 'Re: Demo', from: { name: 'Alex', address: 'alex@nordljus.se' }, to: [{ name: 'Karin Lund', address: 'karin@ex.se' }], cc: [], messageId: '<d1@x>' };

// En minimal zip-fil, som en docx.
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text));
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(text.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(text.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data);
    central.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const DOCX = zip({
  '[Content_Types].xml': '<Types/>',
  'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Första inlägget</w:t></w:r></w:p><w:p><w:r><w:t>Vecka 1 &amp; 2</w:t></w:r></w:p></w:body></w:document>'
});
const FILES = [
  { filename: 'Första inlägget.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: DOCX },
  { filename: 'bild.png', contentType: 'image/png', content: Buffer.from([137, 80, 78, 71]) }
];

// Låtsad kalendervärd: en kalender i minnet, som tjänsten i appen men utan leverantör.
function fakeCalendar() {
  const events: CalendarEvent[] = [];
  const calls: string[] = [];
  const mk = (input: EventInput, id: string): CalendarEvent => ({
    id,
    accountId: 'nordljus',
    calendarId: 'jobb',
    remoteId: id,
    uid: id,
    title: input.title,
    location: input.location ?? '',
    description: input.description ?? '',
    attendees: (input.attendees ?? []).map((a) => ({ name: a.name ?? '', email: a.email })),
    status: 'confirmed',
    busy: true,
    recurring: false,
    isOrganizer: true,
    start: input.start,
    end: input.end,
    allDay: input.allDay,
    startDate: input.startDate,
    endDate: input.endDate
  });
  events.push(mk({ title: 'Demo med Karin', start: new Date(2026, 10, 17, 14).getTime(), end: new Date(2026, 10, 17, 15).getTime(), allDay: false, location: 'Teams', attendees: [{ email: 'karin@ex.se', name: 'Karin' }] }, 'e1'));
  events.push(mk({ title: 'Lunch', start: new Date(2026, 10, 17, 12).getTime(), end: new Date(2026, 10, 17, 13).getTime(), allDay: false }, 'e2'));
  const host = {
    calendars: () => [{ accountId: 'nordljus', id: 'jobb', name: 'Jobb', primary: true, readOnly: false }],
    calendarEvents: async (from: number, to: number, f: { query?: string }) =>
      events.filter((e) => e.end > from && e.start < to && (!f.query || e.title.toLowerCase().includes(f.query.toLowerCase()))).sort((a, b) => a.start - b.start),
    freeSlots: async (o: { from: number; to: number; durationMin: number; workStart?: string; workEnd?: string; weekends?: boolean }) => (calls.push(`free:${o.durationMin}:${o.workStart}-${o.workEnd}`), findFreeSlots(events, o)),
    createEvent: async (input: EventInput, calendar?: string) => {
      calls.push(`create:${calendar ?? ''}`);
      const ev = mk(input, `n${events.length}`);
      events.push(ev);
      return ev;
    },
    updateEvent: async (id: string, patch: Partial<EventInput>) => {
      const i = events.findIndex((e) => e.id === id);
      calls.push(`update:${id}:${Object.keys(patch).sort().join(',')}`);
      events[i] = { ...events[i], ...patch, attendees: patch.attendees ? patch.attendees.map((a) => ({ name: a.name ?? '', email: a.email })) : events[i].attendees };
      return events[i];
    },
    deleteEvent: async (id: string) => {
      const ev = events.find((e) => e.id === id)!;
      events.splice(events.indexOf(ev), 1);
      calls.push(`delete:${id}`);
      return ev;
    },
    getEvent: (id: string) => events.find((e) => e.id === id) ?? null
  };
  return { host, events, calls };
}

function fakeHost() {
  const cal = fakeCalendar();
  const sent: OutgoingMessage[] = [];
  const drafts: OutgoingMessage[] = [];
  const opened: string[] = [];
  const moved: [string, string][] = [];
  const cleaned: string[] = [];
  const answers: string[] = [];
  const msgs = new Map([karin, draft, invite].map((m) => [m.id, m]));
  const full = (id: string): FullMessage => {
    const m = msgs.get(id)!;
    return {
      ...m,
      body: {
        id,
        html: id === 'd1' ? '<p>Hej Karin, tisdag passar.</p>' : null,
        text: id === 'd1' ? 'Hej Karin, tisdag passar.' : 'Hej Alex,\n\nSkulle du kunna visa Nordljus?\n\nKarin',
        attachments:
          id === 'm1'
            ? FILES.map((f, i) => ({ index: i, filename: f.filename, contentType: f.contentType, size: f.content.length, inline: false }))
            : [],
        inlineImages: {},
        references: [],
        inReplyTo: id === 'd1' ? '<k1@ex.se>' : null,
        replyTo: [],
        hasRemoteImages: false,
        invite:
          id === 'inv1'
            ? {
                method: 'REQUEST',
                count: 1,
                ics: null,
                event: {
                  uid: 'u1',
                  sequence: 0,
                  summary: 'Demo av Nordljus',
                  location: 'Rum 3',
                  description: '',
                  url: '',
                  status: '',
                  transparent: false,
                  start: new Date(2026, 10, 17, 14).getTime(),
                  end: new Date(2026, 10, 17, 15).getTime(),
                  allDay: false,
                  organizer: { name: 'Karin Lund', email: 'karin@ex.se' },
                  attendees: [{ name: 'Alex', email: 'alex@nordljus.se', partstat: 'NEEDS-ACTION', rsvp: true, role: 'REQ-PARTICIPANT' }],
                  joinUrl: 'https://meet.google.com/abc-defg-hij'
                }
              }
            : null
      }
    };
  };
  const host: AgentHost = {
    accounts: () => [acc('nordljus', 'alex@nordljus.se', 'Nordljus'), acc('gmail', 'alex@gmail.com', 'Gmail')],
    statuses: () => [{ id: 'nordljus', state: 'online', unread: 3 }],
    settings: () => ({ tone: 'Kort och vänligt.' }) as any,
    folders: () => [
      { accountId: 'nordljus', path: 'INBOX', name: 'Inkorg', role: 'inbox', parent: '', unread: 1 },
      { accountId: 'nordljus', path: 'Drafts', name: 'Utkast', role: 'drafts', parent: '', unread: 0 },
      { accountId: 'nordljus', path: 'Kunder', name: 'Kunder', role: 'other', parent: '', unread: 0 }
    ],
    rolePath: (_a, role) => (role === 'inbox' ? 'INBOX' : role === 'drafts' ? 'Drafts' : role === 'archive' ? 'Archive' : null),
    listFolder: (_a, path) => [...msgs.values()].filter((m) => m.folder === path),
    listUnified: () => [karin],
    search: async (q) => (q.includes('demo') ? [karin] : []),
    getMessage: (id) => msgs.get(id) ?? null,
    open: async (id) => {
      if (!msgs.has(id)) throw new Error('Meddelandet finns inte.');
      return full(id);
    },
    thread: () => [karin, draft],
    send: async (m) => void sent.push(m),
    saveDraft: async (m) => (drafts.push(m), 'd2'),
    setFlag: async () => undefined,
    moveToRole: async (id, role) => void moved.push([id, role]),
    moveToPath: async (id, path) => void moved.push([id, path]),
    showMessage: (id) => void opened.push(`visa:${id}`),
    openDraft: (id) => void opened.push(`utkast:${id}`),
    notifySent: () => undefined,
    senders: () => [
      { address: 'news@shop.se', name: 'Shop', total: 40, unread: 38, inInbox: 12, last: Date.UTC(2026, 10, 9), subject: 'Rea', unsubscribe: true, bulk: true, category: 'newsletter' },
      { address: 'karin@ex.se', name: 'Karin', total: 3, unread: 0, inInbox: 1, last: Date.UTC(2026, 10, 10), subject: 'Demo', unsubscribe: false, bulk: false, category: 'personal' }
    ],
    unsubscribe: async (address) => (cleaned.push(`avreg:${address}`), { method: 'oneclick' }),
    cleanBulk: async (address, action, days) => (cleaned.push(`${action}:${address}:${days ?? ''}`), 40),
    setRule: (address, action) => void cleaned.push(`regel:${action}:${address}`),
    attachment: async (_id, index) => FILES[index],
    contacts: (q) => (/erik/i.test(q) ? [{ name: 'Erik Lind', address: 'erik.lind@ex.se', count: 4 }] : []),
    remind: (id, due) => void cleaned.push(`paminn:${id}:${due ?? 'av'}`),
    sendLater: async (m, at) => void sent.push({ ...m, followUpDays: at }),
    createFolder: async (_a, name, parent) => (parent ? `${parent}/${name}` : name),
    downloadsDir: () => dirs.downloads,
    tempDir: () => dirs.temp,
    inviteAnswer: (id) => (answers.some((a) => a.startsWith(`${id}:`)) ? 'accept' : null),
    respondInvite: async (id, response, comment) => (answers.push(`${id}:${response}:${comment ?? ''}`), { calendar: true }),
    ...cal.host
  };
  return { host, sent, drafts, opened, moved, cleaned, answers, cal };
}

const dirs = { downloads: '', temp: '' };

describe('kalenderverktygen', () => {
  it('listar händelser och hittar ledig tid', async () => {
    const f = fakeHost();
    const call = createAgent(f.host);
    const list = JSON.parse(await call('list_events', { from: '2026-11-17', to: '2026-11-17' }));
    expect(list.map((e: any) => [e.title, e.start, e.end])).toEqual([
      ['Lunch', '2026-11-17 12:00', '2026-11-17 13:00'],
      ['Demo med Karin', '2026-11-17 14:00', '2026-11-17 15:00']
    ]);
    expect(list[1]).toMatchObject({ id: 'e1', location: 'Teams', attendees: ['Karin <karin@ex.se>'], calendar: 'Jobb', account: 'alex@nordljus.se' });
    expect(JSON.parse(await call('lista_handelser', { fran: '2026-11-17', till: '2026-11-18', fraga: 'demo' }))).toHaveLength(1);
    const free = JSON.parse(await call('find_free_time', { duration_minutes: 60, from: '2026-11-17', to: '2026-11-17' }));
    expect(free).toEqual([
      { start: '2026-11-17 09:00', end: '2026-11-17 12:00', minutes: 180 },
      { start: '2026-11-17 13:00', end: '2026-11-17 14:00', minutes: 60 },
      { start: '2026-11-17 15:00', end: '2026-11-17 17:00', minutes: 120 }
    ]);
    expect(f.cal.calls).toContain('free:60:09:00-17:00');
    await expect(call('find_free_time', {})).rejects.toThrow(/duration_minutes/);
    await expect(call('list_events', { from: '17 nov' })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('skapar, ändrar och tar bort händelser', async () => {
    const f = fakeHost();
    const call = createAgent(f.host);
    const created = await call('create_event', { title: 'Fokus', start: '2026-11-18 09:00' });
    expect(created).toMatch(/^Created "Fokus" 2026-11-18 09:00 to 10:00\. Id: n2$/);
    expect(f.cal.events[2]).toMatchObject({ allDay: false, start: new Date(2026, 10, 18, 9).getTime(), end: new Date(2026, 10, 18, 10).getTime() });
    expect(await call('skapa_handelse', { titel: 'Semester', start: '2026-12-21', slut: '2026-12-23' })).toContain('2026-12-21 to 2026-12-23, all day');
    expect(f.cal.events[3]).toMatchObject({ allDay: true, startDate: '2026-12-21', endDate: '2026-12-24' });
    const inv = await call('create_event', { title: 'Demo', start: '2026-11-19 13:00', end: '2026-11-19 13:30', attendees: ['Karin <karin@ex.se>', 'erik@ex.se'], calendar: 'Jobb' });
    expect(inv).toContain('invitation sent to karin@ex.se, erik@ex.se');
    expect(f.cal.calls).toContain('create:Jobb');
    await expect(call('create_event', { title: 'X', start: '2026-11-19 13:00', attendees: ['inte en adress'] })).rejects.toThrow(/Not an email address/);
    await expect(call('create_event', { title: 'X', start: '2026-11-19 13:00', end: '2026-11-19 12:00' })).rejects.toThrow(/after the start/);
    // Ny start behåller längden.
    expect(await call('update_event', { id: 'e1', start: '2026-11-17 16:00' })).toContain('2026-11-17 16:00 to 17:00. The attendees are told about the change');
    expect(f.cal.calls).toContain('update:e1:allDay,end,start');
    await expect(call('update_event', { id: 'e1' })).rejects.toThrow(/Nothing to change/);
    await expect(call('update_event', { id: 'finns-inte', title: 'x' })).rejects.toThrow(/does not exist/);
    expect(await call('delete_event', { id: 'e1' })).toContain('The attendees are told it is cancelled');
    expect(await call('ta_bort_handelse', { id: 'e2' })).toContain('Deleted "Lunch"');
  });

  it('inbjudningar kräver lov att skicka, borttagning lov att radera', () => {
    const events = (id: string) => (id === 'e1' ? { title: 'Demo', attendees: 2, isOrganizer: true, start: 0 } : id === 'e2' ? { title: 'Lunch', attendees: 0, isOrganizer: true, start: 0 } : null);
    expect(permissionKinds('create_event', { title: 'x', start: '2026-11-18' })).toEqual([]);
    expect(permissionKinds('create_event', { title: 'x', attendees: ['k@ex.se'] })).toEqual(['send']);
    expect(permissionKinds('skapa_handelse', { titel: 'x', deltagare: 'k@ex.se' })).toEqual(['send']);
    expect(permissionKinds('update_event', { id: 'e1', title: 'y' }, events)).toEqual(['send']);
    expect(permissionKinds('update_event', { id: 'e2', title: 'y' }, events)).toEqual([]);
    expect(permissionKinds('delete_event', { id: 'e1' }, events)).toEqual(['delete', 'send']);
    expect(permissionKinds('delete_event', { id: 'e2' }, events)).toEqual(['delete']);
    expect(permissionKinds('respond_to_invite', { id: 'm1', response: 'accept' })).toEqual(['send']);
    expect(describeCall('create_event', { title: 'Demo', start: '2026-11-19 13:00', attendees: ['k@ex.se'] }, 'Claude').message).toBe('Claude vill skapa händelsen "Demo" och skicka en inbjudan till k@ex.se.');
    expect(describeCall('delete_event', { id: 'e1' }, 'Claude', undefined, events).detail).toContain('inställt');
  });
});

describe('AI-verktygen', () => {
  it('visar inbjudan i read_email och svarar med respond_to_invite', async () => {
    const f = fakeHost();
    const call = createAgent(f.host);
    const text = await call('read_email', { id: 'inv1' });
    expect(text).toContain('Meeting invitation: Demo av Nordljus');
    expect(text).toContain('When: 2026-11-17 14:00 to 2026-11-17 15:00');
    expect(text).toContain('Organizer: Karin Lund <karin@ex.se>');
    expect(text).toContain('Join link: https://meet.google.com/abc-defg-hij');
    expect(text).toContain('Not answered yet');
    expect(await call('respond_to_invite', { id: 'inv1', response: 'accept', comment: 'Ses då' })).toContain('Accepted "Demo av Nordljus"');
    expect(f.answers).toEqual(['inv1:accept:Ses då']);
    expect(await call('read_email', { id: 'inv1' })).toContain('The user has answered: accept');
    expect(await call('svara_pa_inbjudan', { id: 'inv1', svar: 'nej' })).toContain('Declined');
    await expect(call('respond_to_invite', { id: 'm1', response: 'accept' })).rejects.toThrow(/no calendar invitation/);
    await expect(call('respond_to_invite', { id: 'inv1', response: 'kanske inte' })).rejects.toThrow(/accept, tentative or decline/);
  });

  beforeAll(() => {
    const root = mkdtempSync(join(tmpdir(), 'agent-bilagor-'));
    dirs.downloads = join(root, 'Hämtade filer');
    dirs.temp = join(root, 'tmp');
  });

  it('läser text ur en Word-bilaga och sparar bilagor i Hämtade filer', async () => {
    const f = fakeHost();
    const call = createAgent(f.host);
    expect(await call('read_email', { id: 'm1' })).toMatch(/1\. Första inlägget\.docx .*2\. bild\.png/);
    const text = await call('read_attachment', { id: 'm1', attachment: 'inlägget' });
    expect(text).toContain('Första inlägget\nVecka 1 & 2');
    const png = await call('read_attachment', { id: 'm1', attachment: '2' });
    const tmpPath = /saved as (.+?); read/.exec(png)?.[1] ?? '';
    expect(existsSync(tmpPath)).toBe(true);
    const saved = await call('save_attachment', { id: 'm1', attachment: '1' });
    const path = saved.split('\n')[1];
    expect(path).toBe(join(dirs.downloads, 'Första inlägget.docx'));
    expect(readFileSync(path).equals(DOCX)).toBe(true);
    const again = await call('save_attachment', { id: 'm1' });
    expect(again).toContain('Första inlägget (2).docx');
    expect(again).toContain('bild.png');
    await expect(call('read_attachment', { id: 'm1' })).rejects.toThrow(/several attachments/);
    await expect(call('read_attachment', { id: 'm1', attachment: 'finns inte' })).rejects.toThrow(/No attachment/);
  });

  it('bifogar filer från datorn och vägrar filer som inte finns', async () => {
    const f = fakeHost();
    const call = createAgent(f.host);
    const file = join(dirs.downloads, 'kort.txt');
    writeFileSync(file, 'hej');
    await call('draft_email', { to: 'karin@ex.se', subject: 'Kort', text: 'Här är filen.', attachments: [file] });
    expect(f.drafts[0].attachments).toEqual([{ filename: 'kort.txt', path: file, size: 3 }]);
    await expect(call('draft_email', { to: 'karin@ex.se', text: 'x', attachments: [join(dirs.downloads, 'saknas.txt')] })).rejects.toThrow(/does not exist/);
    await expect(call('draft_email', { to: 'karin@ex.se', text: 'x', attachments: ['relativ.txt'] })).rejects.toThrow(/full path/);
  });

  it('ändrar ett utkast: lägger till bilaga och byter text men behåller signatur och citat', async () => {
    const f = fakeHost();
    const call = createAgent(f.host);
    const file = join(dirs.downloads, 'leta-kvadrat.png');
    writeFileSync(file, 'png');
    const out = await call('edit_draft', { id: 'd1', cc: 'erik.lind@ex.se', attachments: [file] });
    const d = f.drafts[0];
    expect(d.draftOf).toBe('d1');
    expect(d.cc).toBe('erik.lind@ex.se');
    expect(d.attachments[0].filename).toBe('leta-kvadrat.png');
    expect(d.html).toContain('Hej Karin, tisdag passar.');
    expect(out).toMatch(/Cc: erik.lind@ex.se/);
    expect(out).toMatch(/Attachments: leta-kvadrat.png/);
    expect(f.opened).toContain('utkast:d2');
    await expect(call('edit_draft', { id: 'm1' })).rejects.toThrow(/not in Drafts/);
  });

  it('byter bara egen text i HTML och behåller signatur och citat', () => {
    const html = outgoingHtml('<div>Gammal text</div><div><br></div><div class="brevlada-signature"><b>Alex</b></div>', '<div>Den 9 nov skrev Karin:</div><blockquote>Hej</blockquote>');
    const out = replaceOwnHtml(html, '<div>Ny text</div>');
    expect(out).toContain('Ny text');
    expect(out).not.toContain('Gammal text');
    expect(out).toContain('brevlada-signature');
    expect(out).toContain('skrev Karin');
    const noSig = replaceOwnHtml(outgoingHtml('<div>Gammal</div>', '<div>Den 9 nov skrev Karin:</div><blockquote>Hej</blockquote>'), '<div>Ny</div>');
    expect(noSig).not.toContain('Gammal');
    expect(noSig).toContain('skrev Karin');
  });

  it('skickar senare, skapar mappar och tar bort bilagor ur utkast', async () => {
    const f = fakeHost();
    const call = createAgent(f.host);
    const year = new Date().getFullYear() + 1;
    expect(await call('send_email', { to: 'karin@ex.se', subject: 'Senare', text: 'Hej', send_at: `${year}-02-01 07:15` })).toMatch(/waits in the outbox/);
    expect(f.sent[0].followUpDays).toBe(new Date(year, 1, 1, 7, 15).getTime());
    expect(await call('create_folder', { account: 'Nordljus', name: 'LinkedIn', parent_folder: 'Kunder' })).toMatch(/Kunder\/LinkedIn/);
    // Utkastet d1 får två bilagor, sedan tas den ena bort.
    const draftWithFiles = { ...f.host };
    const base = f.host.open;
    draftWithFiles.open = async (id) => {
      const full = await base(id, false);
      return id === 'd1' ? { ...full, body: { ...full.body, attachments: FILES.map((x, i) => ({ index: i, filename: x.filename, contentType: x.contentType, size: x.content.length, inline: false })) } } : full;
    };
    const out = await createAgent(draftWithFiles)('edit_draft', { id: 'd1', remove_attachments: ['bild.png'], open: false });
    const d = f.drafts[0];
    expect(d.forwardOf).toBeUndefined();
    expect(d.attachments.map((x) => x.filename)).toEqual(['Första inlägget.docx']);
    expect(readFileSync(d.attachments[0].path).equals(DOCX)).toBe(true);
    expect(out).toMatch(/Attachments: Första inlägget.docx$/m);
  });

  it('hittar kontakter och sätter påminnelser', async () => {
    const f = fakeHost();
    const call = createAgent(f.host);
    expect(await call('find_contact', { query: 'Erik' })).toBe('Erik Lind <erik.lind@ex.se> (4 emails)');
    expect(await call('find_contact', { query: 'Okänd' })).toBe('No match.');
    const year = new Date().getFullYear() + 1;
    expect(await call('remind', { id: 'm1', time: `${year}-01-05 09:30` })).toMatch(/will come back/);
    expect(f.cleaned[0]).toBe(`paminn:m1:${new Date(year, 0, 5, 9, 30).getTime()}`);
    await expect(call('remind', { id: 'm1', time: '2020-01-01 08:00' })).rejects.toThrow(/passed/);
    await call('remind', { id: 'm1' });
    expect(f.cleaned[1]).toBe('paminn:m1:av');
  });

  it('plockar text ur Excel och vanlig text', () => {
    const xlsx = zip({
      'xl/sharedStrings.xml': '<sst><si><t>Namn</t></si><si><t>Anna</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>42</v></c></row><row><c t="s"><v>1</v></c></row></sheetData></worksheet>'
    });
    expect(attachmentText('lista.xlsx', '', xlsx)).toBe('# sheet1\nNamn\t42\nAnna');
    expect(attachmentText('a.csv', 'application/octet-stream', Buffer.from('a;b'))).toBe('a;b');
    expect(attachmentText('a.pdf', 'application/pdf', Buffer.from('%PDF'))).toBeNull();
  });

  it('har giltiga scheman och unika namn', () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of AGENT_TOOLS) expect((t.inputSchema as any).type).toBe('object');
  });

  it('listar konton med skrivton', async () => {
    const call = createAgent(fakeHost().host);
    const out = JSON.parse(await call('accounts', {}));
    expect(out.accounts[0]).toMatchObject({ address: 'alex@nordljus.se', status: 'connected', unread: 3 });
    expect(out.writing_tone).toBe('Kort och vänligt.');
  });

  it('listar mejl i en namngiven mapp och säger till om okänd mapp', async () => {
    const call = createAgent(fakeHost().host);
    const list = JSON.parse(await call('list_emails', { account: 'Nordljus', folder: 'inbox' }));
    expect(list[0]).toMatchObject({ id: 'm1', subject: 'Demo nästa vecka?', unread: true, folder: 'Inkorg' });
    await expect(call('list_emails', { account: 'alex@nordljus.se', folder: 'Finns inte' })).rejects.toThrow(/Folders: Inkorg, Utkast, Kunder/);
    await expect(call('list_emails', { account: 'okänd@x.se' })).rejects.toThrow(/No account/);
  });

  it('skriver svarsutkast med citat, trådrubriker och signatur och öppnar det', async () => {
    const f = fakeHost();
    const call = createAgent(f.host);
    const out = await call('draft_email', { reply_to: 'm1', reply_all: true, text: 'Hej Karin!\n\nTisdag passar – kl 14.' });
    const d = f.drafts[0];
    expect(d.accountId).toBe('nordljus');
    expect(d.to).toContain('karin@ex.se');
    expect(d.cc).toContain('erik@ex.se');
    expect(d.subject).toBe('Re: Demo nästa vecka?');
    expect(d.inReplyTo).toBe('<k1@ex.se>');
    expect(d.text).not.toMatch(/[–—]/);
    expect(d.text).toContain('> Skulle du kunna visa Nordljus?');
    expect(d.html).toContain('brevlada-signature');
    // Textdelen får signaturen som text, inte som HTML-kod.
    expect(d.text).toContain('Alex');
    expect(d.text).not.toMatch(/<b>|<table|<div/);
    expect(d.html).toContain('<blockquote');
    expect(f.opened).toEqual(['utkast:d2']);
    expect(out).toContain('Id: d2');
    expect(f.sent).toHaveLength(0);
  });

  it('skickar direkt bara via send_email, och kräver mottagare', async () => {
    const f = fakeHost();
    const call = createAgent(f.host);
    await expect(call('send_email', { text: 'Hej' })).rejects.toThrow(/Recipient missing/);
    await call('send_email', { account: 'Gmail', to: 'anna@ex.se', subject: 'Hej', text: 'Hej Anna' });
    expect(f.sent[0]).toMatchObject({ accountId: 'gmail', to: 'anna@ex.se', subject: 'Hej' });
  });

  it('skickar ett utkast ur Utkast men vägrar andra mejl', async () => {
    const f = fakeHost();
    const call = createAgent(f.host);
    await expect(call('send_draft', { id: 'm1' })).rejects.toThrow(/not in Drafts/);
    await call('send_draft', { id: 'd1' });
    expect(f.sent[0]).toMatchObject({ to: 'Karin Lund <karin@ex.se>', draftOf: 'd1', inReplyTo: '<k1@ex.se>', html: '<p>Hej Karin, tisdag passar.</p>' });
  });

  it('arkiverar, flyttar och rapporterar mejl som saknas', async () => {
    const f = fakeHost();
    const call = createAgent(f.host);
    expect(await call('archive', { ids: ['m1', 'nej'] })).toMatch(/1 of 2 done/);
    await call('move', { ids: ['m1'], folder: 'Kunder' });
    expect(f.moved).toEqual([
      ['m1', 'archive'],
      ['m1', 'Kunder']
    ]);
  });

  it('städar: listar avsändare per kategori, avregistrerar och flyttar med regel', async () => {
    const f = fakeHost();
    const call = createAgent(f.host);
    const news = JSON.parse(await call('senders', { category: 'newsletters' }));
    expect(news).toHaveLength(1);
    expect(news[0]).toMatchObject({ address: 'news@shop.se', emails: 40, category: 'newsletters', can_unsubscribe: true });
    await expect(call('senders', { category: 'skräp' })).rejects.toThrow(/Unknown category/);
    expect(await call('unsubscribe', { address: 'news@shop.se' })).toBe('Unsubscribed from news@shop.se.');
    expect(await call('clean_up', { address: 'news@shop.se', action: 'trash', always: true, older_than_days: 30 })).toMatch(/40 emails .* trash\. New emails/);
    expect(f.cleaned).toEqual(['avreg:news@shop.se', 'regel:trash:news@shop.se', 'trash:news@shop.se:30']);
    await expect(call('clean_up', { address: 'x@y.se', action: 'burn' })).rejects.toThrow(/action/);
  });


  it('tar fortfarande emot gamla svenska verktygsnamn och fältnamn', async () => {
    const f = fakeHost();
    const call = createAgent(f.host);
    const out = await call('skriv_utkast', { svar_pa: 'm1', text: 'Hej Karin!', oppna: false });
    expect(out).toContain('Id: d2');
    expect(f.drafts[0]).toMatchObject({ accountId: 'nordljus', subject: 'Re: Demo nästa vecka?', inReplyTo: '<k1@ex.se>' });
    expect(f.opened).toEqual([]);
    const list = JSON.parse(await call('lista_mejl', { konto: 'Nordljus', mapp: 'inkorg', bara_olasta: true, antal: 5 }));
    expect(list[0]).toMatchObject({ id: 'm1', subject: 'Demo nästa vecka?', unread: true });
    expect(await call('sok_kontakt', { fraga: 'Erik' })).toContain('erik.lind@ex.se');
    expect(await call('arkivera', { ids: ['m1'] })).toBe('Done, 1 emails.');
    await call('flytta', { ids: ['m1'], mapp: 'Kunder' });
    expect(f.moved).toEqual([
      ['m1', 'archive'],
      ['m1', 'Kunder']
    ]);
    await call('skicka_mejl', { konto: 'Gmail', till: 'anna@ex.se', amne: 'Hej', text: 'Hej Anna', hemlig_kopia: 'b@ex.se' });
    expect(f.sent[0]).toMatchObject({ accountId: 'gmail', to: 'anna@ex.se', subject: 'Hej', bcc: 'b@ex.se' });
    const news = JSON.parse(await call('avsandare', { kategori: 'nyhetsbrev' }));
    expect(news).toHaveLength(1);
    await call('stada', { adress: 'news@shop.se', atgard: 'radera', alltid: true });
    expect(f.cleaned).toEqual(['regel:trash:news@shop.se', 'trash:news@shop.se:']);
    await expect(call('nej_verktyg', {})).rejects.toThrow(/Unknown tool/);
    expect(AGENT_TOOLS.map((t) => t.name)).not.toContain('skriv_utkast');
  });

  it('accepterar svenska åtgärder och kategorier i de engelska verktygen', async () => {
    const f = fakeHost();
    const call = createAgent(f.host);
    expect(await call('clean_up', { address: 'a@b.se', action: 'arkivera' })).toMatch(/archived/);
    expect(await call('senders', { category: 'Nyhetsbrev' })).toContain('news@shop.se');
    expect(await call('senders', { category: 'newsletters' })).toContain('news@shop.se');
    expect(await call('list_emails', { folder: 'inkorg' })).toContain('m1');
    const sentAt = `${new Date().getFullYear() + 1}-03-04 10:00`;
    await call('send_email', { to: 'a@b.se', text: 'Hej', send_at: sentAt });
    expect(f.sent[0].followUpDays).toBe(new Date(new Date().getFullYear() + 1, 2, 4, 10, 0).getTime());
  });

  it('har engelska verktygsnamn i listan och ingen tankestreck i instruktionerna', () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['accounts', 'list_emails', 'search_emails', 'read_email', 'read_attachment', 'save_attachment', 'read_thread', 'draft_email', 'edit_draft', 'send_email', 'send_draft', 'archive', 'trash', 'mark', 'move', 'create_folder', 'senders', 'unsubscribe', 'clean_up', 'find_contact', 'remind', 'show_in_app'])
    );
    expect(names).toHaveLength(28);
    expect(JSON.stringify(AGENT_TOOLS) + AGENT_INSTRUCTIONS).not.toMatch(/[\u2013\u2014]/);
  });

  it('gör om HTML till läsbar text', () => {
    expect(stripHtml('<style>x{}</style><p>Hej&nbsp;du</p><div>Rad<br>två &amp; tre</div>')).toBe('Hej du\nRad\ntvå & tre');
  });
});

describe('MCP-servern över stdio', () => {
  let dir: string;
  let stop: () => void;
  let proc: ChildProcessWithoutNullStreams;
  let next = 1;
  const pending = new Map<number, (v: any) => void>();
  const rpc = (method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'brevlada-mcp-'));
    const script = join(dir, 'mr-mail-mcp.cjs');
    await build({ entryPoints: ['src/mcp/server.ts'], outfile: script, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const f = fakeHost();
    ({ stop } = await startAgentServer(dir, createAgent(f.host), () => undefined));
    proc = spawn(process.execPath, [script], { env: { ...process.env, MRMAIL_DATA: dir, MRMAIL_APP: join(dir, 'saknas.exe') } });
    let buf = '';
    proc.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        pending.get(msg.id)?.(msg);
      }
    });
  });

  afterAll(() => {
    proc?.kill();
    stop?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it('svarar på initialize och listar verktygen', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.result.serverInfo.name).toBe('mr-mail');
    expect(init.result.instructions).toMatch(/send_email/);
    expect(init.result.capabilities.tools.listChanged).toBe(true);
    const list = await rpc('tools/list');
    expect(list.result.tools.map((t: any) => t.name)).toContain('draft_email');
    expect(list.result.tools.map((t: any) => t.name)).toContain('edit_draft');
  });

  it('skickar anropen vidare till appen och returnerar fel som isError', async () => {
    const ok = await rpc('tools/call', { name: 'search_emails', arguments: { query: 'demo' } });
    expect(ok.result.isError).toBe(false);
    expect(JSON.parse(ok.result.content[0].text)[0].id).toBe('m1');
    const bad = await rpc('tools/call', { name: 'read_email', arguments: { id: 'finns-inte' } });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toBe('Meddelandet finns inte.');
    const unknown = await rpc('tools/call', { name: 'nej', arguments: {} });
    expect(unknown.error.code).toBe(-32602);
  });

  it('säger till när appen inte går att nå', async () => {
    stop();
    const res = await rpc('tools/call', { name: 'accounts', arguments: {} });
    expect(res.result.isError).toBe(true);
  });
});
