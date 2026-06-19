// Quick DB integration smoke test
import { unlinkSync } from 'node:fs';
import assert from 'node:assert/strict';

const dbPath = '/tmp/hml-smoke-' + Date.now() + '.db';
console.log('DB path:', dbPath);

const { HomelanderDB } = await import('../engine/db.js');
const db = new HomelanderDB(dbPath);

try {
  const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  console.log('Tables:', tables.join(', '));
  for (const name of ['schema_version', 'filters', 'listings', 'results']) {
    assert.ok(tables.includes(name), `missing table ${name}`);
  }

  db.addFilter({
    id: 'f1',
    name: 'Berlin',
    web_url: 'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten',
    mobile_params: 'test',
  });
  const filters = db.getFilters();
  assert.equal(filters.length, 1);
  assert.equal(filters[0].name, 'Berlin');

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

  const seenCount = db.getSeenListings().length;
  assert.equal(seenCount, 1);

  const hash = HomelanderDB.hashListing('12345', 800);
  db.markSent(hash, 'SENT', 'modal ✓');

  const stats = db.getStats();
  assert.equal(stats.total, 1);
  assert.equal(stats.sent, 1);
  assert.equal(stats.failed, 0);

  const history = db.getHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].outcome, 'SENT');
  assert.equal(db.getCaptchaConsecutive(), 0);

  console.log('✓ DB smoke passed');
} finally {
  db.close();
  try { unlinkSync(dbPath); } catch {}
  try { unlinkSync(dbPath + '-wal'); } catch {}
  try { unlinkSync(dbPath + '-shm'); } catch {}
}
