# Contributing to Homelander

Thanks for your interest! Here's how to get started.

## Development setup

```bash
git clone https://github.com/B1Z0N/homelander.git
cd homelander
npm install
```

### Run in development

```bash
# Single command (Vite + Electron):
npm run dev

# Or separate terminals:
npm run dev:renderer   # Terminal 1: Vite dev server
npm run dev:electron   # Terminal 2: Electron app
```

### Run tests

```bash
npm test              # Unit tests + i18n check
npm run test:unit     # Unit tests only
npm run test:i18n     # i18n key parity check
```

## Code conventions

- **ESM** (`"type": "module"` in package.json) — **except** `electron/preload.cjs` which MUST remain CommonJS
- **Plain JavaScript** with JSDoc — no TypeScript
- **Zustand store** (`src/stores/appStore.js`) is the single source of truth in the renderer
- **Daemon events** are JSON objects with a `type` field: `stats`, `listing`, `paused`, `resumed`, `error`, `poll_error`, `session_expired`, `chrome_dead`
- **i18n**: `src/locales/de.json` and `src/locales/en.json` must have the same keys. Run `npm run test:i18n` to verify.

## Architecture

- `electron/` — Electron main process (lifecycle, IPC, daemon management, Chrome/CDP)
- `engine/` — Forked daemon (poll loop + apply loop, SQLite, IS24 contactor)
- `src/` — React 19 renderer (Vite, Tailwind CSS 4, Zustand, i18n)
- `test/` — Unit tests (Node built-in test runner)

## Before submitting

- [ ] Tests pass: `npm test`
- [ ] i18n keys in sync: `npm run test:i18n`
- [ ] No new lint warnings
- [ ] Relevant docs updated

## PR process

1. Fork the repo → create a branch → open a PR to `main`
2. CI must pass (unit tests + i18n check on macOS)
3. Keep PRs focused — one feature or fix per PR
4. Link related issues in the description
