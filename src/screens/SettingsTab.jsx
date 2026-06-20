// SettingsTab — configuration screen for Homelander.
// Persona, Message Template, Timing, API keys.

import React, { useState, useEffect } from 'react';
import { useStore } from '../stores/appStore';
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
import { useLocale } from '../locales/LocaleContext';

// ── Helpers ──────────────────────────────────────────────────────────

function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '*'.repeat(key.length);
  return key.slice(0, 4) + '*'.repeat(key.length - 4);
}

function renderPreview(template, sample, t) {
  if (!template) return <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('settings.noTemplate', 'No template set.')}</span>;
  try {
    let result = template;
    for (const [k, v] of Object.entries(sample)) {
      result = result.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'gi'), v || `{{${k}}}`);
    }
    return <span className="text-sm whitespace-pre-wrap">{result}</span>;
  } catch {
    return <span className="text-xs" style={{ color: 'var(--danger)' }}>Invalid template.</span>;
  }
}

// ── Section wrapper ─────────────────────────────────────────────────

function Section({ title, children }) {
  return (
    <section className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

// ── Main component ──────────────────────────────────────────────────

export default function SettingsTab() {
  const { t, locale, setLocale } = useLocale();
  const config = useStore((s) => s.config);
  const setConfig = useStore((s) => s.setConfig);

  // Local editing state
  const [personaDraft, setPersonaDraft] = useState(null);
  const [templateDraft, setTemplateDraft] = useState('');
  const [timingDraft, setTimingDraft] = useState({ speed: 'balanced', poll_interval: 10 });
  const [captchaDraft, setCaptchaDraft] = useState('');
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [cleanupStep, setCleanupStep] = useState(null); // null | 'confirm' | 'purging'
  const [cleanupEmail, setCleanupEmail] = useState('');
  const [cleanupError, setCleanupError] = useState(null);
  const [supportBusy, setSupportBusy] = useState(false);
  const [feedback, setFeedback] = useState(null); // { type: 'success'|'error', msg }
  const [feedbackVisible, setFeedbackVisible] = useState(false);

  const showFeedback = (fb) => {
    setFeedback(fb);
    requestAnimationFrame(() => setFeedbackVisible(true));
    setTimeout(() => {
      setFeedbackVisible(false);
      setTimeout(() => setFeedback(null), 300);
    }, 2000);
  };

  // Initialize persona draft from config
  useEffect(() => {
    if (!config?.persona) return;
    if (personaDraft) return; // already initialized, don't overwrite user edits
    const p = config.persona;
    setPersonaDraft({
      anrede: p.anrede || '',
      vorname: p.vorname || '',
      nachname: p.nachname || '',
      email: p.email || '',
      telefon: p.telefon || '',
      strasse: p.strasse || '',
      hausnummer: p.hausnummer || '',
      plz: p.plz || '',
      ort: p.ort || '',
      einzug: p.einzug || '',
      einzug_datum: p.einzug_datum || '',
      personen: p.personen ?? '',
      haustiere: p.haustiere ?? '',
      haustiere_zusatz: p.haustiere_zusatz || '',
      beschaeftigung: p.beschaeftigung || '',
      einkommen: p.einkommen ?? '',
      unterlagen: p.unterlagen ?? '',
    });
  }, [config?.persona]);

  // Load config into local drafts on mount / config change
  useEffect(() => {
    if (!config) return;
    setTemplateDraft(config.message_template || '');
    setTimingDraft({
      speed: config.timing?.speed || 'balanced',
      poll_interval: Math.max(5, Math.round((config.polling?.interval_seconds ?? 600) / 60)),
    });
    setCaptchaDraft(config.captcha?.api_key || '');
  }, [config]);

  const save = async (patch) => {
    if (!window.homelander) {
      showFeedback({ type: 'error', msg: userErrorText('Backend unavailable', { code: 'BACKEND_UNAVAILABLE' }, t) });
      return;
    }
    const res = await window.homelander.updateConfig(patch);
    if (res?.error) {
      showFeedback({ type: 'error', msg: userErrorText(res.userError || res, { operation: 'config:update' }, t) });
    } else {
      const fresh = await window.homelander.getConfig();
      setConfig(fresh);
      showFeedback({ type: 'success', msg: t('settings.saved', 'Saved') });
    }
  };

  // ── Persona handlers ─────────────────────────────────────────────

  const updatePersonaField = (field, value) => {
    setPersonaDraft((prev) => ({ ...prev, [field]: value }));
  };

  const savePersona = () => {
    const errors = [];
    const p = personaDraft;
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
      const msg = errors.length > 3 ? t('settings.personaFields.required') : errors.join('; ');
      showFeedback({ type: 'error', msg });
      return;
    }
    save({ persona: personaDraft });
  };

  // ── Template handlers ────────────────────────────────────────────

  const saveTemplate = () => save({ message_template: templateDraft });

  // ── Timing handlers ──────────────────────────────────────────────
  // ── Timing handlers ──────────────────────────────────────────────
  const updateTimingField = (field, value) => {
    setTimingDraft((prev) => ({ ...prev, [field]: value }));
  };

  const saveTiming = () => {
    const mins = parseInt(timingDraft.poll_interval) || 10;
    const clamped = Math.max(5, mins);
    const seconds = clamped * 60;
    save({
      timing: { ...config?.timing, speed: timingDraft.speed },
      polling: { ...config?.polling, interval_seconds: seconds },
    });
  };

  // ── Captcha handler ─────────────────────────────────────────────

  const saveCaptcha = () => save({ captcha: { api_key: captchaDraft } });

  const handleExportSupportBundle = async () => {
    if (!window.homelander?.createSupportBundle) {
      showFeedback({ type: 'error', msg: 'Support bundle unavailable' });
      return;
    }
    setSupportBusy(true);
    try {
      const res = await window.homelander.createSupportBundle({ scope: 'global' });
      if (res?.ok) showFeedback({ type: 'success', msg: `Bundle exported — path copied` });
      else showFeedback({ type: 'error', msg: userErrorText(res?.userError || res || 'Bundle export failed', { operation: 'support bundle' }, t) });
    } catch (err) {
      showFeedback({ type: 'error', msg: userErrorText(err, { operation: 'support bundle' }, t) });
    } finally {
      setSupportBusy(false);
    }
  };

  // ── Clean All Data ──────────────────────────────────────────────

  const handleCleanData = () => {
    setCleanupStep('confirm');
    setCleanupEmail('');
    setCleanupError(null);
  };

  const handleCancelClean = () => {
    setCleanupStep(null);
    setCleanupEmail('');
    setCleanupError(null);
  };

  const handleConfirmClean = async () => {
    if (!cleanupEmail.trim()) {
      setCleanupError('Enter your email to confirm.');
      return;
    }
    setCleanupStep('purging');
    setCleanupError(null);
    if (window.homelander?.cleanData) {
      const res = await window.homelander.cleanData(cleanupEmail.trim());
      if (res?.error) {
        setCleanupStep('confirm');
        setCleanupError(userErrorText(res.userError || res, { operation: 'data cleanup' }, t));
      }
      // On success, app relaunches — no state update needed
    }
  };

  // ── Guard ────────────────────────────────────────────────────────

  if (!config) {
    return (
      <div className="py-12 text-center" style={{ color: 'var(--text-muted)' }}>
        <p className="text-sm">Loading configuration...</p>
      </div>
    );
  }

  const persona = config.persona || {};
  const templateRows = Math.max(6, (templateDraft.match(/\n/g)?.length || 0) + 2);

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="space-y-4 pb-8">

      {/* Feedback toast — fixed overlay, always visible */}
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

      {/* ── 1. Persona ──────────────────────────────────────────── */}
      <Section title={t("settings.persona")}>
        {personaDraft ? (
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.anrede")}</label>
                <select className="select text-sm" value={personaDraft.anrede} onChange={(e) => updatePersonaField('anrede', e.target.value)}>
                  <option value="">-</option>
                  {IS24_SALUTATION.filter(Boolean).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.vorname")}</label>
                <input className="input text-sm" value={personaDraft.vorname} onChange={(e) => updatePersonaField('vorname', e.target.value)} />
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.nachname")}</label>
                <input className="input text-sm" value={personaDraft.nachname} onChange={(e) => updatePersonaField('nachname', e.target.value)} />
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.email")}</label>
                <input className="input text-sm" type="email" value={personaDraft.email} onChange={(e) => updatePersonaField('email', e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.telefon")}</label>
                <input className="input text-sm" value={personaDraft.telefon} onChange={(e) => updatePersonaField('telefon', e.target.value)} />
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.strasse")}</label>
                <input className="input text-sm" value={personaDraft.strasse} onChange={(e) => updatePersonaField('strasse', e.target.value)} />
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.hausnr")}</label>
                <input className="input text-sm" value={personaDraft.hausnummer} onChange={(e) => updatePersonaField('hausnummer', e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.plz")}</label>
                  <input className="input text-sm" value={personaDraft.plz} onChange={(e) => updatePersonaField('plz', e.target.value)} />
                </div>
                <div>
                  <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.ort")}</label>
                  <input className="input text-sm" value={personaDraft.ort} onChange={(e) => updatePersonaField('ort', e.target.value)} />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.einzug")}</label>
                <select className="select text-sm" value={personaDraft.einzug} onChange={(e) => updatePersonaField('einzug', e.target.value)}>
                  {IS24_MOVE_IN.filter(Boolean).map((o) => <option key={o} value={o}>{o}</option>)}
                  <option value="">—</option>
                </select>
                {personaDraft.einzug === 'genaues Datum' && (
                  <input
                    className="input mt-2 text-sm"
                    type="date"
                    value={personaDraft.einzug_datum || ''}
                    onChange={(e) => updatePersonaField('einzug_datum', e.target.value)}
                  />
                )}
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.personen")}</label>
                <select className="select text-sm" value={personaDraft.personen} onChange={(e) => updatePersonaField('personen', e.target.value)}>
                  {IS24_PERSONS.map((o) => <option key={o} value={o}>{o || '-'}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.haustiere")}</label>
                <select className="select text-sm" value={personaDraft.haustiere} onChange={(e) => updatePersonaField('haustiere', e.target.value)}>
                  {IS24_PETS.map((o) => <option key={o} value={o}>{o || '-'}</option>)}
                </select>
                {personaDraft.haustiere === 'Ja' && (
                  <input
                    className="input mt-2 text-sm"
                    type="text"
                    placeholder={t("settings.personaFields.haustiereZusatz")}
                    value={personaDraft.haustiere_zusatz}
                    onChange={(e) => updatePersonaField('haustiere_zusatz', e.target.value)}
                  />
                )}
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.beschaeftigung")}</label>
                <select className="select text-sm" value={personaDraft.beschaeftigung} onChange={(e) => updatePersonaField('beschaeftigung', e.target.value)}>
                  {IS24_EMPLOYMENT.map((o) => <option key={o} value={o}>{o || '-'}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.einkommen")}</label>
                <select className="select text-sm" value={personaDraft.einkommen} onChange={(e) => updatePersonaField('einkommen', e.target.value)}>
                  {IS24_INCOME.map((o) => <option key={o} value={o}>{o || '-'}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.unterlagen")}</label>
                <select className="select text-sm" value={personaDraft.unterlagen} onChange={(e) => updatePersonaField('unterlagen', e.target.value)}>
                  {IS24_DOCUMENTS.map((o) => <option key={o} value={o}>{o || '-'}</option>)}
                </select>
              </div>
            </div>
            <div className="pt-1">
              <button className="btn btn-primary text-xs" onClick={savePersona}>
                {t('settings.save', 'Save')}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{t('settings.loadingPersona', 'Loading persona…')}</p>
        )}
      </Section>

      {/* ── 2. Message Template ──────────────────────────────────── */}
      <Section title={t("settings.messageTemplate")}>
        <textarea
          className="input resize-y text-sm font-mono leading-6"
          rows={templateRows}
          value={templateDraft}
          onChange={(e) => setTemplateDraft(e.target.value)}
          placeholder={"Sehr geehrte Damen und Herren,\nich interessiere mich für {{title}} in {{address}}...\n\nMit freundlichen Grüßen\n{{name}}"}
        />
        <div className="mt-2 flex gap-2 items-center mb-2">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Variables:</span>
          <code className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--accent)' }}>{'{{title}}'}</code>
          <code className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--accent)' }}>{'{{address}}'}</code>
          <code className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--accent)' }}>{'{{name}}'}</code>
        </div>
        <div className="mt-3 p-3 rounded-lg" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <p className="text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>{t('settings.livePreview', 'Live preview:')}</p>
          {renderPreview(templateDraft, {
            title: 'Schöne 3-Zimmer-Wohnung',
            address: 'Musterstraße 42, 10115 Berlin',
            name: [persona.anrede, persona.vorname, persona.nachname].filter(Boolean).join(' ') || 'Max Mustermann',
          }, t)}
        </div>
        <div className="pt-3">
          <button className="btn btn-primary text-xs" onClick={saveTemplate}>
            {t('settings.save', 'Save')}
          </button>
        </div>
      </Section>

      {/* ── 3. Timing ────────────────────────────────────────────── */}
      <Section title={t("settings.timing")}>
        <div className="flex items-start justify-between">
          <div className="flex gap-4 flex-1">
            <div className="flex-1">
              <label className="text-xs mb-1.5 block" style={{ color: 'var(--text-muted)' }}>{t("settings.speed")}</label>
              <select
                className="select text-sm w-full"
                value={timingDraft.speed}
                onChange={(e) => updateTimingField('speed', e.target.value)}
              >
                <option value="fast">{t("settings.fast")}</option>
                <option value="balanced">{t("settings.balanced")}</option>
                <option value="slow">{t("settings.slow")}</option>
              </select>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                {timingDraft.speed === 'fast' ? t('settings.speedFastDesc', 'Minimum delays, higher captcha risk') : timingDraft.speed === 'slow' ? t('settings.speedSlowDesc', 'Maximum delays, safest') : t('settings.speedBalancedDesc', 'Default balance')}
              </p>
            </div>
            <div className="flex-1">
              <label className="text-xs mb-1.5 block" style={{ color: 'var(--text-muted)' }}>{t("settings.pollInterval")}</label>
              <input
                className="input text-sm w-full"
                type="number"
                min={5}
                step={1}
                value={timingDraft.poll_interval}
                onChange={(e) => updateTimingField('poll_interval', e.target.value)}
              />
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{t('settings.pollIntervalDesc', 'How often to check for new listings')}</p>
            </div>
          </div>
          <div className="flex items-end ml-4" style={{ paddingTop: '1.65rem' }}>
            <button className="btn btn-primary text-xs" onClick={saveTiming}>
              {t('settings.save', 'Save')}
            </button>
          </div>
        </div>
      </Section>

      {/* ── 4. 2captcha API Key ──────────────────────────────────── */}
      <Section title={t("settings.captcha")}>
        <div className="flex items-center gap-3">
          <input
            className="input text-sm flex-1"
            type={showCaptcha ? 'text' : 'password'}
            placeholder={t("settings.placeholder.apiKey")}
            value={captchaDraft}
            onChange={(e) => setCaptchaDraft(e.target.value)}
          />
          <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none" style={{ color: 'var(--text-muted)' }}>
            <input
              type="checkbox"
              checked={showCaptcha}
              onChange={(e) => setShowCaptcha(e.target.checked)}
              className="cursor-pointer"
            />
            {t('settings.showKey', 'Show')}
          </label>
          <button className="btn btn-primary text-xs" onClick={saveCaptcha}>
            {t('settings.save', 'Save')}
          </button>
        </div>
      </Section>

      {/* ── 5. Support Bundle ──────────────────────────────────── */}
      <Section title={t("settings.support")}>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('settings.supportExportDesc', 'Export redacted logs, config, Chrome status, and recent debug screenshots/HTML.')}
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              {t('settings.supportBundlePath', 'Creates a .zip in ~/.homelander/support-bundles, opens the folder, and copies the path.')}
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              {t('settings.sendBundlesTo', 'Send debug bundles to')}{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); window.homelander?.openExternal('mailto:fedurkomykola@gmail.com'); }} style={{ color: 'var(--accent)', textDecoration: 'none', cursor: 'pointer' }} className="hover:underline">
                fedurkomykola@gmail.com
              </a>
            </p>
          </div>
          <button className="btn btn-primary text-xs flex-shrink-0" onClick={handleExportSupportBundle} disabled={supportBusy}>
            {supportBusy ? t('settings.supportExporting', 'Exporting…') : t('settings.supportExport', 'Export Support Bundle')}
          </button>
        </div>
      </Section>

      {/* ── 6. Language ──────────────────────────────────────────── */}
      <Section title={t("settings.language")}>
        <div className="flex items-center gap-2">
          {['de', 'en'].map((lang) => (
            <button
              key={lang}
              className="btn text-xs"
              onClick={() => setLocale(lang)}
              style={{
                background: locale === lang ? 'var(--accent)' : 'var(--bg-tertiary)',
                color: locale === lang ? '#fff' : 'var(--text-secondary)',
                border: locale === lang ? 'none' : '1px solid var(--border)',
                padding: '4px 14px',
                fontWeight: locale === lang ? 600 : 400,
              }}
            >
              {lang === 'en' ? '🇬🇧 English' : '🇩🇪 Deutsch'}
            </button>
          ))}
        </div>
        <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
          {t('setup.changeLater', 'You can change this later in Settings')}
        </p>
      </Section>

      {/* ── 7. Clean All Data ──────────────────────────────────── */}
      <div className="pt-2">
        {cleanupStep === null ? (
          <button className="btn btn-danger text-sm w-full" onClick={handleCleanData}>
            {t('settings.cleanAllData', 'Clean All Data')}
          </button>
        ) : cleanupStep === 'confirm' ? (
          <div className="p-4 rounded-lg" style={{ border: '1px solid var(--danger)', background: 'rgba(239,68,68,0.06)' }}>
            <p className="text-sm mb-3" style={{ color: 'var(--danger)' }}>
              {t('settings.cleanConfirm', 'This will delete all data — listings, config, API keys. Type your email to confirm.')}
            </p>
            <div className="flex items-center gap-3">
              <input
                className="input text-sm flex-1"
                type="email"
                placeholder={config?.persona?.email || 'your@email.com'}
                value={cleanupEmail}
                onChange={(e) => { setCleanupEmail(e.target.value); setCleanupError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmClean(); }}
              />
              <button
                className="btn btn-danger text-xs"
                onClick={handleConfirmClean}
                disabled={cleanupStep === 'purging'}
              >
                {cleanupStep === 'purging' ? t('settings.purging', 'Purging…') : t('settings.continue', 'Continue')}
              </button>
              <button className="btn btn-ghost text-xs" onClick={handleCancelClean}>
                {t('settings.cancel', 'Cancel')}
              </button>
            </div>
            {cleanupError && (
              <p className="text-xs mt-2" style={{ color: 'var(--danger)' }}>{cleanupError}</p>
            )}
          </div>
        ) : (
          <button className="btn btn-danger text-sm w-full" disabled>
            {t('settings.purgingAll', 'Purging all data…')}
          </button>
        )}
      </div>
    </div>
  );
}
