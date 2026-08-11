// Multi-source listing scanner for Homelander's analysis-only ("scan") mode.
//
// Every source implements the same contract:
//   detect(url)            — does this source handle the pasted URL?
//   validate(url, locale)  — { ok, error, source, mode, preview, mobileUrl }
//   fetchListings(url, page) — { listings, error }
//   getTotal(url)          — { total, error }
//
// Listing objects are normalised to the shape engine/db.js stores:
//   { expose_id, title, price, size, rooms, address, postcode,
//     image_url, url, source }
//
// Non-IS24 expose_ids are prefixed (ka-…, nbk-…) so they can never collide
// with IS24 exposé IDs — and so the apply loop's IS24 contactor can never
// be pointed at them by accident (scan filters are excluded anyway).

import {
  validateSearchUrl,
  fetchListings as fetchIs24Listings,
  getTotalResults as getIs24Total,
  isBuyRealEstateType,
  parseGermanNumber,
} from './url-translator.js';

export const SOURCE_IS24 = 'is24';
export const SOURCE_KLEINANZEIGEN = 'kleinanzeigen';
export const SOURCE_NEUBAUKOMPASS = 'neubaukompass';

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.6',
};

const IS24_APP_HEADERS = {
  'User-Agent': 'ImmoScout_27.12_26.2_._',
  'Accept': 'application/json',
};

function normalizeHost(webUrl) {
  try {
    const input = String(webUrl || '').trim();
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    return { host: url.hostname.toLowerCase(), url };
  } catch {
    return { host: '', url: null };
  }
}

/** Which source handles this URL? Returns SOURCE_* or null. */
export function detectSource(webUrl) {
  const { host } = normalizeHost(webUrl);
  if (!host) return null;
  if (host === 'immobilienscout24.de' || host.endsWith('.immobilienscout24.de')) return SOURCE_IS24;
  if (host === 'kleinanzeigen.de' || host.endsWith('.kleinanzeigen.de')) return SOURCE_KLEINANZEIGEN;
  if (host === 'neubaukompass.de' || host.endsWith('.neubaukompass.de')) return SOURCE_NEUBAUKOMPASS;
  return null;
}

/** Minimal HTML entity decoding for scraped text. */
export function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Kleinanzeigen ──────────────────────────────────────────────

function kleinanzeigenPageUrl(webUrl, page) {
  const { url } = normalizeHost(webUrl);
  if (!url || page <= 1) return url ? url.toString() : String(webUrl);
  // Pagination format: /s-wohnung-kaufen/berlin/seite:2/c196l3331 —
  // the seite:N segment sits directly before the trailing category code.
  const parts = url.pathname.split('/').filter(Boolean).filter(p => !/^seite:\d+$/.test(p));
  parts.splice(Math.max(parts.length - 1, 0), 0, `seite:${page}`);
  url.pathname = `/${parts.join('/')}`;
  return url.toString();
}

