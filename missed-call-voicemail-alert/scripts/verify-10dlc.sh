#!/usr/bin/env bash
# Verify AWS 10DLC assets before deploying missed-call alerts.
# Does not modify PingTweets or any other project.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ORIGINATION="${ORIGINATION_IDENTITY:-+19452025796}"
CAMPAIGN="${CAMPAIGN_ID:-CJDA4Y5}"
BRAND="${BRAND_ID:-B9JC7EP}"

echo "=== Verifying 10DLC assets in $REGION ==="

echo ""
echo "1. Phone number status and MMS capability ($ORIGINATION)"
aws pinpoint-sms-voice-v2 describe-phone-numbers \
  --region "$REGION" \
  --filters "PhoneNumber=${ORIGINATION}" \
  --output table

echo ""
echo "2. Campaign registration ($CAMPAIGN)"
aws pinpoint-sms-voice-v2 describe-registration \
  --region "$REGION" \
  --registration-id "$CAMPAIGN" \
  --output json 2>/dev/null || \
  echo "   (List registrations if describe-registration ID differs in your account)"

echo ""
echo "3. Brand registration ($BRAND)"
aws pinpoint-sms-voice-v2 describe-registration \
  --region "$REGION" \
  --registration-id "$BRAND" \
  --output json 2>/dev/null || true

echo ""
echo "=== Manual checks (console) ==="
cat <<'EOF'
- End User Messaging → Phone numbers → +19452025796:
    Status = Active (not Pending)
    Capabilities include MMS (US)
    Associated campaign = CJDA4Y5
- Campaign CJDA4Y5:
    Status = Complete
    Use case = transactional / notifications (not marketing)
    MMS sample files uploaded if required at registration
- Brand B9JC7EP: Status = Complete
- Sandbox: if account is still in SMS sandbox, add +13477987583 as verified destination
EOF
