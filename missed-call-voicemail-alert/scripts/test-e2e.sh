#!/usr/bin/env bash
# End-to-end test helper: invoke ProcessVoicemail Lambda with a sample WAV.
# For a full live test, forward a real call to Connect and leave voicemail.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK_NAME:-MissedCallVoicemailAlert}"

echo "=== Fetching stack outputs ==="
OUTPUTS=$(aws cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name "$STACK" \
  --query "Stacks[0].Outputs" \
  --output json)

RECORDINGS_BUCKET=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey=="RecordingsBucket") | .OutputValue')
FUNCTION_NAME=$(aws cloudformation list-stack-resources \
  --region "$REGION" \
  --stack-name "$STACK" \
  --query "StackResourceSummaries[?LogicalResourceId=='ProcessVoicemail'].PhysicalResourceId" \
  --output text)

if [[ -z "$RECORDINGS_BUCKET" || "$RECORDINGS_BUCKET" == "null" ]]; then
  echo "Stack not deployed. Run scripts/deploy.sh first."
  exit 1
fi

CONTACT_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
TEST_KEY="connect/test/CallRecordings/$(date +%Y/%m/%d)/${CONTACT_ID}_UTC.wav"
TMP_WAV=$(mktemp /tmp/test-vm-XXXXXX.wav)

echo "=== Generating short test WAV (5 sec silence) ==="
if command -v ffmpeg >/dev/null 2>&1; then
  ffmpeg -y -f lavfi -i anullsrc=r=8000:cl=mono -t 5 -acodec pcm_s16le "$TMP_WAV" 2>/dev/null
else
  python3 - "$TMP_WAV" <<'PY'
import struct, sys, wave
path = sys.argv[1]
with wave.open(path, "w") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(8000)
    w.writeframes(struct.pack("<h", 0) * 8000 * 5)
PY
fi

echo "=== Uploading to s3://$RECORDINGS_BUCKET/$TEST_KEY ==="
aws s3 cp "$TMP_WAV" "s3://$RECORDINGS_BUCKET/$TEST_KEY"
rm -f "$TMP_WAV"

echo "=== Waiting for Lambda (S3 event) ==="
sleep 8

echo "=== Recent Lambda logs ==="
aws logs tail "/aws/lambda/$FUNCTION_NAME" --region "$REGION" --since 2m || true

echo ""
echo "=== Live test ==="
echo "Call your cell (+13477987583), let it ring without answering,"
echo "leave a voicemail on the Connect DID, and confirm MMS/SMS arrives."
