"""Deploy-time seeding. Runs once after every `cdk deploy` through a CDK Trigger.

Loads the demo neighbourhood if the table is empty. If DEMO_PASSWORD is set it also
creates two demo sign-ins. That password is published on the site, so only set it
for a competition demo.
"""
from __future__ import annotations

import os

import boto3
from botocore.exceptions import ClientError

from . import store

DEMO_USERS = [("demo.collector@smartwaste.example", True), ("demo.reporter@smartwaste.example", False)]


def _demo_users() -> list[str]:
    pool, pw = os.environ.get("USER_POOL_ID"), os.environ.get("DEMO_PASSWORD")
    if not (pool and pw):
        return []
    idp = boto3.client("cognito-idp")
    made = []
    for email, is_collector in DEMO_USERS:
        try:
            idp.admin_create_user(UserPoolId=pool, Username=email, MessageAction="SUPPRESS",
                                  UserAttributes=[{"Name": "email", "Value": email},
                                                  {"Name": "email_verified", "Value": "true"}])
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "UsernameExistsException":
                raise
        idp.admin_set_user_password(UserPoolId=pool, Username=email, Password=pw, Permanent=True)
        if is_collector:
            idp.admin_add_user_to_group(UserPoolId=pool, Username=email, GroupName="collectors")
        made.append(email)
    return made


def handler(event, _ctx):
    force = bool((event or {}).get("force"))
    return {"seeded": store.seed(force=force), "demoUsers": _demo_users()}
