"""EventBridge publishing and CloudWatch embedded-metric lines."""
from __future__ import annotations

import json
import os
import time
from functools import lru_cache

import boto3

SOURCE = "smartwaste.app"


@lru_cache(maxsize=1)
def _client():
    return boto3.client("events")


def reset_clients() -> None:
    _client.cache_clear()


def publish(detail_type: str, detail: dict) -> None:
    """Best effort. A failed notification must never fail a report or a plan."""
    bus = os.environ.get("EVENT_BUS")
    if not bus:
        return
    try:
        _client().put_events(Entries=[{
            "EventBusName": bus, "Source": SOURCE, "DetailType": detail_type, "Detail": json.dumps(detail),
        }])
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"level": "warn", "msg": "put_events failed", "error": str(exc)}))


def metric(name: str, value: float = 1, unit: str = "Count") -> None:
    """CloudWatch Embedded Metric Format: one JSON line becomes a custom metric."""
    print(json.dumps({
        "_aws": {"Timestamp": int(time.time() * 1000), "CloudWatchMetrics": [{
            "Namespace": "SmartWaste", "Dimensions": [[]], "Metrics": [{"Name": name, "Unit": unit}]}]},
        name: value,
    }))
