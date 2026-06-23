#!/usr/bin/env node
// Download Chrome for Testing and place it in chrome-bundled/ for packaging.
// Called by CI before electron-builder.
import { install, detectBrowserPlatform, Browser, computeExecutablePath } from '@puppeteer/browsers';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const BUILD_ID = '148.0.7778.97';
const CACHE_DIR = join(process.cwd(), 'chrome-bundled');
const platform = detectBrowserPlatform();

console.log(`Downloading Chrome for Testing ${BUILD_ID} for ${platform}...`);

mkdirSync(CACHE_DIR, { recursive: true });

await install({
  browser: Browser.CHROME,
  buildId: BUILD_ID,
  cacheDir: CACHE_DIR,
  platform,
  unpack: true,
});

// CRITICAL: @puppeteer/browsers extracts via fs.createWriteStream which
// strips Unix executable bits (755 → 644). Without chmod, spawn() throws
// EACCES on macOS/Linux — indistinguishable from a Gatekeeper block.
if (process.platform !== 'win32') {
  const exePath = computeExecutablePath({ browser: Browser.CHROME, buildId: BUILD_ID, cacheDir: CACHE_DIR });
  if (existsSync(exePath)) {
    chmodSync(exePath, 0o755);
    console.log(`chmod 755 ${exePath}`);
  }
}

const finalPath = computeExecutablePath({ browser: Browser.CHROME, buildId: BUILD_ID, cacheDir: CACHE_DIR });
if (existsSync(finalPath)) {
  console.log(`Chrome bundled successfully: ${finalPath}`);
} else {
  console.error(`ERROR: Chrome exe not found at ${finalPath}`);
  process.exit(1);
}
