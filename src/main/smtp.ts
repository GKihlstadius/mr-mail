import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { AccountConfig } from '../shared/types';
import { smtpOptions } from '../shared/accounts';
import { APP_FILE_NAME, APP_VERSION } from '../shared/brand';
import { parseAddressList, formatAddress } from '../shared/compose';
import { t } from '../shared/i18n';

export interface OutgoingPart {
  filename: string;
  content?: Buffer;
  path?: string;
  contentType?: string;
}

export interface SendInput {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments: OutgoingPart[];
  headers?: Record<string, string>;
}

// Lösenord, eller en OAuth-åtkomsttoken som skickas med XOAUTH2.
export type SmtpSecret = string | { accessToken: string };

export function transportFor(cfg: AccountConfig, secret: SmtpSecret, timeoutMs?: number) {
  return nodemailer.createTransport({
    ...smtpOptions(cfg),
    auth: typeof secret === 'string' ? { user: cfg.username, pass: secret } : { type: 'OAuth2', user: cfg.username, accessToken: secret.accessToken },
    connectionTimeout: timeoutMs ?? 20000,
    greetingTimeout: timeoutMs ?? 15000,
    socketTimeout: 60000
  });
}

export function fromHeader(cfg: AccountConfig): string {
  return formatAddress({ name: cfg.displayName, address: cfg.email });
}

export async function buildRaw(
  cfg: AccountConfig,
  input: SendInput,
  opts: { draft?: boolean } = {}
): Promise<{ raw: Buffer; recipients: string[] }> {
  const to = parseAddressList(input.to);
  const cc = parseAddressList(input.cc);
  const bcc = parseAddressList(input.bcc);
  const recipients = [...to, ...cc, ...bcc].map((a) => a.address);
  // Ett utkast får sakna mottagare och ha halvskrivna adresser.
  if (!opts.draft) {
    if (!recipients.length) throw new Error(t('Lägg till minst en mottagare.'));
    const bad = recipients.filter((r) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r) && !/^[^\s@]+@localhost$/.test(r));
    if (bad.length) throw new Error(t('Ogiltig adress: {addresses}', { addresses: bad.join(', ') }));
  }
  const mail = new MailComposer({
    from: fromHeader(cfg),
    to: to.length ? to.map(formatAddress) : undefined,
    cc: cc.length ? cc.map(formatAddress) : undefined,
    bcc: opts.draft && bcc.length ? bcc.map(formatAddress) : undefined,
    subject: input.subject,
    text: input.text,
    html: input.html || undefined,
    inReplyTo: input.inReplyTo,
    references: input.references?.length ? input.references : undefined,
    attachments: input.attachments.map((a) => ({ filename: a.filename, content: a.content, path: a.path, contentType: a.contentType })),
    headers: { 'X-Mailer': `${APP_FILE_NAME} ${APP_VERSION}`, ...(input.headers ?? {}) }
  });
  const node = mail.compile();
  if (opts.draft) (node as any).keepBcc = true;
  const raw: Buffer = await new Promise((resolve, reject) => node.build((err: Error | null, buf: Buffer) => (err ? reject(err) : resolve(buf))));
  return { raw, recipients };
}

export async function sendRaw(cfg: AccountConfig, secret: SmtpSecret, raw: Buffer, recipients: string[]) {
  const transport = transportFor(cfg, secret);
  try {
    return await transport.sendMail({ envelope: { from: cfg.email, to: recipients }, raw });
  } finally {
    transport.close();
  }
}

export async function testSmtp(cfg: AccountConfig, secret: SmtpSecret, timeoutMs?: number): Promise<string | null> {
  const transport = transportFor(cfg, secret, timeoutMs);
  try {
    await transport.verify();
    return null;
  } catch (err: any) {
    if (err?.code === 'EAUTH') return t('SMTP-inloggningen misslyckades. Kontrollera lösenordet.');
    if (err?.code === 'ESOCKET' || err?.code === 'ECONNECTION') return t('Når inte SMTP-servern {host}:{port}.', { host: cfg.smtp.host, port: cfg.smtp.port });
    if (err?.code === 'ETIMEDOUT') return t('Ingen kontakt med {host}, tidsgränsen nåddes.', { host: cfg.smtp.host });
    return err?.message ?? t('Okänt SMTP-fel.');
  } finally {
    transport.close();
  }
}