/** Parse a Kleinanzeigen search-results HTML page into listings. */
export function parseKleinanzeigenHtml(html) {
  const listings = [];
  const articleRe = /<article class="aditem"[\s\S]*?<\/article>/g;
  for (const match of String(html || '').match(articleRe) || []) {
    const adid = match.match(/data-adid="(\d+)"/)?.[1];
    if (!adid) continue;
    const href = match.match(/data-href="([^"]+)"/)?.[1] || '';
    const title = decodeEntities(match.match(/<h2[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/)?.[1] || '');
    const priceText = decodeEntities(match.match(/aditem-main--middle--price-shipping--price"\s*>\s*([^<]+)/)?.[1] || '');
    const tags = decodeEntities(match.match(/aditem-main--middle--tags"\s*>\s*([\s\S]*?)<\/p>/)?.[1] || '');
    const address = decodeEntities(match.match(/icon-pin[^"]*"[^>]*><\/i>\s*([^<]+)/)?.[1] || '');
    const image = match.match(/<img[^>]+src="([^"]+)"/)?.[1] || '';
    const sizeMatch = tags.match(/([\d.,]+)\s*m²/);
    const roomsMatch = tags.match(/([\d.,]+)\s*Zi/);
    listings.push({
      expose_id: `ka-${adid}`,
      title,
      price: parseGermanNumber(priceText),
      size: sizeMatch ? parseGermanNumber(sizeMatch[1]) : 0,
      rooms: roomsMatch ? parseGermanNumber(roomsMatch[1]) : 0,
      address,
      postcode: address.match(/\b(\d{5})\b/)?.[1] || '',
      image_url: image,
      url: href ? `https://www.kleinanzeigen.de${href}` : '',
      source: SOURCE_KLEINANZEIGEN,
    });
  }
  return listings;
}

async function fetchKleinanzeigenListings(webUrl, page = 1) {
  try {
    const resp = await fetch(kleinanzeigenPageUrl(webUrl, page), { headers: BROWSER_HEADERS });
    if (!resp.ok) return { listings: [], error: `HTTP ${resp.status} (kleinanzeigen.de)` };
    const html = await resp.text();
    return { listings: parseKleinanzeigenHtml(html), error: null };
  } catch (err) {
    return { listings: [], error: err.message };
  }
}

async function getKleinanzeigenTotal(webUrl) {
  try {
    const resp = await fetch(kleinanzeigenPageUrl(webUrl, 1), { headers: BROWSER_HEADERS });
    if (!resp.ok) return { total: 0, error: `HTTP ${resp.status} (kleinanzeigen.de)` };
    const html = await resp.text();
    // "1 - 25 von 5.930 Eigentumswohnung kaufen in Berlin"
    const summary = html.match(/breadcrump-summary"[^>]*>[^<]*von\s+([\d.]+)/);
    if (summary) return { total: parseGermanNumber(summary[1]), error: null };
    return { total: parseKleinanzeigenHtml(html).length, error: null };
  } catch (err) {
    return { total: 0, error: err.message };
  }
}

// ── Neubaukompass ──────────────────────────────────────────────
// New-build project portal. No official API — parsed from the search page's
// JSON-LD blocks and project-card links. Neubaukompass sits behind bot
// protection that blocks datacenter IPs; from a normal residential
// connection the pages load fine. Errors are surfaced per poll, never fatal.

function neubaukompassPageUrl(webUrl, page) {
  const { url } = normalizeHost(webUrl);
  if (!url) return String(webUrl);
  if (page > 1) url.searchParams.set('Page', String(page));
  return url.toString();
}

function slugId(href) {
  const slug = String(href || '').split('?')[0].split('/').filter(Boolean).pop() || '';
  return slug.slice(0, 80);
}

/** Parse a Neubaukompass search page into project listings (best effort). */
export function parseNeubaukompassHtml(html) {
  const listings = [];
  const seen = new Set();
  const text = String(html || '');

  // Preferred: JSON-LD structured data (schema.org ItemList / Residence)
  const ldRe = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let ld;
  while ((ld = ldRe.exec(text)) !== null) {
    try {
      const data = JSON.parse(ld[1]);
      const nodes = [];
      const collect = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(collect);
        if (node.itemListElement) collect(node.itemListElement);
        if (node.item) collect(node.item);
        const type = String(node['@type'] || '');
        if (/Residence|Apartment|House|Product|RealEstateListing/i.test(type) && (node.url || node.name)) {
          nodes.push(node);
        }
        if (node['@graph']) collect(node['@graph']);
      };
      collect(data);
      for (const node of nodes) {
        const url = String(node.url || '');
        const id = `nbk-${slugId(url) || listings.length}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const addr = node.address;
        const addressText = typeof addr === 'string'
          ? addr
          : addr ? [addr.streetAddress, addr.postalCode, addr.addressLocality].filter(Boolean).join(', ') : '';
        listings.push({
          expose_id: id,
          title: decodeEntities(node.name || ''),
          price: parseGermanNumber(node.offers?.lowPrice || node.offers?.price || ''),
          size: 0,
          rooms: 0,
          address: decodeEntities(addressText),
          postcode: String(addressText).match(/\b(\d{5})\b/)?.[1] || '',
          image_url: typeof node.image === 'string' ? node.image : (Array.isArray(node.image) ? node.image[0] : ''),
          url: url.startsWith('http') ? url : `https://www.neubaukompass.de${url}`,
          source: SOURCE_NEUBAUKOMPASS,
        });
      }
    } catch { /* malformed JSON-LD block — skip */ }
  }
  if (listings.length > 0) return listings;

  // Fallback: project links (/neubau/<project-slug>/) with nearby title text
  const linkRe = /<a[^>]+href="(\/(?:neubau|nbprojekt)\/[^"#?]+)"[^>]*>([\s\S]{0,400}?)<\/a>/g;
  let link;
  while ((link = linkRe.exec(text)) !== null) {
    const id = `nbk-${slugId(link[1])}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const inner = decodeEntities(link[2].replace(/<[^>]+>/g, ' '));
    if (!inner || inner.length < 5) continue;
    listings.push({
      expose_id: id,
      title: inner.slice(0, 200),
      price: 0,
      size: 0,
      rooms: 0,
      address: '',
      postcode: '',
      image_url: '',
      url: `https://www.neubaukompass.de${link[1]}`,
      source: SOURCE_NEUBAUKOMPASS,
    });
  }
  return listings;
}

