"""Deploy-time data seeding. Runs after every `cdk deploy` through a CDK Trigger."""
from __future__ import annotations

from . import store


def handler(event, _ctx):
    force = bool((event or {}).get("force"))
    return {"seeded": store.seed(force=force)}
