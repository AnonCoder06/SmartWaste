"""SmartWaste prediction model. Pure functions, no AWS imports.

This is a line-for-line port of the model in frontend/engine.js. The two are kept
in step by backend/tests/test_parity.py, which runs both on the same inputs.
"""
from __future__ import annotations

GRID = 80
KM_PER_UNIT = 1.875 / 1000
DEPOT = {"id": "DEPOT", "x": 80, "y": 560, "w": 0}

DEFAULT_CONFIG = {
    "H": 8,
    "truckCap": 7000,
    "lamPct": 40,
    "wts": {"pred": 50, "cur": 20, "time": 15, "risk": 15},
}

LEVELS = [
    {"n": "Low", "v": 15},
    {"n": "Medium", "v": 45},
    {"n": "Nearly full", "v": 78},
    {"n": "Overflowing", "v": 105},
]

# id, name, grid x, grid y, capacity (L), fill %, fill rate (%/h), hours since pickup, reports
SEED_SPEC = [
    ("B-01", "Market Gate", 2, 1, 660, 40, 1.2, 20, 0), ("B-02", "Temple Road", 4, 1, 660, 55, 1.8, 30, 1),
    ("B-03", "Bus Stand", 7, 1, 1100, 82, 2.2, 36, 2), ("B-04", "School Lane", 10, 1, 240, 35, 0.9, 18, 0),
    ("B-05", "North Park", 3, 2, 240, 20, 0.6, 12, 0), ("B-06", "Clinic Corner", 6, 2, 660, 66, 1.5, 28, 1),
    ("B-07", "Vegetable Mart", 11, 2, 1100, 48, 2.6, 24, 0), ("B-08", "Food Street", 5, 3, 660, 72, 2.4, 40, 2),
    ("B-09", "Ward Office", 8, 3, 240, 30, 0.8, 14, 0), ("B-10", "Community Hall", 12, 3, 1100, 90, 1.0, 44, 3),
    ("B-11", "Temple Tank", 3, 4, 660, 58, 0.7, 26, 0), ("B-12", "Station Road", 10, 4, 660, 75, 0.9, 30, 1),
    ("B-13", "Hostel Row", 2, 5, 660, 44, 1.1, 22, 0), ("B-14", "Canteen Chowk", 6, 5, 1100, 70, 3.0, 24, 1),
    ("B-15", "Metro Stop", 8, 5, 660, 25, 0.5, 10, 0), ("B-16", "Apartments C", 11, 5, 660, 52, 2.0, 32, 0),
    ("B-17", "Fish Market", 4, 6, 1100, 78, 3.1, 38, 2), ("B-18", "Bakery Lane", 7, 6, 660, 38, 1.4, 20, 0),
    ("B-19", "Bridge End", 12, 6, 240, 15, 0.4, 8, 0), ("B-20", "Library Gate", 3, 7, 660, 62, 1.7, 26, 1),
    ("B-21", "Petrol Pump", 6, 7, 660, 85, 0.8, 42, 1), ("B-22", "Sports Ground", 9, 7, 660, 28, 1.0, 16, 0),
    ("B-23", "Old Bazaar", 11, 7, 660, 61, 1.9, 30, 0), ("B-24", "Post Office", 5, 4, 240, 33, 1.3, 18, 0),
]


def seed_bins() -> list[dict]:
    return [
        {"id": s[0], "name": s[1], "x": s[2] * GRID, "y": s[3] * GRID, "cap": s[4],
         "cur": s[5], "rate": s[6], "since": s[7], "rep": s[8]}
        for s in SEED_SPEC
    ]


def clamp(v: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, v))


def pred_of(b: dict, cfg: dict) -> float:
    return b["cur"] + b["rate"] * cfg["H"]


def risk_of(b: dict, cfg: dict) -> float:
    return clamp(
        0.25 * b["rep"] + (0.4 if pred_of(b, cfg) > 100 else 0) + (0.15 if b["rate"] > 2.5 else 0),
        0, 1,
    )


def factors(b: dict, cfg: dict) -> dict:
    return {
        "pred": clamp(pred_of(b, cfg) / 100, 0, 1.25),
        "cur": clamp(b["cur"] / 100, 0, 1.25),
        "time": clamp(b["since"] / 48, 0, 1),
        "risk": risk_of(b, cfg),
    }


def norm_weights(cfg: dict) -> dict:
    w = cfg["wts"]
    s = (w["pred"] + w["cur"] + w["time"] + w["risk"]) or 1
    return {k: w[k] / s for k in ("pred", "cur", "time", "risk")}


def score_of(b: dict, cfg: dict) -> float:
    f, w = factors(b, cfg), norm_weights(cfg)
    return clamp(sum(w[k] * f[k] for k in ("pred", "cur", "time", "risk")), 0, 1)


def fill_cls(v: float) -> str:
    return "low" if v < 35 else "med" if v < 65 else "high" if v < 90 else "crit"


def tier_of(s: float) -> str:
    return "crit" if s >= 0.85 else "high" if s >= 0.70 else "med" if s >= 0.50 else "low"


def derive(bins: list[dict], cfg: dict) -> list[dict]:
    rows = []
    for b in bins:
        p, s = pred_of(b, cfg), score_of(b, cfg)
        rows.append({
            "b": b, "pred": p, "score": s, "tier": tier_of(s),
            "load": clamp(p, 0, 100) / 100 * b["cap"],
        })
    return rows


def apply_level(b: dict, level: int, prev: dict) -> dict:
    """Return the bin fields that change when a report says the bin is at `level`.

    `prev` is the bin's {cur, rate, rep} before the first report in a correction
    chain, so correcting a wrong detection does not stack the two updates.
    """
    cur = LEVELS[level]["v"]
    rate = clamp(0.6 * prev["rate"] + 0.4 * (cur / max(b["since"], 6)), 0.2, 4)
    rep = prev["rep"] + (1 if level >= 2 else 0)
    return {"cur": cur, "rate": rate, "rep": rep}


def validate_config(raw: dict) -> dict:
    """Clamp a user-supplied config to the ranges the UI offers. Raises ValueError."""
    try:
        w = raw.get("wts", {})
        cfg = {
            "H": int(raw["H"]),
            "truckCap": int(raw["truckCap"]),
            "lamPct": int(raw["lamPct"]),
            "wts": {k: int(w[k]) for k in ("pred", "cur", "time", "risk")},
        }
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("config is missing a field or has a non-numeric value") from exc
    if not 4 <= cfg["H"] <= 12:
        raise ValueError("H must be between 4 and 12")
    if not 3000 <= cfg["truckCap"] <= 12000:
        raise ValueError("truckCap must be between 3000 and 12000")
    if not 0 <= cfg["lamPct"] <= 100:
        raise ValueError("lamPct must be between 0 and 100")
    if any(not 0 <= v <= 100 for v in cfg["wts"].values()):
        raise ValueError("weights must be between 0 and 100")
    return cfg
