import unittest

import helpers
from helpers import awsfake, call, store


class ApiTests(helpers.AwsCase):
    def test_state_returns_bins_config_and_no_plan(self):
        st, body = call("GET /api/state")
        self.assertEqual(st, 200)
        self.assertEqual(len(body["bins"]), 24)
        self.assertEqual(body["config"]["truckCap"], 7000)
        self.assertIsNone(body["plan"])
        self.assertNotIn("pk", body["bins"][0])

    def test_api_works_without_identity_context(self):
        st, body = call("PUT /api/config", body={"H": 6, "truckCap": 8000, "lamPct": 30,
                                                   "wts": {"pred": 40, "cur": 25, "time": 20, "risk": 15}})
        self.assertEqual(st, 200)
        self.assertEqual(body["truckCap"], 8000)
        st, plan = call("POST /api/plans", body={})
        self.assertEqual(st, 200)
        self.assertGreater(len(plan["route"]), 0)

    def test_unknown_route_and_bad_ids(self):
        self.assertEqual(call("GET /api/nope")[0], 404)
        self.assertEqual(call("POST /api/bins/{id}/reports", body={"level": 1}, path={"id": "x'; drop"})[0], 400)
        self.assertEqual(call("POST /api/bins/{id}/reports", body={"level": 1}, path={"id": "B-77"})[0], 404)

    def test_report_validation(self):
        for bad in (None, "2", 9, True, 1.5):
            st, _ = call("POST /api/bins/{id}/reports", body={"level": bad}, path={"id": "B-01"})
            self.assertEqual(st, 400, bad)
        st, body = call("POST /api/bins/{id}/reports", body={"level": 2, "source": "sample"}, path={"id": "B-01"})
        self.assertEqual(st, 200)
        self.assertEqual(body["source"], "Sample photo")

    def test_upload_flow(self):
        st, body = call("POST /api/bins/{id}/uploads", body={"contentType": "image/jpeg"}, path={"id": "B-01"})
        self.assertEqual(st, 200)
        self.assertTrue(body["post"]["fields"]["key"].startswith("uploads/B-01/"))
        self.assertEqual(body["post"]["fields"]["Content-Type"], "image/jpeg")
        rid = body["reportId"]
        st, rep = call("GET /api/reports/{id}", path={"id": rid})
        self.assertEqual((st, rep["status"]), (200, "pending"))
        # Report IDs are unguessable and the API has no account identity.
        self.assertEqual(call("GET /api/reports/{id}", path={"id": rid})[0], 200)
        self.assertEqual(call("POST /api/bins/{id}/uploads", body={"contentType": "text/html"}, path={"id": "B-01"})[0], 400)
        self.assertEqual(call("GET /api/reports/{id}", path={"id": "../etc"})[0], 404)

    def test_config_roundtrip_and_validation(self):
        good = {"H": 6, "truckCap": 9000, "lamPct": 10, "wts": {"pred": 40, "cur": 20, "time": 20, "risk": 20}}
        self.assertEqual(call("PUT /api/config", good)[0], 200)
        self.assertEqual(call("GET /api/state")[1]["config"], good)
        for bad in ({**good, "H": 99}, {**good, "truckCap": "lots"}, {**good, "wts": {"pred": 1}}, {}):
            self.assertEqual(call("PUT /api/config", bad)[0], 400, bad)

    def test_full_collection_cycle(self):
        st, plan = call("POST /api/plans", {})
        self.assertEqual(st, 200)
        self.assertGreater(len(plan["route"]), 5)
        self.assertEqual(plan["status"], "active")
        self.assertEqual(call("GET /api/state")[1]["plan"]["planId"], plan["planId"])
        self.assertEqual([e["DetailType"] for e in awsfake.STATE["events"]].count("PlanReady"), 1)

        first = plan["route"][0]
        self.assertEqual(call("POST /api/plans/latest/stops/{id}", {"done": True}, {"id": first})[0], 200)
        self.assertTrue(call("GET /api/state")[1]["plan"]["ticked"][first])
        self.assertEqual(call("POST /api/plans/latest/stops/{id}", {"done": True}, {"id": "B-19"})[0], 404)

        st, out = call("POST /api/plans/latest/complete", {})
        self.assertEqual((st, out["serviced"]), (200, len(plan["route"])))
        state = call("GET /api/state")[1]
        self.assertIsNone(state["plan"])
        serviced = {b["id"]: b for b in state["bins"]}[first]
        self.assertEqual((serviced["since"], serviced["rep"]), (0, 0))
        self.assertLess(serviced["cur"], 11)
        self.assertEqual(call("POST /api/plans/latest/complete", {})[0], 404)

    def test_plan_reflects_reports(self):
        _, p1 = call("POST /api/plans", {})
        call("POST /api/bins/{id}/reports", body={"level": 3}, path={"id": "B-05"})  # a quiet park bin overflows
        _, p2 = call("POST /api/plans", {})
        self.assertNotIn("B-05", p1["route"])
        self.assertIn("B-05", p2["route"])

    def test_reset_restores_seed(self):
        call("POST /api/bins/{id}/reports", body={"level": 3}, path={"id": "B-05"})
        call("POST /api/plans", {})
        self.assertEqual(call("POST /api/admin/reset", {})[0], 200)
        state = call("GET /api/state")[1]
        self.assertEqual({b["id"]: b for b in state["bins"]}["B-05"]["cur"], 20)
        self.assertIsNone(state["plan"])

    def test_planner_failure_is_a_502(self):
        store.table().items.clear()  # no bins at all is fine; break the workflow instead
        from smartwaste import planner
        original = planner.score
        planner.score = lambda *_: (_ for _ in ()).throw(RuntimeError("boom"))
        try:
            st, body = call("POST /api/plans", {})
        finally:
            planner.score = original
        self.assertEqual(st, 502)
        self.assertIn("planner failed", body["error"])

    def test_internal_errors_are_not_leaked(self):
        awsfake.STATE["table"].get_item = lambda **_: (_ for _ in ()).throw(RuntimeError("secret table detail"))
        st, body = call("GET /api/state")
        self.assertEqual(st, 500)
        self.assertNotIn("secret", body["error"])


if __name__ == "__main__":
    unittest.main()
