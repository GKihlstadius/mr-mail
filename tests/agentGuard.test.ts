import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeCall, effectivePermission, guardAgent, permissionKinds, summarizeCall, type AgentLogInput, type AskRequest } from '../src/main/agentGuard';
import { Store } from '../src/main/db';
import { setLang } from '../src/shared/i18n';
import type { AgentPermissions } from '../src/shared/types';

const lookup = (id: string) =>
  ({
    d1: { subject: 'Offert', from: 'Alex <alex@x.se>', to: 'karin@x.se' },
    m1: { subject: 'Rea', from: 'Butik <rea@butik.se>', to: 'alex@x.se' }
  })[id] ?? null;

function setup(perms: Partial<AgentPermissions>, answer = true) {
  const asked: AskRequest[] = [];
  const logged: AgentLogInput[] = [];
  const ran: string[] = [];
  const call = guardAgent(
    async (tool, args) => {
      ran.push(tool);
      if (args.fail) throw new Error('Recipient missing (to).');
      return `ran ${tool}`;
    },
    {
      permissions: () => perms,
      ask: async (req) => {
        asked.push(req);
        return answer;
      },
      log: (e) => logged.push(e),
      lookup
    }
  );
  return { call, asked, logged, ran };
}

describe('Behörigheter för AI-verktyg', () => {
  it('rätt behörighet per verktyg, även gamla namn', () => {
    expect(permissionKinds('send_email', {})).toEqual(['send']);
    expect(permissionKinds('skicka_utkast', {})).toEqual(['send']);
    expect(permissionKinds('radera', {})).toEqual(['delete']);
    expect(permissionKinds('unsubscribe', {})).toEqual(['unsubscribe']);
    expect(permissionKinds('clean_up', { action: 'archive' })).toEqual(['unsubscribe']);
    expect(permissionKinds('stada', { atgard: 'radera' })).toEqual(['unsubscribe', 'delete']);
    expect(permissionKinds('archive', {})).toEqual([]);
    expect(permissionKinds('draft_email', {})).toEqual([]);
  });

  it('den strängaste vinner och saknade värden betyder fråga', () => {
    expect(effectivePermission(['unsubscribe', 'delete'], { unsubscribe: 'allow', delete: 'never' })).toBe('never');
    expect(effectivePermission(['unsubscribe', 'delete'], { unsubscribe: 'allow', delete: 'allow' })).toBe('allow');
    expect(effectivePermission(['send'], {})).toBe('ask');
    expect(effectivePermission(['send'], { send: 'konstigt' as any })).toBe('ask');
    expect(effectivePermission([], { send: 'never' })).toBe('allow');
  });

  it('allow kör utan att fråga och loggar', async () => {
    const g = setup({ send: 'allow' });
    expect(await g.call('send_email', { to: 'karin@x.se', subject: 'Demo', text: 'Hemligt innehåll' }, { client: 'Claude Code' })).toBe('ran send_email');
    expect(g.asked).toHaveLength(0);
    expect(g.logged).toEqual([{ tool: 'send_email', summary: 'to: karin@x.se, subject: Demo', ok: true, client: 'Claude Code' }]);
  });

  it('never kör inte och föreslår ett utkast', async () => {
    const g = setup({ send: 'never' });
    await expect(g.call('send_email', { to: 'karin@x.se', text: 'x' })).rejects.toThrow(/turned off sending.*draft_email/);
    expect(g.ran).toEqual([]);
    expect(g.asked).toHaveLength(0);
    expect(g.logged[0]).toMatchObject({ tool: 'send_email', ok: false });
  });

  it('ask frågar med vad som ska hända; nej stoppar, ja kör', async () => {
    setLang('sv');
    const no = setup({ send: 'ask' }, false);
    await expect(no.call('send_draft', { id: 'd1' }, { client: 'Claude Code' })).rejects.toThrow(/declined/);
    expect(no.asked[0].message).toBe('Claude Code vill skicka utkastet till karin@x.se med ämnet "Offert".');
    expect(no.ran).toEqual([]);
    expect(no.logged[0]).toMatchObject({ ok: false, error: 'Nekat av dig' });
    const yes = setup({ delete: 'ask' }, true);
    expect(await yes.call('trash', { ids: ['m1'] })).toBe('ran trash');
    expect(yes.asked[0].message).toBe('Ett AI-verktyg vill flytta ett mejl till papperskorgen.');
    expect(yes.asked[0].detail).toContain('Rea');
  });

  it('ofarliga verktyg frågar aldrig, fel loggas som fel', async () => {
    const g = setup({ send: 'never', delete: 'never', unsubscribe: 'never' });
    expect(await g.call('list_emails', { query: 'faktura' })).toBe('ran list_emails');
    await expect(g.call('draft_email', { fail: true })).rejects.toThrow(/Recipient/);
    expect(g.logged.map((e) => [e.tool, e.ok])).toEqual([
      ['list_emails', true],
      ['draft_email', false]
    ]);
    expect(g.logged[1].error).toContain('Recipient missing');
  });

  it('sammanfattningen tar aldrig med texten eller hemlig kopia', () => {
    const s = summarizeCall('send_email', { till: 'karin@x.se', amne: 'Hej', text: 'lösenord 1234', bcc: 'hemlig@x.se', bilagor: ['C:\\a.pdf'] });
    expect(s).toBe('to: karin@x.se, subject: Hej, attachments: 1');
    expect(summarizeCall('search_emails', { query: 'invoice' })).toBe('query: invoice');
    expect(summarizeCall('archive', { ids: ['a', 'b', 'c'] })).toBe('ids: 3');
  });

  it('beskriver svar med mottagare från originalet', () => {
    setLang('sv');
    const d = describeCall('send_email', { reply_to: 'm1', text: 'x', send_at: '2026-12-01 09:00' }, 'Zed', lookup);
    expect(d.message).toBe('Zed vill skicka ett mejl till Butik <rea@butik.se> med ämnet "Re: Rea".');
    expect(d.detail).toContain('2026-12-01 09:00');
    setLang('en');
    expect(describeCall('clean_up', { address: 'rea@butik.se', action: 'trash', always: true }, undefined).message).toBe('An AI tool wants to move all emails from rea@butik.se to the trash.');
    setLang('sv');
  });
});

describe('Aktivitetsloggen', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('sparar de senaste 500, nyast först, och kan rensas', () => {
    dir = mkdtempSync(join(tmpdir(), 'mrmail-log-'));
    const store = new Store(join(dir, 'test.db'));
    try {
      for (let i = 0; i < 510; i++) store.addAgentLog({ tool: 'list_emails', summary: `n ${i}`, ok: i % 2 === 0, error: i % 2 ? 'fel' : '', client: 'Zed', at: 1000 + i });
      const all = store.listAgentLog(1000);
      expect(all).toHaveLength(500);
      expect(all[0]).toMatchObject({ summary: 'n 509', ok: false, error: 'fel', client: 'Zed', at: 1509 });
      expect(all.at(-1)!.summary).toBe('n 10');
      expect(store.listAgentLog()).toHaveLength(50);
      store.clearAgentLog();
      expect(store.listAgentLog()).toEqual([]);
      expect(store.getSettings().agentPermissions).toEqual({ send: 'ask', delete: 'ask', unsubscribe: 'ask' });
    } finally {
      store.close();
    }
  });
});
