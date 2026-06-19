// Homelander — Electron main process.
// Manages app lifecycle, BrowserWindow, daemon child process,
// Chrome lifecycle, config, and IPC bridge to renderer.

import { app, BrowserWindow, ipcMain, Notification, Tray, Menu, nativeImage } from 'electron';
import { fork } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ChromeManager } from './chrome.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

// Single-instance lock — prevents duplicate Electron processes
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  // Focus existing window instead of opening a second one
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ── Paths ──────────────────────────────────────────────────────

const DATA_DIR = join(homedir(), '.homelander');
const DB_PATH = join(DATA_DIR, 'homelander.db');
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const DAEMON_SCRIPT = join(__dirname, '..', 'engine', 'daemon.js');
const DAEMON_LOG = join(DATA_DIR, 'daemon.log');
const CDP_URL = 'http://localhost:9222';
const PAUSE_FLAG = join(DATA_DIR, '.apply-paused');

// ── State ──────────────────────────────────────────────────────

let mainWindow = null;
let daemonProcess = null;
let daemonStatus = 'stopped'; // stopped | running | paused
let daemonStartedAt = 0;      // timestamp of last startDaemon() call
let _stopKillTimer = null;    // SIGKILL timeout handle — cleared on start to prevent cross-fire
let chromeManager = new ChromeManager();
let config = null;
let setupComplete = false;

// ── Config ─────────────────────────────────────────────────────

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadConfig() {
  ensureDataDir();
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    config = JSON.parse(raw);
    setupComplete = config._setupComplete || false;
    return config;
  } catch {
    config = getDefaultConfig();
    setupComplete = false;
    return config;
  }
}

function saveConfig() {
  ensureDataDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

function getDefaultConfig() {
  return {
    persona: {
      anrede: '',
      vorname: '',
      nachname: '',
      email: '',
      telefon: '',
      strasse: '',
      hausnummer: '',
      plz: '',
      ort: '',
      einzug: '',
      personen: '',
      haustiere: '',
      beschaeftigung: '',
      einkommen: '',
      unterlagen: '',
    },
    is24: {
      email: '',
      password: '',
    },
    captcha: {
      api_key: '',
    },
    message_template: [
      'Sehr geehrte Damen und Herren,',
      '',
      'ich interessiere mich für {{title}} in {{address}}.',
      '',
      'Mit freundlichen Grüßen',
      '{{name}}',
    ].join('\n'),
    timing: {
      speed: 'balanced',
      overrides: {},
    },
    polling: {
      interval_seconds: 600,
    },
    _setupComplete: false,
  };
}

// ── Daemon ────────────────────────────────────────────────────

function startDaemon() {
  if (daemonProcess) return;

  // Cancel any pending stop-SIGKILL to prevent cross-firing on this new daemon
  if (_stopKillTimer) { clearTimeout(_stopKillTimer); _stopKillTimer = null; }

  // Write current config for daemon to read
  ensureDataDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');

  daemonProcess = fork(DAEMON_SCRIPT, [
    `--db=${DB_PATH}`,
    `--cdp-url=${CDP_URL}`,
    `--config=${CONFIG_PATH}`,
    `--poll-interval=${config.polling?.interval_seconds || 120}`,
  ], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HOMELANDER_DEBUG_DIR: join(DATA_DIR, 'debug'),
    },
  });

  daemonStatus = 'running';
  daemonStartedAt = Date.now();
  if (mainWindow) {
    mainWindow.webContents.send('homelander:event', { type: 'daemon_started' });
  }

  // Parse stdout JSON lines for events
  let buffer = '';
  daemonProcess.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        handleDaemonEvent(event);
      } catch {
        // Non-JSON line (log output) — ignore
      }
    }
  });

  daemonProcess.stderr.on('data', (data) => {
    const text = data.toString().trim();
    console.error('[daemon]', text);
    try { appendFileSync(DAEMON_LOG, text + '\n', 'utf8'); } catch {}
  });

  daemonProcess.on('exit', (code) => {
    console.log(`[daemon] exited with code ${code}`);
    daemonProcess = null;
    // Clear any pending SIGKILL timer — process already exited cleanly
    if (_stopKillTimer) { clearTimeout(_stopKillTimer); _stopKillTimer = null; }
    const wasRunning = daemonStatus === 'running' || daemonStatus === 'paused';
    daemonStatus = 'stopped';
    if (mainWindow) {
      mainWindow.webContents.send('homelander:event', {
        type: 'daemon_stopped',
        code,
      });
    }
    // Auto-restart on unexpected exit (not user-requested stop).
    // Only auto-restart if the daemon ran for at least 3 seconds —
    // immediate crashes indicate a startup bug and restarting would loop.
    const ranLongEnough = (Date.now() - daemonStartedAt) > 3000;
    if (wasRunning && !app.isQuitting && ranLongEnough) {
      console.log('[daemon] auto-restarting in 5s...');
      daemonStatus = 'restarting';
      if (mainWindow) {
        mainWindow.webContents.send('homelander:event', { type: 'daemon_restarting' });
      }
      setTimeout(() => {
        if (!daemonProcess && !app.isQuitting) {
          console.log('[daemon] restarting...');
          startDaemon();
        }
      }, 5000);
    }
  });

  daemonProcess.on('error', (err) => {
    console.error('[daemon] spawn error:', err.message);
    daemonProcess = null;
    daemonStatus = 'stopped';
  });
}

