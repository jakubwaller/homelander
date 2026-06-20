// IS24 Web URL → canonical Homelander search model → Mobile API translator.
// The mobile API is public; Homelander imports search links conservatively:
// known result-affecting params are parsed, tracking params are ignored safely,
// unknown params are surfaced by validateSearchUrl() instead of silently saved.

const MOBILE_API_BASE = 'https://api.mobile.immobilienscout24.de/search/list';

const REALESTATE_TYPE_MAP = {
  'wohnung-mieten': 'apartmentrent',
  'wohnung-kaufen': 'apartmentbuy',
  'haus-mieten': 'houserent',
  'haus-kaufen': 'housebuy',
  'grundstueck-kaufen': 'plotbuy',
  'wohnung-mieten-tausch': 'apartmentrent',
  'neubauwohnung-mieten': 'apartmentrent',
  'neubauwohnung-kaufen': 'apartmentbuy',
  'neubauhaus-mieten': 'houserent',
  'neubauhaus-kaufen': 'housebuy',
};

const NEW_BUILD_TYPES = new Set([
  'neubauwohnung-mieten',
  'neubauwohnung-kaufen',
  'neubauhaus-mieten',
  'neubauhaus-kaufen',
]);

const PRICE_TYPE_MAP = {
  'wohnung-mieten': 'calculatedtotalrent',
  'neubauwohnung-mieten': 'calculatedtotalrent',
  'haus-mieten': 'calculatedtotalrent',
  'neubauhaus-mieten': 'calculatedtotalrent',
  'wohnung-kaufen': 'purchaseprice',
  'neubauwohnung-kaufen': 'purchaseprice',
  'haus-kaufen': 'purchaseprice',
  'neubauhaus-kaufen': 'purchaseprice',
  'grundstueck-kaufen': 'purchaseprice',
};

const PREVIEW_I18N = {
  en: {
    realEstate: {
      apartmentrent: 'Apartment rent',
      apartmentbuy: 'Apartment buy',
      houserent: 'House rent',
      housebuy: 'House buy',
      plotbuy: 'Plot buy',
    },
    heating: {
      CENTRAL_HEATING: 'central heating',
      SELF_CONTAINED_CENTRAL_HEATING: 'self-contained central heating',
      FLOOR_HEATING: 'floor heating',
      GAS_HEATING: 'gas heating',
      OIL_HEATING: 'oil heating',
      DISTRICT_HEATING: 'district heating',
      NIGHT_STORAGE_HEATER: 'night storage heating',
      STOVE_HEATING: 'stove heating',
      WOOD_PELLET_HEATING: 'wood pellet heating',
      HEAT_PUMP: 'heat pump',
      SOLAR_HEATING: 'solar heating',
    },
    equipment: {
      HANDICAPPED_ACCESSIBLE: 'barrier-free',
      BALCONY: 'balcony',
      GARDEN: 'garden',
      BUILT_IN_KITCHEN: 'built-in kitchen',
      LIFT: 'elevator',
      PARKING_SPACE: 'parking',
      GUEST_TOILET: 'guest toilet',
      CELLAR: 'cellar',
      FRIDGE: 'fridge',
      COOKER: 'cooker',
      PETS_ALLOWED: 'pets allowed',
      INTERNET: 'internet',
    },
    labels: {
      allGermany: 'All Germany',
      newBuildPrefix: 'New-build',
      price: 'Price',
      rooms: 'Rooms',
      livingSpace: 'Living space',
      heating: 'Heating',
      equipment: 'Equipment',
      energy: 'Energy',
      pets: 'Pets',
      any: 'any',
      selected: 'selected',
      unsupportedFilters: 'Unsupported IS24 search filters',
      mobileRejects: (label) => `The IS24 mobile API rejects ${label} filters; Homelander keeps the supported parts of the search.`,
    },
  },
  de: {
    realEstate: {
      apartmentrent: 'Wohnung zur Miete',
      apartmentbuy: 'Wohnung zum Kauf',
      houserent: 'Haus zur Miete',
      housebuy: 'Haus zum Kauf',
      plotbuy: 'Grundstück zum Kauf',
    },
    heating: {
      CENTRAL_HEATING: 'Zentralheizung',
      SELF_CONTAINED_CENTRAL_HEATING: 'Etagenheizung',
      FLOOR_HEATING: 'Fußbodenheizung',
      GAS_HEATING: 'Gasheizung',
      OIL_HEATING: 'Ölheizung',
      DISTRICT_HEATING: 'Fernwärme',
      NIGHT_STORAGE_HEATER: 'Nachtspeicherheizung',
      STOVE_HEATING: 'Ofenheizung',
      WOOD_PELLET_HEATING: 'Pelletheizung',
      HEAT_PUMP: 'Wärmepumpe',
      SOLAR_HEATING: 'Solarheizung',
    },
    equipment: {
      HANDICAPPED_ACCESSIBLE: 'barrierefrei',
      BALCONY: 'Balkon',
      GARDEN: 'Garten',
      BUILT_IN_KITCHEN: 'Einbauküche',
      LIFT: 'Aufzug',
      PARKING_SPACE: 'Stellplatz',
      GUEST_TOILET: 'Gäste-WC',
      CELLAR: 'Keller',
      FRIDGE: 'Kühlschrank',
      COOKER: 'Herd',
      PETS_ALLOWED: 'Haustiere erlaubt',
      INTERNET: 'Internet',
    },
    labels: {
      allGermany: 'Deutschlandweit',
      newBuildPrefix: 'Neubau',
      price: 'Preis',
      rooms: 'Zimmer',
      livingSpace: 'Wohnfläche',
      heating: 'Heizung',
      equipment: 'Ausstattung',
      energy: 'Energie',
      pets: 'Haustiere',
      any: 'egal',
      selected: 'ausgewählt',
      unsupportedFilters: 'Nicht unterstützte IS24-Suchfilter',
      mobileRejects: (label) => `Die IS24 Mobile API lehnt Filter für ${label} ab; Homelander übernimmt die unterstützten Teile der Suche.`,
    },
  },
};

