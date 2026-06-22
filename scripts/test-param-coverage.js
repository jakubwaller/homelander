// Live conformance: test every mobile API param against /search/total.
// Run: HOMELANDER_LIVE_PARAM_TEST=1 node scripts/test-param-coverage.js
//
// For each param we claim to support, queries the mobile API with and without
// that param set to a restrictive value. Reports whether the param actually
// filters results (total changes), is silently ignored (total unchanged), or
// is rejected by the API (HTTP 412 / error).

const MOBILE_API_TOTAL = 'https://api.mobile.immobilienscout24.de/search/total';
const UA = 'ImmoScout_27.12_26.2_._';
const HEADERS = { 'User-Agent': UA, 'Accept': 'application/json' };

// Base params shared across all queries
const BASE_PARAMS = {
  geocodes: '/de/hamburg/hamburg',
  searchType: 'region',
};

// Each test case: [param_key, test_value, description, realestatetype]
const TESTS = [
  // === Structured params (apartmentrent) ===
  ['price', '-800', 'max price 800€', 'apartmentrent'],
  ['numberofrooms', '2-', 'min 2 rooms', 'apartmentrent'],
  ['livingspace', '60-', 'min 60 m²', 'apartmentrent'],
  ['pricetype', 'rentpermonth', 'cold rent per month', 'apartmentrent'],

  // === DIRECT_PARAM_MAP (apartmentrent) ===
  ['exclusioncriteria', 'projectlisting', 'exclude new-build projects', 'apartmentrent'],
  ['energyefficiencyclasses', 'a,a_plus', 'energy class A/A+', 'apartmentrent'],
  ['petsallowedtypes', 'yes', 'pets allowed = yes', 'apartmentrent'],
  ['floor', '1-', 'floor ≥ 1', 'apartmentrent'],
  ['haspromotion', 'true', 'only promotions', 'apartmentrent'],
  ['constructionyear', '2000-', 'built 2000+', 'apartmentrent'],
  ['osmtags', 'park', 'near a park', 'apartmentrent'],
  ['minimuminternetspeed', '100000', 'min 100 Mbit/s', 'apartmentrent'],
  ['exclusiveonis24', 'true', 'only on IS24', 'apartmentrent'],
  ['comingsoon', 'true', 'coming soon only', 'apartmentrent'],
  ['paywall', 'true', 'Suchen+ only', 'apartmentrent'],
  ['fulltext', 'Altbau', 'keyword: Altbau', 'apartmentrent'],
  ['apartmenttypes', 'groundfloor', 'ground floor only', 'apartmentrent'],
  ['newbuilding', 'true', 'new building only', 'apartmentrent'],

  // === Canonical enums (apartmentrent) ===
  ['heatingtypes', 'central', 'central heating', 'apartmentrent'],
  ['equipment', 'balcony', 'has balcony', 'apartmentrent'],

  // === House-specific params (houserent) ===
  ['buildingtypes', 'singlefamilyhouse', 'single family house', 'houserent'],
  ['ground', '100-', 'plot ≥ 100 m²', 'houserent'],
];

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

async function main() {
  console.log('=== IS24 Mobile API Param Coverage Test ===\n');

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

  let passed = 0, ignored = 0, rejected = 0;
  const results = [];

  for (const [key, value, desc, type] of TESTS) {
    const baseline = baselines[type];
    const withParam = await fetchTotal(type, { [key]: value });
    const icon = withParam.error
      ? '❌'
      : withParam.total !== baseline
        ? '✅'
        : '⚠️';
    const status = withParam.error
      ? `REJECTED (${withParam.error})`
      : withParam.total !== baseline
        ? `${withParam.total.toLocaleString()} (Δ${(withParam.total - baseline).toLocaleString()})`
        : `${withParam.total?.toLocaleString() ?? '?'} (no change)`;

    if (withParam.error) rejected++;
    else if (withParam.total !== baseline) passed++;
    else ignored++;

    console.log(`${icon} ${key}=${value}  →  ${status}  [${desc}] (${type})`);
    results.push({ key, value, desc, type, icon, status, error: withParam.error, total: withParam.total });
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`✅ Filtering: ${passed}/${TESTS.length}`);
  console.log(`⚠️  Ignored:  ${ignored}/${TESTS.length}`);
  console.log(`❌ Rejected: ${rejected}/${TESTS.length}`);

  if (rejected > 0) {
    console.log('\n❌ FAIL: Some params were rejected by the mobile API.');
    process.exit(1);
  }
  if (ignored > 0) {
    console.log('\n⚠️  WARNING: Some params are silently ignored (no regression).');
  } else {
    console.log('\n✅ All params accepted and actively filtering.');
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
