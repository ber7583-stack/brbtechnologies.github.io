# Cursor Cloud Agent instructions

## Do NOT deploy GitHub Pages for voicemail tasks

This repo also contains `missed-call-voicemail-alert/` — a separate AWS project.

## To deploy missed-call voicemail alerts

1. Verify AWS creds: `aws sts get-caller-identity`
2. Deploy:
   ```bash
   cd missed-call-voicemail-alert/infra && npm ci && npm run deploy
   ```
3. Post-deploy (AWS console/CLI):
   - SES: verify `ber7583@gmail.com`
   - Connect: claim US DID, enable recordings → S3 bucket from stack output, assign **MissedCallVoicemail** flow
   - End User Messaging: inbound SMS on +19452025796 → SNS topic from stack output

Region: `us-east-1`
