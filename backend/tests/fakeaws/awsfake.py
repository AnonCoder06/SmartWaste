"""In-memory AWS for tests and the dev server.

DynamoDB: get/put/delete/update/query/batch_writer with the expression forms smartwaste uses.
It enforces two rules the real service has that are easy to forget: floats are rejected
(use Decimal) and a SET into a missing parent map fails.
"""
import copy
import io
import json
import re
from decimal import Decimal

from botocore.exceptions import ClientError

STATE = {}


def reset():
    STATE.clear()
    STATE.update(table=None, s3={}, events=[], users={}, groups={}, rek_labels=None, rek_error=False,
                 sm_response=None, sm_error=False, fail_next_updates=0)
    STATE["table"] = FakeTable()


def _err(code, op):
    return ClientError({"Error": {"Code": code, "Message": code}}, op)


def _no_floats(o, where):
    if isinstance(o, float):
        raise TypeError(f"Float types are not supported. Use Decimal types instead. ({where})")
    if isinstance(o, dict):
        for v in o.values():
            _no_floats(v, where)
    elif isinstance(o, list):
        for v in o:
            _no_floats(v, where)


class FakeTable:
    def __init__(self):
        self.items = {}

    def _k(self, key):
        return (key["pk"], key["sk"])

    def get_item(self, Key, **_):
        it = self.items.get(self._k(Key))
        return {"Item": copy.deepcopy(it)} if it else {}

    def put_item(self, Item, **_):
        _no_floats(Item, "put_item")
        self.items[(Item["pk"], Item["sk"])] = copy.deepcopy(Item)
        return {}

    def delete_item(self, Key, **_):
        self.items.pop(self._k(Key), None)
        return {}

    def batch_writer(self):
        table = self

        class W:
            def __enter__(s):
                return s

            def __exit__(s, *a):
                return False

            def put_item(s, Item):
                table.put_item(Item=Item)
        return W()

    @staticmethod
    def _resolve(token, names):
        return names.get(token, token) if token.startswith("#") else token

    def _cond_ok(self, item, expr, names, vals):
        for clause in expr.split(" AND "):
            clause = clause.strip()
            m = re.fullmatch(r"attribute_exists\((.+)\)", clause)
            if m:
                if item is None or self._resolve(m.group(1), names) not in item:
                    return False
                continue
            m = re.fullmatch(r"(\S+)\s*=\s*(:\w+)", clause)
            if not m:
                raise NotImplementedError(clause)
            if item is None or item.get(self._resolve(m.group(1), names)) != vals[m.group(2)]:
                return False
        return True

    def update_item(self, Key, UpdateExpression, ConditionExpression=None, ExpressionAttributeNames=None,
                    ExpressionAttributeValues=None, **_):
        names, vals = ExpressionAttributeNames or {}, ExpressionAttributeValues or {}
        _no_floats(vals, "update_item")
        if STATE["fail_next_updates"] > 0 and ConditionExpression:
            STATE["fail_next_updates"] -= 1
            raise _err("ConditionalCheckFailedException", "UpdateItem")
        item = self.items.get(self._k(Key))
        if ConditionExpression and not self._cond_ok(item, ConditionExpression, names, vals):
            raise _err("ConditionalCheckFailedException", "UpdateItem")
        if item is None:
            item = {"pk": Key["pk"], "sk": Key["sk"]}
            self.items[self._k(Key)] = item
        assert UpdateExpression.startswith("SET "), UpdateExpression
        for part in UpdateExpression[4:].split(", "):
            lhs, rhs = [p.strip() for p in part.split("=", 1)]
            path = [self._resolve(p, names) for p in lhs.split(".")]
            target = item
            for seg in path[:-1]:
                if not isinstance(target.get(seg), dict):
                    raise _err("ValidationException", "UpdateItem")
                target = target[seg]
            target[path[-1]] = copy.deepcopy(vals[rhs])
        return {}

    def query(self, IndexName, KeyConditionExpression, ExclusiveStartKey=None, **_):
        assert IndexName == "gsi1"
        found = [copy.deepcopy(i) for i in self.items.values()
                 if i.get("gsi1pk") == KeyConditionExpression.value]
        found.sort(key=lambda i: i["gsi1sk"])
        return {"Items": found}


class DynamoResource:
    def Table(self, _name):
        return STATE["table"]


class S3:
    def generate_presigned_post(self, bucket, key, Fields=None, Conditions=None, ExpiresIn=3600):
        return {"url": f"https://{bucket}.s3.amazonaws.com/",
                "fields": {**(Fields or {}), "key": key, "policy": "fake", "x-amz-signature": "fake"}}

    def get_object(self, Bucket, Key):
        data, ctype = STATE["s3"][(Bucket, Key)]
        return {"Body": io.BytesIO(data), "ContentType": ctype}


class Events:
    def put_events(self, Entries):
        STATE["events"].extend(Entries)
        return {"FailedEntryCount": 0}


class Rekognition:
    def detect_labels(self, Image, MaxLabels, MinConfidence):
        if STATE["rek_error"]:
            raise _err("AccessDeniedException", "DetectLabels")
        names = STATE["rek_labels"] if STATE["rek_labels"] is not None else ["Trash", "Bin"]
        return {"Labels": [{"Name": n, "Confidence": 95.0} for n in names]}


class SageMakerRuntime:
    def invoke_endpoint(self, EndpointName, ContentType, Body):
        if STATE["sm_error"]:
            raise _err("ModelError", "InvokeEndpoint")
        return {"Body": io.BytesIO(json.dumps(STATE["sm_response"]).encode())}


class StepFunctions:
    """Runs the same task handlers as the state machine, passing state through JSON like the service does."""

    def start_sync_execution(self, stateMachineArn, input):
        from smartwaste import planner

        def hop(fn, state):
            return json.loads(json.dumps(fn(state, None)))
        try:
            s = json.loads(input)
            for fn in (planner.load, planner.score, planner.select):
                s = hop(fn, s)
            if s["chosenCount"] > 0:
                s = hop(planner.route, s)
            s = hop(planner.save, s)
            return {"status": "SUCCEEDED", "output": json.dumps(s)}
        except Exception as exc:  # noqa: BLE001
            return {"status": "FAILED", "error": repr(exc)}


class Cognito:
    def admin_create_user(self, UserPoolId, Username, **_):
        if Username in STATE["users"]:
            raise _err("UsernameExistsException", "AdminCreateUser")
        STATE["users"][Username] = {}

    def admin_set_user_password(self, UserPoolId, Username, Password, Permanent):
        STATE["users"][Username]["password"] = Password

    def admin_add_user_to_group(self, UserPoolId, Username, GroupName):
        STATE["groups"].setdefault(Username, []).append(GroupName)


def client(name):
    return {"s3": S3, "events": Events, "rekognition": Rekognition, "sagemaker-runtime": SageMakerRuntime,
            "stepfunctions": StepFunctions, "cognito-idp": Cognito}[name]()


reset()
