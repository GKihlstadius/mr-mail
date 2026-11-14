import { describe, expect, it } from 'vitest';
import net from 'node:net';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { baseDomain, defaultDeps, discover, findWorkingConfig, parseAutoconfig, safeToTry, type Candidate, type DiscoverDeps } from '../src/main/discover';
import { makeAccount } from '../src/shared/accounts';
import { probeImap } from '../src/main/imap';
import { testSmtp } from '../src/main/smtp';

const xml = (host: string, user = '%EMAILADDRESS%', extra = '') => `<?xml version="1.0"?>
<clientConfig version="1.1"><emailProvider id="exempel.se">
  ${extra}
  <incomingServer type="imap"><hostname>${host}</hostname><port>993</port><socketType>SSL</socketType><username>${user}</username><authentication>password-cleartext</authentication></incomingServer>
  <incomingServer type="pop3"><hostname>pop.${host}</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
  <outgoingServer type="smtp"><hostname>smtp.exempel.se</hostname><port>587</port><socketType>STARTTLS</socketType><username>${user}</username></outgoingServer>
</emailProvider></clientConfig>`;

function deps(over: Partial<DiscoverDeps> & { pages?: Record<string, string> } = {}): DiscoverDeps {
  const pages = over.pages ?? {};
  return {
    fetchText: async (u) => pages[u.split('?')[0]] ?? null,
    resolveMx: async () => [],
    resolveSrv: async () => [],
    ispdb: 'https://ispdb.test/',
    ...over
  };
}

describe('upptäckt av servrar', () => {
  it('känner igen vanliga leverantörer direkt', async () => {
    const c = await discover('anna@gmail.com', deps({ resolveMx: async () => { throw new Error('ska inte fråga'); } }));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ provider: 'gmail', source: 'leverantör', imap: { host: 'imap.gmail.com' } });
    expect((await discover('a@nordljus.se', deps({ resolveMx: async () => ['mx1.simply.com'] })))[0].provider).toBe('simply');
  });

  it('ser Google Workspace och Microsoft 365 på MX-posten', async () => {
    const g = await discover('anna@foretag.se', deps({ resolveMx: async () => ['aspmx.l.google.com'] }));
    expect(g[0]).toMatchObject({ provider: 'gmail', source: 'mx', username: 'anna@foretag.se' });
    const m = await discover('anna@bolag.se', deps({ resolveMx: async () => ['bolag-se.mail.protection.outlook.com.'] }));
    expect(m[0].provider).toBe('outlook');
  });

  it('läser autoconfig hos domänen, med lokal del som användarnamn', async () => {
    const c = await discover('kalle@exempel.se', deps({ pages: { 'https://autoconfig.exempel.se/mail/config-v1.1.xml': xml('imap.exempel.se', '%EMAILLOCALPART%') } }));
    expect(c[0]).toMatchObject({
      source: 'autoconfig',
      imap: { host: 'imap.exempel.se', port: 993, security: 'ssl' },
      smtp: { host: 'smtp.exempel.se', port: 587, security: 'starttls' },
      username: 'kalle'
    });
  });

  it('frågar Mozillas databas om MX-domänen när domänen själv saknar autoconfig', async () => {
    const c = await discover('kalle@litenfirma.se', deps({ resolveMx: async () => ['mx2.one.com'], pages: { 'https://ispdb.test/one.com': xml('imap.one.com') } }));
    expect(c[0]).toMatchObject({ source: 'autoconfig', imap: { host: 'imap.one.com' } });
    expect(baseDomain('mx1.mail.example.co.uk')).toBe('example.co.uk');
  });

  it('använder SRV-poster och gissar till sist vanliga namn', async () => {
    const c = await discover('a@srv.se', deps({
      resolveSrv: async (n) => (n.startsWith('_imaps') ? [{ name: 'post.srv.se', port: 993 }] : n.startsWith('_submission.') ? [{ name: 'ut.srv.se', port: 587 }] : [])
    }));
    expect(c[0]).toMatchObject({ source: 'srv', imap: { host: 'post.srv.se' }, smtp: { host: 'ut.srv.se', security: 'starttls' } });
    expect(c.slice(1).map((x) => x.imap.host)).toEqual(['imap.srv.se', 'mail.srv.se']);
    expect(c.every((x) => x.imap.security === 'ssl')).toBe(true);
  });

  it('tar inte med servrar utan IMAP eller utan SMTP', () => {
    expect(parseAutoconfig('<clientConfig><incomingServer type="pop3"><hostname>x</hostname><port>1</port></incomingServer></clientConfig>', 'a@b.se')).toEqual([]);
  });

  it('provar aldrig okrypterat mot andra datorer', () => {
    const base = { provider: 'manual', username: 'a', source: 'autoconfig' } as const;
    expect(safeToTry({ ...base, imap: { host: 'mail.x.se', port: 143, security: 'none' }, smtp: { host: 'mail.x.se', port: 465, security: 'ssl' } })).toBe(false);
    expect(safeToTry({ ...base, imap: { host: '127.0.0.1', port: 3143, security: 'none' }, smtp: { host: '127.0.0.1', port: 3025, security: 'none' } })).toBe(true);
  });
});

