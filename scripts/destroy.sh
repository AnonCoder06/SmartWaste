#!/usr/bin/env bash
# Remove everything SmartWaste created, so nothing keeps costing money.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backend/layer/python   # synth needs the folder to exist, its contents do not matter here
( cd infra && npm install --no-audit --no-fund && npx cdk destroy --force )
rm -f cdk-outputs.json
echo "SmartWaste removed. The CDK bootstrap stack (CDKToolkit) is shared and was left in place."
