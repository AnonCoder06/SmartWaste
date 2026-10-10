import unittest

import helpers
from helpers import awsfake, store
from smartwaste import reports
from smartwaste.model import LEVELS


class ReportTests(helpers.AwsCase):
    def test_report_updates_bin_and_stores_report(self):
        before = store.get_bin("B-05")
        rep = reports.apply_report("B-05", 3, 0.9, "Sample photo", "u1")
        after = store.get_bin("B-05")
        self.assertEqual(after["cur"], LEVELS[3]["v"])
        self.assertEqual(after["rep"], before["rep"] + 1)
        self.assertEqual(after["version"], before["version"] + 1)
        self.assertEqual(after["lastReport"], rep["id"])
        self.assertIsNotNone(store.get_report(rep["id"]))
        self.assertGreater(rep["after"]["pred"], rep["before"]["pred"])

    def test_correction_replaces_instead_of_stacking(self):
        b0 = store.get_bin("B-05")
        first = reports.apply_report("B-05", 3, 0.7, "Photo upload", "u1")
        fixed = reports.apply_report("B-05", 1, 1.0, "Correction", "u1", replaces=first["id"])
        direct = reports.apply_report("B-19", 1, 1.0, "Manual report", "u1")  # unrelated bin, direct path
        b = store.get_bin("B-05")
        self.assertEqual(b["cur"], 45)
        self.assertEqual(b["rep"], b0["rep"])            # the wrong "overflowing" report no longer counts
        self.assertEqual(fixed["before"], first["before"])  # before/after still compares with the original state
        self.assertNotEqual(direct["binId"], "B-05")

    def test_replaces_ignored_when_another_report_came_in_between(self):
        first = reports.apply_report("B-05", 3, 1, "Manual report", "u1")
        reports.apply_report("B-05", 2, 1, "Manual report", "u2")
        reports.apply_report("B-05", 1, 1, "Correction", "u1", replaces=first["id"])
        self.assertEqual(store.get_bin("B-05")["cur"], 45)
        self.assertEqual(store.get_bin("B-05")["rep"], 1 + 1)  # seed 0 + two level>=2 reports; correction adds none

    def test_overflow_event_only_on_transition(self):
        reports.apply_report("B-05", 3, 1, "Manual report", "u1")
        kinds = [e["DetailType"] for e in awsfake.STATE["events"]]
        self.assertEqual(kinds.count("OverflowRisk"), 1)
        reports.apply_report("B-05", 3, 1, "Manual report", "u2")
        kinds = [e["DetailType"] for e in awsfake.STATE["events"]]
        self.assertEqual(kinds.count("OverflowRisk"), 1)

    def test_retries_after_version_conflict(self):
        awsfake.STATE["fail_next_updates"] = 2
        reports.apply_report("B-05", 2, 1, "Manual report", "u1")
        self.assertEqual(store.get_bin("B-05")["cur"], 78)

    def test_gives_up_after_repeated_conflicts(self):
        awsfake.STATE["fail_next_updates"] = 9
        with self.assertRaises(reports.Conflict):
            reports.apply_report("B-05", 2, 1, "Manual report", "u1")

    def test_bad_inputs(self):
        with self.assertRaises(ValueError):
            reports.apply_report("B-05", 7, 1, "x", "u")
        with self.assertRaises(reports.NotFound):
            reports.apply_report("B-99", 1, 1, "x", "u")


if __name__ == "__main__":
    unittest.main()