function previewLocale(locale = 'en') {
  return PREVIEW_I18N[String(locale).toLowerCase().startsWith('de') ? 'de' : 'en'];
}

const SAFE_IGNORED_PARAM_PATTERNS = [
  /^enteredfrom$/i,
  /^utm_/i,
  /^referrer$/i,
  /^referrerurl$/i,
  /^from$/i,
  /^viewmode$/i,
  /^sorting$/i,
  /^pagenumber$/i,
  /^pagesize$/i,
];

// Direct query passthroughs kept for legacy coverage and known mobile API params.
const DIRECT_PARAM_MAP = {
  'exclusioncriteria': 'exclusioncriteria',
  'has-pictures': 'hasPictures',
  'ageofconstruction': 'ageOfConstruction',
  'energyefficiencyclasses': 'energyefficiencyclasses',
  'petsallowedtypes': 'petsallowedtypes',
  'floor': 'floor',
  'balcony': 'balcony',
  'garden': 'garden',
  'cellar': 'cellar',
  'elevator': 'elevator',
  'barrier-free': 'barrierFree',
  'parking': 'parkingSpace',
  'pets-allowed': 'petsAllowed',
  'energy-efficiency': 'energyEfficiency',
};

const HEATING_TYPE_MAP = {
  central: 'CENTRAL_HEATING',
  selfcontainedcentral: 'SELF_CONTAINED_CENTRAL_HEATING',
  floorheating: 'FLOOR_HEATING',
  gas: 'GAS_HEATING',
  oil: 'OIL_HEATING',
  district: 'DISTRICT_HEATING',
  nightstorage: 'NIGHT_STORAGE_HEATER',
  stove: 'STOVE_HEATING',
  woodpellet: 'WOOD_PELLET_HEATING',
  heatpump: 'HEAT_PUMP',
  solar: 'SOLAR_HEATING',
};

