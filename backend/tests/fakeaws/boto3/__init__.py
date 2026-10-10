"""Stand-in for boto3 so the Lambda code can run with no AWS and no pip installs.
Only what smartwaste uses. Real behaviour is checked by scripts/smoke.py after deploy."""
import awsfake


def resource(name, **_kw):
    assert name == "dynamodb", name
    return awsfake.DynamoResource()


def client(name, **_kw):
    return awsfake.client(name)
