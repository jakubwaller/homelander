// Chrome manager for Homelander.
// Launches Chromium with CDP enabled, headed but offscreen (Datadome-safe).
// Handles profile isolation, tab monitoring, sleep/wake reconnection.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import puppeteer from 'puppeteer';

const CDP_PORT = 9222;
const OFFSCREEN_POSITION = '-32000,-32000';

/**
 * Find the Chromium binary path for the current platform.
 * Order: 1) puppeteer's bundled Chromium (full CDP, self-contained),
 *        2) Electron's bundled Chromium (fallback, limited CDP),
 *        3) system Chrome/Chromium (last resort).
 */
function findChromiumPath() {
  // 1. Puppeteer's bundled Chromium — full CDP (Target.createTarget), self-contained
  try {
    const ppPath = puppeteer.executablePath();
    if (ppPath && existsSync(ppPath)) return ppPath;
  } catch {}

  // 2. Electron's bundled Chromium — limited CDP, fallback
  const electronChromium = join(
    homedir(), 'homelander', 'node_modules', 'electron', 'dist',
    'Electron.app', 'Contents', 'MacOS', 'Electron'
  );
  if (existsSync(electronChromium)) return electronChromium;

  // 3. System Chrome — last resort
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(systemChrome)) return systemChrome;

  return null;
}

/**
 * Get the Chrome profile directory for a given email (persona isolation).
 */
function getProfileDir(email) {
  const hash = createHash('sha256').update(email || 'default').digest('hex').slice(0, 12);
  return join(homedir(), '.homelander', 'chrome-profiles', `profile-${hash}`);
}

export class ChromeManager {
  constructor() {
    this.process = null;
    this.cdpUrl = `http://localhost:${CDP_PORT}`;
    this.profileDir = null;
    this._tabCount = 0;
    this._restartCount = 0;
    this._maxRestartsPerHour = 3;
    this._restartWindow = [];
  }

  /**
   * Launch Chromium with CDP on the given profile.
   * @param {string} email - IS24 account email (for profile isolation)
   * @returns {Promise<{cdpUrl: string, webSocketDebuggerUrl: string}>}
   */
  async launch(email) {
    this.profileDir = getProfileDir(email);

    // If Chrome is already running on our port, reuse it — don't kill the user's session
    if (await this.isHealthy()) {
      console.log('[chrome] Chrome already running on port', CDP_PORT, '— reusing existing session');
      return {
        cdpUrl: `http://localhost:${CDP_PORT}`,
        webSocketDebuggerUrl: null, // daemon will resolve this via IS24Contactor
      };
    }

    const chromiumPath = findChromiumPath();
    if (!chromiumPath) {
      throw new Error('Chromium not found. Please install Google Chrome.');
    }

    if (!existsSync(this.profileDir)) {
      mkdirSync(this.profileDir, { recursive: true });
    }

    // Check restart rate limit
    const now = Date.now();
    this._restartWindow = this._restartWindow.filter(t => now - t < 3600000);
    if (this._restartWindow.length >= this._maxRestartsPerHour) {
      throw new Error('Too many Chrome restarts. Please wait and try again.');
    }
    this._restartWindow.push(now);

    const args = [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${this.profileDir}`,
      `--window-position=${OFFSCREEN_POSITION}`,
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
      // Open IS24 so the window shows the right page, not Electron default
      'https://www.immobilienscout24.de/',
    ];

    return new Promise((resolve, reject) => {
      this.process = spawn(chromiumPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      this.process.stderr.on('data', (data) => {
        const msg = data.toString();
        // Chrome 149+ requires --user-data-dir with --remote-debugging-port
        if (msg.includes('requires a non-default data directory')) {
          reject(new Error('Chrome requires a non-default data directory. Profile issue.'));
        }
      });

      this.process.on('error', (err) => {
        reject(new Error(`Failed to start Chrome: ${err.message}`));
      });

      this.process.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          // Chrome crashed — don't reject here, let the health check handle it
          console.error(`[chrome] Chrome exited with code ${code}`);
        }
        this.process = null;
      });

      // Wait for CDP to become available
      this._waitForCdp(30000)
        .then(resolve)
        .catch(reject);
    });
  }

  async _killExisting() {
    try {
      const resp = await fetch(`http://localhost:${CDP_PORT}/json/version`);
      if (resp.ok) {
        // Chrome already running on our port — try to close it
        try {
          await fetch(`http://localhost:${CDP_PORT}/json/close/all`);
        } catch {}
      }
    } catch {
      // No existing Chrome on this port — good
    }
  }