const cand = (host: string, over: Partial<Candidate> = {}): Candidate => ({
  provider: 'manual',
  imap: { host, port: 993, security: 'ssl' },
  smtp: { host: `smtp.${host}`, port: 587, security: 'starttls' },
  username: 'kalle@exempel.se',
  source: 'gissning',
  ...over
});

describe('provning av inställningar', () => {
  it('hoppar över servrar som inte svarar och tar den första som godtar lösenordet', async () => {
    const tried: string[] = [];
    const res = await findWorkingConfig('kalle@exempel.se', 'hemligt', [cand('a.se'), cand('b.se')], {
      imap: async (c) => (tried.push(c.imap.host), c.imap.host === 'a.se' ? { kind: 'unreachable', message: 'nej' } : { kind: 'ok' }),
      smtp: async () => null
    });
    expect(tried).toEqual(['a.se', 'b.se']);
    expect(res.ok && res.candidate.imap.host).toBe('b.se');
  });

  it('slutar vid fel lösenord, men provar först lokala delen som användarnamn', async () => {
    const users: string[] = [];
    const res = await findWorkingConfig('kalle@exempel.se', 'fel', [cand('a.se'), cand('b.se')], {
      imap: async (c) => (users.push(`${c.imap.host} ${c.username}`), { kind: 'auth', message: 'Inloggningen misslyckades.' }),
      smtp: async () => null
    });
    expect(res).toMatchObject({ ok: false, reason: 'auth' });
    expect(users).toEqual(['a.se kalle@exempel.se', 'a.se kalle']);

    const ok = await findWorkingConfig('kalle@exempel.se', 'rätt', [cand('a.se')], {
      imap: async (c) => (c.username === 'kalle' ? { kind: 'ok' } : { kind: 'auth', message: 'x' }),
      smtp: async () => null
    });
    expect(ok.ok && ok.candidate.username).toBe('kalle');
  });

  it('provar port 465 när 587 inte fungerar för utgående post', async () => {
    const res = await findWorkingConfig('kalle@exempel.se', 'x', [cand('a.se')], {
      imap: async () => ({ kind: 'ok' }),
      smtp: async (c) => (c.smtp.port === 465 ? null : 'Når inte SMTP-servern.')
    });
    expect(res.ok && res.candidate.smtp).toEqual({ host: 'smtp.a.se', port: 465, security: 'ssl' });
  });

  it('säger tydligt när inget hittas', async () => {
    const res = await findWorkingConfig('kalle@okand.se', 'x', [], { imap: async () => ({ kind: 'ok' }), smtp: async () => null });
    expect(res).toMatchObject({ ok: false, reason: 'notfound' });
    if (!res.ok) expect(res.message).toContain('okand.se');
  });
});

// Hela vägen mot GreenMail: autoconfig från en lokal webbserver, sedan riktiga IMAP- och SMTP-prov.
const HOST = process.env.GREENMAIL_HOST ?? '127.0.0.1';
const up = await new Promise<boolean>((resolve) => {
  const s = net.connect(3143, HOST);
  s.once('connect', () => (s.destroy(), resolve(true)));
  s.once('error', () => resolve(false));
});

describe.skipIf(!up)('enkel inloggning mot GreenMail', () => {
  it('hittar servrarna via autoconfig och loggar in', async () => {
    const config = `<clientConfig version="1.1"><emailProvider id="test.local">
      <incomingServer type="imap"><hostname>${HOST}</hostname><port>3143</port><socketType>plain</socketType><username>%EMAILADDRESS%</username></incomingServer>
      <outgoingServer type="smtp"><hostname>${HOST}</hostname><port>3025</port><socketType>plain</socketType><username>%EMAILADDRESS%</username></outgoingServer>
    </emailProvider></clientConfig>`;
    const server = createServer((req, res) => {
      if (req.url === '/test.local') res.writeHead(200, { 'Content-Type': 'text/xml' }).end(config);
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    process.env.MRMAIL_ISPDB = `http://127.0.0.1:${port}/`;
    process.env.MRMAIL_NO_DNS = '1';
    try {
      const email = `ny-${Date.now().toString(36)}@test.local`;
      const candidates = await discover(email, defaultDeps());
      expect(candidates[0]).toMatchObject({ source: 'autoconfig', imap: { host: HOST, port: 3143 } });
      const toCfg = (c: Candidate) => makeAccount(email, c.provider, { imap: c.imap, smtp: c.smtp, username: c.username });
      const res = await findWorkingConfig(email, 'lösen', candidates, {
        imap: (c, pw) => probeImap(toCfg(c), pw, 4000),
        smtp: (c, pw) => testSmtp(toCfg(c), pw, 4000)
      });
      expect(res).toMatchObject({ ok: true, candidate: { imap: { port: 3143 }, smtp: { port: 3025 } } });
    } finally {
      delete process.env.MRMAIL_ISPDB;
      delete process.env.MRMAIL_NO_DNS;
      server.close();
    }
  });
});
