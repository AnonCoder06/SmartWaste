"""DynamoDB access. One table, string keys pk/sk, one GSI (gsi1pk/gsi1sk).

  pk                sk                  what
  BIN#B-01          META                bin state (gsi1pk=BINS, gsi1sk=B-01)
  REPORT#<id>       META                one report or photo upload (gsi1pk=BINREP#B-01, gsi1sk=<iso time>)
  CONFIG            MODEL               model and truck settings
  PLAN              LATEST              the active collection plan
  PLAN#<planId>     META                history copy of every plan
"""
from __future__ import annotations

import json
import os
import time
from decimal import Decimal
from functools import lru_cache

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from .model import DEFAULT_CONFIG, seed_bins


@lru_cache(maxsize=1)
def table():
    return boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])


def reset_clients() -> None:
    """Tests call this after switching mocked AWS accounts."""
    table.cache_clear()


def to_ddb(obj):
    return json.loads(json.dumps(obj), parse_float=Decimal)


def _plain(o):
    if isinstance(o, Decimal):
        return int(o) if o == o.to_integral_value() else float(o)
    raise TypeError(type(o))


def from_ddb(obj):
    return json.loads(json.dumps(obj, default=_plain))


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ---- bins -------------------------------------------------------------------

def _bin_item(b: dict) -> dict:
    return to_ddb({**b, "pk": f"BIN#{b['id']}", "sk": "META", "gsi1pk": "BINS", "gsi1sk": b["id"],
                   "version": b.get("version", 0), "updatedAt": now_iso()})


def _bin_public(item: dict) -> dict:
    d = from_ddb(item)
    for k in ("pk", "sk", "gsi1pk", "gsi1sk"):
        d.pop(k, None)
    return d


def list_bins() -> list[dict]:
    out, kwargs = [], {"IndexName": "gsi1", "KeyConditionExpression": Key("gsi1pk").eq("BINS")}
    while True:
        resp = table().query(**kwargs)
        out += [_bin_public(i) for i in resp["Items"]]
        if "LastEvaluatedKey" not in resp:
            return out
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]


def get_bin(bin_id: str) -> dict | None:
    item = table().get_item(Key={"pk": f"BIN#{bin_id}", "sk": "META"}).get("Item")
    return _bin_public(item) if item else None


def update_bin(bin_id: str, fields: dict, expected_version: int, report_id: str) -> bool:
    """Optimistic update. Returns False if someone else changed the bin first."""
    f = to_ddb(fields)
    try:
        table().update_item(
            Key={"pk": f"BIN#{bin_id}", "sk": "META"},
            UpdateExpression="SET #c=:c, #r=:r, #p=:p, #v=:nv, #t=:t, #l=:rid",
            ConditionExpression="#v = :v",
            ExpressionAttributeNames={"#c": "cur", "#r": "rate", "#p": "rep", "#v": "version", "#t": "updatedAt",
                                      "#l": "lastReport"},  # aliased so no attribute name can collide with a reserved word
            ExpressionAttributeValues={":c": f["cur"], ":r": f["rate"], ":p": f["rep"], ":v": expected_version,
                                       ":nv": expected_version + 1, ":t": now_iso(), ":rid": report_id},
        )
        return True
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def put_bins(bins: list[dict]) -> None:
    with table().batch_writer() as w:
        for b in bins:
            w.put_item(Item=_bin_item(b))


def seed(force: bool = False) -> bool:
    """Load the demo neighbourhood. Does nothing if bins exist, unless force=True."""
    if not force and list_bins():
        return False
    put_bins(seed_bins())
    set_config(DEFAULT_CONFIG)
    table().delete_item(Key={"pk": "PLAN", "sk": "LATEST"})
    return True


# ---- config -----------------------------------------------------------------

def get_config() -> dict:
    item = table().get_item(Key={"pk": "CONFIG", "sk": "MODEL"}).get("Item")
    if not item:
        return json.loads(json.dumps(DEFAULT_CONFIG))
    d = from_ddb(item)
    return {k: d[k] for k in ("H", "truckCap", "lamPct", "wts")}


def set_config(cfg: dict) -> None:
    table().put_item(Item=to_ddb({"pk": "CONFIG", "sk": "MODEL", **cfg, "updatedAt": now_iso()}))


# ---- reports ----------------------------------------------------------------

def put_report(rep: dict) -> None:
    rid = rep["id"]
    table().put_item(Item=to_ddb({**rep, "pk": f"REPORT#{rid}", "sk": "META",
                                   "gsi1pk": f"BINREP#{rep['binId']}", "gsi1sk": rep["ts"]}))


def get_report(rid: str) -> dict | None:
    item = table().get_item(Key={"pk": f"REPORT#{rid}", "sk": "META"}).get("Item")
    if not item:
        return None
    d = from_ddb(item)
    for k in ("pk", "sk", "gsi1pk", "gsi1sk"):
        d.pop(k, None)
    return d


def claim_upload(rid: str) -> bool:
    """Move a pending upload to processing. SQS delivers at least once, so only one worker wins."""
    try:
        table().update_item(
            Key={"pk": f"REPORT#{rid}", "sk": "META"},
            UpdateExpression="SET #s=:p",
            ConditionExpression="#s = :w",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":p": "processing", ":w": "pending"},
        )
        return True
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def set_report_status(rid: str, status: str, **fields) -> None:
    names, vals, sets = {"#s": "status"}, {":s": status}, ["#s=:s"]
    for i, (k, v) in enumerate(fields.items()):
        names[f"#f{i}"], vals[f":f{i}"] = k, to_ddb(v)
        sets.append(f"#f{i}=:f{i}")
    table().update_item(Key={"pk": f"REPORT#{rid}", "sk": "META"}, UpdateExpression="SET " + ", ".join(sets),
                        ExpressionAttributeNames=names, ExpressionAttributeValues=vals)


# ---- plans ------------------------------------------------------------------

def get_plan() -> dict | None:
    item = table().get_item(Key={"pk": "PLAN", "sk": "LATEST"}).get("Item")
    if not item:
        return None
    d = from_ddb(item)
    for k in ("pk", "sk"):
        d.pop(k, None)
    return d


def put_plan(plan: dict) -> None:
    table().put_item(Item=to_ddb({**plan, "pk": "PLAN", "sk": "LATEST"}))
    table().put_item(Item=to_ddb({**plan, "pk": f"PLAN#{plan['planId']}", "sk": "META"}))


def set_stop(bin_id: str, done: bool) -> None:
    table().update_item(
        Key={"pk": "PLAN", "sk": "LATEST"},
        UpdateExpression="SET ticked.#b = :d",
        ConditionExpression="attribute_exists(pk) AND #st = :a",
        ExpressionAttributeNames={"#b": bin_id, "#st": "status"},
        ExpressionAttributeValues={":d": done, ":a": "active"},
    )
