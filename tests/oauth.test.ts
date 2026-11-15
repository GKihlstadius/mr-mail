import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { authorize, buildAuthUrl, createPkce, emailFromIdToken, ENDPOINTS, GRAPH_TOKEN_SCOPE, hasGoogleCalendarScope, MS_MAIL_SCOPE, nameFromIdToken, refreshAccessToken, withCalendar, type OAuthEndpoints } from '../src/main/oauth';

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const idToken = (email: string, extra: Record<string, string> = {}) => `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ email, ...extra }))}.x`;

describe('OAuth', () => {
  let server: Server;
  let ep: OAuthEndpoints;
  const challenges = new Map<string, string>();
  const seen: Record<string, string>[] = [];

  beforeAll(async () => {
    // Låtsad tokentjänst: kontrollerar PKCE och svarar som Google.
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = Object.fromEntries(new URLSearchParams(body));
        seen.push(p);
        res.setHeader('Content-Type', 'application/json');
        if (p.grant_type === 'authorization_code') {
          const expected = challenges.get(p.code);
          const actual = b64url(createHash('sha256').update(p.code_verifier ?? '').digest());
          if (!expected || expected !== actual) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
          res.end(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'https://mail.google.com/ https://www.googleapis.com/auth/calendar.events', id_token: idToken('Alex@Gmail.com', { name: 'Alex Berg' }) }));
        } else if (p.grant_type === 'refresh_token') {
          if (p.refresh_token !== 'rt-1') {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
          res.end(JSON.stringify({ access_token: 'at-2', expires_in: 1800 }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    ep = { ...ENDPOINTS.google, auth: 'https://accounts.example/auth', token: `http://127.0.0.1:${port}/token` };
  });

  afterAll(() => server.close());

  it('PKCE-utmaningen är SHA-256 av verifieraren', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(b64url(createHash('sha256').update(verifier).digest()));
  });

  it('bygger inloggningsadressen med PKCE och loopback', () => {
    const u = new URL(buildAuthUrl(ENDPOINTS.google, { clientId: 'cid' }, 'http://127.0.0.1:5000/', 'ch', 'st', 'a@b.se'));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toContain('https://mail.google.com/');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('login_hint')).toBe('a@b.se');
    expect(new URL(buildAuthUrl(ENDPOINTS.microsoft, { clientId: 'x' }, 'http://localhost:1/', 'c', 's')).searchParams.get('scope')).toContain('IMAP.AccessAsUser.All');
  });

  it('läser namnet ur id_token och ber Google om profilen', () => {
    expect(nameFromIdToken(idToken('a@b.se', { given_name: 'Anna', family_name: 'Berg' }))).toBe('Anna Berg');
    expect(nameFromIdToken(idToken('a@b.se'))).toBeUndefined();
    expect(ENDPOINTS.google.scope.split(' ')).toContain('profile');
  });

  it('kan avbrytas medan den väntar på webbläsaren', async () => {
    const ctrl = new AbortController();
    const done = authorize('google', { clientId: 'cid' }, () => void setTimeout(() => ctrl.abort(), 50), { endpoints: ep, signal: ctrl.signal });
    await expect(done).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('läser e-postadressen ur id_token', () => {
    expect(emailFromIdToken(idToken('Anna@Example.se'))).toBe('anna@example.se');
    expect(emailFromIdToken('trasig')).toBeUndefined();
  });

  it('loggar in via webbläsaren och byter koden mot token', async () => {
    const tokens = await authorize('google', { clientId: 'cid', clientSecret: 'hemlig' }, async (url) => {
      const u = new URL(url);
      challenges.set('kod-1', u.searchParams.get('code_challenge')!);
      const redirect = new URL(u.searchParams.get('redirect_uri')!);
      expect(redirect.hostname).toBe('127.0.0.1');
      // Webbläsaren skickas tillbaka till loopback-servern med koden.
      const r = await fetch(`${redirect.origin}/?code=kod-1&state=${u.searchParams.get('state')}`);
      expect(await r.text()).toContain('Du är inloggad');
    }, { endpoints: ep });
    expect(tokens).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1', email: 'alex@gmail.com', name: 'Alex Berg' });
    expect(seen.at(-1)?.client_secret).toBe('hemlig');
  });

  it('avvisar svar med fel state och nekad åtkomst', async () => {
    await expect(
      authorize('google', { clientId: 'cid' }, async (url) => {
        const redirect = new URL(new URL(url).searchParams.get('redirect_uri')!);
        await fetch(`${redirect.origin}/?code=x&state=fel`).catch(() => undefined);
      }, { endpoints: ep })
    ).rejects.toThrow(/verifieras/);
    await expect(
      authorize('google', { clientId: 'cid' }, async (url) => {
        const u = new URL(url);
        const redirect = new URL(u.searchParams.get('redirect_uri')!);
        await fetch(`${redirect.origin}/?error=access_denied&state=${u.searchParams.get('state')}`).catch(() => undefined);
      }, { endpoints: ep })
    ).rejects.toThrow(/nekade/);
    await expect(authorize('google', { clientId: '' }, () => undefined, { endpoints: ep })).rejects.toThrow(/Klient-id saknas/);
  });

  it('förnyar åtkomsttoken och förklarar utgången inloggning', async () => {
    expect((await refreshAccessToken(ep, { clientId: 'cid' }, 'rt-1')).accessToken).toBe('at-2');
    await expect(refreshAccessToken(ep, { clientId: 'cid' }, 'gammal')).rejects.toThrow(/gått ut/);
  });

  it('kalendern: Google ber om Calendar API och förnyar utan scope, så att äldre inloggningar fortsätter fungera', async () => {
    expect(ENDPOINTS.google.scope.split(' ')).toEqual(expect.arrayContaining(['https://mail.google.com/', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly']));
    seen.length = 0;
    await refreshAccessToken(ep, { clientId: 'cid' }, 'rt-1');
    expect(seen[0]).toEqual({ client_id: 'cid', grant_type: 'refresh_token', refresh_token: 'rt-1' });
    expect(hasGoogleCalendarScope('https://mail.google.com/ https://www.googleapis.com/auth/calendar.events')).toBe(true);
    expect(hasGoogleCalendarScope('https://mail.google.com/ openid')).toBe(false);
    expect(hasGoogleCalendarScope(undefined)).toBe(false);
  });

  it('kalendern: Microsoft samtycker till Graph vid inloggningen men e-posten får samma token som förut', async () => {
    const ms: OAuthEndpoints = { ...ENDPOINTS.microsoft, token: ep.token, host: '127.0.0.1' };
    // Vanlig inloggning ber bara om e-post, så att en spärr för Graph aldrig stoppar mejlen.
    const mailScope = new URL(buildAuthUrl(ENDPOINTS.microsoft, { clientId: 'x' }, 'http://localhost:1/', 'c', 's')).searchParams.get('scope')!;
    expect(mailScope.split(' ')).not.toContain('https://graph.microsoft.com/Calendars.ReadWrite');
    // Inloggning från kalendern lägger till Graph.
    const authScope = new URL(buildAuthUrl(withCalendar('microsoft', ENDPOINTS.microsoft), { clientId: 'x' }, 'http://localhost:1/', 'c', 's')).searchParams.get('scope')!;
    expect(authScope.split(' ')).toEqual(expect.arrayContaining(['https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send', 'offline_access', 'https://graph.microsoft.com/Calendars.ReadWrite']));
    expect(withCalendar('google', ENDPOINTS.google)).toBe(ENDPOINTS.google);
    // Koden och förnyelsen för e-post ber bara om e-postens resurs, som före kalendern.
    expect(MS_MAIL_SCOPE).toBe('https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile');
    expect(ENDPOINTS.microsoft.tokenScope).toBe(MS_MAIL_SCOPE);
    seen.length = 0;
    const tokens = await authorize('microsoft', { clientId: 'cid' }, async (url) => {
      const u = new URL(url);
      challenges.set('kod-ms', u.searchParams.get('code_challenge')!);
      const redirect = new URL(u.searchParams.get('redirect_uri')!);
      await fetch(`${redirect.origin}/?code=kod-ms&state=${u.searchParams.get('state')}`);
    }, { endpoints: ms });
    expect(tokens.refreshToken).toBe('rt-1');
    expect(seen[0]).toMatchObject({ grant_type: 'authorization_code', code: 'kod-ms', scope: MS_MAIL_SCOPE });
    seen.length = 0;
    await refreshAccessToken(ms, { clientId: 'cid' }, 'rt-1');
    expect(seen[0]).toEqual({ client_id: 'cid', grant_type: 'refresh_token', refresh_token: 'rt-1', scope: MS_MAIL_SCOPE });
    await refreshAccessToken(ms, { clientId: 'cid' }, 'rt-1', GRAPH_TOKEN_SCOPE);
    expect(seen[1]).toEqual({ client_id: 'cid', grant_type: 'refresh_token', refresh_token: 'rt-1', scope: 'https://graph.microsoft.com/Calendars.ReadWrite offline_access' });
  });

  it('läser de godkända behörigheterna ur tokensvaret', async () => {
    const tokens = await authorize('google', { clientId: 'cid' }, async (url) => {
      const u = new URL(url);
      challenges.set('kod-2', u.searchParams.get('code_challenge')!);
      const redirect = new URL(u.searchParams.get('redirect_uri')!);
      await fetch(`${redirect.origin}/?code=kod-2&state=${u.searchParams.get('state')}`);
    }, { endpoints: ep });
    expect(tokens.scope).toContain('calendar.events');
    expect(seen.at(-1)?.scope).toBeUndefined();
  });
});
