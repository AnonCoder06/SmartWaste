#!/usr/bin/env bash
# Fastest possible live URL: the front end alone, hosted on S3 static website hosting.
# No backend, no sign-in. The page runs its built-in offline demo (the model runs in the browser).
# Use scripts/deploy.sh for the full AWS system.
#
#   scripts/deploy-s3-only.sh              create the bucket and upload
#   scripts/deploy-s3-only.sh --destroy    delete it
set -euo pipefail
cd "$(dirname "$0")/.."
command -v aws >/dev/null || { echo "Install the AWS CLI, or use AWS CloudShell." >&2; exit 1; }
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)" || { echo "No AWS credentials." >&2; exit 1; }
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
REGION="${REGION:-us-east-1}"
BUCKET="smartwaste-site-${ACCOUNT}-${REGION}"

if [ "${1:-}" = "--destroy" ]; then
  aws s3 rb "s3://$BUCKET" --force --region "$REGION"; echo "Deleted $BUCKET"; exit 0
fi

if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  if [ "$REGION" = "us-east-1" ]; then aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null; fi
fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"PublicRead\",\"Effect\":\"Allow\",\"Principal\":\"*\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\"}]}"
aws s3 website "s3://$BUCKET" --index-document index.html
# no config.json on purpose: without it the page uses its offline demo
aws s3 sync frontend "s3://$BUCKET" --delete --exclude "config.json" --cache-control "no-cache"

case "$REGION" in
  us-east-1|us-west-1|us-west-2|eu-west-1|ap-southeast-1|ap-southeast-2|ap-northeast-1|sa-east-1) SEP="-" ;;
  *) SEP="." ;;
esac
echo
echo "Live at: http://${BUCKET}.s3-website${SEP}${REGION}.amazonaws.com"
