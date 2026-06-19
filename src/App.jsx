// Homelander — Main App component.
// Tab-based navigation: Searches, History, Settings.

import React, { useEffect } from 'react';
import { useStore } from './stores/appStore';
import SearchTab from './screens/SearchTab';
import HistoryTab from './screens/HistoryTab';
import SettingsTab from './screens/SettingsTab';
import SetupWizard from './screens/SetupWizard';

const TABS = [
  { id: 'searches', label: 'Searches' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
];

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
        setStats(stats);
        if (recent) {
          for (const item of recent) {
            addActivity({
              outcome: item.outcome,
              title: item.title,
              price: item.price,
              address: item.address,
              detail: item.detail,
              time: item.sent_at,
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
      setStats({
        seen: data.seen,
        sent: data.sent,
        failed: data.failed,
        deactivated: data.deactivated || 0,
        seen_unapplied: data.seen_unapplied,
        today: data.today,
        nextPollAt: data.next_poll_at || null,
      });
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
      });
    }));

    unsubs.push(window.homelander.onEvent((data) => {
      if (data.type === 'paused') setDaemonStatus('paused');
      if (data.type === 'resumed') setDaemonStatus('running');
      if (data.type === 'daemon_stopped') setDaemonStatus('stopped');
    }));

    return () => unsubs.forEach(fn => fn());
  }, []);

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
        <h1 className="text-lg font-semibold tracking-tight">Homelander</h1>

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
