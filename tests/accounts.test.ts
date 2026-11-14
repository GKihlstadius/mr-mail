import { SEED } from './fixtures';
import { describe, expect, it } from 'vitest';
import {
  PROVIDERS,
  defaultAccounts,
  guessProvider,
  imapOptions,
  isValidEmail,
  makeAccount,
  slugify,
  smtpOptions,
  validateAccount
} from '../src/shared/accounts';

describe('kontokonfiguration', () => {
  it('har förinställningar för Gmail, iCloud, Outlook, Simply och manuellt', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(['gmail', 'icloud', 'outlook', 'simply', 'manual']);
    const gmail = PROVIDERS[0];
    expect(gmail.imap).toEqual({ host: 'imap.gmail.com', port: 993, security: 'ssl' });
    expect(gmail.smtp).toEqual({ host: 'smtp.gmail.com', port: 465, security: 'ssl' });
    expect(gmail.helpUrl).toBe('https://myaccount.google.com/apppasswords');
  });

  it('lägger inte in några konton om inget anges, och förbereder angivna konton utan lösenord', () => {
    expect(defaultAccounts()).toEqual([]);
    expect(defaultAccounts('inte json')).toEqual([]);
    const accs = defaultAccounts(SEED);
    expect(accs.map((a) => a.email)).toEqual(['alex.berg@gmail.com', 'alex@nordljus.se', 'hej@nordljus.se']);
    expect(accs[0].imap.host).toBe('imap.gmail.com');
    expect(accs[1].imap).toEqual({ host: 'mail.simply.com', port: 993, security: 'ssl' });
    expect(accs[1].smtp).toEqual({ host: 'smtp.simply.com', port: 465, security: 'ssl' });
    expect(accs[2].smtp.host).toBe('smtp.simply.com');
    for (const a of accs) {
      expect(validateAccount(a)).toEqual([]);
      expect(JSON.stringify(a)).not.toMatch(/pass/i);
    }
    expect(new Set(accs.map((a) => a.id)).size).toBe(3);
  });

  it('gissar leverantör från adressen', () => {
    expect(guessProvider('någon@gmail.com')).toBe('gmail');
    expect(guessProvider('x@ICLOUD.com')).toBe('icloud');
    expect(guessProvider('x@hotmail.se')).toBe('outlook');
    expect(guessProvider('a@firma.se')).toBe('manual');
  });

  it('validerar fält och portar', () => {
    const a = makeAccount('fel', 'manual');
    const errs = validateAccount(a);
    expect(errs).toContain('Ange en giltig e-postadress.');
    expect(errs).toContain('Ange en IMAP-server.');
    const b = makeAccount('a@b.se', 'manual', {
      imap: { host: 'imap.b.se', port: 70000, security: 'ssl' },
      smtp: { host: 'smtp b', port: 465, security: 'ssl' }
    });
    const errs2 = validateAccount(b);
    expect(errs2).toContain('IMAP-porten måste vara mellan 1 och 65535.');
    expect(errs2).toContain('SMTP-servern får inte innehålla mellanslag.');
    expect(isValidEmail(' alex@nordljus.se ')).toBe(true);
  });

  it('översätter säkerhetsläge till klientinställningar', () => {
    const ssl = makeAccount('a@gmail.com', 'gmail');
    expect(smtpOptions(ssl)).toMatchObject({ secure: true, requireTLS: false, ignoreTLS: false });
    expect(imapOptions(ssl)).toMatchObject({ secure: true });
    const icloud = makeAccount('a@icloud.com', 'icloud');
    expect(smtpOptions(icloud)).toMatchObject({ port: 587, secure: false, requireTLS: true });
    const plain = makeAccount('a@test.local', 'manual', {
      imap: { host: 'localhost', port: 3143, security: 'none' },
      smtp: { host: 'localhost', port: 3025, security: 'none' },
      allowInsecureTls: true
    });
    expect(smtpOptions(plain)).toMatchObject({ secure: false, ignoreTLS: true, tls: { rejectUnauthorized: false } });
  });

  it('skapar stabila id:n', () => {
    expect(slugify('Alex@Nordljus.se')).toBe('alex-nordljus-se');
  });
});
