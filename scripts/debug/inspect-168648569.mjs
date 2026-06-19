// inspect-168648569.mjs
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222' });
const pages = await browser.pages();

for (const page of pages) {
  const url = page.url();
  if (url.includes('168648569') && url.includes('basicContact')) {
    console.log(`\n=== ${url.substring(0, 100)} ===`);
    
    const state = await page.evaluate(() => {
      // Check all input/textarea fields
      const inputs = document.querySelectorAll('input, textarea');
      const fields = Array.from(inputs).map(el => ({
        tag: el.tagName,
        id: el.id || null,
        name: el.name || null,
        type: el.type || null,
        value: el.value?.substring(0, 100) || '',
        placeholder: el.placeholder || null,
        dataTestid: el.getAttribute('data-testid') || null,
      }));
      
      // Check captcha
      const captchaImg = document.querySelector('.captcha-image-container img');
      const confirmModal = document.querySelector('.StatusMessage_status-confirm');
      
      return {
        fields,
        captcha: captchaImg ? { complete: captchaImg.complete, naturalWidth: captchaImg.naturalWidth } : null,
        confirmModal: confirmModal ? confirmModal.innerText?.substring(0, 100) : null,
        bodyText: document.body?.innerText?.substring(0, 500),
      };
    });
    console.log(JSON.stringify(state, null, 2));
  }
}

await browser.disconnect();
