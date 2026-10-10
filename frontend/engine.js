/* SmartWaste engine: prediction model, route planner and photo heuristic.
   Used by the browser in two ways: to draw derived values (forecast, priority score) from raw
   bin data, and as the whole backend in offline demo mode. The Lambda code in
   backend/src/smartwaste/{model,routing}.py is a port of this file; backend/tests/test_parity.py
   keeps them identical. Change one, change the other. */
(function (root) {
'use strict';
var E = {};
E.GRID = 80;
E.KM = 1.875 / 1000;
E.DEPOT = { id: 'DEPOT', x: 80, y: 560, lon: 85.79385141, lat: 20.27105111, w: 0 };
E.DEFAULT_CONFIG = { H: 8, truckCap: 7000, lamPct: 40, wts: { pred: 50, cur: 20, time: 15, risk: 15 } };
E.LEVELS = [{ n: 'Low', v: 15 }, { n: 'Medium', v: 45 }, { n: 'Nearly full', v: 78 }, { n: 'Overflowing', v: 105 }];
// Mo Bus stop coordinates from BhubaneswarOne's UpdatedBusStops ArcGIS layer
// (Bus_Stops, service tagged "mobus"). Keep this data in sync with backend/model.py.
// https://bhubaneswarone.in/arcgis/rest/services/BhubaneswarOne/UpdatedBusStops/MapServer/3
E.SPEC = [
['B-01','Jaydev Vihar',2,1,660,40,1.2,20,0,85.82429129,20.29459375],['B-02','Aacharya Vihar Square',4,1,660,55,1.8,30,1,85.83249756,20.29676224],
['B-03','Vani Vihar Square',7,1,1100,82,2.2,36,2,85.84290691,20.29642195],['B-04','Master Canteen',10,1,240,35,0.9,18,0,85.84038997,20.26689536],
['B-05','Rasulgarh Square',3,2,240,20,0.6,12,0,85.85717592,20.29431609],['B-06','Satya Nagar Square',6,2,660,66,1.5,28,1,85.84362874,20.27968040],
['B-07','Bomikhal',11,2,1100,48,2.6,24,0,85.85759609,20.28742953],['B-08','Rajmahal Square',5,3,660,72,2.4,40,2,85.83628897,20.26069145],
['B-09','AG Square',8,3,240,30,0.8,14,0,85.82893453,20.26682667],['B-10','Kalpana Square',12,3,1100,90,1.0,44,3,85.84173369,20.25871046],
['B-11','Shishu Bhawan',3,4,660,58,0.7,26,0,85.83252832,20.25596667],['B-12','Unit 8 Square',10,4,660,75,0.9,30,1,85.81699794,20.27585624],
['B-13','Fire Station Square',2,5,660,44,1.1,22,0,85.79864937,20.27914711],['B-14','Capital Hospital',6,5,1100,70,3.0,24,1,85.82434309,20.25971552],
['B-15','Iskcon Temple',8,5,660,25,0.5,10,0,85.81398375,20.28897098],['B-16','Satsang Vihar',11,5,660,52,2.0,32,0,85.84609095,20.29563748],
['B-17','VSS Nagar Market',4,6,1100,78,3.1,38,2,85.84641562,20.31054214],['B-18','Nayapalli',7,6,660,38,1.4,20,0,85.81110606,20.28673681],
['B-19','Khandagiri Square',12,6,240,15,0.4,8,0,85.78899412,20.25847954],['B-20','Bhubaneswar Club',3,7,660,62,1.7,26,1,85.82791188,20.26783797],
['B-21','OUAT Square',6,7,660,85,0.8,42,1,85.81007218,20.26798698],['B-22','Laxmi Sagar',9,7,660,28,1.0,16,0,85.84886868,20.26881588],
['B-23','BJB College',11,7,660,61,1.9,30,0,85.84118891,20.25339626],['B-24','Power House Square',5,4,240,33,1.3,18,0,85.82537280,20.27351130]
];

var clamp = E.clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
var man = function (a, b) { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); };

E.seedBins = function () {
  return E.SPEC.map(function (s) {
    return { id: s[0], name: s[1], x: s[2] * E.GRID, y: s[3] * E.GRID, cap: s[4], cur: s[5], rate: s[6], since: s[7], rep: s[8], lon: s[9], lat: s[10] };
  });
};

/* ---------- model ---------- */
var predOf = E.predOf = function (b, c) { return b.cur + b.rate * c.H; };
function riskOf(b, c) { return clamp(0.25 * b.rep + (predOf(b, c) > 100 ? 0.4 : 0) + (b.rate > 2.5 ? 0.15 : 0), 0, 1); }
E.factors = function (b, c) {
  return { pred: clamp(predOf(b, c) / 100, 0, 1.25), cur: clamp(b.cur / 100, 0, 1.25), time: clamp(b.since / 48, 0, 1), risk: riskOf(b, c) };
};
E.normW = function (c) {
  var w = c.wts, s = (w.pred + w.cur + w.time + w.risk) || 1;
  return { pred: w.pred / s, cur: w.cur / s, time: w.time / s, risk: w.risk / s };
};
function scoreOf(b, c) {
  var f = E.factors(b, c), w = E.normW(c);
  return clamp(w.pred * f.pred + w.cur * f.cur + w.time * f.time + w.risk * f.risk, 0, 1);
}
E.fillCls = function (v) { return v < 35 ? 'low' : v < 65 ? 'med' : v < 90 ? 'high' : 'crit'; };
E.tierOf = function (s) { return s >= 0.85 ? 'crit' : s >= 0.70 ? 'high' : s >= 0.50 ? 'med' : 'low'; };
E.derive = function (bins, c) {
  return bins.map(function (b) {
    var p = predOf(b, c), s = scoreOf(b, c);
    return { b: b, pred: p, score: s, tier: E.tierOf(s), load: clamp(p, 0, 100) / 100 * b.cap };
  });
};
E.applyLevel = function (b, i, prev) {
  var cur = E.LEVELS[i].v;
  return { cur: cur, rate: clamp(0.6 * prev.rate + 0.4 * (cur / Math.max(b.since, 6)), 0.2, 4), rep: prev.rep + (i >= 2 ? 1 : 0) };
};

/* ---------- routing ---------- */
function cost(o, l) { var t = 0, p = E.DEPOT, pen = 0; for (var i = 0; i < o.length; i++) { t += man(p, o[i]); pen += o[i].w * t; p = o[i]; } t += man(p, E.DEPOT); return t + l * pen; }
function dist(o) { var t = 0, p = E.DEPOT; for (var i = 0; i < o.length; i++) { t += man(p, o[i]); p = o[i]; } return t + man(p, E.DEPOT); }
function improve(o, l) {
  var best = cost(o, l), imp = true, guard = 0;
  while (imp && guard++ < 60) {
    imp = false;
    for (var i = 0; i < o.length - 1; i++) { for (var j = i + 1; j < o.length; j++) {
      var c = o.slice(0, i).concat(o.slice(i, j + 1).reverse(), o.slice(j + 1)), cc = cost(c, l);
      if (cc < best - 1e-6) { o = c; best = cc; imp = true; }
    } }
    for (var a = 0; a < o.length; a++) {
      var n = o[a], rest = o.slice(0, a).concat(o.slice(a + 1));
      for (var k = 0; k <= rest.length; k++) {
        if (k === a) continue;
        var c2 = rest.slice(0, k).concat([n], rest.slice(k)), c3 = cost(c2, l);
        if (c3 < best - 1e-6) { o = c2; best = c3; imp = true; break; }
      }
    }
  }
  return o;
}
function solve(nodes, l) {
  if (nodes.length < 2) return nodes.slice();
  var rem = nodes.slice(), cur = E.DEPOT, nn = [];
  while (rem.length) { var bi = 0, bd = 1e9; for (var i = 0; i < rem.length; i++) { var d = man(cur, rem[i]); if (d < bd) { bd = d; bi = i; } } cur = rem.splice(bi, 1)[0]; nn.push(cur); }
  var byW = nodes.slice().sort(function (a, b) { return b.w - a.w; });
  var A = improve(nn, l), B = improve(byW, l);
  return cost(A, l) <= cost(B, l) ? A : B;
}
E.makePlan = function (rows, c) {
  var order = rows.slice().sort(function (a, b) { return b.score - a.score; });
  var load = 0, chosen = [], deferred = [];
  order.forEach(function (r) {
    if (r.tier === 'low') return;
    if (load + r.load <= c.truckCap) { chosen.push(r); load += r.load; } else deferred.push(r.b.id);
  });
  var lam = c.lamPct / 100 * 0.15;
  var nodes = chosen.map(function (r) { return { id: r.b.id, x: r.b.x, y: r.b.y, w: r.score }; });
  var route = solve(nodes, lam);
  var all = rows.map(function (r) { return { id: r.b.id, x: r.b.x, y: r.b.y, w: r.score }; });
  var base = dist(solve(all, 0));
  var d = route.length ? dist(route) : 0;
  var cum = [], t = 0, p = E.DEPOT; route.forEach(function (n) { t += man(p, n); cum.push(t); p = n; });
  var ids = route.map(function (n) { return n.id; });
  var urgent = rows.filter(function (r) { return r.pred >= 90; });
  var urgentC = urgent.filter(function (r) { return ids.indexOf(r.b.id) >= 0; });
  var hp = rows.filter(function (r) { return r.tier === 'crit' || r.tier === 'high'; });
  var hpC = hp.filter(function (r) { return ids.indexOf(r.b.id) >= 0; });
  var km = d * E.KM;
  return { route: ids, cum: cum, km: km, baseKm: base * E.KM, deferred: deferred, load: load,
    urgentN: urgent.length, urgentC: urgentC.length, hpN: hp.length, hpC: hpC.length, timeMin: km / 18 * 60 + ids.length * 3 };
};

/* ---------- photo heuristic (offline demo mode; the cloud analyzer uses the same idea) ---------- */
E.heuristic = function (img) {
  var c = document.createElement('canvas'); c.width = c.height = 64;
  var cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(img, 0, 0, 64, 64);
  var d = cx.getImageData(0, 0, 64, 64).data, g = new Float32Array(4096), i;
  for (i = 0; i < 4096; i++) g[i] = (0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2]) / 255;
  var edges = 0, n = 0;
  for (var y = 1; y < 40; y++) for (var x = 1; x < 63; x++) {
    var gx = g[y * 64 + x + 1] - g[y * 64 + x - 1], gy = g[(y + 1) * 64 + x] - g[(y - 1) * 64 + x];
    if (Math.sqrt(gx * gx + gy * gy) > 0.18) edges++; n++;
  }
  var dn = edges / n, th = [0.05, 0.12, 0.2], lv = dn < th[0] ? 0 : dn < th[1] ? 1 : dn < th[2] ? 2 : 3;
  var gap = Math.min.apply(null, th.map(function (t) { return Math.abs(dn - t); }));
  return { lv: lv, conf: clamp(0.55 + gap * 3, 0.55, 0.86) };
};

