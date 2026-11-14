import { t } from './i18n';
import type { AccountConfig, ProviderId, ServerConfig } from './types';

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  imap: ServerConfig;
  smtp: ServerConfig;
  help?: string;
  helpUrl?: string;
  helpLinkText?: string;
  domains: string[];
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'gmail',
    label: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'ssl' },
    help:
      'Gmail kräver ett app-lösenord. Slå på tvåstegsverifiering i ditt Google-konto, skapa sedan ett app-lösenord (16 tecken) och klistra in det här.',
    helpUrl: 'https://myaccount.google.com/apppasswords',
    helpLinkText: 'Skapa app-lösenord hos Google',
    domains: ['gmail.com', 'googlemail.com']
  },
  {
    id: 'icloud',
    label: 'iCloud',
    imap: { host: 'imap.mail.me.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    help: 'iCloud kräver ett appspecifikt lösenord som du skapar på account.apple.com under Inloggning och säkerhet.',
    helpUrl: 'https://account.apple.com/account/manage',
    helpLinkText: 'Öppna Apple-konto',
    domains: ['icloud.com', 'me.com', 'mac.com']
  },
  {
    id: 'outlook',
    label: 'Outlook',
    imap: { host: 'outlook.office365.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' },
    help: 'Outlook kräver att IMAP är påslaget. Använd ett app-lösenord, eller logga in med Microsoft när klient-id finns under Inställningar.',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'outlook.se', 'hotmail.se', 'live.se']
  },
  {
    id: 'simply',
    label: 'Simply.com',
    imap: { host: 'mail.simply.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.simply.com', port: 465, security: 'ssl' },
    help: 'Använd samma lösenord som för webbmejlen hos Simply.com.',
    domains: []
  },
  {
    id: 'manual',
    label: 'Annat (IMAP/SMTP)',
    imap: { host: '', port: 993, security: 'ssl' },
    smtp: { host: '', port: 465, security: 'ssl' },
    domains: []
  }
];

export const ACCOUNT_COLORS = ['#4f7cff', '#2fb36d', '#e0883a', '#a56cf0', '#e05a7a', '#2aa7b8'];

export function getProvider(id: ProviderId): ProviderPreset {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[PROVIDERS.length - 1];
}

export function guessProvider(email: string): ProviderId {
  const domain = email.trim().toLowerCase().split('@')[1] ?? '';
  for (const p of PROVIDERS) if (p.domains.includes(domain)) return p.id;
  return 'manual';
}

export function slugify(email: string): string {
  return email
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function makeAccount(
  email: string,
  provider: ProviderId,
  opts: Partial<AccountConfig> = {},
  index = 0
): AccountConfig {
  const p = getProvider(provider);
  return {
    id: opts.id ?? slugify(email),
    name: opts.name ?? email,
    email: email.trim(),
    displayName: opts.displayName ?? '',
    provider,
    imap: { ...(opts.imap ?? p.imap) },
    smtp: { ...(opts.smtp ?? p.smtp) },
    username: opts.username ?? email.trim(),
    color: opts.color ?? ACCOUNT_COLORS[index % ACCOUNT_COLORS.length],
    allowInsecureTls: opts.allowInsecureTls,
    signature: opts.signature
  };
}

// Konton som läggs in vid första start utan lösenord. Används av testerna via MRMAIL_SEED:
// en JSON-lista med [adress, leverantör, kontonamn, avsändarnamn].
export function defaultAccounts(seed = ''): AccountConfig[] {
  if (!seed) return [];
  try {
    const list = JSON.parse(seed) as [string, ProviderId, string, string][];
    return list.map(([email, provider, name, displayName], i) => makeAccount(email, provider, { name, displayName }, i));
  } catch {
    return [];
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

export function validateAccount(a: AccountConfig): string[] {
  const errors: string[] = [];
  if (!isValidEmail(a.email)) errors.push(t('Ange en giltig e-postadress.'));
  if (!a.username.trim()) errors.push(t('Ange ett användarnamn.'));
  for (const [label, s] of [
    ['IMAP', a.imap],
    ['SMTP', a.smtp]
  ] as const) {
    if (!s.host.trim()) errors.push(t('Ange en {label}-server.', { label }));
    else if (/\s/.test(s.host.trim())) errors.push(t('{label}-servern får inte innehålla mellanslag.', { label }));
    if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) errors.push(t('{label}-porten måste vara mellan 1 och 65535.', { label }));
  }
  return errors;
}

export function smtpOptions(a: AccountConfig) {
  return {
    host: a.smtp.host,
    port: a.smtp.port,
    secure: a.smtp.security === 'ssl',
    requireTLS: a.smtp.security === 'starttls',
    ignoreTLS: a.smtp.security === 'none',
    tls: a.allowInsecureTls ? { rejectUnauthorized: false } : undefined
  };
}

export function imapOptions(a: AccountConfig) {
  return {
    host: a.imap.host,
    port: a.imap.port,
    secure: a.imap.security === 'ssl',
    tls: a.allowInsecureTls ? { rejectUnauthorized: false } : undefined
  };
}
