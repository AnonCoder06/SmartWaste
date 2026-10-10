#!/usr/bin/env bash
# One command from a fresh AWS account to a live URL.
#
#   scripts/deploy.sh
#
# Optional environment variables:
#   AWS_REGION         where to deploy (default: your CLI region, else us-east-1)
#   ALERT_EMAIL        email overflow warnings and the nightly plan here (confirm the SNS email after deploy)
#   SAGEMAKER_ENDPOINT name of a SageMaker endpoint the photo analyzer should ask first
#   DOMAIN_NAME, HOSTED_ZONE_NAME   serve from your own Route 53 domain (forces us-east-1)
set -euo pipefail
cd "$(dirname "$0")/.."

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing '$1'. $2" >&2; exit 1; }; }
need node "Install Node.js 20 or newer from https://nodejs.org"
need npm  "It ships with Node.js."
need python3 "Install Python 3.9 or newer."
need aws "Install the AWS CLI v2, then run: aws configure   (or use AWS CloudShell, which has everything)"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" || {
  echo "No AWS credentials found. Run 'aws configure', or open AWS CloudShell." >&2; exit 1; }
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
REGION="${REGION:-us-east-1}"
[ -n "${DOMAIN_NAME:-}" ] && REGION="us-east-1"
export CDK_DEFAULT_ACCOUNT="$ACCOUNT" CDK_DEFAULT_REGION="$REGION"
echo "Deploying SmartWaste to account $ACCOUNT in $REGION"

if python3 -c "import PIL" 2>/dev/null; then
  echo "Running backend tests first..."
  python3 -m unittest discover -s backend/tests -p "test_*.py" 2>&1 | tail -3
fi

scripts/build-layer.sh
( cd infra && npm install --no-audit --no-fund )

CTX=()
[ -n "${ALERT_EMAIL:-}" ]         && CTX+=(-c "alertEmail=$ALERT_EMAIL")
[ -n "${SAGEMAKER_ENDPOINT:-}" ]  && CTX+=(-c "sagemakerEndpoint=$SAGEMAKER_ENDPOINT")
[ -n "${DOMAIN_NAME:-}" ]         && CTX+=(-c "domainName=$DOMAIN_NAME" -c "hostedZoneName=${HOSTED_ZONE_NAME:?Set HOSTED_ZONE_NAME with DOMAIN_NAME}")

( cd infra
  npx cdk bootstrap "aws://$ACCOUNT/$REGION"
  npx cdk deploy --require-approval never --outputs-file ../cdk-outputs.json ${CTX[@]+"${CTX[@]}"} )

URL="$(python3 -c "import json;print(json.load(open('cdk-outputs.json'))['SmartWaste']['SiteUrl'])")"
echo
echo "Live at: $URL"
echo "Running the smoke test against the live site..."
python3 scripts/smoke.py "$URL" --reset