const HEATING_TYPE_MOBILE_VALUE = Object.fromEntries(
  Object.entries(HEATING_TYPE_MAP).map(([mobile, canonical]) => [canonical, mobile])
);

const HEATING_LABELS = {
  CENTRAL_HEATING: 'central heating',
  SELF_CONTAINED_CENTRAL_HEATING: 'self-contained central heating',
  FLOOR_HEATING: 'floor heating',
  GAS_HEATING: 'gas heating',
  OIL_HEATING: 'oil heating',
  DISTRICT_HEATING: 'district heating',
  NIGHT_STORAGE_HEATER: 'night storage heating',
  STOVE_HEATING: 'stove heating',
  WOOD_PELLET_HEATING: 'wood pellet heating',
  HEAT_PUMP: 'heat pump',
  SOLAR_HEATING: 'solar heating',
};

const EQUIPMENT_MAP = {
  handicappedaccessible: 'HANDICAPPED_ACCESSIBLE',
  barrierfree: 'HANDICAPPED_ACCESSIBLE',
  balcony: 'BALCONY',
  garden: 'GARDEN',
  builtinKitchen: 'BUILT_IN_KITCHEN',
  'built-in-kitchen': 'BUILT_IN_KITCHEN',
  kitchen: 'BUILT_IN_KITCHEN',
  elevator: 'LIFT',
  lift: 'LIFT',
  parking: 'PARKING_SPACE',
  guesttoilet: 'GUEST_TOILET',
  'guest-toilet': 'GUEST_TOILET',
  cellar: 'CELLAR',
  fridge: 'FRIDGE',
  cooker: 'COOKER',
  petsallowed: 'PETS_ALLOWED',
  internet: 'INTERNET',
};

const EQUIPMENT_MOBILE_VALUE = Object.fromEntries(
  Object.entries(EQUIPMENT_MAP).map(([mobile, canonical]) => [canonical, mobile])
);
EQUIPMENT_MOBILE_VALUE.HANDICAPPED_ACCESSIBLE = 'handicappedaccessible';
EQUIPMENT_MOBILE_VALUE.BUILT_IN_KITCHEN = 'builtinKitchen';
EQUIPMENT_MOBILE_VALUE.GUEST_TOILET = 'guesttoilet';
EQUIPMENT_MOBILE_VALUE.PARKING_SPACE = 'parking';
EQUIPMENT_MOBILE_VALUE.LIFT = 'elevator';
EQUIPMENT_MOBILE_VALUE.FRIDGE = 'fridge';
EQUIPMENT_MOBILE_VALUE.COOKER = 'cooker';
EQUIPMENT_MOBILE_VALUE.PETS_ALLOWED = 'petsallowed';
EQUIPMENT_MOBILE_VALUE.INTERNET = 'internet';

const EQUIPMENT_LABELS = {
  HANDICAPPED_ACCESSIBLE: 'barrier-free',
  BALCONY: 'balcony',
  GARDEN: 'garden',
  BUILT_IN_KITCHEN: 'built-in kitchen',
  LIFT: 'elevator',
  PARKING_SPACE: 'parking',
  GUEST_TOILET: 'guest toilet',
  CELLAR: 'cellar',
  FRIDGE: 'fridge',
  COOKER: 'cooker',
  PETS_ALLOWED: 'pets allowed',
  INTERNET: 'internet',
};

const MOBILE_UNSUPPORTED_WEB_FILTER_LABELS = {
  gender: 'flatmate gender',
  smokingallowed: 'smoking allowed',
  startrentaldate: 'rental start date',
  furniture: 'furnished',
  rentalduration: 'rental duration',
};

function parseWgSlug(segment) {
  const match = String(segment || '').match(/^(\d+)er-wg$/i);
  if (!match) return null;
  return { size: Number(match[1]), fullText: `${match[1]}er wg`, label: `${match[1]}er WG` };
}

const SEO_PRICE_PATTERNS = [
  /wohnung-bis-(\d+)-euro-warm/,
  /wohnung-bis-(\d+)-euro-kalt/,
  /haus-bis-(\d+)-euro/,
];

