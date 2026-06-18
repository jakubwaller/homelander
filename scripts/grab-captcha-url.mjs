// grab-captcha-url.mjs
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'fs';

const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222' });
const pages = await browser.pages();

for (const page of pages) {
  const url = page.url();
  if (url.includes('168662564') && url.includes('basicContact')) {
    // Get the captcha image src and fetch it with cookies
    const imgInfo = await page.evaluate(() => {
      const img = document.querySelector('.captcha-image-container img');
      if (!img) return null;
      return {
        src: img.src,
        renderedWidth: img.width,
        renderedHeight: img.height,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        boundingRect: (() => {
          const r = img.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })()
      };
    });
    console.log('Img info:', JSON.stringify(imgInfo, null, 2));

    // Fetch the image directly using the page's cookies
    const imgBuf = await page.evaluate(async (imgSrc) => {
      const resp = await fetch(imgSrc);
      const blob = await resp.blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    }, imgInfo.src);
    
    // Extract base64
    const b64 = imgBuf.split(',')[1];
    writeFileSync('/tmp/captcha-direct.b64', b64);
    console.log('Direct fetch saved, base64 length:', b64.length);
    
    // Also try screenshot with clip option
    const clip = await page.evaluate(() => {
      const img = document.querySelector('.captcha-image-container img');
      const r = img.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    console.log('Clip region:', JSON.stringify(clip));
    
    const clippedScreenshot = await page.screenshot({ 
      encoding: 'base64',
      clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height }
    });
    writeFileSync('/tmp/captcha-clipped.b64', clippedScreenshot);
    console.log('Clipped screenshot saved, length:', clippedScreenshot.length);
  }
}

await browser.disconnect();
