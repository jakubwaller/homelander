// IS24 Web URL → Mobile API translator.
// Ported from orangecoding/fredy:lib/services/immoscout/immoscout-web-translator.js
//
// Converts user-facing IS24 search URLs to mobile API parameters.
// The mobile API is completely public — no auth, works from any IP.
// Just needs a spoofed Android User-Agent.

const MOBILE_API_BASE = 'https://api.mobile.immobilienscout24.de/search/list';

// Map IS24 web path segments to mobile API parameters
const REALESTATE_TYPE_MAP = {
  'wohnung-mieten': 'apartmentrent',
  'wohnung-kaufen': 'apartmentbuy',
  'haus-mieten': 'houserent',
  'haus-kaufen': 'housebuy',
  'grundstueck-kaufen': 'plotbuy',
  'wohnung-mieten-tausch': 'apartmentrent',
};

const PRICE_TYPE_MAP = {
  'wohnung-mieten': 'calculatedtotalrent',
  'haus-mieten': 'calculatedtotalrent',
  'wohnung-kaufen': 'purchaseprice',
  'haus-kaufen': 'purchaseprice',
};

// Key: web URL parameter name → mobile API parameter name
const PARAM_MAP = {
  'price': 'price',
  'numberofrooms': 'numberofrooms',
  'livingspace': 'livingspace',
  'pricetype': 'pricetype',
  'exclusioncriteria': 'exclusioncriteria',
  'has-pictures': 'hasPictures',
  'ageofconstruction': 'ageOfConstruction',
  'floor': 'floor',
  'balcony': 'balcony',
  'garden': 'garden',
  'cellar': 'cellar',
  'built-in-kitchen': 'equipment',
  'guest-toilet': 'equipment',
  'elevator': 'elevator',
  'barrier-free': 'barrierFree',
  'parking': 'parkingSpace',
  'pets-allowed': 'petsAllowed',
  'energy-efficiency': 'energyEfficiency',
};

// SEO-friendly path segments that encode price filters
const SEO_PRICE_PATTERNS = [
  /wohnung-bis-(\d+)-euro-warm/,
  /wohnung-bis-(\d+)-euro-kalt/,
  /haus-bis-(\d+)-euro/,
];

/**
 * Parse an IS24 web search URL and return mobile API query parameters.
 * @param {string} webUrl
 * @returns {{ fullUrl: string, error: string|null }}
 */
export function translateUrl(webUrl) {
  try {
    const url = new URL(webUrl);
    const pathParts = url.pathname.split('/').filter(Boolean);

    const sucheIdx = pathParts.findIndex(p => p.toLowerCase() === 'suche');
    if (sucheIdx === -1) {
      return { fullUrl: '', error: 'URL does not contain /Suche/ path' };
    }

    const afterSuche = pathParts.slice(sucheIdx + 1);
    const realEstateType = afterSuche.find(p => REALESTATE_TYPE_MAP[p]);
    const typeIdx = afterSuche.indexOf(realEstateType);
    const geocodeParts = typeIdx > 0 ? afterSuche.slice(0, typeIdx) : afterSuche.filter(p => !REALESTATE_TYPE_MAP[p]);

    // Build query string manually to avoid double-encoding
    const qsParts = [];

    // Geocodes
    if (geocodeParts.length > 0) {
      const geoPath = '/' + geocodeParts.join('/');
      qsParts.push(`geocodes=${encodeURIComponent(geoPath)}`);
    }

    // Search type
    let searchType = 'region';
    if (geocodeParts[0] === 'radius') searchType = 'radius';
    else if (geocodeParts[0] === 'shape') searchType = 'shape';
    qsParts.push(`searchType=${searchType}`);

    // Real estate type + price type
    const mobileType = REALESTATE_TYPE_MAP[realEstateType] || 'apartmentrent';
    qsParts.push(`realestatetype=${mobileType}`);
    const priceType = PRICE_TYPE_MAP[realEstateType] || 'calculatedtotalrent';
    qsParts.push(`pricetype=${priceType}`);

    // Map web URL query params
    for (const [key, value] of url.searchParams) {
      const mappedKey = PARAM_MAP[key];
      if (mappedKey) {
        qsParts.push(`${mappedKey}=${encodeURIComponent(value)}`);
      }
    }

    // SEO-encoded price
    const lastPathSegment = afterSuche[afterSuche.length - 1] || '';
    for (const pattern of SEO_PRICE_PATTERNS) {
      const match = lastPathSegment.match(pattern);
      if (match) {
        qsParts.push(`price=-${match[1]}`);
        if (lastPathSegment.includes('warm')) {
          // Replace existing pricetype if set
          const ptIdx = qsParts.findIndex(p => p.startsWith('pricetype='));
          if (ptIdx >= 0) qsParts[ptIdx] = 'pricetype=calculatedtotalrent';
        }
        break;
      }
    }

    // Exclude Tauschwohnung (swap apartments) by default — user wants real rentals
    if (!webUrl.includes('tausch')) {
      qsParts.push('exclusioncriteria=swapFlat');
    }

    // Sorting + pagination
    qsParts.push('sorting=-firstactivation');
    qsParts.push('pagenumber=1');
    qsParts.push('pagesize=20');

    return { fullUrl: `${MOBILE_API_BASE}?${qsParts.join('&')}`, error: null };
  } catch (err) {
    return { fullUrl: '', error: err.message };
  }
}

