import { useEffect, useRef, useState } from 'react';
import type { AccountConfig, AccountStatus, Signature, ProviderId, Security } from '../../shared/types';
import { ACCOUNT_COLORS, PROVIDERS, getProvider, guessProvider, makeAccount, slugify, validateAccount } from '../../shared/accounts';
import { api, type OAuthConfig } from '../api';
import { SignaturePreview } from './Signatures';
import { cx } from '../util';
import { APP_NAME } from '../../shared/brand';
import { StatusDot, statusText } from './Sidebar';
import * as I from './Icons';
import { AddAccount } from './AddAccount';
import { t, locale } from '../../shared/i18n';

interface Props {
  accounts: AccountConfig[];
  accountId?: string;
  status?: AccountStatus;
  // Öppnat från Logga in i sidopanelen: visa rätt inloggning direkt.
  login?: boolean;
  signatures: Signature[];
  onEditSignatures?(): void;
  onClose(): void;
  onSaved(): void;
}

export function lastSyncText(s?: AccountStatus): string {
  if (!s?.lastSync) return t('Inte synkad än.');
  const d = new Date(s.lastSync);
  const time = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  const today = new Date().toDateString() === d.toDateString();
  const when = today ? t('i dag {time}', { time }) : `${d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' })} ${time}`;
  return t('Senast synkad {when}.', { when });
}

const securityLabel = (): Record<Security, string> => ({ ssl: 'SSL/TLS', starttls: 'STARTTLS', none: t('Ingen') });

