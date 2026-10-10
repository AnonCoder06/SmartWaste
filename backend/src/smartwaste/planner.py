"""Step Functions task handlers for the nightly planner.

Each handler takes the workflow state and returns it with more fields filled in:

  load -> score -> select -> (any stops?) -> route -> save

The deployed state machine is in infra/lib/smartwaste-stack.ts.
"""
from __future__ import annotations

import time

from . import events, store
from .model import derive
from .routing import plan_stats, route_stops, select_bins


def load(event, _ctx):
    return {**event, "bins": store.list_bins(), "config": store.get_config()}


def score(event, _ctx):
    return {**event, "rows": derive(event["bins"], event["config"])}


def select(event, _ctx):
    sel = select_bins(event["rows"], event["config"]["truckCap"])
    return {**event, "chosen": sel["chosen"], "deferred": sel["deferred"], "load": sel["load"],
            "chosenCount": len(sel["chosen"])}


def route(event, _ctx):
    rt = route_stops(event["rows"], event["chosen"], event["config"]["lamPct"])
    return {**event, **rt, **plan_stats(event["rows"], rt["route"], rt["km"])}


def save(event, _ctx):
    if "route" not in event:  # nothing needed collecting, the optimizer was skipped
        event = route(event, _ctx)
    now = time.gmtime()
    plan = {
        "planId": time.strftime("%Y%m%dT%H%M%SZ", now), "createdAt": store.now_iso(), "status": "active",
        "trigger": event.get("trigger", "api"), "by": event.get("by", ""),
        "route": event["route"], "cum": event["cum"], "km": event["km"], "baseKm": event["baseKm"],
        "deferred": event["deferred"], "load": event["load"], "truckCap": event["config"]["truckCap"],
        "urgentN": event["urgentN"], "urgentC": event["urgentC"], "hpN": event["hpN"], "hpC": event["hpC"],
        "timeMin": event["timeMin"], "ticked": {},
    }
    store.put_plan(plan)
    events.publish("PlanReady", {
        "planId": plan["planId"], "stops": len(plan["route"]), "km": round(plan["km"], 1),
        "loadLitres": round(plan["load"]), "urgentCovered": f'{plan["urgentC"]}/{plan["urgentN"]}',
        "trigger": plan["trigger"],
    })
    events.metric("PlansCreated")
    events.metric("PlanStops", len(plan["route"]))
    return plan
