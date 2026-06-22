// Live conformance: test EVERY mobile API param, equipment value, heating type,
// and apartment type against /search/total. Full coverage — no spot-checks.
// Run: HOMELANDER_LIVE_PARAM_TEST=1 node scripts/test-param-coverage.js
//
// Compares each param set vs. unset against the mobile API. Reports:
//   ✅ FILTERS   — total changed (param actively affects results)
//   ⚠️ NO CHANGE — silently ignored (param accepted but no filtering effect)
//   ❌ REJECTED  — HTTP 412 or error (param not supported by mobile API)
//
// Rejected params cause CI failure. Ignored params are warnings only.

const MOBILE_API_TOTAL = 'https://api.mobile.immobilienscout24.de/search/total';
const UA = 'ImmoScout_27.12_26.2_._';
const HEADERS = { 'User-Agent': UA, 'Accept': 'application/json' };

const BASE_PARAMS = {
  geocodes: '/de/hamburg/hamburg',
  searchType: 'region',
};

// ── Test cases ────────────────────────────────────────────────────────────
// [param_key, test_value, description, realestatetype]

const TESTS = [
  // === Structured params (apartmentrent) ===
  ['price', '-800', 'max price 800€', 'apartmentrent'],
  ['numberofrooms', '2-', 'min 2 rooms', 'apartmentrent'],
  ['livingspace', '60-', 'min 60 m²', 'apartmentrent'],
  ['pricetype', 'rentpermonth', 'cold rent per month', 'apartmentrent', 'ignore'],

  // === DIRECT_PARAM_MAP (apartmentrent) ===
  ['exclusioncriteria', 'projectlisting', 'exclude new-build projects', 'apartmentrent'],
  ['energyefficiencyclasses', 'a,a_plus', 'energy class A/A+', 'apartmentrent'],
  ['petsallowedtypes', 'yes', 'pets allowed = yes', 'apartmentrent'],
  ['floor', '1-', 'floor ≥ 1', 'apartmentrent'],
  ['haspromotion', 'true', 'only promotions', 'apartmentrent'],
  ['constructionyear', '2000-', 'built 2000+', 'apartmentrent'],
  ['fulltext', 'Altbau', 'keyword: Altbau', 'apartmentrent'],
  ['osmtags', 'park', 'near a park', 'apartmentrent'],
  ['minimuminternetspeed', '100000', 'min 100 Mbit/s', 'apartmentrent'],
  ['exclusiveonis24', 'true', 'only on IS24', 'apartmentrent'],
  ['comingsoon', 'true', 'coming soon only', 'apartmentrent'],
  ['paywall', 'true', 'Suchen+ only', 'apartmentrent'],
  ['newbuilding', 'true', 'new building only', 'apartmentrent'],

  // === House-specific (houserent) ===
  ['buildingtypes', 'singlefamilyhouse', 'single family house', 'houserent'],
  ['ground', '100-', 'plot ≥ 100 m²', 'houserent'],
];

// ── Equipment values (each sent as equipment=<value> to isolate) ──────────
// elevator → lift (fixed 2026-06-22: mobile API uses 'lift', not 'elevator')
// fridge/cooker/petsallowed/internet → kept as tests (accepted, silently ignored)
const EQUIPMENT_TESTS = [
  ['balcony', 'balcony', true],
  ['garden', 'garden', true],
  ['parking', 'parking', true],
  ['cellar', 'cellar', true],
  ['lift', 'elevator/lift', true],
  ['builtinKitchen', 'built-in kitchen', true],
  ['guesttoilet', 'guest toilet', true],
  ['handicappedaccessible', 'barrier-free', true],
  // Known silently ignored (accepted, no filtering)
  ['fridge', 'fridge (ignored)', false],
  ['cooker', 'cooker (ignored)', false],
  ['petsallowed', 'pets allowed (ignored)', false],
  ['internet', 'internet (ignored)', false],
];

for (const [val, desc, expectsFilter] of EQUIPMENT_TESTS) {
  TESTS.push(['equipment', val, `equipment: ${desc}`, 'apartmentrent', expectsFilter ? 'filter' : 'ignore']);
}

// ── Heating types (only the 3 that mobile API still supports) ─────────────
// 8 heating types removed 2026-06-22: mobile API rejects with 412
const HEATING_TESTS = [
  'central',
  'selfcontainedcentral',
  'stove',
];

for (const hv of HEATING_TESTS) {
  TESTS.push(['heatingtypes', hv, `heating: ${hv}`, 'apartmentrent']);
}

// ── Apartment types ───────────────────────────────────────────────────────
const APARTMENT_TYPES = [
  'groundfloor', 'halfbasement', 'raisedgroundfloor', 'apartment',
  'loft', 'maisonette', 'terracedflat', 'penthouse', 'roofstorey',
];

