// Homelander — Electron main process.
// Manages app lifecycle, BrowserWindow, daemon child process,
// Chrome lifecycle, config, and IPC bridge to renderer.

import { app, BrowserWindow, ipcMain, Notification, Tray, Menu, nativeImage } from 'electron';
import { fork } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
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
const CDP_URL = 'http://localhost:9222';

// ── State ──────────────────────────────────────────────────────

let mainWindow = null;
let daemonProcess = null;
let daemonStatus = 'stopped'; // stopped | running | paused
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
      max_sends_per_run: 0,
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
    console.error('[daemon]', data.toString().trim());
  });

  daemonProcess.on('exit', (code) => {
    console.log(`[daemon] exited with code ${code}`);
    daemonProcess = null;
    daemonStatus = 'stopped';
    if (mainWindow) {
      mainWindow.webContents.send('homelander:event', {
        type: 'daemon_stopped',
        code,
      });
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
  daemonProcess.kill('SIGTERM');
  setTimeout(() => {
    if (daemonProcess) {
      daemonProcess.kill('SIGKILL');
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
      // Native notification on SENT
      if (event.outcome === 'SENT' && config.notifications !== false) {
        new Notification({
          title: 'Application Sent ✓',
          body: `${event.title} — ${event.address}`,
          silent: true,
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
    case 'captcha_wall':
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
    stopDaemon();
    return { status: daemonStatus };
  });

  ipcMain.handle('daemon:pause', () => {
    if (daemonProcess) {
      daemonProcess.kill('SIGSTOP');
      daemonStatus = 'paused';
    }
    return { status: daemonStatus };
  });

  ipcMain.handle('daemon:resume', () => {
    if (daemonProcess) {
      daemonProcess.kill('SIGCONT');
      daemonStatus = 'running';
    }
    return { status: daemonStatus };
  });

  ipcMain.handle('daemon:status', () => {
    return { status: daemonStatus };
  });

  ipcMain.handle('daemon:poll-now', async (_event, filterId) => {
    if (daemonProcess) {
      daemonProcess.send({ type: 'poll_now', filterId });
      return { ok: true };
    }
    return { ok: false, error: 'Daemon not running' };
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

  ipcMain.handle('listings:stats', async () => {
    try {
      const { HomelanderDB } = await import('../engine/db.js');
      const db = new HomelanderDB(DB_PATH);
      const stats = db.getStats();
      const recent = db.getRecentActivity(20);
      db.close();
      return { stats, recent, error: null };
    } catch (err) {
      return { stats: { total: 0, sent: 0, failed: 0, deactivated: 0, premium: 0, captcha: 0, seen_unapplied: 0, today: 0 }, recent: [], error: err.message };
    }
  });

  ipcMain.handle('listings:todayStats', async () => {
    try {
      const { HomelanderDB } = await import('../engine/db.js');
      const db = new HomelanderDB(DB_PATH);
      const stats = db.getTodayStats();
      db.close();
      return { stats, error: null };
    } catch (err) {
      return { stats: { seen: 0, sent: 0, failed: 0, deactivated: 0, seen_unapplied: 0, today: 0 }, error: err.message };
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

    // If daemon is running, restart it with new config
    if (daemonProcess) {
      stopDaemon();
      setTimeout(() => startDaemon(), 1000);
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
