// inspect-168664081.mjs
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222' });
const pages = await browser.pages();

for (const page of pages) {
  const url = page.url();
  if (url.includes('168664081') && url.includes('basicContact')) {
    console.log(`\n=== ${url.substring(0, 100)} ===`);
    
    const state = await page.evaluate(() => {
      const captchaImg = document.querySelector('.captcha-image-container img');
      const captchaInput = document.querySelector('#userAnswer');
      const submitBtn = document.querySelector('button[type="submit"]');
      const confirmModal = document.querySelector('.StatusMessage_status-confirm');
      
      return {
        captchaImg: captchaImg ? {
          alt: captchaImg.alt,
          complete: captchaImg.complete,
          naturalWidth: captchaImg.naturalWidth,
        } : null,
        captchaInput: captchaInput ? { value: captchaInput.value } : null,
        submitBtn: submitBtn ? { text: submitBtn.innerText } : null,
        confirmModal: confirmModal ? confirmModal.innerText.substring(0, 100) : null,
      };
    });
    console.log(JSON.stringify(state, null, 2));
  }
}

await browser.disconnect();
