"""HTTP API handler (API Gateway HTTP API, payload v2)."""
from __future__ import annotations

import base64
import json
import os
import random
import re
import time
import uuid
from functools import lru_cache

import boto3
from botocore.config import Config

from . import events, reports, store
from .model import validate_config

MAX_PHOTO_BYTES = 8 * 1024 * 1024
CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
ID_RE = re.compile(r"^B-\d{2,3}$")


class HttpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


@lru_cache(maxsize=1)
def _s3():
    # Regional endpoint on purpose: the global one can answer a brand-new bucket with a redirect,
    # and a browser POST cannot follow it.
    region = os.environ.get("AWS_REGION", "us-east-1")
    return boto3.client("s3", region_name=region, endpoint_url=f"https://s3.{region}.amazonaws.com",
                        config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))


@lru_cache(maxsize=1)
def _sfn():
    return boto3.client("stepfunctions")


def reset_clients() -> None:
    _s3.cache_clear()
    _sfn.cache_clear()


def _resp(status: int, body) -> dict:
    return {"statusCode": status, "headers": {"content-type": "application/json", "cache-control": "no-store"},
            "body": json.dumps(body)}


def _body(event) -> dict:
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode()
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise HttpError(400, "body is not valid JSON") from exc
    if not isinstance(data, dict):
        raise HttpError(400, "body must be a JSON object")
    return data


def _bin_id(event) -> str:
    bid = (event.get("pathParameters") or {}).get("id", "")
    if not ID_RE.match(bid):
        raise HttpError(400, "bad bin id")
    return bid


# ---- routes -----------------------------------------------------------------

def state(event, user):
    plan = store.get_plan()
    return 200, {
        "bins": store.list_bins(), "config": store.get_config(),
        "plan": plan if plan and plan.get("status") == "active" else None,
        "serverTime": store.now_iso(),
    }


def create_upload(event, user):
    bid = _bin_id(event)
    if not store.get_bin(bid):
        raise HttpError(404, "no such bin")
    ctype = _body(event).get("contentType", "image/jpeg")
    if ctype not in CONTENT_TYPES:
        raise HttpError(400, "photo must be JPEG, PNG or WebP")
    rid = uuid.uuid4().hex
    key = f"uploads/{bid}/{rid}"
    store.put_report({"id": rid, "binId": bid, "ts": store.now_iso(), "status": "pending", "user": "public",
                      "ttl": int(time.time()) + 24 * 3600})
    post = _s3().generate_presigned_post(
        os.environ["UPLOAD_BUCKET"], key, Fields={"Content-Type": ctype},
        Conditions=[{"Content-Type": ctype}, ["content-length-range", 1, MAX_PHOTO_BYTES]], ExpiresIn=300)
    return 200, {"reportId": rid, "post": post, "maxBytes": MAX_PHOTO_BYTES}


def get_report(event, user):
    rid = (event.get("pathParameters") or {}).get("id", "")
    rep = store.get_report(rid) if re.fullmatch(r"[0-9a-f]{32}", rid) else None
    if not rep:
        raise HttpError(404, "no such report")
    keep = ("id", "binId", "status", "level", "conf", "labels", "reason", "before", "after", "source", "model", "ts")
    return 200, {k: rep[k] for k in keep if k in rep}


def create_report(event, user):
    bid = _bin_id(event)
    body = _body(event)
    level = body.get("level")
    if not isinstance(level, int) or isinstance(level, bool):
        raise HttpError(400, "level must be an integer from 0 to 3")
    source = {"sample": "Sample photo", "correction": "Correction"}.get(body.get("source"), "Manual report")
    try:
        rep = reports.apply_report(bid, level, 1.0, source, "public", replaces=body.get("replaces"))
    except ValueError as exc:
        raise HttpError(400, str(exc)) from exc
    except reports.NotFound as exc:
        raise HttpError(404, "no such bin") from exc
    except reports.Conflict as exc:
        raise HttpError(409, str(exc)) from exc
    return 200, {k: rep[k] for k in ("id", "binId", "status", "level", "conf", "before", "after", "source")}


def put_config(event, user):
    try:
        cfg = validate_config(_body(event))
    except ValueError as exc:
        raise HttpError(400, str(exc)) from exc
    store.set_config(cfg)
    return 200, cfg


def run_plan(event, user):
    resp = _sfn().start_sync_execution(
        stateMachineArn=os.environ["STATE_MACHINE_ARN"],
        input=json.dumps({"trigger": "api", "by": "SmartWaste user"}))
    if resp["status"] != "SUCCEEDED":
        raise HttpError(502, f"planner failed: {resp.get('error', resp['status'])}")
    return 200, json.loads(resp["output"])


def set_stop(event, user):
    bid = _bin_id(event)
    plan = store.get_plan()
    if not plan or plan.get("status") != "active" or bid not in plan["route"]:
        raise HttpError(404, "that bin is not on the active route")
    done = bool(_body(event).get("done", True))
    store.set_stop(bid, done)
    return 200, {"binId": bid, "done": done}


def complete_plan(event, user):
    plan = store.get_plan()
    if not plan or plan.get("status") != "active":
        raise HttpError(404, "there is no active plan")
    rnd = random.Random(7)
    stops, bins = set(plan["route"]), store.list_bins()
    for b in bins:
        if b["id"] in stops:
            b.update(cur=4 + round(rnd.random() * 6), since=0, rep=0)
        else:
            b["since"] += 10
        b["version"] = b.get("version", 0) + 1
        b.pop("lastReport", None)
    store.put_bins(bins)
    store.put_plan({**plan, "status": "completed", "completedAt": store.now_iso()})
    events.publish("CollectionCompleted", {"planId": plan["planId"], "binsServiced": len(stops)})
    return 200, {"serviced": len(stops)}


def reset(event, user):
    store.seed(force=True)
    return 200, {"ok": True}


ROUTES = {
    "GET /api/state": state,
    "POST /api/bins/{id}/uploads": create_upload,
    "GET /api/reports/{id}": get_report,
    "POST /api/bins/{id}/reports": create_report,
    "PUT /api/config": put_config,
    "POST /api/plans": run_plan,
    "POST /api/plans/latest/stops/{id}": set_stop,
    "POST /api/plans/latest/complete": complete_plan,
    "POST /api/admin/reset": reset,
}


def handler(event, _ctx):
    fn = ROUTES.get(event.get("routeKey"))
    if not fn:
        return _resp(404, {"error": "not found"})
    try:
        user = {"sub": "public", "email": "", "groups": []}
        status, body = fn(event, user)
        return _resp(status, body)
    except HttpError as exc:
        return _resp(exc.status, {"error": exc.message})
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"level": "error", "route": event.get("routeKey"), "error": repr(exc)}))
        return _resp(500, {"error": "something went wrong on our side"})
