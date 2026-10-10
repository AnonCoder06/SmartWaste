/* SmartWaste UI. Talks to the backend only through SWApi.backend (see api.js). */
(function () {
'use strict';
var E = SWEngine, Api = SWApi;
var GRID = E.GRID, DEPOT = E.DEPOT, LEVELS = E.LEVELS;
var CLS_NAME = { low: 'Low', med: 'Medium', high: 'High', crit: 'Very high' };
var FILL_NAME = { low: 'Low', med: 'Medium', high: 'Nearly full', crit: 'Overflowing' };

var $ = function (s) { return document.querySelector(s); };
var all = function (s, root) { return Array.prototype.slice.call((root || document).querySelectorAll(s)); };
var clamp = E.clamp;
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
var reduceMotion = function () { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; };

var cfg = JSON.parse(JSON.stringify(E.DEFAULT_CONFIG));
var bins = [], plan = null, D = [], sel = null, lr = 'cur', lc = 'prio';
var lastResult = null, busyMsg = '', log = [], anim, simClock = 'Mon 22:00', saveT, tuneBusy = false, planBusy = false, loaded = false;
var samples = null;
var geoMaps = {}, geoMarkers = { r: [], c: [] }, geoReady = { r: false, c: false };

function binById(id) { return bins.filter(function (b) { return b.id === id; })[0]; }
function row(id) { return D.filter(function (r) { return r.b.id === id; })[0]; }
function cloud() { return Api.mode === 'cloud'; }
function ticked() { return (plan && plan.ticked) || {}; }
function stale() { return !!(cloud() && plan && bins.some(function (b) { return b.updatedAt && b.updatedAt > plan.createdAt; })); }

var toastT;
function toast(m) { var t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('on'); }, 3400); }
function banner(msg, kind, action) {
  ['#bnL', '#bnR'].forEach(function (id) {
    var el = $(id);
    if (!msg) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false; el.className = 'banner' + (kind === 'err' ? ' err' : '');
    el.innerHTML = '<span>' + esc(msg) + '</span>' + (action ? '<button class="btn" type="button" data-act="' + action.id + '">' + esc(action.label) + '</button>' : '');
  });
}
document.addEventListener('click', function (e) {
  var b = e.target.closest('.banner [data-act]'); if (!b) return;
  var a = b.getAttribute('data-act');
  if (a === 'retry') reload(); else if (a === 'replan') runPlan();
});

/* ------------------------------------------------------------------ data loading */
function reload(silent) {
  return Api.backend.state().then(function (s) {
    bins = s.bins; cfg = s.config; plan = s.plan; D = E.derive(bins, cfg);
    if (!sel || !binById(sel)) sel = bins.some(function (b) { return b.id === 'B-17'; }) ? 'B-17' : (bins[0] && bins[0].id);
    loaded = true;
    renderAll();
    if (stale()) banner('Reports have come in since this plan was made.', null, { id: 'replan', label: 'Re-run planner' });
    else banner(null);
  }, function (e) {
    if (!silent || !loaded) banner('Could not load bin data. ' + e.message, 'err', { id: 'retry', label: 'Try again' });
  });
}
function guard(p, what) {
  return p.catch(function (e) {
    toast((what ? what + ': ' : '') + e.message);
    return reload(true);
  });
}

