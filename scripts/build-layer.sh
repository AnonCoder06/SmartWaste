#!/usr/bin/env bash
# Builds the Lambda layer that holds Pillow. Downloads the Linux wheel for Lambda's runtime,
# so it works from macOS, Windows (Git Bash/WSL) and Linux with no Docker.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf backend/layer
mkdir -p backend/layer/python
python3 -m pip install --quiet --upgrade --only-binary=:all: \
  --platform manylinux2014_x86_64 --platform manylinux_2_28_x86_64 \
  --implementation cp --python-version 3.12 \
  --target backend/layer/python "Pillow>=10"
find backend/layer -name "__pycache__" -type d -prune -exec rm -rf {} + 2>/dev/null || true
echo "Pillow layer ready: $(du -sh backend/layer | cut -f1)"
