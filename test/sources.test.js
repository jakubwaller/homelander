// Unit tests for engine/sources.js — multi-source scan module.
// Run: node --test test/sources.test.js

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSource,
  decodeEntities,
  parseKleinanzeigenHtml,
  parseNeubaukompassHtml,
  validateAnySearchUrl,
  fetchAnyListings,
  fetchIs24ExposeDetails,
  geocodePostcode,
  SOURCE_IS24,
  SOURCE_KLEINANZEIGEN,
  SOURCE_NEUBAUKOMPASS,
} from '../engine/sources.js';

let originalFetch;
before(() => { originalFetch = globalThis.fetch; });
after(() => { globalThis.fetch = originalFetch; });

function mockJsonResponse(payload, { status = 200, contentType = 'application/json' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => contentType },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function mockHtmlResponse(html, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'text/html' },
    text: async () => html,
    json: async () => { throw new Error('not json'); },
  };
}

// ---------------------------------------------------------------------------

describe('detectSource', () => {
  it('detects the three supported portals', () => {
    assert.equal(detectSource('https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-kaufen'), SOURCE_IS24);
    assert.equal(detectSource('https://www.kleinanzeigen.de/s-wohnung-kaufen/berlin/c196l3331'), SOURCE_KLEINANZEIGEN);
    assert.equal(detectSource('https://www.neubaukompass.de/neubau-immobilien/berlin-region/'), SOURCE_NEUBAUKOMPASS);
  });

  it('returns null for unknown hosts and garbage', () => {
    assert.equal(detectSource('https://example.com/wohnung'), null);
    assert.equal(detectSource(''), null);
    assert.equal(detectSource('not a url at all ::'), null);
  });
});

describe('decodeEntities', () => {
  it('decodes numeric and named entities and collapses whitespace', () => {
    assert.equal(decodeEntities('67,30 m&#178; &#183; 3 Zi.'), '67,30 m² · 3 Zi.');
    assert.equal(decodeEntities('a &amp; b\n   c &quot;d&quot;'), 'a & b c "d"');
  });
});

describe('validateAnySearchUrl', () => {
  it('marks IS24 buy searches as scan mode', () => {
    const v = validateAnySearchUrl('https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-kaufen');
    assert.equal(v.ok, true);
    assert.equal(v.source, SOURCE_IS24);
    assert.equal(v.mode, 'scan');
    assert.ok(!v.mobileUrl.includes('pricetype='));
  });

  it('keeps IS24 rent searches in apply mode', () => {
    const v = validateAnySearchUrl('https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten');
    assert.equal(v.ok, true);
    assert.equal(v.mode, 'apply');
  });

  it('accepts Kleinanzeigen search URLs as scan mode', () => {
    const v = validateAnySearchUrl('https://www.kleinanzeigen.de/s-wohnung-kaufen/berlin/c196l3331');
    assert.equal(v.ok, true);
    assert.equal(v.source, SOURCE_KLEINANZEIGEN);
    assert.equal(v.mode, 'scan');
    assert.equal(v.mobileUrl, '');
  });

  it('rejects Kleinanzeigen non-search URLs', () => {
    const v = validateAnySearchUrl('https://www.kleinanzeigen.de/hilfe');
    assert.equal(v.ok, false);
  });

  it('accepts Neubaukompass project-search URLs as scan mode', () => {
    const v = validateAnySearchUrl('https://www.neubaukompass.de/neubau-immobilien/berlin-region/');
    assert.equal(v.ok, true);
    assert.equal(v.source, SOURCE_NEUBAUKOMPASS);
    assert.equal(v.mode, 'scan');
  });

  it('routes unknown hosts through the IS24 validator error copy', () => {
    const v = validateAnySearchUrl('https://example.com/Suche/de/berlin/berlin/wohnung-mieten');
    assert.equal(v.ok, false);
    assert.match(v.error, /immobilienscout24/);
  });
});

// ---------------------------------------------------------------------------

