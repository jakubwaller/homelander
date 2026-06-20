// Setup Wizard — first-launch guided setup for Homelander.
// 6 steps: Language → Persona → Message → IS24 Login → 2captcha → First Search → Done

import React, { useState, useEffect, useCallback } from 'react';
import { useStore } from '../stores/appStore';
import { useLocale } from '../locales/LocaleContext';
import {
  IS24_SALUTATION,
  IS24_MOVE_IN,
  IS24_PERSONS,
  IS24_PETS,
  IS24_EMPLOYMENT,
  IS24_INCOME,
  IS24_DOCUMENTS,
} from '../shared/is24FormOptions';
import { userErrorText } from '../shared/userErrors';

const STEPS = [
  { id: 'language', label: 'Language' },
  { id: 'persona', label: 'Persona' },
  { id: 'message', label: 'Message' },
  { id: 'is24', label: 'IS24' },
  { id: 'captcha', label: '2captcha' },
  { id: 'search', label: 'Search' },
];

const ANREDE_OPTIONS = IS24_SALUTATION.filter(Boolean);
const EINZUG_OPTIONS = IS24_MOVE_IN.filter(Boolean);
const PERSONEN_OPTIONS = IS24_PERSONS.filter(Boolean);
const HAUSTIERE_OPTIONS = IS24_PETS.filter(Boolean);
const BESCHAEFTIGUNG_OPTIONS = IS24_EMPLOYMENT.filter(Boolean);
const EINKOMMEN_OPTIONS = IS24_INCOME.filter(Boolean);
const UNTERLAGEN_OPTIONS = IS24_DOCUMENTS.filter(Boolean);

const DEFAULT_MESSAGE = [
  'Sehr geehrte Damen und Herren,',
  '',
  'ich interessiere mich für {{title}} in {{address}}.',
  '',
  'Mit freundlichen Grüßen',
  '{{name}}',
].join('\n');

