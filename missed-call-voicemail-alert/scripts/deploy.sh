#!/usr/bin/env bash
# Deploy missed-call-voicemail-alert stack (separate from PingTweets).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/infra"

if ! command -v aws >/dev/null 2>&1; then
  echo "AWS CLI is required. Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required for CDK."
  exit 1
fi

echo "=== Pre-flight: verify 10DLC ==="
bash "$ROOT/scripts/verify-10dlc.sh" || true

echo ""
echo "=== Installing CDK dependencies ==="
npm ci 2>/dev/null || npm install

echo ""
echo "=== Deploying stack ==="
npm run deploy

echo ""
echo "=== Post-deploy AWS setup ==="
bash "$ROOT/scripts/complete-aws-setup.sh"