function emptyResult(error) {
  return {
    canonical: null,
    unsupportedParams: [],
    safeIgnoredParams: [],
    error,
  };
}

function normalizeUrl(webUrl) {
  const input = String(webUrl || '').trim();
  if (!input) throw new Error('Invalid URL');
  return /^https?:\/\//i.test(input) ? input : `https://${input}`;
}

function parseRange(raw, label) {
  const value = String(raw ?? '').trim();
  const m = value.match(/^(\d+(?:\.\d+)?)?-(\d+(?:\.\d+)?)?$/);
  if (!m) {
    const single = value.match(/^\d+(?:\.\d+)?$/);
    if (single) return { min: Number(value), max: Number(value) };
    throw new Error(`Invalid ${label} range: ${value}`);
  }
  const min = m[1] ? Number(m[1]) : null;
  const max = m[2] ? Number(m[2]) : null;
  if (min === null && max === null) throw new Error(`Invalid ${label} range: ${value}`);
  if (min !== null && max !== null && min > max) throw new Error(`Invalid ${label} range: ${value}`);
  return { min, max };
}

function formatRange(range) {
  if (!range) return null;
  if (range.min === null && range.max === null) return null;
  const min = range.min ?? '';
  const max = range.max ?? '';
  if (range.min !== null && range.max !== null && range.min === range.max) return String(range.min);
  return `${min}-${max}`;
}

function splitValues(value) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function mapMultiValues(rawValue, mapping, key, unsupportedParams) {
  const mapped = [];
  for (const value of splitValues(rawValue)) {
    const normalized = value.toLowerCase();
    if (mapping[normalized]) mapped.push(mapping[normalized]);
    else unsupportedParams.push({ key, value, risk: 'dangerous' });
  }
  return mapped;
}