function stopDaemon() {
  if (!daemonProcess) return;

  // Clear any previous stop timer
  if (_stopKillTimer) { clearTimeout(_stopKillTimer); _stopKillTimer = null; }

  const proc = daemonProcess; // capture reference — never cross-fire on a newer daemon
  proc.kill('SIGTERM');
  _stopKillTimer = setTimeout(() => {
    _stopKillTimer = null;
    // Only SIGKILL if this is still the SAME process AND still alive
    if (daemonProcess === proc) {
      try { proc.kill('SIGKILL'); } catch {}
      daemonProcess = null;
    }
  }, 5000);
  daemonStatus = 'stopped';
}

function handleDaemonEvent(event) {
  if (!mainWindow) return;

  switch (event.type) {
    case 'stats':
      mainWindow.webContents.send('homelander:stats', event);
      break;
    case 'listing':
      mainWindow.webContents.send('homelander:listing', event);
      // Native notification
      if (config.notifications !== false) {
        if (event.outcome === 'SENT') {
          new Notification({
            title: '✓ Application Sent',
            body: `${event.title} — ${event.address || 'no address'}`,
            silent: true,
          }).show();
        } else if (event.outcome === 'FAIL') {
          new Notification({
            title: '✗ Application Failed',
            body: `${event.title} — ${(event.detail || '').substring(0, 80)}`,
            silent: true,
          }).show();
        }
      }
      break;
    case 'captcha_wall':
      mainWindow.webContents.send('homelander:event', event);
      if (config.notifications !== false) {
        new Notification({
          title: '🔐 Captcha Wall Detected',
          body: `Auto-paused for 15 minutes after ${event.consecutive} captchas`,
          silent: true,
        }).show();
      }
      break;
    case 'session_expired':
      daemonStatus = 'paused';
      mainWindow.webContents.send('homelander:event', {
        type: 'session_expired',
        reason: event.reason,
      });
      if (config.notifications !== false) {
        new Notification({
          title: '⚠ IS24 Session Expired',
          body: 'Log in again via Settings → IS24 Account',
          silent: false,
        }).show();
      }
      break;
    case 'error':
      mainWindow.webContents.send('homelander:error', event);
      break;
    case 'paused':
      daemonStatus = 'paused';
      mainWindow.webContents.send('homelander:event', event);
      break;
    case 'resumed':
      daemonStatus = 'running';
      mainWindow.webContents.send('homelander:event', event);
      break;
    default:
      mainWindow.webContents.send('homelander:event', event);
  }
}

