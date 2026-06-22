// Bundled Chromium manager for Homelander.
// Owns one Puppeteer-managed Chromium profile, keeps CDP available for the daemon,
// and controls browser visibility without touching user-owned tabs.

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const CDP_PORT = 9222;
const DEFAULT_MAX_TABS = 5;
const DEFAULT_WINDOW_POSITION = { left: 80, top: 60, width: 1200, height: 850 };
const IS24_HOME = 'https://www.immobilienscout24.de/';
/** Logged-catch replacement — never throws, logs to console. */
function swallow(err, context) {
  try { console.error(`[chrome swallow] ${context}: ${err?.message || err}`); } catch {}
}


function getBundledChromiumPath() {
  try {
    const executablePath = puppeteer.executablePath();
    if (executablePath && existsSync(executablePath)) return executablePath;
  } catch (err) { swallow(err, 'chrome/get-bundled-chromium'); }
  return null;
}

function getProfileDir(email) {
  const hash = createHash('sha256').update(email || 'default').digest('hex').slice(0, 12);
  return join(homedir(), '.homelander', 'chrome-profiles', `profile-${hash}`);
}

function logCookiesState(label, profileDir) {
  try {
    const cookiesPath = join(profileDir, 'Default', 'Cookies');
    if (!existsSync(cookiesPath)) {
      console.log(`[chrome:cookies] ${label} — Cookies file MISSING at ${cookiesPath}`);
      return;
    }
    const stat = statSync(cookiesPath);
    console.log(`[chrome:cookies] ${label} — size=${stat.size} mtime=${stat.mtime.toISOString()} mtimeMs=${stat.mtimeMs}`);
  } catch (err) {
    console.log(`[chrome:cookies] ${label} — stat failed: ${err.message}`);
  }
}

function clampMaxTabs(maxTabs) {
  const n = Number(maxTabs || DEFAULT_MAX_TABS);
  return Math.min(5, Math.max(1, Number.isFinite(n) ? Math.floor(n) : DEFAULT_MAX_TABS));
}

export class ChromeManager {
  constructor() {
    this.browser = null;
    this.cdpUrl = `http://localhost:${CDP_PORT}`;
    this.profileDir = null;
    this.manualLoginProcess = null;
    this._restartWindow = [];
    this._maxRestartsPerHour = 3;
  }

  _options(options = {}) {
    return {
      visibility: options.visibility || 'hidden_unless_needed',
      maxTabs: clampMaxTabs(options.maxTabs),
    };
  }

  async launch(email, options = {}) {
    const t0 = Date.now();
    const opts = this._options(options);
    this.profileDir = getProfileDir(email);
    console.log(`[chrome:launch] email=${email} profileDir=${this.profileDir} manualLoginRunning=${this.isManualLoginRunning()}`);
    logCookiesState('launch-entry', this.profileDir);

    // If CDP is already running (e.g. setup browser still alive), connect to it.
    // No kill + relaunch — the session stays alive in the running browser.
    const healthy = await this.isHealthy();
    console.log(`[chrome:launch] isHealthy=${healthy} (${Date.now() - t0}ms elapsed)`);
    if (healthy) {
      console.log('[chrome:launch] CDP already healthy — connecting to existing browser (setup session preserved)');
      await this._connectExisting().catch((err) => { swallow(err, 'chrome/connect-existing'); });
      if (opts.visibility === 'always_show') await this.showBrowser();
      else await this.hideBrowser().catch((err) => { swallow(err, 'chrome/hide-browser'); });
      return this._versionInfo();
    }

    // CDP not running — maybe manual login browser was configured but
    // never started. Start it fresh.
    if (this.isManualLoginRunning()) {
      console.log('[chrome:launch] manual login running but CDP not healthy — waiting for CDP');
      await this._waitForCdp(15000);
      await this._connectExisting().catch((err) => { swallow(err, 'chrome/connect-existing'); });
      if (opts.visibility === 'always_show') await this.showBrowser();
      else await this.hideBrowser().catch((err) => { swallow(err, 'chrome/hide-browser'); });
      return this._versionInfo();
    }

    const executablePath = getBundledChromiumPath();
    if (!executablePath) {
      throw new Error('Bundled Chromium not found. Run npm install so Puppeteer can install its browser.');
    }
    mkdirSync(this.profileDir, { recursive: true });

    const now = Date.now();
    this._restartWindow = this._restartWindow.filter(t => now - t < 3600000);
    if (this._restartWindow.length >= this._maxRestartsPerHour) {
      throw new Error('Too many Chromium restarts. Please wait and try again.');
    }
    this._restartWindow.push(now);

    console.log(`[chrome:launch] puppeteer.launch() starting... userDataDir=${this.profileDir}`);
    const launchT0 = Date.now();
    this.browser = await puppeteer.launch({
      executablePath,
      headless: false,
      defaultViewport: null,
      userDataDir: this.profileDir,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        `--remote-debugging-port=${CDP_PORT}`,
        ...(opts.visibility === 'always_show'
          ? ['--window-size=1200,850']
          : [`--window-position=${DEFAULT_WINDOW_POSITION.left},${DEFAULT_WINDOW_POSITION.top}`, '--inactive']),
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-hang-monitor',
        '--disable-translate',
        '--no-pings',
        '--disable-features=NetworkServiceSandbox',
      ],
    });
    console.log(`[chrome:launch] puppeteer.launch() done in ${Date.now() - launchT0}ms`);
    logCookiesState('launch-after-puppeteer', this.profileDir);

