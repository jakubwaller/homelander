// Unit tests for url-translator.js (engine/url-translator.js).
// Run: node --test test/url-translator.test.js
//
// Tests translateUrl, getTotalResults, and fetchListings.
// Mocks global fetch to avoid real network calls.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { translateUrl, getTotalResults, fetchListings } from '../engine/url-translator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Original global fetch reference for restore. */
let originalFetch;

before(() => {
  originalFetch = globalThis.fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

/** Install a mock fetch that returns a given response. */
function mockFetch(responseFactory) {
  globalThis.fetch = async (url, init) => {
    if (typeof responseFactory === 'function') {
      return responseFactory(url, init);
    }
    return responseFactory;
  };
}

/** Create a mock Response object. */
function mockResponse(body, status = 200, ok = true) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

// ---------------------------------------------------------------------------
// translateUrl — successful translations
// ---------------------------------------------------------------------------

describe('translateUrl — Hamburg', () => {
  it('basic Hamburg apartment rent URL', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/hamburg/hamburg/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.startsWith('https://api.mobile.immobilienscout24.de/search/list?'));
    assert.ok(fullUrl.includes('geocodes=%2Fde%2Fhamburg%2Fhamburg'));
    assert.ok(fullUrl.includes('searchType=region'));
    assert.ok(fullUrl.includes('realestatetype=apartmentrent'));
    assert.ok(fullUrl.includes('pricetype=calculatedtotalrent'));
    assert.ok(fullUrl.includes('exclusioncriteria=swapFlat'));
    assert.ok(fullUrl.includes('sorting=-firstactivation'));
    assert.ok(fullUrl.includes('pagenumber=1'));
    assert.ok(fullUrl.includes('pagesize=20'));
  });

  it('Hamburg with price and rooms params', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/hamburg/hamburg/wohnung-mieten?price=-1000&numberofrooms=2'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('price=-1000'));
    assert.ok(fullUrl.includes('numberofrooms=2'));
  });

  it('Hamburg house rent', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/hamburg/hamburg/haus-mieten'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('realestatetype=houserent'));
    assert.ok(fullUrl.includes('pricetype=calculatedtotalrent'));
  });
});

describe('translateUrl — Berlin', () => {
  it('basic Berlin apartment rent URL', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('geocodes=%2Fde%2Fberlin%2Fberlin'));
    assert.ok(fullUrl.includes('realestatetype=apartmentrent'));
  });

  it('Berlin apartment buy', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-kaufen'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('realestatetype=apartmentbuy'));
    assert.ok(fullUrl.includes('pricetype=purchaseprice'));
  });

  it('Berlin house buy', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/haus-kaufen'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('realestatetype=housebuy'));
    assert.ok(fullUrl.includes('pricetype=purchaseprice'));
  });

  it('Berlin with multiple query params', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?price=-1500&livingspace=60&has-pictures=1&balcony=1'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('price=-1500'));
    assert.ok(fullUrl.includes('livingspace=60'));
    assert.ok(fullUrl.includes('hasPictures=1'));
    assert.ok(fullUrl.includes('balcony=1'));
  });
});

describe('translateUrl — Munich', () => {
  it('basic Munich apartment rent URL', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/bayern/muenchen/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('geocodes=%2Fde%2Fbayern%2Fmuenchen'));
    assert.ok(fullUrl.includes('realestatetype=apartmentrent'));
  });

  it('Munich with many amenities', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/bayern/muenchen/wohnung-mieten?balcony=1&elevator=1&parking=1&cellar=1'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('balcony=1'));
    assert.ok(fullUrl.includes('elevator=1'));
    assert.ok(fullUrl.includes('parkingSpace=1'));   // mapped
    assert.ok(fullUrl.includes('cellar=1'));
  });

  it('Munich with unmapped query params are excluded', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/bayern/muenchen/wohnung-mieten?unknown=foo&other=bar'
    );
    assert.equal(error, null);
    assert.ok(!fullUrl.includes('unknown='));
    assert.ok(!fullUrl.includes('other='));
  });
});

