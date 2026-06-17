# Cursor Cloud Agent instructions

## Do NOT deploy GitHub Pages for voicemail tasks

Deploy `missed-call-voicemail-alert/` to AWS only.

```bash
aws sts get-caller-identity
cd missed-call-voicemail-alert/infra && npm ci && npm run deploy
```

CDK automates: Connect DID, recordings bucket, contact flow, SES identity, inbound SMS → SNS.

**User only does:** click SES verification email + Verizon call forward to `ConnectInboundDid` output.

Region: `us-east-1`
