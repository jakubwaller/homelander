// Homelander — Electron main process.
// Manages app lifecycle, BrowserWindow, daemon child process,
// Chrome lifecycle, config, and IPC bridge to renderer.

import { app, BrowserWindow, ipcMain, Notification, Tray, Menu, nativeImage, shell, clipboard } from 'electron';
import { fork, spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, readdirSync, statSync, cpSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { homedir, platform } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ChromeManager } from './chrome.js';
import { createSupportId, rawErrorText, redact, toUserError } from '../src/shared/userErrors.js';

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
const SUPPORT_DIR = join(DATA_DIR, 'support-bundles');
const DEBUG_DIR = join(DATA_DIR, 'debug');
const APP_ICON_PNG = join(__dirname, '..', 'resources', 'icon.png');

// ── State ──────────────────────────────────────────────────────

let mainWindow = null;
let daemonProcess = null;
let daemonStatus = 'stopped'; // stopped | running | paused | restarting | session_expired
let daemonStartedAt = 0;      // timestamp of last startDaemon() call
let latestNextPollAt = null;  // last future next_poll_at emitted by daemon poll loop
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

function logRawError(operation, err, context = {}) {
  ensureDataDir();
  const supportId = context.supportId || createSupportId();
  const raw = redact(rawErrorText(err));
  const stack = redact(err?.stack || '');
  const ctx = redact(JSON.stringify(context));
  const line = `[${new Date().toISOString()}] [${supportId}] ${operation} failed raw=${raw} context=${ctx}`;
  try { appendFileSync(DAEMON_LOG, `${line}${stack ? `\n${stack}` : ''}\n`, 'utf8'); } catch {}
  console.error(`[main] ${operation} failed [${supportId}]:`, raw);
  return supportId;
}

function gracefulFailure(operation, err, context = {}) {
  const supportId = logRawError(operation, err, context);
  const userError = toUserError(err, { ...context, operation, supportId });
  return { error: userError.message, userError, supportId };
}

function redactSupportText(text = '') {
  let out = String(text || '');
  const sensitive = [];
  const collect = (obj, path = []) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
      const nextPath = [...path, key];
      if (value && typeof value === 'object') collect(value, nextPath);
      else if (typeof value === 'string' && value.trim().length >= 3) {
        const keyPath = nextPath.join('.');
        if (/email|mail|phone|telefon|tel|name|vorname|nachname|strasse|straße|hausnummer|api[_-]?key|token|secret|password/i.test(keyPath)) {
          sensitive.push([key, value.trim()]);
        }
      }
    }
  };
  collect(config || {});
  for (const [key, value] of sensitive) out = out.split(value).join(`[REDACTED:${key}]`);
  out = out.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED:email]');
  out = out.replace(/(clientKey|api[_-]?key|password|token|secret)(["'\s:=]+)([^"'\s,}]+)/gi, '$1$2[REDACTED]');
  return out;
}

function redactHtmlSnapshot(text = '') {
  // HTML pages are multi-MB and often minified. Keep this deliberately linear:
  // targeted exact replacements + email/API-key patterns only. Broad phone-like
  // regexes and config-wide replacements can lock the Electron main process.
  return redactSupportText(String(text || ''));
}

function redactedConfigSnapshot() {
  const clone = JSON.parse(JSON.stringify(config || {}));
  const scrub = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
      if (/password|api[_-]?key|token|secret/i.test(key)) obj[key] = value ? '[REDACTED]' : '';
      else if (value && typeof value === 'object') scrub(value);
      else if (typeof value === 'string') obj[key] = redactSupportText(value);
    }
  };
  scrub(clone);
  return clone;
}

function safeBundleName(value, fallback = 'global') {
  return String(value || fallback).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || fallback;
}

function writeSupportFile(root, relativePath, content) {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

async function copySupportArtifact(src, root, relativePath, { redactTextFile = false, htmlSnapshot = false } = {}) {
  if (!existsSync(src)) return false;
  const dest = join(root, relativePath);
  mkdirSync(dirname(dest), { recursive: true });
  if (redactTextFile) {
    const raw = await readFile(src, 'utf8');
    await writeFile(dest, htmlSnapshot ? redactHtmlSnapshot(raw) : redactSupportText(raw), 'utf8');
  } else cpSync(src, dest);
  return true;
}

function tailTextFile(path, maxBytes = 400_000) {
  if (!existsSync(path)) return '';
  const raw = readFileSync(path);
  return raw.slice(Math.max(0, raw.length - maxBytes)).toString('utf8');
}

function listDebugArtifacts(exposeId = null, limit = 80) {
  const dirs = [join(DEBUG_DIR, 'screenshots'), join(DEBUG_DIR, 'html')];
  const files = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        if (exposeId && !name.includes(String(exposeId))) continue;
        files.push({ path, name, dir: basename(dir), mtimeMs: st.mtimeMs, size: st.size });
      } catch {}
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, exposeId ? 40 : limit);
}

