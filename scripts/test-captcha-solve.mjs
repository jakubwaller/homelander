// test-captcha-solve.mjs — one-off captcha solve test for a specific listing.
// Reads 2captcha key from CAPTCHA_API_KEY env var or config/autoapply.config.yaml.
import puppeteer from 'puppeteer-core';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config', 'autoapply.config.yaml');

function getApiKey() {
  if (process.env.CAPTCHA_API_KEY) return process.env.CAPTCHA_API_KEY;
  try {
    const cfg = yaml.load(readFileSync(CONFIG_PATH, 'utf8'));
    return cfg?.captcha?.api_key || '';
  } catch { return ''; }
}

const API_KEY = getApiKey();
if (!API_KEY) {
  console.error('No 2captcha API key found.');
  console.error('Set CAPTCHA_API_KEY env var or configure captcha.api_key in config/autoapply.config.yaml');
  process.exit(1);
}

const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222' });
const pages = await browser.pages();

for (const page of pages) {
  const url = page.url();
  if (url.includes('168662564') && url.includes('basicContact')) {
    const imgEl = await page.$('.captcha-image-container img');
    if (imgEl) {
      const buf = await imgEl.screenshot({ encoding: 'base64' });
      writeFileSync('/tmp/captcha-168662564.b64', buf);
      console.log('Screenshot saved, length:', buf.length);

      const createResp = await fetch('https://api.2captcha.com/createTask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientKey: API_KEY,
          task: { type: 'ImageToTextTask', body: buf, case: false, numeric: 0 }
        })
      });
      const task = await createResp.json();
      console.log('createTask:', JSON.stringify(task));

      if (task.taskId) {
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const resp = await fetch('https://api.2captcha.com/getTaskResult', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientKey: API_KEY, taskId: task.taskId })
          });
          const result = await resp.json();
          if (result.status === 'ready') {
            console.log('SOLVED:', result.solution.text);
            break;
          }
          if (result.errorId !== 0) {
            console.log('ERROR:', result.errorDescription);
            break;
          }
          console.log(`  poll ${i+1}: ${result.status}`);
        }
      }
    } else {
      console.log('No captcha image found');
    }
  }
}

await browser.disconnect();
