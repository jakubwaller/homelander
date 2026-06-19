// Homelander — Main App component.
// Tab-based navigation: Searches, History, Settings.

import React, { useEffect, useState, useCallback } from 'react';
import { useStore } from './stores/appStore';
import SearchTab from './screens/SearchTab';
import HistoryTab from './screens/HistoryTab';
import SettingsTab from './screens/SettingsTab';
import SetupWizard from './screens/SetupWizard';
import StatusDot from './components/StatusDot';

const TABS = [
  { id: 'searches', label: 'Searches' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
];

function normalizeStats(stats) {
  if (!stats) return stats;
  if (stats.total != null) {
    return {
      seen: (stats.total || 0) + (stats.seen_unapplied || 0),
      sent: stats.sent || 0,
      failed: stats.failed || 0,
      deactivated: stats.deactivated || 0,
      premium: stats.premium || 0,
      captcha: stats.captcha || 0,
      seen_unapplied: stats.seen_unapplied || 0,
      today: stats.today || 0,
      nextPollAt: stats.nextPollAt || null,
    };
  }
  return {
    seen: stats.seen || 0,
    sent: stats.sent || 0,
    failed: stats.failed || 0,
    deactivated: stats.deactivated || 0,
    premium: stats.premium || 0,
    captcha: stats.captcha || 0,
    seen_unapplied: stats.seen_unapplied || 0,
    today: stats.today || 0,
    nextPollAt: stats.nextPollAt || stats.next_poll_at || null,
  };
}

export default function App() {
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setupComplete = useStore((s) => s.setupComplete);
  const daemonStatus = useStore((s) => s.daemonStatus);
  const setSetupComplete = useStore((s) => s.setSetupComplete);
  const setConfig = useStore((s) => s.setConfig);
  const setDaemonStatus = useStore((s) => s.setDaemonStatus);
  const setStats = useStore((s) => s.setStats);
  const addActivity = useStore((s) => s.addActivity);
  const setFilters = useStore((s) => s.setFilters);

  // Load initial state from Electron main process
  useEffect(() => {
    async function init() {
      if (!window.homelander) return;

      const config = await window.homelander.getConfig();
      setConfig(config);
      if (config._setupComplete) {
        setSetupComplete(true);
      }

      const { stats, recent, error } = await window.homelander.getStats();
      if (!error) {
        setStats(normalizeStats(stats));
        if (recent) {
          for (const item of recent) {
            addActivity({
              outcome: item.outcome,
              exposeId: item.expose_id || item.exposeId,
              title: item.title,
              price: item.price,
              address: item.address,
              detail: item.detail,
              failureReason: item.failure_reason || item.failureReason,
              time: item.sent_at,
              imageUrl: item.image_url,
            });
          }
        }
      }

      const { filters } = await window.homelander.getFilters();
      if (filters) setFilters(filters);

      const { status } = await window.homelander.getDaemonStatus();
      setDaemonStatus(status);
    }
    init();
  }, []);

  // Listen for daemon events
  useEffect(() => {
    if (!window.homelander) return;

    const unsubs = [];

    unsubs.push(window.homelander.onStats((data) => {
      setStats(normalizeStats(data));
      // Refresh per-search counts so FilterCards stay live
      window.homelander.getFilters().then(({ filters }) => {
        if (filters) setFilters(filters);
      }).catch(() => {});
    }));

    unsubs.push(window.homelander.onListing((data) => {
      addActivity({
        outcome: data.outcome,
        exposeId: data.exposeId,
        title: data.title,
        price: data.price,
        address: data.address,
        detail: data.detail,
        failureReason: data.failureReason,
        time: new Date().toISOString(),
        imageUrl: data.imageUrl,
      });
    }));

    unsubs.push(window.homelander.onEvent((data) => {
      if (data.type === 'daemon_started') setDaemonStatus('running');
      if (data.type === 'daemon_restarting') setDaemonStatus('restarting');
      if (data.type === 'paused') setDaemonStatus('paused');
      if (data.type === 'resumed') setDaemonStatus('running');
      if (data.type === 'daemon_stopped') setDaemonStatus('stopped');
      if (data.type === 'session_expired') setDaemonStatus('paused');
      if (data.type === 'config_applied') {
        // Brief flash — clears after animation
        setDaemonStatus((prev) => prev === 'restarting' ? prev : prev);
        window.dispatchEvent(new CustomEvent('homelander:config-applied'));
      }
      if (data.type === 'retry_queued') {
        window.dispatchEvent(new CustomEvent('homelander:retry-queued', { detail: { exposeId: data.exposeId } }));
      }
    }));

    return () => unsubs.forEach(fn => fn());
  }, []);

  // ── Daemon controls (global, visible from all tabs) ──────────
  const [daemonError, setDaemonError] = useState(null);

  const daemonControlDisabled = daemonStatus === 'restarting';

  const handleToggleDaemon = useCallback(async () => {
    if (!window.homelander) return;
    try {
      if (daemonStatus === 'stopped') {
        const { status } = await window.homelander.startDaemon();
        setDaemonStatus(status || 'running');
      } else if (daemonStatus === 'running') {
        const { status } = await window.homelander.pauseDaemon();
        setDaemonStatus(status || 'paused');
      } else if (daemonStatus === 'paused') {
        const { status } = await window.homelander.resumeDaemon();
        setDaemonStatus(status || 'running');
      }
      setDaemonError(null);
    } catch (err) {
      setDaemonError(err.message || 'Daemon action failed');
    }
  }, [daemonStatus, setDaemonStatus]);

  const handleStopDaemon = useCallback(async () => {
    if (!window.homelander) return;
    try {
      const { status } = await window.homelander.stopDaemon();
      setDaemonStatus(status || 'stopped');
      setDaemonError(null);
    } catch (err) {
      setDaemonError(err.message || 'Failed to stop daemon');
    }
  }, [setDaemonStatus]);

  // Show setup wizard on first launch
  if (!setupComplete) {
    return <SetupWizard onComplete={() => setSetupComplete(true)} />;
  }

  return (
    <div className="flex flex-col h-screen">
      {/* Titlebar (draggable region for macOS hiddenInset) */}
      <div className="titlebar" />

      {/* Header */}
      <header className="flex items-center justify-between px-5 pb-2">
        {/* Left: title + controls grouped */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-base">🏠</span>
            <h1 className="text-lg font-semibold tracking-tight">Homelander</h1>
          </div>
          <div
            className="flex items-center gap-3 px-2.5 py-1 rounded"
          >
          <StatusDot status={daemonStatus} />
          <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
            {daemonStatus === 'running' ? 'Active'
              : daemonStatus === 'paused' ? 'Paused'
              : daemonStatus === 'restarting' ? 'Restarting…'
              : 'Stopped'}
          </span>
          <button
            className="flex items-center justify-center w-6 h-6 rounded-full cursor-pointer select-none transition-all"
            onClick={handleToggleDaemon}
            disabled={daemonControlDisabled}
            title={daemonStatus === 'stopped' ? 'Start' : daemonStatus === 'running' ? 'Pause' : daemonStatus === 'restarting' ? 'Restarting…' : 'Resume'}
            style={{
              fontSize: '13px',
              background: daemonStatus === 'stopped' ? 'rgba(59,130,246,0.15)' : daemonStatus === 'running' ? 'rgba(245,158,11,0.18)' : daemonStatus === 'restarting' ? 'rgba(156,163,175,0.12)' : 'rgba(59,130,246,0.15)',
              color: daemonStatus === 'stopped' ? 'var(--accent)' : daemonStatus === 'running' ? 'var(--warning)' : daemonStatus === 'restarting' ? 'var(--text-muted)' : 'var(--accent)',
              opacity: daemonControlDisabled ? 0.4 : 1,
            }}
          >
            {daemonStatus === 'stopped' ? '▶' : daemonStatus === 'running' ? '⏸' : daemonStatus === 'restarting' ? '⏳' : '▶'}
          </button>
          {daemonStatus !== 'stopped' && daemonStatus !== 'restarting' && (
            <button
              className="flex items-center justify-center w-6 h-6 rounded-full cursor-pointer select-none transition-all"
              onClick={handleStopDaemon}
              title="Stop"
              style={{ fontSize: '13px', background: 'rgba(239,68,68,0.12)', color: 'var(--danger)' }}
            >
              ⏹
            </button>
          )}
          {daemonError && (
            <span className="text-xs" style={{ color: 'var(--danger)' }}>{daemonError}</span>
          )}
        </div>
        </div>

        {/* Right: tabs */}
        <nav className="flex gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto px-5 pb-5">
        {activeTab === 'searches' && <SearchTab />}
        {activeTab === 'history' && <HistoryTab />}
        {activeTab === 'settings' && <SettingsTab />}
      </main>
    </div>
  );
}