function trimArtifactsByBudget(files, maxBytes) {
  let used = 0;
  const kept = [];
  for (const file of files) {
    if (used + file.size > maxBytes) continue;
    kept.push(file);
    used += file.size;
  }
  return kept;
}

function matchingLogLines(exposeId, contextLines = 8) {
  if (!exposeId || !existsSync(DAEMON_LOG)) return '';
  const lines = tailTextFile(DAEMON_LOG, 1_000_000).split(/\r?\n/);
  const keep = new Set();
  lines.forEach((line, i) => {
    if (line.includes(String(exposeId))) {
      for (let j = Math.max(0, i - contextLines); j <= Math.min(lines.length - 1, i + contextLines); j += 1) keep.add(j);
    }
  });
  return [...keep].sort((a, b) => a - b).map(i => lines[i]).join('\n');
}

async function createSupportBundle(payload = {}) {
  ensureDataDir();
  mkdirSync(SUPPORT_DIR, { recursive: true });
  const scope = payload?.scope === 'entry' ? 'entry' : 'global';
  const listing = payload?.listing || null;
  const exposeId = listing?.expose_id || listing?.exposeId || null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bundleBase = `homelander-${scope}${exposeId ? `-${safeBundleName(exposeId)}` : ''}-${stamp}`;
  const tempRoot = join(SUPPORT_DIR, `${bundleBase}.tmp`);
  const zipPath = join(SUPPORT_DIR, `${bundleBase}.zip`);
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });

  let dbListing = null;
  if (exposeId) {
    try {
      const { HomelanderDB } = await import('../engine/db.js');
      const db = new HomelanderDB(DB_PATH);
      try { dbListing = db.getHistory(5000, 0).find((row) => String(row.expose_id) === String(exposeId)) || null; }
      finally { db.close(); }
    } catch {}
  }

  const chromeStatus = await chromeManager.isHealthy()
    .then(async (healthy) => ({
      running: healthy || chromeManager.isManualLoginRunning?.() || false,
      manualLogin: chromeManager.isManualLoginRunning?.() || false,
      cdpHealthy: healthy,
      tabCount: healthy ? await chromeManager.getTabCount() : -1,
      maxTabs: browserOptions().maxTabs,
      visibility: browserOptions().visibility,
    }))
    .catch((err) => ({ error: redactSupportText(err?.message || String(err)) }));

  const gitCommit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: join(__dirname, '..'), encoding: 'utf8' });
  const gitStatus = spawnSync('git', ['status', '--short'], { cwd: join(__dirname, '..'), encoding: 'utf8' });
  const metadata = {
    created_at: new Date().toISOString(),
    scope,
    expose_id: exposeId,
    listing: dbListing || listing,
    app: { version: app.getVersion(), isPackaged: app.isPackaged, gitCommit: gitCommit.status === 0 ? gitCommit.stdout.trim() : null },
    daemon: { status: daemonStatus, processAlive: !!daemonProcess, logPath: DAEMON_LOG },
    chrome: chromeStatus,
    configPath: CONFIG_PATH,
    debugDir: DEBUG_DIR,
  };
  writeSupportFile(tempRoot, 'metadata.json', JSON.stringify(JSON.parse(redactSupportText(JSON.stringify(metadata))), null, 2));
  writeSupportFile(tempRoot, 'config.redacted.json', JSON.stringify(redactedConfigSnapshot(), null, 2));
  writeSupportFile(tempRoot, 'git-status.txt', redactSupportText(gitStatus.stdout || gitStatus.stderr || ''));

  if (existsSync(PAUSE_FLAG)) writeSupportFile(tempRoot, 'apply-paused.json', redactSupportText(readFileSync(PAUSE_FLAG, 'utf8')));
  if (existsSync(DAEMON_LOG)) {
    writeSupportFile(tempRoot, 'logs/daemon-tail.log', redactSupportText(tailTextFile(DAEMON_LOG)));
    if (exposeId) writeSupportFile(tempRoot, 'logs/entry-context.log', redactSupportText(matchingLogLines(exposeId) || `No daemon.log lines matched expose ${exposeId}.`));
  }

  const allCandidates = listDebugArtifacts(scope === 'entry' ? exposeId : null, scope === 'entry' ? 40 : 60);

  if (scope === 'entry') {
    // Per-entry: raw copy everything (instant). Logs/config redacted separately.
    for (const artifact of allCandidates) {
      const dest = join(tempRoot, `debug/${artifact.dir}/${artifact.name}`);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(artifact.path, dest);
    }
    writeSupportFile(tempRoot, 'included-files.txt', allCandidates.map((f) => `debug/${f.dir}/${f.name} (${Math.round(f.size / 1024)} KB)`).join('\n') || 'No debug artifacts found.');
  } else {
    // Global: screenshots raw (instant), HTML listed by name only
    const screenshots = trimArtifactsByBudget(allCandidates.filter((f) => f.dir === 'screenshots'), 100 * 1024 * 1024);
    const htmlList = allCandidates.filter((f) => f.dir === 'html');
    for (const artifact of screenshots) {
      cpSync(artifact.path, join(tempRoot, `debug/${artifact.dir}/${artifact.name}`));
    }
    writeSupportFile(
      tempRoot,
      'included-files.txt',
      [
        ...screenshots.map((f) => `debug/${f.dir}/${f.name} (${Math.round(f.size / 1024)} KB)`),
        '',
        `HTML snapshots not included in global bundle (use per-entry Export Debug Bundle).`,
        `Found ${htmlList.length} recent HTML snapshots:`,
        ...htmlList.map((f) => `  debug/${f.dir}/${f.name} (${Math.round(f.size / 1024)} KB)`),
      ].join('\n')
    );
  }

  await new Promise((resolve, reject) => {
    const args = platform() === 'win32'
      ? ['-NoProfile', '-Command', `Compress-Archive -Path "${tempRoot}\\*" -DestinationPath "${zipPath}" -Force`]
      : ['-qr', zipPath, '.'];
    const cmd = platform() === 'win32' ? 'powershell' : (existsSync('/usr/bin/zip') ? '/usr/bin/zip' : 'zip');
    const opts = platform() === 'win32' ? {} : { cwd: tempRoot };
    const child = spawn(cmd, args, opts);
    child.on('close', (code) => {
      rmSync(tempRoot, { recursive: true, force: true });
      if (code !== 0) reject(new Error(`zip exited ${code}`));
      else resolve();
    });
    child.on('error', reject);
  });
  clipboard.writeText(zipPath);
  shell.showItemInFolder(zipPath);
  return { ok: true, path: zipPath, fileName: basename(zipPath), copiedToClipboard: true, files: allCandidates.length };
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
      haustiere_zusatz: '',
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
    browser: {
      visibility: 'hidden_unless_needed',
      max_tabs: 5,
    },
    _setupComplete: false,
  };
}