export function AccountDialog({ accounts, accountId, status, login, signatures, onEditSignatures, onClose, onSaved }: Props) {
  const existing = accounts.find((a) => a.id === accountId);
  const [adding, setAdding] = useState(!existing || (!!login && existing.provider !== 'manual'));
  const [step, setStep] = useState<'provider' | 'form'>(existing ? 'form' : 'provider');
  const [cfg, setCfg] = useState<AccountConfig>(existing ?? makeAccount('', 'gmail', {}, accounts.length));
  const [password, setPassword] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [advanced, setAdvanced] = useState(existing?.provider === 'manual');
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [testFailed, setTestFailed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [oauth, setOauth] = useState<OAuthConfig | null>(null);
  const [method, setMethod] = useState<'oauth' | 'password'>(existing?.auth === 'oauth' ? 'oauth' : 'password');
  // Ett konto som redan har ett inloggningssätt behåller det, annars väljs det bästa som finns.
  const methodTouched = useRef(!!existing?.auth);

  useEffect(() => {
    void api.oauthConfig().then(setOauth).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!existing) return;
    void api.hasPassword(existing.id).then((has) => {
      setHasPassword(has);
      if (has && existing.auth !== 'oauth') {
        methodTouched.current = true;
        setMethod('password');
      }
    });
  }, [existing?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const provider = getProvider(cfg.provider);
  const oauthKind = cfg.provider === 'gmail' ? 'google' : cfg.provider === 'outlook' ? 'microsoft' : null;
  const oauthReady = oauthKind === 'google' ? !!oauth?.googleClientId : oauthKind === 'microsoft' ? !!oauth?.microsoftClientId : false;
  const oauthName = oauthKind === 'google' ? 'Google' : 'Microsoft';

  // Nya Gmail- och Outlook-konton loggar in med OAuth när klient-id finns, annars app-lösenord.
  useEffect(() => {
    if (methodTouched.current) return;
    setMethod(oauthKind && oauthReady ? 'oauth' : 'password');
  }, [oauthKind, oauthReady]);

  const pickProvider = (id: ProviderId) => {
    const p = getProvider(id);
    setCfg({ ...cfg, provider: id, imap: { ...p.imap }, smtp: { ...p.smtp } });
    setAdvanced(id === 'manual');
    setStep('form');
  };

  const setEmail = (email: string) => {
    const next = { ...cfg, email };
    if (!existing) {
      next.username = email;
      next.id = slugify(email);
      if (!cfg.name || cfg.name === cfg.email) next.name = email;
      const guess = guessProvider(email);
      if (cfg.provider === 'manual' && guess !== 'manual') {
        const p = getProvider(guess);
        next.provider = guess;
        next.imap = { ...p.imap };
        next.smtp = { ...p.smtp };
      }
    }
    setCfg(next);
  };

  const finalConfig = (): AccountConfig => {
    const c = {
      ...cfg,
      name: cfg.name.trim() || cfg.email.trim(),
      email: cfg.email.trim(),
      username: cfg.username.trim() || cfg.email.trim(),
      signatureId: cfg.signatureId ?? ''
    };
    if (!existing) {
      let id = slugify(c.email);
      let n = 2;
      while (accounts.some((a) => a.id === id)) id = `${slugify(c.email)}-${n++}`;
      c.id = id;
    }
    return c;
  };

  const loginOAuth = async () => {
    const c = finalConfig();
    setErrors([]);
    setBusy(t('Logga in hos {name} i webbläsaren…', { name: oauthName }));
    try {
      const res = await api.oauthLogin({ config: { ...c, auth: 'oauth' } });
      setBusy(null);
      if (res.ok) onSaved();
      else setErrors([res.error ?? t('Inloggningen misslyckades.')]);
    } catch (e: any) {
      setBusy(null);
      setErrors([e.message]);
    }
  };

  const save = async (skipTest = false) => {
    const c = finalConfig();
    const v = validateAccount(c);
    if (method === 'oauth' && existing?.auth !== 'oauth') {
      v.push(t('Logga in med {name} först.', { name: oauthName }));
    } else if (method === 'password' && !password && (!hasPassword || existing?.auth === 'oauth')) v.push(t('Fyll i lösenordet.'));
    setErrors(v);
    if (v.length) return;
    if (!skipTest) {
      setBusy(t('Testar anslutningen…'));
      const test = await api.testAccount({ config: c, password: password || undefined }).catch((e) => ({ ok: false, imap: e.message }) as any);
      setBusy(null);
      if (!test.ok) {
        setErrors([test.imap && t('Inkommande (IMAP): {error}', { error: test.imap }), test.smtp && t('Utgående (SMTP): {error}', { error: test.smtp })].filter(Boolean));
        setTestFailed(true);
        return;
      }
    }
    setBusy(t('Sparar…'));
    const res = await api.saveAccount({ config: c, password: password || undefined });
    setBusy(null);
    if (!res.ok) setErrors(res.errors);
    else onSaved();
  };

  const remove = async () => {
    if (!existing) return;
    await api.deleteAccount(existing.id);
    onSaved();
  };

  if (adding) {
    return (
      <AddAccount
        accounts={accounts}
        existing={existing}
        onClose={onClose}
        onSaved={onSaved}
        onManual={(c) => {
          setCfg(c);
          setAdvanced(c.provider === 'manual');
          setStep('form');
          setAdding(false);
        }}
      />
    );
  }

  const server = (kind: 'imap' | 'smtp', label: string) => (
    <div className="server-row">
      <span className="server-label">{label}</span>
      <input
        className="grow"
        value={cfg[kind].host}
        placeholder={t('server.exempel.se')}
        spellCheck={false}
        onChange={(e) => setCfg({ ...cfg, [kind]: { ...cfg[kind], host: e.target.value.trim() } })}
      />
      <input
        className="port"
        value={cfg[kind].port}
        inputMode="numeric"
        aria-label={t('{label} port', { label })}
        onChange={(e) => setCfg({ ...cfg, [kind]: { ...cfg[kind], port: Number(e.target.value.replace(/\D/g, '')) || 0 } })}
      />
      <select
        value={cfg[kind].security}
        aria-label={t('{label} säkerhet', { label })}
        onChange={(e) => setCfg({ ...cfg, [kind]: { ...cfg[kind], security: e.target.value as Security } })}
      >
        {(Object.keys(securityLabel()) as Security[]).map((s) => (
          <option key={s} value={s}>
            {securityLabel()[s]}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal account-modal" role="dialog" aria-modal="true" aria-label={existing ? t('Konto') : t('Lägg till konto')}>
        <header className="modal-head">
          <h2>{existing ? cfg.name : t('Lägg till konto')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('Stäng')}>
            <I.Close size={16} />
          </button>
        </header>

        {step === 'provider' ? (
          <div className="modal-body">
            <p className="muted">{t('Välj vilken sorts konto du vill lägga till.')}</p>
            <div className="provider-grid">
              {PROVIDERS.map((p) => (
                <button key={p.id} className={cx('provider', `provider-${p.id}`)} onClick={() => pickProvider(p.id)}>
                  <span className="provider-mark">{p.id === 'manual' ? <I.Gear size={18} /> : p.label[0]}</span>
                  <span>{t(p.label)}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="modal-body">
            {existing && (
              <div className={cx('status-box', status?.state === 'error' && 'error')}>
                <div className="status-line">
                  <StatusDot status={status} />
                  <span className="status-text">{statusText(status)}</span>
                  {(status?.state === 'error' || status?.state === 'offline') && (
                    <button className="btn small" onClick={() => api.reconnect(existing.id)}>
                      {t('Försök igen')}
                    </button>
                  )}
                </div>
                <div className="status-sub muted small">{lastSyncText(status)}</div>
              </div>
            )}
            {!existing && (
              <div className="provider-chip">
                <span>{t(provider.label)}</span>
                <button className="link" onClick={() => setStep('provider')}>
                  {t('Byt')}
                </button>
              </div>
            )}
            {oauthKind && (
              <div className="segmented method-switch" role="radiogroup" aria-label={t('Inloggning')}>
                <button
                  className={cx(method === 'oauth' && 'on')}
                  role="radio"
                  aria-checked={method === 'oauth'}
                  onClick={() => {
                    methodTouched.current = true;
                    setMethod('oauth');
                  }}
                >
                  {t('Logga in med {name}', { name: oauthName })}
                </button>
                <button
                  className={cx(method === 'password' && 'on')}
                  role="radio"
                  aria-checked={method === 'password'}
                  onClick={() => {
                    methodTouched.current = true;
                    setMethod('password');
                  }}
                >
                  {t('App-lösenord')}
                </button>
              </div>
            )}
            {method === 'oauth' && oauthKind ? (
              <div className="help-box">
                {oauthReady ? (
                  <p>
                    {t('Du loggar in i webbläsaren hos {name}. {app} sparar inget lösenord, bara en nyckel som du kan dra tillbaka i ditt {account} när du vill.', {
                      name: oauthName,
                      app: APP_NAME,
                      account: oauthKind === 'google' ? t('Google-konto') : t('Microsoft-konto')
                    })}
                  </p>
                ) : (
                  <p>
                    {t('Inloggning med {name} kräver ett klient-id. Lägg in det under Inställningar, Inloggning med Google och Microsoft. Guiden finns i docs/oauth.md. Tills dess fungerar app-lösenord.', { name: oauthName })}
                  </p>
                )}
              </div>
            ) : (
              provider.help && (
                <div className="help-box">
                  <p>{t(provider.help)}</p>
                  {provider.helpUrl && (
                    <button className="link" onClick={() => api.external(provider.helpUrl!)}>
                      {provider.helpLinkText ? t(provider.helpLinkText) : provider.helpUrl}
                    </button>
                  )}
                </div>
              )
            )}
            <label className="field">
              <span>{t('E-postadress')}</span>
              <input value={cfg.email} onChange={(e) => setEmail(e.target.value)} placeholder={t('namn@exempel.se')} spellCheck={false} autoFocus={!existing} disabled={!!existing} />
            </label>
            {method === 'oauth' && oauthKind ? (
              <div className="oauth-row">
                <button className="btn primary oauth-btn" onClick={loginOAuth} disabled={!oauthReady || !!busy}>
                  {existing?.auth === 'oauth' ? t('Logga in med {name} igen', { name: oauthName }) : t('Logga in med {name}', { name: oauthName })}
                </button>
                {existing?.auth === 'oauth' && hasPassword && <span className="muted small">{t('Inloggad med {name}.', { name: oauthName })}</span>}
              </div>
            ) : (
              <label className="field">
                <span>{cfg.provider === 'gmail' ? t('App-lösenord') : t('Lösenord')}</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={hasPassword && existing?.auth !== 'oauth' ? t('Sparat. Lämna tomt för att behålla.') : cfg.provider === 'gmail' ? t('16 tecken från Google') : ''}
                  autoFocus={!!existing && !hasPassword}
                />
              </label>
            )}
            <div className="field-pair">
              <label className="field">
                <span>{t('Namn i sidopanelen')}</span>
                <input value={cfg.name} onChange={(e) => setCfg({ ...cfg, name: e.target.value })} placeholder={t('Jobb')} />
              </label>
              <label className="field">
                <span>{t('Avsändarnamn')}</span>
                <input value={cfg.displayName} onChange={(e) => setCfg({ ...cfg, displayName: e.target.value })} placeholder={t('Förnamn Efternamn')} />
              </label>
            </div>
            <div className="field">
              <span>{t('Färg')}</span>
              <div className="color-row" role="radiogroup" aria-label={t('Färg')}>
                {ACCOUNT_COLORS.map((c) => (
                  <button
                    key={c}
                    className={cx('color-swatch', cfg.color === c && 'on')}
                    style={{ background: c }}
                    role="radio"
                    aria-checked={cfg.color === c}
                    aria-label={t('Färg {color}', { color: c })}
                    onClick={() => setCfg({ ...cfg, color: c })}
                  />
                ))}
              </div>
            </div>
            <div className="field">
              <span>{t('Signatur')}</span>
              <div className="sig-select-row">
                <select value={cfg.signatureId ?? ''} onChange={(e) => setCfg({ ...cfg, signatureId: e.target.value })} aria-label={t('Signatur')}>
                  <option value="">{t('Ingen')}</option>
                  {signatures.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {onEditSignatures && (
                  <button className="btn small" onClick={onEditSignatures}>
                    {t('Redigera signaturer…')}
                  </button>
                )}
              </div>
            </div>
            {cfg.signatureId && <SignaturePreview html={signatures.find((s) => s.id === cfg.signatureId)?.html ?? ''} compact />}
            <label className="check">
              <input type="checkbox" checked={cfg.notify !== false} onChange={(e) => setCfg({ ...cfg, notify: e.target.checked })} />
              <span>{t('Aviseringar för nya mejl i det här kontot')}</span>
            </label>

            <button className="link disclosure" onClick={() => setAdvanced(!advanced)}>
              <I.Chevron size={12} className={cx(advanced && 'rot')} /> {t('Servrar och avancerat')}
            </button>
            {advanced && (
              <div className="advanced">
                {server('imap', 'IMAP')}
                {server('smtp', 'SMTP')}
                <label className="field">
                  <span>{t('Användarnamn')}</span>
                  <input value={cfg.username} onChange={(e) => setCfg({ ...cfg, username: e.target.value })} spellCheck={false} />
                </label>
                <label className="check">
                  <input type="checkbox" checked={!!cfg.allowInsecureTls} onChange={(e) => setCfg({ ...cfg, allowInsecureTls: e.target.checked })} />
                  <span>{t('Godta självsignerade certifikat (bara för egna servrar)')}</span>
                </label>
              </div>
            )}

            {errors.length > 0 && (
              <div className="form-errors" role="alert">
                {errors.map((e) => (
                  <div key={e}>{e}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {step === 'form' && (
          <footer className="modal-foot">
            {existing &&
              (confirmDelete ? (
                <button className="btn danger" onClick={remove}>
                  {t('Ta bort på riktigt')}
                </button>
              ) : (
                <button className="btn ghost danger-text" onClick={() => setConfirmDelete(true)}>
                  {t('Ta bort konto')}
                </button>
              ))}
            <span className="grow" />
            {busy && <span className="muted small">{busy}</span>}
            {testFailed && !busy && (
              <button className="btn" onClick={() => save(true)}>
                {t('Spara ändå')}
              </button>
            )}
            <button className="btn" onClick={onClose}>
              {t('Avbryt')}
            </button>
            <button className="btn primary" onClick={() => save(false)} disabled={!!busy}>
              {existing ? t('Spara') : t('Lägg till')}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