/* ------------------------------------------------------------------ map */
var BASE = (function () {
  var s = '<rect width="1040" height="640" fill="var(--block)"/>';
  s += '<rect x="490" y="250" width="300" height="140" rx="12" fill="var(--park)"/>';
  s += '<ellipse cx="150" cy="330" rx="110" ry="50" fill="var(--water)"/>';
  var i;
  for (i = 0; i <= 13; i++) s += '<line x1="' + i * GRID + '" y1="0" x2="' + i * GRID + '" y2="640" stroke="var(--street)" stroke-width="' + (i === 6 ? 16 : 9) + '"/>';
  for (i = 0; i <= 8; i++) s += '<line x1="0" y1="' + i * GRID + '" x2="1040" y2="' + i * GRID + '" stroke="var(--street)" stroke-width="' + (i === 3 ? 16 : 9) + '"/>';
  s += '<text class="st" x="50" y="226">MAIN ROAD</text><text class="st" x="496" y="602">STATION AVENUE</text>';
  s += '<g transform="translate(900 594)"><line x1="0" y1="0" x2="80" y2="0" stroke="var(--ink)" stroke-width="2"/><line x1="0" y1="-4" x2="0" y2="4" stroke="var(--ink)" stroke-width="2"/><line x1="80" y1="-4" x2="80" y2="4" stroke="var(--ink)" stroke-width="2"/><text class="st" x="0" y="-9" style="fill:var(--ink)">150 m</text></g>';
  return s;
})();
function colorOf(k) { return 'var(--c-' + k + ')'; }
function geoPoint(b) {
  // Older cloud records may not have lon/lat yet. Fall back to the matching
  // seed stop by bin ID so every pin still lands on its own real coordinate.
  var spec = E.SPEC.filter(function (s) { return s[0] === b.id; })[0];
  var lon = b.lon != null ? Number(b.lon) : (spec ? spec[9] : 85.835);
  var lat = b.lat != null ? Number(b.lat) : (spec ? spec[10] : 20.275);
  return [lon, lat];
}
function geoName(b) {
  var spec = E.SPEC.filter(function (s) { return s[0] === b.id; })[0];
  return spec ? spec[1] : b.name;
}
function cssColor(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function geoMarkerHTML(r, layer, withRoute) {
  var b = r.b, cls = layer === 'cur' ? E.fillCls(b.cur) : layer === 'pred' ? E.fillCls(r.pred) : r.tier;
  var val = layer === 'cur' ? Math.round(b.cur) : layer === 'pred' ? Math.round(r.pred) : Math.round(r.score * 100);
  var idx = withRoute && plan ? plan.route.indexOf(b.id) : -1;
  var place = geoName(b);
  var tip = b.id + ' ' + place + ' · ' + Math.round(b.cur) + '% now · ' + Math.round(r.pred) + '% by morning · priority ' + Math.round(r.score * 100);
  var el = document.createElement('button');
  el.type = 'button'; el.className = 'geo-bin' + (withRoute && plan && idx < 0 ? ' dim' : '') + (sel === b.id ? ' sel' : '');
  el.setAttribute('data-id', b.id); el.setAttribute('data-place', place); el.setAttribute('aria-label', tip);
  el.style.setProperty('--pin', cssColor('--c-' + cls));
  el.innerHTML = '<span class="geo-bin-ring">' + val + '</span><span class="geo-bin-label">' + esc(b.id) + '</span>'
    + (idx >= 0 ? '<span class="geo-stop' + (ticked()[b.id] ? ' done' : '') + '" data-stop="' + idx + '">' + (idx + 1) + '</span>' : '');
  el.addEventListener('click', function (e) { e.stopPropagation(); select(b.id); });
  return el;
}
function renderGeoMap(side, layer, withRoute) {
  var map = geoMaps[side], el = $(side === 'r' ? '#rMap' : '#cMap');
  if (!map || !geoReady[side] || !map.loaded()) return false;
  geoMarkers[side].forEach(function (m) { m.remove(); }); geoMarkers[side] = [];
  var srcId = side + '-route';
  if (map.getLayer(srcId + '-line')) map.removeLayer(srcId + '-line');
  if (map.getSource(srcId)) map.removeSource(srcId);
  if (withRoute && plan && plan.route.length) {
    var pts = [geoPoint(DEPOT)].concat(plan.route.map(function (id) { return binById(id); }).filter(Boolean).map(geoPoint), [geoPoint(DEPOT)]);
    map.addSource(srcId, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } } });
    map.addLayer({ id: srcId + '-line', type: 'line', source: srcId, layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': cssColor('--route'), 'line-width': 5, 'line-opacity': 0.9 } });
  }
  var depotEl = document.createElement('div'); depotEl.className = 'geo-depot'; depotEl.textContent = 'D'; depotEl.title = 'Collection depot';
  geoMarkers[side].push(new maplibregl.Marker({ element: depotEl, anchor: 'center' }).setLngLat(geoPoint(DEPOT)).addTo(map));
  D.forEach(function (r) {
    geoMarkers[side].push(new maplibregl.Marker({ element: geoMarkerHTML(r, layer, withRoute), anchor: 'center' }).setLngLat(geoPoint(r.b)).addTo(map));
  });
  requestAnimationFrame(function () { map.resize(); });
  return true;
}
function initGeoMaps(mapConfig) {
  if (!mapConfig || !window.maplibregl || !window.amazonLocationAuthHelper) return;
  amazonLocationAuthHelper.withIdentityPoolId(mapConfig.identityPoolId).then(function (auth) {
    ['r', 'c'].forEach(function (side) {
      $(side === 'r' ? '#rMap' : '#cMap').innerHTML = '';
      var map = new maplibregl.Map({
        container: side === 'r' ? 'rMap' : 'cMap',
        center: [85.835, 20.278], zoom: 12.4,
        style: 'https://maps.geo.' + mapConfig.region + '.amazonaws.com/v2/styles/' + mapConfig.style + '/descriptor',
        attributionControl: true,
        transformRequest: auth.getMapAuthenticationOptions().transformRequest,
      });
      geoMaps[side] = map;
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      map.once('load', function () { geoReady[side] = true; renderMaps(); });
      map.once('error', function (e) {
        if (!geoReady[side] && e && e.error) {
          console.warn('Amazon Location map failed to load; showing the local map view instead.', e.error.message);
          map.remove(); geoMaps[side] = null; renderMaps();
        }
      });
    });
  }).catch(function (e) { console.warn('Amazon Location authentication failed', e); });
}
function binSVG(r, layer, withRoute) {
  var b = r.b, cls, txt;
  if (layer === 'cur') { cls = E.fillCls(b.cur); txt = Math.round(b.cur); }
  else if (layer === 'pred') { cls = E.fillCls(r.pred); txt = Math.round(r.pred); }
  else { cls = r.tier; txt = Math.round(r.score * 100); }
  var idx = withRoute && plan ? plan.route.indexOf(b.id) : -1;
  var dim = withRoute && plan && idx < 0 ? ' dim' : '';
  var isSel = sel === b.id;
  var tip = b.id + ' ' + b.name + ' · ' + Math.round(b.cur) + '% now · ' + Math.round(r.pred) + '% by morning · priority ' + Math.round(r.score * 100);
  var placeW = Math.max(86, Math.min(210, b.name.length * 7 + 24));
  return '<g class="bin' + dim + (isSel ? ' sel' : '') + '" data-id="' + esc(b.id) + '" tabindex="0" role="button" aria-label="' + esc(tip) + '" transform="translate(' + b.x + ',' + b.y + ')">'
    + (isSel ? '<circle class="halo" r="26"/>' : '') + '<circle class="fr" r="23"/>'
    + (layer === 'cur' ? '<circle class="fut" r="21" style="stroke:' + colorOf(E.fillCls(r.pred)) + '"/>' : '')
    + '<circle class="ring" r="16" style="stroke:' + colorOf(cls) + '"/><text class="val" y="4.5">' + txt + '</text><text class="bid" y="36">' + esc(b.id) + '</text>'
    + (idx >= 0 ? '<g class="stop' + (ticked()[b.id] ? ' done' : '') + '" data-stop="' + idx + '" transform="translate(16,-16)"><circle r="9"/><text y="3.5">' + (idx + 1) + '</text></g>' : '')
    + '<g class="bin-place-tooltip" aria-hidden="true"><rect x="' + (-placeW / 2) + '" y="-54" width="' + placeW + '" height="26" rx="7"/><path d="M-5 -29 L0 -24 L5 -29 Z"/><text y="-37">' + esc(b.name) + '</text></g></g>';
}
function routeSVG() {
  if (!plan || !plan.route.length) return '';
  var pts = [DEPOT], d;
  plan.route.forEach(function (id) { var b = binById(id); if (b) pts.push(b); });
  pts.push(DEPOT);
  d = 'M' + pts[0].x + ' ' + pts[0].y;
  for (var i = 1; i < pts.length; i++) d += ' H' + pts[i].x + ' V' + pts[i].y;
  return '<path class="route-casing" d="' + d + '"/><path class="route-line" id="routeLine" d="' + d + '"/>';
}
function legendHTML(layer) {
  var L = layer === 'prio' ? [['low', 'Low <50'], ['med', 'Medium 50–69'], ['high', 'High 70–84'], ['crit', 'Very high 85+']]
    : [['low', 'Low <35%'], ['med', 'Medium 35–64%'], ['high', 'Nearly full 65–89%'], ['crit', 'Overflowing 90%+']];
  return L.map(function (x) { return '<span><i style="--lc:' + colorOf(x[0]) + '"></i>' + x[1] + '</span>'; }).join('') + (layer === 'cur' ? '<span>Dashed ring: by morning</span>' : '');
}
function capText(layer) {
  return {
    cur: '<b>Fill now:</b> how full each bin is right now. The dashed ring shows the colour it is predicted to reach by morning.',
    pred: '<b>By morning:</b> predicted fill when the truck arrives (' + cfg.H + ' h from now). Above 100 means the bin is expected to overflow.',
    prio: '<b>Priority:</b> a 0 to 100 score that sets collection order, from predicted fill, current fill, time since pickup and report risk.'
  }[layer];
}
function setSeg(id, val) { all('button', $(id)).forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-l') === val ? 'true' : 'false'); }); }
function renderMaps() {
  if (!geoMaps.r) $('#rMap').innerHTML = '<svg class="mapsvg" viewBox="40 40 960 570" role="group" aria-label="Map of waste bins">' + BASE + D.map(function (r) { return binSVG(r, lr, false); }).join('') + '</svg>';
  else renderGeoMap('r', lr, false);
  setSeg('#rLayers', lr); $('#rLegend').innerHTML = legendHTML(lr); $('#rCap').innerHTML = capText(lr) + '<br><small>Bin positions are illustrative points in a sample Bengaluru neighborhood.</small>';
  var depot = '<g class="depot" transform="translate(80 560)"><rect x="-13" y="-13" width="26" height="26" rx="5"/><text y="4">D</text><text class="lbl" x="-13" y="28" style="text-anchor:start">DEPOT</text></g>';
  var truck = '<g id="truck" style="display:none"><rect x="-11" y="-8" width="22" height="16" rx="4" fill="var(--route)" stroke="var(--panel)" stroke-width="2.5"/><rect x="3" y="-5" width="6" height="7" rx="1" fill="var(--panel)"/></g>';
  if (!geoMaps.c) $('#cMap').innerHTML = '<svg class="mapsvg" viewBox="40 40 960 570" role="group" aria-label="Map of waste bins and route">' + BASE + routeSVG() + depot + D.map(function (r) { return binSVG(r, lc, true); }).join('') + truck + '</svg>';
  else renderGeoMap('c', lc, true);
  setSeg('#cLayers', lc); $('#cLegend').innerHTML = legendHTML(lc); $('#cCap').innerHTML = capText(lc) + '<br><small>Sample locations; route lines are straight overlays and distance estimates still use the demo street grid.</small>';
  $('#btnPlay').disabled = !(plan && plan.route.length);
}

/* ------------------------------------------------------------------ panels */
function fmtTime(m) { var h = Math.floor(m / 60), mm = Math.round(m % 60); return h ? h + ' h ' + (mm < 10 ? '0' : '') + mm + ' min' : mm + ' min'; }
function stat(k, v, s) { return '<div class="stat"><span class="k">' + k + '</span><span class="v">' + v + '</span><span class="s">' + s + '</span></div>'; }
function planTimeLabel() {
  if (!plan) return cloud() ? 'none yet' : simClock;
  if (!cloud()) return simClock;
  var d = new Date(plan.createdAt);
  return isNaN(d) ? '' : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
function renderStats() {
  var over = D.filter(function (r) { return r.pred >= 100; }).length;
  var vh = D.filter(function (r) { return r.tier === 'crit'; }).length, hi = D.filter(function (r) { return r.tier === 'high'; }).length;
  var avgC = Math.round(bins.reduce(function (a, b) { return a + b.cur; }, 0) / bins.length);
  var avgP = Math.round(D.reduce(function (a, r) { return a + r.pred; }, 0) / D.length);
  $('#rPulse').innerHTML = '<div class="hot"><b>' + over + '</b><span>bins will overflow by morning</span></div>'
    + '<div><b>' + (vh + hi) + '</b><span>bins need a pickup tonight</span></div>'
    + '<div><b>' + avgC + '% → ' + avgP + '%</b><span>average fill, now to morning</span></div>';
  var el = $('#cStats');
  if (plan) {
    var pct = plan.urgentN ? Math.round(plan.urgentC / plan.urgentN * 100) : 100;
    el.className = 'stats';
    el.innerHTML = stat('Bins to collect', plan.route.length + ' of ' + bins.length, (bins.length - plan.route.length) + ' skipped')
      + stat('Route distance', plan.km.toFixed(1) + ' km', Math.max(0, plan.baseKm - plan.km).toFixed(1) + ' km shorter than all ' + bins.length)
      + stat('Estimated time', fmtTime(plan.timeMin), 'plus 3 min per stop')
      + stat('Truck load', Math.round(plan.load).toLocaleString() + ' L', Math.round(plan.load / cfg.truckCap * 100) + '% of ' + cfg.truckCap.toLocaleString() + ' L')
      + stat('Urgent bins covered', pct + '%', plan.urgentC + ' of ' + plan.urgentN + ' above 90% by morning');
  } else {
    el.className = 'empty';
    el.innerHTML = 'No route yet. Run the planner to see route distance, time, truck load and urgent coverage.';
  }
  updateCovers(over, vh + hi);
}
function updateCovers(over, urgent) {
  var l = $('#liveL'), r = $('#liveR');
  if (over === undefined) return;
  l.textContent = over + ' bins forecast to overflow';
  r.textContent = plan ? 'Route ready: ' + plan.route.length + ' stops, ' + plan.km.toFixed(1) + ' km' : urgent + ' priority bins waiting';
}
function inspectorHTML() {
  var r = row(sel); if (!r) return '<div class="empty">Select a bin on the map.</div>';
  var b = r.b, f = E.factors(b, cfg), w = E.normW(cfg), cc = E.fillCls(b.cur);
  var rows = [['Predicted fill', f.pred, w.pred], ['Current fill', f.cur, w.cur], ['Time since pickup', f.time, w.time], ['Report risk', f.risk, w.risk]];
  var stopN = plan ? plan.route.indexOf(b.id) : -1;
  var h = '<div style="display:flex;flex-direction:column;gap:16px">';
  h += '<div class="insp-head"><div><h3>' + esc(b.id) + ' · ' + esc(b.name) + '</h3><p>' + b.cap + ' L bin · ' + (stopN >= 0 ? 'stop ' + (stopN + 1) + ' on the route' : 'not on a route') + '</p></div><span class="pill t-' + r.tier + '">' + CLS_NAME[r.tier] + '</span></div>';
  h += '<div><div class="meter" role="img" aria-label="Fill ' + Math.round(b.cur) + '% now, ' + Math.round(r.pred) + '% by morning"><div class="m-cur" style="width:' + Math.min(b.cur, 125) / 125 * 100 + '%;background:' + colorOf(cc) + '"></div><div class="m-100" style="left:80%"></div><div class="m-pred" style="left:' + Math.min(r.pred, 125) / 125 * 100 + '%"></div></div>'
    + '<div class="m-legend"><span>Now <b class="mono">' + Math.round(b.cur) + '%</b> · ' + FILL_NAME[cc] + '</span><span>By morning <b class="mono">' + Math.round(r.pred) + '%</b></span></div></div>';
  h += '<div class="kv"><div><span>Fill rate</span><b>' + b.rate.toFixed(1) + ' %/h</b></div><div><span>Since pickup</span><b>' + b.since + ' h</b></div><div><span>Reports</span><b>' + b.rep + '</b></div></div>';
  h += '<div><p class="sub-h">Priority score</p><div class="score"><b class="mono">' + Math.round(r.score * 100) + '</b><span>out of 100 · ' + CLS_NAME[r.tier] + '</span></div><div class="bd">'
    + rows.map(function (x) { return '<div class="bd-row"><div>' + x[0] + '<small>' + x[2].toFixed(2) + ' × ' + x[1].toFixed(2) + '</small></div><div class="bd-bar"><i style="width:' + Math.min(100, x[1] / 1.25 * 100) + '%"></i></div><b>' + (x[1] * x[2]).toFixed(2) + '</b></div>'; }).join('') + '</div></div>';
  return h + '</div>';
}
function getSamples() { if (!samples) samples = [0, 1, 2, 3].map(E.sampleImage); return samples; }
function renderReporter() {
  var r = row(sel), el = $('#rRep'); if (!r) { el.innerHTML = ''; return; }
  var b = r.b, S = getSamples();
  var h = '<div><p class="eyebrow">Report</p><h3 style="font-size:21px;margin-top:2px">Estimate fill level from a photo</h3></div>'
    + '<p class="rep-for">Reporting for <b class="mono">' + esc(b.id) + '</b> · ' + esc(b.name) + '. Pick another bin on the map to report on it.</p>'
    + '<label class="drop" for="photo"><input type="file" id="photo" accept="image/*"' + (busyMsg ? ' disabled' : '') + '><span>Choose a photo of ' + esc(b.id) + '</span><small>or tap a sample below</small></label>'
    + '<div class="samples">' + LEVELS.map(function (l, i) { return '<button class="sample" data-lv="' + i + '"' + (busyMsg ? ' disabled' : '') + ' aria-label="Sample photo: ' + l.n + '"><img alt="" src="' + S[i] + '"><span>' + l.n + '</span></button>'; }).join('') + '</div>';
  if (busyMsg) h += '<div class="busy"><span class="spin"></span>' + esc(busyMsg) + '</div>';
  else if (lastResult && lastResult.binId === b.id) {
    var L = lastResult, bs = Math.round(L.before.score * 100), as = Math.round(L.after.score * 100);
    h += '<div class="result"><img alt="Submitted photo" src="' + L.thumb + '"><div><b>Detected: ' + LEVELS[L.lv].n + '</b> <span class="mono muted">' + Math.round(L.conf * 100) + '%</span>'
      + '<p>Fill set to ' + LEVELS[L.lv].v + '%. Predicted ' + Math.round(L.before.pred) + '% → ' + Math.round(L.after.pred) + '%. Priority ' + bs + ' → ' + as + '.</p>'
      + '<div class="chips"><span>Wrong? Correct it:</span>' + LEVELS.map(function (l, i) { return '<button class="chip" data-fix="' + i + '" aria-pressed="' + (i === L.lv) + '">' + l.n + '</button>'; }).join('') + '</div></div></div>';
  } else h += '<div class="empty">No report for ' + esc(b.id) + ' yet. Add a photo or tap a sample to see the detected fill level and how its priority changes.</div>';
  if (log.length) h += '<div><p class="sub-h">Recent updates</p><ul class="feed">' + log.map(function (x) { return '<li><time>' + esc(x.t) + '</time><span>' + esc(x.m) + '</span></li>'; }).join('') + '</ul></div>';
  el.innerHTML = h;
}
function renderTasks() {
  var el = $('#cTasks');
  if (!plan) {
    el.innerHTML = '<div class="empty">The task list fills in when the planner runs. Stops appear in driving order.</div>';
    $('#cProg').textContent = ''; $('#cProgBar').style.width = '0'; return;
  }
  var tk = ticked(), done = plan.route.filter(function (id) { return tk[id]; }).length;
  $('#cProg').textContent = done + ' of ' + plan.route.length + ' collected';
  $('#cProgBar').style.width = (plan.route.length ? done / plan.route.length * 100 : 0) + '%';
  var h = '<ol class="tasks">' + plan.route.map(function (id, i) {
    var r = row(id); if (!r) return '';
    var ok = !!tk[id];
    return '<li class="task' + (sel === id ? ' sel' : '') + (ok ? ' ok' : '') + '" data-id="' + esc(id) + '"><button class="tick" data-tick="' + esc(id) + '" aria-pressed="' + ok + '" aria-label="Mark ' + esc(id) + ' ' + esc(r.b.name) + ' collected">' + (ok ? '✓' : '') + '</button><span class="ord">' + (i + 1) + '</span>'
      + '<span class="tn">' + esc(r.b.name) + '<small>' + esc(id) + ' · ' + Math.round(r.pred) + '% · ' + Math.round(r.load) + ' L</small></span><span class="pill t-' + r.tier + '">' + Math.round(r.score * 100) + '</span></li>';
  }).join('') + '</ol>';
  if (plan.deferred.length) h += '<p class="defer" style="margin-top:10px">Left for later, truck full: ' + plan.deferred.join(', ') + '.</p>';
  el.innerHTML = h;
}
function actionOf(r) {
  var i = plan ? plan.route.indexOf(r.b.id) : -1;
  if (plan) {
    if (i >= 0) return { t: 'Collect', c: 'go' };
    if (plan.deferred.indexOf(r.b.id) >= 0) return { t: 'Skip: truck full', c: 'skip' };
    return { t: 'Skip', c: 'skip' };
  }
  return r.tier === 'low' ? { t: 'Skip', c: 'skip' } : r.tier === 'med' ? { t: 'Collect if capacity allows', c: '' } : { t: 'Collect', c: 'go' };
}
function renderTable() {
  var rows = D.slice().sort(function (a, b) { return b.score - a.score; });
  var h = '<thead><tr><th>' + (plan ? 'Stop' : '') + '</th><th>Bin</th><th>Location</th><th class="n">Now</th><th class="n">By morning</th><th class="n">Priority</th><th class="n">Load</th><th>' + (plan ? 'Action' : 'Planned action') + '</th></tr></thead><tbody>';
  rows.forEach(function (r) {
    var a = actionOf(r), i = plan ? plan.route.indexOf(r.b.id) : -1;
    h += '<tr data-id="' + esc(r.b.id) + '" class="' + (sel === r.b.id ? 'sel' : '') + '"><td>' + (i >= 0 ? '<span class="ord">' + (i + 1) + '</span>' : '') + '</td><td class="mono">' + esc(r.b.id) + '</td><td>' + esc(r.b.name) + '</td><td class="n">' + Math.round(r.b.cur) + '%</td><td class="n">' + Math.round(r.pred) + '%</td>'
      + '<td class="n"><span class="pill t-' + r.tier + '">' + Math.round(r.score * 100) + ' · ' + CLS_NAME[r.tier] + '</span></td><td class="n">' + Math.round(r.load) + ' L</td><td class="act ' + a.c + '">' + a.t + '</td></tr>';
  });
  $('#tbl').innerHTML = h + '</tbody>';
  $('#planTitle').textContent = plan ? 'Collection plan' : 'Bins ranked by priority';
  var sched = cloud() && Api.config.schedule ? ' The planner also runs by itself ' + Api.config.schedule + '.' : '';
  $('#planSub').textContent = (plan ? 'Route order, skipped bins and truck load. Click a row to inspect a bin.' : 'Preview of the planned action for each bin. Run the planner to build the route.') + sched;
}
function renderTune() {
  if (tuneBusy) return;
  $('#sH').value = cfg.H; $('#sCap').value = cfg.truckCap; $('#sLam').value = cfg.lamPct;
  $('#wP').value = cfg.wts.pred; $('#wC').value = cfg.wts.cur; $('#wT').value = cfg.wts.time; $('#wR').value = cfg.wts.risk;
  tuneLabels();
}
function tuneLabels() {
  $('#oH').textContent = cfg.H + ' h'; $('#oCap').textContent = cfg.truckCap.toLocaleString() + ' L';
  $('#oLam').textContent = cfg.lamPct <= 15 ? 'shortest' : cfg.lamPct >= 70 ? 'urgent first' : 'balanced';
  var w = E.normW(cfg);
  $('#oP').textContent = Math.round(w.pred * 100) + '%'; $('#oC').textContent = Math.round(w.cur * 100) + '%'; $('#oT').textContent = Math.round(w.time * 100) + '%'; $('#oR').textContent = Math.round(w.risk * 100) + '%';
}
function renderChrome() {
  $('#modePill').hidden = cloud();
  $('#clockLbl').textContent = cloud() ? 'Latest plan' : 'Planner time';
  $('#clock').textContent = planTimeLabel();
  $('#btnCollect').disabled = !plan || planBusy;
  $('#btnPlan').disabled = planBusy;
  $('#btnPlan').textContent = planBusy ? 'Planning…' : (plan ? 'Re-run planner' : 'Run nightly planner');
}
function renderAll() {
  cancelAnimationFrame(anim);
  renderChrome();
  if (!bins.length) return;
  renderMaps(); renderStats();
  var ins = inspectorHTML(); $('#rInsp').innerHTML = ins; $('#cInsp').innerHTML = ins;
  renderReporter(); renderTasks(); renderTable(); renderTune();
}

/* ------------------------------------------------------------------ actions */
function stamp() { var d = new Date(); return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes(); }
function finishReport(rep, thumb) {
  busyMsg = '';
  lastResult = { id: rep.id, binId: rep.binId, lv: rep.level, conf: rep.conf, thumb: thumb, before: rep.before, after: rep.after };
  log.unshift({ t: stamp(), m: rep.binId + ' · ' + rep.source + ' · ' + LEVELS[rep.level].n + ', priority ' + Math.round(rep.after.score * 100) });
  log = log.slice(0, 4);
  var next = (!cloud() && plan) ? Api.backend.runPlan() : Promise.resolve();
  return next.then(reload).then(function () { toast(rep.binId + ' updated to ' + LEVELS[rep.level].n.toLowerCase() + '.'); });
}
function failReport(e) {
  busyMsg = '';
  toast(e.message); renderReporter();
}
function reportSample(i) {
  busyMsg = 'Estimating fill level…'; renderReporter();
  var id = sel, thumb = getSamples()[i];
  setTimeout(function () {
    Api.backend.report(id, i, { source: 'sample' }).then(function (rep) { return finishReport(rep, thumb); }, failReport);
  }, 500);
}
function reportFile(file) {
  var thumb = URL.createObjectURL(file);
  busyMsg = 'Preparing photo…'; renderReporter();
  Api.backend.photo(sel, file, function (m) { busyMsg = m; renderReporter(); }).then(function (rep) { return finishReport(rep, thumb); }, failReport);
}
function correct(i) {
  if (!lastResult) return;
  var thumb = lastResult.thumb;
  Api.backend.report(lastResult.binId, i, { source: 'correction', replaces: lastResult.id }).then(function (rep) { return finishReport(rep, thumb); }, failReport);
}
function runPlan() {
  planBusy = true; renderChrome();
  return Api.backend.runPlan().then(function (p) {
    planBusy = false; return reload().then(function () { toast('Plan ready: ' + p.route.length + ' bins, ' + p.km.toFixed(1) + ' km.'); });
  }, function (e) { planBusy = false; renderChrome(); toast(e.message); });
}
function collect() {
  var n = plan ? plan.route.length : 0;
  guard(Api.backend.complete().then(function () {
    lastResult = null; simClock = 'Tue 06:40';
    log.unshift({ t: stamp(), m: 'Truck finished: ' + n + ' bins serviced and reset' }); log = log.slice(0, 4);
    return reload().then(function () { toast(n + ' bins serviced and reset.'); });
  }), 'Could not complete the collection');
}
function tick(id) {
  if (!plan) return;
  var done = !ticked()[id];
  plan.ticked = plan.ticked || {}; plan.ticked[id] = done; renderAll();
  Api.backend.setStop(id, done).catch(function (e) {
    plan.ticked[id] = !done; renderAll();
    toast(e.message);
  });
}
function playRoute() {
  if (geoReady.c && geoMaps.c && plan && plan.route.length) { playGeoRoute(); return; }
  var path = $('#routeLine'), truck = $('#truck'); if (!plan || !path || !truck) return;
  var Lg = path.getTotalLength(), dur = reduceMotion() ? 1 : clamp(Lg * 8, 3500, 9000), t0 = performance.now();
  cancelAnimationFrame(anim); truck.style.display = '';
  var stops = all('.stop', $('#cMap'));
  function step(now) {
    var p = Math.min(1, (now - t0) / dur), pt = path.getPointAtLength(p * Lg);
    truck.setAttribute('transform', 'translate(' + pt.x + ',' + pt.y + ')');
    stops.forEach(function (s) { var i = +s.getAttribute('data-stop'); s.classList.toggle('done', p * Lg >= plan.cum[i] - 0.5); });
    if (p < 1) anim = requestAnimationFrame(step);
  }
  anim = requestAnimationFrame(step);
}
function playGeoRoute() {
  var map = geoMaps.c, pts = [geoPoint(DEPOT)].concat(plan.route.map(function (id) { return binById(id); }).filter(Boolean).map(geoPoint), [geoPoint(DEPOT)]);
  if (pts.length < 2) return;
  var pixels = pts.map(function (p) { return map.project(p); }), lens = [], total = 0;
  for (var i = 1; i < pixels.length; i++) { var dx = pixels[i].x - pixels[i - 1].x, dy = pixels[i].y - pixels[i - 1].y; lens.push(Math.sqrt(dx * dx + dy * dy)); total += lens[i - 1]; }
  var truckEl = document.createElement('div'); truckEl.className = 'geo-truck'; truckEl.textContent = '↗';
  var marker = new maplibregl.Marker({ element: truckEl, anchor: 'center' }).setLngLat(pts[0]).addTo(map);
  var t0 = performance.now(), dur = reduceMotion() ? 1 : 6500;
  function step(now) {
    var distance = Math.min(1, (now - t0) / dur) * total, seg = 0;
    while (seg < lens.length - 1 && distance > lens[seg]) { distance -= lens[seg]; seg++; }
    var q = lens[seg] ? clamp(distance / lens[seg], 0, 1) : 1;
    marker.setLngLat([pts[seg][0] + (pts[seg + 1][0] - pts[seg][0]) * q, pts[seg][1] + (pts[seg + 1][1] - pts[seg][1]) * q]);
    var done = plan.route.filter(function (_id, ix) { var along = lens.slice(0, ix + 1).reduce(function (a, b) { return a + b; }, 0); return along <= (Math.min(1, (now - t0) / dur) * total); });
    $('#cMap').querySelectorAll('.geo-stop').forEach(function (stop) { stop.classList.toggle('done', +stop.getAttribute('data-stop') < done.length); });
    if ((now - t0) < dur) anim = requestAnimationFrame(step); else marker.remove();
  }
  cancelAnimationFrame(anim); anim = requestAnimationFrame(step);
}
function select(id) { sel = id; renderAll(); }

/* ------------------------------------------------------------------ events */
function mapClick(e) { var g = e.target.closest('.bin'); if (g) select(g.getAttribute('data-id')); }
function mapKey(e) { if (e.key === 'Enter' || e.key === ' ') { var g = e.target.closest('.bin'); if (g) { e.preventDefault(); select(g.getAttribute('data-id')); } } }
$('#rMap').addEventListener('click', mapClick); $('#cMap').addEventListener('click', mapClick);
$('#rMap').addEventListener('keydown', mapKey); $('#cMap').addEventListener('keydown', mapKey);
$('#tbl').addEventListener('click', function (e) { var tr = e.target.closest('tr[data-id]'); if (tr) select(tr.getAttribute('data-id')); });
$('#cTasks').addEventListener('click', function (e) {
  var t = e.target.closest('[data-tick]'); if (t) { tick(t.getAttribute('data-tick')); return; }
  var li = e.target.closest('.task'); if (li) select(li.getAttribute('data-id'));
});
$('#rRep').addEventListener('click', function (e) {
  var s = e.target.closest('.sample'); if (s) { reportSample(+s.getAttribute('data-lv')); return; }
  var c = e.target.closest('.chip'); if (c) correct(+c.getAttribute('data-fix'));
});
$('#rRep').addEventListener('change', function (e) { if (e.target.id === 'photo' && e.target.files[0]) reportFile(e.target.files[0]); });
$('#rLayers').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; lr = b.getAttribute('data-l'); renderMaps(); });
$('#cLayers').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; lc = b.getAttribute('data-l'); renderMaps(); });
$('#btnPlan').addEventListener('click', runPlan);
$('#btnCollect').addEventListener('click', collect);
$('#btnPlay').addEventListener('click', playRoute);
$('#btnReset').addEventListener('click', function () {
  if (cloud() && !window.confirm('Reset every bin and plan back to the starting data? This affects everyone using this site.')) return;
  cancelAnimationFrame(anim); lastResult = null; log = []; simClock = 'Mon 22:00';
  guard(Api.backend.reset().then(reload).then(function () { toast('Data reset.'); }), 'Reset failed');
});
function bind(id, fn) {
  $(id).addEventListener('input', function (e) {
    fn(+e.target.value); tuneBusy = true; D = E.derive(bins, cfg); tuneLabels(); renderMaps(); renderStats(); renderTable();
    var ins = inspectorHTML(); $('#rInsp').innerHTML = ins; $('#cInsp').innerHTML = ins;
    clearTimeout(saveT); saveT = setTimeout(saveTune, 450);
  });
}
function saveTune() {
  var p = Api.backend.saveConfig(cfg).then(function () { return plan ? Api.backend.runPlan() : null; });
  guard(p.then(function () { tuneBusy = false; return reload(); }), 'Could not save settings').then(function () { tuneBusy = false; });
}
bind('#sH', function (v) { cfg.H = v; }); bind('#sCap', function (v) { cfg.truckCap = v; }); bind('#sLam', function (v) { cfg.lamPct = v; });
bind('#wP', function (v) { cfg.wts.pred = v; }); bind('#wC', function (v) { cfg.wts.cur = v; }); bind('#wT', function (v) { cfg.wts.time = v; }); bind('#wR', function (v) { cfg.wts.risk = v; });