function browserOptions() {
  return {
    visibility: config?.browser?.visibility || 'hidden_unless_needed',
    maxTabs: Math.min(5, Math.max(1, Number(config?.browser?.max_tabs || 5))),
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
  latestNextPollAt = new Date(Date.now() + (config.polling?.interval_seconds || 120) * 1000).toISOString();
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
    latestNextPollAt = null;
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
    logRawError('daemon spawn', err, { code: 'DAEMON_ACTION_FAILED' });
    daemonProcess = null;
    daemonStatus = 'stopped';
    latestNextPollAt = null;
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
      latestNextPollAt = null;
    }
  }, 5000);
  daemonStatus = 'stopped';
  latestNextPollAt = null;
}

function getNextPollAt(db) {
  if (!daemonProcess || daemonStatus === 'stopped') return null;

  // Prefer the daemon poll loop's own schedule. This is the only source that
  // stays correct while the apply loop is processing a backlog.
  if (latestNextPollAt && new Date(latestNextPollAt).getTime() > Date.now()) {
    return latestNextPollAt;
  }

  const pollIntervalMs = (config?.polling?.interval_seconds || 120) * 1000;
  try {
    const filters = db.getFilters();
    const lastPoll = filters.reduce((max, f) => {
      const t = f.last_polled_at ? new Date(f.last_polled_at).getTime() : 0;
      return t > max ? t : max;
    }, 0);
    if (lastPoll > 0) {
      const fromDb = new Date(lastPoll + pollIntervalMs).toISOString();
      if (new Date(fromDb).getTime() > Date.now()) return fromDb;
    }
  } catch {}

  // Startup / first-cycle fallback: daemon is alive but no future schedule has
  // arrived yet. Show a real countdown instead of the useless "bald" state.
  const fallback = new Date(Date.now() + pollIntervalMs).toISOString();
  latestNextPollAt = fallback;
  return fallback;
}