const KA_FIXTURE = `
<article class="aditem" data-adid="3315808121" data-href="/s-anzeige/3-zimmer-wohnung/3315808121-196-3353">
  <div class="aditem-image">
    <a href="/s-anzeige/3-zimmer-wohnung/3315808121-196-3353">
      <div class="imagebox srpimagebox">
        <img src="https://img.kleinanzeigen.de/api/v1/prod-ads/images/fa/example?rule=$_59.AUTO" alt="preview" />
      </div>
    </a>
  </div>
  <div class="aditem-main">
    <div class="aditem-main--top">
      <div class="aditem-main--top--left">
        <i class="icon icon-small icon-pin-gray" aria-hidden="true"></i>
        10247 Friedrichshain
      </div>
    </div>
    <div class="aditem-main--middle">
      <h2 class="text-module-begin">
        <a class="ellipsis" href="/s-anzeige/3-zimmer-wohnung/3315808121-196-3353">3-Zimmer-Wohnung mit Terrasse &amp; Garten</a>
      </h2>
      <p class="aditem-main--middle--tags"> 67,30 m&#178; &#183; 3 Zi. </p>
      <div class="aditem-main--middle--price-shipping">
        <p class="aditem-main--middle--price-shipping--price"> 320.000 &#8364; </p>
      </div>
    </div>
  </div>
</article>`;

describe('parseKleinanzeigenHtml', () => {
  it('extracts normalised listings from result-page HTML', () => {
    const listings = parseKleinanzeigenHtml(KA_FIXTURE);
    assert.equal(listings.length, 1);
    const l = listings[0];
    assert.equal(l.expose_id, 'ka-3315808121');
    assert.equal(l.title, '3-Zimmer-Wohnung mit Terrasse & Garten');
    assert.equal(l.price, 320000);
    assert.equal(l.size, 67.3);
    assert.equal(l.rooms, 3);
    assert.equal(l.postcode, '10247');
    assert.equal(l.source, 'kleinanzeigen');
    assert.ok(l.url.startsWith('https://www.kleinanzeigen.de/s-anzeige/'));
  });

  it('returns empty array for pages without ad articles', () => {
    assert.deepEqual(parseKleinanzeigenHtml('<html><body>nix</body></html>'), []);
  });
});

describe('fetchAnyListings — kleinanzeigen pagination', () => {
  it('inserts the seite:N segment before the category code', async () => {
    let requestedUrl = null;
    globalThis.fetch = async (url) => { requestedUrl = String(url); return mockHtmlResponse(KA_FIXTURE); };
    const { listings, error } = await fetchAnyListings('https://www.kleinanzeigen.de/s-wohnung-kaufen/berlin/c196l3331', 2);
    assert.equal(error, null);
    assert.equal(listings.length, 1);
    assert.match(requestedUrl, /\/s-wohnung-kaufen\/berlin\/seite:2\/c196l3331$/);
  });
});