async function fetchNeubaukompassListings(webUrl, page = 1) {
  try {
    const resp = await fetch(neubaukompassPageUrl(webUrl, page), { headers: BROWSER_HEADERS });
    if (resp.status === 403) {
      return { listings: [], error: 'HTTP 403 (neubaukompass.de) — Bot-Schutz aktiv, Abruf später erneut versucht' };
    }
    if (!resp.ok) return { listings: [], error: `HTTP ${resp.status} (neubaukompass.de)` };
    const html = await resp.text();
    return { listings: parseNeubaukompassHtml(html), error: null };
  } catch (err) {
    return { listings: [], error: err.message };
  }
}

async function getNeubaukompassTotal(webUrl) {
  const { listings, error } = await fetchNeubaukompassListings(webUrl, 1);
  return { total: listings.length, error };
}

// ── Unified interface ──────────────────────────────────────────

function simplePreview(source, webUrl, filters) {
  const { url } = normalizeHost(webUrl);
  return { location: url ? decodeURIComponent(url.pathname) : '', filters };
}

/**
 * Validate any supported search URL.
 * Returns { ok, error, source, mode, preview, mobileUrl, … } — `mode` is
 * 'scan' for buy searches and all non-IS24 sources, 'apply' otherwise.
 */
export function validateAnySearchUrl(webUrl, options = {}) {
  const source = detectSource(webUrl);
  if (source === SOURCE_IS24 || source === null) {
    // Unknown hosts flow into the IS24 validator so its existing
    // "not an immobilienscout24.de link" error copy is preserved.
    const validation = validateSearchUrl(webUrl, options);
    const mode = validation.ok && isBuyRealEstateType(validation.canonical?.realEstateType) ? 'scan' : 'apply';
    return { ...validation, source: SOURCE_IS24, mode };
  }
  if (source === SOURCE_KLEINANZEIGEN) {
    const { url } = normalizeHost(webUrl);
    const ok = !!url && /^\/s-/.test(url.pathname);
    return {
      ok,
      error: ok ? null : 'Kleinanzeigen: Bitte eine Such-URL einfügen (Pfad beginnt mit /s-…)',
      source,
      mode: 'scan',
      preview: simplePreview(source, webUrl, ['Kleinanzeigen']),
      mobileUrl: '',
      unsupportedParams: [],
      safeIgnoredParams: [],
    };
  }
  // Neubaukompass
  {
    const { url } = normalizeHost(webUrl);
    const ok = !!url && /neubau/i.test(url.pathname);
    return {
      ok,
      error: ok ? null : 'Neubaukompass: Bitte eine Projektsuche-URL einfügen (z.B. /neubau-immobilien/berlin/)',
      source,
      mode: 'scan',
      preview: simplePreview(source, webUrl, ['Neubaukompass']),
      mobileUrl: '',
      unsupportedParams: [],
      safeIgnoredParams: [],
    };
  }
}

/** Fetch one page of listings from whichever source handles the URL. */
export async function fetchAnyListings(webUrl, page = 1) {
  const source = detectSource(webUrl);
  if (source === SOURCE_KLEINANZEIGEN) return fetchKleinanzeigenListings(webUrl, page);
  if (source === SOURCE_NEUBAUKOMPASS) return fetchNeubaukompassListings(webUrl, page);
  return fetchIs24Listings(webUrl, page);
}

/** Total result count for the Add-Search "Test" button. */
export async function getAnyTotalResults(webUrl, options = {}) {
  const source = detectSource(webUrl);
  if (source === SOURCE_KLEINANZEIGEN) {
    const validation = validateAnySearchUrl(webUrl, options);
    if (!validation.ok) return { total: 0, error: validation.error, validation };
    return { ...(await getKleinanzeigenTotal(webUrl)), validation };
  }
  if (source === SOURCE_NEUBAUKOMPASS) {
    const validation = validateAnySearchUrl(webUrl, options);
    if (!validation.ok) return { total: 0, error: validation.error, validation };
    return { ...(await getNeubaukompassTotal(webUrl)), validation };
  }
  return getIs24Total(webUrl, options);
}

// ── IS24 exposé enrichment (details + coordinates for the map) ─

