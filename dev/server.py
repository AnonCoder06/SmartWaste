#!/usr/bin/env python3
"""Local stand-in for the whole AWS stack, for developing and testing the front end.

Serves frontend/, runs the real Lambda handlers (backend/src) on in-memory AWS fakes, and
mimics the public API and the S3 presigned POST. Nothing here ships to AWS.

    python3 dev/server.py              # http://localhost:8787  (cloud API mode, no sign-in)
    python3 dev/server.py --local      # no config.json: the page falls back to offline demo mode
"""
import argparse
import email
import json
import mimetypes
import os
import re
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend" / "src"))
sys.path.insert(0, str(ROOT / "backend" / "tests" / "fakeaws"))
os.environ.update(TABLE_NAME="t", UPLOAD_BUCKET="up", EVENT_BUS="bus", STATE_MACHINE_ARN="arn:sm",
                  AWS_DEFAULT_REGION="us-east-1")

import awsfake  # noqa: E402
from smartwaste import analyzer, api, store  # noqa: E402

PORT = 8787
LOCAL_ONLY = False


def route_for(method, path):
    for key in api.ROUTES:
        m, tmpl = key.split(" ", 1)
        if m != method:
            continue
        rx = "^" + re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", tmpl) + "$"
        hit = re.match(rx, path)
        if hit:
            return key, hit.groupdict()
    return None, {}


def start_server():
    awsfake.reset()
    store.reset_clients()
    api.reset_clients()
    analyzer.reset_clients()
    store.seed()

    def presign(self, bucket, key, Fields=None, Conditions=None, ExpiresIn=3600):
        return {"url": f"http://localhost:{PORT}/__s3/", "fields": {**(Fields or {}), "key": key, "policy": "dev"}}
    awsfake.S3.generate_presigned_post = presign
    if os.environ.get("DEV_REK") == "person":
        awsfake.STATE["rek_labels"] = ["Person", "Selfie"]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("DEV_VERBOSE"):
            super().log_message(fmt, *args)

    def _send(self, status, body=b"", ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    # ---- static
    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/api/"):
            return self.api("GET", path)
        if path == "/config.json":
            if LOCAL_ONLY:
                return self._send(404, b"not found", "text/plain")
            return self._send(200, {
                "mode": "cloud", "region": "us-east-1", "apiBase": "/api",
                "schedule": "every night at 22:00 IST"})
        f = ROOT / "frontend" / ("index.html" if path == "/" else path.lstrip("/"))
        if f.is_file() and ROOT / "frontend" in f.resolve().parents:
            ctype = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
            return self._send(200, f.read_bytes(), ctype)
        self._send(404, b"not found", "text/plain")

    def do_PUT(self):
        self.api("PUT", self.path.split("?")[0])

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/__s3/":
            return self.s3_post()
        self.api("POST", path)

    # ---- Public API Gateway stand-in
    def api(self, method, path):
        raw = self._body()
        key, params = route_for(method, path)
        if not key:
            return self._send(404, {"message": "Not Found"})
        ev = {"routeKey": key, "pathParameters": params, "body": raw.decode() or None}
        out = api.handler(ev, None)
        self._send(out["statusCode"], out["body"], out["headers"]["content-type"])

    # ---- S3 presigned POST target, then the S3 -> SQS -> analyzer hop
    def s3_post(self):
        ctype = self.headers.get("Content-Type", "")
        raw = self._body()
        msg = email.message_from_bytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + raw)
        fields, data = {}, None
        for part in msg.get_payload():
            name = part.get_param("name", header="content-disposition")
            if name == "file":
                data = part.get_payload(decode=True)
            else:
                fields[name] = part.get_payload(decode=True).decode()
        if not data or "key" not in fields or len(data) > 8 * 1024 * 1024:
            return self._send(400, b"bad upload", "text/plain")
        key = fields["key"]
        awsfake.STATE["s3"][("up", key)] = (data, fields.get("Content-Type", "image/jpeg"))
        self._send(204, b"", "text/plain")

        def later():
            time.sleep(0.5)
            body = {"Records": [{"s3": {"bucket": {"name": "up"}, "object": {"key": key}}}]}
            analyzer.handler({"Records": [{"messageId": uuid.uuid4().hex, "body": json.dumps(body),
                                           "attributes": {"ApproximateReceiveCount": "1"}}]}, None)
        threading.Thread(target=later, daemon=True).start()


def main():
    global LOCAL_ONLY, PORT
    ap = argparse.ArgumentParser()
    ap.add_argument("--local", action="store_true", help="serve no config.json so the page runs in offline demo mode")
    ap.add_argument("--port", type=int, default=PORT)
    a = ap.parse_args()
    LOCAL_ONLY, PORT = a.local, a.port
    start_server()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"SmartWaste dev server on http://localhost:{PORT} ({'offline demo' if LOCAL_ONLY else 'cloud mode on in-memory AWS'})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
