import { useEffect, useRef, useState } from 'react';
import type { AccountConfig, ProviderId, SetupOutcome } from '../../shared/types';
import { getProvider, guessProvider, isValidEmail, makeAccount, slugify } from '../../shared/accounts';
import { api, type OAuthConfig } from '../api';
import { cx } from '../util';
import { APP_NAME } from '../../shared/brand';
import { t } from '../../shared/i18n';
import * as I from './Icons';
import { GoogleLogo, ICloudLogo, OtherLogo, OutlookLogo, SimplyLogo } from './Logos';

type View = 'pick' | 'google' | 'guide' | 'password' | 'other';
type PasswordProvider = Exclude<ProviderId, 'manual'>;

interface Props {
  accounts: AccountConfig[];
  // Ett förifyllt konto som saknar lösenord.
  existing?: AccountConfig;
  onClose(): void;
  onSaved(): void;
  onManual(cfg: AccountConfig): void;
}

const LOGO: Record<PasswordProvider, () => React.ReactNode> = {
  gmail: () => <span className="logo-tile logo-google"><GoogleLogo size={18} /></span>,
  simply: SimplyLogo,
  icloud: ICloudLogo,
  outlook: OutlookLogo
};

const GOOGLE_CONSOLE = 'https://console.cloud.google.com/';

function firstView(existing?: AccountConfig): View {
  if (!existing) return 'pick';
  if (existing.provider === 'gmail') return 'google';
  return 'password';
}

