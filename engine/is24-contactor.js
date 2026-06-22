// IS24 contactor — connects to host Chrome via CDP, navigates to listings,
// fills the contact form, and submits. Uses Puppeteer over CDP to drive
// Homelander's bundled Chromium profile.
// Debug outputs saved to debug/ (html/, screenshots/).

import puppeteer from 'puppeteer';
import { mkdirSync, existsSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS24_EXPOSE_URL = 'https://www.immobilienscout24.de/expose';
const DEBUG_DIR = process.env.HOMELANDER_DEBUG_DIR || join(__dirname, '..', 'debug');
const DEFAULT_WINDOW = { windowState: 'normal', left: 80, top: 60, width: 1200, height: 850 };

/** Ensure a debug directory exists, return its path. */
function ensureDir(subdir) {
  const dir = join(DEBUG_DIR, subdir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export const DEBUG = {
  htmlDir: () => ensureDir('html'),
  screenshotDir: () => ensureDir('screenshots'),

  /** Prune debug artifacts — keep only the N most recent files in each subdir. */
  prune(maxFiles = 50) {
    for (const getDir of [this.htmlDir, this.screenshotDir]) {
      try {
        const dir = getDir();
        const files = readdirSync(dir)
          .map(name => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }))
          .sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (const f of files.slice(maxFiles)) {
          try { unlinkSync(join(dir, f.name)); } catch {}
        }
      } catch {}
    }
  },
};
/** Logged-catch replacement for bare catch {} — never throws, always logs. */
function swallow(err, context, logFn = console.error) {
  try { logFn(`[swallow] ${context}: ${err?.message || err}`); } catch {}
}


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
  if (process.env.HOMELANDER_TEST_FAST === '1') return Promise.resolve();
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
  /**
   * Broad Plus words appear in normal IS24 chrome/marketing, so they are NOT enough.
   * Premium detection must find an actual visible gate/CTA, never generic page text.
   */
  static PLUS_TEXT_RE = /(MieterPlus|Mieter\+|Plus-Mitglied|Premium-Mitglied|Plus Mitgliedschaft|Suchen\+|Suchen Plus)/i;
  static PLUS_GATE_RE = /(Tarif wählen|Mitgliedschaft wählen|Jetzt Plus|Plus buchen|PLUS-Mitglied werden|zum PLUS-Mitglied|Kontakt nur|nur mit .{0,30}Plus|exklusiv .{0,30}Plus|Plus .{0,30}kontaktieren)/i;

  constructor(cdpUrl, contact, speed = 'balanced', timingOverrides = {}, captchaCfg = {}) {
    this.cdpUrl = cdpUrl;
    this.contact = contact;
    this.captchaCfg = captchaCfg;
    const preset = SPEEDS[speed] || SPEEDS.balanced;
    this.t = deepMergeTiming(preset, timingOverrides);
    this.browser = null;
    this.page = null;
  }

  /** Hot-reload persona fields without restarting the daemon. */
  updateContact(persona) {
    this.contact = persona;
  }

  /** Hot-reload timing speed/overrides without restarting. */
  updateTiming(speed, overrides = {}) {
    const preset = SPEEDS[speed] || SPEEDS.balanced;
    this.t = deepMergeTiming(preset, overrides);
  }

  /** Hot-reload captcha config without restarting. */
  updateCaptcha(captchaCfg) {
    this.captchaCfg = captchaCfg;
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
    // Pre-create one persistent background page for all applies.
    // Reusing it avoids the OS-level app activation that newPage() triggers.
    await this._ensurePage();
  }

  /** Get or create the single persistent background page. */
  async _ensurePage() {
    if (this.page && !this.page.isClosed()) return this.page;
    this.page = await this.browser.newPage();
    // Use default window position — no off-screen shenanigans
    await this._setWindowBounds(this.page);
    // newPage() already returns a page at about:blank — no navigation needed.
    return this.page;
  }

  /**
   * Navigate the persistent page to a URL without triggering Chromium's
   * window activation (which page.goto() causes via CDP in Electron 42).
   *
   * Uses in-page window.location assignment + waitForNavigation instead
   * of the CDP Page.navigate command that page.goto() delegates to.
   */
  async _navigate(url, { timeout = 20000 } = {}) {
    // navigate to about:blank from about:blank is a no-op
    if (url === 'about:blank' && this.page?.url() === 'about:blank') return;
    const nav = this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout });
    await this.page.evaluate((u) => { window.location.href = u; }, url);
    await nav;
  }

  /** Position a page's Chromium window at default coords via CDP. */
  async _setWindowBounds(page) {
    if (!page) return;
    try {
      const session = await page.target().createCDPSession();
      try {
        const { windowId } = await session.send('Browser.getWindowForTarget');
        await session.send('Browser.setWindowBounds', { windowId, bounds: DEFAULT_WINDOW });
      } finally {
        await session.detach().catch((err) => { swallow(err, 'CDP/session-detach'); });
      }
    } catch (err) { swallow(err, 'CDP/restore-window'); }
  }

  /**
   * Navigate to an IS24 expose contact form, fill it, and submit.
   * Returns rich metadata for logging.
   */
  async apply(exposeId, message, captchaApiKey, maxTabs = 5) {
    const url = `${IS24_EXPOSE_URL}/${exposeId}#/basicContact/email`;
    const tStart = Date.now();
    const timing = {};
    const captcha = { detected: false, solved: false, attempts: 0, solutions: [] };
    let formState = 'unknown';
    let fieldCount = 0;
    let fieldRetries = 0;

    this.page = await this._ensurePage();
    this._captchaAttempts = 0;

    try {
      const tGoto = Date.now();
      await this._navigate(url);
      timing.goto_ms = Date.now() - tGoto;

      await jitter(...this.t.spaRenderWait);

      // Check IS24.expose.userLoggedIn on the freshly loaded page
      try {
        const loggedIn = await this.page.evaluate(() => {
          const flag = (window.IS24 && window.IS24.expose && window.IS24.expose.userLoggedIn);
          return typeof flag === 'boolean' ? flag : null;
        });
        if (loggedIn === false) {
          const ssDir = DEBUG.screenshotDir();
          try { await this.page.screenshot({ path: join(ssDir, `${exposeId}_session_expired.png`), fullPage: true }); } catch (err) { swallow(err, 'screenshot/session_expired'); }
          return {
            success: false, reason: 'SESSION_EXPIRED (IS24 login required — re-login via Settings)',
            timing_ms: Date.now() - tStart, timing, captcha, form_state: 'session_expired',
            fields_typed: 0, field_retries: 0,
          };
        }
      } catch (err) { swallow(err, 'apply/session-expiry-url-check'); }

      // Detect session expiry: IS24 redirects unauthenticated users to login
      try {
        const currentUrl = this.page.url();
        const isLoginRedirect = currentUrl.includes('/login')
          || currentUrl.includes('/registrierung')
          || currentUrl.includes('sso.immobilienscout24');
        if (isLoginRedirect || !currentUrl.includes(exposeId)) {
          const ssDir = DEBUG.screenshotDir();
          try { await this.page.screenshot({ path: join(ssDir, `${exposeId}_session_expired.png`), fullPage: true }); } catch (err) { swallow(err, 'screenshot/session_expired'); }
          return {
            success: false, reason: 'SESSION_EXPIRED (IS24 login required — re-login via Settings)',
            timing_ms: Date.now() - tStart, timing, captcha, form_state: 'session_expired',
            fields_typed: 0, field_retries: 0,
          };
        }
      } catch (err) { swallow(err, 'apply/loggedout-session-check'); }

      const loggedOutSession = await this._isLoggedOutSession();
      if (loggedOutSession) {
        const ssDir = DEBUG.screenshotDir();
        try { await this.page.screenshot({ path: join(ssDir, `${exposeId}_session_expired.png`), fullPage: true }); } catch (err) { swallow(err, 'screenshot/session_expired'); }
        return {
          success: false, reason: 'SESSION_EXPIRED (IS24 login required — re-login via Settings)',
          timing_ms: Date.now() - tStart, timing, captcha, form_state: 'session_expired',
          fields_typed: 0, field_retries: 0,
        };
      }

      // Detect deactivated listing before trying to find form
      const isDeactivated = await this._isDeactivated();
      if (isDeactivated) {
        const ssDir = DEBUG.screenshotDir();
        try { await this.page.screenshot({ path: join(ssDir, `${exposeId}_deactivated.png`), fullPage: true }); } catch (err) { swallow(err, 'screenshot/deactivated'); }
        return {
          success: false, reason: 'DEACTIVATED (listing no longer available)',
          timing_ms: Date.now() - tStart, timing, captcha, form_state: 'deactivated',
          fields_typed: 0, field_retries: 0,
        };
      }

      const tForm = Date.now();
      await this._openContactFormIfNeeded();
      const formReady = await this._waitForForm(this.t.formWaitTimeout);
      timing.form_wait_ms = Date.now() - tForm;

      if (!formReady) {
        const premium = await this._isPremiumListing();
        formState = premium ? 'premium_upsell' : 'no_form';
        const ssDir = DEBUG.screenshotDir();
        await this.page.screenshot({ path: join(ssDir, `${exposeId}_${formState}.png`), fullPage: true });
        return {
          success: false, reason: premium
            ? 'PREMIUM_ONLY (Nachricht opened a Plus/Suchen+ upsell instead of the contact form)'
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

      let formStillOpen = await this._isContactFormOpen();
      if (!formStillOpen) {
        // Some IS24 variants close/return to the expose page during SPA transitions.
        // If a visible "Nachricht" contact button is present, reopen, refill once, then submit.
        const reopened = await this._openContactFormIfNeeded();
        if (reopened && await this._waitForForm(Math.min(this.t.formWaitTimeout, 10_000))) {
          const refillResult = await this._fillForm(message);
          fieldCount += refillResult.filled;
          fieldRetries += refillResult.retries;
          formStillOpen = await this._isContactFormOpen();
        }
      }
      if (!formStillOpen) {
        const ssDir = DEBUG.screenshotDir();
        try { await this.page?.screenshot({ path: join(ssDir, `${exposeId}_form_closed_before_submit.png`), fullPage: true }); } catch (err) { swallow(err, 'screenshot/form_closed'); }
        return {
          success: false, reason: 'SUBMIT_FAILED (contact form closed before submit)',
          timing_ms: Date.now() - tStart, timing, captcha, form_state: 'form_closed_before_submit',
          fields_typed: fieldCount, field_retries: fieldRetries,
        };
      }

      await this._clickAbschicken();

      const tVerify = Date.now();
      const { verified, detail } = await this._verifySubmission(exposeId, captcha);
      timing.verify_ms = Date.now() - tVerify;

      // Dump page HTML AFTER verification (strip form values for privacy)
      // Only when HOMELANDER_DEBUG_HTML=1 (off by default — 4 MB per apply)
      try {
        if (process.env.HOMELANDER_DEBUG_HTML === '1') {
          let html = await this.page.content();
          // Strip PII: remove input values and textarea contents
          html = html.replace(/\svalue="[^"]*"/gi, ' value=""');
          html = html.replace(/\svalue='[^']*'/gi, " value=''");
          html = html.replace(/(<textarea[^>]*>)[\s\S]*?(<\/textarea>)/gi, '$1$2');
          const htmlDir = DEBUG.htmlDir();
          const outcomeTag = verified ? 'SENT' : (detail.includes('captcha') ? 'CAPTCHA_FAIL' : 'FAIL');
          writeFileSync(join(htmlDir, `${exposeId}_${outcomeTag}.html`), html, 'utf8');
        }
      } catch (err) { swallow(err, 'debug/write-html'); }

      formState = verified ? 'confirmed' : (detail.includes('captcha') ? 'captcha_fail' : detail.substring(0, 40));

      if (!verified) {
        const ssDir = DEBUG.screenshotDir();
        try { await this.page?.screenshot({ path: join(ssDir, `${exposeId}_submit_failed.png`), fullPage: true }); } catch (err) { swallow(err, 'screenshot/submit_failed'); }
        return {
          success: false, reason: `SUBMIT_FAILED (${detail})`,
          timing_ms: Date.now() - tStart, timing, captcha, form_state: formState,
          fields_typed: fieldCount, field_retries: fieldRetries,
        };
      }

      return {
        success: true, detail,
        timing_ms: Date.now() - tStart, timing, captcha, form_state: formState,
        fields_typed: fieldCount, field_retries: fieldRetries,
      };
    } catch (err) {
      formState = 'error';
      const ssDir = DEBUG.screenshotDir();
      try { await this.page?.screenshot({ path: join(ssDir, `${exposeId}_error.png`), fullPage: true }); } catch (err) { swallow(err, 'screenshot/error'); }
      return {
        success: false, reason: `ERROR: ${err.message}`,
        timing_ms: Date.now() - tStart, timing, captcha, form_state: formState,
        fields_typed: fieldCount, field_retries: fieldRetries,
      };
    } finally {
      // Keep the persistent page alive — blank it for the next apply.
      // Closing it would force a newPage() which activates Chromium.
      try {
        if (this.page && !this.page.isClosed() && this.browser?.isConnected()) {
          await this._navigate('about:blank', { timeout: 5000 }).catch((err) => { swallow(err, 'page/navigate-about-blank'); });
        }
      } catch (err) { swallow(err, 'apply/about-blank-cleanup'); }
    }
  }

  async _isLoggedOutSession() {
    try {
      return await this.page.evaluate(() => {
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        // Real session expiry redirects to /login or sso.immobilienscout24.
        // "Anmelden" text on an expose page is usually a Plus-membership upsell.
        const urlShowsLogin = window.location.href.includes('/login')
          || window.location.href.includes('/registrierung')
          || window.location.href.includes('sso.immobilienscout24');
        if (!urlShowsLogin) return false;
        return Array.from(document.querySelectorAll('a, button'))
          .filter(visible)
          .some((el) => /^\s*(Anmelden|Jetzt einloggen|Einloggen)\s*$/i.test(el.textContent || ''));
      });
    } catch { return false; }
  }

  /** Check whether the IS24 header on the current page indicates the user is logged in. */
  async checkIS24Login() {
    try {
      return await this.page.evaluate(() => {
        // 1. IS24's own JS flag — reliable on expose pages
        const flag = (window.IS24 && window.IS24.expose && window.IS24.expose.userLoggedIn);
        if (typeof flag === 'boolean') return flag;

        // 2. Check .sso-login header text — works on homepage, search, every IS24 page
        const wrapper = document.querySelector('.sso-login');
        if (wrapper) {
          const text = wrapper.innerText || '';
          // "angemeldet als <email>" = logged in
          if (/angemeldet\s+als/i.test(text)) return true;
          // "Anmelden" as a visible link = logged out
          if (/\bAnmelden\b/.test(text)) return false;
        }

        // 3. Fallback: scan full page text
        const bodyText = document.body?.innerText || '';
        const loggedInRe = /angemeldet\s+als|zu\s+meinem\s+Bereich|Mein\s*Konto|Abmelden/i;
        const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
        return loggedInRe.test(bodyText) && emailRe.test(bodyText);
      });
    } catch { return false; }
  }

  /** Check login status by opening a fresh IS24 homepage tab.
   *  Existing tabs may have stale state — a fresh page is the only reliable way. */
  async checkIS24LoginAnyTab() {
    const evaluateLogin = () => `(() => {
      const flag = (window.IS24 && window.IS24.expose && window.IS24.expose.userLoggedIn);
      if (typeof flag === 'boolean') return flag;
      const wrapper = document.querySelector('.sso-login');
      if (wrapper) {
        const text = wrapper.innerText || '';
        if (/angemeldet\\s+als/i.test(text)) return true;
        if (/\\bAnmelden\\b/.test(text)) return false;
      }
      const bodyText = document.body?.innerText || '';
      const loggedInRe = /angemeldet\\s+als|zu\\s+meinem\\s+Bereich|Mein\\s*Konto|Abmelden/i;
      const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/;
      return loggedInRe.test(bodyText) && emailRe.test(bodyText);
    })()`;

    try {
      const tempPage = await this.browser.newPage();
      try {
        await tempPage.goto('https://www.immobilienscout24.de/', { waitUntil: 'domcontentloaded', timeout: 15000 });
        return await tempPage.evaluate(evaluateLogin);
      } finally {
        await tempPage.close().catch((err) => { swallow(err, 'CDP/tempPage-close'); });
      }
    } catch { return false; }
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
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const plusTextRe = /(MieterPlus|Mieter\+|Plus-Mitglied|Premium-Mitglied|Plus Mitgliedschaft|Suchen\+|Suchen Plus)/i;
        const plusGateRe = /(Tarif wählen|Mitgliedschaft wählen|Jetzt Plus|Plus buchen|PLUS-Mitglied werden|zum PLUS-Mitglied|Kontakt nur|nur mit .{0,30}Plus|exklusiv .{0,30}Plus|Plus .{0,30}kontaktieren)/i;
        const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], [class*="modal"], [class*="Modal"], [class*="upsell"], [class*="Upsell"], [class*="paywall"], [class*="Paywall"]'))
          .filter(visible)
          .map((el) => el.textContent?.trim() || '')
          .filter(Boolean);
        return candidates.some((text) => plusTextRe.test(text) && plusGateRe.test(text));
      });
    } catch { return false; }
  }

  async _isDeactivated() {
    try {
      return await this.page.evaluate(() => {
        const text = document.body?.innerText || '';
        const url = document.location?.href || '';
        // IS24 shows these when listing is gone
        if (/(nicht mehr verfügbar|nicht mehr verfuegbar|Anzeige.{0,30}nicht gefunden|Anzeige.{0,30}existiert nicht|wurde deaktiviert|Objekt wurde.{0,30}entfernt|Leider wurde das Objekt|Diese Seite existiert nicht|Angebot ist abgelaufen|wurde bereits vergeben|ist bereits vergeben|nicht mehr online|expose.{0,10}not found)/i.test(text)) return true;
        // 404 redirects or page title says "not found"
        if (/Seite nicht gefunden|Page not found|404/i.test(document.title || '')) return true;
        return false;
      });
    } catch { return false; }
  }

  async _waitForForm(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await this._isContactFormOpen();
      if (found) return true;
      await this._openContactFormIfNeeded();
      await jitter(500, 1500);
    }
    return false;
  }

  async _openContactFormIfNeeded() {
    try {
      if (await this._isContactFormOpen()) return true;
      const clicked = await this.page.evaluate(() => {
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        const btn = buttons.find((el) => {
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          return visible(el) && /^(Nachricht|Kontakt aufnehmen|Anbieter kontaktieren|Vermieter kontaktieren)$/i.test(text);
        });
        if (!btn) return false;
        btn.scrollIntoView({ block: 'center', inline: 'center' });
        btn.click();
        return true;
      });
      if (clicked) await jitter(800, 1500);
      return clicked;
    } catch { return false; }
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
    } catch (err) { swallow(err, 'form/dismiss-cookie-consent'); }
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
            el.dispatchEvent(new Event('input', { bubbles: true }));
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

    // Fill pet details when haustiere is "Ja"
    if (this.contact.haustiere === 'Ja' && this.contact.haustiere_zusatz) {
      const petSel = 'input[name="petsInHousehold"]';
      const petExists = await this.page.evaluate((s) => !!document.querySelector(s), petSel);
      if (petExists) {
        process.stderr.write(`[contactor] Filling petsInHousehold: "${this.contact.haustiere_zusatz}"\n`);
        await this.page.evaluate((s) => document.querySelector(s)?.focus(), petSel);
        await jitter(100, 200);
        await this.page.evaluate(({ s, v }) => {
          const el = document.querySelector(s);
          if (!el) return;
          const ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          ns.call(el, v);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, { s: petSel, v: this.contact.haustiere_zusatz });
        await jitter(...this.t.postTypeJitter);
      }
    }

    // Fill move-in date when einzug is "genaues Datum"
    if (this.contact.einzug === 'genaues Datum' && this.contact.einzug_datum) {
      const dateSelector = 'input#moveInDate';
      // Debug: dump all named inputs on the form
      const allInputs = await this.page.evaluate(() =>
        Array.from(document.querySelectorAll('input, select')).map(el => ({
          tag: el.tagName,
          name: el.name,
          type: el.getAttribute('type'),
          placeholder: el.getAttribute('placeholder'),
          id: el.id,
          class: el.className?.slice?.(0, 60) || '',
        })).filter(i => i.name || i.id || i.class)
      );
      process.stderr.write('[contactor] All form inputs: ' + JSON.stringify(allInputs) + '\n');
      // Retry — React may need a moment to render the date input after select change
      let exists = false;
      for (let i = 0; i < 5; i++) {
        exists = await this.page.evaluate((sel) => !!document.querySelector(sel), dateSelector);
        if (exists) break;
        await jitter(200, 400);
      }
      process.stderr.write(`[contactor] Date selector "${dateSelector}" exists: ${exists}\n`);
      if (exists) {
        // 1) Set the date text via native setter (proven to put text in the field)
        // 2) Open calendar — IS24 reads the pre-filled value and should pre-select it
        // 3) Click OK to confirm through the calendar picker (proper React state update)
        // Block SPA hash changes so the form doesn't close.
        const parts = this.contact.einzug_datum.split('-');
        const targetDay = parseInt(parts[2], 10);
        const targetMonth = parseInt(parts[1], 10);
        const targetYear = parseInt(parts[0], 10);
        const germanDate = parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : this.contact.einzug_datum;

        // Step 1: set date text + block hash changes
        await this.page.evaluate(({ sel, date }) => {
          // Block hash changes
          window.__homelander_blockHash = true;
          window.__homelander_originalHash = location.hash;
          const _ps = history.pushState, _rs = history.replaceState;
          history.pushState = function (...a) { if (window.__homelander_blockHash) return; return _ps.apply(this, a); };
          history.replaceState = function (...a) { if (window.__homelander_blockHash) return; return _rs.apply(this, a); };
          // Set the date text in the input
          const el = document.querySelector(sel);
          if (!el) return;
          const ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          ns.call(el, date);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, { sel: dateSelector, date: germanDate });
        await jitter(200, 400);

        // Step 2: focus to open calendar (should see the pre-filled date)
        await this.page.evaluate((sel) => document.querySelector(sel)?.focus(), dateSelector);
        await jitter(500, 800);

        // Step 3: click OK to confirm
        await this.page.evaluate(() => {
          document.querySelector('.DatePicker_datepicker-okay-button__JxpMI')?.click();
        });
        await jitter(400, 600);

        // If calendar still open after OK, retry with manual navigation + day pick
        const stillOpen = await this.page.evaluate(() =>
          !!document.querySelector('.DatePicker_datepicker-days-wrapper__qCgH-')
        );
        if (stillOpen) {
          process.stderr.write('[contactor] Calendar still open — retrying with day pick\n');
          await this.page.evaluate(({ day, month, year }) => {
            const months = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
            const getDisp = () => {
              const el = document.querySelector('.DatePicker_datepicker-current-month__HB2Ak');
              if (!el) return null;
              const p = el.textContent.trim().split(/\s+/);
              const m = months.indexOf(p[0]);
              return m >= 0 ? { month: m + 1, year: parseInt(p[1]) } : null;
            };
            let cur = getDisp();
            if (!cur) return;
            const next = () => document.querySelector('.DatePicker_datepicker-next-month-button__V6X0I');
            const prev = () => document.querySelector('.DatePicker_datepicker-previous-month-button__N37Co');
            for (let c = 0; c < 24 && !(cur.year === year && cur.month === month); c++) {
              (cur.year < year || (cur.year === year && cur.month < month)) ? next()?.click() : prev()?.click();
              const t = Date.now(); while (Date.now() - t < 150) {}
              const nextCur = getDisp();
              if (!nextCur) break;
              cur = nextCur;
            }
            if (cur && cur.month === month && cur.year === year) {
              const btns = document.querySelectorAll('.DatePicker_datepicker-day-cell__Bomtx');
              for (const b of btns) {
                if (b.textContent.trim() === String(day) && !b.disabled) {
                  b.click();
                  const t = Date.now(); while (Date.now() - t < 150) {}
                  break;
                }
              }
            }
            document.querySelector('.DatePicker_datepicker-okay-button__JxpMI')?.click();
          }, { day: targetDay, month: targetMonth, year: targetYear });
          await jitter(400, 600);
        }

        // Unblock hash changes + restore form
        await this.page.evaluate(() => {
          window.__homelander_blockHash = false;
          if (!location.hash.includes('basicContact')) {
            location.hash = window.__homelander_originalHash || '#/basicContact/email';
          }
        });
        await jitter(300, 500);
      }
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
        // IS24's React onChange can reject keyboard.type() values — email and
        // address fields are common victims.  Instead of a single requestAnimationFrame,
        // run a retry loop inside the page that sets + verifies the value across
        // multiple microtask ticks so React's render cycle has time to settle.
        const stuck = await this.page.evaluate(({ s, v }) => {
          const el = document.querySelector(s);
          if (!el) return false;
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;

          // Helper — fire the full event sequence IS24's React expects
          const fireEvents = () => {
            el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          };

          // Clear first
          nativeSetter.call(el, '');
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));

          // Set + re-verify across several microtask ticks
          let attempts = 0;
          const trySet = () => {
            nativeSetter.call(el, v);
            fireEvents();
            // must read .value, not el.value, to get the real DOM property
            if (el.value === v) return true;
            attempts++;
            if (attempts < 6) {
              // schedule next attempt after a short timeout so React can settle
              return new Promise(resolve => {
                setTimeout(() => resolve(trySet()), 30 + attempts * 15);
              });
            }
            return false;
          };
          return trySet();
        }, { s: sel, v: val });
        if (!stuck) {
          retries++;
          process.stderr.write(`[contactor] Failed to fill ${sel} after retries\\n`);
        }
      }
      filled++;
    }

    // Do NOT fill global expose-page helpers like `vonplz`/`nachplz` here.
    // Those names are used by IS24's "Was kostet ein Umzug?" calculator outside
    // the contact form; clicking them closes the contact form and scrolls to the page body.

    // Message textarea (optional — not every IS24 listing has one)
    const textareaSel = 'textarea[name="message"]';
    const hasTextarea = await this.page.evaluate((s) => !!document.querySelector(s), textareaSel);

    if (hasTextarea) {
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
          el.dispatchEvent(new Event('change', { bubbles: true }));
          // Retry loop — IS24's React may revert the value after the first set
          let n = 0;
          const trySet = () => {
            nativeSetter.call(el, msg);
            el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: msg }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (el.value === msg) return;
            if (++n < 4) setTimeout(() => trySet(), 50 + n * 20);
          };
          trySet();
        }, { sel: textareaSel, msg: message });
        await jitter(200, 400);
        retries++;
      }
    }

    // Final verify: IS24 auto-fill can asynchronously revert fields after the bot types.
    // Re-check every field and robustly re-set any that lost their value.
    for (const { sel, val } of fields) {
      if (!val) continue;
      const actual = await this.page.evaluate((s) => document.querySelector(s)?.value || '', sel);
      if (actual !== val) {
        const ok = await this.page.evaluate(({ s, v }) => {
          const el = document.querySelector(s);
          if (!el) return false;
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          const fireEvents = () => {
            el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          };
          let n = 0;
          const trySet = () => {
            nativeSetter.call(el, v);
            fireEvents();
            if (el.value === v) return true;
            if (++n < 4) return new Promise(r => setTimeout(() => r(trySet()), 40 + n * 20));
            return false;
          };
          return trySet();
        }, { s: sel, v: val });
        if (!ok) retries++;
        await jitter(100, 200);
      }
    }

    return { filled, retries };
  }

  async _isContactFormOpen() {
    try {
      return await this.page.evaluate(() => {
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const hasSubmit = Array.from(document.querySelectorAll('button')).some((b) => visible(b) && /Abschicken|Senden|Kontaktanfrage senden/i.test(b.textContent || ''));
        // Message textarea is optional; some IS24 forms also use alternate email/phone names.
        const fieldSelectors = [
          'input[name="firstName"]',
          'input[name="lastName"]',
          'input[name="emailAddress"]',
          'input[name="email"]',
          'input[type="email"]',
          'input[name="phoneNumber"]',
          'input[name="phone"]',
          'input[type="tel"]',
          'textarea[name="message"]',
          'select[name="salutation"]',
        ];
        const hasField = fieldSelectors.some((sel) => visible(document.querySelector(sel)));
        return hasSubmit && hasField;
      });
    } catch { return false; }
  }

  async _clickAbschicken() {
    const clicked = await this.page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const buttons = Array.from(document.querySelectorAll('button'));
      const btn = buttons.find((b) => visible(b) && !b.disabled && /^(Abschicken|Senden|Kontaktanfrage senden)$/i.test((b.textContent || '').trim()));
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!clicked) throw new Error('Submit button not found or not clickable');
  }

  async _verifySubmission(exposeId, captchaStats = {}) {
    await jitter(1500, 2500);
    const verifyDeadlineMs = this.verifyDeadlineMs ?? (process.env.HOMELANDER_TEST_FAST === '1' ? 1 : 5_000);
    let deadline = Date.now() + verifyDeadlineMs;
    let captchaRetries = 0;
    let serverRetries = 0;
    let deadlineExtended = false;
    let sawValidation = false;

    while (Date.now() < deadline) {
      const state = await this.page.evaluate(() => {
        const allText = document.body?.innerText || '';
        const msgTextarea = document.querySelector('textarea[name="message"]');
        const contactContainer = (el) => el?.closest('[class*="contact"], [class*="modal"], [class*="overlay"], [class*="ReactModal"], form');
        const submitBtn = Array.from(document.querySelectorAll('button')).find(b =>
          /Abschicken|Senden|Kontaktanfrage senden/i.test(b.textContent || '') &&
          // Only count submit buttons inside a modal/contact container unless the textarea
          // is present (form is open — any matching button is relevant).
          (msgTextarea || contactContainer(b))
        );
        const confirmed = document.querySelector('[class*="StatusMessage_status-confirm"]') !== null;
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const plusTextRe = /(MieterPlus|Mieter\+|Plus-Mitglied|Premium-Mitglied|Plus Mitgliedschaft|Suchen\+|Suchen Plus)/i;
        const plusGateRe = /(Tarif wählen|Mitgliedschaft wählen|Jetzt Plus|Plus buchen|PLUS-Mitglied werden|zum PLUS-Mitglied|Kontakt nur|nur mit .{0,30}Plus|exklusiv .{0,30}Plus|Plus .{0,30}kontaktieren)/i;
        const premium = Array.from(document.querySelectorAll('button, a, [role="button"], [class*="modal"], [class*="Modal"], [class*="upsell"], [class*="Upsell"], [class*="paywall"], [class*="Paywall"]'))
          .filter(visible)
          .some((el) => {
            const text = el.textContent?.trim() || '';
            return plusTextRe.test(text) && plusGateRe.test(text);
          });
        // "Anmelden"/"Einloggen" text on an expose page almost always comes from
        // a Plus-membership upsell ("Jetzt für Plus anmelden"), not a real logout.
        // Real session expiry redirects the URL to /login or sso.immobilienscout24.
        // Only flag loggedOut when the URL confirms it OR when "Anmelden" appears
        // AND no IS24 user-menu indicator (username/avatar) is present.
        const currentUrl = window.location.href;
        const urlShowsLogin = currentUrl.includes('/login')
          || currentUrl.includes('/registrierung')
          || currentUrl.includes('sso.immobilienscout24');
        const hasUserMenu = (() => {
          // IS24 logged-in header shows a truncated email/username (e.g. "bowiclg454..."),
          // "Mein Konto", avatar img, or "Abmelden" link — any of these = logged in.
          const indicators = Array.from(document.querySelectorAll('a, button, span, img'))
            .filter(visible)
            .some(el => {
              const txt = (el.textContent || '').trim();
              const alt = (el.getAttribute('alt') || '');
              return /\b(Mein Konto|Mein ImmoScout24|Abmelden|account|user)\b/i.test(txt)
                || /^[a-z0-9._%-]{3,}\.{3}$/i.test(txt)  // truncated username like "bowiclg454..."
                || /avatar|user|account|profile/i.test(el.className || '')
                || /avatar|user|account/i.test(alt);
            });
          return indicators;
        })();
        const loggedOut = !hasUserMenu && (
          urlShowsLogin
          || /\bAnmelden\b|Jetzt einloggen|Einloggen|Loggen Sie sich ein|Bitte melden Sie sich an/i.test(allText)
          || Array.from(document.querySelectorAll('a, button')).some((el) => /\bAnmelden\b|Jetzt einloggen|Einloggen/i.test(el.textContent || ''))
        );
        const successText = /Kontaktanfrage.{0,80}(gesendet|verschickt|erfolgreich)|Nachricht.{0,80}(gesendet|verschickt)|Vielen Dank.{0,120}(Nachricht|Kontaktanfrage)/i.test(allText);
        return {
          confirmed,
          successText,
          loggedOut,
          formGone: !msgTextarea && !submitBtn,
          captcha: /Roboter|Sicherheitsprüfung|Sicherheitsabfrage/i.test(allText),
          serverError: /Es ist ein Fehler aufgetreten/i.test(allText),
          premium,
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

      if (state.confirmed || state.successText) return { verified: true, detail: state.confirmed ? 'confirmed (modal)' : 'confirmed (success text)', captcha_retries: captchaRetries, server_retries: serverRetries, deadline_extended: deadlineExtended };

      if (state.loggedOut && state.formGone) {
        return { verified: false, detail: 'SESSION_EXPIRED (login required — form closed to expose page)', captcha_retries: captchaRetries, server_retries: serverRetries, deadline_extended: deadlineExtended, error_text: state.errorText };
      }

      // Deactivated — listing vanished during submission
      if (/nicht mehr verfügbar|Anzeige.{0,20}nicht gefunden|wurde deaktiviert|wurde bereits vergeben|ist bereits vergeben/i.test(state.errorText || '')) {
        return { verified: false, detail: 'DEACTIVATED (listing removed during submission)', captcha_retries: captchaRetries, server_retries: serverRetries, deadline_extended: deadlineExtended, error_text: state.errorText };
      }

      if (state.captcha) {
        captchaStats.detected = true;
        captchaRetries++;
        captchaStats.attempts = captchaRetries;
        const solved = await this._solveCaptcha(captchaStats);
        if (solved) {
          deadline = Date.now() + verifyDeadlineMs;
          deadlineExtended = true;
          await jitter(800, 1500);
          continue;
        }
        return { verified: false, detail: 'captcha (unsolved)', captcha_retries: captchaRetries, server_retries: serverRetries, deadline_extended: deadlineExtended, error_text: state.errorText };
      }

      if (state.serverError) {
        return { verified: false, detail: 'PREMIUM_ONLY (Es ist ein Fehler aufgetreten. — Plus/Suchen+ required)', captcha_retries: captchaRetries, server_retries: serverRetries, deadline_extended: deadlineExtended, error_text: state.errorText };
      }

      if (state.hasErrors || state.validationText) {
        sawValidation = true;
        // IS24 often flashes validation highlights during async submission.
        // Don't bail — the form may have submitted successfully despite transient errors.
        // Wait and re-check; only fail if errors persist and form is still present at deadline.
        await jitter(800, 1500);
        continue;
      }

      if (state.formGone) {
        return { verified: false, detail: 'SUBMIT_UNCONFIRMED (form closed without confirmation)', captcha_retries: captchaRetries, server_retries: serverRetries, deadline_extended: deadlineExtended, error_text: state.errorText };
      }

      await jitter(800, 1200);
    }

    // Deadline fallback — form is gone only when both optional textarea AND submit button vanished.
    const fallbackState = await this.page.evaluate(() => {
      const hasTextarea = !!document.querySelector('textarea[name="message"]');
      const contactContainer = (el) => el?.closest('[class*="contact"], [class*="modal"], [class*="overlay"], [class*="ReactModal"], form');
      const hasSubmit = Array.from(document.querySelectorAll('button')).some(b =>
        /Abschicken|Senden|Kontaktanfrage senden/i.test(b.textContent || '') &&
        // Only count submit buttons inside a modal/contact container unless the textarea
        // is present (form is open — any matching button is relevant).
        (hasTextarea || contactContainer(b))
      );
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const plusTextRe = /(MieterPlus|Mieter\+|Plus-Mitglied|Premium-Mitglied|Plus Mitgliedschaft|Suchen\+|Suchen Plus)/i;
      const plusGateRe = /(Tarif wählen|Mitgliedschaft wählen|Jetzt Plus|Plus buchen|PLUS-Mitglied werden|zum PLUS-Mitglied|Kontakt nur|nur mit .{0,30}Plus|exklusiv .{0,30}Plus|Plus .{0,30}kontaktieren)/i;
      const premium = Array.from(document.querySelectorAll('button, a, [role="button"], [class*="modal"], [class*="Modal"], [class*="upsell"], [class*="Upsell"], [class*="paywall"], [class*="Paywall"]'))
        .filter(visible)
        .some((el) => {
          const text = el.textContent?.trim() || '';
          return plusTextRe.test(text) && plusGateRe.test(text);
        });
      const allText = document.body?.innerText || '';
      return {
        formGone: !hasTextarea && !hasSubmit,
        premium,
        loggedOut: /\bAnmelden\b|Jetzt einloggen|Einloggen|Loggen Sie sich ein|Bitte melden Sie sich an/i.test(allText)
          || Array.from(document.querySelectorAll('a, button')).some((el) => /\bAnmelden\b|Jetzt einloggen|Einloggen/i.test(el.textContent || '')),
        successText: /Kontaktanfrage.{0,80}(gesendet|verschickt|erfolgreich)|Nachricht.{0,80}(gesendet|verschickt)|Vielen Dank.{0,120}(Nachricht|Kontaktanfrage)/i.test(allText),
        serverError: /Es ist ein Fehler aufgetreten/i.test(allText),
      };
    });
    const formGone = fallbackState?.formGone === true;
    const isServerError = fallbackState?.serverError === true;

    if (fallbackState?.successText === true) return { verified: true, detail: 'confirmed (success text)', captcha_retries: captchaRetries, server_retries: serverRetries, deadline_extended: deadlineExtended };
    if (formGone && fallbackState?.loggedOut === true) return { verified: false, detail: 'SESSION_EXPIRED (login required — form closed to expose page)', captcha_retries: captchaRetries, server_retries: serverRetries, deadline_extended: deadlineExtended };
    // When the form closed itself AND we saw validation flashes, IS24 accepted the submission —
    // transient React validation highlights are normal during async form submit.
    // Real validation errors keep the form open with red borders.
    if (formGone) return { verified: false, detail: sawValidation ? 'SUBMIT_UNCONFIRMED (form closed after transient validation)' : 'SUBMIT_UNCONFIRMED (form closed without confirmation)', captcha_retries: captchaRetries, server_retries: serverRetries, deadline_extended: deadlineExtended };
    if (isServerError && !formGone) return { verified: false, detail: 'PREMIUM_ONLY (Es ist ein Fehler aufgetreten. — Plus/Suchen+ required)', captcha_retries: captchaRetries, server_retries: serverRetries, deadline_extended: deadlineExtended };
    if (sawValidation) return { verified: false, detail: 'validation errors persisted', captcha_retries: captchaRetries, server_retries: serverRetries, deadline_extended: deadlineExtended };
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
      } catch (err) { swallow(err, 'captcha/check-solved'); }
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
    try { if (this.page) await this.page.close(); } catch (err) { swallow(err, 'page/close-cleanup'); }
    try { if (this.browser) await this.browser.disconnect(); } catch (err) { swallow(err, 'browser/disconnect-cleanup'); }
    this.browser = null;
    this.page = null;
  }
}
