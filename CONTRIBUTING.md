# Contributing to Homelander

Thanks for contributing!

## Setup

```bash
git clone https://github.com/B1Z0N/homelander.git
cd homelander
npm install        # installs deps + rebuilds better-sqlite3 for Electron
```

## Development

```bash
npm run dev        # starts Vite dev server + Electron
npm run test       # runs the test suite
```

- **Renderer:** React 19 + Vite + Tailwind CSS — edit under `src/`
- **Daemon:** Node.js forked process — edit under `engine/`
- **Electron main:** `electron/main.js` — IPC handlers, app lifecycle

## Submitting Changes

1. Open an issue first for larger changes to discuss the approach
2. Create a feature branch off `main`
3. Keep commits focused and well-described
4. Run the tests: `npm test`
5. Open a pull request using the PR template

## Style

- 2-space indentation
- Use `const`/`let`, no `var`
- Prefer async/await over raw promises
- CamelCase for variables, PascalCase for React components