describe('translateUrl — additional realestate types', () => {
  it('grundstueck-kaufen (plot buy)', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/brandenburg/potsdam/grundstueck-kaufen'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('realestatetype=plotbuy'));
  });

  it('wohnung-mieten-tausch (swap apartments)', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten-tausch'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('realestatetype=apartmentrent'));
  });

  it('swap apartment URL does NOT add exclusioncriteria=swapFlat', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten-tausch'
    );
    assert.equal(error, null);
    assert.ok(!fullUrl.includes('exclusioncriteria=swapFlat'));
  });
});

describe('translateUrl — parameter mappings', () => {
  it('maps has-pictures → hasPictures', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?has-pictures=1'
    );
    assert.ok(fullUrl.includes('hasPictures=1'));
  });

  it('maps ageofconstruction → ageOfConstruction', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?ageofconstruction=3'
    );
    assert.ok(fullUrl.includes('ageOfConstruction=3'));
  });

  it('maps barrier-free → barrierFree', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?barrier-free=1'
    );
    assert.ok(fullUrl.includes('barrierFree=1'));
  });

  it('maps parking → parkingSpace', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?parking=1'
    );
    assert.ok(fullUrl.includes('parkingSpace=1'));
  });

  it('maps pets-allowed → petsAllowed', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?pets-allowed=1'
    );
    assert.ok(fullUrl.includes('petsAllowed=1'));
  });

  it('maps energy-efficiency → energyEfficiency', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?energy-efficiency=A%2B'
    );
    assert.ok(fullUrl.includes('energyEfficiency=A%2B'));
  });

  it('maps guest-toilet and built-in-kitchen → equipment', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?built-in-kitchen=1&guest-toilet=1'
    );
    assert.ok(fullUrl.includes('equipment=1'));
  });
});

// ---------------------------------------------------------------------------
// translateUrl — edge cases
// ---------------------------------------------------------------------------

describe('translateUrl — edge cases', () => {
  it('handles case-insensitive Suche', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('geocodes=%2Fde%2Fberlin%2Fberlin'));
  });

  it('handles mixed-case Suche', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/SuChE/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('geocodes=%2Fde%2Fberlin%2Fberlin'));
  });

  it('handles radius search type', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/radius/berlin/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('searchType=radius'));
  });

  it('handles shape search type', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/shape/berlin/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('searchType=shape'));
  });

  it('encodes special characters in path segments', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin-mitte/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('berlin-mitte'));
  });
});

// ---------------------------------------------------------------------------
// translateUrl — error cases
// ---------------------------------------------------------------------------

describe('translateUrl — error cases', () => {
  it('returns error for non-IS24 URL', () => {
    const { fullUrl, error } = translateUrl('https://example.com/page');
    assert.equal(fullUrl, '');
    assert.ok(error.includes('does not contain /Suche/'));
  });

  it('returns error for URL without Suche path', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/expose/12345'
    );
    assert.equal(fullUrl, '');
    assert.ok(error.includes('does not contain /Suche/'));
  });

  it('returns error for completely malformed URL', () => {
    const { fullUrl, error } = translateUrl('not-a-url');
    assert.equal(fullUrl, '');
    assert.ok(error.length > 0); // URL constructor throws
  });

  it('returns error for empty string', () => {
    const { fullUrl, error } = translateUrl('');
    assert.equal(fullUrl, '');
    assert.ok(error.length > 0);
  });

  it('handles URL with Suche but no realestate type (uses defaults)', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('realestatetype=apartmentrent')); // default
  });

  it('handles Suche-only URL (empty afterSuche)', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche'
    );
    assert.equal(error, null);
    // Still produces a URL with defaults
    assert.ok(fullUrl.startsWith('https://api.mobile.immobilienscout24.de/search/list?'));
  });
});

// ---------------------------------------------------------------------------
// getTotalResults
// ---------------------------------------------------------------------------