function titleizeSlug(slug) {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isSafeIgnoredParam(key) {
  return SAFE_IGNORED_PARAM_PATTERNS.some(rx => rx.test(key));
}

/**
 * Parse an IS24 web search URL into Homelander's canonical search model.
 * @param {string} webUrl
 * @returns {{canonical: object|null, unsupportedParams: Array, safeIgnoredParams: Array, error: string|null}}
 */
export function parseSearchUrl(webUrl) {
  try {
    const url = new URL(normalizeUrl(webUrl));
    const pathParts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const sucheIdx = pathParts.findIndex(p => p.toLowerCase() === 'suche');
    if (sucheIdx === -1) return emptyResult('URL does not contain /Suche/ path');
    if (!/immobilienscout24\.de$/i.test(url.hostname) && !/\.immobilienscout24\.de$/i.test(url.hostname)) {
      return emptyResult('URL is not an immobilienscout24.de search link');
    }

    const afterSuche = pathParts.slice(sucheIdx + 1);
    const realEstatePathType = afterSuche.find(p => REALESTATE_TYPE_MAP[p]);
    const wgPathSegment = afterSuche.find(p => parseWgSlug(p));
    const wgSearch = parseWgSlug(wgPathSegment);
    const typeIdx = realEstatePathType
      ? afterSuche.indexOf(realEstatePathType)
      : wgPathSegment
        ? afterSuche.indexOf(wgPathSegment)
        : -1;
    const geocodeParts = typeIdx >= 0 ? afterSuche.slice(0, typeIdx) : afterSuche.filter(p => !REALESTATE_TYPE_MAP[p]);
    const searchType = geocodeParts[0] === 'radius' ? 'radius' : geocodeParts[0] === 'shape' ? 'shape' : 'region';

    const canonical = {
      originalUrl: url.toString(),
      realEstateType: REALESTATE_TYPE_MAP[realEstatePathType] || 'apartmentrent',
      realEstatePathType: realEstatePathType || wgPathSegment || null,
      searchType,
      location: {
        path: geocodeParts,
        geocode: geocodeParts.length ? `/${geocodeParts.join('/')}` : '',
        label: geocodeParts.length ? geocodeParts.filter(p => p !== 'de').map(titleizeSlug).join(' / ') : 'All Germany',
      },
      construction: { newBuildingOnly: NEW_BUILD_TYPES.has(realEstatePathType) },
      price: { min: null, max: null, type: PRICE_TYPE_MAP[realEstatePathType] || 'calculatedtotalrent' },
      rooms: { min: null, max: null },
      livingSpace: { min: null, max: null },
      heatingTypes: [],
      equipment: [],
      fullText: wgSearch?.fullText || null,
      flatShare: wgSearch || null,
      directParams: [],
      excludeSwapFlat: !String(webUrl).includes('tausch'),
    };

    const unsupportedParams = [];
    const safeIgnoredParams = [];
    const seenKnownKeys = new Set();

    for (const [rawKey, value] of url.searchParams) {
      const key = rawKey.toLowerCase();
      if (key === 'price') {
        canonical.price = { ...parseRange(value, 'price'), type: canonical.price.type };
        seenKnownKeys.add(key);
      } else if (key === 'numberofrooms') {
        canonical.rooms = parseRange(value, 'number of rooms');
        seenKnownKeys.add(key);
      } else if (key === 'livingspace') {
        canonical.livingSpace = parseRange(value, 'living space');
        seenKnownKeys.add(key);
      } else if (key === 'pricetype') {
        canonical.price.type = value;
        seenKnownKeys.add(key);
      } else if (key === 'heatingtypes') {
        canonical.heatingTypes.push(...mapMultiValues(value, HEATING_TYPE_MAP, rawKey, unsupportedParams));
        seenKnownKeys.add(key);
      } else if (key === 'equipment') {
        canonical.equipment.push(...mapMultiValues(value, EQUIPMENT_MAP, rawKey, unsupportedParams));
        seenKnownKeys.add(key);
      } else if (DIRECT_PARAM_MAP[key]) {
        canonical.directParams.push({ key: DIRECT_PARAM_MAP[key], value });
        seenKnownKeys.add(key);
      } else if (MOBILE_UNSUPPORTED_WEB_FILTER_LABELS[key]) {
        safeIgnoredParams.push({
          key: rawKey,
          value,
          reason: `The IS24 mobile API rejects ${MOBILE_UNSUPPORTED_WEB_FILTER_LABELS[key]} filters; Homelander keeps the supported parts of the search.`,
        });
        seenKnownKeys.add(key);
      } else if (key === 'built-in-kitchen' || key === 'guest-toilet') {
        // Legacy IS24/Fredy-style flags: keep the historical mobile param shape
        // while also surfacing a human-readable equipment preview.
        canonical.directParams.push({ key: 'equipment', value });
        const mapped = EQUIPMENT_MAP[key];
        if (mapped) canonical.equipment.push(mapped);
        seenKnownKeys.add(key);
      } else if (isSafeIgnoredParam(rawKey)) {
        safeIgnoredParams.push({ key: rawKey, value });
      } else {
        unsupportedParams.push({ key: rawKey, value, risk: 'dangerous' });
      }
    }

    // SEO-encoded price e.g. wohnung-bis-1000-euro-warm.
    const lastPathSegment = afterSuche[afterSuche.length - 1] || '';
    for (const pattern of SEO_PRICE_PATTERNS) {
      const match = lastPathSegment.match(pattern);
      if (match && !seenKnownKeys.has('price')) {
        canonical.price.max = Number(match[1]);
        if (lastPathSegment.includes('warm')) canonical.price.type = 'calculatedtotalrent';
        break;
      }
    }

    canonical.heatingTypes = [...new Set(canonical.heatingTypes)];
    canonical.equipment = [...new Set(canonical.equipment)];

    return { canonical, unsupportedParams, safeIgnoredParams, error: null };
  } catch (err) {
    return emptyResult(err.message);
  }
}

/** Build a mobile API list URL from a canonical search model. */
export function buildMobileApiUrl(canonical, { page = 1, pageSize = 20, includeListControls = true } = {}) {
  const params = new URLSearchParams();
  if (canonical.location?.geocode) params.set('geocodes', canonical.location.geocode);
  params.set('searchType', canonical.searchType || 'region');
  params.set('realestatetype', canonical.realEstateType || 'apartmentrent');
  if (canonical.price?.type) params.set('pricetype', canonical.price.type);

  const price = formatRange(canonical.price);
  const rooms = formatRange(canonical.rooms);
  const livingSpace = formatRange(canonical.livingSpace);
  if (price) params.set('price', price);
  if (rooms) params.set('numberofrooms', rooms);
  if (livingSpace) params.set('livingspace', livingSpace);
  if (canonical.construction?.newBuildingOnly) params.set('newbuilding', 'true');
  if (canonical.fullText) params.set('fulltext', canonical.fullText);
  if (canonical.heatingTypes?.length) {
    params.set('heatingtypes', canonical.heatingTypes.map(v => HEATING_TYPE_MOBILE_VALUE[v] || v).join(','));
  }
  if (canonical.equipment?.length) {
    params.set('equipment', canonical.equipment.map(v => EQUIPMENT_MOBILE_VALUE[v] || v).join(','));
  }
  for (const { key, value } of canonical.directParams || []) params.append(key, value);
  if (canonical.excludeSwapFlat) params.append('exclusioncriteria', 'swapFlat');
  if (includeListControls) {
    params.set('sorting', '-firstactivation');
    params.set('pagenumber', String(page));
    params.set('pagesize', String(pageSize));
  }
  return `${MOBILE_API_BASE}?${params.toString()}`;
}

function formatRangePreview(range, unit = '') {
  const suffix = unit ? ` ${unit}` : '';
  if (!range || (range.min === null && range.max === null)) return null;
  if (range.min !== null && range.max !== null) return `${range.min}–${range.max}${suffix}`;
  if (range.min !== null) return `≥ ${range.min}${suffix}`;
  return `≤ ${range.max}${suffix}`;
}

function formatDirectParamPreview({ key, value }, i18n) {
  if (key === 'energyefficiencyclasses') {
    const label = value.split(',').map(v => v.replace('a_plus', 'A+').toUpperCase()).join(', ');
    return `${i18n.labels.energy}: ${label}`;
  }
  if (key === 'petsallowedtypes') {
    const values = value.split(',').map(v => v.trim()).filter(Boolean);
    const allPetValues = ['no', 'yes', 'negotiable'];
    if (allPetValues.every(v => values.includes(v))) return `${i18n.labels.pets}: ${i18n.labels.any}`;
    return `${i18n.labels.pets}: ${values.join(', ')}`;
  }
  return `${key}: ${value}`;
}

function previewFor(canonical, locale = 'en') {
  const i18n = previewLocale(locale);
  const filters = [];
  let type = i18n.realEstate[canonical.realEstateType] || canonical.realEstateType;
  if (canonical.construction?.newBuildingOnly) {
    type = String(locale).toLowerCase().startsWith('de')
      ? `${i18n.labels.newBuildPrefix}: ${type}`
      : `${i18n.labels.newBuildPrefix} ${type.charAt(0).toLowerCase()}${type.slice(1)}`;
  }
  if (canonical.flatShare?.label) type = canonical.flatShare.label;
  filters.push(type);

  const price = formatRangePreview(canonical.price);
  const rooms = formatRangePreview(canonical.rooms);
  const livingSpace = formatRangePreview(canonical.livingSpace, 'm²');
  if (price) filters.push(`${i18n.labels.price} ${price}`);
  if (rooms) filters.push(`${i18n.labels.rooms} ${rooms}`);
  if (livingSpace) filters.push(`${i18n.labels.livingSpace} ${livingSpace}`);
  if (canonical.heatingTypes?.length) filters.push(`${i18n.labels.heating}: ${canonical.heatingTypes.map(v => i18n.heating[v] || v).join(', ')}`);
  if (canonical.equipment?.length) {
    const labels = canonical.equipment.map(v => i18n.equipment[v] || v);
    filters.push(labels.length > 3 ? `${i18n.labels.equipment}: ${labels.length} ${i18n.labels.selected}` : `${i18n.labels.equipment}: ${labels.join(', ')}`);
  }
  for (const directParam of canonical.directParams || []) filters.push(formatDirectParamPreview(directParam, i18n));
  const locationLabel = canonical.location?.label === PREVIEW_I18N.en.labels.allGermany
    ? i18n.labels.allGermany
    : (canonical.location?.label || i18n.labels.allGermany);
  return { location: locationLabel, filters };
}

/** Validate a pasted search URL for user-facing import. Blocks dangerous unknown filters. */
export function validateSearchUrl(webUrl, options = {}) {
  const locale = typeof options === 'string' ? options : (options.locale || 'en');
  const i18n = previewLocale(locale);
  const parsed = parseSearchUrl(webUrl);
  if (parsed.error) {
    return { ok: false, error: parsed.error, ...parsed, preview: { location: '', filters: [] }, mobileUrl: '' };
  }
  const preview = previewFor(parsed.canonical, locale);
  const dangerous = parsed.unsupportedParams.filter(p => p.risk === 'dangerous');
  const error = dangerous.length
    ? `${i18n.labels.unsupportedFilters}: ${dangerous.map(p => `${p.key}=${p.value}`).join(', ')}`
    : null;
  const localizeIgnored = (p) => {
    if (!p.mobileRejected) return p;
    return { ...p, reason: i18n.labels.mobileRejects(p.label || p.key) };
  };
  return {
    ok: !error,
    error,
    canonical: parsed.canonical,
    preview,
    unsupportedParams: parsed.unsupportedParams,
    safeIgnoredParams: parsed.safeIgnoredParams.map(localizeIgnored),
    mobileUrl: buildMobileApiUrl(parsed.canonical),
  };
}

/**
 * Parse an IS24 web search URL and return mobile API query parameters.
 * Kept compatible with existing callers; use validateSearchUrl() for import gates.
 */
export function translateUrl(webUrl) {
  const parsed = parseSearchUrl(webUrl);
  if (parsed.error) return { fullUrl: '', error: parsed.error, parsed };
  return { fullUrl: buildMobileApiUrl(parsed.canonical), error: null, parsed };
}

/** Fetch total result count for a search URL (used by "Test" button). */
export async function getTotalResults(webUrl, options = {}) {
  const validation = validateSearchUrl(webUrl, options);
  if (!validation.ok) return { total: 0, error: validation.error, validation };

  const totalUrl = buildMobileApiUrl(validation.canonical, { includeListControls: false })
    .replace('/search/list?', '/search/total?');

  try {
    const resp = await fetch(totalUrl, {
      headers: {
        'User-Agent': 'ImmoScout_27.12_26.2_._',
        'Accept': 'application/json',
      },
    });
    if (!resp.ok) return { total: 0, error: `HTTP ${resp.status}`, validation };
    const data = await resp.json();
    return { total: data.totalResults || data.numberOfHits || data.total || 0, error: null, validation };
  } catch (err) {
    return { total: 0, error: err.message, validation };
  }
}

/** Fetch listings from the mobile API. */
export async function fetchListings(webUrl, page = 1) {
  const validation = validateSearchUrl(webUrl);
  if (!validation.ok) return { listings: [], error: validation.error, validation };
  const fetchUrl = buildMobileApiUrl(validation.canonical, { page });

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

    if (!resp.ok) return { listings: [], error: `HTTP ${resp.status}`, validation };

    const data = await resp.json();
    const items = data.resultListItems || [];
    const listings = items.map((item) => {
      const expose = item.item || item;
      const attrs = {};
      if (Array.isArray(expose.attributes)) {
        for (const attr of expose.attributes) {
          if (attr.attribute && attr.value) attrs[attr.attribute] = attr.value;
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

    return { listings, error: null, validation };
  } catch (err) {
    return { listings: [], error: err.message, validation };
  }
}
