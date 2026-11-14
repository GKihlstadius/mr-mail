import { promises as dns } from 'node:dns';
import type { ProviderId, Security, ServerConfig } from '../shared/types';
import { getProvider, PROVIDERS } from '../shared/accounts';
import { t } from '../shared/i18n';

// Hittar IMAP- och SMTP-servrar utifrån bara e-postadressen, ungefär som Thunderbird:
// kända leverantörer, MX-poster, autoconfig hos domänen och i Mozillas databas, SRV-poster, vanliga namn.

export interface Candidate {
  provider: ProviderId;
  imap: ServerConfig;
  smtp: ServerConfig;
  // Användarnamnet för inloggningen, oftast hela adressen.
  username: string;
  source: 'leverantör' | 'mx' | 'autoconfig' | 'srv' | 'gissning';
}

export interface DiscoverDeps {
  fetchText(url: string): Promise<string | null>;
  resolveMx(domain: string): Promise<string[]>;
  resolveSrv(name: string): Promise<{ name: string; port: number }[]>;
  // Mozillas databas, kan bytas ut i tester.
  ispdb: string;
}

export const ISPDB = 'https://autoconfig.thunderbird.net/v1.1/';

// MX-värdar som avslöjar leverantören, till exempel Google Workspace på en egen domän.
const MX_PROVIDERS: { suffix: string[]; provider: ProviderId }[] = [
  { suffix: ['google.com', 'googlemail.com'], provider: 'gmail' },
  { suffix: ['outlook.com', 'protection.outlook.com', 'hotmail.com'], provider: 'outlook' },
  { suffix: ['icloud.com', 'me.com'], provider: 'icloud' },
  { suffix: ['simply.com'], provider: 'simply' }
];

export function domainOf(email: string): string {
  return email.trim().toLowerCase().split('@')[1] ?? '';
}

function localPart(email: string): string {
  return email.trim().split('@')[0] ?? '';
}

function fromPreset(provider: ProviderId, email: string, source: Candidate['source']): Candidate {
  const p = getProvider(provider);
  return { provider, imap: { ...p.imap }, smtp: { ...p.smtp }, username: email.trim(), source };
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

function securityOf(socketType: string): Security {
  const s = socketType.toUpperCase();
  if (s === 'SSL' || s === 'TLS') return 'ssl';
  if (s === 'STARTTLS') return 'starttls';
  return 'none';
}

function fillUser(template: string, email: string): string {
  return template
    .replace(/%EMAILADDRESS%/g, email)
    .replace(/%EMAILLOCALPART%/g, localPart(email))
    .replace(/%EMAILDOMAIN%/g, domainOf(email));
}

// Läser Thunderbirds format (clientConfig 1.1). Krypterade servrar först, sedan i filens ordning.
export function parseAutoconfig(xml: string, email: string): Candidate[] {
  const pick = (kind: 'incomingServer' | 'outgoingServer', type: string) => {
    const re = new RegExp(`<${kind}\\s+type="${type}"[^>]*>([\\s\\S]*?)</${kind}>`, 'gi');
    const out: { server: ServerConfig; username: string }[] = [];
    for (const m of xml.matchAll(re)) {
      const host = fillUser(tag(m[1], 'hostname'), email);
      const port = Number(tag(m[1], 'port'));
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue;
      out.push({ server: { host, port, security: securityOf(tag(m[1], 'socketType')) }, username: fillUser(tag(m[1], 'username') || '%EMAILADDRESS%', email) });
    }
    const rank = (s: ServerConfig) => (s.security === 'none' ? 1 : 0);
    return out.sort((a, b) => rank(a.server) - rank(b.server));
  };
  const imap = pick('incomingServer', 'imap');
  const smtp = pick('outgoingServer', 'smtp');
  if (!imap.length || !smtp.length) return [];
  return imap.map((i) => ({ provider: 'manual', imap: i.server, smtp: smtp[0].server, username: i.username, source: 'autoconfig' }));
}

// Basdomänen ur en MX-värd, mx1.one.com ger one.com. Räcker för Mozillas databas.
export function baseDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.');
  const twoLevel = /^(co|com|org|net|ac|gov)\.[a-z]{2}$/.test(parts.slice(-2).join('.'));
  return parts.slice(twoLevel ? -3 : -2).join('.');
}

function providerFromMx(mx: string[]): ProviderId | null {
  for (const host of mx) {
    const h = host.toLowerCase().replace(/\.$/, '');
    for (const p of MX_PROVIDERS) if (p.suffix.some((s) => h === s || h.endsWith(`.${s}`))) return p.provider;
  }
  return null;
}

function key(c: Candidate): string {
  return `${c.imap.host}:${c.imap.port}:${c.imap.security}|${c.username}`;
}