/**
 * Fetch total result count for a search URL (used by "Test" button in Add Search dialog).
 * @param {string} webUrl
 * @returns {Promise<{total: number, error: string|null}>}
 */
export async function getTotalResults(webUrl) {
  const { fullUrl, error } = translateUrl(webUrl);
  if (error) return { total: 0, error };

  // Use the /search/total endpoint
  const totalUrl = fullUrl
    .replace('/search/list?', '/search/total?')
    .replace(/&pagenumber=\d+/, '')
    .replace(/&pagesize=\d+/, '')
    .replace(/&sorting=[^&]+/, '');

  try {
    const resp = await fetch(totalUrl, {
      headers: {
        'User-Agent': 'ImmoScout_27.12_26.2_._',
        'Accept': 'application/json',
      },
    });
    if (!resp.ok) return { total: 0, error: `HTTP ${resp.status}` };
    const data = await resp.json();
    return { total: data.totalResults || data.numberOfHits || data.total || 0, error: null };
  } catch (err) {
    return { total: 0, error: err.message };
  }
}

/**
 * Fetch listings from the mobile API.
 * @param {string} webUrl
 * @param {number} [page=1]
 * @returns {Promise<{listings: Array, error: string|null}>}
 */
export async function fetchListings(webUrl, page = 1) {
  const { fullUrl, error } = translateUrl(webUrl);
  if (error) return { listings: [], error };

  // Set page number
  const fetchUrl = fullUrl.replace(/&pagenumber=\d+/, `&pagenumber=${page}`);

  try {
    const resp = await fetch(fetchUrl, {
      method: 'POST',
      headers: {
        'User-Agent': 'ImmoScout_27.12_26.2_._',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ supportedResultListTypes: [], userData: {} }),
    });

    if (!resp.ok) return { listings: [], error: `HTTP ${resp.status}` };

    const data = await resp.json();
    const items = data.resultListItems || [];

    const listings = items.map((item) => {
      const expose = item.item || item;
      const attrs = {};
      if (Array.isArray(expose.attributes)) {
        for (const attr of expose.attributes) {
          if (attr.attribute && attr.value) {
            attrs[attr.attribute] = attr.value;
          }
        }
      }

      return {
        expose_id: String(expose.id || expose.exposeId || ''),
        title: expose.title || '',
        price: parseFloat(attrs.price || attrs.totalRent || attrs.purchasePrice || 0),
        size: parseFloat(attrs.livingSpace || attrs.area || 0),
        rooms: parseFloat(attrs.numberOfRooms || 0),
        address: expose.address?.line || expose.address || '',
        image_url: expose.titlePicture?.full || expose.titlePicture?.preview || '',
      };
    });

    return { listings, error: null };
  } catch (err) {
    return { listings: [], error: err.message };
  }
}
