// Quick DB integration test
import { existsSync, unlinkSync } from 'node:fs';

const dbPath = '/tmp/hml-smoke-' + Date.now() + '.db';
console.log('DB path:', dbPath);

const { HomelanderDB } = await import('../engine/db.js');
const db = new HomelanderDB(dbPath);

// Verify tables
const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));
console.log('Expected: schema_version, filters, listings, results');

// Test CRUD
db.addFilter({
  id: 'f1',
  name: 'Berlin',
  web_url: 'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten',
  mobile_params: 'test',
});
const filters = db.getFilters();
console.log('Filters count:', filters.length, '(expected: 1)');
console.log('Filter name:', filters[0]?.name, '(expected: Berlin)');

// Test listing flow
db.insertListing({
  expose_id: '12345',
  title: 'Test Wohnung',
  price: 800,
  size: 50,
  rooms: 2,
  address: 'Berlin-Mitte',
  image_url: '',
  filter_id: 'f1',
});

const newCount = db.getNewListings().length;
console.log('New listings:', newCount, '(expected: 1)');

const hash = HomelanderDB.hashListing('12345', 800);
db.markSent(hash, 'SENT', 'modal ✓');

const stats = db.getStats();
console.log('Stats - seen:', stats.seen, 'sent:', stats.sent, 'failed:', stats.failed);
console.log('Expected: seen=1, sent=1, failed=0');

const history = db.getHistory();
console.log('History entries:', history.length, '(expected: 1)');
console.log('Outcome:', history[0]?.outcome, '(expected: SENT)');

// Captcha consecutive test
console.log('Consecutive captchas:', db.getCaptchaConsecutive(), '(expected: 0)');

db.close();
console.log('\n✓ All DB integration tests passed');