describe('parseNeubaukompassHtml', () => {
  it('prefers JSON-LD structured data', () => {
    const html = `
      <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"ItemList","itemListElement":[
        {"@type":"ListItem","item":{"@type":"Residence","name":"Quartier Am Park",
          "url":"/neubau/quartier-am-park/","image":"https://img.example/x.jpg",
          "address":{"streetAddress":"Parkstr. 1","postalCode":"13086","addressLocality":"Berlin"},
          "offers":{"lowPrice":"350000"}}}]}
      </script>`;
    const listings = parseNeubaukompassHtml(html);
    assert.equal(listings.length, 1);
    assert.equal(listings[0].expose_id, 'nbk-quartier-am-park');
    assert.equal(listings[0].title, 'Quartier Am Park');
    assert.equal(listings[0].price, 350000);
    assert.equal(listings[0].postcode, '13086');
    assert.equal(listings[0].source, 'neubaukompass');
  });

  it('falls back to project links when no JSON-LD is present', () => {
    const html = '<a href="/neubau/wohnpark-sued/">Wohnpark Süd — Neubauprojekt in Berlin</a>';
    const listings = parseNeubaukompassHtml(html);
    assert.equal(listings.length, 1);
    assert.equal(listings[0].expose_id, 'nbk-wohnpark-sued');
    assert.match(listings[0].url, /neubaukompass\.de\/neubau\/wohnpark-sued\//);
  });
});

// ---------------------------------------------------------------------------

describe('fetchIs24ExposeDetails', () => {
  it('computes the postcode-shape centroid and collects details', async () => {
    globalThis.fetch = async () => mockJsonResponse({
      sections: [
        { type: 'TOP_ATTRIBUTES', attributes: [{ label: 'Kaufpreis', text: '899.000 €', type: 'TEXT' }] },
        {
          type: 'MAP',
          addressLine1: 'Die vollständige Adresse der Immobilie erhältst du vom Anbieter.',
          addressLine2: '14050 Westend, Berlin',
          zipCodeShapes: [
            { outline: [{ lat: 52.0, lng: 13.0 }, { lat: 54.0, lng: 15.0 }] },
          ],
        },
        { type: 'ATTRIBUTE_LIST', title: 'Kosten', attributes: [{ type: 'TEXT', label: 'Hausgeld:', text: '455 €' }, { type: 'CHECK', label: 'Aufzug:' }] },
        { type: 'TEXT_AREA', title: 'Lage', text: 'Ruhige Lage.' },
      ],
    });
    const result = await fetchIs24ExposeDetails('123');
    assert.equal(result.error, null);
    assert.equal(result.lat, 53.0);
    assert.equal(result.lng, 14.0);
    assert.equal(result.details.address, '14050 Westend, Berlin');
    assert.equal(result.details.attributeGroups.length, 2);
    assert.equal(result.details.attributeGroups[1].items[0].label, 'Hausgeld');
    assert.equal(result.details.attributeGroups[1].items[1].text, '✓');
    assert.deepEqual(result.details.texts, [{ title: 'Lage', text: 'Ruhige Lage.' }]);
  });

  it('prefers an exact location over shape centroids', async () => {
    globalThis.fetch = async () => mockJsonResponse({
      sections: [{ type: 'MAP', location: { lat: 52.5, lng: 13.4 }, zipCodeShapes: [{ outline: [{ lat: 1, lng: 1 }] }] }],
    });
    const result = await fetchIs24ExposeDetails('123');
    assert.equal(result.lat, 52.5);
    assert.equal(result.lng, 13.4);
  });

  it('surfaces HTTP errors without throwing', async () => {
    globalThis.fetch = async () => mockJsonResponse({}, { status: 404 });
    const result = await fetchIs24ExposeDetails('123');
    assert.equal(result.error, 'HTTP 404');
    assert.equal(result.lat, null);
  });
});

describe('geocodePostcode', () => {
  it('uses the DB cache before hitting Nominatim', async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return mockJsonResponse([]); };
    const db = { getGeoCache: () => ({ postcode: '10115', lat: 52.53, lng: 13.38 }), setGeoCache: () => {} };
    const result = await geocodePostcode('10115', db);
    assert.deepEqual(result, { lat: 52.53, lng: 13.38 });
    assert.equal(fetchCalled, false);
  });

  it('resolves and caches on miss', async () => {
    globalThis.fetch = async () => mockJsonResponse([{ lat: '52.5300', lon: '13.3800' }]);
    const cached = {};
    const db = { getGeoCache: () => undefined, setGeoCache: (code, lat, lng) => { cached[code] = { lat, lng }; } };
    const result = await geocodePostcode('10115', db);
    assert.deepEqual(result, { lat: 52.53, lng: 13.38 });
    assert.deepEqual(cached['10115'], { lat: 52.53, lng: 13.38 });
  });

  it('returns null for invalid postcodes without any request', async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return mockJsonResponse([]); };
    assert.equal(await geocodePostcode('abc', null), null);
    assert.equal(fetchCalled, false);
  });
});
