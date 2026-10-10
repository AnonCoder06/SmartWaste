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

function binById(id) { return bins.filter(function (b) { return b.id === id; })[0]; }
function row(id) { return D.filter(function (r) { return r.b.id === id; })[0]; }
function cloud() { return Api.mode === 'cloud'; }
function me() { return cloud() ? Api.auth.me() : null; }
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
    if (e.code === 'auth') { authLost(); return; }
    if (!silent || !loaded) banner('Could not load bin data. ' + e.message, 'err', { id: 'retry', label: 'Try again' });
  });
}
function guard(p, what) {
  return p.catch(function (e) {
    if (e.code === 'auth') { authLost(); return; }
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
function binSVG(r, layer, withRoute) {
  var b = r.b, cls, txt;
  if (layer === 'cur') { cls = E.fillCls(b.cur); txt = Math.round(b.cur); }
  else if (layer === 'pred') { cls = E.fillCls(r.pred); txt = Math.round(r.pred); }
  else { cls = r.tier; txt = Math.round(r.score * 100); }
  var idx = withRoute && plan ? plan.route.indexOf(b.id) : -1;
  var dim = withRoute && plan && idx < 0 ? ' dim' : '';
  var isSel = sel === b.id;
  var tip = b.id + ' ' + b.name + ' · ' + Math.round(b.cur) + '% now · ' + Math.round(r.pred) + '% by morning · priority ' + Math.round(r.score * 100);
  return '<g class="bin' + dim + (isSel ? ' sel' : '') + '" data-id="' + esc(b.id) + '" tabindex="0" role="button" aria-label="' + esc(tip) + '" transform="translate(' + b.x + ',' + b.y + ')"><title>' + esc(tip) + '</title>'
    + (isSel ? '<circle class="halo" r="26"/>' : '') + '<circle class="fr" r="23"/>'
    + (layer === 'cur' ? '<circle class="fut" r="21" style="stroke:' + colorOf(E.fillCls(r.pred)) + '"/>' : '')
    + '<circle class="ring" r="16" style="stroke:' + colorOf(cls) + '"/><text class="val" y="4.5">' + txt + '</text><text class="bid" y="36">' + esc(b.id) + '</text>'
    + (idx >= 0 ? '<g class="stop' + (ticked()[b.id] ? ' done' : '') + '" data-stop="' + idx + '" transform="translate(16,-16)"><circle r="9"/><text y="3.5">' + (idx + 1) + '</text></g>' : '') + '</g>';
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
  $('#rMap').innerHTML = BASE + D.map(function (r) { return binSVG(r, lr, false); }).join('');
  setSeg('#rLayers', lr); $('#rLegend').innerHTML = legendHTML(lr); $('#rCap').innerHTML = capText(lr);
  var depot = '<g class="depot" transform="translate(80 560)"><rect x="-13" y="-13" width="26" height="26" rx="5"/><text y="4">D</text><text class="lbl" x="-13" y="28" style="text-anchor:start">DEPOT</text></g>';
  var truck = '<g id="truck" style="display:none"><rect x="-11" y="-8" width="22" height="16" rx="4" fill="var(--route)" stroke="var(--panel)" stroke-width="2.5"/><rect x="3" y="-5" width="6" height="7" rx="1" fill="var(--panel)"/></g>';
  $('#cMap').innerHTML = BASE + routeSVG() + depot + D.map(function (r) { return binSVG(r, lc, true); }).join('') + truck;
  setSeg('#cLayers', lc); $('#cLegend').innerHTML = legendHTML(lc); $('#cCap').innerHTML = capText(lc);
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
  if (cloud() && !Api.auth.session()) { l.textContent = 'Sign in to report'; r.textContent = 'Sign in as a collector'; return; }
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
  var h = '<div><p class="eyebrow">Report</p><h3 style="font-size:21px;margin-top:2px">What does the camera see?</h3></div>'
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
  var m = me();
  $('#modePill').hidden = cloud();
  $('#userChip').hidden = !m;
  if (m) { $('#userWho').textContent = m.email; $('#userRole').textContent = m.isCollector ? 'Collector' : 'Contributor'; }
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
  if (e.code === 'auth') { authLost(); return; }
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
  }, function (e) { planBusy = false; renderChrome(); if (e.code === 'auth') authLost(); else toast(e.message); });
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
    if (e.code === 'auth') authLost(); else toast(e.message);
  });
}
function playRoute() {
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

/* ------------------------------------------------------------------ sign in */
var dlg = $('#authDlg'), authMode = 'in', authResolve = null, authOk = false;
function authSet(mode) {
  authMode = mode;
  var up = mode === 'up', conf = mode === 'confirm';
  all('button', $('#authTabs')).forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-m') === (conf ? 'up' : mode) ? 'true' : 'false'); });
  $('#authTabs').hidden = conf;
  $('#authTitle').textContent = conf ? 'Check your email' : up ? 'Create account' : 'Sign in';
  $('#pwHint').hidden = !up;
  $('#authPw').autocomplete = up ? 'new-password' : 'current-password';
  $('#codeField').hidden = !conf; $('#authResend').hidden = !conf;
  $('#authEmail').readOnly = conf; $('#pwField').hidden = conf;
  $('#authGo').textContent = conf ? 'Confirm and sign in' : up ? 'Create account' : 'Sign in';
  authError('');
}
function authError(msg) { var el = $('#authErr'); el.hidden = !msg; el.textContent = msg || ''; }
function askAuth(side) {
  authSet('in'); $('#authPw').value = ''; $('#authCode').value = '';
  $('#authWhy').textContent = side === 'r'
    ? 'The collector console is for collection crews. Your account needs the collector role.'
    : 'An account lets us trace each photo to a reporter and keeps the bin data trustworthy.';
  var demo = Api.config && Api.config.demo;
  $('#authDemo').hidden = !demo;
  if (demo) {
    $('#authDemoBtns').innerHTML = demo.accounts.map(function (a, i) { return '<button type="button" class="btn" data-demo="' + i + '">' + esc(a.label) + '</button>'; }).join('');
  }
  authOk = false;
  return new Promise(function (resolve) { authResolve = resolve; dlg.showModal(); $('#authEmail').focus(); });
}
dlg.addEventListener('close', function () { if (authResolve) { var r = authResolve; authResolve = null; r(authOk); } });
$('#authClose').addEventListener('click', function () { dlg.close(); });
$('#authTabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) authSet(b.getAttribute('data-m')); });
function doSignIn(email, pw) {
  return Api.auth.signIn(email, pw).then(function () { authOk = true; delete $('#authPw').dataset.keep; dlg.close(); renderChrome(); }, function (e) {
    if (e.type === 'UserNotConfirmedException') { $('#authPw').dataset.keep = pw; Api.auth.resend(email).catch(function () {}); authSet('confirm'); authError('Enter the code we just emailed you.'); return; }
    authError(e.message);
  });
}
$('#authForm').addEventListener('submit', function (e) {
  e.preventDefault();
  var email = $('#authEmail').value.trim(), pw = $('#authPw').value, code = $('#authCode').value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) { authError('Enter a valid email address.'); return; }
  $('#authGo').disabled = true;
  var done = function () { $('#authGo').disabled = false; };
  if (authMode === 'confirm') {
    if (!code) { authError('Enter the confirmation code.'); done(); return; }
    Api.auth.confirm(email, code).then(function () { return doSignIn(email, $('#authPw').dataset.keep || ''); }, function (er) { authError(er.message); }).then(done);
    return;
  }
  if (pw.length < 8) { authError('Use at least 8 characters for the password.'); done(); return; }
  if (authMode === 'up') {
    Api.auth.signUp(email, pw).then(function () { $('#authPw').dataset.keep = pw; authSet('confirm'); }, function (er) { authError(er.message); }).then(done);
  } else doSignIn(email, pw).then(done);
});
$('#authResend').addEventListener('click', function () {
  Api.auth.resend($('#authEmail').value.trim()).then(function () { authError(''); toast('A new code is on its way.'); }, function (er) { authError(er.message); });
});
$('#authDemoBtns').addEventListener('click', function (e) {
  var b = e.target.closest('[data-demo]'); if (!b) return;
  var d = Api.config.demo, a = d.accounts[+b.getAttribute('data-demo')];
  doSignIn(a.email, d.password);
});
function signOut() {
  Api.auth.signOut(); loaded = false; bins = []; D = []; plan = null; lastResult = null;
  setOpen(null); renderChrome(); updateCovers();
}
$('#btnSignOut').addEventListener('click', signOut);
function authLost() { toast('Your session ended. Sign in again.'); signOut(); }

/* ------------------------------------------------------------------ gateway */
var gate = $('#gate'), conL = $('#conL'), conR = $('#conR'), covL = $('#covL'), covR = $('#covR'), backBtn = $('#btnBack');
function applyAccess(side) {
  var m = me(), deny = $('#denyR');
  if (side === 'r' && m && !m.isCollector) {
    deny.innerHTML = '<div><h2>Collector access only</h2><p>You are signed in as <b class="mono">' + esc(m.email) + '</b>. The collector console needs the collector role, which an administrator adds to an account. You can still report bins from the Community Contributor side.</p><div class="btns"><button class="btn primary" data-deny="report" style="background:var(--teal);color:var(--teal-ink)">Report a bin instead</button><button class="btn" data-deny="switch">Use another account</button></div></div>';
    deny.hidden = false;
  } else { deny.hidden = true; deny.innerHTML = ''; }
}
$('#denyR').addEventListener('click', function (e) {
  var b = e.target.closest('[data-deny]'); if (!b) return;
  if (b.getAttribute('data-deny') === 'report') { setOpen(null); setTimeout(function () { enter('l'); }, 60); }
  else { Api.auth.signOut(); setOpen(null); renderChrome(); setTimeout(function () { enter('r'); }, 60); }
});
function setOpen(side, instant) {
  if (side) gate.setAttribute('data-open', side); else gate.removeAttribute('data-open');
  conL.inert = side !== 'l'; conR.inert = side !== 'r';
  covL.inert = !!side; covR.inert = !!side; backBtn.inert = !side;
  $('#denyR').inert = side !== 'r';
  if (side) {
    applyAccess(side); renderChrome();
    (side === 'l' ? conL : conR).scrollTop = 0;
    if (!(side === 'r' && me() && !me().isCollector)) reload();
    setTimeout(function () { if (gate.getAttribute('data-open') === side) backBtn.focus({ preventScroll: true }); }, instant ? 0 : 950);
  }
  try { history.replaceState(null, '', side ? (side === 'l' ? '#reporter' : '#collector') : location.pathname + location.search); } catch (e) {}
}
function enter(side) {
  if (cloud() && !Api.auth.session()) { askAuth(side).then(function (ok) { if (ok) setOpen(side); }); return; }
  setOpen(side);
}
function wireCover(el, side) {
  el.addEventListener('click', function () { enter(side); });
  el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enter(side); } });
}
wireCover(covL, 'l'); wireCover(covR, 'r');
function leave() { var was = gate.getAttribute('data-open'); setOpen(null); (was === 'l' ? covL : covR).focus({ preventScroll: true }); }
backBtn.addEventListener('click', leave);
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && gate.hasAttribute('data-open') && !dlg.open) leave(); });
setInterval(function () {
  if (cloud() && gate.hasAttribute('data-open') && document.visibilityState === 'visible' && !busyMsg && !tuneBusy && !planBusy && Api.auth.session()) reload(true);
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
conL.inert = true; conR.inert = true; backBtn.inert = true; $('#denyR').inert = true;
Api.init().then(function () {
  renderTheme(); renderChrome(); updateCovers();
  if (!cloud()) { return reload().then(function () { routeFromHash(); }); }
  routeFromHash();
});
function routeFromHash() {
  var h = (location.hash || '').replace('#', '');
  var side = h === 'reporter' ? 'l' : h === 'collector' ? 'r' : null;
  if (!side) return;
  if (cloud() && !Api.auth.session()) return;
  setOpen(side, true);
}
window.__sw = { get state() { return { bins: bins, plan: plan, cfg: cfg, mode: Api.mode }; } };
})();
