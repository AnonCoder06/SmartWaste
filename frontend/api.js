/* SmartWaste data layer. Two interchangeable backends behind one interface:

     cloud  config.json says mode "cloud": the API behind CloudFront (/api/*),
            photos go straight to S3 with a presigned POST and the analyzer Lambda answers by polling.
     local  no config.json (or mode "local"): the engine in engine.js runs in the browser and
            data lives in memory. Used for development and as a fallback demo.

   Backend interface (all async):
     state() -> { bins, config, plan }       report(binId, level, {source, replaces}) -> report
     photo(binId, file, onStatus) -> report  saveConfig(cfg)   runPlan() -> plan
     setStop(binId, done)                    complete()        reset()                              */
(function (root) {
'use strict';
var E = root.SWEngine;
var Api = { mode: 'local', config: null, backend: null };

function ApiError(status, message, extra) { var e = new Error(message); e.status = status; e.extra = extra; e.code = 'api'; return e; }
var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

/* ------------------------------------------------------------------ cloud backend */
function shrink(file) {
  return new Promise(function (resolve, reject) {
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      var max = 1280, k = Math.min(1, max / Math.max(img.width, img.height));
      var c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(function (b) { b ? resolve(b) : reject(new Error('That file could not be read as an image.')); }, 'image/jpeg', 0.85);
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That file could not be read as an image.')); };
    img.src = url;
  });
}
function makeCloud(conf) {
  var base = conf.apiBase || '/api';
  function call(method, path, body) {
    return fetch(base + path, {
      method: method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw ApiError(r.status, j.error || ('Request failed (' + r.status + ')'));
        return j;
      });
    }, function () { throw new Error('Cannot reach SmartWaste. Check your connection.'); });
  }
  return {
    state: function () { return call('GET', '/state'); },
    report: function (id, level, o) { o = o || {}; return call('POST', '/bins/' + id + '/reports', { level: level, source: o.source, replaces: o.replaces }); },
    photo: function (id, file, onStatus) {
      onStatus && onStatus('Preparing photo…');
      return shrink(file).then(function (blob) {
        return call('POST', '/bins/' + id + '/uploads', { contentType: 'image/jpeg' }).then(function (up) {
          var fd = new FormData();
          Object.keys(up.post.fields).forEach(function (k) { fd.append(k, up.post.fields[k]); });
          fd.append('file', blob);
          onStatus && onStatus('Uploading…');
          return fetch(up.post.url, { method: 'POST', body: fd }).then(function (r) {
            if (!r.ok) throw new Error('The upload was refused (' + r.status + '). Try a smaller photo.');
            onStatus && onStatus('Analyzing the photo…');
            return poll(up.reportId, 0);
          });
        });
      });
    },
    saveConfig: function (cfg) { return call('PUT', '/config', cfg); },
    runPlan: function () { return call('POST', '/plans', {}); },
    setStop: function (id, done) { return call('POST', '/plans/latest/stops/' + id, { done: done }); },
    complete: function () { return call('POST', '/plans/latest/complete', {}); },
    reset: function () { return call('POST', '/admin/reset', {}); }
  };
  function poll(rid, n) {
    if (n > 40) throw new Error('The analysis is taking longer than usual. Choose a fill level by hand, or try again.');
    return sleep(n < 4 ? 700 : 1500).then(function () { return call('GET', '/reports/' + rid); }).then(function (rep) {
      if (rep.status === 'done') return rep;
      if (rep.status === 'rejected' || rep.status === 'error') { var e = new Error(rep.reason || 'The photo could not be analyzed.'); e.code = 'rejected'; throw e; }
      return poll(rid, n + 1);
    });
  }
}

/* ------------------------------------------------------------------ local backend (offline demo) */
function makeLocal() {
  var L;
  function init() { L = { bins: E.seedBins(), cfg: JSON.parse(JSON.stringify(E.DEFAULT_CONFIG)), plan: null, reports: {}, n: 0 }; }
  init();
  var rid = function () { L.n++; return 'local' + L.n; };
  function find(id) { return L.bins.filter(function (b) { return b.id === id; })[0]; }
  function snap(b) { return { cur: b.cur, rate: b.rate, rep: b.rep }; }
  function view(r) { return { pred: r.pred, score: r.score }; }
  function report(id, level, o) {
    o = o || {};
    var b = find(id), cfg = L.cfg;
    var prev = snap(b), before = view(E.derive([b], cfg)[0]);
    if (o.replaces && b.lastReport === o.replaces) { var e = L.reports[o.replaces]; if (e && e.binId === id) { prev = e.prev; before = e.before; } }
    Object.assign(b, E.applyLevel(b, level, prev));
    var after = view(E.derive([b], cfg)[0]), r = { id: rid(), binId: id, level: level, conf: o.conf || 1, prev: prev, before: before, after: after, source: o.source || 'Manual report' };
    b.lastReport = r.id; L.reports[r.id] = r;
    return r;
  }
  return {
    state: function () { return Promise.resolve(JSON.parse(JSON.stringify({ bins: L.bins, config: L.cfg, plan: L.plan }))); },
    report: function (id, level, o) {
      var src = { sample: 'Sample photo', correction: 'Correction' }[(o || {}).source] || 'Manual report';
      return Promise.resolve(report(id, level, { source: src, replaces: (o || {}).replaces }));
    },
    photo: function (id, file, onStatus) {
      onStatus && onStatus('Analyzing the photo…');
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file), img = new Image();
        img.onload = function () { var h = E.heuristic(img); setTimeout(function () { resolve(report(id, h.lv, { source: 'Photo upload', conf: h.conf })); }, 650); };
        img.onerror = function () { reject(new Error('That file could not be read as an image.')); };
        img.src = url;
      });
    },
    saveConfig: function (cfg) { L.cfg = cfg; return Promise.resolve(cfg); },
    runPlan: function () {
      var rows = E.derive(L.bins, L.cfg), p = E.makePlan(rows, L.cfg);
      p.planId = 'local-' + Date.now(); p.createdAt = new Date().toISOString(); p.status = 'active'; p.ticked = {};
      L.plan = p; return Promise.resolve(JSON.parse(JSON.stringify(p)));
    },
    setStop: function (id, done) { if (L.plan) L.plan.ticked[id] = done; return Promise.resolve({}); },
    complete: function () {
      var stops = L.plan ? L.plan.route : [], k = 0;
      L.bins.forEach(function (b) {
        if (stops.indexOf(b.id) >= 0) { b.cur = 4 + (k++ * 3) % 7; b.since = 0; b.rep = 0; } else b.since += 10;
        delete b.lastReport;
      });
      L.plan = null; L.reports = {};
      return Promise.resolve({ serviced: stops.length });
    },
    reset: function () { init(); return Promise.resolve({}); }
  };
}

/* ------------------------------------------------------------------ boot */
Api.init = function () {
  return fetch('config.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; })
    .catch(function () { return null; })
    .then(function (conf) {
      if (conf && conf.mode === 'cloud') {
        Api.mode = 'cloud'; Api.config = conf; Api.backend = makeCloud(conf);
      } else {
        Api.mode = 'local'; Api.config = conf || {}; Api.backend = makeLocal();
      }
      return Api;
    });
};
root.SWApi = Api;
})(self);
