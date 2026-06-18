#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
STACK="${STACK_NAME:-MissedCallVoicemailAlert}"
SESSION_FILE="${1:-$HOME/.googlevoice/session.json}"

if [[ ! -f "$SESSION_FILE" ]]; then
  echo "Session file not found: $SESSION_FILE"
  echo "Run: python3 scripts/gv-session-login.py"
  exit 1
fi

SECRET_ARN=$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK" --region "$REGION" \
  --logical-resource-id GvSessionSecret \
  --query 'StackResources[0].PhysicalResourceId' --output text 2>/dev/null || true)

if [[ -z "$SECRET_ARN" || "$SECRET_ARN" == "None" ]]; then
  echo "GvSessionSecret not found in stack $STACK — deploy the updated stack first."
  exit 1
fi

aws secretsmanager put-secret-value \
  --secret-id "$SECRET_ARN" \
  --region "$REGION" \
  --secret-string "file://$SESSION_FILE"

echo "Uploaded Google Voice session to AWS Secrets Manager."
echo "Original voicemail recordings will now be attached to alerts."