export function AddAccount({ accounts, existing, onClose, onSaved, onManual }: Props) {
  const [view, setView] = useState<View>(firstView(existing));
  const [provider, setProvider] = useState<PasswordProvider>(existing && existing.provider !== 'manual' ? existing.provider : 'simply');
  const [name, setName] = useState(existing?.displayName || accounts.find((a) => a.displayName.trim())?.displayName || '');
  const [email, setEmail] = useState(existing?.email ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [failure, setFailure] = useState<SetupOutcome | null>(null);
  const [oauth, setOauth] = useState<OAuthConfig | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const waitingOAuth = useRef(false);
  const autoStarted = useRef(false);

  useEffect(() => {
    void api
      .oauthConfig()
      .then((c) => {
        setOauth(c);
        setClientId(c.googleClientId);
      })
      .catch(() => setOauth({ googleClientId: '', microsoftClientId: '', hasGoogleSecret: false }));
  }, []);
  useEffect(() => api.on('setup-progress', (text: string) => setProgress(text)), []);
  // Stängs dialogen mitt i en inloggning slutar appen vänta på webbläsaren.
  useEffect(() => () => void (waitingOAuth.current && api.oauthCancel()), []);

  const googleReady = !!oauth?.googleClientId;
  const microsoftReady = !!oauth?.microsoftClientId;
  const p = getProvider(provider);

  const startOAuth = async (kind: 'google' | 'microsoft') => {
    const prov: ProviderId = kind === 'google' ? 'gmail' : 'outlook';
    const preset = getProvider(prov);
    // Nytt Google-konto: namn och adress kommer från Google.
    const base = existing ?? makeAccount(email.trim(), prov, { displayName: kind === 'google' ? '' : name.trim() }, accounts.length);
    const cfg: AccountConfig = { ...base, provider: prov, imap: { ...preset.imap }, smtp: { ...preset.smtp }, auth: 'oauth' };
    if (!existing && email.trim()) cfg.id = slugify(email);
    setErrors([]);
    setBusy(t('Väntar på inloggningen hos {name} i webbläsaren…', { name: kind === 'google' ? 'Google' : 'Microsoft' }));
    waitingOAuth.current = true;
    try {
      const res = await api.oauthLogin({ config: cfg });
      if (res.ok) onSaved();
      else if (!res.cancelled) setErrors([res.error ?? t('Inloggningen misslyckades.')]);
    } catch (e: any) {
      setErrors([e.message]);
    } finally {
      waitingOAuth.current = false;
      setBusy(null);
    }
  };

  // Google-vyn loggar in direkt när klient-id finns, både från Logga in med Google och för ett
  // förifyllt Gmail-konto. Väntar in inställningarna om de inte hunnit läsas än.
  useEffect(() => {
    if (view !== 'google' || !oauth || autoStarted.current) return;
    autoStarted.current = true;
    if (googleReady) void startOAuth('google');
  }, [view, oauth]);

  const pickGoogle = () => {
    setErrors([]);
    setView('google');
  };

  const pickPassword = (id: PasswordProvider) => {
    setProvider(id);
    setErrors([]);
    setFailure(null);
    setView('password');
  };

  const cancelOAuth = () => void api.oauthCancel();

  const saveGuide = async () => {
    if (!/\.apps\.googleusercontent\.com$/.test(clientId.trim())) {
      setErrors([t('Klient-id ska sluta på .apps.googleusercontent.com.')]);
      return;
    }
    if (!clientSecret.trim() && !oauth?.hasGoogleSecret) {
      setErrors([t('Fyll i klienthemligheten.')]);
      return;
    }
    await api.oauthConfigSave({ googleClientId: clientId.trim(), microsoftClientId: oauth?.microsoftClientId ?? '', googleClientSecret: clientSecret.trim() || undefined });
    const c = await api.oauthConfig();
    setOauth(c);
    setView('google');
    void startOAuth('google');
  };

  const setup = async (forced?: PasswordProvider) => {
    const v: string[] = [];
    const appPw = forced === 'gmail' || forced === 'icloud' || (!forced && ['gmail', 'icloud'].includes(guessProvider(email)));
    if (!isValidEmail(email)) v.push(t('Ange en giltig e-postadress.'));
    if (!password) v.push(appPw ? t('Fyll i app-lösenordet.') : t('Fyll i lösenordet.'));
    setErrors(v);
    setFailure(null);
    if (v.length) return;
    setBusy(forced ? t('Loggar in…') : t('Letar efter servrar…'));
    setProgress(null);
    try {
      const res = await api.setupAccount({ email: email.trim(), password, displayName: name.trim(), provider: forced, accountId: existing?.id });
      if (res.ok) {
        onSaved();
        return;
      }
      setFailure(res);
      const label = getProvider(res.provider).label;
      if (res.reason === 'auth') {
        const needsApp = res.provider === 'gmail' || res.provider === 'icloud';
        setErrors([
          t('Fel lösenord. {who} godtog inte lösenordet för {email}.', {
            who: res.provider === 'manual' ? t('Servern {host}', { host: res.config?.imap.host ?? '' }) : t(label),
            email: email.trim()
          }) + (needsApp ? ' ' + t('Det behövs ett app-lösenord, inte det vanliga lösenordet.') : '')
        ]);
      } else if (res.reason === 'notfound') setErrors([`${res.message} ${t('Ställ in servrarna manuellt.')}`]);
      else setErrors([res.message]);
    } catch (e: any) {
      setErrors([e.message]);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const manual = () => {
    const found = failure && !failure.ok ? failure.config : undefined;
    const prov: ProviderId = found?.provider ?? (view === 'password' ? provider : guessProvider(email));
    const preset = getProvider(prov);
    const base = existing ?? makeAccount(email.trim(), prov, { displayName: name.trim() }, accounts.length);
    onManual({
      ...base,
      email: email.trim(),
      username: found?.username ?? email.trim(),
      name: existing?.name ?? email.trim(),
      displayName: name.trim(),
      provider: prov,
      imap: found?.imap ?? { ...preset.imap },
      smtp: found?.smtp ?? { ...preset.smtp },
      id: existing?.id ?? slugify(email)
    });
  };

  const errorBox = errors.length > 0 && (
    <div className="form-errors" role="alert">
      {errors.map((e) => (
        <div key={e}>{e}</div>
      ))}
    </div>
  );

  const nameField = (
    <label className="field">
      <span>{t('Ditt namn')}</span>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Förnamn Efternamn')} />
    </label>
  );

  const back = !existing && view !== 'pick' && (
    <button className="icon-btn back-btn" onClick={() => (view === 'guide' ? setView('google') : setView('pick'))} aria-label={t('Tillbaka')} disabled={!!busy && !waitingOAuth.current}>
      <I.Chevron size={14} className="flip" />
    </button>
  );

  const title = existing ? t('Logga in på {name}', { name: existing.name }) : t('Lägg till konto');

  let body: React.ReactNode;
  let foot: React.ReactNode;

  if (view === 'pick') {
    body = (
      <div className="modal-body">
        <p className="muted center">{t('Välj din e-postleverantör.')}</p>
        <div className="provider-list">
          <button className="provider-big provider-google" onClick={pickGoogle}>
            <span className="logo-tile logo-google">
              <GoogleLogo size={18} />
            </span>
            <span>{t('Logga in med Google')}</span>
          </button>
          <button className="provider-big" onClick={() => pickPassword('simply')}>
            <SimplyLogo />
            <span>Simply.com</span>
          </button>
          <button className="provider-big" onClick={() => pickPassword('icloud')}>
            <ICloudLogo />
            <span>iCloud</span>
          </button>
          <button className="provider-big" onClick={() => pickPassword('outlook')}>
            <OutlookLogo />
            <span>Outlook</span>
          </button>
          <button className="provider-big" onClick={() => setView('other')}>
            <OtherLogo />
            <span>{t('Annat konto')}</span>
          </button>
        </div>
      </div>
    );
  } else if (view === 'google') {
    body = (
      <div className="modal-body">
        <div className="provider-head">
          <span className="logo-tile logo-google">
            <GoogleLogo size={18} />
          </span>
          <span>Google</span>
        </div>
        {!oauth ? null : googleReady ? (
          <>
            <p className="muted">
              {t('Du loggar in i webbläsaren hos Google. {app} får namn och adress därifrån och sparar inget lösenord, bara en nyckel som du kan dra tillbaka i ditt Google-konto.', { app: APP_NAME })}
            </p>
            {busy ? (
              <div className="oauth-wait" role="status">
                <span className="spinner" aria-hidden="true" />
                {busy}
              </div>
            ) : (
              <button className="btn google-btn" onClick={() => void startOAuth('google')}>
                <GoogleLogo size={16} />
                {existing ? t('Logga in med Google igen') : t('Logga in med Google')}
              </button>
            )}
          </>
        ) : (
          <div className="notice-box">
            <h3>{t('Google-inloggning är inte aktiverad än')}</h3>
            <p>
              {t('{app} behöver ett eget klient-id från Google för att du ska kunna logga in med ett klick. Det skapar du en gång, ungefär tio minuter. Tills dess fungerar ett app-lösenord.', { app: APP_NAME })}
            </p>
            <div className="notice-actions">
              <button className="btn primary" onClick={() => (setErrors([]), setView('guide'))}>
                {t('Visa guiden')}
              </button>
              <button className="btn" onClick={() => pickPassword('gmail')}>
                {t('Använd app-lösenord')}
              </button>
            </div>
          </div>
        )}
        {errorBox}
      </div>
    );
    foot = (
      <>
        {googleReady && (
          <button className="btn ghost manual-link" onClick={() => (cancelOAuth(), pickPassword('gmail'))}>
            {t('Använd app-lösenord i stället')}
          </button>
        )}
        <span className="grow" />
        {busy ? (
          <button className="btn" onClick={cancelOAuth}>
            {t('Avbryt inloggningen')}
          </button>
        ) : (
          <button className="btn" onClick={onClose}>
            {t('Stäng')}
          </button>
        )}
      </>
    );
  } else if (view === 'guide') {
    body = (
      <div className="modal-body guide">
        <p className="muted">{t('Gör så här en gång i Google Cloud. {app} sparar uppgifterna krypterat på datorn.', { app: APP_NAME })}</p>
        <ol className="guide-steps">
          <li>
            {t('Öppna')}{' '}
            <button className="link" onClick={() => api.external(GOOGLE_CONSOLE)}>
              Google Cloud Console
            </button>{' '}
            {t('och skapa ett projekt som heter {app}.', { app: APP_NAME })}
          </li>
          <li>{t('Under API:er och tjänster, Bibliotek: sök på Gmail API och klicka Aktivera.')}</li>
          <li>{t('Under Google Auth Platform: appnamn {app}, målgrupp Extern, och lägg till din Gmail-adress som testanvändare.', { app: APP_NAME })}</li>
          <li>{t('Under Dataåtkomst: lägg till omfattningen https://mail.google.com/.')}</li>
          <li>{t('Under Klienter, Skapa klient: välj Datorprogram. Kopiera klient-id och klienthemlighet hit.')}</li>
        </ol>
        <label className="field">
          <span>{t('Klient-id')}</span>
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="123-abc.apps.googleusercontent.com" spellCheck={false} />
        </label>
        <label className="field">
          <span>{t('Klienthemlighet')}</span>
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={oauth?.hasGoogleSecret ? t('Sparad. Lämna tomt för att behålla.') : 'GOCSPX-…'}
          />
        </label>
        {errorBox}
      </div>
    );
    foot = (
      <>
        <span className="grow" />
        <button className="btn" onClick={() => setView('google')}>
          {t('Tillbaka')}
        </button>
        <button className="btn primary" onClick={() => void saveGuide()}>
          {t('Spara och logga in')}
        </button>
      </>
    );
  } else {
    const isOther = view === 'other';
    const appPw = !isOther && (provider === 'gmail' || provider === 'icloud');
    const help = isOther ? null : p;
    body = (
      <form
        className="modal-body simple-setup"
        onSubmit={(e) => {
          e.preventDefault();
          void setup(isOther ? undefined : provider);
        }}
      >
        <div className="provider-head">
          {isOther ? <OtherLogo /> : LOGO[provider]()}
          <span>{isOther ? t('Annat konto') : t(p.label)}</span>
        </div>
        <p className="muted">
          {isOther
            ? t('Skriv in din e-postadress och ditt lösenord. {app} hittar servrarna själv.', { app: APP_NAME })
            : existing
              ? appPw
                ? t('Fyll i app-lösenordet för {email}. Servrarna är redan inställda.', { email: existing.email })
                : t('Fyll i lösenordet för {email}. Servrarna är redan inställda.', { email: existing.email })
              : appPw
                ? t('Bara adress och app-lösenord. Servrarna fylls i själv och anslutningen provas direkt.')
                : t('Bara adress och lösenord. Servrarna fylls i själv och anslutningen provas direkt.')}
        </p>
        {nameField}
        <label className="field">
          <span>{t('E-postadress')}</span>
          <input
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setFailure(null);
            }}
            placeholder={t('namn@exempel.se')}
            spellCheck={false}
            autoFocus={!existing}
            disabled={!!existing}
          />
        </label>
        <label className="field">
          <span>{appPw ? t('App-lösenord') : t('Lösenord')}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={provider === 'gmail' && !isOther ? t('16 tecken från Google') : ''}
            autoFocus={!!existing}
          />
        </label>
        {help?.help && provider !== 'simply' && (
          <div className="help-box">
            <p>{t(help.help)}</p>
            {provider === 'outlook' && microsoftReady ? (
              <button type="button" className="btn oauth-btn" onClick={() => void startOAuth('microsoft')} disabled={!!busy}>
                {t('Logga in med Microsoft')}
              </button>
            ) : (
              help.helpUrl && (
                <button type="button" className="link" onClick={() => api.external(help.helpUrl!)}>
                  {help.helpLinkText ? t(help.helpLinkText) : help.helpUrl}
                </button>
              )
            )}
          </div>
        )}
        {errorBox}
        <button type="submit" hidden />
      </form>
    );
    foot = (
      <>
        <button className="btn ghost manual-link" onClick={manual} disabled={!!busy}>
          {t('Ställ in manuellt')}
        </button>
        <span className="grow" />
        {busy && (
          <span className="muted small setup-progress" role="status">
            <span className="spinner" aria-hidden="true" />
            {progress ?? busy}
          </span>
        )}
        <button className="btn" onClick={onClose}>
          {t('Avbryt')}
        </button>
        <button className="btn primary setup-btn" onClick={() => void setup(isOther ? undefined : provider)} disabled={!!busy}>
          {t('Logga in')}
        </button>
      </>
    );
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className={cx('modal account-modal add-account', `view-${view}`)} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          {back}
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('Stäng')}>
            <I.Close size={16} />
          </button>
        </header>
        {body}
        {foot && <footer className="modal-foot">{foot}</footer>}
      </div>
    </div>
  );
}
