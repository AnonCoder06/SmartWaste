// Runs the browser engine in Node on a set of scenarios and prints the results as JSON.
// backend/tests/test_parity.py compares this output with the Python port.
const E = require('../../frontend/engine.js');

const scenarios = [];
const configs = [
  ['default', E.DEFAULT_CONFIG],
  ['small truck', { H: 8, truckCap: 3000, lamPct: 40, wts: { pred: 50, cur: 20, time: 15, risk: 15 } }],
  ['urgent first', { H: 10, truckCap: 12000, lamPct: 100, wts: { pred: 30, cur: 30, time: 20, risk: 20 } }],
  ['shortest', { H: 5, truckCap: 7000, lamPct: 0, wts: { pred: 10, cur: 60, time: 10, risk: 20 } }],
];
for (const [name, cfg] of configs) {
  const bins = E.seedBins();
  scenarios.push({ name, cfg, bins });
}
// a reported scenario: two bins change after photo reports
{
  const bins = E.seedBins();
  const cfg = E.DEFAULT_CONFIG;
  [['B-05', 3], ['B-19', 2]].forEach(([id, lv]) => {
    const b = bins.find(x => x.id === id);
    Object.assign(b, E.applyLevel(b, lv, { cur: b.cur, rate: b.rate, rep: b.rep }));
  });
  scenarios.push({ name: 'after reports', cfg, bins });
}

const out = scenarios.map(s => {
  const rows = E.derive(s.bins, s.cfg);
  const plan = E.makePlan(rows, s.cfg);
  return {
    name: s.name, cfg: s.cfg, bins: s.bins,
    scores: rows.map(r => [r.b.id, r.pred, r.score, r.tier, r.load]),
    plan,
  };
});
process.stdout.write(JSON.stringify(out));
