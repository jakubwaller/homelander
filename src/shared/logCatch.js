// Shared error-swallow helper — replaces bare `catch {}` / `.catch(() => {})`
// with logged diagnostics while still preventing unhandled rejections.
//
// Usage:
//   import { swallow } from '../shared/logCatch.js';  // renderer
//   const { swallow } = await import('./logCatch.js'); // daemon (dynamic import)
//
//   // before:  try { risky(); } catch {}
//   // after:   try { risky(); } catch (err) { swallow(err, 'context label'); }
//
// `log` should be the module's logger function (e.g. `log` from daemon.js,
// `logRawError` from main.js, or `console.error` in renderer).
// If `log` is omitted, falls back to `console.error` with a `[swallow]` prefix.

export function swallow(err, context, log = null) {
  const msg = `[swallow] ${context || '?'}: ${err?.message || err}`;
  try {
    if (log) log(msg);
    else console.error(msg);
  } catch {
    // Last resort — do not re-throw; the whole point is to never throw
  }
}