/* ---------- sample photos drawn on a canvas ---------- */
function rng(s) { return function () { s |= 0; s = s + 0x6D2B79F5 | 0; var t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
E.sampleImage = function (level) {
  var cv = document.createElement('canvas'); cv.width = 120; cv.height = 84;
  var x = cv.getContext('2d'), w = 120, h = 84, r = rng(level * 97 + 11);
  x.fillStyle = '#b9c4c0'; x.fillRect(0, 0, w, h * 0.7); x.fillStyle = '#8c948d'; x.fillRect(0, h * 0.7, w, h * 0.3);
  var bw = 48, bh = 46, bx = (w - bw) / 2, by = 26, fill = [0.14, 0.48, 0.82, 1.1][level];
  var top = by + bh * (1 - Math.min(fill, 1)) - (fill > 1 ? 14 : 0);
  x.fillStyle = '#e4e9e6'; x.fillRect(bx, by, bw, bh);
  var cols = ['#2b2f33', '#e8e2d0', '#c0553a', '#4c7a9c', '#8a9a5b', '#6b5b4a'];
  for (var i = 0; i < (fill > 1 ? 90 : 60); i++) {
    var px = bx + 3 + r() * (bw - 6), py = top + r() * (by + bh - top), rad = 3 + r() * 4;
    x.fillStyle = cols[Math.floor(r() * cols.length)]; x.beginPath(); x.arc(px, py, rad, 0, 6.283); x.fill();
  }
  if (fill > 1) { for (var k = 0; k < 14; k++) { var sx = (r() < 0.5 ? bx - 8 - r() * 14 : bx + bw + r() * 14), sy = by + bh - 4 - r() * 6; x.fillStyle = cols[Math.floor(r() * cols.length)]; x.beginPath(); x.arc(sx, sy, 3 + r() * 3, 0, 6.283); x.fill(); } }
  x.strokeStyle = '#2f5d4d'; x.lineWidth = 4; x.beginPath(); x.moveTo(bx, by - 2); x.lineTo(bx, by + bh); x.lineTo(bx + bw, by + bh); x.lineTo(bx + bw, by - 2); x.stroke();
  return cv.toDataURL('image/png');
};

root.SWEngine = E;
if (typeof module !== 'undefined' && module.exports) module.exports = E;
})(typeof self !== 'undefined' ? self : this);
