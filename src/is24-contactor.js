// IS24 contactor — connects to host Chrome via CDP, navigates to listings,
// fills the contact form, and submits. Uses puppeteer-core to drive the
// already-running host Chrome with its real profile and residential IP.
// Debug outputs saved to debug/ (html/, screenshots/).

import puppeteer from 'puppeteer-core';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS24_EXPOSE_URL = 'https://www.immobilienscout24.de/expose';
const DEBUG_DIR = join(__dirname, '..', 'debug');

/** Ensure a debug directory exists, return its path. */
function ensureDir(subdir) {
  const dir = join(DEBUG_DIR, subdir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export const DEBUG = {
  htmlDir: () => ensureDir('html'),
  screenshotDir: () => ensureDir('screenshots'),
};

/**
 * Timing presets for 'fast', 'balanced', and 'slow' modes (all values in ms).
 *
 * Calibration rationale (from IS24 captcha-wall data, June 2026):
 *   very_fast (deleted): 0.3-0.8s cooldown → captcha wall at listing #5
 *   fast: 3-8s cooldown → 4 submissions in ~50-90s. May trigger occasional captcha
 *         after ~8-12 listings; acceptable for speed runs.
 *   balanced: 15-30s cooldown → 4 submissions in ~100-200s. Human pace.
 *             Should avoid the captcha wall entirely; rare captchas only.
 *   slow: 45-90s cooldown → 4 submissions in ~4-7 min. Stealth mode.
 */
const SPEEDS = {
  fast: {
    preSendJitter:   [300, 1000],
    spaRenderWait:   [800, 2000],
    formWaitTimeout:  5000,
    anredeJitter:    [40, 100],
    fieldJitter:     [30, 80],
    textareaJitter:  [50, 150],
    typeDelay:       [8, 25],
    postTypeJitter:  [150, 500],
    cooldown:        [3000, 8000],
  },
  balanced: {
    preSendJitter:   [1000, 3000],
    spaRenderWait:   [1500, 3500],
    formWaitTimeout:  8000,
    anredeJitter:    [80, 200],
    fieldJitter:     [50, 150],
    textareaJitter:  [100, 300],
    typeDelay:       [15, 40],
    postTypeJitter:  [300, 1000],
    cooldown:        [15000, 30000],
  },
  slow: {
    preSendJitter:   [2000, 5000],
    spaRenderWait:   [3000, 6000],
    formWaitTimeout:  10000,
    anredeJitter:    [150, 400],
    fieldJitter:     [100, 300],
    textareaJitter:  [200, 500],
    typeDelay:       [20, 60],
    postTypeJitter:  [500, 1500],
    cooldown:        [45000, 90000],
  },
};

function jitter(min, max) {
  return new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
}

/** Deep-merge timing overrides onto a speed preset. */
function deepMergeTiming(preset, overrides) {
  const merged = { ...preset };
  for (const [key, val] of Object.entries(overrides)) {
    if (val !== undefined && val !== null) merged[key] = val;
  }
  return merged;
}

/**
 * Drive the host's Chrome to auto-apply to IS24 listings.
 */
export class IS24Contactor {
  /** SINGLE source of truth for Suchen+/premium detection. */
  static PREMIUM_RE = /(MieterPlus|Mieter\+|Plus-Mitglied|Premium-Mitglied|Plus Mitgliedschaft|Suchen\+|Suchen Plus|Tarif wählen|Mitgliedschaft wählen|Jetzt Plus|Plus buchen|PLUS-Mitglied|zum PLUS-Mitglied)/i;

  constructor(cdpUrl, contact, speed = 'balanced', timingOverrides = {}, captchaCfg = {}) {
    this.cdpUrl = cdpUrl;
    this.contact = contact;
    this.captchaCfg = captchaCfg;
    const preset = SPEEDS[speed] || SPEEDS.balanced;
    this.t = deepMergeTiming(preset, timingOverrides);
    this.browser = null;
    this.page = null;
  }

  async connect() {
    let versionData;
    try {
      const resp = await fetch(`${this.cdpUrl}/json/version`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      versionData = await resp.json();
    } catch (err) {
      throw new Error(`CDP_FAILED — cannot reach Chrome at ${this.cdpUrl}: ${err.message}`);
    }
    const { webSocketDebuggerUrl } = versionData;
    if (!webSocketDebuggerUrl) throw new Error('CDP /json/version missing webSocketDebuggerUrl');
    this.browser = await puppeteer.connect({
      browserWSEndpoint: webSocketDebuggerUrl,
      defaultViewport: null,
    });
  }

  /**
   * Navigate to an IS24 expose contact form, fill it, and submit.
   * Returns rich metadata for logging.
   */
  async apply(exposeId, message, captchaApiKey) {
    const url = `${IS24_EXPOSE_URL}/${exposeId}#/basicContact/email`;
    const tStart = Date.now();
    const timing = {};
    const captcha = { detected: false, solved: false, attempts: 0, solutions: [] };
    let formState = 'unknown';
    let fieldCount = 0;
    let fieldRetries = 0;

    this.page = await this.browser.newPage();
    this._captchaAttempts = 0;

    try {
      const tGoto = Date.now();
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      timing.goto_ms = Date.now() - tGoto;

      await jitter(...this.t.spaRenderWait);

      const tForm = Date.now();
      const formReady = await this._waitForForm(this.t.formWaitTimeout);
      timing.form_wait_ms = Date.now() - tForm;

      if (!formReady) {
        const premium = await this._isPremiumListing();
        formState = premium ? 'premium_upsell' : 'no_form';
        const ssDir = DEBUG.screenshotDir();
        await this.page.screenshot({ path: join(ssDir, `${exposeId}_${formState}.png`), fullPage: true });
        this.page = null;
        return {
          success: false, reason: premium
            ? 'SUBMIT_FAILED (PREMIUM_ONLY — Plus listing, cannot contact without subscription)'
            : 'NO_FORM (contact form not found)',
          timing_ms: Date.now() - tStart, timing, captcha, form_state: formState,
          fields_typed: 0, field_retries: 0,
        };
      }

      const tFill = Date.now();
      const fillResult = await this._fillForm(message);
      timing.fill_ms = Date.now() - tFill;
      fieldCount = fillResult.filled;
      fieldRetries = fillResult.retries;

      await this._clickAbschicken();

      const tVerify = Date.now();
      const { verified, detail } = await this._verifySubmission(exposeId, captcha);
      timing.verify_ms = Date.now() - tVerify;

      // Dump page HTML AFTER verification
      if (this.page) {
        try {
          const html = await this.page.content();
          const htmlDir = DEBUG.htmlDir();
          const outcomeTag = verified ? 'SENT' : (detail.includes('captcha') ? 'CAPTCHA_FAIL' : 'FAIL');
          writeFileSync(join(htmlDir, `${exposeId}_${outcomeTag}.html`), html, 'utf8');
        } catch {}
      }

      formState = verified ? 'confirmed' : (detail.includes('captcha') ? 'captcha_fail' : detail.substring(0, 40));

      if (!verified) {
        const ssDir = DEBUG.screenshotDir();
        try { await this.page?.screenshot({ path: join(ssDir, `${exposeId}_submit_failed.png`), fullPage: true }); } catch {}
        this.page = null;
        return {
          success: false, reason: `SUBMIT_FAILED (${detail})`,
          timing_ms: Date.now() - tStart, timing, captcha, form_state: formState,
          fields_typed: fieldCount, field_retries: fieldRetries,
        };
      }

      this.page = null;
      return {
        success: true, detail,
        timing_ms: Date.now() - tStart, timing, captcha, form_state: formState,
        fields_typed: fieldCount, field_retries: fieldRetries,
      };
    } catch (err) {
      formState = 'error';
      const ssDir = DEBUG.screenshotDir();
      try { await this.page?.screenshot({ path: join(ssDir, `${exposeId}_error.png`), fullPage: true }); } catch {}
      this.page = null;
      return {
        success: false, reason: `ERROR: ${err.message}`,
        timing_ms: Date.now() - tStart, timing, captcha, form_state: formState,
        fields_typed: fieldCount, field_retries: fieldRetries,
      };
    }
  }

  async _isBlocked() {
    try {
      const title = await this.page.title();
      if (/Roboter|Sicherheitsprüfung|Sicherheitsabfrage/i.test(title)) return true;
      const bodyText = await this.page.evaluate(() => document.body ? document.body.innerText : '');
      return /(Ich bin kein Roboter|Sicherheitsabfrage|Zeichen aus dem Bild eingeben|Sicherheitsprüfung bestanden)/i.test(bodyText);
    } catch { return false; }
  }

  async _isPremiumListing() {
    try {
      return await this.page.evaluate(() => {
        const text = document.body?.innerText || '';
        return /(MieterPlus|Mieter\+|Plus-Mitglied|Premium-Mitglied|Plus Mitgliedschaft|Suchen\+|Suchen Plus|Tarif wählen|Mitgliedschaft wählen|Jetzt Plus|Plus buchen|PLUS-Mitglied|zum PLUS-Mitglied)/i.test(text);
      });
    } catch { return false; }
  }

  async _waitForForm(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await this.page.evaluate(() => {
        const ta = document.querySelector('textarea[name="message"]');
        const fn = document.querySelector('input[name="firstName"]');
        return !!(ta && fn);
      });
      if (found) return true;
      await jitter(500, 1500);
    }
    return false;
  }

  async _dismissOverlays() {
    try {
      await this.page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
          const text = btn.textContent?.trim() || '';
          if (/alle.*akzeptieren|akzeptieren.*alle|alles.*erlauben|zustimmen/i.test(text)) { btn.click(); return; }
        }
        for (const btn of btns) {
          const text = btn.textContent?.trim() || '';
          if (/speichern|auswählen|bestätigen/i.test(text) && btn.offsetParent) { btn.click(); return; }
        }
      });
      await jitter(1000, 2000);
    } catch {}
  }

  async _fillForm(message) {
    await this._dismissOverlays();
    let filled = 0;
    let retries = 0;

    // Inject select helpers
    await this.page.evaluate(() => {
      window.__setSelect = function (sel, text) {
        const el = document.querySelector(sel);
        if (!el) return;
        for (const o of el.options) {
          if (o.textContent.trim() === text || o.value === text) {
            el.value = o.value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }
      };
      window.__getSelectText = function (sel) {
        const el = document.querySelector(sel);
        if (!el) return null;
        return el.options[el.selectedIndex]?.textContent?.trim() || null;
      };
      window.__clearInput = function (sel) {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.focus();
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(el, '');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
        return true;
      };
    });

    // Anrede
    const targetAnrede = this.contact.anrede || 'Frau';
    const currentAnrede = await this.page.evaluate(() => window.__getSelectText('select[name="salutation"]'));
    if (!currentAnrede || currentAnrede !== targetAnrede) {
      await this.page.evaluate((a) => window.__setSelect('select[name="salutation"]', a), targetAnrede);
      await jitter(...this.t.anredeJitter);
    }

    const dropdowns = [
      ['select[name="moveInDateType"]', this.contact.einzug],
      ['select[name="numberOfPersons"]', this.contact.personen],
      ['select[name="hasPets"]', this.contact.haustiere],
      ['select[name="employmentRelationship"]', this.contact.beschaeftigung],
      ['select[name="income"]', this.contact.einkommen],
      ['select[name="applicationPackageCompleted"]', this.contact.unterlagen],
    ];
    for (const [sel, val] of dropdowns) {
      if (!val) continue;
      const current = await this.page.evaluate((s) => window.__getSelectText(s), sel);
      if (current === val) continue;
      await this.page.evaluate(({ s, v }) => window.__setSelect(s, v), { s: sel, v: val });
      await jitter(...this.t.anredeJitter);
    }

    // Text inputs — only stringify non-undefined values (never "undefined" in the DOM)
    const fields = [
      { sel: 'input[name="firstName"]', val: this.contact.vorname },
      { sel: 'input[name="lastName"]', val: this.contact.nachname },
      { sel: 'input[name="emailAddress"]', val: this.contact.email },
      { sel: 'input[name="phoneNumber"]', val: this.contact.telefon },
      { sel: 'input[name="street"]', val: this.contact.strasse },
      { sel: 'input[name="houseNumber"]', val: this.contact.hausnummer != null ? String(this.contact.hausnummer) : '' },
      { sel: 'input[name="postcode"]', val: this.contact.plz != null ? String(this.contact.plz) : '' },
      { sel: 'input[name="city"]', val: this.contact.ort },
    ];

    for (const { sel, val } of fields) {
      if (!val) continue;
      const elState = await this.page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        return { disabled: el.disabled, value: el.value || '' };
      }, sel);
      if (!elState) continue;

      // Disabled field (IS24 pre-fills + locks e.g. email) — skip if correct, native-set if wrong
      if (elState.disabled) {
        if (elState.value === val) { filled++; continue; }
        await this.page.evaluate(({ s, v }) => {
          const el = document.querySelector(s);
          if (!el) return;
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(el, v);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
        }, { s: sel, v: val });
        await jitter(100, 200);
        retries++;
        filled++;
        continue;
      }

      await this.page.evaluate((s) => window.__clearInput(s), sel);
      await jitter(...this.t.fieldJitter);
      await this.page.click(sel);
      await jitter(50, 150);

      const kbdDelay = Array.isArray(this.t.typeDelay)
        ? this.t.typeDelay[0] + Math.random() * (this.t.typeDelay[1] - this.t.typeDelay[0])
        : this.t.typeDelay;
      await this.page.keyboard.type(val, { delay: Math.round(kbdDelay) });

      await jitter(100, 200);
      const actual = await this.page.evaluate((s) => document.querySelector(s)?.value || null, sel);
      if (actual !== val) {
        await this.page.evaluate(({ s, v }) => {
          const el = document.querySelector(s);
          if (!el) return;
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(el, '');
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
          requestAnimationFrame(() => {
            nativeSetter.call(el, v);
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
          });
        }, { s: sel, v: val });
        await jitter(200, 400);
        retries++;
      }
      filled++;
    }

    // Message textarea
    const textareaSel = 'textarea[name="message"]';
    const currentMsg = await this.page.evaluate((s) => document.querySelector(s)?.value || '', textareaSel);

    if (currentMsg && currentMsg.length > 0) {
      await this.page.click(textareaSel);
      await jitter(100, 200);
      await this.page.keyboard.down('Meta');
      await this.page.keyboard.press('KeyA');
      await this.page.keyboard.up('Meta');
      await jitter(80, 150);
      await this.page.keyboard.press('Backspace');
      await jitter(150, 300);
    } else {
      await this.page.click(textareaSel);
      await jitter(100, 200);
    }

    const kbdDelay = Array.isArray(this.t.typeDelay)
      ? this.t.typeDelay[0] + Math.random() * (this.t.typeDelay[1] - this.t.typeDelay[0])
      : this.t.typeDelay;
    await this.page.keyboard.type(message, { delay: Math.round(kbdDelay) });
    await jitter(200, 400);

    const actualMsg = await this.page.evaluate((s) => document.querySelector(s)?.value || '', textareaSel);
    if (actualMsg !== message) {
      await this.page.evaluate(({ sel, msg }) => {
        const el = document.querySelector(sel);
        if (!el) return;
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeSetter.call(el, '');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
        return new Promise((resolve) => {
          requestAnimationFrame(() => {
            nativeSetter.call(el, msg);
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
            resolve(true);
          });
        });
      }, { sel: textareaSel, msg: message });
      await jitter(200, 400);
      retries++;
    }

    // Final verify: IS24 auto-fill can asynchronously revert fields after the bot types.
    // Re-check every field and native-set any that lost their value.
    for (const { sel, val } of fields) {
      if (!val) continue;
      const actual = await this.page.evaluate((s) => document.querySelector(s)?.value || '', sel);
      if (actual !== val) {
        await this.page.evaluate(({ s, v }) => {
          const el = document.querySelector(s);
          if (!el) return;
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(el, v);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
        }, { s: sel, v: val });
        await jitter(100, 200);
        retries++;
      }
    }

    return { filled, retries };
  }

  async _clickAbschicken() {
    await this.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const btn = buttons.find((b) => b.textContent.includes('Abschicken'));
      if (btn) btn.click();
    });
  }

  async _verifySubmission(exposeId, captchaStats = {}) {
    await jitter(1500, 2500);
    let deadline = Date.now() + 5_000;
    let captchaRetries = 0;
    let serverRetries = 0;
    let deadlineExtended = false;

    while (Date.now() < deadline) {
      const state = await this.page.evaluate(() => {
        const allText = document.body?.innerText || '';
        const msg = document.querySelector('textarea[name="message"]');
        const confirmed = document.querySelector('[class*="StatusMessage_status-confirm"]') !== null;
        return {
          confirmed,
          formGone: !msg,
          captcha: /Roboter|Sicherheitsprüfung|Sicherheitsabfrage/i.test(allText),
          serverError: /Es ist ein Fehler aufgetreten/i.test(allText),
          premium: /(MieterPlus|Mieter\+|Plus-Mitglied|Premium-Mitglied|Plus Mitgliedschaft|Suchen\+|Suchen Plus|Tarif wählen|Mitgliedschaft wählen|Jetzt Plus|Plus buchen|PLUS-Mitglied|zum PLUS-Mitglied)/i.test(allText),
          hasErrors: (() => {
            const errs = document.querySelectorAll('[class*="error"], [class*="invalid"], [aria-invalid="true"]');
            return errs.length > 0;
          })(),
          validationText: /(Bitte füllen|Pflichtfeld|fehlerhaft|korrigieren|benötigt)/i.test(allText),
          errorText: (() => {
            const el = document.querySelector('[class*="StatusMessage_status-error"]');
            return el ? el.textContent?.trim() : null;
          })(),
        };
      });

      if (state.confirmed) return { verified: true, detail: 'confirmed (modal)', captcha_retries: captchaRetries, server_retries: serverRetries, deadline_extended: deadlineExtended };

      if (state.captcha) {
        captchaStats.detected = true;
        captchaRetries++;
        captchaStats.attempts = captchaRetries;
        const solved = await this._solveCaptcha(captchaStats);
        if (solved) {
          deadline = Date.now() + 5_000;
          deadlineExtended = true;
          await jitter(800, 1500);
          continue;
        }
        return { verified: false, detail: 'captcha (unsolved)', captcha_retries: captchaRetries, server_retries: serverRetries, deadline_extended: deadlineExtended, error_text: state.errorText };
      }

      if (state.premium && state.formGone) return { verified: false, detail: 'premium upsell (Suchen+)', captcha_retries: captchaRetries, server_retries: serverRetries, deadline_extended: deadlineExtended, error_text: state.errorText };

      if (state.serverError) {
        if (state.premium && state.formGone) return { verified: false, detail: 'premium upsell (Suchen+)', captcha_retries: captchaRetries, server_retries: serverRetries, deadline_extended: deadlineExtended, error_text: state.errorText };
        if (state.formGone) return { verified: false, detail: `server error (account blocked?): ${state.errorText || 'unknown'}`, captcha_retries: captchaRetries, server_retries: serverRetries, deadline_extended: deadlineExtended, error_text: state.errorText };
        serverRetries++;
        await jitter(2000, 4000);
        continue;
      }

      if (state.hasErrors || state.validationText) {
        return { verified: false, detail: `validation errors${state.errorText ? ': ' + state.errorText : ''}`, captcha_retries: captchaRetries, server_retries: serverRetries, deadline_extended: deadlineExtended, error_text: state.errorText };
      }

      if (state.formGone) {
        await jitter(1200, 1800);
        continue;
      }

      await jitter(800, 1200);
    }

    // Deadline fallback
    const formGone = await this.page.evaluate(() => !document.querySelector('textarea[name="message"]'));
    const bodyText = await this.page.evaluate(() => document.body?.innerText || '');
    const isPremium = IS24Contactor.PREMIUM_RE.test(bodyText);
    const isServerError = /Es ist ein Fehler aufgetreten/i.test(bodyText);

    if (formGone && isPremium) return { verified: false, detail: 'premium upsell (Suchen+)', captcha_retries: captchaRetries, server_retries: serverRetries, deadline_extended: deadlineExtended };
    if (formGone) return { verified: true, detail: 'form removed (modal dismissed)', captcha_retries: captchaRetries, server_retries: serverRetries, deadline_extended: deadlineExtended };
    if (isServerError && !formGone) return { verified: false, detail: 'server error (premium gate?)', captcha_retries: captchaRetries, server_retries: serverRetries, deadline_extended: deadlineExtended };
    return { verified: false, detail: 'no confirmation after 5s', captcha_retries: captchaRetries, server_retries: serverRetries, deadline_extended: deadlineExtended };
  }

  async _solveCaptcha(captchaStats) {
    this._captchaAttempts = (this._captchaAttempts || 0) + 1;
    if (this._captchaAttempts > 3) return false;

    const apiKey = this.captchaCfg?.api_key;
    const solverUrl = this.captchaCfg?.solver_url;
    if (!apiKey && !solverUrl) return false;

    try {
      const imgData = await this.page.evaluate(() => {
        const img = document.querySelector('.captcha-image-container img');
        if (!img) return null;
        if (!img.complete || img.naturalWidth === 0) return { loading: true };
        return { src: img.src, loading: false };
      });

      if (!imgData) return false;

      if (imgData.loading) {
        const dl = Date.now() + 15_000;
        let loaded = false;
        while (Date.now() < dl) {
          await new Promise(r => setTimeout(r, 500));
          loaded = await this.page.evaluate(() => {
            const img = document.querySelector('.captcha-image-container img');
            if (!img) return false;
            return img.complete && img.naturalWidth > 0;
          });
          if (loaded) break;
        }
        if (!loaded) return false;
      }

      const screenshot = await this.page.evaluate(async () => {
        const img = document.querySelector('.captcha-image-container img');
        if (!img) return null;
        const resp = await fetch(img.src);
        const blob = await resp.blob();
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(blob);
        });
      });
      if (!screenshot) return false;

      let solution;
      if (apiKey) {
        solution = await this._solveWith2captcha(screenshot, apiKey, captchaStats);
      } else {
        solution = await this._solveWithOcr(screenshot, solverUrl);
      }

      if (!solution || solution.length < 2 || solution.length > 8) return false;

      captchaStats.solved = true;
      if (!captchaStats.solutions) captchaStats.solutions = [];
      captchaStats.solutions.push(solution);

      // Guard: captcha modal may have been dismissed while solving
      const inputStillThere = await this.page.evaluate(() => !!document.querySelector('#userAnswer'));
      if (!inputStillThere) {
        const succeeded = await this.page.evaluate(() =>
          !!document.querySelector('[class*="StatusMessage_status-confirm"]')
        );
        return !!succeeded;
      }

      await this.page.click('#userAnswer');
      await jitter(100, 300);
      await this.page.evaluate(() => { document.querySelector('#userAnswer').value = ''; });
      await this.page.type('#userAnswer', solution, { delay: 30 });
      await jitter(300, 600);
      await this.page.click('[data-testid="contact-form"] button[type="submit"]');
      return true;
    } catch (e) {
      try {
        const succeeded = await this.page.evaluate(() =>
          !!document.querySelector('[class*="StatusMessage_status-confirm"]')
        );
        if (succeeded) { captchaStats.solved = true; return true; }
      } catch {}
      return false;
    }
  }

  async _solveWith2captcha(screenshot, apiKey, captchaStats) {
    const tSolve = Date.now();
    const taskResp = await fetch('https://api.2captcha.com/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: apiKey,
        task: { type: 'ImageToTextTask', body: screenshot, case: false, numeric: 0 }
      })
    });

    const task = await taskResp.json();
    if (task.errorId !== 0) return null;

    captchaStats.taskId = task.taskId;
    captchaStats.task_ids = captchaStats.task_ids || [];
    captchaStats.task_ids.push(task.taskId);

    const dl = Date.now() + 30_000;
    while (Date.now() < dl) {
      await new Promise(r => setTimeout(r, 2000));
      const resp = await fetch('https://api.2captcha.com/getTaskResult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, taskId: task.taskId })
      });
      const result = await resp.json();
      if (result.status === 'ready') {
        captchaStats.solve_ms = (captchaStats.solve_ms || 0) + (Date.now() - tSolve);
        return result.solution.text.trim();
      }
      if (result.errorId !== 0) return null;
    }
    return null;
  }

  async _solveWithOcr(screenshot, solverUrl) {
    try {
      const resp = await fetch(solverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: screenshot })
      });
      const result = await resp.json();
      if (result.error) return null;
      return result.text;
    } catch { return null; }
  }

  async disconnect() {
    try { if (this.page) await this.page.close(); } catch {}
    try { if (this.browser) await this.browser.disconnect(); } catch {}
    this.browser = null;
    this.page = null;
  }
}
