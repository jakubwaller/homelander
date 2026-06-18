// submit-168662564.mjs — one-off captcha solve + submit for a specific listing.
// Reads 2captcha key from CAPTCHA_API_KEY env var or config/autoapply.config.yaml.
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
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
    const b64 = await page.evaluate(async () => {
      const img = document.querySelector('.captcha-image-container img');
      const resp = await fetch(img.src);
      const blob = await resp.blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.readAsDataURL(blob);
      });
    });

    const createResp = await fetch('https://api.2captcha.com/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: API_KEY,
        task: { type: 'ImageToTextTask', body: b64, case: false, numeric: 0 }
      })
    });
    const task = await createResp.json();
    console.log('Task:', task.taskId);

    let solution;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const r = await fetch('https://api.2captcha.com/getTaskResult', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: API_KEY, taskId: task.taskId })
      });
      const result = await r.json();
      if (result.status === 'ready') { solution = result.solution.text; break; }
    }

    console.log('Solution:', solution);

    await page.click('#userAnswer');
    await page.type('#userAnswer', solution, { delay: 30 });
    await new Promise(r => setTimeout(r, 500));
    await page.click('[data-testid="contact-form"] button[type="submit"]');
    console.log('Submitted!');
  }
}
await browser.disconnect();
