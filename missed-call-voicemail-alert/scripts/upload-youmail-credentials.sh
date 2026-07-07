#!/usr/bin/env bash
# Store YouMail phone + PIN in AWS Secrets Manager for voicemail download.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACK="MissedCallVoicemailAlert"

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <phone> <pin>"
  echo "Example: $0 3477987583 1234"
  echo ""
  echo "Phone: your YouMail account phone number"
  echo "PIN: numeric voicemail PIN from YouMail settings"
  exit 1
fi

PHONE="$1"
PIN="$2"

SECRET_ARN=$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK" \
  --region "$REGION" \
  --query "StackResources[?LogicalResourceId=='YoumailSessionSecret'].PhysicalResourceId" \
  --output text)

if [[ -z "$SECRET_ARN" || "$SECRET_ARN" == "None" ]]; then
  echo "Could not find YoumailSessionSecret in stack $STACK"
  exit 1
fi

PAYLOAD=$(jq -n --arg phone "$PHONE" --arg pin "$PIN" '{phone: $phone, pin: $pin}')

aws secretsmanager put-secret-value \
  --secret-id "$SECRET_ARN" \
  --secret-string "$PAYLOAD" \
  --region "$REGION"

echo "YouMail credentials saved to $SECRET_ARN"
