// inspect-buttons.mjs
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222' });
const pages = await browser.pages();

for (const page of pages) {
  const url = page.url();
  if (url.includes('168664081') && url.includes('basicContact')) {
    console.log(`\n=== ${url.substring(0, 100)} ===`);
    
    const btns = await page.evaluate(() => {
      const all = document.querySelectorAll('button[type="submit"]');
      return Array.from(all).map(b => ({
        text: b.innerText?.trim(),
        class: b.className?.substring(0, 80),
        visible: b.offsetParent !== null,
        inCaptchaForm: !!b.closest('[data-testid="contact-form"]'),
      }));
    });
    console.log('All submit buttons:', JSON.stringify(btns, null, 2));

    // Check what the captcha form contains
    const captchaForm = await page.evaluate(() => {
      const form = document.querySelector('[data-testid="contact-form"]');
      if (!form) return null;
      const btns = form.querySelectorAll('button');
      return {
        formExists: true,
        buttons: Array.from(btns).map(b => ({
          text: b.innerText?.trim(),
          type: b.type,
          class: b.className?.substring(0, 80),
        })),
        innerText: form.innerText?.substring(0, 500),
      };
    });
    console.log('Captcha form:', JSON.stringify(captchaForm, null, 2));
  }
}

await browser.disconnect();
