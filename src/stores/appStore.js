// Zustand store for Homelander renderer state.
import { create } from 'zustand';

export const useStore = create((set, get) => ({
  // ── App state ──────────────────────────────────────────────
  activeTab: 'searches',
  setupComplete: false,
  daemonStatus: 'stopped', // stopped | running | paused
  chromeStatus: 'stopped', // stopped | running

  setActiveTab: (tab) => set({ activeTab: tab }),
  setSetupComplete: (v) => set({ setupComplete: v }),
  setDaemonStatus: (status) => set({ daemonStatus: status }),
  setChromeStatus: (status) => set({ chromeStatus: status }),

  // ── Filters ────────────────────────────────────────────────
  filters: [],
  setFilters: (filters) => set({ filters }),

  // ── Stats ──────────────────────────────────────────────────
  stats: { seen: 0, sent: 0, failed: 0, deactivated: 0, seen_unapplied: 0, today: 0, nextPollAt: null },
  setStats: (stats) => set({ stats }),

  // ── Activity feed ──────────────────────────────────────────
  activity: [],
  addActivity: (item) => set((state) => ({
    activity: [item, ...state.activity].slice(0, 200),
  })),

  // ── Config ─────────────────────────────────────────────────
  config: null,
  setConfig: (config) => set({ config }),

  // ── Poll errors ────────────────────────────────────────────
  pollErrors: {},
  setPollError: (filterId, error) => set((state) => ({
    pollErrors: { ...state.pollErrors, [filterId]: error },
  })),
  clearPollError: (filterId) => set((state) => {
    const next = { ...state.pollErrors };
    delete next[filterId];
    return { pollErrors: next };
  }),
}));