/* ------------------------------------------------------------------ gateway */
var gate = $('#gate'), conL = $('#conL'), conR = $('#conR'), covL = $('#covL'), covR = $('#covR'), backBtn = $('#btnBack');
function setOpen(side, instant) {
  if (side) { gate.setAttribute('data-open', side); gate.removeAttribute('data-returning'); }
  else { gate.removeAttribute('data-open'); gate.setAttribute('data-returning', ''); }
  conL.inert = side !== 'l'; conR.inert = side !== 'r';
  covL.inert = !!side; covR.inert = !!side; backBtn.inert = !side;
  if (side) {
    renderChrome();
    (side === 'l' ? conL : conR).scrollTop = 0;
    reload();
    setTimeout(function () { if (gate.getAttribute('data-open') === side) backBtn.focus({ preventScroll: true }); }, instant ? 0 : 950);
  }
  try { history.replaceState(null, '', side ? (side === 'l' ? '#reporter' : '#collector') : location.pathname + location.search); } catch (e) {}
}
function resumeCoverHover() { if (gate.hasAttribute('data-returning')) gate.removeAttribute('data-returning'); }
gate.addEventListener('pointermove', resumeCoverHover);
document.addEventListener('keydown', resumeCoverHover);
function enter(side) {
  setOpen(side);
}
function wireCover(el, side) {
  el.addEventListener('click', function () { enter(side); });
  el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enter(side); } });
}
wireCover(covL, 'l'); wireCover(covR, 'r');
function leave() { var was = gate.getAttribute('data-open'); setOpen(null); (was === 'l' ? covL : covR).focus({ preventScroll: true }); }
backBtn.addEventListener('click', leave);
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && gate.hasAttribute('data-open')) leave(); });
setInterval(function () {
  if (cloud() && gate.hasAttribute('data-open') && document.visibilityState === 'visible' && !busyMsg && !tuneBusy && !planBusy) reload(true);
}, 20000);

