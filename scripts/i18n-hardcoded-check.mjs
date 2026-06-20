#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const SCAN_DIRS = ['src'];
const EXTENSIONS = new Set(['.js', '.jsx']);
const SKIP_PARTS = new Set(['node_modules', 'dist', 'release', '.git']);
const SKIP_FILES = new Set([
  'src/locales/en.json',
  'src/locales/de.json',
  'src/shared/userErrors.js', // userErrors owns its own key mapping/fallbacks
]);

const JSX_TEXT_ALLOWED = [
  /^×$/,
  /^✓$/,
  /^↗$/,
  /^⟳$/,
  /^▶$/,
  /^⏸$/,
  /^🗑$/,
  /^📋$/,
  /^🇩🇪\s*Deutsch$/,
  /^🇬🇧\s*English$/,
];

// Some literal strings are not user-facing copy: selectors, IPC/event names,
// config keys, CSS tokens, DB columns, IS24 API params, URLs, regex snippets.
const NON_COPY_PATTERNS = [
  /^[a-z0-9_.:-]+$/i,
  /^#[0-9a-f]{3,8}$/i,
  /^\.[a-z0-9_-]+$/i,
  /^--[a-z0-9_-]+$/i,
  /^var\(--[a-z0-9_-]+\)$/i,
  /^https?:\/\//i,
  /^file:\/\//i,
  /^\/[^\s]+$/,
  /^\.[/\\]/,
  /^~\//,
  /^[A-Z0-9_]+$/,
  /^\d+(\.\d+)?(px|rem|em|ms|s|%)?$/,
  /^\s*$/,
];

