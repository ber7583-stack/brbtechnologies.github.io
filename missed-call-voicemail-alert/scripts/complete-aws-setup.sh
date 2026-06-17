#!/usr/bin/env bash
set -euo pipefail
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
STACK="${STACK_NAME:-MissedCallVoicemailAlert}"

INBOUND_TOPIC=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='InboundSmsTopicArn'].OutputValue" --output text)
ORIGINATION="${ORIGINATION_IDENTITY:-+19452025796}"
SENDER_EMAIL="${SENDER_EMAIL:-ber7583@gmail.com}"

echo "=== SES verify $SENDER_EMAIL ==="
aws ses verify-email-identity --email-address "$SENDER_EMAIL" --region "$REGION" || true
aws ses get-identity-verification-attributes --identities "$SENDER_EMAIL" --region "$REGION"

echo "=== Enable two-way SMS on $ORIGINATION ==="
PHONE_NUM_ID=$(aws pinpoint-sms-voice-v2 describe-phone-numbers --region "$REGION" \
  --filters Name=PhoneNumber,Values="$ORIGINATION" --query 'PhoneNumbers[0].PhoneNumberId' --output text)
aws pinpoint-sms-voice-v2 update-phone-number --region "$REGION" \
  --phone-number-id "$PHONE_NUM_ID" --two-way-enabled --two-way-channel-arn "$INBOUND_TOPIC"

echo ""
echo "=== Stack outputs (for Gmail Apps Script) ==="
aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='WebhookUrl' || OutputKey=='WebhookSecret' || OutputKey=='GoogleVoiceNumber'].{Key:OutputKey,Value:OutputValue}" \
  --output table