function centroidOfShapes(zipCodeShapes) {
  let latSum = 0, lngSum = 0, count = 0;
  for (const shape of zipCodeShapes || []) {
    for (const point of shape?.outline || []) {
      if (typeof point?.lat === 'number' && typeof point?.lng === 'number') {
        latSum += point.lat;
        lngSum += point.lng;
        count++;
      }
    }
  }
  if (!count) return null;
  return { lat: latSum / count, lng: lngSum / count };
}

/**
 * Fetch exposé details from the IS24 mobile API for a scanned listing.
 * Returns { lat, lng, details, error } — coordinates from the exact
 * location when published, otherwise the postcode-area centroid.
 */
export async function fetchIs24ExposeDetails(exposeId) {
  try {
    const resp = await fetch(`https://api.mobile.immobilienscout24.de/expose/${exposeId}`, {
      headers: IS24_APP_HEADERS,
    });
    if (!resp.ok) return { lat: null, lng: null, details: null, error: `HTTP ${resp.status}` };
    const data = await resp.json();
    const sections = Array.isArray(data.sections) ? data.sections : [];

    let lat = null, lng = null;
    let addressLine = '';
    const attributeGroups = [];
    const texts = [];
    const media = [];

    for (const section of sections) {
      if (section?.type === 'MAP') {
        addressLine = [section.addressLine1, section.addressLine2]
          .filter(v => v && !/vollständige Adresse/i.test(v)).join(', ');
        if (typeof section.location?.lat === 'number') {
          lat = section.location.lat;
          lng = section.location.lng ?? section.location.lon ?? null;
        } else {
          const centroid = centroidOfShapes(section.zipCodeShapes);
          if (centroid) ({ lat, lng } = centroid);
        }
      } else if (section?.type === 'TOP_ATTRIBUTES' || section?.type === 'ATTRIBUTE_LIST') {
        const items = (section.attributes || [])
          .map(a => ({ label: String(a.label || '').replace(/:$/, ''), text: a.text ?? (a.type === 'CHECK' ? '✓' : '') }))
          .filter(a => a.label || a.text);
        if (items.length) attributeGroups.push({ title: section.title || '', items });
      } else if (section?.type === 'TEXT_AREA' && section.text) {
        texts.push({ title: section.title || '', text: String(section.text) });
      } else if (section?.type === 'MEDIA') {
        for (const m of section.media || []) {
          const url = m.fullImageUrl || m.previewImageUrl || '';
          if (!url) continue;
          media.push({
            type: String(m.type || 'PICTURE'),
            caption: String(m.caption || ''),
            url,
            floorplan: /floor|plan/i.test(m.type || '') || /grundriss/i.test(m.caption || ''),
          });
        }
      }
    }

    return {
      lat,
      lng,
      details: { address: addressLine, attributeGroups, texts, media },
      error: null,
    };
  } catch (err) {
    return { lat: null, lng: null, details: null, error: err.message };
  }
}

// ── Postcode geocoding (Nominatim, cached in SQLite) ───────────

let lastNominatimAt = 0;

/**
 * Resolve a German postcode to coordinates via Nominatim, respecting the
 * 1 req/s usage policy. `db` is a HomelanderDB used as a persistent cache.
 */
export async function geocodePostcode(postcode, db) {
  const code = String(postcode || '').match(/\d{5}/)?.[0];
  if (!code) return null;
  try {
    const cached = db?.getGeoCache?.(code);
    if (cached) return (cached.lat != null) ? { lat: cached.lat, lng: cached.lng } : null;
  } catch { /* cache miss path below */ }

  // Nominatim usage policy: max 1 request/second
  const wait = 1100 - (Date.now() - lastNominatimAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastNominatimAt = Date.now();

  try {
    const url = `https://nominatim.openstreetmap.org/search?postalcode=${code}&countrycodes=de&format=jsonv2&limit=1`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Homelander/1.x (https://github.com/B1Z0N/homelander)' },
    });
    if (!resp.ok) return null;
    const results = await resp.json();
    const hit = Array.isArray(results) ? results[0] : null;
    const lat = hit ? parseFloat(hit.lat) : null;
    const lng = hit ? parseFloat(hit.lon) : null;
    if (lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
      try { db?.setGeoCache?.(code, lat, lng); } catch { /* non-fatal */ }
      return { lat, lng };
    }
    // Negative result cached too — avoids re-hitting Nominatim every poll
    try { db?.setGeoCache?.(code, null, null); } catch { /* non-fatal */ }
    return null;
  } catch {
    return null;
  }
}
