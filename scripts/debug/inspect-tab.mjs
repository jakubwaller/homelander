// inspect-tab.mjs — connect to Chrome via CDP and inspect a specific tab
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222' });
const pages = await browser.pages();

for (const page of pages) {
  const url = page.url();
  if (url.includes('168664572') && url.includes('basicContact')) {
    console.log(`\n=== Page: ${url.substring(0, 100)} ===`);
    
    const imgInfo = await page.evaluate(() => {
      const img = document.querySelector('.captcha-image-container img');
      if (!img) return { found: false };
      return {
        found: true,
        src: img.src.substring(0, 120),
        alt: img.alt,
        complete: img.complete,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
      };
    });
    console.log('Captcha image:', JSON.stringify(imgInfo, null, 2));
    
    const formText = await page.evaluate(() => {
      const el = document.querySelector('.captcha-image-container');
      return el?.closest('form')?.innerText?.substring(0, 300) || 'no form';
    });
    console.log('Form text:', formText);
  }
}

await browser.disconnect();