/* ------------------------------------------------------------------ theme */
var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function effTheme() { var t = document.documentElement.getAttribute('data-theme'); return t || (mq && mq.matches ? 'dark' : 'light'); }
function renderTheme() { var cur = effTheme(); all('button', $('#themeSeg')).forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-t') === cur ? 'true' : 'false'); }); }
$('#themeSeg').addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  document.documentElement.setAttribute('data-theme', b.getAttribute('data-t'));
  try { localStorage.setItem('sw-theme', b.getAttribute('data-t')); } catch (x) {}
  renderTheme();
});
if (mq && mq.addEventListener) mq.addEventListener('change', renderTheme);
try { var saved = localStorage.getItem('sw-theme'); if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved); } catch (e) {}

/* ------------------------------------------------------------------ boot */
conL.inert = true; conR.inert = true; backBtn.inert = true;
Api.init().then(function () {
  initGeoMaps(Api.config && Api.config.map);
  renderTheme(); renderChrome(); updateCovers();
  if (!cloud()) { return reload().then(function () { routeFromHash(); }); }
  routeFromHash();
});
function routeFromHash() {
  var h = (location.hash || '').replace('#', '');
  var side = h === 'reporter' ? 'l' : h === 'collector' ? 'r' : null;
  if (!side) return;
  setOpen(side, true);
}
window.__sw = { get state() { return { bins: bins, plan: plan, cfg: cfg, mode: Api.mode }; } };
})();
