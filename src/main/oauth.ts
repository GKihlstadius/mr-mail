import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { APP_NAME } from '../shared/brand';
import { getLang, t } from '../shared/i18n';

// OAuth 2.0 med PKCE och loopback-omdirigering (RFC 8252) för Gmail och Outlook.
// Webbläsaren öppnas mot leverantören, svaret kommer tillbaka till en tillfällig server på 127.0.0.1.

export type OAuthProvider = 'google' | 'microsoft';

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
}

export interface OAuthEndpoints {
  auth: string;
  token: string;
  scope: string;
  // Google godtar 127.0.0.1 med valfri port, Microsoft kräver http://localhost för skrivbordsappar.
  host: '127.0.0.1' | 'localhost';
  extra?: Record<string, string>;
}

export const ENDPOINTS: Record<OAuthProvider, OAuthEndpoints> = {
  google: {
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'https://mail.google.com/ openid email profile',
    host: '127.0.0.1',
    extra: { access_type: 'offline', prompt: 'consent' }
  },
  microsoft: {
    auth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile',
    host: 'localhost',
    extra: { prompt: 'select_account' }
  }
};

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  email?: string;
  name?: string;
}

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function createPkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthUrl(ep: OAuthEndpoints, client: OAuthClient, redirectUri: string, challenge: string, state: string, loginHint?: string): string {
  const u = new URL(ep.auth);
  const params: Record<string, string> = {
    client_id: client.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: ep.scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    ...(ep.extra ?? {})
  };
  if (loginHint) params.login_hint = loginHint;
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function idTokenPayload(idToken?: string): Record<string, unknown> | null {
  if (!idToken) return null;
  try {
    return JSON.parse(Buffer.from(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// E-postadressen ur id_token. Token kommer direkt från leverantörens tokenadress över TLS, därför räcker avkodning.
export function emailFromIdToken(idToken?: string): string | undefined {
  const p = idTokenPayload(idToken);
  const email = p?.email ?? p?.preferred_username ?? p?.upn;
  return typeof email === 'string' ? email.toLowerCase() : undefined;
}

// Namnet på kontoinnehavaren, till avsändarnamnet.
export function nameFromIdToken(idToken?: string): string | undefined {
  const p = idTokenPayload(idToken);
  const name = p?.name ?? [p?.given_name, p?.family_name].filter((x) => typeof x === 'string' && x).join(' ');
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

export class OAuthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function tokenRequest(ep: OAuthEndpoints, client: OAuthClient, body: Record<string, string>): Promise<TokenSet> {
  const form = new URLSearchParams({ client_id: client.clientId, ...body });
  if (client.clientSecret) form.set('client_secret', client.clientSecret);
  let res: Response;
  try {
    res = await fetch(ep.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form });
  } catch (err: any) {
    throw new OAuthError('network', t('Når inte inloggningstjänsten: {error}', { error: err?.message ?? err }));
  }
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !data.access_token) {
    const code = String(data.error ?? res.status);
    const msg =
      code === 'invalid_grant'
        ? t('Inloggningen har gått ut eller dragits tillbaka. Logga in igen.')
        : code === 'invalid_client' || code === 'unauthorized_client'
          ? t('Klient-id eller klienthemlighet stämmer inte. Kontrollera inställningarna för OAuth.')
          : t('Inloggningen misslyckades ({detail}).', { detail: data.error_description ?? code });
    throw new OAuthError(code, msg);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
    email: emailFromIdToken(data.id_token),
    name: nameFromIdToken(data.id_token)
  };
}

export function refreshAccessToken(ep: OAuthEndpoints, client: OAuthClient, refreshToken: string): Promise<TokenSet> {
  return tokenRequest(ep, client, { grant_type: 'refresh_token', refresh_token: refreshToken, scope: ep.scope });
}

const DONE_PAGE = (ok: boolean, text: string) =>
  `<!doctype html><html lang="${getLang()}"><head><meta charset="utf-8"><title>${APP_NAME}</title><style>body{font:16px/1.5 "Segoe UI",system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f5f5f7;color:#1d1d1f}div{background:#fff;padding:32px 40px;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.08);text-align:center}h1{font-size:20px;margin:0 0 6px;color:${ok ? '#1d1d1f' : '#c0392b'}}</style></head><body><div><h1>${ok ? t('Klart') : t('Inloggningen avbröts')}</h1><p>${text}</p></div></body></html>`;

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });
}

// Hela inloggningen: öppnar webbläsaren, väntar på svaret och byter koden mot token.
export async function authorize(
  provider: OAuthProvider,
  client: OAuthClient,
  openUrl: (url: string) => Promise<unknown> | unknown,
  opts: { endpoints?: OAuthEndpoints; loginHint?: string; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<TokenSet> {
  if (!client.clientId) throw new OAuthError('no_client', t('Klient-id saknas. Fyll i det under Inställningar, se docs/oauth.md.'));
  const ep = opts.endpoints ?? ENDPOINTS[provider];
  const { verifier, challenge } = createPkce();
  const state = b64url(randomBytes(16));
  const servers: Server[] = [];
  let finish: (v: { code?: string; error?: string }) => void = () => undefined;
  const result = new Promise<{ code?: string; error?: string }>((resolve) => (finish = resolve));
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/' || (!url.searchParams.has('code') && !url.searchParams.has('error'))) {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get('error');
    const okState = url.searchParams.get('state') === state;
    const code = url.searchParams.get('code');
    const success = !error && okState && !!code;
    res.writeHead(success ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DONE_PAGE(success, success ? t('Du är inloggad. Stäng den här fliken och gå tillbaka till {app}.', { app: APP_NAME }) : t('Gå tillbaka till {app} och försök igen.', { app: APP_NAME })));
    if (!okState && !error) finish({ error: 'state' });
    else finish({ code: code ?? undefined, error: error ?? undefined });
  };
  const main = createServer(handler);
  servers.push(main);
  const port = await listen(main, '127.0.0.1', 0);
  if (ep.host === 'localhost') {
    // localhost kan slås upp till ::1, lyssna på båda loopback-adresserna.
    const v6 = createServer(handler);
    await listen(v6, '::1', port).then(() => servers.push(v6)).catch(() => v6.close());
  }
  const redirectUri = `http://${ep.host}:${port}/`;
  const timer = setTimeout(() => finish({ error: 'timeout' }), opts.timeoutMs ?? 5 * 60 * 1000);
  if (opts.signal?.aborted) finish({ error: 'cancelled' });
  opts.signal?.addEventListener('abort', () => finish({ error: 'cancelled' }), { once: true });
  try {
    await openUrl(buildAuthUrl(ep, client, redirectUri, challenge, state, opts.loginHint));
    const r = await result;
    if (r.error === 'cancelled') throw new OAuthError('cancelled', t('Inloggningen avbröts.'));
    if (r.error === 'timeout') throw new OAuthError('timeout', t('Ingen inloggning inom fem minuter. Försök igen.'));
    if (r.error === 'access_denied') throw new OAuthError('access_denied', t('Du nekade åtkomst i webbläsaren.'));
    if (r.error === 'state') throw new OAuthError('state', t('Svaret från webbläsaren kunde inte verifieras. Försök igen.'));
    if (r.error || !r.code) throw new OAuthError(r.error ?? 'no_code', t('Inloggningen avbröts ({detail}).', { detail: r.error ?? t('ingen kod') }));
    const tokens = await tokenRequest(ep, client, { grant_type: 'authorization_code', code: r.code, code_verifier: verifier, redirect_uri: redirectUri });
    if (!tokens.refreshToken) throw new OAuthError('no_refresh', t('Leverantören gav ingen förnyelsenyckel. Ta bort åtkomsten för {app} i kontot och logga in igen.', { app: APP_NAME }));
    return tokens;
  } finally {
    clearTimeout(timer);
    for (const s of servers) s.close();
  }
}

export function providerFor(accountProvider: string): OAuthProvider | null {
  if (accountProvider === 'gmail') return 'google';
  if (accountProvider === 'outlook') return 'microsoft';
  return null;
}
