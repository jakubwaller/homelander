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
  html, body { height: 100%; }
  body { background: var(--bg); color: var(--text); font: 14px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif; height: 100vh; height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
  header { display:flex; align-items:center; gap:16px; flex-wrap:wrap; padding:14px 20px; border-bottom:1px solid var(--border); background:var(--bg); z-index:1100; }
  header h1 { font-size:17px; color:var(--gold); white-space:nowrap; }
  header .count { color:var(--text-dim); font-size:13px; }
  .controls { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .controls input, .controls select {
    background:var(--bg-card); color:var(--text); border:1px solid var(--border);
    border-radius:8px; padding:6px 10px; font-size:13px; outline:none;
  }
  .controls input:focus, .controls select:focus { border-color:var(--gold); }
  .controls input[type=number] { width:96px; }
  #filter-toggle, #list-toggle { display:none; background:var(--bg-card); color:var(--text-dim); border:1px solid var(--border); border-radius:8px; padding:6px 12px; font-size:13px; cursor:pointer; }
  #list-toggle { margin-left:auto; }
  #filter-toggle.on, #list-toggle.on { border-color:var(--gold); color:var(--gold); }
  #layout { display:grid; grid-template-columns: minmax(360px, 46%) 1fr; flex:1; min-height:0; }
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
  .card.seen { opacity:.45; }
  .seen-btn { background:none; border:1px solid var(--border); color:var(--text-dim); border-radius:8px; padding:3px 9px; font-size:12px; cursor:pointer; flex-shrink:0; align-self:flex-start; }
  .seen-btn:hover { border-color:var(--gold); color:var(--gold); }
  .card.seen .seen-btn, .seen-btn.on { color:var(--green); border-color:#34d39944; }
  label.chk { display:flex; gap:5px; align-items:center; font-size:13px; color:var(--text-dim); cursor:pointer; }
  #detail .gallery { display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:8px; margin:10px 0; }
  #detail .gallery img { width:100%; height:104px; object-fit:cover; border-radius:8px; background:var(--bg-elevated); }
  #detail .gallery img.fp { outline:2px solid var(--gold-dark); }
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
  .locate-btn { font-size:17px; }
  @media (max-width: 900px) {
    /* List folded by default: display:none takes it out of the grid, so the
       map is the only row and gets the whole viewport. The "Liste" toggle
       restores the split. */
    #layout { grid-template-columns: 1fr; grid-template-rows: 1fr; }
    #list { display:none; }
    #layout.list-open { grid-template-rows: 45% 55%; }
    #layout.list-open #list { display:flex; }
    #filter-toggle, #list-toggle { display:block; }
    .controls { display:none; width:100%; }
    header.filters-open .controls { display:flex; }
    /* 16px keeps iOS Safari from zooming the page on input focus */
    .controls input, .controls select { font-size:16px; }
  }
</style>
</head>
<body>
<header>
  <h1>⌂ Kaufradar</h1>
  <span class="count" id="count">…</span>
  <button id="list-toggle" aria-expanded="false" aria-controls="list">Liste</button>
  <button id="filter-toggle" aria-expanded="false" aria-controls="controls">Filter</button>
  <div class="controls" id="controls">
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
    <label class="chk"><input type="checkbox" id="f-hideseen"> Gesehene ausblenden</label>
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
  var cards = {};
  var markerLayer = null;
  var map = null;
  var activeHash = null;
  var locateLayer = null;
  var lastFitKey = null;

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
    var LocateControl = L.Control.extend({
      onAdd: function () {
        var div = L.DomUtil.create('div', 'leaflet-bar');
        var a = L.DomUtil.create('a', 'locate-btn', div);
        a.href = '#';
        a.title = 'Meinen Standort anzeigen';
        a.setAttribute('aria-label', 'Meinen Standort anzeigen');
        a.textContent = '◎';
        L.DomEvent.on(a, 'click', function (e) { L.DomEvent.stop(e); locateMe(a); });
        return div;
      }
    });
    new LocateControl({ position: 'topleft' }).addTo(map);
    // The map pane resizes when the mobile filter panel opens/closes and when
    // the mobile browser chrome collapses; Leaflet won't notice on its own.
    if (window.ResizeObserver) {
      new ResizeObserver(function () { map.invalidateSize(); }).observe(document.getElementById('map'));
    }
    loadTransitLines();
    loadManualProjects();
  }

  // Geolocation only works in secure contexts — https://homelander.… and
  // localhost qualify, plain-http LAN access does not; there the error
  // callback fires and the button just flashes ✕.
  function locateMe(btn) {
    function fail() {
      btn.textContent = '✕';
      setTimeout(function () { btn.textContent = '◎'; }, 1500);
    }
    if (!navigator.geolocation) return fail();
    btn.textContent = '…';
    navigator.geolocation.getCurrentPosition(function (pos) {
      btn.textContent = '◎';
      var ll = [pos.coords.latitude, pos.coords.longitude];
      if (locateLayer) map.removeLayer(locateLayer);
      locateLayer = L.layerGroup([
        L.circle(ll, {
          radius: pos.coords.accuracy || 0, weight: 1, color: '#3b82f6',
          fillColor: '#3b82f6', fillOpacity: 0.12, interactive: false
        }),
        L.circleMarker(ll, { radius: 7, weight: 2, color: '#ffffff', fillColor: '#3b82f6', fillOpacity: 1 })
      ]).addTo(map);
      map.setView(ll, Math.max(map.getZoom(), 14));
    }, fail, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
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

  function projectStyle(p) {
    return p.seen
      ? { radius: 9, weight: 2, color: '#3b2f14', fillColor: '#94a3b8', fillOpacity: 0.6 }
      : { radius: 9, weight: 2, color: '#3b2f14', fillColor: '#D9A441', fillOpacity: 0.95 };
  }

  function setProjectSeen(p, marker, next) {
    fetch('/api/scan/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash: p.hash, seen: next })
    }).then(function () {
      p.seen = next ? 1 : 0;
      marker.setStyle(projectStyle(p));
      var popup = marker.getPopup();
      var a = popup && popup.isOpen() ? popup.getElement().querySelector('.proj-seen') : null;
      if (a) a.textContent = p.seen ? 'Als ungesehen markieren' : 'Als gesehen markieren';
    }).catch(function () {});
  }

  function loadManualProjects() {
    fetch('/api/scan/projects').then(function (r) { return r.json(); }).then(function (data) {
      (data.projects || []).forEach(function (p) {
        if (p.lat == null || p.lng == null) return;
        var m = L.circleMarker([p.lat, p.lng], projectStyle(p)).addTo(map);
        m.bindTooltip(p.name);
        m.bindPopup(
          '<strong>' + esc(p.name) + '</strong> <span style="color:#B8860B">Neubau</span><br>' +
          esc(p.address || '') +
          (p.note ? '<br>' + esc(p.note) : '') +
          (p.url ? '<br><a href="' + esc(p.url) + '" target="_blank" rel="noopener">Projektseite</a>' : '') +
          (p.hash ? '<br><a href="#" class="proj-seen"></a>' : '')
        );
        // Mirror the listing dots: opening a pin marks the project seen
        // (grey, in place — the popup stays open); the popup link toggles.
        m.on('click', function () {
          if (!p.seen && p.hash) setProjectSeen(p, m, true);
        });
        m.on('popupopen', function (e) {
          var a = e.popup.getElement().querySelector('.proj-seen');
          if (!a) return;
          a.textContent = p.seen ? 'Als ungesehen markieren' : 'Als gesehen markieren';
          a.addEventListener('click', function (ev) {
            ev.preventDefault();
            setProjectSeen(p, m, !p.seen);
          });
        });
      });
    }).catch(function () { /* no pins then */ });
  }

  // Marker fills need to be dark and saturated: the pastel badge colours wash
  // out on the light OSM tiles.
  function sourceColor(source) {
    return source === 'kleinanzeigen' ? '#059669' : source === 'neubaukompass' ? '#dc2626' : '#7c3aed';
  }

  function markerStyle(l) {
    return l.seen
      ? { radius: 7, weight: 2, color: '#ffffff', fillColor: '#94a3b8', fillOpacity: 0.6 }
      : { radius: 7, weight: 2, color: '#ffffff', fillColor: sourceColor(l.source), fillOpacity: 0.9 };
  }

  function filtered() {
    var fid = document.getElementById('f-filter').value;
    var q = document.getElementById('f-q').value.trim().toLowerCase();
    var maxPrice = parseFloat(document.getElementById('f-maxprice').value) || 0;
    var minRooms = parseFloat(document.getElementById('f-minrooms').value) || 0;
    var minSize = parseFloat(document.getElementById('f-minsize').value) || 0;
    var days = parseFloat(document.getElementById('f-days').value) || 0;
    var cutoff = days ? Date.now() - days * 24 * 3600 * 1000 : 0;
    var hideSeen = document.getElementById('f-hideseen').checked;
    var rows = all.filter(function (l) {
      if (hideSeen && l.seen) return false;
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
      '</div></div>' +
      '<button class="seen-btn" title="' + (l.seen ? 'Als ungesehen markieren' : 'Als gesehen markieren') + '">✓</button>';
  }

  // inPlace restyles the existing card + marker instead of re-rendering,
  // so the map popup a click just opened stays open.
  function setSeen(l, next, inPlace) {
    fetch('/api/scan/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash: l.hash, seen: next })
    }).then(function () {
      l.seen = next ? 1 : 0;
      if (!inPlace) return render();
      if (markers[l.hash]) markers[l.hash].setStyle(markerStyle(l));
      if (cards[l.hash]) cards[l.hash].classList.toggle('seen', !!l.seen);
    }).catch(function () {});
  }

  function toggleSeen(l) {
    setSeen(l, !l.seen);
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
    cards = {};
    var bounds = [];
    rows.forEach(function (l) {
      var card = document.createElement('div');
      card.className = 'card' + (l.hash === activeHash ? ' active' : '') + (l.seen ? ' seen' : '');
      card.innerHTML = cardHtml(l);
      card.addEventListener('click', function () { openDetail(l); });
      card.querySelector('.seen-btn').addEventListener('click', function (ev) {
        ev.stopPropagation();
        toggleSeen(l);
      });
      list.appendChild(card);
      cards[l.hash] = card;
      if (l.lat != null && l.lng != null) {
        var m = L.circleMarker([l.lat, l.lng], markerStyle(l));
        m.on('click', function () {
          if (!l.seen) setSeen(l, true, true);
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
    // Refit only when the visible marker set changed — the 60 s auto-refresh
    // re-renders too, and must not yank away a view the user chose (e.g.
    // after zooming to their own location).
    var fitKey = bounds.join(';');
    if (bounds.length && fitKey !== lastFitKey) {
      lastFitKey = fitKey;
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 });
    }
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
      '<button class="seen-btn' + (l.seen ? ' on' : '') + '" id="detail-seen" style="position:absolute;top:12px;right:48px">' +
      (l.seen ? '✓ gesehen' : 'als gesehen markieren') + '</button>' +
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
      '<div class="gallery" id="gallery"></div>' +
      detailTables(l.details) +
      (l.url ? '<a class="out" href="' + esc(l.url) + '" target="_blank" rel="noopener">Zum Original-Inserat ↗</a>' : '');
    el.querySelector('.close').addEventListener('click', closeDetail);
    el.querySelector('#detail-seen').addEventListener('click', function () {
      toggleSeen(l);
      closeDetail();
    });
    fetch('/api/scan/media/' + l.hash).then(function (r) { return r.json(); }).then(function (m) {
      var g = document.getElementById('gallery');
      if (!g || !m.files || !m.files.length) return;
      g.innerHTML = m.files.map(function (f) {
        return '<a href="' + esc(f.url) + '" target="_blank" rel="noopener">' +
          '<img loading="lazy"' + (f.floorplan ? ' class="fp"' : '') + ' src="' + esc(f.url) + '"' +
          ' title="' + esc(f.caption || (f.floorplan ? 'Grundriss' : '')) + '"></a>';
      }).join('');
    }).catch(function () { /* archive not there yet */ });
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

  document.getElementById('filter-toggle').addEventListener('click', function () {
    var on = document.querySelector('header').classList.toggle('filters-open');
    this.classList.toggle('on', on);
    this.setAttribute('aria-expanded', on ? 'true' : 'false');
  });

  document.getElementById('list-toggle').addEventListener('click', function () {
    var on = document.getElementById('layout').classList.toggle('list-open');
    this.classList.toggle('on', on);
    this.setAttribute('aria-expanded', on ? 'true' : 'false');
  });

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

  ['f-filter', 'f-sort', 'f-days', 'f-hideseen'].forEach(function (id) {
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
