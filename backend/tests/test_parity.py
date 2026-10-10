"""The Python model and planner must give the same answers as frontend/engine.js."""
import shutil
import subprocess
import unittest

import helpers  # noqa: F401
from smartwaste.model import derive
from smartwaste.routing import make_plan


class Parity(unittest.TestCase):
    def test_scenarios_match(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed")
        import json
        out = subprocess.run([node, str(helpers.HERE / "gen_js_fixture.js")], check=True, capture_output=True, text=True).stdout
        results = json.loads(out)
        self.assertEqual(len(results), 5)
        for sc in results:
            rows = derive(sc["bins"], sc["cfg"])
            for r, (bid, pred, score, tier, load) in zip(rows, sc["scores"]):
                self.assertEqual(r["b"]["id"], bid)
                self.assertAlmostEqual(r["pred"], pred, places=9)
                self.assertAlmostEqual(r["score"], score, places=9)
                self.assertEqual(r["tier"], tier, (sc["name"], bid))
                self.assertAlmostEqual(r["load"], load, places=9)
            py, js = make_plan(rows, sc["cfg"]), sc["plan"]
            self.assertEqual(py["route"], js["route"], sc["name"])
            self.assertEqual(py["deferred"], js["deferred"], sc["name"])
            for k in ("km", "baseKm", "load", "timeMin"):
                self.assertAlmostEqual(py[k], js[k], places=6, msg=(sc["name"], k))
            for k in ("urgentN", "urgentC", "hpN", "hpC"):
                self.assertEqual(py[k], js[k], (sc["name"], k))
            for a, b in zip(py["cum"], js["cum"]):
                self.assertAlmostEqual(a, b, places=6)
            self.assertTrue(len(py["route"]) > 0, sc["name"])


if __name__ == "__main__":
    unittest.main()