for (const at of APARTMENT_TYPES) {
  TESTS.push(['apartmenttypes', at, `apartment type: ${at}`, 'apartmentrent']);
}

// ── Fetch helper ──────────────────────────────────────────────────────────
async function fetchTotal(realestatetype, extraParams = {}) {
  const url = new URL(MOBILE_API_TOTAL);
  for (const [k, v] of Object.entries(BASE_PARAMS)) url.searchParams.set(k, v);
  url.searchParams.set('realestatetype', realestatetype);
  for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);
  try {
    const resp = await fetch(url, { headers: HEADERS });
    if (!resp.ok) return { error: `HTTP ${resp.status}`, total: null };
    const data = await resp.json();
    return { total: data.totalResults ?? data.numberOfHits ?? data.total ?? null, error: null };
  } catch (err) {
    return { error: err.message, total: null };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const label = `IS24 Mobile API — Full Param Coverage (${TESTS.length} params)`;
  console.log(`${'='.repeat(label.length)}`);
  console.log(label);
  console.log(`${'='.repeat(label.length)}\n`);

  // Fetch baselines per realestatetype
  const baselines = {};
  for (const [, , , type] of TESTS) {
    if (!baselines[type]) {
      const b = await fetchTotal(type);
      if (b.error) { console.error(`❌ Baseline for ${type} failed: ${b.error}`); process.exit(1); }
      baselines[type] = b.total;
      console.log(`Baseline ${type}: ${b.total.toLocaleString()}`);
    }
  }
  console.log();

  let passed = 0, ignored = 0, rejected = 0, expectedIgnored = 0;
  const ignoredList = [];
  const rejectedList = [];

  for (let i = 0; i < TESTS.length; i++) {
    const entry = TESTS[i];
    const key = entry[0];
    const value = entry[1];
    const desc = entry[2];
    const type = entry[3];
    const expect = entry[4] || 'filter'; // 'filter', 'ignore', or undefined (defaults to filter)

    const baseline = baselines[type];
    const withParam = await fetchTotal(type, { [key]: value });

    let status, icon;
    if (withParam.error) {
      status = 'REJECTED';
      icon = '❌';
      rejected++;
      rejectedList.push({ key, value, desc, type, error: withParam.error });
    } else if (withParam.total !== baseline) {
      status = 'FILTERS';
      icon = '✅';
      passed++;
    } else {
      status = 'NO CHANGE';
      icon = expect === 'ignore' ? '📌' : '⚠️';
      ignored++;
      if (expect === 'ignore') expectedIgnored++;
      else ignoredList.push({ key, value, desc, type });
    }

    const detail = withParam.error
      ? withParam.error
      : withParam.total !== baseline
        ? `${withParam.total.toLocaleString()} (Δ${(withParam.total - baseline).toLocaleString()})`
        : `${withParam.total?.toLocaleString() ?? '?'} (same)`;

    const expectTag = expect === 'ignore' ? ' [expected: ignored]' : '';
    const pct = `${i + 1}/${TESTS.length}`;
    console.log(`${icon} [${pct}] ${key}=${value}  →  ${status}  ${detail}  [${desc}]${expectTag}`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log('SUMMARY');
  console.log(`${'─'.repeat(60)}`);
  console.log(`✅ Actively filtering: ${passed}/${TESTS.length}`);
  console.log(`⚠️  Silently ignored:   ${ignored}/${TESTS.length} (${expectedIgnored} expected, ${ignored - expectedIgnored} unexpected)`);
  console.log(`❌ Rejected:           ${rejected}/${TESTS.length}`);

  const unexpectedIgnored = ignoredList.filter(p => {
    const entry = TESTS.find(t => t[0] === p.key && t[1] === p.value);
    return !entry || entry[4] !== 'ignore';
  });

  if (unexpectedIgnored.length) {
    console.log(`\n⚠️  Unexpectedly ignored params (regression risk):`);
    for (const p of unexpectedIgnored) {
      console.log(`   ${p.key}=${p.value}  [${p.desc}]`);
    }
  }

  if (rejectedList.length) {
    console.log(`\n❌ Rejected params (API error — fix in url-translator.js):`);
    for (const p of rejectedList) {
      console.log(`   ${p.key}=${p.value}  → ${p.error}  [${p.desc}]`);
    }
  }

  if (rejected > 0) {
    console.log('\n❌ FAIL: Some params were rejected by the mobile API.');
    process.exit(1);
  }
  if (unexpectedIgnored.length) {
    console.log('\n⚠️  WARNING: Unexpectedly ignored params detected.');
    process.exit(0);
  }
  console.log('\n✅ All params accepted and actively filtering.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
