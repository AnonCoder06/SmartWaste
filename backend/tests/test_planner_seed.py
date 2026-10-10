import json
import unittest

import helpers
from helpers import awsfake, store
from smartwaste import planner, seed
from smartwaste.model import derive, seed_bins, DEFAULT_CONFIG, validate_config, fill_cls, tier_of
from smartwaste.routing import make_plan


class PlannerTests(helpers.AwsCase):
    def test_state_machine_steps_match_one_shot_planner(self):
        out = awsfake.StepFunctions().start_sync_execution("arn", json.dumps({"trigger": "api", "by": "me"}))
        self.assertEqual(out["status"], "SUCCEEDED")
        plan = json.loads(out["output"])
        ref = make_plan(derive(seed_bins(), DEFAULT_CONFIG), DEFAULT_CONFIG)
        self.assertEqual(plan["route"], ref["route"])
        self.assertAlmostEqual(plan["km"], ref["km"], places=9)
        self.assertEqual(plan["by"], "me")
        self.assertEqual(store.get_plan()["planId"], plan["planId"])

    def test_nothing_to_collect_still_produces_a_plan(self):
        bins = [{**b, "cur": 5, "rate": 0.2, "since": 1, "rep": 0, "version": 0} for b in seed_bins()]
        store.put_bins(bins)
        plan = json.loads(awsfake.StepFunctions().start_sync_execution("arn", "{}")["output"])
        self.assertEqual((plan["route"], plan["km"], plan["load"]), ([], 0, 0))

    def test_small_truck_defers_bins(self):
        store.set_config({**DEFAULT_CONFIG, "truckCap": 3000})
        plan = json.loads(awsfake.StepFunctions().start_sync_execution("arn", "{}")["output"])
        self.assertTrue(plan["deferred"])
        self.assertLessEqual(plan["load"], 3000)


class SeedTests(helpers.AwsCase):
    def test_seed_is_idempotent_unless_forced(self):
        store.update_bin("B-01", {"cur": 99, "rate": 1, "rep": 0}, 0, "r")
        self.assertEqual(seed.handler({}, None)["seeded"], False)
        self.assertEqual(store.get_bin("B-01")["cur"], 99)
        self.assertEqual(seed.handler({"force": True}, None)["seeded"], True)
        self.assertEqual(store.get_bin("B-01")["cur"], 40)

    def test_demo_users_only_when_password_set(self):
        import os
        self.assertEqual(seed.handler({}, None)["demoUsers"], [])
        os.environ.update(USER_POOL_ID="pool", DEMO_PASSWORD="Demo-pass-1")
        try:
            out = seed.handler({}, None)
            self.assertEqual(len(out["demoUsers"]), 2)
            self.assertEqual(awsfake.STATE["groups"], {"demo.collector@smartwaste.example": ["collectors"]})
            seed.handler({}, None)  # second deploy: users exist, no error
        finally:
            del os.environ["USER_POOL_ID"], os.environ["DEMO_PASSWORD"]


class ModelTests(unittest.TestCase):
    def test_classes(self):
        self.assertEqual([fill_cls(v) for v in (0, 34.9, 35, 64.9, 65, 89.9, 90, 120)],
                         ["low", "low", "med", "med", "high", "high", "crit", "crit"])
        self.assertEqual([tier_of(v) for v in (0.49, 0.5, 0.7, 0.85)], ["low", "med", "high", "crit"])

    def test_validate_config_rejects_out_of_range(self):
        self.assertEqual(validate_config(DEFAULT_CONFIG), DEFAULT_CONFIG)
        with self.assertRaises(ValueError):
            validate_config({**DEFAULT_CONFIG, "H": 3})
        with self.assertRaises(ValueError):
            validate_config({**DEFAULT_CONFIG, "wts": {"pred": 101, "cur": 0, "time": 0, "risk": 0}})


if __name__ == "__main__":
    unittest.main()