const STRING_CONTEXT_ALLOWLIST = [
  /import\s+.*\s+from\s+['"]/,
  /export\s+.*\s+from\s+['"]/,
  /require\(['"]/,
  /className\s*=/,
  /style\s*=/,
  /console\.(log|warn|error|info|debug)\(/,
  /logRawError\(/,
  /debugLog\(/,
  /writeFileSync\(/,
  /readFileSync\(/,
  /ipc(Main|Renderer)\./,
  /webContents\.send\(/,
  /ipcRenderer\.invoke\(/,
  /querySelector(All)?\(/,
  /waitForSelector\(/,
  /getElementById\(/,
  /addEventListener\(/,
  /removeEventListener\(/,
  /new URL\(/,
  /URLSearchParams\(/,
  /RegExp\(/,
  /process\.env/,
  /path\.(join|resolve|dirname|basename)\(/,
  /app\.getPath\(/,
  /BrowserWindow\(/,
  /spawn\(/,
  /execFile\(/,
  /sqlite|SELECT|INSERT|UPDATE|DELETE|CREATE|PRAGMA|FROM|WHERE/i,
  /Object\.entries\(/,
  /Object\.keys\(/,
  /case\s+['"]/,
];

const VISIBLE_ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_PARTS.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(full))) out.push(full);
  }
  return out;
}

function rel(file) {
  return path.relative(root, file).replaceAll(path.sep, '/');
}

function lineNo(content, index) {
  return content.slice(0, index).split('\n').length;
}

function hasLetters(s) {
  return /[A-Za-zÄÖÜäöüß]/.test(s);
}

function isLikelyCopy(s) {
  const text = s.trim();
  if (!hasLetters(text)) return false;
  if (NON_COPY_PATTERNS.some(rx => rx.test(text))) return false;
  // Single technical-ish token is usually an id/param, not copy.
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(text) && text.length < 24) return false;
  return true;
}

function isAllowedJsxText(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return true;
  if (JSX_TEXT_ALLOWED.some(rx => rx.test(normalized))) return true;
  return false;
}

function stripJsxExpressions(text) {
  // Conservative: remove simple one-line {...} expressions so the remaining
  // literal text between tags can be inspected.
  return text.replace(/\{[^{}\n]*\}/g, '');
}

function findJsxText(content, file) {
  const findings = [];
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes('i18n-allow-hardcoded')) return;
    // Deliberately line-local and conservative to avoid treating JS comparisons
    // (`a > b`) as JSX. This catches the common leak: <div>English copy</div>.
    const rx = />\s*([^<>{};=]*[A-Za-zÄÖÜäöüß][^<>{};=]*)\s*</g;
    for (const m of line.matchAll(rx)) {
      const literal = m[1].replace(/\s+/g, ' ').trim();
      if (!literal || !isLikelyCopy(literal) || isAllowedJsxText(literal)) continue;
      findings.push({
        file,
        line: idx + 1,
        kind: 'JSX text node',
        text: literal,
        fix: 'Wrap visible text with t("key", "German fallback") or move it to locale JSON.',
      });
    }
  });
  return findings;
}

function findVisibleAttrs(content, file) {
  const findings = [];
  for (const attr of VISIBLE_ATTRS) {
    const rx = new RegExp(`\\b${attr}=["']([^"']*[A-Za-zÄÖÜäöüß][^"']*)["']`, 'g');
    for (const m of content.matchAll(rx)) {
      const value = m[1].trim();
      if (!isLikelyCopy(value)) continue;
      findings.push({
        file,
        line: lineNo(content, m.index),
        kind: `${attr}= literal`,
        text: value,
        fix: `Use ${attr}={t("key", "German fallback")} or a localized variable.`,
      });
    }
  }
  return findings;
}

function findSuspiciousStringLiterals(content, file) {
  const findings = [];
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    if (trimmed.includes('i18n-allow-hardcoded')) return;
    if (trimmed.includes('${')) return;
    if (trimmed.includes('useLocale must be used within LocaleProvider')) return;
    if (trimmed.includes('t(') || trimmed.includes('previewLocale(')) return;
    if (STRING_CONTEXT_ALLOWLIST.some(rx => rx.test(line))) return;

    // Visible-copy contexts outside JSX: state errors, browser dialogs, and
    // explicitly user-facing thrown errors in renderer code.
    const visibleContext = /(set[A-Z][A-Za-z0-9_]*\(|throw new Error\(|alert\(|confirm\()/;
    if (!visibleContext.test(line)) return;

    const stringRx = /(['"`])((?:\\.|(?!\1).)*?[A-Za-zÄÖÜäöüß](?:\\.|(?!\1).)*?)\1/g;
    for (const m of line.matchAll(stringRx)) {
      const value = m[2].replace(/\$\{[^}]+\}/g, '').trim();
      if (!isLikelyCopy(value)) continue;
      findings.push({
        file,
        line: idx + 1,
        kind: 'visible string literal',
        text: value,
        fix: 'Move this visible copy to locale JSON / translator helper, or mark intentional with // i18n-allow-hardcoded.',
      });
    }
  });
  return findings;
}

const files = SCAN_DIRS.flatMap(dir => {
  const full = path.join(root, dir);
  try { return walk(full); } catch { return []; }
});

const findings = [];
for (const file of files) {
  const r = rel(file);
  if (SKIP_FILES.has(r)) continue;
  const content = readFileSync(file, 'utf8');
  if (file.endsWith('.jsx')) {
    findings.push(...findJsxText(content, r));
    findings.push(...findVisibleAttrs(content, r));
  }
  findings.push(...findSuspiciousStringLiterals(content, r));
}

if (findings.length) {
  console.error('\n❌ Hardcoded user-facing strings found. Localize them or add // i18n-allow-hardcoded for intentional non-translatable copy.\n');
  for (const f of findings) {
    console.error(`${f.file}:${f.line}  ${f.kind}: ${JSON.stringify(f.text)}`);
    console.error(`  → ${f.fix}`);
  }
  console.error(`\n${findings.length} issue(s).`);
  process.exit(1);
}

console.log('✓ i18n hardcoded-string guard passed');
