#!/usr/bin/env python3
"""Smoke test for a running SmartWaste (deployed on AWS, or dev/server.py). Standard library only.

    python3 scripts/smoke.py https://dxxxx.cloudfront.net
    python3 scripts/smoke.py http://localhost:8787

Exercises the public API, reports, the S3 -> SQS -> analyzer photo path, the Step Functions planner,
stop ticking and collection. With --reset it puts the seed data back at the end. Exit code 1 if anything fails.
"""
import argparse
import json
import random
import struct
import sys
import time
import urllib.error
import urllib.request
import uuid
import zlib

fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        fails.append(name)


def http(method, url, body=None, headers=None, raw=False):
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            payload = r.read()
            return r.status, (payload if raw else (json.loads(payload) if payload else {}))
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return e.code, json.loads(payload)
        except ValueError:
            return e.code, {"raw": payload[:200].decode(errors="replace")}


def png(w=96, h=72):
    rnd = random.Random(5)
    rows = b"".join(b"\x00" + bytes(255 if rnd.random() < 0.5 else 0 for _ in range(w)) for _ in range(h))
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def multipart(fields, filename, content, ctype):
    b = uuid.uuid4().hex
    out = b""
    for k, v in fields.items():
        out += f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    out += (f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n").encode() + content + f"\r\n--{b}--\r\n".encode()
    return out, f"multipart/form-data; boundary={b}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--reset", action="store_true", help="restore the seed data at the end")
    a = ap.parse_args()
    base = a.base.rstrip("/")
    st, conf = http("GET", base + "/config.json")
    check("site serves config.json in cloud mode", st == 200 and conf.get("mode") == "cloud", str(conf)[:120])
    st, home = http("GET", base + "/", raw=True)
    check("site serves the page", st == 200 and b"SmartWaste" in home)
    if fails:
        sys.exit(1)

    def api(m, p, body=None):
        return http(m, base + "/api" + p, body, {"Content-Type": "application/json"})

    st, _ = http("GET", base + "/api/state")
    check("API works without signing in", st == 200, str(st))
    st, s0 = api("GET", "/state")
    check("state returns 24 bins", st == 200 and len(s0.get("bins", [])) == 24, str(s0)[:120])
    b05 = next(b for b in s0["bins"] if b["id"] == "B-05")

    st, r1 = api("POST", "/bins/B-05/reports", {"level": 3, "source": "sample"})
    check("report accepted", st == 200 and r1.get("level") == 3, str(r1)[:120])
    check("report raises the forecast", r1.get("after", {}).get("pred", 0) > r1.get("before", {}).get("pred", 1))
    st, r2 = api("POST", "/bins/B-05/reports", {"level": 1, "source": "correction", "replaces": r1.get("id")})
    st, s1 = api("GET", "/state")
    now = next(b for b in s1["bins"] if b["id"] == "B-05")
    check("correction replaces the first report", now["cur"] == 45 and now["rep"] == b05["rep"], f"cur={now['cur']} rep={now['rep']}")

    st, up = api("POST", "/bins/B-19/uploads", {"contentType": "image/png"})
    check("upload URL issued", st == 200 and "post" in up, str(up)[:120])
    if st == 200:
        body, ctype = multipart(up["post"]["fields"], "bin.png", png(), "image/png")
        pu = up["post"]["url"]
        if pu.startswith("/"):
            pu = base + pu
        st, _ = http("POST", pu, body, {"Content-Type": ctype}, raw=True)
        check("photo accepted by S3", st in (200, 201, 204), str(st))
        status, t0 = None, time.time()
        while time.time() - t0 < 60:
            st, rep = api("GET", "/reports/" + up["reportId"])
            status = rep.get("status")
            if status in ("done", "rejected", "error"):
                break
            time.sleep(1.5)
        check("analyzer finished the photo (S3 -> SQS -> Lambda)", status in ("done", "rejected"), f"status={status}")
        print(f"     analyzer verdict: {status}" + (f", level {rep.get('level')}, model {rep.get('model')}" if status == "done" else f" ({rep.get('reason', '')[:60]})"))

    st, plan = api("POST", "/plans", {})
    check("planner (Step Functions) returns a plan", st == 200 and len(plan.get("route", [])) > 0, str(plan)[:160])
    route = plan.get("route", [])
    check("plan respects truck capacity", plan.get("load", 1e9) <= 7000 + 1e-6, str(plan.get("load")))
    if route:
        st, _ = api("POST", f"/plans/latest/stops/{route[0]}", {"done": True})
        st2, s2 = api("GET", "/state")
        check("stop ticked and persisted", st == 200 and s2["plan"]["ticked"].get(route[0]) is True)
    st, cfg = api("PUT", "/config", {**s0["config"], "truckCap": 5000})
    check("configuration can be changed without signing in", st == 200 and cfg.get("truckCap") == 5000, str(cfg)[:100])
    st, done = api("POST", "/plans/latest/complete", {})
    check("collection completes", st == 200 and done.get("serviced") == len(route), str(done))
    if a.reset:
        api("PUT", "/config", s0["config"])
        st, _ = api("POST", "/admin/reset", {})
        check("seed data restored", st == 200)

    print(f"\n{len(fails)} failed" if fails else "\nall checks passed")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