export default function SetupWizard({ onComplete }) {
  const { t, locale, setLocale } = useLocale();
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState(null);
  const [saving, setSaving] = useState(false);
  const [is24Status, setIs24Status] = useState('pending');
  const [captchaValidating, setCaptchaValidating] = useState(false);
  const [searchUrl, setSearchUrl] = useState('');

  // Floating feedback toast (matches SettingsTab pattern)
  const [feedback, setFeedback] = useState(null);
  const [feedbackVisible, setFeedbackVisible] = useState(false);
  const showFeedback = (fb) => {
    setFeedback(fb);
    requestAnimationFrame(() => setFeedbackVisible(true));
    setTimeout(() => {
      setFeedbackVisible(false);
      setTimeout(() => setFeedback(null), 300);
    }, 2500);
  };

  const setStoreConfig = useStore((s) => s.setConfig);
  const setStoreSetupComplete = useStore((s) => s.setSetupComplete);

  // Load config on mount
  useEffect(() => {
    async function load() {
      if (window.homelander) {
        const cfg = await window.homelander.getConfig();
        setConfig(cfg);
      }
    }
    load();
  }, []);

  const updateConfig = useCallback((patch) => {
    setConfig((prev) => {
      const merged = { ...prev };
      for (const [key, value] of Object.entries(patch)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          merged[key] = { ...merged[key], ...value };
        } else {
          merged[key] = value;
        }
      }
      return merged;
    });
  }, []);

  const saveAndNext = async () => {
    setSaving(true);

    try {
      if (!window.homelander) throw { userError: { code: 'BACKEND_UNAVAILABLE', title: t('errors.backendUnavailable.title', 'Backend unavailable'), message: t('errors.backendUnavailable.message', 'Homelander is still starting up. Try again in a moment.') } };

      let configToSave = config;

      // ── Step-specific validation ────────────────────────────
      if (step === 1) {
        // Persona: ALL fields mandatory
        const errors = [];
        const p = configToSave.persona || {};
        if (!p.anrede?.trim()) errors.push(t('setup.anredeRequired', 'Anrede is required'));
        if (!p.vorname?.trim()) errors.push(t('setup.vornameRequired', 'Vorname is required'));
        if (!p.nachname?.trim()) errors.push(t('setup.nachnameRequired', 'Nachname is required'));
        if (!p.email?.trim()) errors.push(t('setup.emailRequired', 'Email is required'));
        if (p.email?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email.trim())) {
          errors.push(t('setup.emailInvalid', 'Email format is invalid'));
        }
        if (!p.telefon?.trim()) errors.push(t('setup.telefonRequired', 'Telefon is required'));
        if (!p.strasse?.trim()) errors.push(t('setup.strasseRequired', 'Straße is required'));
        if (!p.hausnummer?.trim()) errors.push(t('setup.hausnrRequired', 'Hausnr. is required'));
        if (!p.plz?.trim()) errors.push(t('setup.plzRequired', 'PLZ is required'));
        if (p.plz?.trim() && !/^\d{4,5}$/.test(String(p.plz).trim())) {
          errors.push(t('setup.plzDigits', 'PLZ must be 4-5 digits'));
        }
        if (!p.ort?.trim()) errors.push(t('setup.ortRequired', 'Ort is required'));
        if (!p.einzug?.trim()) errors.push(t('setup.einzugRequired', 'Einzug is required'));
        if (p.einzug === 'genaues Datum' && !p.einzug_datum?.trim()) errors.push(t('setup.einzugDatumRequired', 'Einzug Datum is required'));
        if (!p.personen?.trim()) errors.push(t('setup.personenRequired', 'Personen is required'));
        if (!p.haustiere?.trim()) errors.push(t('setup.haustiereRequired', 'Haustiere is required'));
        if (p.haustiere === 'Ja' && !p.haustiere_zusatz?.trim()) errors.push(t('setup.haustiereZusatzRequired', 'Anzahl und Tierart is required'));
        if (!p.beschaeftigung?.trim()) errors.push(t('setup.beschaeftigungRequired', 'Beschäftigung is required'));
        if (!p.einkommen?.trim()) errors.push(t('setup.einkommenRequired', 'Einkommen (netto) is required'));
        if (!p.unterlagen?.trim()) errors.push(t('setup.unterlagenRequired', 'Unterlagen is required'));
        if (errors.length > 0) {
          const msg = errors.length > 3 ? t('setup.allFieldsRequired', 'All fields are required') : errors.join('; ');
          showFeedback({ type: 'error', msg });
          setSaving(false);
          return;
        }
      }

      if (step === 3) {
        // IS24 login: do not inspect or verify the account page. IS24 login/SSO
        // is sensitive to automation, so this step trusts the user's confirmation.
        let chromeStatus = await window.homelander.getChromeStatus();
        
        if (!chromeStatus.running) {
          // Auto-launch plain Chromium for the user, then stop here. The user
          // should log in manually and click Continue only after the page shows
          // them as logged in.
          setIs24Status('launching');
          try {
            await window.homelander.updateConfig(config);
            const result = await window.homelander.openLoginPage();
            if (result.error) throw result;
            setIs24Status('waiting_for_login');
            showFeedback({ type: 'success', msg: t('setup.is24WaitingStatus', 'Log in, then click Continue.') });
            setSaving(false);
            return;
          } catch (err) {
            showFeedback({ type: 'error', msg: userErrorText(err.userError || err, { operation: 'chrome open' }, t) });
            setIs24Status('chrome_error');
            setSaving(false);
            return;
          }
        }

        // User clicked Continue after confirming the manual login. If this is
        // still the plain login browser, close it and relaunch the same profile
        // under CDP for applying. No login probes, no email scraping.
        if (chromeStatus.manualLogin && !chromeStatus.cdpHealthy) {
          setIs24Status('preparing');
          const finalize = await window.homelander.finalizeManualLogin();
          if (finalize?.error) throw finalize;
          await new Promise(r => setTimeout(r, 800));
        }
      }

      if (step === 4) {
        // 2captcha: validate the API key if provided (optional)
        const captchaKey = configToSave.captcha?.api_key || '';
        if (captchaKey.trim()) {
          setCaptchaValidating(true);
          const validResult = await window.homelander.validateCaptchaKey(captchaKey.trim());
          setCaptchaValidating(false);
          if (!validResult.valid) {
            showFeedback({ type: 'error', msg: userErrorText(validResult.userError || validResult, { operation: 'captcha validate' }, t) });
            setSaving(false);
            return;
          }
        }
        // Empty key = skip captcha solving (listings with captchas will be skipped)
      }

      if (step === 5) {
        // First search: validate URL if provided
        if (searchUrl.trim()) {
          const testResult = await window.homelander.testFilter(searchUrl.trim());
          if (testResult.error) {
            showFeedback({ type: 'error', msg: userErrorText(testResult.userError || testResult, { operation: 'search test' }, t) });
            setSaving(false);
            return;
          }
          // Save the filter before completing setup so new users do not land on an empty dashboard.
          const addResult = await window.homelander.addFilter(searchUrl.trim(), '');
          if (addResult?.error) {
            showFeedback({ type: 'error', msg: userErrorText(addResult.userError || addResult, { operation: 'search add' }, t) });
            setSaving(false);
            return;
          }
        }
      }

      // Save config
      await window.homelander.updateConfig(configToSave);

      if (step < 5) {
        setStep(step + 1);
      } else {
        // Final step — complete setup
        await window.homelander.completeSetup();
        setStoreSetupComplete(true);
        setStoreConfig(configToSave);
        onComplete();
      }
    } catch (err) {
      showFeedback({ type: 'error', msg: userErrorText(err.userError || err, { operation: 'setup' }, t) });
    } finally {
      setSaving(false);
      setCaptchaValidating(false);
    }
  };

  const updatePersona = (field, value) => {
    updateConfig({
      persona: { ...config?.persona, [field]: value },
    });
  };

  if (!config) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p style={{ color: 'var(--text-muted)' }}>{t('setup.loading', 'Lädt…')}</p>
      </div>
    );
  }

  const persona = config.persona || {};

  return (
    <div className="flex flex-col h-screen">
      {/* Titlebar */}
      <div className="titlebar" />

      {/* Header */}
      <header className="flex items-center justify-between px-5 pb-2">
        <h1 className="text-lg font-semibold tracking-tight">{t('setup.header', 'Homelander Setup')}</h1>
      </header>

      {/* Step indicator */}
      <div className="flex items-center justify-center gap-3 py-4">
        {STEPS.map((s, i) => (
          <React.Fragment key={s.id}>
            <div className={`step-dot ${i < step ? 'done' : i === step ? 'active' : ''}`}>
              {i < step ? '✓' : i + 1}
            </div>
            <span className="text-xs" style={{ color: i <= step ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              {t(`setup.steps.${s.id}`, s.label)}
            </span>
            {i < STEPS.length - 1 && (
              <div style={{ width: 24, height: 1, background: i < step ? 'var(--success)' : 'var(--border)' }} />
            )}
          </React.Fragment>
        ))}
      </div>

      {/* Feedback toast — fixed overlay (matches SettingsTab pattern) */}
      {feedback && (
        <div
          className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-3 py-1.5 rounded-lg text-xs font-medium shadow-lg"
          style={{
            background: feedback.type === 'success' ? 'rgba(34,197,94,0.85)' : 'rgba(239,68,68,0.85)',
            color: '#fff',
            opacity: feedbackVisible ? 1 : 0,
            transition: 'opacity 0.3s ease',
          }}
        >
          {feedback.msg}
        </div>
      )}

      {/* Content */}
      <main className="flex-1 overflow-y-auto px-8 pb-8" style={{ maxWidth: 600, margin: '0 auto', width: '100%' }}>

        {/* ── Step 0: Language ────────────────────────────────────────── */}
        {step === 0 && (
          <div className="space-y-6 text-center" style={{ maxWidth: 420, margin: '0 auto' }}>
            <h2 className="text-base font-semibold">{t('setup.language', 'Language')}</h2>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{t('setup.languageDesc', 'Choose your language')}</p>
            <div className="grid grid-cols-2 gap-4">
              {['de', 'en'].map((lang) => (
                <button
                  key={lang}
                  className="card p-6 cursor-pointer transition-all hover:scale-[1.02]"
                  style={{
                    border: locale === lang ? '2px solid var(--accent)' : '2px solid var(--border)',
                    background: locale === lang ? 'rgba(59,130,246,0.08)' : 'var(--bg-secondary)',
                  }}
                  onClick={() => setLocale(lang)}
                >
                  <div className="text-4xl mb-2">{lang === 'en' ? '🇬🇧' : '🇩🇪'}</div>
                  <div className="text-sm font-medium">{lang === 'en' ? t('setup.english', 'English') : t('setup.german', 'Deutsch')}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Step 1: Persona ────────────────────────────────────────── */}
        {step === 1 && (
          <div className="space-y-4">
            <h2 className="text-base font-semibold">{t('setup.personaTitle', 'Your details')}</h2>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {t('setup.personaSubtext', 'These details will be filled into the IS24 contact form for every application.')}
            </p>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>Anrede</label>
                <select className="select" value={persona.anrede || ''} onChange={(e) => updatePersona('anrede', e.target.value)}>
                  <option value="">—</option>
                  {ANREDE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('settings.personaFields.email', 'E-Mail')}</label>
                <input className="input" type="email" value={persona.email || ''} onChange={(e) => updatePersona('email', e.target.value)} placeholder={t('setup.placeholderEmail', 'your@email.com')} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('settings.personaFields.vorname', 'Vorname')}</label>
                <input className="input" value={persona.vorname || ''} onChange={(e) => updatePersona('vorname', e.target.value)} />
              </div>
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('settings.personaFields.nachname', 'Nachname')}</label>
                <input className="input" value={persona.nachname || ''} onChange={(e) => updatePersona('nachname', e.target.value)} />
              </div>
            </div>

            <div>
              <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('settings.personaFields.telefon', 'Telefon')}</label>
              <input className="input" value={persona.telefon || ''} onChange={(e) => updatePersona('telefon', e.target.value)} />
            </div>

            <div className="grid grid-cols-4 gap-3">
              <div className="col-span-2">
                <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('settings.personaFields.strasse', 'Straße')}</label>
                <input className="input" value={persona.strasse || ''} onChange={(e) => updatePersona('strasse', e.target.value)} />
              </div>
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('settings.personaFields.hausnr', 'Hausnr.')}</label>
                <input className="input" value={persona.hausnummer || ''} onChange={(e) => updatePersona('hausnummer', e.target.value)} />
              </div>
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('settings.personaFields.plz', 'PLZ')}</label>
                <input className="input" value={persona.plz || ''} onChange={(e) => updatePersona('plz', e.target.value)} />
              </div>
            </div>

            <div>
              <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('settings.personaFields.ort', 'Ort')}</label>
              <input className="input" value={persona.ort || ''} onChange={(e) => updatePersona('ort', e.target.value)} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('settings.personaFields.einzug', 'Einzug')}</label>
                <select className="select" value={persona.einzug || ''} onChange={(e) => updatePersona('einzug', e.target.value)}>
                  <option value="">—</option>
                  {EINZUG_OPTIONS.filter(Boolean).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                {persona.einzug === 'genaues Datum' && (
                  <input
                    className="input mt-2"
                    type="date"
                    value={persona.einzug_datum || ''}
                    onChange={(e) => updatePersona('einzug_datum', e.target.value)}
                  />
                )}
              </div>
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('settings.personaFields.personen', 'Personen')}</label>
                <select className="select" value={persona.personen || ''} onChange={(e) => updatePersona('personen', e.target.value)}>
                  <option value="">—</option>
                  {PERSONEN_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('settings.personaFields.haustiere', 'Haustiere')}</label>
                <select className="select" value={persona.haustiere || ''} onChange={(e) => updatePersona('haustiere', e.target.value)}>
                  <option value="">—</option>
                  {HAUSTIERE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                {persona.haustiere === 'Ja' && (
                  <input
                    className="input mt-2"
                    type="text"
                    placeholder={t('setup.placeholderHaustiere', 'Anzahl und Tierart')}
                    value={persona.haustiere_zusatz || ''}
                    onChange={(e) => updatePersona('haustiere_zusatz', e.target.value)}
                  />
                )}
              </div>
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('settings.personaFields.beschaeftigung', 'Beschäftigung')}</label>
                <select className="select" value={persona.beschaeftigung || ''} onChange={(e) => updatePersona('beschaeftigung', e.target.value)}>
                  <option value="">—</option>
                  {BESCHAEFTIGUNG_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('settings.personaFields.einkommen', 'Einkommen (netto)')}</label>
                <select className="select" value={persona.einkommen || ''} onChange={(e) => updatePersona('einkommen', e.target.value)}>
                  <option value="">—</option>
                  {EINKOMMEN_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('settings.personaFields.unterlagen', 'Unterlagen')}</label>
                <select className="select" value={persona.unterlagen || ''} onChange={(e) => updatePersona('unterlagen', e.target.value)}>
                  <option value="">—</option>
                  {UNTERLAGEN_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 2: Message Template ───────────────────────────────── */}
        {step === 2 && (
          <div className="space-y-4">
            <h2 className="text-base font-semibold">{t('setup.messageTitle', 'Message template')}</h2>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {t('setup.messageSubtext', "This message will be sent for every application. Use {{title}}, {{address}}, and {{name}} as placeholders.")}
            </p>

            <textarea
              className="input"
              rows={10}
              style={{ fontFamily: 'monospace', fontSize: 13, resize: 'vertical' }}
              value={config.message_template || DEFAULT_MESSAGE}
              onChange={(e) => updateConfig({ message_template: e.target.value })}
            />

            {/* Live preview */}
            <div className="card p-4">
              <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>{t('setup.livePreview', 'Live preview:')}</p>
              <div className="text-sm whitespace-pre-wrap" style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                {(config.message_template || DEFAULT_MESSAGE)
                  .replace(/\{\{title\}\}/g, 'Helle 2-Zimmer-Wohnung in Berlin-Mitte')
                  .replace(/\{\{address\}\}/g, 'Torstraße 15, 10119 Berlin')
                  .replace(/\{\{name\}\}/g, `${persona.vorname || 'Max'} ${persona.nachname || 'Mustermann'}`)}
              </div>
            </div>
          </div>
        )}

        {/* ── Step 3: IS24 Login ─────────────────────────────────────── */}
        {step === 3 && (
          <div className="space-y-4">
            <h2 className="text-base font-semibold">{t('setup.is24Title', 'IS24 Account')}</h2>

            <div className="card p-4">
              <div className="flex items-center gap-3">
                <StatusIndicator status={is24Status} />
                <div className="flex-1">
                  <p className="text-sm font-medium">
                    {is24Status === 'pending' && t('setup.is24Pending', 'Open IS24')}
                    {is24Status === 'launching' && t('setup.is24LaunchingStatus', 'Opening Chromium…')}
                    {is24Status === 'waiting_for_login' && t('setup.is24WaitingStatus', 'Log in, then continue')}
                    {is24Status === 'preparing' && t('setup.is24PreparingStatus', 'Saving session…')}
                    {is24Status === 'chrome_closed' && t('setup.is24ClosedStatus', 'Chromium closed')}
                    {is24Status === 'chrome_error' && t('setup.is24ErrorStatus', 'Could not open Chromium')}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {is24Status === 'pending' && t('setup.is24PendingDesc', 'Open Chromium and log in to IS24.')}
                    {is24Status === 'launching' && t('setup.is24LaunchingDesc', 'Chromium is starting.')}
                    {is24Status === 'waiting_for_login' && t('setup.is24WaitingDesc', 'Only click Continue after IS24 shows you are logged in.')}
                    {is24Status === 'preparing' && t('setup.is24PreparingDesc', 'Keeping this login for future applications.')}
                    {is24Status === 'chrome_closed' && t('setup.is24ClosedDesc', 'Reopen Chromium to log in.')}
                    {is24Status === 'chrome_error' && t('setup.is24ErrorDesc', 'Try again after Chromium is available.')}
                  </p>
                </div>
              </div>
            </div>

            {(is24Status === 'pending' || is24Status === 'chrome_closed' || is24Status === 'chrome_error') && (
              <button
                className="btn btn-primary w-full"
                onClick={async () => {
                  setIs24Status('launching');
                  try {
                    if (!window.homelander) throw { userError: { code: 'BACKEND_UNAVAILABLE', title: t('errors.backendUnavailable.title', 'Backend unavailable'), message: t('errors.backendUnavailable.message', 'Homelander is still starting up. Try again in a moment.') } };
                    await window.homelander.updateConfig(config);
                    const result = await window.homelander.openLoginPage();
                    if (result.error) throw result;
                    setIs24Status('waiting_for_login');
                  } catch (err) {
                    showFeedback({ type: 'error', msg: userErrorText(err.userError || err, { operation: 'chrome open' }, t) });
                    setIs24Status('chrome_error');
                  }
                }}
              >
                {is24Status === 'chrome_closed' ? t('setup.reopenChromium', '🖥 Reopen Chromium') :
                 is24Status === 'chrome_error' ? t('setup.tryAgain', '🖥 Try again') :
                 t('setup.openChromium', '🖥 Open Chromium')}
              </button>
            )}
          </div>
        )}

        {/* ── Step 4: 2captcha ────────────────────────────────────────── */}
        {step === 4 && (
          <div className="space-y-4">
            <h2 className="text-base font-semibold">{t('setup.captchaTitle', '2captcha API Key (optional)')}</h2>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {t('setup.captchaSubtext', 'IS24 sometimes shows captcha. Costs ~0.001$ to solve with a key from ')}{' '}
              <a href="https://2captcha.com" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>2captcha.com</a>.
            </p>

            <div>
              <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('setup.captchaApiKey', 'API Key')}</label>
              <input
                className="input"
                type="password"
                value={config.captcha?.api_key || ''}
                onChange={(e) => updateConfig({ captcha: { ...config.captcha, api_key: e.target.value } })}
                placeholder={t('setup.placeholderCaptcha', 'Leave empty to skip captcha solving')}
              />
            </div>
          </div>
        )}

        {/* ── Step 5: First Search ───────────────────────────────────── */}
        {step === 5 && (
          <div className="space-y-4">
            <h2 className="text-base font-semibold">{t('setup.searchTitle', 'Your first search')}</h2>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {t('setup.searchSubtext', 'Paste an IS24 search URL to get started. You can add more searches later from the Searches tab.')}
            </p>

            <div>
              <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('setup.searchUrlLabel', 'IS24 search URL')}</label>
              <input
                className="input"
                placeholder="https://www.immobilienscout24.de/Suche/de/..."
                value={searchUrl}
                onChange={(e) => setSearchUrl(e.target.value)}
              />
            </div>

            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {t('setup.searchSkip', 'Leave empty to skip — you can add searches later.')}
            </p>
          </div>
        )}

        {/* ── Navigation buttons ──────────────────────────────────────── */}
        <div className="flex justify-between mt-8 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
          <button
            className="btn btn-ghost"
            onClick={() => setStep(Math.max(0, step - 1))}
            disabled={step === 0}
          >
            {t('setup.backButton', '← Back')}
          </button>

          <button
            className="btn btn-primary"
            onClick={saveAndNext}
            disabled={saving}
          >
            {saving ? t('setup.saving', 'Saving…') : step === 5 ? t('setup.startSearching', 'Start searching') : t('setup.continueButton', 'Continue →')}
          </button>
        </div>
      </main>
    </div>
  );
}

// Small status indicator for IS24 login state
function StatusIndicator({ status }) {
  if (status === 'launching' || status === 'preparing') {
    return <span className="status-dot paused" />;
  }
  if (status === 'waiting_for_login') {
    return <span className="status-dot paused" style={{ opacity: 0.6 }} />;
  }
  if (status === 'chrome_closed' || status === 'chrome_error') {
    return <span className="status-dot error" />;
  }
  return <span className="status-dot error" style={{ opacity: 0.4 }} />;
}
