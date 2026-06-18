#!/usr/bin/env bash
set -euo pipefail
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
STACK="${STACK_NAME:-MissedCallVoicemailAlert}"

outputs() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

INBOUND_TOPIC=$(outputs InboundSmsTopicArn)
ORIGINATION="${ORIGINATION_IDENTITY:-+19452025796}"
SENDER_EMAIL="${SENDER_EMAIL:-ber7583@gmail.com}"
WEBHOOK_URL=$(outputs WebhookUrl)
SECRET_ARN=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --logical-resource-id GvWebhookSecret57F9EBF6 \
  --query 'StackResources[0].PhysicalResourceId' --output text)
WEBHOOK_SECRET=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --region "$REGION" \
  --query SecretString --output text)
GV_NUMBER=$(outputs GoogleVoiceNumber)

echo "=== SES verify $SENDER_EMAIL ==="
aws ses verify-email-identity --email-address "$SENDER_EMAIL" --region "$REGION" || true
aws ses get-identity-verification-attributes --identities "$SENDER_EMAIL" --region "$REGION"

echo "=== Enable two-way SMS on $ORIGINATION ==="
PHONE_NUM_ID=$(aws pinpoint-sms-voice-v2 describe-phone-numbers --region "$REGION" \
  --query "PhoneNumbers[?PhoneNumber=='$ORIGINATION'].PhoneNumberId | [0]" --output text)
aws pinpoint-sms-voice-v2 update-phone-number --region "$REGION" \
  --phone-number-id "$PHONE_NUM_ID" --two-way-enabled --two-way-channel-arn "$INBOUND_TOPIC"

echo ""
echo "============================================"
echo "GOOGLE VOICE: forward Verizon unanswered to $GV_NUMBER"
echo "Verizon dial: *71*7249126268#"
echo ""
echo "Gmail Apps Script (google-voice/gmail-trigger.gs):"
echo "  WEBHOOK_URL    = $WEBHOOK_URL"
echo "  WEBHOOK_SECRET = $WEBHOOK_SECRET"
echo ""
echo "ORIGINAL VOICEMAIL AUDIO (one-time on your computer):"
echo "  pip install nodriver"
echo "  python3 scripts/gv-session-login.py"
echo "  bash scripts/upload-gv-session.sh"
echo "============================================"