describe('getTotalResults', () => {
  beforeEach(() => {
    // Reset fetch
    globalThis.fetch = originalFetch;
  });

  it('returns error for invalid URL (non-IS24)', async () => {
    const result = await getTotalResults('https://example.com');
    assert.equal(result.total, 0);
    assert.ok(result.error.includes('does not contain /Suche/'));
  });

  it('constructs the correct total URL from a search URL', async () => {
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return mockResponse({ totalResults: 42 });
    };

    const result = await getTotalResults(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(result.total, 42);
    assert.equal(result.error, null);
    // Verify it hits /search/total (not /search/list)
    assert.ok(capturedUrl.includes('/search/total?'));
    // Verify pagination/sorting params are stripped
    assert.ok(!capturedUrl.includes('pagenumber='));
    assert.ok(!capturedUrl.includes('pagesize='));
    assert.ok(!capturedUrl.includes('sorting='));
  });

  it('returns total from numberOfHits when totalResults missing', async () => {
    globalThis.fetch = async () => mockResponse({ numberOfHits: 99 });
    const result = await getTotalResults(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(result.total, 99);
  });

  it('returns total from "total" field when others missing', async () => {
    globalThis.fetch = async () => mockResponse({ total: 7 });
    const result = await getTotalResults(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(result.total, 7);
  });

  it('returns 0 when response has no count fields', async () => {
    globalThis.fetch = async () => mockResponse({ foo: 'bar' });
    const result = await getTotalResults(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(result.total, 0);
  });

  it('returns error on HTTP failure', async () => {
    globalThis.fetch = async () => mockResponse({}, 500, false);
    const result = await getTotalResults(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(result.total, 0);
    assert.equal(result.error, 'HTTP 500');
  });

  it('returns error on network failure', async () => {
    globalThis.fetch = async () => { throw new Error('Network error'); };
    const result = await getTotalResults(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(result.total, 0);
    assert.equal(result.error, 'Network error');
  });
});

// ---------------------------------------------------------------------------
// fetchListings
// ---------------------------------------------------------------------------

describe('fetchListings', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns error for invalid URL', async () => {
    const result = await fetchListings('https://example.com');
    assert.deepEqual(result.listings, []);
    assert.ok(result.error.includes('does not contain /Suche/'));
  });

  it('fetches and transforms listings from the mobile API', async () => {
    globalThis.fetch = async (url) => {
      return mockResponse({
        resultListItems: [
          {
            item: {
              id: '142345678',
              title: 'Schöne 3-Zimmer Wohnung',
              attributes: [
                { attribute: 'totalRent', value: '950' },
                { attribute: 'livingSpace', value: '78.5' },
                { attribute: 'numberOfRooms', value: '3' },
              ],
              address: { line: 'Musterstraße 1, 10115 Berlin' },
              titlePicture: {
                full: 'https://pictures.is24.de/abc123_full.jpg',
                preview: 'https://pictures.is24.de/abc123_preview.jpg',
              },
            },
          },
        ],
      });
    };

    const { listings, error } = await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.equal(listings.length, 1);

    const l = listings[0];
    assert.equal(l.expose_id, '142345678');
    assert.equal(l.title, 'Schöne 3-Zimmer Wohnung');
    assert.equal(l.price, 950);
    assert.equal(l.size, 78.5);
    assert.equal(l.rooms, 3);
    assert.equal(l.address, 'Musterstraße 1, 10115 Berlin');
    assert.equal(l.image_url, 'https://pictures.is24.de/abc123_full.jpg');
  });

  it('falls back to exposeId when id is missing', async () => {
    globalThis.fetch = async () => mockResponse({
      resultListItems: [
        {
          item: {
            exposeId: '98765',
            title: 'Fallback ID',
            attributes: [],
            address: '',
            titlePicture: null,
          },
        },
      ],
    });

    const { listings, error } = await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.equal(listings[0].expose_id, '98765');
  });

  it('handles missing optional fields gracefully', async () => {
    globalThis.fetch = async () => mockResponse({
      resultListItems: [
        {
          item: {
            id: '1',
            title: '',
            attributes: [],
            address: '',
          },
        },
      ],
    });

    const { listings, error } = await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.equal(listings[0].expose_id, '1');
    assert.equal(listings[0].title, '');
    assert.equal(listings[0].price, 0);
    assert.equal(listings[0].size, 0);
    assert.equal(listings[0].rooms, 0);
    assert.equal(listings[0].address, '');
    assert.equal(listings[0].image_url, '');
  });

  it('uses preview image when full is missing', async () => {
    globalThis.fetch = async () => mockResponse({
      resultListItems: [
        {
          item: {
            id: '1',
            title: 'Preview image',
            attributes: [],
            address: '',
            titlePicture: { preview: 'https://pictures.is24.de/preview.jpg' },
          },
        },
      ],
    });

    const { listings, error } = await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.equal(listings[0].image_url, 'https://pictures.is24.de/preview.jpg');
  });

  it('handles flat item structure (no nested item)', async () => {
    globalThis.fetch = async () => mockResponse({
      resultListItems: [
        {
          id: 'flat123',
          title: 'Flat Structure',
          attributes: [
            { attribute: 'purchasePrice', value: '250000' },
            { attribute: 'livingSpace', value: '100' },
            { attribute: 'numberOfRooms', value: '4' },
          ],
          address: 'Flat Address',
        },
      ],
    });

    const { listings, error } = await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-kaufen'
    );
    assert.equal(error, null);
    assert.equal(listings[0].expose_id, 'flat123');
    assert.equal(listings[0].price, 250000);
    assert.equal(listings[0].size, 100);
    assert.equal(listings[0].rooms, 4);
  });

  it('returns empty listings for empty resultListItems', async () => {
    globalThis.fetch = async () => mockResponse({ resultListItems: [] });
    const { listings, error } = await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.deepEqual(listings, []);
    assert.equal(error, null);
  });

  it('returns empty listings when resultListItems is missing', async () => {
    globalThis.fetch = async () => mockResponse({ otherField: true });
    const { listings, error } = await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.deepEqual(listings, []);
    assert.equal(error, null);
  });

  it('respects page parameter', async () => {
    let capturedUrl;
    globalThis.fetch = async (url, init) => {
      capturedUrl = url;
      return mockResponse({ resultListItems: [] });
    };

    await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten',
      3
    );
    assert.ok(capturedUrl.includes('pagenumber=3'));
  });

  it('returns error on HTTP failure', async () => {
    globalThis.fetch = async () => mockResponse({}, 429, false);
    const result = await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.deepEqual(result.listings, []);
    assert.equal(result.error, 'HTTP 429');
  });

  it('returns error on network failure', async () => {
    globalThis.fetch = async () => { throw new Error('Connection refused'); };
    const result = await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.deepEqual(result.listings, []);
    assert.equal(result.error, 'Connection refused');
  });

  it('skips attributes with missing attribute/value keys', async () => {
    globalThis.fetch = async () => mockResponse({
      resultListItems: [
        {
          item: {
            id: '1',
            title: 'Broken attrs',
            attributes: [
              { attribute: 'totalRent', value: '500' },
              {},                                                    // missing both
              { attribute: 'rooms' },                                 // missing value
              { value: '2' },                                         // missing attribute
              { attribute: 'livingSpace', value: '60' },
            ],
            address: '',
          },
        },
      ],
    });

    const { listings, error } = await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.equal(listings[0].price, 500);   // from totalRent
    assert.equal(listings[0].size, 60);     // from livingSpace
    assert.equal(listings[0].rooms, 0);     // 'rooms' attr had no value key
  });
});

// ---------------------------------------------------------------------------
// MOBILE_API_BASE constant (implicitly tested via all translations)
// ---------------------------------------------------------------------------

describe('mobile API base URL', () => {
  it('all successful translations point to the mobile API', () => {
    const urls = [
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten',
      'https://www.immobilienscout24.de/Suche/de/hamburg/hamburg/wohnung-mieten',
      'https://www.immobilienscout24.de/Suche/de/bayern/muenchen/wohnung-mieten',
    ];
    for (const url of urls) {
      const { fullUrl, error } = translateUrl(url);
      assert.equal(error, null);
      assert.ok(
        fullUrl.startsWith('https://api.mobile.immobilienscout24.de/search/list?'),
        `Expected mobile API base for: ${url}`
      );
    }
  });
});
