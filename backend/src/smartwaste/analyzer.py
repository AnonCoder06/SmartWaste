"""Photo analyzer. S3 upload -> SQS -> this Lambda.

Two signals:
  1. Fill level: edge density on a 64x64 greyscale thumbnail (the same heuristic the
     browser prototype used). If SAGEMAKER_ENDPOINT is set, that endpoint is asked first
     and the heuristic is the fallback.
  2. Rekognition labels, to turn away photos that are not a bin or litter at all.

The Lambda needs Pillow, which ships as a layer built by scripts/build-layer.sh.
"""
from __future__ import annotations

import io
import json
import os
import time
import urllib.parse
from functools import lru_cache

import boto3

from . import events, reports, store
from .model import clamp

MAX_RECEIVES = int(os.environ.get("MAX_RECEIVES", "3"))  # matches the queue redrive policy
THRESH = [0.05, 0.12, 0.2]
WASTE_LABELS = {
    "trash", "garbage", "litter", "waste", "rubbish", "dumpster", "recycling", "trash can", "bin",
    "plastic bag", "landfill", "junk", "pollution", "tin", "can", "bag", "plastic",
}


@lru_cache(maxsize=1)
def _s3():
    return boto3.client("s3")


@lru_cache(maxsize=1)
def _rek():
    return boto3.client("rekognition")


@lru_cache(maxsize=1)
def _smr():
    return boto3.client("sagemaker-runtime")


def reset_clients() -> None:
    for fn in (_s3, _rek, _smr):
        fn.cache_clear()


def edge_level(data: bytes) -> tuple[int, float]:
    from PIL import Image  # layer

    img = Image.open(io.BytesIO(data)).convert("L").resize((64, 64))
    g = [v / 255 for v in img.tobytes()]
    edges = n = 0
    for y in range(1, 40):
        for x in range(1, 63):
            gx = g[y * 64 + x + 1] - g[y * 64 + x - 1]
            gy = g[(y + 1) * 64 + x] - g[(y - 1) * 64 + x]
            if (gx * gx + gy * gy) ** 0.5 > 0.18:
                edges += 1
            n += 1
    dn = edges / n
    lv = 0 if dn < THRESH[0] else 1 if dn < THRESH[1] else 2 if dn < THRESH[2] else 3
    gap = min(abs(dn - t) for t in THRESH)
    return lv, clamp(0.55 + gap * 3, 0.55, 0.86)


def sagemaker_level(data: bytes, content_type: str) -> tuple[int, float] | None:
    ep = os.environ.get("SAGEMAKER_ENDPOINT")
    if not ep:
        return None
    try:
        resp = _smr().invoke_endpoint(EndpointName=ep, ContentType=content_type, Body=data)
        out = json.loads(resp["Body"].read())
        return int(out["level"]), float(out["confidence"])
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"level": "warn", "msg": "sagemaker failed, using heuristic", "error": str(exc)}))
        return None


def waste_check(data: bytes) -> tuple[bool | None, list[str]]:
    """(looks_like_waste, labels). None means Rekognition could not be reached."""
    try:
        resp = _rek().detect_labels(Image={"Bytes": data}, MaxLabels=15, MinConfidence=50)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"level": "warn", "msg": "rekognition failed", "error": str(exc)}))
        return None, []
    labels = [lb["Name"] for lb in resp.get("Labels", [])]
    return any(n.lower() in WASTE_LABELS for n in labels), labels


def analyze(bin_id: str, rid: str, key: str, bucket: str, last_attempt: bool = True) -> None:
    if not store.claim_upload(rid):
        return  # duplicate delivery, or upload record missing
    rec = store.get_report(rid) or {}
    try:
        obj = _s3().get_object(Bucket=bucket, Key=key)
        data, ctype = obj["Body"].read(), obj.get("ContentType", "image/jpeg")

        looks_like_waste, labels = waste_check(data)
        if looks_like_waste is False and os.environ.get("REJECT_NON_BIN", "true") == "true":
            store.set_report_status(
                rid, "rejected", labels=labels, ttl=_ttl(),
                reason="This photo does not look like a bin or litter. Try again, or choose a fill level by hand.")
            events.metric("PhotosRejected")
            return

        sm = sagemaker_level(data, ctype)
        level, conf = sm if sm else edge_level(data)
        reports.apply_report(
            bin_id, level, conf, "Photo upload", rec.get("user", "unknown"), report_id=rid,
            extra={"labels": labels, "key": key, "model": "sagemaker" if sm else "edge-heuristic"},
        )
        events.metric("PhotosAnalyzed")
    except Exception:
        if last_attempt:
            store.set_report_status(rid, "error", ttl=_ttl(), reason="Analysis failed. Choose a fill level by hand.")
        else:
            store.set_report_status(rid, "pending")  # let the SQS retry claim it again
        raise


def _ttl() -> int:
    return int(time.time()) + 24 * 3600


def handler(event, _ctx):
    """SQS batch. Each record body is an S3 event notification."""
    failures = []
    for rec in event.get("Records", []):
        try:
            body = json.loads(rec["body"])
            for s3rec in body.get("Records", []):  # s3:TestEvent has no Records
                key = urllib.parse.unquote_plus(s3rec["s3"]["object"]["key"])
                bucket = s3rec["s3"]["bucket"]["name"]
                parts = key.split("/")
                if len(parts) != 3 or parts[0] != "uploads":
                    continue
                last = int(rec.get("attributes", {}).get("ApproximateReceiveCount", "1")) >= MAX_RECEIVES
                analyze(parts[1], parts[2], key, bucket, last_attempt=last)
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"level": "error", "msg": "analyze failed", "error": str(exc), "id": rec.get("messageId")}))
            failures.append({"itemIdentifier": rec["messageId"]})
    return {"batchItemFailures": failures}
