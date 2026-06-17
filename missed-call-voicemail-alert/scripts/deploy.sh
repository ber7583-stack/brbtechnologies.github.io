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
echo "=== Post-deploy manual steps ==="
cat <<'EOF'
1. Amazon Connect console → your new instance:
   - Claim a US DID (inbound voicemail number, ~$1/mo)
   - Data storage → Call recordings → enable, point to RecordingsBucket output
   - Phone numbers → assign MissedCallVoicemail contact flow to the DID
2. End User Messaging → Phone numbers → +19452025796:
   - Two-way SMS → inbound messages → SNS topic (InboundSmsTopicArn output)
3. On your cell phone (+13477987583):
   - Settings → Phone → Call Forwarding → No Answer → Connect DID
   - Use 20–25 second ring delay so you can answer locally first
4. Run: bash scripts/test-e2e.sh
EOF
