"""Import this first in every test module. Puts the AWS stand-ins ahead of any real boto3."""
import io
import json
import os
import random
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "src"))
sys.path.insert(0, str(HERE / "fakeaws"))
os.environ.update(TABLE_NAME="t", UPLOAD_BUCKET="up", EVENT_BUS="bus", STATE_MACHINE_ARN="arn:sm",
                  AWS_DEFAULT_REGION="us-east-1")

import awsfake  # noqa: E402
from smartwaste import analyzer, api, events, store  # noqa: E402


class AwsCase(unittest.TestCase):
    def setUp(self):
        real_stdout = sys.stdout
        sys.stdout = io.StringIO()  # Lambda log lines are noise in test output
        self.addCleanup(setattr, sys, "stdout", real_stdout)
        awsfake.reset()
        for mod in (store, events, analyzer, api):
            mod.reset_clients()
        store.seed()


def claims(sub="u1", email="u1@x.test", groups=None):
    c = {"sub": sub, "email": email}
    if groups is not None:
        c["cognito:groups"] = "[" + " ".join(groups) + "]"
    return c


def call(route, user=None, body=None, path=None):
    """Invoke the API handler like API Gateway would. Returns (status, parsed body)."""
    ev = {"routeKey": route, "pathParameters": path or {}, "body": json.dumps(body) if body is not None else None,
          "requestContext": {"authorizer": {"jwt": {"claims": user or claims()}}}}
    out = api.handler(ev, None)
    return out["statusCode"], json.loads(out["body"])


COLLECTOR = claims("c1", "c@x.test", ["collectors"])


def photo(kind):
    """Synthetic bin photos: flat grey gives a low edge density, speckle gives a high one."""
    from PIL import Image
    rnd = random.Random(3)
    img = Image.new("RGB", (160, 120), (150, 150, 150))
    if kind == "busy":
        px = img.load()
        for y in range(120):
            for x in range(160):
                v = 255 if rnd.random() < 0.5 else 0
                px[x, y] = (v, v, v)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def s3_event_for(key, count=1):
    body = {"Records": [{"s3": {"bucket": {"name": "up"}, "object": {"key": key}}}]}
    return {"Records": [{"messageId": "m1", "body": json.dumps(body),
                         "attributes": {"ApproximateReceiveCount": str(count)}}]}
