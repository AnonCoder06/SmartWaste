#!/usr/bin/env bash
# Give an existing account the collector role. Usage: scripts/make-collector.sh you@example.com
set -euo pipefail
cd "$(dirname "$0")/.."
EMAIL="${1:?Usage: scripts/make-collector.sh you@example.com}"
POOL="$(python3 -c "import json;print(json.load(open('cdk-outputs.json'))['SmartWaste']['UserPoolId'])")"
aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL" --username "$EMAIL" --group-name collectors
echo "$EMAIL is now a collector. They need to sign out and back in to pick up the role."