// ── Window ─────────────────────────────────────────────────────

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 720,
    minHeight: 500,
    title: 'Homelander',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0b',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Load renderer
  if (isDev) {
    // Wait for Vite dev server to be ready (retry up to 30s)
    const deadline = Date.now() + 30000;
    let loaded = false;
    while (Date.now() < deadline) {
      try {
        await mainWindow.loadURL('http://localhost:5173');
        loaded = true;
        break;
      } catch {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (!loaded) {
      // Show helpful error in the window instead of Electron's default screen
      mainWindow.loadURL(`data:text/html,<html><body style="background:#0a0a0b;color:#ededef;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>Homelander</h2><p style="color:#9d9da5">Vite dev server not running.</p><p style="color:#63636b;font-size:13px">Run <code style="background:#1c1c1f;padding:2px 6px;border-radius:4px">npm run dev:renderer</code> in another terminal, then restart.</p></div></body></html>`);
    }
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    try {
      await mainWindow.loadFile(join(__dirname, '..', 'dist', 'index.html'));
    } catch {
      mainWindow.loadURL(`data:text/html,<html><body style="background:#0a0a0b;color:#ededef;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>Homelander</h2><p style="color:#9d9da5">App not built.</p><p style="color:#63636b;font-size:13px">Run <code style="background:#1c1c1f;padding:2px 6px;border-radius:4px">npm run build</code> then restart.</p></div></body></html>`);
    }
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Close = hide to background (not quit)
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── IPC Handlers ───────────────────────────────────────────────

function registerIpcHandlers() {
  // Daemon
  ipcMain.handle('daemon:start', async () => {
    try {
      // Launch Chrome first
      const email = config?.is24?.email || config?.persona?.email || 'default';
      await chromeManager.launch(email);
      // Then start the daemon
      startDaemon();
    } catch (err) {
      console.error('[main] Chrome launch failed:', err.message);
      return { status: daemonStatus, error: err.message };
    }
    return { status: daemonStatus };
  });

  ipcMain.handle('daemon:stop', () => {
    daemonStatus = 'stopped'; // must be set BEFORE kill — exit handler checks this
    try { unlinkSync(PAUSE_FLAG); } catch {} // clear pause flag so restart doesn't inherit pause
    stopDaemon();
    return { status: daemonStatus };
  });

  ipcMain.handle('daemon:pause', () => {
    if (daemonProcess && daemonProcess.connected) {
      // Write filesystem flag so daemon can check it as belt-and-suspenders
      writeFileSync(PAUSE_FLAG, JSON.stringify({ paused_at: new Date().toISOString(), reason: 'manual' }), 'utf8');
      daemonProcess.send({ type: 'pause_apply' });
      daemonStatus = 'paused';
    } else if (!daemonProcess) {
      // Daemon not running — write flag for when it starts
      writeFileSync(PAUSE_FLAG, JSON.stringify({ paused_at: new Date().toISOString(), reason: 'manual' }), 'utf8');
      daemonStatus = 'paused';
    }
    return { status: daemonStatus };
  });

  ipcMain.handle('daemon:resume', () => {
    try { unlinkSync(PAUSE_FLAG); } catch {}
    if (daemonProcess && daemonProcess.connected) {
      daemonProcess.send({ type: 'resume_apply' });
      daemonStatus = 'running';
    } else if (!daemonProcess) {
      daemonStatus = 'running';
    }
    return { status: daemonStatus };
  });

  ipcMain.handle('daemon:status', () => {
    return { status: daemonStatus };
  });

  ipcMain.handle('daemon:poll-now', async (_event, filterId) => {
    try {
      const { HomelanderDB } = await import('../engine/db.js');
      const { fetchListings } = await import('../engine/url-translator.js');
      const db = new HomelanderDB(DB_PATH);
      try {
        const filter = db.getFilter(filterId);
        if (!filter) return { ok: false, error: 'Search not found' };

        // Multi-page: fetch up to 5 pages, stop when page < 20 or 0 new
        const MAX_PAGES = 5, PAGE_SIZE = 20;
        let allInserted = 0, allFetched = 0;
        for (let page = 1; page <= MAX_PAGES; page++) {
          const { listings, error } = await fetchListings(filter.web_url, page);
          if (error) break;
          allFetched += listings.length;
          const inserted = db.insertListings(listings, filter.id);
          allInserted += inserted;
          if (listings.length < PAGE_SIZE) break;
          if (inserted === 0) break;
        }

        db.updateFilter(filter.id, {
          last_polled_at: new Date().toISOString(),
          total_seen: (filter.total_seen || 0) + allInserted,
        });

        const stats = db.getStats();
        if (mainWindow) {
          mainWindow.webContents.send('homelander:event', { type: 'stats', ...stats });
          if (allInserted > 0) {
            mainWindow.webContents.send('homelander:event', {
              type: 'poll_complete',
              filter_id: filter.id,
              inserted: allInserted,
            });
          }
        }

        return { ok: true, inserted: allInserted, fetched: allFetched };
      } finally {
        db.close();
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Retry a failed listing via the daemon
  ipcMain.handle('daemon:retry-listing', async (_event, exposeId) => {
    if (daemonProcess && daemonProcess.connected) {
      daemonProcess.send({ type: 'retry_listing', exposeId });
      return { ok: true };
    }
    // Fallback: direct DB access when daemon not running
    try {
      const { HomelanderDB } = await import('../engine/db.js');
      const db = new HomelanderDB(DB_PATH);
      try {
        const result = db.retryListing(exposeId);
        return { ok: !result.error, error: result.error };
      } finally { db.close(); }
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Filters
  ipcMain.handle('filters:list', async () => {
    try {
      const { HomelanderDB } = await import('../engine/db.js');
      const db = new HomelanderDB(DB_PATH);
      const filters = db.getFilters();
      db.close();
      return { filters, error: null };
    } catch (err) {
      return { filters: [], error: err.message };
    }
  });

  ipcMain.handle('filters:add', async (_e, webUrl, name) => {
    try {
      const { translateUrl } = await import('../engine/url-translator.js');
      const { fullUrl, error } = translateUrl(webUrl);
      if (error) return { error };

      const { HomelanderDB } = await import('../engine/db.js');
      const db = new HomelanderDB(DB_PATH);
      const id = randomUUID();
      db.addFilter({
        id,
        name: name || '',
        web_url: webUrl,
        mobile_params: fullUrl,
      });
      const filter = db.getFilter(id);
      db.close();
      return { filter, error: null };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('filters:remove', async (_e, id) => {
    try {
      const { HomelanderDB } = await import('../engine/db.js');
      const db = new HomelanderDB(DB_PATH);
      db.removeFilter(id);
      db.close();
      return { error: null };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('filters:update', async (_e, id, patch) => {
    try {
      const { HomelanderDB } = await import('../engine/db.js');
      const db = new HomelanderDB(DB_PATH);
      db.updateFilter(id, patch);
      db.close();
      return { error: null };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('filters:test', async (_e, webUrl) => {
    const { getTotalResults } = await import('../engine/url-translator.js');
    return getTotalResults(webUrl);
  });

  // Listings
  ipcMain.handle('listings:history', async (_e, limit, offset, filterId, outcome) => {
    try {
      const { HomelanderDB } = await import('../engine/db.js');
      const db = new HomelanderDB(DB_PATH);
      const listings = db.getHistory(limit || 100, offset || 0, filterId, outcome);
      db.close();
      return { listings, error: null };
    } catch (err) {
      return { listings: [], error: err.message };
    }
  });

  ipcMain.handle('listings:stats', async (_event, filterId) => {
    try {
      const { HomelanderDB } = await import('../engine/db.js');
      const db = new HomelanderDB(DB_PATH);
      const stats = db.getStats(filterId || null);
      const recent = db.getRecentActivity(20);
      // Compute next poll estimate only when daemon is alive.
      // When stopped, leave null — the UI shows nothing instead of stale "any moment".
      let nextPollAt = null;
      if (daemonProcess && daemonStatus !== 'stopped') {
        try {
          const filters = db.getFilters();
          const pollIntervalMs = (config.polling?.interval_seconds || 120) * 1000;
          const lastPoll = filters.reduce((max, f) => {
            const t = f.last_polled_at ? new Date(f.last_polled_at).getTime() : 0;
            return t > max ? t : max;
          }, 0);
          if (lastPoll > 0) {
            nextPollAt = new Date(lastPoll + pollIntervalMs).toISOString();
          }
        } catch {}
      }
      db.close();
      return { stats: { ...stats, nextPollAt }, recent, error: null };
    } catch (err) {
      return { stats: { total: 0, sent: 0, failed: 0, deactivated: 0, premium: 0, captcha: 0, seen_unapplied: 0, today: 0, nextPollAt: null }, recent: [], error: err.message };
    }
  });

  ipcMain.handle('listings:todayStats', async (_event, filterId) => {
    try {
      const { HomelanderDB } = await import('../engine/db.js');
      const db = new HomelanderDB(DB_PATH);
      const stats = db.getTodayStats(filterId || null);
      db.close();
      return { stats, error: null };
    } catch (err) {
      return { stats: { total: 0, sent: 0, failed: 0, deactivated: 0, premium: 0, captcha: 0, seen_unapplied: 0, today: 0 }, error: err.message };
    }
  });

  // Config
  ipcMain.handle('config:get', () => {
    return config;
  });

  ipcMain.handle('config:update', (_e, patch) => {
    // Deep merge patch into config
    config = deepMerge(config, patch);
    saveConfig();

    // Hot-reload everything into the running daemon — no restart needed
    if (daemonProcess) {
      const msg = { type: 'config_update' };

      if (patch.message_template !== undefined) msg.message_template = config.message_template;
      if (patch.captcha) msg.captcha = config.captcha;
      if (patch.polling?.interval_seconds !== undefined) msg.poll_interval = config.polling.interval_seconds;

      const personaChanged = patch.persona && Object.keys(patch.persona).length > 0;
      const timingChanged = patch.timing && Object.keys(patch.timing).length > 0;
      if (personaChanged) msg.persona = config.persona;
      if (timingChanged) msg.timing = config.timing;

      if (Object.keys(msg).length > 1) { // more than just 'type'
        console.log('[main] Hot-reloading config into running daemon');
        daemonProcess.send(msg);
      }
    }

    return { error: null };
  });

  // Chrome
  ipcMain.handle('chrome:status', async () => {
    const healthy = await chromeManager.isHealthy();
    const tabCount = healthy ? await chromeManager.getTabCount() : -1;
    return { running: healthy, tabCount };
  });

  ipcMain.handle('chrome:launch', async () => {
    try {
      const email = config?.is24?.email || config?.persona?.email || 'default';
      const result = await chromeManager.launch(email);
      return { ...result, error: null };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('chrome:openLogin', async () => {
    try {
      const email = config?.is24?.email || config?.persona?.email || 'default';
      const result = await chromeManager.openLoginPage(email);
      return { ...result, error: null };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('chrome:checkIs24Login', async () => {
    try {
      const result = await chromeManager.checkIs24Login();
      return { ...result, error: null };
    } catch (err) {
      return { loggedIn: false, error: err.message };
    }
  });

  ipcMain.handle('chrome:getIs24Email', async () => {
    try {
      const result = await chromeManager.getIs24Email();
      return { ...result, error: null };
    } catch (err) {
      return { email: null, error: err.message };
    }
  });

  // 2captcha
  ipcMain.handle('captcha:validate', async (_e, apiKey) => {
    try {
      const resp = await fetch('https://api.2captcha.com/getBalance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json();
      if (data.errorId === 0) {
        return { valid: true, balance: data.balance, error: null };
      }
      return { valid: false, balance: 0, error: data.errorDescription || data.errorText || 'Invalid API key' };
    } catch (err) {
      return { valid: false, balance: 0, error: err.message };
    }
  });
  ipcMain.handle('setup:complete', () => {
    return { complete: setupComplete };
  });

  ipcMain.handle('setup:done', () => {
    setupComplete = true;
    config._setupComplete = true;
    saveConfig();
    return { error: null };
  });

  ipcMain.handle('app:quit', () => {
    app.isQuitting = true;
    app.quit();
    return { ok: true };
  });

  ipcMain.handle('data:clean', (_event, confirmEmail) => {
    // Verify email matches configured email
    const configuredEmail = config?.persona?.email || config?.is24?.email || '';
    if (!configuredEmail || confirmEmail !== configuredEmail) {
      return { error: 'Email does not match.' };
    }

    // Stop daemon first
    daemonStatus = 'stopped';
    try { unlinkSync(PAUSE_FLAG); } catch {}
    stopDaemon();

    // Shutdown Chrome
    chromeManager.shutdown().catch(() => {});

    // Delete data files
    try { unlinkSync(DB_PATH); } catch (err) { console.error('[clean] db delete:', err.message); }
    try { unlinkSync(CONFIG_PATH); } catch (err) { console.error('[clean] config delete:', err.message); }
    try { unlinkSync(PAUSE_FLAG); } catch {}

    // Relaunch fresh — config will be recreated with defaults
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });
}

// ── Helpers ────────────────────────────────────────────────────

function deepMerge(target, patch) {
  const result = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') {
      result[key] = deepMerge(target[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ── App Lifecycle ──────────────────────────────────────────────

app.whenReady().then(async () => {
  loadConfig();
  registerIpcHandlers();
  await createWindow();

  // Don't auto-launch Chrome or daemon — user clicks "Start" when ready
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

app.on('window-all-closed', () => {
  // Don't quit on macOS — app stays in background
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopDaemon();
  chromeManager.shutdown().catch(() => {});
});
