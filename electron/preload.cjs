// Homelander — Electron preload script.
// Bridges main process ↔ renderer via contextBridge.
// This MUST be CommonJS (.cjs) for contextBridge to work.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('homelander', {
  // ── Daemon ────────────────────────────────────────────────
  startDaemon: () => ipcRenderer.invoke('daemon:start'),
  stopDaemon: () => ipcRenderer.invoke('daemon:stop'),
  pauseDaemon: () => ipcRenderer.invoke('daemon:pause'),
  resumeDaemon: () => ipcRenderer.invoke('daemon:resume'),
  getDaemonStatus: () => ipcRenderer.invoke('daemon:status'),
  pollNow: (filterId) => ipcRenderer.invoke('daemon:poll-now', filterId),

  // ── Filters ───────────────────────────────────────────────
  getFilters: () => ipcRenderer.invoke('filters:list'),
  addFilter: (webUrl, name) => ipcRenderer.invoke('filters:add', webUrl, name),
  removeFilter: (id) => ipcRenderer.invoke('filters:remove', id),
  updateFilter: (id, patch) => ipcRenderer.invoke('filters:update', id, patch),
  testFilter: (webUrl) => ipcRenderer.invoke('filters:test', webUrl),

  // ── Listings / History ────────────────────────────────────
  getHistory: (limit, offset, filterId, outcome) =>
    ipcRenderer.invoke('listings:history', limit, offset, filterId, outcome),
  getStats: () => ipcRenderer.invoke('listings:stats'),
  getTodayStats: () => ipcRenderer.invoke('listings:todayStats'),

  // ── Config ────────────────────────────────────────────────
  getConfig: () => ipcRenderer.invoke('config:get'),
  updateConfig: (patch) => ipcRenderer.invoke('config:update', patch),

  // ── Chrome ────────────────────────────────────────────────
  getChromeStatus: () => ipcRenderer.invoke('chrome:status'),
  launchChrome: () => ipcRenderer.invoke('chrome:launch'),
  openLoginPage: () => ipcRenderer.invoke('chrome:openLogin'),
  checkIs24Login: () => ipcRenderer.invoke('chrome:checkIs24Login'),
  getIs24Email: () => ipcRenderer.invoke('chrome:getIs24Email'),

  // ── Setup ─────────────────────────────────────────────────
  getSetupComplete: () => ipcRenderer.invoke('setup:complete'),
  completeSetup: () => ipcRenderer.invoke('setup:done'),

  // ── Captcha ───────────────────────────────────────────────
  validateCaptchaKey: (key) => ipcRenderer.invoke('captcha:validate', key),

  // ── Events (main → renderer) ──────────────────────────────
  onEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('homelander:event', handler);
    return () => ipcRenderer.removeListener('homelander:event', handler);
  },
  onStats: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('homelander:stats', handler);
    return () => ipcRenderer.removeListener('homelander:stats', handler);
  },
  onListing: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('homelander:listing', handler);
    return () => ipcRenderer.removeListener('homelander:listing', handler);
  },
  onError: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('homelander:error', handler);
    return () => ipcRenderer.removeListener('homelander:error', handler);
  },
});
