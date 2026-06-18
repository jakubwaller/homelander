// click-bestatigen.mjs
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222' });
const pages = await browser.pages();

for (const page of pages) {
  const url = page.url();
  if (url.includes('168664081') && url.includes('basicContact')) {
    // Click Bestätigen inside the captcha form
    await page.click('[data-testid="contact-form"] button[type="submit"]');
    console.log('Clicked Bestätigen!');
    
    // Wait and check result
    await new Promise(r => setTimeout(r, 3000));
    const result = await page.evaluate(() => {
      const confirm = document.querySelector('.StatusMessage_status-confirm');
      const captcha = document.querySelector('.captcha-image-container');
      return {
        confirmModal: confirm ? confirm.innerText.substring(0, 100) : null,
        stillCaptcha: !!captcha,
      };
    });
    console.log('Result:', JSON.stringify(result));
  }
}

await browser.disconnect();
