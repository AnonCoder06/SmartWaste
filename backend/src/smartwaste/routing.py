"""Collection planning: pick bins within truck capacity, then order the stops.

Port of makePlan/solve/improve in frontend/engine.js. Distances are Manhattan on
the street grid, which is what a truck driving a block grid actually travels.
"""
from __future__ import annotations

import os

from .model import DEPOT, KM_PER_UNIT, SEED_SPEC


def man(a: dict, b: dict) -> float:
    return abs(a["x"] - b["x"]) + abs(a["y"] - b["y"])


def cost(order: list[dict], lam: float) -> float:
    t, p, pen = 0.0, DEPOT, 0.0
    for n in order:
        t += man(p, n)
        pen += n["w"] * t
        p = n
    t += man(p, DEPOT)
    return t + lam * pen


def dist(order: list[dict]) -> float:
    t, p = 0.0, DEPOT
    for n in order:
        t += man(p, n)
        p = n
    return t + man(p, DEPOT)


def improve(order: list[dict], lam: float) -> list[dict]:
    """2-opt then or-opt until no move helps (capped at 60 passes, like the JS)."""
    o = list(order)
    best = cost(o, lam)
    improved, guard = True, 0
    while improved and guard < 60:
        guard += 1
        improved = False
        for i in range(len(o) - 1):
            for j in range(i + 1, len(o)):
                c = o[:i] + o[i:j + 1][::-1] + o[j + 1:]
                cc = cost(c, lam)
                if cc < best - 1e-6:
                    o, best, improved = c, cc, True
        for a in range(len(o)):
            n = o[a]
            rest = o[:a] + o[a + 1:]
            for k in range(len(rest) + 1):
                if k == a:
                    continue
                c2 = rest[:k] + [n] + rest[k:]
                c3 = cost(c2, lam)
                if c3 < best - 1e-6:
                    o, best, improved = c2, c3, True
                    break
    return o


def solve(nodes: list[dict], lam: float) -> list[dict]:
    if len(nodes) < 2:
        return list(nodes)
    rem, cur, nn = list(nodes), DEPOT, []
    while rem:
        bi, bd = 0, 1e9
        for i, n in enumerate(rem):
            d = man(cur, n)
            if d < bd:
                bd, bi = d, i
        cur = rem.pop(bi)
        nn.append(cur)
    by_w = sorted(nodes, key=lambda n: -n["w"])
    a, b = improve(nn, lam), improve(by_w, lam)
    return a if cost(a, lam) <= cost(b, lam) else b


def select_bins(rows: list[dict], truck_cap: float) -> dict:
    """Highest priority first. Low-tier bins are skipped, the rest fill the truck."""
    order = sorted(rows, key=lambda r: -r["score"])
    load, chosen, deferred = 0.0, [], []
    for r in order:
        if r["tier"] == "low":
            continue
        if load + r["load"] <= truck_cap:
            chosen.append(r)
            load += r["load"]
        else:
            deferred.append(r["b"]["id"])
    return {"chosen": chosen, "deferred": deferred, "load": load}


def route_stops(rows: list[dict], chosen: list[dict], lam_pct: float) -> dict:
    lam = lam_pct / 100 * 0.15
    nodes = [{"id": r["b"]["id"], "x": r["b"]["x"], "y": r["b"]["y"], "w": r["score"]} for r in chosen]
    route = solve(nodes, lam)
    everything = [{"id": r["b"]["id"], "x": r["b"]["x"], "y": r["b"]["y"], "w": r["score"]} for r in rows]
    base = dist(solve(everything, 0))
    d = dist(route) if route else 0
    cum, t, p = [], 0.0, DEPOT
    for n in route:
        t += man(p, n)
        cum.append(t)
        p = n
    return {"route": [n["id"] for n in route], "cum": cum, "km": d * KM_PER_UNIT, "baseKm": base * KM_PER_UNIT}


def road_path(route_ids: list[str], rows: list[dict]) -> list[list[float]] | None:
    """Return an Amazon Location road-following LineString for the chosen stop order.

    Kept behind ROUTING_ENABLED so local/offline planning does not need AWS credentials.
    CalculateRoutes accepts at most 25 positions per request, including both endpoints.
    """
    if os.environ.get("ROUTING_ENABLED", "").lower() != "true":
        return None
    if not route_ids:
        return []

    import boto3

    seeds = {s[0]: s for s in SEED_SPEC}
    by_id = {r["b"]["id"]: r["b"] for r in rows}

    def position(bid: str) -> list[float]:
        b = by_id[bid]
        seed = seeds.get(bid)
        lon = b.get("lon", seed[9] if seed else None)
        lat = b.get("lat", seed[10] if seed else None)
        if lon is None or lat is None:
            raise ValueError(f"No geographic coordinates for route stop {bid}")
        return [float(lon), float(lat)]

    positions = [[float(DEPOT["lon"]), float(DEPOT["lat"])]]
    positions.extend(position(bid) for bid in route_ids)
    positions.append([float(DEPOT["lon"]), float(DEPOT["lat"])])
    client = boto3.client("geo-routes")
    path: list[list[float]] = []

    # A request can contain 25 positions total (origin + up to 23 waypoints + destination).
    # Split larger tours at an existing stop and join the returned leg geometries.
    start = 0
    while start < len(positions) - 1:
        end = min(start + 24, len(positions) - 1)
        segment = positions[start:end + 1]
        response = client.calculate_routes(
            Origin=segment[0],
            Destination=segment[-1],
            Waypoints=[{"Position": point} for point in segment[1:-1]],
            TravelMode="Truck",
            OptimizeRoutingFor="FastestRoute",
            LegGeometryFormat="Simple",
        )
        routes = response.get("Routes", [])
        if not routes:
            raise RuntimeError("Amazon Location returned no road route")
        for leg in routes[0].get("Legs", []):
            line = leg.get("Geometry", {}).get("LineString", [])
            if len(line) < 2:
                continue
            coords = [[float(point[0]), float(point[1])] for point in line]
            if path and abs(path[-1][0] - coords[0][0]) < 1e-5 and abs(path[-1][1] - coords[0][1]) < 1e-5:
                coords = coords[1:]
            path.extend(coords)
        start = end

    if len(path) < 2:
        raise RuntimeError("Amazon Location returned incomplete road geometry")
    return path


def plan_stats(rows: list[dict], route_ids: list[str], km: float) -> dict:
    urgent = [r for r in rows if r["pred"] >= 90]
    urgent_c = [r for r in urgent if r["b"]["id"] in route_ids]
    hp = [r for r in rows if r["tier"] in ("crit", "high")]
    hp_c = [r for r in hp if r["b"]["id"] in route_ids]
    return {
        "urgentN": len(urgent), "urgentC": len(urgent_c),
        "hpN": len(hp), "hpC": len(hp_c),
        "timeMin": km / 18 * 60 + len(route_ids) * 3,
    }


def make_plan(rows: list[dict], cfg: dict) -> dict:
    """Whole pipeline in one call. The deployed workflow runs the same three steps as
    separate Step Functions states; this is what the tests and the dev server use."""
    sel = select_bins(rows, cfg["truckCap"])
    rt = route_stops(rows, sel["chosen"], cfg["lamPct"])
    stats = plan_stats(rows, rt["route"], rt["km"])
    return {
        "route": rt["route"], "cum": rt["cum"], "km": rt["km"], "baseKm": rt["baseKm"],
        "deferred": sel["deferred"], "load": sel["load"], **stats,
    }
