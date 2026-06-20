// Bundled Chromium manager for Homelander.
// Owns one Puppeteer-managed Chromium profile, keeps CDP available for the daemon,
// and controls browser visibility without touching user-owned tabs.

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const CDP_PORT = 9222;
const DEFAULT_MAX_TABS = 5;
const DEFAULT_WINDOW_POSITION = { left: 80, top: 60, width: 1200, height: 850 };
const IS24_HOME = 'https://www.immobilienscout24.de/';

function getBundledChromiumPath() {
  try {
    const executablePath = puppeteer.executablePath();
    if (executablePath && existsSync(executablePath)) return executablePath;
  } catch {}
  return null;
}

function getProfileDir(email) {
  const hash = createHash('sha256').update(email || 'default').digest('hex').slice(0, 12);
  return join(homedir(), '.homelander', 'chrome-profiles', `profile-${hash}`);
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
    const opts = this._options(options);
    this.profileDir = getProfileDir(email);

    if (await this.isHealthy()) {
      await this._connectExisting().catch(() => {});
      if (opts.visibility === 'always_show') await this.showBrowser();
      else await this.hideBrowser().catch(() => {});
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

    this.browser = await puppeteer.launch({
      executablePath,
      headless: false,
      defaultViewport: null,
      userDataDir: this.profileDir,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        `--remote-debugging-port=${CDP_PORT}`,
        opts.visibility === 'always_show' ? '--window-size=1200,850' : `--window-position=${DEFAULT_WINDOW_POSITION.left},${DEFAULT_WINDOW_POSITION.top}`,
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

    this.browser.on('disconnected', () => { this.browser = null; });

    await this._waitForCdp(30000);
    const pages = await this.browser.pages();
    if (pages.length === 0) await this.browser.newPage();
    const page = (await this.browser.pages())[0];
    if (page && page.url() === 'about:blank') {
      await page.goto(IS24_HOME, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }
    return this._versionInfo();
  }

  async _connectExisting() {
    if (this.browser?.isConnected?.()) return this.browser;
    this.browser = await puppeteer.connect({ browserURL: this.cdpUrl, defaultViewport: null });
    this.browser.on('disconnected', () => { this.browser = null; });
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
      } catch {}
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
      await session.detach().catch(() => {});
    }
  }
  async showBrowser() {
    const browser = await this._connectExisting();
    const page = (await browser.pages())[0];
    if (!page) return;
    await this._setWindowBounds(page, DEFAULT_WINDOW_POSITION);
    await page.bringToFront().catch(() => {});
  }

  async hideBrowser() {
    // No-op: keep browser at default position — don't drag off-screen.
    // macOS handles background windows fine without forced positioning.
  }

  async openUrl(url, email, options = {}) {
    const opts = this._options(options);
    await this.launch(email, { ...opts, visibility: 'always_show' });
    const browser = await this._connectExisting();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await this.showBrowser();
    return this._versionInfo();
  }

  async openLoginPage(email, options = {}) {
    return this.openManualLoginPage(email, options);
  }

  isManualLoginRunning() {
    return !!this.manualLoginProcess && this.manualLoginProcess.exitCode === null && !this.manualLoginProcess.killed;
  }

  async openManualLoginPage(email, options = {}) {
    this.profileDir = getProfileDir(email);
    mkdirSync(this.profileDir, { recursive: true });

    // Login/SSO pages are more aggressive than expose pages. Opening login via
    // Puppeteer/CDP exposes automation flags and can trigger visual challenges
    // ("find the stairs"). For the one-time manual login, run the same bundled
    // Chromium profile as a plain user-started process: no CDP, no Puppeteer
    // connection, no --enable-automation. The manual browser stays open
    // after login; CDP launches later when the daemon starts.
    if (await this.isHealthy()) await this.shutdown();
    if (this.isManualLoginRunning()) return { manualLogin: true, profileDir: this.profileDir };

    const executablePath = getBundledChromiumPath();
    if (!executablePath) {
      throw new Error('Bundled Chromium not found. Run npm install so Puppeteer can install its browser.');
    }

    this.manualLoginProcess = spawn(executablePath, [
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1200,850',
      IS24_HOME,
    ], {
      detached: false,
      stdio: 'ignore',
    });
    this.manualLoginProcess.once('exit', () => { this.manualLoginProcess = null; });
    this.manualLoginProcess.unref();
    return { manualLogin: true, profileDir: this.profileDir };
  }

  async finalizeManualLogin(email, options = {}) {
    // Leave the manual-login Chromium open — user is logged in, keep it.
    // CDP-controlled browser launches later when the daemon starts.
    return { manualLogin: !!this.isManualLoginRunning(), cdpHealthy: false };
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
        await page.goto(IS24_HOME, { waitUntil: 'domcontentloaded', timeout: 10000 });
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
    } catch {}
    this.browser = null;
  }

  async restart(email, options = {}) {
    await this.shutdown();
    await new Promise(r => setTimeout(r, 1000));
    return this.launch(email, options);
  }
}
