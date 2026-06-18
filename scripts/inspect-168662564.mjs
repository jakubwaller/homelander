// inspect-168662564.mjs
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222' });
const pages = await browser.pages();

for (const page of pages) {
  const url = page.url();
  if (url.includes('168662564') && url.includes('basicContact')) {
    console.log(`\n=== ${url.substring(0, 100)} ===`);
    
    const state = await page.evaluate(() => {
      const captchaImg = document.querySelector('.captcha-image-container img');
      const captchaInput = document.querySelector('#userAnswer');
      const confirmModal = document.querySelector('.StatusMessage_status-confirm');
      const form = document.querySelector('[data-testid="contact-form"]');
      
      return {
        captchaImg: captchaImg ? {
          src: captchaImg.src?.substring(0, 100),
          alt: captchaImg.alt,
          complete: captchaImg.complete,
          naturalWidth: captchaImg.naturalWidth,
          naturalHeight: captchaImg.naturalHeight,
        } : null,
        captchaInput: captchaInput ? { value: captchaInput.value } : null,
        confirmModal: confirmModal ? confirmModal.innerText?.substring(0, 100) : null,
        formInnerText: form ? form.innerText?.substring(0, 400) : null,
      };
    });
    console.log(JSON.stringify(state, null, 2));
  }
}

await browser.disconnect();
