// Kaufradar single-page UI — served by engine/scan-server.js.
// Self-contained HTML string: inline CSS/JS, Leaflet + OSM tiles from CDN
// (the page opens in the user's normal browser, which is online anyway).

export function renderScanPage() {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Homelander Kaufradar</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  :root {
    --gold: #D9A441; --gold-dark: #B8860B;
    --bg: #0f0f11; --bg-card: #1a1a1e; --bg-elevated: #232329;
    --border: #2e2e36; --text: #ededef; --text-dim: #9d9da5; --text-muted: #6b6b74;
    --green: #34d399; --red: #f87171;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--text); font: 14px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { display:flex; align-items:center; gap:16px; flex-wrap:wrap; padding:14px 20px; border-bottom:1px solid var(--border); position:sticky; top:0; background:var(--bg); z-index:1100; }
  header h1 { font-size:17px; color:var(--gold); white-space:nowrap; }
  header .count { color:var(--text-dim); font-size:13px; }
  .controls { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .controls input, .controls select {
    background:var(--bg-card); color:var(--text); border:1px solid var(--border);
    border-radius:8px; padding:6px 10px; font-size:13px; outline:none;
  }
  .controls input:focus, .controls select:focus { border-color:var(--gold); }
  .controls input[type=number] { width:96px; }
  #layout { display:grid; grid-template-columns: minmax(360px, 46%) 1fr; height: calc(100vh - 63px); }
  #list { overflow-y:auto; padding:14px; display:flex; flex-direction:column; gap:10px; }
  #map { height:100%; }
  .card { display:flex; gap:12px; background:var(--bg-card); border:1px solid var(--border); border-radius:12px; padding:10px; cursor:pointer; transition:border-color .15s; }
  .card:hover, .card.active { border-color:var(--gold); }
  .card img { width:120px; height:90px; object-fit:cover; border-radius:8px; background:var(--bg-elevated); flex-shrink:0; }
  .card .noimg { width:120px; height:90px; border-radius:8px; background:var(--bg-elevated); display:flex; align-items:center; justify-content:center; color:var(--text-muted); font-size:22px; flex-shrink:0; }
  .card h3 { font-size:13.5px; font-weight:600; margin-bottom:2px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .card .addr { color:var(--text-dim); font-size:12px; }
  .card .meta { margin-top:6px; display:flex; gap:10px; flex-wrap:wrap; font-size:12.5px; color:var(--text-dim); }
  .card .price { color:var(--gold); font-weight:700; font-size:14px; }
  .badge { font-size:10.5px; padding:1px 7px; border-radius:99px; border:1px solid var(--border); color:var(--text-dim); }
  .badge.is24 { color:#7dd3fc; border-color:#7dd3fc44; }
  .badge.kleinanzeigen { color:#86efac; border-color:#86efac44; }
  .badge.neubaukompass { color:#fca5a5; border-color:#fca5a544; }
  .badge.new { color:var(--green); border-color:#34d39944; }
  #empty { color:var(--text-muted); text-align:center; padding:40px 10px; }
  /* Detail modal */
  #overlay { position:fixed; inset:0; background:rgba(0,0,0,.65); display:none; align-items:flex-start; justify-content:center; z-index:2000; overflow-y:auto; padding:5vh 16px; }
  #overlay.open { display:flex; }
  #detail { background:var(--bg-card); border:1px solid var(--border); border-radius:14px; max-width:680px; width:100%; padding:20px; position:relative; }
  #detail .close { position:absolute; top:10px; right:14px; background:none; border:none; color:var(--text-dim); font-size:22px; cursor:pointer; }
  #detail img.hero { width:100%; max-height:320px; object-fit:cover; border-radius:10px; margin:10px 0; }
  #detail h2 { font-size:17px; padding-right:28px; }
  #detail .price-line { color:var(--gold); font-size:16px; font-weight:700; margin:6px 0; }
  #detail table { width:100%; border-collapse:collapse; font-size:13px; margin:6px 0 14px; }
  #detail td { padding:4px 6px; border-bottom:1px solid var(--border); vertical-align:top; }
  #detail td:first-child { color:var(--text-dim); width:45%; }
  #detail h4 { color:var(--gold); font-size:13px; margin:14px 0 4px; }
  #detail .text-block { color:var(--text-dim); font-size:13px; white-space:pre-wrap; margin-bottom:8px; }
  #detail a.out { display:inline-block; margin-top:10px; background:var(--gold); color:#151515; font-weight:600; padding:8px 16px; border-radius:9px; text-decoration:none; }
  .leaflet-container { background:#1a1a1e; }
  .leaflet-popup-content-wrapper, .leaflet-popup-tip { background:var(--bg-elevated); color:var(--text); }
  @media (max-width: 900px) {
    #layout { grid-template-columns: 1fr; grid-template-rows: 45% 55%; }
  }
</style>
</head>
<body>
<header>
  <h1>⌂ Kaufradar</h1>
  <span class="count" id="count">…</span>
  <div class="controls">
    <select id="f-filter"><option value="">Alle Suchen</option></select>
    <input id="f-q" type="search" placeholder="Suche in Titel/Adresse…">
    <input id="f-maxprice" type="number" placeholder="max €" step="10000">
    <input id="f-minrooms" type="number" placeholder="min Zi." step="0.5">
    <input id="f-minsize" type="number" placeholder="min m²" step="5">
    <select id="f-sort">
      <option value="newest">Neueste zuerst</option>
      <option value="price_asc">Preis aufsteigend</option>
      <option value="price_desc">Preis absteigend</option>
      <option value="sqm_asc">€/m² aufsteigend</option>
      <option value="size_desc">Größe absteigend</option>
    </select>
    <select id="f-days">
      <option value="">Gesamter Zeitraum</option>
      <option value="1">Letzte 24 h</option>
      <option value="7">Letzte 7 Tage</option>
      <option value="30">Letzte 30 Tage</option>
    </select>
  </div>
</header>
<div id="layout">
  <div id="list"></div>
  <div id="map"></div>
</div>
<div id="overlay"><div id="detail"></div></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function () {
  'use strict';
  var all = [];
  var markers = {};
  var markerLayer = null;
  var map = null;
  var activeHash = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function euro(v) { return v > 0 ? Math.round(v).toLocaleString('de-DE') + ' €' : '–'; }
  function perSqm(l) { return (l.price > 0 && l.size > 0) ? Math.round(l.price / l.size).toLocaleString('de-DE') + ' €/m²' : ''; }
  function isNew(l) {
    return (Date.now() - new Date(l.discovered_at + (l.discovered_at.endsWith('Z') ? '' : 'Z')).getTime()) < 48 * 3600 * 1000;
  }

  function initMap() {
    map = L.map('map', { zoomControl: true }).setView([51.16, 10.45], 6);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    // Transit lines live in their own pane below the overlay pane (z 400), so
    // they always render under listing/project markers regardless of when the
    // async fetches land.
    map.createPane('transit').style.zIndex = 350;
    markerLayer = L.layerGroup().addTo(map);
    loadTransitLines();
    loadManualProjects();
  }

  function loadTransitLines() {
    fetch('/api/scan/transit').then(function (r) { return r.json(); }).then(function (data) {
      (data.lines || []).forEach(function (line) {
        (line.ways || []).forEach(function (way) {
          L.polyline(way, {
            pane: 'transit', color: line.colour || '#666',
            weight: 3, opacity: 0.6, interactive: false
          }).addTo(map);
        });
      });
    }).catch(function () { /* map just has no lines */ });
  }

  function loadManualProjects() {
    fetch('/api/scan/projects').then(function (r) { return r.json(); }).then(function (data) {
      (data.projects || []).forEach(function (p) {
        if (p.lat == null || p.lng == null) return;
        var m = L.circleMarker([p.lat, p.lng], {
          radius: 9, weight: 2, color: '#3b2f14',
          fillColor: '#D9A441', fillOpacity: 0.95
        }).addTo(map);
        m.bindTooltip(p.name);
        m.bindPopup(
          '<strong>' + esc(p.name) + '</strong> <span style="color:#B8860B">Neubau</span><br>' +
          esc(p.address || '') +
          (p.note ? '<br>' + esc(p.note) : '') +
          (p.url ? '<br><a href="' + esc(p.url) + '" target="_blank" rel="noopener">Projektseite</a>' : '')
        );
      });
    }).catch(function () { /* no pins then */ });
  }

  // Marker fills need to be dark and saturated: the pastel badge colours wash
  // out on the light OSM tiles.
  function sourceColor(source) {
    return source === 'kleinanzeigen' ? '#059669' : source === 'neubaukompass' ? '#dc2626' : '#7c3aed';
  }

  function filtered() {
    var fid = document.getElementById('f-filter').value;
    var q = document.getElementById('f-q').value.trim().toLowerCase();
    var maxPrice = parseFloat(document.getElementById('f-maxprice').value) || 0;
    var minRooms = parseFloat(document.getElementById('f-minrooms').value) || 0;
    var minSize = parseFloat(document.getElementById('f-minsize').value) || 0;
    var days = parseFloat(document.getElementById('f-days').value) || 0;
    var cutoff = days ? Date.now() - days * 24 * 3600 * 1000 : 0;
    var rows = all.filter(function (l) {
      if (fid && l.filter_id !== fid) return false;
      if (q && (String(l.title) + ' ' + String(l.address)).toLowerCase().indexOf(q) === -1) return false;
      if (maxPrice && !(l.price > 0 && l.price <= maxPrice)) return false;
      if (minRooms && !(l.rooms >= minRooms)) return false;
      if (minSize && !(l.size >= minSize)) return false;
      if (cutoff && new Date(l.discovered_at + (l.discovered_at.endsWith('Z') ? '' : 'Z')).getTime() < cutoff) return false;
      return true;
    });
    var sort = document.getElementById('f-sort').value;
    rows.sort(function (a, b) {
      if (sort === 'price_asc') return (a.price || 9e12) - (b.price || 9e12);
      if (sort === 'price_desc') return (b.price || 0) - (a.price || 0);
      if (sort === 'size_desc') return (b.size || 0) - (a.size || 0);
      if (sort === 'sqm_asc') {
        var qa = a.price > 0 && a.size > 0 ? a.price / a.size : 9e12;
        var qb = b.price > 0 && b.size > 0 ? b.price / b.size : 9e12;
        return qa - qb;
      }
      return String(b.discovered_at).localeCompare(String(a.discovered_at));
    });
    return rows;
  }

  function cardHtml(l) {
    var img = l.image_url
      ? '<img loading="lazy" src="' + esc(l.image_url) + '" alt="">'
      : '<div class="noimg">⌂</div>';
    return img +
      '<div style="min-width:0;flex:1">' +
      '<h3>' + esc(l.title || l.expose_id) + '</h3>' +
      '<div class="addr">' + esc(l.address || '') + '</div>' +
      '<div class="meta">' +
      '<span class="price">' + euro(l.price) + '</span>' +
      (l.size > 0 ? '<span>' + l.size + ' m²</span>' : '') +
      (l.rooms > 0 ? '<span>' + l.rooms + ' Zi.</span>' : '') +
      (perSqm(l) ? '<span>' + perSqm(l) + '</span>' : '') +
      '<span class="badge ' + esc(l.source || 'is24') + '">' + esc(l.source || 'is24') + '</span>' +
      (isNew(l) ? '<span class="badge new">neu</span>' : '') +
      '</div></div>';
  }

  function render() {
    var rows = filtered();
    var list = document.getElementById('list');
    list.innerHTML = '';
    document.getElementById('count').textContent =
      rows.length + ' von ' + all.length + ' Angeboten';
    if (!rows.length) {
      list.innerHTML = '<div id="empty">Keine Angebote — Suchen im Homelander-Hauptfenster anlegen und pollen lassen.</div>';
    }
    markerLayer.clearLayers();
    markers = {};
    var bounds = [];
    rows.forEach(function (l) {
      var card = document.createElement('div');
      card.className = 'card' + (l.hash === activeHash ? ' active' : '');
      card.innerHTML = cardHtml(l);
      card.addEventListener('click', function () { openDetail(l); });
      list.appendChild(card);
      if (l.lat != null && l.lng != null) {
        var m = L.circleMarker([l.lat, l.lng], {
          radius: 7, weight: 2, color: '#ffffff',
          fillColor: sourceColor(l.source), fillOpacity: 0.9
        });
        m.bindPopup(
          '<strong>' + esc(l.title || '') + '</strong><br>' + euro(l.price) +
          (l.size > 0 ? ' · ' + l.size + ' m²' : '') +
          '<br><a href="#" data-hash="' + l.hash + '" class="popup-more">Details…</a>'
        );
        m.on('popupopen', function (e) {
          var a = e.popup.getElement().querySelector('.popup-more');
          if (a) a.addEventListener('click', function (ev) { ev.preventDefault(); openDetail(l); });
        });
        markerLayer.addLayer(m);
        markers[l.hash] = m;
        bounds.push([l.lat, l.lng]);
      }
    });
    if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 });
  }

  function detailTables(details) {
    if (!details) return '';
    var html = '';
    (details.attributeGroups || []).forEach(function (group) {
      if (group.title) html += '<h4>' + esc(group.title) + '</h4>';
      html += '<table>' + (group.items || []).map(function (item) {
        return '<tr><td>' + esc(item.label) + '</td><td>' + esc(item.text) + '</td></tr>';
      }).join('') + '</table>';
    });
    (details.texts || []).forEach(function (t) {
      html += '<h4>' + esc(t.title) + '</h4><div class="text-block">' + esc(t.text) + '</div>';
    });
    return html;
  }

  function openDetail(l) {
    activeHash = l.hash;
    var el = document.getElementById('detail');
    el.innerHTML =
      '<button class="close" aria-label="close">×</button>' +
      '<h2>' + esc(l.title || l.expose_id) + '</h2>' +
      '<div class="addr" style="color:var(--text-dim)">' + esc(l.address || '') +
      (l.details && l.details.address ? ' · ' + esc(l.details.address) : '') + '</div>' +
      '<div class="price-line">' + euro(l.price) +
      (l.size > 0 ? ' · ' + l.size + ' m²' : '') +
      (l.rooms > 0 ? ' · ' + l.rooms + ' Zi.' : '') +
      (perSqm(l) ? ' · ' + perSqm(l) : '') + '</div>' +
      (l.image_url ? '<img class="hero" src="' + esc(l.image_url) + '" alt="">' : '') +
      '<div style="color:var(--text-muted);font-size:12px">Quelle: ' + esc(l.source || 'is24') +
      ' · gefunden ' + new Date(l.discovered_at + (String(l.discovered_at).endsWith('Z') ? '' : 'Z')).toLocaleString('de-DE') +
      (l.filter_name ? ' · Suche: ' + esc(l.filter_name) : '') + '</div>' +
      detailTables(l.details) +
      (l.url ? '<a class="out" href="' + esc(l.url) + '" target="_blank" rel="noopener">Zum Original-Inserat ↗</a>' : '');
    el.querySelector('.close').addEventListener('click', closeDetail);
    document.getElementById('overlay').classList.add('open');
    if (l.lat != null && markers[l.hash]) {
      map.setView([l.lat, l.lng], Math.max(map.getZoom(), 13));
      markers[l.hash].openPopup();
    }
  }
  function closeDetail() {
    document.getElementById('overlay').classList.remove('open');
    activeHash = null;
  }
  document.getElementById('overlay').addEventListener('click', function (e) {
    if (e.target === this) closeDetail();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDetail(); });

  function loadFilters() {
    return fetch('/api/scan/filters').then(function (r) { return r.json(); }).then(function (data) {
      var select = document.getElementById('f-filter');
      var current = select.value;
      select.innerHTML = '<option value="">Alle Suchen</option>' +
        (data.filters || []).map(function (f) {
          return '<option value="' + esc(f.id) + '">' + esc(f.name || f.web_url) + '</option>';
        }).join('');
      select.value = current;
    });
  }

  function loadListings() {
    return fetch('/api/scan/listings').then(function (r) { return r.json(); }).then(function (data) {
      all = data.listings || [];
      render();
    });
  }

  ['f-filter', 'f-sort', 'f-days'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', render);
  });
  ['f-q', 'f-maxprice', 'f-minrooms', 'f-minsize'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', render);
  });

  initMap();
  loadFilters().then(loadListings).catch(function (err) {
    document.getElementById('list').innerHTML = '<div id="empty">Fehler beim Laden: ' + esc(err.message) + '</div>';
  });
  setInterval(function () { loadFilters().then(loadListings).catch(function () {}); }, 60000);
})();
</script>
</body>
</html>`;
}
