import { useEffect, useState } from 'react';
import type { AgentLogEntry, AgentPermission, AgentPermissions, Settings, ThemeChoice, TrustedSender } from '../../shared/types';
import { api, type AgentInfo, type McpClientInfo } from '../api';
import { cx } from '../util';
import { APP_NAME } from '../../shared/brand';
import { locale, t, tn } from '../../shared/i18n';
import * as I from './Icons';

const themes = (): [ThemeChoice, string][] => [
  ['system', t('Som Windows')],
  ['light', t('Ljust')],
  ['dark', t('Mörkt')]
];

const languages = (): [Settings['language'], string][] => [
  ['auto', t('Samma som Windows')],
  ['sv', 'Svenska'],
  ['en', 'English']
];

const permissionRows = (): [keyof AgentPermissions, string][] => [
  ['send', t('Skicka mejl')],
  ['delete', t('Radera mejl')],
  ['unsubscribe', t('Avregistrera och städa')]
];

const permissionChoices = (): [AgentPermission, string][] => [
  ['ask', t('Fråga först')],
  ['allow', t('Tillåt alltid')],
  ['never', t('Aldrig')]
];

function logTime(at: number): string {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

interface Props {
  settings: Settings;
  onEditSignatures(): void;
  onClose(): void;
  onSaved(): void;
}

export function SettingsDialog({ settings, onEditSignatures, onClose, onSaved }: Props) {
  const [s, setS] = useState<Settings>(settings);
  const [saving, setSaving] = useState(false);
  const [googleSecret, setGoogleSecret] = useState('');
  const [hasGoogleSecret, setHasGoogleSecret] = useState(false);
  const [openaiKey, setOpenaiKey] = useState('');
  const [hasOpenaiKey, setHasOpenaiKey] = useState(false);
  const [models, setModels] = useState<{ latest: string | null; models: string[] } | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [codex, setCodex] = useState<{ installed: boolean; chatgpt: boolean; detail: string } | null>(null);
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [clients, setClients] = useState<McpClientInfo[] | null>(null);
  const [clientBusy, setClientBusy] = useState<string | null>(null);
  const [clientNote, setClientNote] = useState<{ error: boolean; text: string } | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [activity, setActivity] = useState<AgentLogEntry[]>([]);
  const [trusted, setTrusted] = useState<TrustedSender[]>([]);

  useEffect(() => {
    void api.oauthConfig().then((c) => setHasGoogleSecret(c.hasGoogleSecret)).catch(() => undefined);
    void api.openaiStatus().then((st) => setHasOpenaiKey(st.hasKey)).catch(() => undefined);
    void api.codexStatus().then(setCodex).catch(() => undefined);
    void api.agentInfo().then(setAgent).catch(() => undefined);
    void api.mcpClients().then(setClients).catch(() => undefined);
    void api.trustedSenders().then(setTrusted).catch(() => undefined);
    const loadLog = () => void api.agentLog().then(setActivity).catch(() => undefined);
    loadLog();
    return api.on('agent-log', loadLog);
  }, []);

  const toggleClient = async (c: McpClientInfo) => {
    setClientBusy(c.id);
    setClientNote(null);
    try {
      const connect = !c.connected;
      setClients(connect ? await api.mcpClientConnect(c.id) : await api.mcpClientDisconnect(c.id));
      setClientNote({ error: false, text: connect ? t('Starta om {name} så att {app} syns där.', { name: c.name, app: APP_NAME }) : t('{name} är bortkopplat. Starta om {name}.', { name: c.name }) });
    } catch (e: any) {
      setClientNote({ error: true, text: e.message });
    } finally {
      setClientBusy(null);
    }
  };

  const copy = (key: string, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
    });
  };

  const loadModels = async () => {
    setModelError(null);
    try {
      setModels(await api.openaiModels());
    } catch (e: any) {
      setModelError(e.message);
    }
  };

  useEffect(() => {
    if (s.aiEngine === 'openai' && hasOpenaiKey && !models) void loadModels();
  }, [s.aiEngine, hasOpenaiKey]);

  const saveKey = async () => {
    if (!openaiKey.trim()) return;
    const st = await api.openaiKeySave(openaiKey.trim());
    setOpenaiKey('');
    setHasOpenaiKey(st.hasKey);
    setModels(null);
    await loadModels();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    if (openaiKey.trim()) await api.openaiKeySave(openaiKey.trim());
    await api.oauthConfigSave({ googleClientId: s.googleClientId, microsoftClientId: s.microsoftClientId, googleClientSecret: googleSecret || undefined });
    // Signaturerna sparas i sin egen dialog och skrivs inte över härifrån.
    const { signatures: _sigs, sparkOffered: _offered, agentHttpToken: _token, ...rest } = s;
    await api.saveSettings(rest);
    setSaving(false);
    onSaved();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal" role="dialog" aria-modal="true" aria-label={t('Inställningar')}>
        <header className="modal-head">
          <h2>{t('Inställningar')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('Stäng')}>
            <I.Close size={16} />
          </button>
        </header>
        <div className="modal-body">
          <div className="section-title">{t('AI-hjälp')}</div>
          <div className="segmented engines" role="radiogroup" aria-label={t('AI-motor')}>
            <button className={cx(s.aiEngine === 'spark' && 'on')} onClick={() => setS({ ...s, aiEngine: 'spark' })} role="radio" aria-checked={s.aiEngine === 'spark'}>
              <strong>{t('Egen server')}</strong>
              <span>{t('Lokal och gratis')}</span>
            </button>
            <button className={cx(s.aiEngine === 'local' && 'on')} onClick={() => setS({ ...s, aiEngine: 'local' })} role="radio" aria-checked={s.aiEngine === 'local'}>
              <strong>{t('Datorns modell')}</strong>
              <span>{t('Grafikkortet, startar på 25 s')}</span>
            </button>
            <button className={cx(s.aiEngine === 'claude' && 'on')} onClick={() => setS({ ...s, aiEngine: 'claude' })} role="radio" aria-checked={s.aiEngine === 'claude'}>
              <strong>Claude</strong>
              <span>{t('Via Max-abonnemanget')}</span>
            </button>
            <button className={cx(s.aiEngine === 'openai' && 'on')} onClick={() => setS({ ...s, aiEngine: 'openai' })} role="radio" aria-checked={s.aiEngine === 'openai'}>
              <strong>ChatGPT</strong>
              <span>{t('OpenAI:s API, egen nyckel')}</span>
            </button>
            <button
              className={cx(s.aiEngine === 'codex' && 'on', codex && !codex.chatgpt && 'unavailable')}
              onClick={() => setS({ ...s, aiEngine: 'codex' })}
              role="radio"
              aria-checked={s.aiEngine === 'codex'}
            >
              <strong>{t('ChatGPT (ditt abonnemang)')}</strong>
              <span>{codex ? (codex.chatgpt ? t('Via Codex CLI') : t('Kräver Codex CLI')) : t('Kontrollerar…')}</span>
            </button>
          </div>
          {s.aiEngine === 'spark' ? (
            <>
              <label className="field">
                <span>{t('Serverns adress')}</span>
                <input value={s.sparkUrl} onChange={(e) => setS({ ...s, sparkUrl: e.target.value })} spellCheck={false} />
              </label>
              <div className="field-pair">
                <label className="field">
                  <span>{t('Modell')}</span>
                  <input value={s.sparkModel} onChange={(e) => setS({ ...s, sparkModel: e.target.value })} spellCheck={false} />
                </label>
                <label className="field">
                  <span>{t('Nyckel')}</span>
                  <input type="password" value={s.sparkKey} onChange={(e) => setS({ ...s, sparkKey: e.target.value })} />
                </label>
              </div>
            </>
          ) : s.aiEngine === 'local' ? (
            <>
              <label className="field">
                <span>{t('Adress till datorns modell')}</span>
                <input value={s.localUrl} onChange={(e) => setS({ ...s, localUrl: e.target.value })} spellCheck={false} />
              </label>
              <div className="field-pair">
                <label className="field">
                  <span>{t('Modell')}</span>
                  <input value={s.localModel} onChange={(e) => setS({ ...s, localModel: e.target.value })} spellCheck={false} />
                </label>
                <label className="field">
                  <span>{t('Nyckel')}</span>
                  <input type="password" value={s.localKey} onChange={(e) => setS({ ...s, localKey: e.target.value })} />
                </label>
              </div>
            </>
          ) : s.aiEngine === 'openai' ? (
            <>
              <div className="field-pair">
                <label className="field">
                  <span>{t('API-nyckel från OpenAI')}</span>
                  <input
                    id="openai-key"
                    type="password"
                    value={openaiKey}
                    onChange={(e) => setOpenaiKey(e.target.value)}
                    onBlur={() => void saveKey()}
                    placeholder={hasOpenaiKey ? t('Sparad, lämna tomt') : 'sk-…'}
                    spellCheck={false}
                  />
                </label>
                <label className="field">
                  <span>{t('Modell')}</span>
                  <select id="openai-model" value={s.openaiModel} onChange={(e) => setS({ ...s, openaiModel: e.target.value })} disabled={!models}>
                    <option value="">{models?.latest ? t('Senaste ({model})', { model: models.latest }) : t('Senaste GPT-modellen')}</option>
                    {models?.models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                    {s.openaiModel && !models?.models.includes(s.openaiModel) && <option value={s.openaiModel}>{s.openaiModel}</option>}
                  </select>
                </label>
              </div>
              {modelError && <p className="muted small error-text">{modelError}</p>}
              <p className="muted small">
                {t('Kostar per anrop hos OpenAI. Nyckeln sparas krypterad med Windows och skickas bara till OpenAI. Snabbsvar tas fram på begäran.')}
              </p>
            </>
          ) : s.aiEngine === 'codex' ? (
            <>
              <div className={cx('status-box', codex && !codex.chatgpt && 'error')}>
                <div className="status-line codex-status">
                  <span className={cx('dot', codex?.chatgpt ? 'dot-online' : 'dot-offline')} />
                  <span className="status-text">{codex?.detail ?? t('Kontrollerar Codex CLI…')}</span>
                  <button className="btn small" onClick={() => void api.codexStatus(true).then(setCodex)}>
                    {t('Kontrollera igen')}
                  </button>
                </div>
                {codex && !codex.chatgpt && (
                  <div className="status-sub muted small">
                    {t('Installera med')} <code>npm i -g @openai/codex</code> {t('och logga in med')} <code>codex login</code>{t(', välj ChatGPT-kontot.')}
                  </div>
                )}
              </div>
              <div className="field-pair">
                <label className="field">
                  <span>{t('Sökväg till Codex (valfri)')}</span>
                  <input value={s.codexPath} onChange={(e) => setS({ ...s, codexPath: e.target.value })} spellCheck={false} placeholder={t('Hittas på PATH')} />
                </label>
                <label className="field">
                  <span>{t('Modell (valfri)')}</span>
                  <input value={s.codexModel} onChange={(e) => setS({ ...s, codexModel: e.target.value })} spellCheck={false} placeholder={t('Codex standard')} />
                </label>
              </div>
            </>
          ) : (
            <label className="field">
              <span>{t('Sökväg till Claude Code')}</span>
              <input value={s.claudePath} onChange={(e) => setS({ ...s, claudePath: e.target.value })} spellCheck={false} />
            </label>
          )}
          <label className="field">
            <span>{t('Din ton (används i alla förslag)')}</span>
            <textarea rows={4} value={s.tone} onChange={(e) => setS({ ...s, tone: e.target.value })} />
          </label>

          <div className="section-title">{t('Inloggning med Google och Microsoft')}</div>
          <p className="muted small settings-note">
            {t('Klient-id skapar du själv i Google Cloud och Azure, se docs/oauth.md. Utan dem används app-lösenord.')}
          </p>
          <label className="field">
            <span>{t('Google klient-id')}</span>
            <input id="google-client-id" value={s.googleClientId} onChange={(e) => setS({ ...s, googleClientId: e.target.value })} spellCheck={false} placeholder="123-abc.apps.googleusercontent.com" />
          </label>
          <label className="field">
            <span>{t('Google klienthemlighet')}</span>
            <input
              id="google-client-secret"
              type="password"
              value={googleSecret}
              onChange={(e) => setGoogleSecret(e.target.value)}
              placeholder={hasGoogleSecret ? t('Sparad. Lämna tomt för att behålla.') : 'GOCSPX-…'}
            />
          </label>
          <label className="field">
            <span>{t('Microsoft klient-id (Azure)')}</span>
            <input id="microsoft-client-id" value={s.microsoftClientId} onChange={(e) => setS({ ...s, microsoftClientId: e.target.value })} spellCheck={false} placeholder="00000000-0000-0000-0000-000000000000" />
          </label>

          <div className="section-title">{t('Styr med AI-verktyg')}</div>
          <label className="check">
            <input id="agent-tools" type="checkbox" checked={s.agentTools} onChange={(e) => setS({ ...s, agentTools: e.target.checked })} />
            <span>{t('Låt Claude Code, Zed och andra AI-verktyg läsa, skriva och skicka mejl åt dig (MCP)')}</span>
          </label>
          {s.agentTools && agent && (
            <div className="agent-setup">
              <p className="muted small">
                {t('Verktyget skickar bara när du ber om det, annars hamnar svaren i Utkast och öppnas här. {app} startas dold i systemfältet om den inte redan är igång.', { app: APP_NAME })}
              </p>
              {clients && (
                <div className="client-list" id="mcp-clients">
                  {clients.map((c) => (
                    <div className={cx('client-row', !c.installed && 'missing')} key={c.id} data-client={c.id}>
                      <div className="client-name">
                        <span>{c.name}</span>
                        {c.connected ? (
                          <span className="client-state on">
                            <I.Check size={12} /> {t('Ansluten')}
                          </span>
                        ) : !c.installed ? (
                          <span className="client-state">{t('Inte installerad')}</span>
                        ) : null}
                      </div>
                      {c.installed && (!c.connected || c.managed) ? (
                        <button className="btn small" disabled={clientBusy === c.id} onClick={() => void toggleClient(c)}>
                          {c.connected ? t('Koppla från') : t('Anslut')}
                        </button>
                      ) : c.connected ? (
                        <span className="muted small" title={c.path}>
                          {t('Inlagd för hand')}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
              {clientNote && <p className={cx('small', clientNote.error ? 'error-text' : 'muted')}>{clientNote.text}</p>}
              <label className="check">
                <input id="agent-http" type="checkbox" checked={s.agentHttp} onChange={(e) => setS({ ...s, agentHttp: e.target.checked })} />
                <span>{t('Ta emot anslutningar via en adress (HTTP) för verktyg som inte kan starta program')}</span>
              </label>
              {s.agentHttp && (
                <div className="http-setup">
                  <div className="settings-row">
                    <span className="grow">{t('Port')}</span>
                    <input
                      id="agent-http-port"
                      className="port-input"
                      inputMode="numeric"
                      value={s.agentHttpPort}
                      onChange={(e) => setS({ ...s, agentHttpPort: Math.min(65535, Number(e.target.value.replace(/\D/g, '')) || 0) })}
                    />
                  </div>
                  <div className="settings-row">
                    <span className="grow">{t('Nyckel')}</span>
                    <code className="token" id="agent-http-token">
                      {s.agentHttpToken ? (showToken ? s.agentHttpToken : `${s.agentHttpToken.slice(0, 6)}${'•'.repeat(14)}`) : t('Skapas när du sparar')}
                    </code>
                    {s.agentHttpToken && (
                      <>
                        <button className="btn small" onClick={() => setShowToken((v) => !v)}>
                          {showToken ? t('Dölj') : t('Visa')}
                        </button>
                        <button className="btn small" onClick={() => copy('token', s.agentHttpToken)}>
                          {copied === 'token' ? t('Kopierat') : t('Kopiera')}
                        </button>
                      </>
                    )}
                    <button
                      className="btn small"
                      id="agent-http-rotate"
                      onClick={() =>
                        void api.agentHttpRotate().then((tok) => {
                          setS((cur) => ({ ...cur, agentHttpToken: tok }));
                          setClientNote({ error: false, text: t('Ny nyckel. Den gamla slutar fungera direkt.') });
                        })
                      }
                    >
                      {t('Ny nyckel')}
                    </button>
                  </div>
                  {agent.http.error && <p className="small error-text">{agent.http.error}</p>}
                </div>
              )}
              <div className="section-sub">{t('Behörigheter')}</div>
              <div className="permission-list" id="agent-permissions">
                {permissionRows().map(([key, label]) => (
                  <div className="settings-row" key={key}>
                    <span className="grow">{label}</span>
                    <select
                      id={`perm-${key}`}
                      className="clean-sort"
                      value={s.agentPermissions?.[key] ?? 'ask'}
                      onChange={(e) => setS({ ...s, agentPermissions: { ...s.agentPermissions, [key]: e.target.value as AgentPermission } })}
                    >
                      {permissionChoices().map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <div className="section-sub activity-head">
                <span className="grow">{t('Aktivitet')}</span>
                {activity.length > 0 && (
                  <button className="btn small" id="agent-log-clear" onClick={() => void api.agentLogClear().then(() => setActivity([]))}>
                    {t('Rensa')}
                  </button>
                )}
              </div>
              {activity.length ? (
                <div className="activity-list" id="agent-activity">
                  {activity.map((e) => (
                    <div className={cx('activity-row', !e.ok && 'failed')} key={e.id} title={e.error || undefined}>
                      <span className="activity-time">{logTime(e.at)}</span>
                      <span className="activity-tool">{e.tool}</span>
                      <span className="activity-summary">
                        {e.client ? `${e.client}: ` : ''}
                        {e.error ? `${e.summary}${e.summary ? '. ' : ''}${e.error}` : e.summary}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted small">{t('Inga anrop än.')}</p>
              )}
              <details className="manual-setup">
                <summary>{t('Visa manuell installation')}</summary>
                {snippets(agent).map(([key, label, text]) => (
                  <div className="snippet" key={key}>
                    <div className="snippet-head">
                      <span>{label}</span>
                      <button className="btn small" onClick={() => copy(key, text)}>
                        {copied === key ? t('Kopierat') : t('Kopiera')}
                      </button>
                    </div>
                    <pre>{text}</pre>
                  </div>
                ))}
                {s.agentHttp && (
                  <div className="snippet">
                    <div className="snippet-head">
                      <span>{t('Adress för HTTP (Streamable HTTP)')}</span>
                      <button className="btn small" onClick={() => copy('http', httpUrl(s.agentHttpPort))}>
                        {copied === 'http' ? t('Kopierat') : t('Kopiera')}
                      </button>
                    </div>
                    <pre>{`${httpUrl(s.agentHttpPort)}\nAuthorization: Bearer ${t('<nyckeln ovan>')}`}</pre>
                  </div>
                )}
              </details>
            </div>
          )}

          <div className="section-title">{t('Signaturer')}</div>
          <div className="settings-row">
            <span className="muted small grow">
              {settings.signatures.length === 0
                ? t('Inga signaturer än.')
                : t('{count}: {names}', { count: tn(settings.signatures.length, '{n} signatur', '{n} signaturer'), names: settings.signatures.map((x) => x.name).join(', ') })}
            </span>
            <button className="btn small" onClick={onEditSignatures}>
              {t('Redigera signaturer…')}
            </button>
          </div>

          <div className="section-title">{t('Betrodda avsändare')}</div>
          <p className="muted small">
            {t('Bilder från internet visas direkt i mejl från de här adresserna, och från adresser du själv har skrivit till. I skräpposten visas de aldrig direkt.')}
          </p>
          {trusted.length ? (
            <div className="activity-list" id="trusted-senders">
              {trusted.map((x) => (
                <div className="trusted-row" key={x.address}>
                  <span className="trusted-address">{x.address}</span>
                  <button
                    className="btn small"
                    aria-label={t('Ta bort {name}', { name: x.address })}
                    onClick={() => void api.setTrustedSender(x.address, false).then(setTrusted).catch(() => undefined)}
                  >
                    {t('Ta bort')}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted small">{t('Inga betrodda avsändare än. Lägg till en med Visa alltid bilder i ett mejl.')}</p>
          )}

          <div className="section-title">{t('Allmänt')}</div>
          <div className="settings-row">
            <span className="grow">{t('Utseende')}</span>
            <div className="segmented small" id="theme-choice">
              {themes().map(([v, label]) => (
                <button key={v} className={s.theme === v ? 'on' : ''} onClick={() => setS({ ...s, theme: v })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-row">
            <span className="grow">{t('Språk')}</span>
            <div className="segmented small" id="language-choice">
              {languages().map(([v, label]) => (
                <button key={v} className={s.language === v ? 'on' : ''} onClick={() => setS({ ...s, language: v })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={s.notifications} onChange={(e) => setS({ ...s, notifications: e.target.checked })} />
            <span>{t('Visa aviseringar i Windows när nya mejl kommer')}</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={s.threads} onChange={(e) => setS({ ...s, threads: e.target.checked })} />
            <span>{t('Visa konversationer som trådar')}</span>
          </label>
          <label className="check">
            <input id="smart-inbox" type="checkbox" checked={s.smartInbox} onChange={(e) => setS({ ...s, smartInbox: e.target.checked })} />
            <span>{t('Smart inkorg: personliga mejl för sig, nyhetsbrev och aviseringar i egna flikar')}</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={s.openAtLogin} onChange={(e) => setS({ ...s, openAtLogin: e.target.checked })} />
            <span>{t('Starta {app} när Windows startar (i systemfältet)', { app: APP_NAME })}</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={s.closeToTray} onChange={(e) => setS({ ...s, closeToTray: e.target.checked })} />
            <span>{t('Stäng till systemfältet och fortsätt hämta mejl')}</span>
          </label>
          <div className="settings-row">
            <span className="grow">{t('Ångra skicka')}</span>
            <select id="undo-send" className="clean-sort" value={s.undoSendSeconds} onChange={(e) => setS({ ...s, undoSendSeconds: Number(e.target.value) })}>
              <option value={0}>{t('Av, skicka direkt')}</option>
              <option value={5}>{t('{n} sekunder', { n: 5 })}</option>
              <option value={10}>{t('{n} sekunder', { n: 10 })}</option>
              <option value={20}>{t('{n} sekunder', { n: 20 })}</option>
              <option value={30}>{t('{n} sekunder', { n: 30 })}</option>
            </select>
          </div>
          <label className="field narrow">
            <span>{t('Antal mejl att hämta per mapp')}</span>
            <input
              inputMode="numeric"
              value={s.syncLimit}
              onChange={(e) => setS({ ...s, syncLimit: Math.min(5000, Number(e.target.value.replace(/\D/g, '')) || 50) })}
            />
          </label>
        </div>
        <footer className="modal-foot">
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            {t('Avbryt')}
          </button>
          <button className="btn primary" onClick={save} disabled={saving}>
            {t('Spara')}
          </button>
        </footer>
      </div>
    </div>
  );
}

function httpUrl(port: number) {
  return `http://127.0.0.1:${port || 7337}/mcp`;
}

function snippets(a: AgentInfo): [string, string, string][] {
  const q = (x: string) => (/\s/.test(x) ? `"${x}"` : x);
  const envFlags = Object.entries(a.env).map(([k, v]) => `-e ${k}=${v} `).join('');
  const claude = `claude mcp add mr-mail --scope user ${envFlags}-- ${[a.command, ...a.args].map(q).join(' ')}`;
  const zed = JSON.stringify({ context_servers: { 'mr-mail': { source: 'custom', command: a.command, args: a.args, env: a.env } } }, null, 2);
  return [
    ['claude', t('Claude Code (kör i en terminal)'), claude],
    ['zed', t('Zed (i settings.json)'), zed]
  ];
}