  async _waitForCdp(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(`http://localhost:${CDP_PORT}/json/version`);
        if (resp.ok) {
          const data = await resp.json();
          return {
            cdpUrl: `http://localhost:${CDP_PORT}`,
            webSocketDebuggerUrl: data.webSocketDebuggerUrl,
          };
        }
      } catch {
        // Not ready yet
      }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`Chrome CDP not available after ${timeoutMs}ms`);
  }

  /**
   * Check if Chrome CDP is reachable and healthy.
   */
  async isHealthy() {
    try {
      const resp = await fetch(`http://localhost:${CDP_PORT}/json/version`, {
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get current tab count from Chrome.
   */
  async getTabCount() {
    try {
      const resp = await fetch(`http://localhost:${CDP_PORT}/json/list`);
      if (!resp.ok) return -1;
      const tabs = await resp.json();
      return tabs.length;
    } catch {
      return -1;
    }
  }

  /**
   * Close old tabs, keeping the most recent `keep` tabs.
   */
  async cleanTabs(keep = 20) {
    try {
      const resp = await fetch(`http://localhost:${CDP_PORT}/json/list`);
      if (!resp.ok) return 0;
      const tabs = await resp.json();
      if (tabs.length <= keep) return 0;

      let closed = 0;
      // Close oldest tabs first (they appear first in the list)
      for (let i = 0; i < tabs.length - keep; i++) {
        try {
          await fetch(`http://localhost:${CDP_PORT}/json/close/${tabs[i].id}`);
          closed++;
        } catch {}
      }
      return closed;
    } catch {
      return 0;
    }
  }

  /**
   * Shut down Chrome gracefully.
   */
  /**
   * Check if the user is logged into IS24 by looking for session cookies via CDP.
   * @returns {Promise<{loggedIn: boolean, cookies: string[]}>}
   */
  async checkIs24Login() {
    let browser = null;
    try {
      // Verify CDP is reachable
      const versionResp = await fetch(`http://localhost:${CDP_PORT}/json/version`);
      if (!versionResp.ok) return { loggedIn: false, cookies: [] };
      const { webSocketDebuggerUrl } = await versionResp.json();
      if (!webSocketDebuggerUrl) return { loggedIn: false, cookies: [] };

      // Connect via Puppeteer
      browser = await puppeteer.connect({
        browserURL: `http://localhost:${CDP_PORT}`,
        defaultViewport: null,
      });

      const pages = await browser.pages();
      const is24Page = pages.find(p => {
        try { return p.url().includes('immobilienscout24'); } catch { return false; }
      });

      if (!is24Page) return { loggedIn: false, cookies: [] };

      // Strategy 1: CDP Network.getCookies (reads HttpOnly cookies that document.cookie misses)
      let cdpCookies = [];
      let hasSessionCookie = false;
      try {
        const cdpSession = await is24Page.createCDPSession();
        const result = await cdpSession.send('Network.getCookies', {
          urls: ['https://www.immobilienscout24.de/'],
        });
        cdpCookies = result.cookies || [];
        await cdpSession.detach();

        // IS24 auth cookies typically have long values; tracking/cookie-consent cookies are short
        hasSessionCookie = cdpCookies.some(c =>
          (c.name.length > 3 && c.value.length > 20) ||
          /(is24|session|sso|login|auth|token|remember)/i.test(c.name)
        );
      } catch {}

      // Strategy 2: Hidden tab — navigate to Mein Konto, check for redirect
      let navigatedOk = false;
      let hiddenPage = null;
      try {
        hiddenPage = await browser.newPage();
        const resp = await hiddenPage.goto('https://www.immobilienscout24.de/meinkonto', {
          waitUntil: 'domcontentloaded',
          timeout: 8000,
        });
        const finalUrl = hiddenPage.url();
        // If we stayed on /meinkonto (or /mein-konto etc.), user is logged in.
        // If redirected to /login, /anmelden, or the homepage, user is NOT logged in.
        navigatedOk = (
          resp && resp.ok() &&
          /mein.?konto/i.test(finalUrl) &&
          !/(\/login|\/anmelden)/i.test(finalUrl)
        );
      } catch {} finally {
        if (hiddenPage) {
          try { await hiddenPage.close(); } catch {}
        }
      }

      // Strategy 3: DOM check on the visible IS24 page
      const domLoggedIn = await is24Page.evaluate(() => {
        const hasMeinKonto = Array.from(document.querySelectorAll('a, button, [role="link"]'))
          .some(el => /Mein\s*Konto/i.test(el.textContent || ''));
        const hasAnmelden = Array.from(document.querySelectorAll('a, button'))
          .some(el => /\bAnmelden\b/i.test(el.textContent || ''));
        const isLoginPage = /(\/login|\/anmelden)/i.test(window.location.pathname);
        return hasMeinKonto && !hasAnmelden && !isLoginPage;
      });

      // Logged in = CDP session cookie present OR hidden tab stayed on mein konto OR DOM shows logged in
      const loggedIn = hasSessionCookie || navigatedOk || domLoggedIn;

      await browser.disconnect();
      return { loggedIn, cookies: loggedIn ? ['session_present'] : [] };
    } catch (err) {
      if (browser) {
        try { await browser.disconnect(); } catch {}
      }
      return { loggedIn: false, cookies: [], error: err.message };
    }
  }

  /**
   * Try to extract the IS24 account email from the logged-in Chrome session.
   * Uses puppeteer-core to evaluate JS in the IS24 page context.
   * @returns {Promise<{email: string|null, error: string|null}>}
   */
  async getIs24Email() {
    try {
      // Dynamic import puppeteer (already a project dependency)
      const puppeteer = (await import('puppeteer')).default;

      // Connect to Chrome
      const versionResp = await fetch(`http://localhost:${CDP_PORT}/json/version`);
      if (!versionResp.ok) return { email: null, error: 'Chrome not reachable' };
      const { webSocketDebuggerUrl } = await versionResp.json();
      if (!webSocketDebuggerUrl) return { email: null, error: 'No CDP WebSocket URL' };

      const browser = await puppeteer.connect({
        browserWSEndpoint: webSocketDebuggerUrl,
        defaultViewport: null,
      });

      // Find an existing IS24 page or open one
      const pages = await browser.pages();
      let page = pages.find(p => p.url().includes('immobilienscout24'));
      
      if (!page) {
        page = await browser.newPage();
        await page.goto('https://www.immobilienscout24.de/', { 
          waitUntil: 'domcontentloaded', 
          timeout: 10000 
        });
        await new Promise(r => setTimeout(r, 2000));
      }

      // Try multiple strategies to extract the email
      const email = await page.evaluate(() => {
        // Strategy 1: Look for email in common IS24 UI elements
        const selectors = [
          '[data-testid="user-email"]',
          '.user-email',
          '[data-email]',
          'a[href^="mailto:"]',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            const text = el.textContent?.trim() || el.getAttribute('data-email') || '';
            const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            if (match) return match[0];
          }
        }

        // Strategy 2: Search all text on page for email patterns near "E-Mail" labels
        const body = document.body?.innerText || '';
        const lines = body.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (/E-Mail|Email|e-mail/i.test(lines[i])) {
            // Check current line and next line for email
            const combined = lines[i] + ' ' + (lines[i + 1] || '');
            const match = combined.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            if (match) return match[0];
          }
        }

        // Strategy 3: Check any mailto links
        const mailtoLinks = document.querySelectorAll('a[href^="mailto:"]');
        for (const link of mailtoLinks) {
          const href = link.getAttribute('href') || '';
          const match = href.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
          if (match) return match[1];
        }

        return null;
      });

      await browser.disconnect();
      return { email, error: null };
    } catch (err) {
      return { email: null, error: err.message };
    }
  }

  async shutdown() {
    try {
      await fetch(`http://localhost:${CDP_PORT}/json/close/all`);
    } catch {}

    if (this.process) {
      this.process.kill('SIGTERM');
      // Force kill after 3 seconds if still running
      setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL');
          this.process = null;
        }
      }, 3000);
    }
  }

  /**
   * Restart Chrome (for tab cleanup or crash recovery).
   */
  async restart(email) {
    await this.shutdown();
    await new Promise(r => setTimeout(r, 2000));
    return this.launch(email);
  }

  /**
   * Open IS24 login page in a VISIBLE Chrome window for the user to log in.
   * This stops any existing offscreen Chrome first (port conflict),
   * then launches a visible window directly to the IS24 login page.
   */
  async openLoginPage(email) {
    // Kill existing Chrome (offscreen) to free the port
    await this.shutdown();
    await new Promise(r => setTimeout(r, 1500));

    const chromiumPath = findChromiumPath();
    if (!chromiumPath) throw new Error('Chromium not found');

    this.profileDir = getProfileDir(email);
    if (!existsSync(this.profileDir)) {
      mkdirSync(this.profileDir, { recursive: true });
    }

    // Launch VISIBLE Chrome (no --window-position flag) directly to IS24
    const args = [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1200,800',
      'https://www.immobilienscout24.de/',
    ];

    return new Promise((resolve, reject) => {
      this.process = spawn(chromiumPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      this.process.on('error', (err) => {
        reject(new Error(`Failed to start Chrome: ${err.message}`));
      });

      this.process.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          console.error(`[chrome] Chrome exited with code ${code}`);
        }
        this.process = null;
      });

      // Wait for CDP to become available, then return
      this._waitForCdp(15000)
        .then(resolve)
        .catch(reject);
    });
  }
}
