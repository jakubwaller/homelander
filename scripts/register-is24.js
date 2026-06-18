// Full IS24 registration flow via Chrome CDP
// Credentials from env vars: IS24_EMAIL, IS24_PASSWORD
import puppeteer from 'puppeteer-core';

const CDP_URL = 'http://localhost:9222';
const EMAIL = process.env.IS24_EMAIL || '';
const PASSWORD = process.env.IS24_PASSWORD || '';

if (!EMAIL || !PASSWORD) {
  console.error('Set IS24_EMAIL and IS24_PASSWORD environment variables.');
  process.exit(1);
}

async function main() {
  const resp = await fetch(`${CDP_URL}/json/version`);
  const { webSocketDebuggerUrl } = await resp.json();
  const browser = await puppeteer.connect({
    browserWSEndpoint: webSocketDebuggerUrl,
    defaultViewport: null,
  });

  const page = await browser.newPage();

  try {
    // 1. Navigate to registration page
    console.log('1. Loading registration page...');
    await page.goto('https://www.immobilienscout24.de/registrierung/', {
      waitUntil: 'domcontentloaded', timeout: 20000
    });
    await new Promise(r => setTimeout(r, 4000));

    const title = await page.title();
    console.log(`   Page title: "${title}"`);

    // 2. Find registration form inputs
    const formInfo = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input, select');
      return Array.from(inputs).map(el => ({
        tag: el.tagName,
        type: el.type || '',
        name: el.name || '',
        id: el.id || '',
        placeholder: el.placeholder || '',
        label: (() => {
          const label = el.closest('label') || document.querySelector(`label[for="${el.id}"]`);
          return label ? label.textContent.trim() : '';
        })(),
      })).filter(i => i.type !== 'hidden');
    });

    console.log('   Form fields found:');
    formInfo.forEach(f => {
      console.log(`     ${f.name || f.id}: type=${f.type} placeholder="${f.placeholder}" label="${f.label}"`);
    });

    // 3. Look for "E-Mail" field and fill it
    const emailField = formInfo.find(f =>
      /email|e-mail/i.test(f.name + f.id + f.label + f.placeholder)
    );

    if (emailField) {
      const sel = emailField.name ? `[name="${emailField.name}"]` : `#${emailField.id}`;
      console.log(`\n2. Filling email field: ${sel}`);
      await page.click(sel);
      await page.keyboard.type(EMAIL, { delay: 40 });
      console.log(`   Email: ${EMAIL}`);
    }

    // 4. Look for password field
    const pwField = formInfo.find(f =>
      /passwort|password/i.test(f.name + f.id + f.label)
    );
    if (pwField) {
      const sel = pwField.name ? `[name="${pwField.name}"]` : `#${pwField.id}`;
      console.log(`\n3. Filling password field: ${sel}`);
      await page.click(sel);
      await page.keyboard.type(PASSWORD, { delay: 40 });
      console.log('   Password: ***');
    }

    // Screenshot to inspect
    await page.screenshot({ path: '/tmp/is24_reg_form.png', fullPage: true });
    console.log('\n   Screenshot saved: /tmp/is24_reg_form.png');

    // 5. Check page text for any "submit" or "registrieren" button
    const buttons = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
        .map(b => ({
          text: (b.textContent || b.value || '').trim().substring(0, 60),
          type: b.type || '',
        }));
    });
    console.log('\n   Buttons found:');
    buttons.forEach(b => {
      if (b.text) console.log(`     "${b.text}" (type=${b.type})`);
    });

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    console.log('\nPage left open in Chrome for manual inspection.');
    await browser.disconnect();
  }
}

main();
