#!/usr/bin/env bash
set -euo pipefail
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
STACK="${STACK_NAME:-MissedCallVoicemailAlert}"

INSTANCE_ARN=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ConnectInstanceArn'].OutputValue" --output text)
RECORDINGS_BUCKET=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='RecordingsBucket'].OutputValue" --output text)
INBOUND_TOPIC=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='InboundSmsTopicArn'].OutputValue" --output text)
ORIGINATION="${ORIGINATION_IDENTITY:-+19452025796}"
SENDER_EMAIL="${SENDER_EMAIL:-ber7583@gmail.com}"
INSTANCE_ID="${INSTANCE_ARN##*/instance/}"

echo "=== SES verify $SENDER_EMAIL ==="
aws ses verify-email-identity --email-address "$SENDER_EMAIL" --region "$REGION" || true
aws ses get-identity-verification-attributes --identities "$SENDER_EMAIL" --region "$REGION"

echo "=== Connect recordings storage ==="
if ! aws connect list-instance-storage-configs --instance-id "$INSTANCE_ID" --resource-type CALL_RECORDINGS --region "$REGION" --query 'StorageConfigs[0].AssociationId' --output text 2>/dev/null | grep -q .; then
  aws connect associate-instance-storage-config --instance-id "$INSTANCE_ID" --resource-type CALL_RECORDINGS \
    --storage-config "StorageType=S3,S3Config={BucketName=$RECORDINGS_BUCKET,BucketPrefix=connect/recordings/}" \
    --region "$REGION"
fi

echo "=== Claim Connect DID ==="
PHONE=$(aws connect list-phone-numbers-v2 --target-arn "$INSTANCE_ARN" --region "$REGION" \
  --query 'ListPhoneNumbersSummaryList[0].PhoneNumber' --output text 2>/dev/null || true)
if [[ -z "$PHONE" || "$PHONE" == "None" ]]; then
  AVAILABLE=$(aws connect search-available-phone-numbers --target-arn "$INSTANCE_ARN" \
    --phone-number-country-code US --phone-number-type DID --max-results 1 --region "$REGION" \
    --query 'AvailableNumbersList[0].PhoneNumber' --output text)
  CLAIM=$(aws connect claim-phone-number --target-arn "$INSTANCE_ARN" --phone-number "$AVAILABLE" \
    --phone-number-description "Missed-call voicemail inbound" --region "$REGION")
  PHONE=$(echo "$CLAIM" | jq -r '.PhoneNumber // empty')
  PHONE_ID=$(echo "$CLAIM" | jq -r '.PhoneNumberId')
  if [[ -z "$PHONE" || "$PHONE" == "null" ]]; then
    for _ in $(seq 1 18); do
      PHONE=$(aws connect describe-phone-number --phone-number-id "$PHONE_ID" --region "$REGION" \
        --query 'ClaimedPhoneNumberSummary.PhoneNumber' --output text 2>/dev/null || true)
      STATUS=$(aws connect describe-phone-number --phone-number-id "$PHONE_ID" --region "$REGION" \
        --query 'ClaimedPhoneNumberSummary.PhoneNumberStatus.Status' --output text 2>/dev/null || true)
      [[ "$STATUS" == "CLAIMED" || "$STATUS" == "ACQUIRED" ]] && break
      sleep 10
    done
  fi
else
  PHONE_ID=$(aws connect list-phone-numbers-v2 --target-arn "$INSTANCE_ARN" --region "$REGION" \
    --query 'ListPhoneNumbersSummaryList[0].PhoneNumberId' --output text)
fi

echo "=== Assign voicemail contact flow ==="
FLOW_ID=$(aws connect list-contact-flows --instance-id "$INSTANCE_ID" --contact-flow-types CONTACT_FLOW \
  --region "$REGION" --query "ContactFlowSummaryList[?Name=='MissedCallVoicemail'].Id" --output text)
aws connect associate-phone-number-contact-flow --instance-id "$INSTANCE_ID" \
  --phone-number-id "$PHONE_ID" --contact-flow-id "$FLOW_ID" --region "$REGION"

echo "=== Enable two-way SMS on $ORIGINATION ==="
PHONE_NUM_ID=$(aws pinpoint-sms-voice-v2 describe-phone-numbers --region "$REGION" \
  --filters Name=PhoneNumber,Values="$ORIGINATION" --query 'PhoneNumbers[0].PhoneNumberId' --output text)
aws pinpoint-sms-voice-v2 update-phone-number --region "$REGION" \
  --phone-number-id "$PHONE_NUM_ID" --two-way-enabled --two-way-channel-arn "$INBOUND_TOPIC"

echo ""
echo "============================================"
echo "CONNECT DID (forward Verizon unanswered): $PHONE"
echo "============================================"
