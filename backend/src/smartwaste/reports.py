"""Turning a fill-level report into a bin update, a stored report and (maybe) an alert."""
from __future__ import annotations

import uuid

from . import events, store
from .model import LEVELS, apply_level, derive


class NotFound(Exception):
    pass


class Conflict(Exception):
    pass


def _snap(b: dict) -> dict:
    return {"cur": b["cur"], "rate": b["rate"], "rep": b["rep"]}


def _view(row: dict) -> dict:
    return {"pred": row["pred"], "score": row["score"]}


def apply_report(bin_id: str, level: int, conf: float, source: str, user: str,
                 report_id: str | None = None, replaces: str | None = None, extra: dict | None = None) -> dict:
    """Apply `level` to the bin and store the report. Returns the stored report.

    `replaces` names an earlier report for the same bin. If that report is still the
    bin's latest, the update starts from the bin's state before it, so fixing a wrong
    photo detection replaces the first update instead of stacking on top of it.
    """
    if level not in range(len(LEVELS)):
        raise ValueError("level must be 0 to 3")
    rid = report_id or uuid.uuid4().hex
    cfg = store.get_config()

    for _ in range(4):
        b = store.get_bin(bin_id)
        if not b:
            raise NotFound(bin_id)
        old = derive([b], cfg)[0]
        prev, before = _snap(b), _view(old)
        if replaces and b.get("lastReport") == replaces:
            earlier = store.get_report(replaces)
            if earlier and earlier.get("binId") == bin_id and earlier.get("prev"):
                prev, before = earlier["prev"], earlier["before"]
        new = apply_level(b, level, prev)
        if store.update_bin(bin_id, new, b["version"], rid):
            break
    else:
        raise Conflict("bin was updated by someone else, try again")

    after = derive([{**b, **new}], cfg)[0]
    rep = {
        "id": rid, "binId": bin_id, "ts": store.now_iso(), "status": "done", "user": user, "source": source,
        "level": level, "conf": conf, "prev": prev, "before": before, "after": _view(after),
        "replaces": replaces, **(extra or {}),
    }
    store.put_report(rep)

    events.metric("ReportsApplied")
    if after["pred"] >= 100 and old["pred"] < 100:
        events.publish("OverflowRisk", {
            "binId": bin_id, "name": b["name"], "predictedFill": round(after["pred"]),
            "currentFill": round(new["cur"]), "source": source,
        })
        events.metric("OverflowRisk")
    return rep