function handleDaemonEvent(event) {
  if (event?.type === 'stats') {
    const next = event.next_poll_at || event.nextPollAt || null;
    if (next && new Date(next).getTime() > Date.now()) {
      latestNextPollAt = next;
    }
  }

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
            title: '✓ Bewerbung gesendet',
            body: `${event.title} — ${event.address || 'keine Adresse'}`,
            silent: true,
          }).show();
        } else if (event.outcome === 'FAIL') {
          const userError = toUserError(event.detail || event.failureReason || 'Application failed', { operation: 'listing apply' });
          new Notification({
            title: 'Bewerbung braucht Aufmerksamkeit',
            body: `${event.title} — ${userError.title}`,
            silent: true,
          }).show();
        }
      }
      break;
    case 'captcha_wall':
      mainWindow.webContents.send('homelander:event', event);
      if (config.notifications !== false) {
        new Notification({
          title: '🔐 Captcha-Wand erkannt',
          body: `Nach ${event.consecutive} Captchas automatisch für 15 Minuten pausiert`,
          silent: true,
        }).show();
      }
      break;
    case 'session_expired':
      daemonStatus = 'session_expired';
      try { writeFileSync(PAUSE_FLAG, JSON.stringify({ paused_at: new Date().toISOString(), reason: 'session_expired' }), 'utf8'); } catch {}
      mainWindow.webContents.send('homelander:event', {
        type: 'session_expired',
        reason: event.reason,
      });
      if (config.notifications !== false) {
        new Notification({
          title: '⚠ IS24-Anmeldung abgelaufen',
          body: 'Melde dich erneut über Einstellungen → IS24-Konto an',
          silent: false,
        }).show();
      }
      break;
    case 'error': {
      const supportId = logRawError('daemon event', new Error(event.message || 'Daemon error'), { type: event.type });
      const userError = toUserError(event.message || event, { operation: 'daemon', supportId });
      mainWindow.webContents.send('homelander:error', { ...event, message: userError.message, userError, supportId });
      break;
    }
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
    width: 1030,
    height: 680,
    minWidth: 720,
    minHeight: 500,
    title: 'Homelander',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0b',
    icon: APP_ICON_PNG,
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
      // Start means run now. Never inherit a stale persisted pause from an old
      // stop/restart/debug session; Pause is the only action allowed to create it.
      try { unlinkSync(PAUSE_FLAG); } catch {}

      // Launch Chrome first
      const email = config?.is24?.email || config?.persona?.email || 'default';
      await chromeManager.launch(email, browserOptions());
      // Then start the daemon
      startDaemon();
    } catch (err) {
      return { status: daemonStatus, ...gracefulFailure('daemon:start chrome launch', err, { code: 'BROWSER_START_FAILED' }) };
    }
    return { status: daemonStatus };
  });

  ipcMain.handle('daemon:stop', () => {
    daemonStatus = 'stopped'; // must be set BEFORE kill — exit handler checks this
    latestNextPollAt = null;
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
        if (!filter) return { ok: false, error: 'Suche nicht gefunden' };

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
      return { ok: false, ...gracefulFailure('daemon:poll-now', err, { code: 'SEARCH_POLL_FAILED' }) };
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
        if (result.error) return { ok: false, ...gracefulFailure('daemon:retry-listing', new Error(result.error), { code: 'LISTING_RETRY_FAILED', exposeId }) };
        return { ok: true, error: null };
      } finally { db.close(); }
    } catch (err) {
      return { ok: false, ...gracefulFailure('daemon:retry-listing', err, { code: 'LISTING_RETRY_FAILED', exposeId }) };
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
      return { filters: [], ...gracefulFailure('filters:list', err, { code: 'DATABASE_ERROR' }) };
    }
  });

  ipcMain.handle('filters:add', async (_e, webUrl, name) => {
    try {
      const { validateSearchUrl } = await import('../engine/url-translator.js');
      const validation = validateSearchUrl(webUrl);
      if (!validation.ok) {
        return {
          validation,
          ...gracefulFailure('filters:add validate', new Error(validation.error), { code: 'SEARCH_URL_INVALID' }),
        };
      }

      const { HomelanderDB } = await import('../engine/db.js');
      const db = new HomelanderDB(DB_PATH);
      const id = randomUUID();
      db.addFilter({
        id,
        name: name || '',
        web_url: webUrl,
        mobile_params: validation.mobileUrl,
      });
      const filter = db.getFilter(id);
      db.close();
      return { filter, error: null };
    } catch (err) {
      return gracefulFailure('ipc action', err);
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
      return gracefulFailure('filters:remove', err, { code: 'DATABASE_ERROR', filterId: id });
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
      return gracefulFailure('filters:update', err, { code: 'DATABASE_ERROR', filterId: id });
    }
  });

  ipcMain.handle('filters:test', async (_e, webUrl, locale = 'en') => {
    try {
      const { getTotalResults } = await import('../engine/url-translator.js');
      const result = await getTotalResults(webUrl, { locale });
      if (result.error) {
        return {
          total: 0,
          validation: result.validation,
          ...gracefulFailure('filters:test', new Error(result.error), { code: 'SEARCH_URL_INVALID' }),
        };
      }
      return result;
    } catch (err) {
      return { total: 0, ...gracefulFailure('filters:test', err, { code: 'SEARCH_POLL_FAILED' }) };
    }
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
      return { listings: [], ...gracefulFailure('listings:history', err, { code: 'DATABASE_ERROR' }) };
    }
  });

  ipcMain.handle('listings:stats', async (_event, filterId) => {
    try {
      const { HomelanderDB } = await import('../engine/db.js');
      const db = new HomelanderDB(DB_PATH);
      const stats = db.getStats(filterId || null);
      const recent = db.getRecentActivity(20);
      const nextPollAt = getNextPollAt(db);
      db.close();
      return { stats: { ...stats, nextPollAt }, recent, error: null };
    } catch (err) {
      return { stats: { total: 0, sent: 0, failed: 0, deactivated: 0, premium: 0, captcha: 0, seen_unapplied: 0, today: 0, nextPollAt: null }, recent: [], ...gracefulFailure('listings:stats', err, { code: 'DATABASE_ERROR' }) };
    }
  });

  ipcMain.handle('listings:todayStats', async (_event, filterId) => {
    try {
      const { HomelanderDB } = await import('../engine/db.js');
      const db = new HomelanderDB(DB_PATH);
      const stats = db.getTodayStats(filterId || null);
      const nextPollAt = getNextPollAt(db);
      db.close();
      return { stats: { ...stats, nextPollAt }, error: null };
    } catch (err) {
      return { stats: { total: 0, sent: 0, failed: 0, deactivated: 0, premium: 0, captcha: 0, seen_unapplied: 0, today: 0, nextPollAt: null }, ...gracefulFailure('listings:todayStats', err, { code: 'DATABASE_ERROR' }) };
    }
  });

  // Support bundles
  ipcMain.handle('support:bundle', async (_event, payload) => {
    try {
      return await createSupportBundle(payload || { scope: 'global' });
    } catch (err) {
      return { ok: false, ...gracefulFailure('support:bundle', err, { code: 'SUPPORT_BUNDLE_FAILED', scope: payload?.scope, exposeId: payload?.listing?.expose_id || payload?.listing?.exposeId }) };
    }
  });

  // Config
  ipcMain.handle('config:get', () => {
    return config;
  });

  ipcMain.handle('config:update', (_e, patch) => {
    try {
      // Deep merge patch into config
      config = deepMerge(config, patch);
      saveConfig();

    // Hot-reload everything into the running daemon — no restart needed
    if (daemonProcess) {
      const msg = { type: 'config_update' };

      if (patch.message_template !== undefined) msg.message_template = config.message_template;
      if (patch.captcha) msg.captcha = config.captcha;
      if (patch.polling?.interval_seconds !== undefined) msg.poll_interval = config.polling.interval_seconds;
      if (patch.browser) msg.browser = config.browser;

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
    } catch (err) {
      return gracefulFailure('config:update', err, { code: 'CONFIG_SAVE_FAILED', patchKeys: Object.keys(patch || {}) });
    }
  });

  // Chrome
  ipcMain.handle('chrome:status', async () => {
    const healthy = await chromeManager.isHealthy();
    const manualLogin = chromeManager.isManualLoginRunning?.() || false;
    const tabCount = healthy ? await chromeManager.getTabCount() : -1;
    return { running: healthy || manualLogin, manualLogin, cdpHealthy: healthy, tabCount, maxTabs: browserOptions().maxTabs, visibility: browserOptions().visibility };
  });

  ipcMain.handle('chrome:launch', async () => {
    try {
      const email = config?.is24?.email || config?.persona?.email || 'default';
      const result = await chromeManager.launch(email, browserOptions());
      return { ...result, error: null };
    } catch (err) {
      return gracefulFailure('chrome:launch', err, { code: 'BROWSER_START_FAILED' });
    }
  });

  ipcMain.handle('chrome:openLogin', async () => {
    try {
      const email = config?.is24?.email || config?.persona?.email || 'default';
      const result = await chromeManager.openLoginPage(email, browserOptions());
      return { ...result, error: null };
    } catch (err) {
      return gracefulFailure('chrome:openLogin', err, { code: 'BROWSER_START_FAILED' });
    }
  });

  ipcMain.handle('chrome:finalizeManualLogin', async () => {
    try {
      const email = config?.is24?.email || config?.persona?.email || 'default';
      const result = await chromeManager.finalizeManualLogin(email, browserOptions());
      return { ...result, error: null };
    } catch (err) {
      return gracefulFailure('chrome:finalizeManualLogin', err, { code: 'BROWSER_START_FAILED' });
    }
  });

  ipcMain.handle('chrome:openListing', async (_event, exposeIdOrUrl) => {
    try {
      const email = config?.is24?.email || config?.persona?.email || 'default';
      const result = await chromeManager.openListing(exposeIdOrUrl, email, browserOptions());
      return { ...result, error: null };
    } catch (err) {
      return gracefulFailure('chrome:openListing', err, { code: 'BROWSER_START_FAILED', exposeIdOrUrl });
    }
  });

  ipcMain.handle('chrome:checkIs24Login', async () => {
    try {
      if (chromeManager.isManualLoginRunning?.() && !(await chromeManager.isHealthy())) {
        return { loggedIn: false, manualLogin: true, cookies: [], error: null };
      }
      const result = await chromeManager.checkIs24Login();
      return { ...result, error: null };
    } catch (err) {
      return { loggedIn: false, ...gracefulFailure('chrome:checkIs24Login', err, { code: 'BROWSER_NOT_RESPONDING' }) };
    }
  });

  ipcMain.handle('chrome:getIs24Email', async () => {
    try {
      const result = await chromeManager.getIs24Email();
      return { ...result, error: null };
    } catch (err) {
      return { email: null, ...gracefulFailure('chrome:getIs24Email', err, { code: 'BROWSER_NOT_RESPONDING' }) };
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
      return { valid: false, balance: 0, ...gracefulFailure('captcha:validate response', new Error(data.errorDescription || data.errorText || 'Invalid API key'), { code: 'CAPTCHA_KEY_INVALID' }) };
    } catch (err) {
      return { valid: false, balance: 0, ...gracefulFailure('captcha:validate', err, { code: 'CAPTCHA_KEY_INVALID' }) };
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
      return gracefulFailure('data:clean confirm', new Error('Email does not match.'), { code: 'CLEANUP_CONFIRMATION_FAILED' });
    }

    // Stop daemon first
    daemonStatus = 'stopped';
    latestNextPollAt = null;
    try { unlinkSync(PAUSE_FLAG); } catch {}
    stopDaemon();

    // Shutdown Chrome
    chromeManager.shutdown().catch(() => {});

    // Delete data files
    try { unlinkSync(DB_PATH); } catch (err) { logRawError('data:clean db delete', err, { code: 'DATABASE_ERROR' }); }
    try { unlinkSync(CONFIG_PATH); } catch (err) { logRawError('data:clean config delete', err, { code: 'CONFIG_SAVE_FAILED' }); }
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
  app.setName('Homelander');
  if (process.platform === 'darwin' && existsSync(APP_ICON_PNG)) {
    app.dock.setIcon(nativeImage.createFromPath(APP_ICON_PNG));
  }

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