// Alla tänkbara inställningar, bäst först. Lösenordet behövs inte här.
export async function discover(email: string, deps: DiscoverDeps): Promise<Candidate[]> {
  const domain = domainOf(email);
  if (!domain) return [];
  const out: Candidate[] = [];
  const add = (cs: Candidate[]) => {
    for (const c of cs) if (!out.some((o) => key(o) === key(c))) out.push(c);
  };

  const known = PROVIDERS.find((p) => p.domains.includes(domain));
  if (known) return [fromPreset(known.id, email, 'leverantör')];

  const mx = await deps.resolveMx(domain).catch(() => [] as string[]);
  const viaMx = providerFromMx(mx);
  if (viaMx) add([fromPreset(viaMx, email, 'mx')]);

  const enc = encodeURIComponent(email.trim());
  const urls = [
    `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${enc}`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${enc}`,
    `${deps.ispdb}${domain}`
  ];
  const mxBase = mx.length ? baseDomain(mx[0]) : '';
  if (mxBase && mxBase !== domain) urls.push(`${deps.ispdb}${mxBase}`);
  const configs = await Promise.all(urls.map((u) => deps.fetchText(u).catch(() => null)));
  for (const xml of configs) if (xml) add(parseAutoconfig(xml, email));

  const [imaps, subs, sub] = await Promise.all(
    [`_imaps._tcp.${domain}`, `_submissions._tcp.${domain}`, `_submission._tcp.${domain}`].map((n) => deps.resolveSrv(n).catch(() => []))
  );
  const imapSrv = imaps.find((r) => r.name && r.name !== '.');
  const smtpSrv = subs.find((r) => r.name && r.name !== '.') ?? sub.find((r) => r.name && r.name !== '.');
  if (imapSrv && smtpSrv) {
    add([
      {
        provider: 'manual',
        imap: { host: imapSrv.name.replace(/\.$/, ''), port: imapSrv.port, security: 'ssl' },
        smtp: { host: smtpSrv.name.replace(/\.$/, ''), port: smtpSrv.port, security: smtpSrv.port === 465 ? 'ssl' : 'starttls' },
        username: email.trim(),
        source: 'srv'
      }
    ]);
  }

  for (const prefix of ['imap', 'mail']) {
    add([
      {
        provider: 'manual',
        imap: { host: `${prefix}.${domain}`, port: 993, security: 'ssl' },
        smtp: { host: `${prefix === 'imap' ? 'smtp' : 'mail'}.${domain}`, port: 465, security: 'ssl' },
        username: email.trim(),
        source: 'gissning'
      }
    ]);
  }
  return out;
}

const TIMEOUT_MS = 6000;

async function fetchText(url: string): Promise<string | null> {
  // Lösenordet skickas aldrig hit, men okrypterade adresser godtas ändå bara för tester på den egna datorn.
  if (!/^https:/i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(url)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { Accept: 'application/xml, text/xml' } });
    if (!res.ok) return null;
    const text = await res.text();
    return /<clientConfig/i.test(text) ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), TIMEOUT_MS))]);
}

export function defaultDeps(): DiscoverDeps {
  const noDns = !!process.env.MRMAIL_NO_DNS;
  return {
    fetchText,
    resolveMx: (d) =>
      noDns ? Promise.resolve([]) : withTimeout(dns.resolveMx(d).then((r) => r.sort((a, b) => a.priority - b.priority).map((x) => x.exchange)), []),
    resolveSrv: (n) => (noDns ? Promise.resolve([]) : withTimeout(dns.resolveSrv(n).then((r) => r.sort((a, b) => a.priority - b.priority)), [])),
    ispdb: process.env.MRMAIL_ISPDB ?? ISPDB
  };
}

// Okrypterade anslutningar provas bara mot den egna datorn, så att lösenordet aldrig går i klartext över nätet.
export function safeToTry(c: Candidate): boolean {
  const local = (h: string) => h === '127.0.0.1' || h === 'localhost' || h === '::1';
  return (c.imap.security !== 'none' || local(c.imap.host)) && (c.smtp.security !== 'none' || local(c.smtp.host));
}

export interface SetupProbes {
  imap(c: Candidate, password: string): Promise<{ kind: 'ok' } | { kind: 'auth' | 'unreachable'; message: string }>;
  smtp(c: Candidate, password: string): Promise<string | null>;
}

export type SetupResult =
  | { ok: true; candidate: Candidate }
  | { ok: false; reason: 'auth'; candidate: Candidate; message: string }
  | { ok: false; reason: 'smtp'; candidate: Candidate; message: string }
  | { ok: false; reason: 'notfound'; message: string };

// Andra vanliga SMTP-portar på samma värd, om den angivna inte svarar.
function smtpAlternatives(c: Candidate): Candidate[] {
  const alts: ServerConfig[] = [
    { host: c.smtp.host, port: 465, security: 'ssl' },
    { host: c.smtp.host, port: 587, security: 'starttls' }
  ];
  return alts.filter((s) => s.port !== c.smtp.port).map((smtp) => ({ ...c, smtp }));
}

// Provar inställningarna i tur och ordning. Första server som svarar avgör: fel lösenord där betyder fel lösenord.
export async function findWorkingConfig(
  email: string,
  password: string,
  candidates: Candidate[],
  probes: SetupProbes,
  onProgress: (text: string) => void = () => undefined
): Promise<SetupResult> {
  for (const first of candidates.filter(safeToTry)) {
    onProgress(`Provar ${first.imap.host}…`);
    let c = first;
    let r = await probes.imap(c, password);
    if (r.kind === 'auth' && c.username === email.trim() && localPart(email)) {
      const alt = { ...c, username: localPart(email) };
      const r2 = await probes.imap(alt, password);
      if (r2.kind === 'ok') {
        c = alt;
        r = r2;
      }
    }
    if (r.kind === 'unreachable') continue;
    if (r.kind === 'auth') return { ok: false, reason: 'auth', candidate: c, message: r.message };
    onProgress(t('Provar utgående post på {host}…', { host: c.smtp.host }));
    let smtpErr = await probes.smtp(c, password);
    if (smtpErr) {
      for (const alt of smtpAlternatives(c).filter(safeToTry)) {
        if (!(await probes.smtp(alt, password))) {
          c = alt;
          smtpErr = null;
          break;
        }
      }
    }
    if (smtpErr) return { ok: false, reason: 'smtp', candidate: c, message: smtpErr };
    return { ok: true, candidate: c };
  }
  return { ok: false, reason: 'notfound', message: t('Hittade ingen e-postserver för {domain}.', { domain: domainOf(email) || t('adressen') }) };
}