    // --remote-debugging-port causes Chromium to set navigator.webdriver=true
    // regardless of --disable-blink-features=AutomationControlled. IS24 detects
    // this and treats the browser as a bot, invalidating the session. Inject
    // the override on every existing page and all future pages.
    const injectWebdriverOverride = async (page) => {
      try {
        await page.evaluateOnNewDocument(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
      } catch { /* page might close before injection */ }
    };
    // Apply to all existing pages
    for (const p of await this.browser.pages()) {
      await injectWebdriverOverride(p).catch(() => {});
    }
    // Apply to every new page that opens
    this.browser.on('targetcreated', async (target) => {
      if (target.type() === 'page') {
        try {
          const p = await target.page();
          if (p) await injectWebdriverOverride(p);
        } catch { /* target might close */ }
      }
    });
    console.log('[chrome:launch] injected navigator.webdriver=false for all pages');

    this.browser.on('disconnected', () => { console.log('[chrome:launch] browser disconnected event'); this.browser = null; });

    console.log('[chrome:launch] waiting for CDP...');
    const cdpT0 = Date.now();
    await this._waitForCdp(30000);
    console.log(`[chrome:launch] CDP ready in ${Date.now() - cdpT0}ms`);
    const pages = await this.browser.pages();
    console.log(`[chrome:launch] browser has ${pages.length} pages: ${pages.map(p => p.url()).join(', ')}`);
    if (pages.length === 0) { console.log('[chrome:launch] no pages — creating new page'); await this.browser.newPage(); }
    const page = (await this.browser.pages())[0];
    if (page && page.url() === 'about:blank') {
      console.log('[chrome:launch] page is about:blank — navigating to IS24');
      const navT0 = Date.now();
      await page.goto(IS24_HOME, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch((err) => { swallow(err, 'chrome/navigate-is24-home'); });
      console.log(`[chrome:launch] IS24 navigation done in ${Date.now() - navT0}ms, url now: ${page.url()}`);
    }
    console.log(`[chrome:launch] total launch time: ${Date.now() - t0}ms`);
    return this._versionInfo();
  }

  async _connectExisting() {
    if (this.browser?.isConnected?.()) return this.browser;
    this.browser = await puppeteer.connect({ browserURL: this.cdpUrl, defaultViewport: null });
    this.browser.on('disconnected', () => { console.log('[chrome] browser disconnected'); this.browser = null; });

    // Spoof navigator.webdriver on ALL pages (existing + future).
    // --remote-debugging-port forces webdriver=true in Chrome 148+;
    // IS24 checks this and rejects sessions from automated browsers.
    const spoofWebdriver = async (page) => {
      try {
        await page.evaluateOnNewDocument(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
        await page.evaluate(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
      } catch { /* page may close before injection */ }
    };
    const pages = await this.browser.pages();
    for (const page of pages) {
      await spoofWebdriver(page).catch(() => {});
    }
    this.browser.on('targetcreated', async (target) => {
      if (target.type() === 'page') {
        const page = await target.page().catch(() => null);
        if (page) await spoofWebdriver(page).catch(() => {});
      }
    });

    return this.browser;
  }

  async _versionInfo() {
    const data = await this._waitForCdp(5000);
    return { cdpUrl: this.cdpUrl, webSocketDebuggerUrl: data.webSocketDebuggerUrl };
  }

  async _waitForCdp(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(`${this.cdpUrl}/json/version`);
        if (resp.ok) return await resp.json();
      } catch (err) { swallow(err, 'chrome/cdp-version-check'); }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`Chromium CDP not available after ${timeoutMs}ms`);
  }

  async isHealthy() {
    try {
      const resp = await fetch(`${this.cdpUrl}/json/version`, { signal: AbortSignal.timeout(3000) });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async getTabCount() {
    try {
      const browser = await this._connectExisting();
      return (await browser.pages()).length;
    } catch {
      return -1;
    }
  }

  async _setWindowBounds(page, bounds) {
    if (!page) return;
    const session = await page.target().createCDPSession();
    try {
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', { windowId, bounds });
    } finally {
      await session.detach().catch((err) => { swallow(err, 'chrome/session-detach'); });
    }
  }
  async showBrowser() {
    const browser = await this._connectExisting();
    const page = (await browser.pages())[0];
    if (!page) return;
    await this._setWindowBounds(page, DEFAULT_WINDOW_POSITION);
    await page.bringToFront().catch((err) => { swallow(err, 'chrome/bring-to-front'); });
  }

  async hideBrowser() {
    // Intentional no-op — macOS handles background windows fine without
    // forced off-screen positioning (which causes window-management issues).
  }

  async openUrl(url, email, options = {}) {
    const opts = this._options(options);
    await this.launch(email, { ...opts, visibility: 'always_show' });
    const browser = await this._connectExisting();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((err) => { swallow(err, 'chrome/open-url-goto'); });
    await this.showBrowser();
    return this._versionInfo();
  }

  async openLoginPage(email, options = {}) {
    return this.openManualLoginPage(email, options);
  }

  isManualLoginRunning() {
    return !!this.manualLoginProcess && this.manualLoginProcess.exitCode === null && !this.manualLoginProcess.killed;
  }

  async stopManualLoginProcess(timeoutMs = 20000) {
    const proc = this.manualLoginProcess;
    console.log(`[chrome:stopManual] called — proc=${!!proc} pid=${proc?.pid} exitCode=${proc?.exitCode} killed=${proc?.killed}`);
    if (!proc) return;
    if (proc.exitCode !== null || proc.killed) {
      console.log(`[chrome:stopManual] process already exited (exitCode=${proc.exitCode}, killed=${proc.killed}) — clearing ref`);
      this.manualLoginProcess = null;
      return;
    }

    const t0 = Date.now();
    console.log(`[chrome:stopManual] sending SIGTERM to pid ${proc.pid}...`);
    try { proc.kill('SIGTERM'); } catch (err) { console.log(`[chrome:stopManual] SIGTERM failed: ${err.message}`); this.manualLoginProcess = null; return; }

    await new Promise((resolve) => {
      let settled = false;
      const done = (reason) => {
        if (settled) return;
        settled = true;
        const elapsed = Date.now() - t0;
        clearTimeout(killTimer);
        console.log(`[chrome:stopManual] done — reason=${reason} elapsed=${elapsed}ms exitCode=${proc.exitCode} killed=${proc.killed}`);
        if (this.manualLoginProcess === proc) this.manualLoginProcess = null;
        resolve();
      };
      const killTimer = setTimeout(() => {
        console.log(`[chrome:stopManual] ${timeoutMs}ms elapsed — sending SIGKILL to pid ${proc.pid}`);
        try { proc.kill('SIGKILL'); } catch (err) { console.log(`[chrome:stopManual] SIGKILL failed: ${err.message}`); }
        done('timeout-sigkill');
      }, timeoutMs);
      proc.once('exit', (code, signal) => {
        console.log(`[chrome:stopManual] process exited — code=${code} signal=${signal} elapsed=${Date.now() - t0}ms`);
        done('exit');
      });
    });
  }

  async openManualLoginPage(email, options = {}) {
    console.log(`[chrome:openManualLogin] called — email=${email}`);
    // When CDP is already running (e.g. session-expired re-login), don't
    // restart the browser — just open a fresh IS24 tab via CDP and show it.
    // Avoids killing the daemon's CDP connection, works cross-platform.
    if (await this.isHealthy()) {
      console.log('[chrome:openManualLogin] CDP healthy — opening login tab via existing browser');
      try {
        const browser = await this._connectExisting();
        await browser.newPage();
        const pages = await browser.pages();
        const lastPage = pages[pages.length - 1];
        await lastPage.goto(IS24_HOME, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await lastPage.bringToFront();
        await this.showBrowser();
        return { cdpConnected: true, manualLogin: false };
      } catch {
        console.log('[chrome:openManualLogin] CDP tab open failed — falling through to manual browser');
        // CDP navigation failed — fall through to manual-browser path
      }
    }

    this.profileDir = getProfileDir(email);
    console.log(`[chrome:openManualLogin] profileDir=${this.profileDir}`);
    mkdirSync(this.profileDir, { recursive: true });

    // Login/SSO pages are more aggressive than expose pages. Opening login via
    // Puppeteer/CDP exposes automation flags and can trigger visual challenges
    // ("find the stairs"). For the one-time manual login, run the same bundled
    // Chromium profile as a plain user-started process: no CDP, no Puppeteer
    // connection, no --enable-automation. The manual browser stays open
    // after login; CDP launches later when the daemon starts.
    if (await this.isHealthy()) { console.log('[chrome:openManualLogin] CDP became healthy — shutting down first'); await this.shutdown(); }
    if (this.isManualLoginRunning()) { console.log('[chrome:openManualLogin] manual login already running'); return { manualLogin: true, profileDir: this.profileDir }; }

    const executablePath = getBundledChromiumPath();
    if (!executablePath) {
      throw new Error('Bundled Chromium not found. Run npm install so Puppeteer can install its browser.');
    }

    // Launch with CDP enabled so the daemon can connect to the SAME browser
    // process later — no kill + relaunch, no session loss.
    console.log(`[chrome:openManualLogin] spawning Chromium with CDP — userDataDir=${this.profileDir}`);
    this.manualLoginProcess = spawn(executablePath, [
      `--user-data-dir=${this.profileDir}`,
      `--remote-debugging-port=${CDP_PORT}`,
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1200,850',
      IS24_HOME,
    ], {
      detached: false,
      stdio: 'ignore',
    });
    console.log(`[chrome:openManualLogin] spawned — pid=${this.manualLoginProcess.pid}`);
    this.manualLoginProcess.once('exit', (code, signal) => {
      console.log(`[chrome:openManualLogin] manual browser exited — code=${code} signal=${signal}`);
      this.manualLoginProcess = null;
    });
    this.manualLoginProcess.unref();
    return { manualLogin: true, profileDir: this.profileDir };
  }

  async finalizeManualLogin(email, options = {}) {
    console.log(`[chrome:finalizeManualLogin] called — manualLoginRunning=${this.isManualLoginRunning()}`);
    logCookiesState('finalize-before', this.profileDir);
    // DO NOT kill the browser. The daemon will connect to this same CDP-enabled
    // Chromium via puppeteer.connect() — no process restart, no session loss.
    // The login cookies/profile stay alive in the running browser.
    if (!(await this.isHealthy())) {
      console.log('[chrome:finalizeManualLogin] CDP not healthy yet — waiting for browser to start');
      await this._waitForCdp(10000);
      console.log(`[chrome:finalizeManualLogin] CDP healthy=${await this.isHealthy()}`);
    }
    logCookiesState('finalize-after', this.profileDir);
    console.log('[chrome:finalizeManualLogin] done — browser still running, daemon will connect');
    return { manualLogin: false, cdpHealthy: await this.isHealthy() };
  }

  async openListing(exposeIdOrUrl, email, options = {}) {
    const url = String(exposeIdOrUrl || '').startsWith('http')
      ? String(exposeIdOrUrl)
      : `https://www.immobilienscout24.de/expose/${encodeURIComponent(String(exposeIdOrUrl))}`;
    return this.openUrl(url, email, { ...options, visibility: 'always_show' });
  }

  async checkIs24Login() {
    let browser = null;
    try {
      if (!(await this.isHealthy())) return { loggedIn: false, cookies: [] };
      browser = await this._connectExisting();
      let pages = await browser.pages();
      const is24Pages = pages.filter(p => {
        const url = p.url();
        return url.includes('immobilienscout24.de') && !url.includes('sso.immobilienscout24.de');
      });
      const is24Page = is24Pages[0] || pages.find(p => p.url().includes('immobilienscout24'));

      // Background login polling must not open/navigate a tab. That focus-steals
      // on macOS. Do NOT treat generic IS24 cookies as proof of login: logged-out
      // visitors still receive long tracking/consent/session cookies, which caused
      // setup step 3 to say "logged in" before the user had actually authenticated.
      // IS24's current header marks logged-in users with body text like
      // "angemeldet als <email>" and "zu meinem Bereich"; the account link can
      // still contain stale "logged-out" CSS class names, so do not key off class
      // names or require only "Mein Konto" wording.
      const domLoggedIn = (await Promise.all(is24Pages.map(page => page.evaluate(() => {
        const visible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const text = document.body?.innerText || '';
        const loggedInTextRe = /angemeldet\s+als|zu\s+meinem\s+Bereich|Mein\s*Konto|Meine\s*Immobilien|Postfach|Abmelden/i;
        const loggedOutTextRe = /\bAnmelden\b|Einloggen|Jetzt\s+einloggen|Anmelden\s+oder\s+registrieren/i;
        const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
        const interactive = Array.from(document.querySelectorAll('a, button, [role="link"], [role="button"]')).filter(visible);
        const hasLoggedInText = loggedInTextRe.test(text) || interactive.some(el => loggedInTextRe.test(el.textContent || ''));
        const hasLoginUi = interactive.some(el => loggedOutTextRe.test(el.textContent || ''));
        const isLoginPage = /(\/login|\/anmelden|sso\.)/i.test(`${window.location.href} ${window.location.pathname}`);

        // A visible "angemeldet als <email>" header is the strongest signal on
        // the current IS24 homepage. Prefer it even if hidden/stale elements still
        // include logged-out wording in their class names/text serialization.
        if (/angemeldet\s+als/i.test(text) && emailRe.test(text) && !isLoginPage) return true;
        return hasLoggedInText && !hasLoginUi && !isLoginPage;
      }).catch(() => false)))).some(Boolean);

      return { loggedIn: domLoggedIn, cookies: domLoggedIn ? ['session_present'] : [] };
    } catch (err) {
      return { loggedIn: false, cookies: [], error: err.message };
    }
  }

  async getIs24Email() {
    try {
      if (!(await this.isHealthy())) return { email: null, error: 'Chromium not reachable' };
      const browser = await this._connectExisting();
      let page = (await browser.pages()).find(p => p.url().includes('immobilienscout24'));
      if (!page) {
        page = await browser.newPage();
        const url = IS24_HOME;
        await page.evaluate(u => { window.location.href = u; }, url);
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 });
        await new Promise(r => setTimeout(r, 2000));
      }
      const email = await page.evaluate(() => {
        const selectors = ['[data-testid="user-email"]', '.user-email', '[data-email]', 'a[href^="mailto:"]'];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (!el) continue;
          const text = el.textContent?.trim() || el.getAttribute('data-email') || el.getAttribute('href') || '';
          const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
          if (match) return match[0];
        }
        return null;
      });
      return { email, error: null };
    } catch (err) {
      return { email: null, error: err.message };
    }
  }

  async shutdown() {
    try {
      if (this.browser?.isConnected?.()) {
        await this.browser.close();
      } else if (await this.isHealthy()) {
        const browser = await puppeteer.connect({ browserURL: this.cdpUrl, defaultViewport: null });
        await browser.close();
      }
    } catch (err) { swallow(err, 'chrome/shutdown'); }
    this.browser = null;
  }

  async restart(email, options = {}) {
    await this.shutdown();
    await new Promise(r => setTimeout(r, 1000));
    return this.launch(email, options);
  }
}
