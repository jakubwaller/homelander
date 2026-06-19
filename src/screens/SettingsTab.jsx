// SettingsTab — configuration screen for Homelander.
// Persona, Message Template, Timing, Connections, API keys.

import React, { useState, useEffect } from 'react';
import { useStore } from '../stores/appStore';
import StatusDot from '../components/StatusDot';

// ── Helpers ──────────────────────────────────────────────────────────

function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '*'.repeat(key.length);
  return key.slice(0, 4) + '*'.repeat(key.length - 4);
}

function renderPreview(template, sample) {
  if (!template) return <span className="text-xs" style={{ color: 'var(--text-muted)' }}>No template set.</span>;
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

function Section({ title, action, children }) {
  return (
    <section className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

// ── Main component ──────────────────────────────────────────────────

export default function SettingsTab() {
  const config = useStore((s) => s.config);
  const setConfig = useStore((s) => s.setConfig);
  const chromeStatus = useStore((s) => s.chromeStatus);
  const setChromeStatus = useStore((s) => s.setChromeStatus);

  // Local editing state
  const [editingPersona, setEditingPersona] = useState(false);
  const [personaDraft, setPersonaDraft] = useState(null);
  const [templateDraft, setTemplateDraft] = useState('');
  const [timingDraft, setTimingDraft] = useState({ speed: 'balanced', max_sends_per_run: 10, poll_interval: 600 });
  const [captchaDraft, setCaptchaDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null); // { type: 'success'|'error', msg }

  // Load config into local drafts on mount / config change
  useEffect(() => {
    if (!config) return;
    setTemplateDraft(config.message_template || '');
    setTimingDraft({
      speed: config.timing?.speed || 'balanced',
      max_sends_per_run: config.timing?.max_sends_per_run ?? 10,
      poll_interval: config.polling?.interval_seconds ?? 600,
    });
    setCaptchaDraft(config.captcha?.api_key || '');
  }, [config]);

  // Refresh Chrome status on mount
  useEffect(() => {
    refreshChromeStatus();
  }, []);

  const refreshChromeStatus = async () => {
    if (!window.homelander) return;
    const res = await window.homelander.getChromeStatus();
    if (res && !res.error) {
      setChromeStatus(res.tabCount > 0 ? 'running' : 'stopped');
    }
  };

  const save = async (patch) => {
    if (!window.homelander) {
      setFeedback({ type: 'error', msg: 'No backend connection.' });
      return;
    }
    setSaving(true);
    setFeedback(null);
    const res = await window.homelander.updateConfig(patch);
    if (res?.error) {
      setFeedback({ type: 'error', msg: res.error });
    } else {
      // Re-fetch full config so store is consistent
      const fresh = await window.homelander.getConfig();
      setConfig(fresh);
      setFeedback({ type: 'success', msg: 'Saved.' });
    }
    setSaving(false);
    setTimeout(() => setFeedback(null), 2500);
  };

  // ── Persona handlers ─────────────────────────────────────────────

  const startEditPersona = () => {
    const p = config?.persona || {};
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
      personen: p.personen ?? '',
      haustiere: p.haustiere ?? '',
      beschaeftigung: p.beschaeftigung || '',
      einkommen: p.einkommen ?? '',
      unterlagen: p.unterlagen ?? '',
    });
    setEditingPersona(true);
  };

  const cancelEditPersona = () => {
    setEditingPersona(false);
    setPersonaDraft(null);
  };

  const savePersona = () => {
    save({ persona: personaDraft });
    setEditingPersona(false);
    setPersonaDraft(null);
  };

  const updatePersonaField = (field, value) => {
    setPersonaDraft((prev) => ({ ...prev, [field]: value }));
  };

  // ── Template handlers ────────────────────────────────────────────

  const saveTemplate = () => save({ message_template: templateDraft });

  // ── Timing handlers ──────────────────────────────────────────────

  const saveTimingField = (field, value) => {
    const updated = { ...timingDraft, [field]: value };
    setTimingDraft(updated);

    const patch = {
      timing: { ...config?.timing, [field === 'speed' ? 'speed' : field === 'max_sends_per_run' ? 'max_sends_per_run' : undefined]: value },
      polling: { ...config?.polling },
    };

    if (field === 'speed' || field === 'max_sends_per_run') {
      patch.timing[field] = value;
    }
    if (field === 'poll_interval') {
      patch.polling.interval_seconds = value;
    }

    // Clean undefined
    if (patch.timing.speed === undefined) delete patch.timing.speed;
    if (patch.timing.max_sends_per_run === undefined) {
      patch.timing.max_sends_per_run = config?.timing?.max_sends_per_run ?? 10;
    }

    save(patch);
  };

  // ── Captcha handler ─────────────────────────────────────────────

  const saveCaptcha = () => save({ captcha: { api_key: captchaDraft } });

  // ── Launch Chrome ───────────────────────────────────────────────

  const handleLaunchChrome = async () => {
    if (!window.homelander) return;
    const res = await window.homelander.launchChrome();
    if (res?.error) {
      setFeedback({ type: 'error', msg: res.error });
    } else {
      setChromeStatus('running');
      setFeedback({ type: 'success', msg: 'Chrome launched.' });
    }
    setTimeout(() => setFeedback(null), 2500);
  };

  // ── Quit ────────────────────────────────────────────────────────

  const handleQuit = () => {
    if (window.homelander?.quit) {
      window.homelander.quit();
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
  const hasCaptcha = !!config.captcha?.api_key;

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="space-y-4 pb-8">

      {/* Feedback toast */}
      {feedback && (
        <div
          className="px-4 py-2 rounded-lg text-sm font-medium"
          style={{
            background: feedback.type === 'success' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
            color: feedback.type === 'success' ? 'var(--success)' : 'var(--danger)',
          }}
        >
          {feedback.msg}
        </div>
      )}

      {/* ── 1. Persona ──────────────────────────────────────────── */}
      <Section
        title="Persona"
        action={
          editingPersona ? null : (
            <button className="btn btn-ghost text-xs" onClick={startEditPersona}>
              Edit
            </button>
          )
        }
      >
        {editingPersona && personaDraft ? (
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Anrede</label>
                <select className="select text-sm" value={personaDraft.anrede} onChange={(e) => updatePersonaField('anrede', e.target.value)}>
                  <option value="">-</option>
                  <option value="Herr">Herr</option>
                  <option value="Frau">Frau</option>
                </select>
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Vorname</label>
                <input className="input text-sm" value={personaDraft.vorname} onChange={(e) => updatePersonaField('vorname', e.target.value)} />
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Nachname</label>
                <input className="input text-sm" value={personaDraft.nachname} onChange={(e) => updatePersonaField('nachname', e.target.value)} />
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>E-Mail</label>
                <input className="input text-sm" type="email" value={personaDraft.email} onChange={(e) => updatePersonaField('email', e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Telefon</label>
                <input className="input text-sm" value={personaDraft.telefon} onChange={(e) => updatePersonaField('telefon', e.target.value)} />
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Straße</label>
                <input className="input text-sm" value={personaDraft.strasse} onChange={(e) => updatePersonaField('strasse', e.target.value)} />
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Hausnr.</label>
                <input className="input text-sm" value={personaDraft.hausnummer} onChange={(e) => updatePersonaField('hausnummer', e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>PLZ</label>
                  <input className="input text-sm" value={personaDraft.plz} onChange={(e) => updatePersonaField('plz', e.target.value)} />
                </div>
                <div>
                  <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Ort</label>
                  <input className="input text-sm" value={personaDraft.ort} onChange={(e) => updatePersonaField('ort', e.target.value)} />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Einzug</label>
                <input className="input text-sm" placeholder="z.B. 01.09.2026" value={personaDraft.einzug} onChange={(e) => updatePersonaField('einzug', e.target.value)} />
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Personen</label>
                <input className="input text-sm" type="number" value={personaDraft.personen} onChange={(e) => updatePersonaField('personen', parseInt(e.target.value) || '')} />
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Haustiere</label>
                <input className="input text-sm" placeholder="z.B. 1 Hund" value={personaDraft.haustiere} onChange={(e) => updatePersonaField('haustiere', e.target.value)} />
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Beschäftigung</label>
                <input className="input text-sm" value={personaDraft.beschaeftigung} onChange={(e) => updatePersonaField('beschaeftigung', e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Einkommen (€)</label>
                <input className="input text-sm" type="number" value={personaDraft.einkommen} onChange={(e) => updatePersonaField('einkommen', parseInt(e.target.value) || '')} />
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Unterlagen</label>
                <select className="select text-sm" value={personaDraft.unterlagen} onChange={(e) => updatePersonaField('unterlagen', e.target.value)}>
                  <option value="">-</option>
                  <option value="vorhanden">Vorhanden</option>
                  <option value="teilweise">Teilweise</option>
                  <option value="keine">Keine</option>
                </select>
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button className="btn btn-primary text-xs" onClick={savePersona} disabled={saving}>
                {saving ? 'Saving...' : 'Save Persona'}
              </button>
              <button className="btn btn-ghost text-xs" onClick={cancelEditPersona}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
            <InfoRow label="Name" value={[persona.anrede, persona.vorname, persona.nachname].filter(Boolean).join(' ') || '—'} />
            <InfoRow label="E-Mail" value={persona.email || '—'} />
            <InfoRow label="Telefon" value={persona.telefon || '—'} />
            <InfoRow label="Adresse" value={[persona.strasse, persona.hausnummer, persona.plz, persona.ort].filter(Boolean).join(' ') || '—'} />
            <InfoRow label="Einzug" value={persona.einzug || '—'} />
            <InfoRow label="Personen" value={persona.personen ?? '—'} />
            <InfoRow label="Haustiere" value={persona.haustiere || 'Keine'} />
            <InfoRow label="Beschäftigung" value={persona.beschaeftigung || '—'} />
            <InfoRow label="Einkommen" value={persona.einkommen ? `${persona.einkommen} €` : '—'} />
            <InfoRow label="Unterlagen" value={persona.unterlagen || '—'} />
          </div>
        )}
      </Section>

      {/* ── 2. Message Template ──────────────────────────────────── */}
      <Section title="Message Template">
        <textarea
          className="input min-h-[100px] resize-y text-sm font-mono"
          value={templateDraft}
          onChange={(e) => setTemplateDraft(e.target.value)}
          onBlur={saveTemplate}
          placeholder="Sehr geehrte Damen und Herren,\nich interessiere mich für {{title}} in {{address}}...\n\nMit freundlichen Grüßen\n{{name}}"
        />
        <div className="mt-2 flex gap-2 items-center mb-2">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Variables:</span>
          <code className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--accent)' }}>{'{{title}}'}</code>
          <code className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--accent)' }}>{'{{address}}'}</code>
          <code className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--accent)' }}>{'{{name}}'}</code>
        </div>
        <div className="mt-3 p-3 rounded-lg" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <p className="text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>Live preview:</p>
          {renderPreview(templateDraft, {
            title: 'Schöne 3-Zimmer-Wohnung',
            address: 'Musterstraße 42, 10115 Berlin',
            name: [persona.anrede, persona.vorname, persona.nachname].filter(Boolean).join(' ') || 'Max Mustermann',
          })}
        </div>
      </Section>

      {/* ── 3. Timing ────────────────────────────────────────────── */}
      <Section title="Timing">
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="text-xs mb-1.5 block" style={{ color: 'var(--text-muted)' }}>Speed</label>
            <select
              className="select text-sm"
              value={timingDraft.speed}
              onChange={(e) => saveTimingField('speed', e.target.value)}
            >
              <option value="fast">Fast</option>
              <option value="balanced">Balanced</option>
              <option value="slow">Slow</option>
            </select>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              {timingDraft.speed === 'fast' ? 'Minimum delays, higher captcha risk' : timingDraft.speed === 'slow' ? 'Maximum delays, safest' : 'Default balance'}
            </p>
          </div>
          <div>
            <label className="text-xs mb-1.5 block" style={{ color: 'var(--text-muted)' }}>Max sends per run</label>
            <input
              className="input text-sm"
              type="number"
              min={1}
              value={timingDraft.max_sends_per_run}
              onChange={(e) => saveTimingField('max_sends_per_run', parseInt(e.target.value) || 1)}
            />
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Stops after N applications per cycle</p>
          </div>
          <div>
            <label className="text-xs mb-1.5 block" style={{ color: 'var(--text-muted)' }}>Poll interval (s)</label>
            <input
              className="input text-sm"
              type="number"
              min={60}
              step={30}
              value={timingDraft.poll_interval}
              onChange={(e) => saveTimingField('poll_interval', parseInt(e.target.value) || 60)}
            />
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>How often to check for new listings</p>
          </div>
        </div>
      </Section>

      {/* ── 4. Connections ───────────────────────────────────────── */}
      <Section
        title="Connections"
        action={
          <button className="btn btn-ghost text-xs" onClick={refreshChromeStatus}>
            Refresh
          </button>
        }
      >
        <div className="space-y-2">
          {/* IS24 Mobile API */}
          <div className="flex items-center justify-between py-1.5">
            <div className="flex items-center gap-2">
              <StatusDot status="running" />
              <span className="text-sm">IS24 Mobile API</span>
            </div>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Always reachable from desktop</span>
          </div>

          {/* Chrome CDP */}
          <div className="flex items-center justify-between py-1.5">
            <div className="flex items-center gap-2">
              <StatusDot status={chromeStatus} />
              <span className="text-sm">Chrome CDP</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {chromeStatus === 'running' ? 'Connected' : 'Not connected'}
              </span>
              {chromeStatus !== 'running' && (
                <button className="btn btn-ghost text-xs" onClick={handleLaunchChrome}>
                  Launch
                </button>
              )}
            </div>
          </div>

          {/* 2captcha */}
          <div className="flex items-center justify-between py-1.5">
            <div className="flex items-center gap-2">
              <StatusDot status={hasCaptcha ? 'running' : 'error'} />
              <span className="text-sm">2captcha</span>
            </div>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {hasCaptcha ? 'Configured' : 'Not configured'}
            </span>
          </div>
        </div>
      </Section>

      {/* ── 5. 2captcha API Key ──────────────────────────────────── */}
      <Section title="2captcha API Key">
        <div className="flex items-center gap-3">
          <input
            className="input text-sm flex-1"
            type="password"
            placeholder={hasCaptcha ? maskApiKey(config.captcha?.api_key) : 'Enter your 2captcha API key'}
            value={captchaDraft}
            onChange={(e) => setCaptchaDraft(e.target.value)}
          />
          <button className="btn btn-primary text-xs" onClick={saveCaptcha} disabled={saving || !captchaDraft}>
            {saving ? 'Saving...' : hasCaptcha ? 'Change' : 'Save'}
          </button>
        </div>
        {hasCaptcha && (
          <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
            Key configured: {maskApiKey(config.captcha?.api_key)}
          </p>
        )}
      </Section>

      {/* ── 6. Quit ──────────────────────────────────────────────── */}
      <div className="pt-2">
        <button className="btn btn-danger text-sm w-full" onClick={handleQuit}>
          Quit Homelander
        </button>
      </div>
    </div>
  );
}

// ── Small helper ────────────────────────────────────────────────────

function InfoRow({ label, value }) {
  return (
    <div className="flex justify-between">
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="text-right" style={{ color: 'var(--text-primary)' }}>{value}</span>
    </div>
  );
}
