import json
import unittest

import helpers
from helpers import awsfake, call, photo, s3_event_for, store
from smartwaste import analyzer


def new_upload(bin_id="B-01"):
    st, body = call("POST /api/bins/{id}/uploads", body={"contentType": "image/png"}, path={"id": bin_id})
    assert st == 200
    return body["reportId"], body["post"]["fields"]["key"]


def put_photo(key, kind):
    awsfake.STATE["s3"][("up", key)] = (photo(kind), "image/png")


class AnalyzerTests(helpers.AwsCase):
    def run_event(self, key, count=1):
        return analyzer.handler(s3_event_for(key, count), None)

    def test_edge_level_separates_flat_from_busy(self):
        lo, _ = analyzer.edge_level(photo("flat"))
        hi, conf = analyzer.edge_level(photo("busy"))
        self.assertEqual((lo, hi), (0, 3))
        self.assertTrue(0.55 <= conf <= 0.86)

    def test_photo_updates_bin(self):
        rid, key = new_upload("B-05")
        put_photo(key, "busy")
        self.assertEqual(self.run_event(key), {"batchItemFailures": []})
        rep = store.get_report(rid)
        self.assertEqual((rep["status"], rep["level"], rep["source"]), ("done", 3, "Photo upload"))
        self.assertEqual(rep["model"], "edge-heuristic")
        self.assertEqual(store.get_bin("B-05")["cur"], 105)
        st, polled = call("GET /api/reports/{id}", path={"id": rid})
        self.assertEqual((st, polled["status"], polled["level"]), (200, "done", 3))
        self.assertIn("Trash", polled["labels"])

    def test_non_bin_photo_is_rejected_without_touching_the_bin(self):
        awsfake.STATE["rek_labels"] = ["Person", "Selfie"]
        rid, key = new_upload("B-05")
        put_photo(key, "busy")
        self.run_event(key)
        rep = store.get_report(rid)
        self.assertEqual(rep["status"], "rejected")
        self.assertIn("does not look like a bin", rep["reason"])
        self.assertEqual(store.get_bin("B-05")["cur"], 20)

    def test_rekognition_outage_does_not_block_reports(self):
        awsfake.STATE["rek_error"] = True
        rid, key = new_upload("B-05")
        put_photo(key, "flat")
        self.run_event(key)
        self.assertEqual(store.get_report(rid)["status"], "done")

    def test_duplicate_delivery_is_applied_once(self):
        rid, key = new_upload("B-05")
        put_photo(key, "busy")
        self.run_event(key)
        v = store.get_bin("B-05")["version"]
        self.run_event(key)
        self.assertEqual(store.get_bin("B-05")["version"], v)

    def test_failure_retries_then_marks_error_on_last_attempt(self):
        rid, key = new_upload("B-05")  # object never uploaded to S3
        out = self.run_event(key, count=1)
        self.assertEqual(out["batchItemFailures"], [{"itemIdentifier": "m1"}])
        self.assertEqual(store.get_report(rid)["status"], "pending")  # released for the retry
        out = self.run_event(key, count=3)
        self.assertEqual(out["batchItemFailures"], [{"itemIdentifier": "m1"}])
        rep = store.get_report(rid)
        self.assertEqual(rep["status"], "error")
        self.assertIn("by hand", rep["reason"])

    def test_sagemaker_used_when_configured_and_falls_back_on_error(self):
        import os
        os.environ["SAGEMAKER_ENDPOINT"] = "ep"
        try:
            awsfake.STATE["sm_response"] = {"level": 2, "confidence": 0.91}
            rid, key = new_upload("B-05")
            put_photo(key, "flat")
            self.run_event(key)
            rep = store.get_report(rid)
            self.assertEqual((rep["level"], rep["model"]), (2, "sagemaker"))

            awsfake.STATE["sm_error"] = True
            rid2, key2 = new_upload("B-19")
            put_photo(key2, "flat")
            self.run_event(key2)
            rep2 = store.get_report(rid2)
            self.assertEqual((rep2["level"], rep2["model"]), (0, "edge-heuristic"))
        finally:
            del os.environ["SAGEMAKER_ENDPOINT"]

    def test_ignores_test_events_and_foreign_keys(self):
        ev = {"Records": [{"messageId": "a", "body": json.dumps({"Event": "s3:TestEvent"})},
                          {"messageId": "b", "body": json.dumps(
                              {"Records": [{"s3": {"bucket": {"name": "up"}, "object": {"key": "other/x"}}}]})}]}
        self.assertEqual(analyzer.handler(ev, None), {"batchItemFailures": []})


if __name__ == "__main__":
    unittest.main()
