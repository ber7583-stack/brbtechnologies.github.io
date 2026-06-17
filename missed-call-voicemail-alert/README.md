# Missed-call voicemail alert

Standalone — not PingTweets.

Every voicemail → **email with MP3** + phone MMS/text. No links.

## Deploy (agent does this)

```bash
cd missed-call-voicemail-alert/infra && npm ci && npm run deploy
```

CDK handles Connect DID, recordings, contact flow, SES, inbound SMS.

## You only do (phone + email)

1. **Gmail** — click AWS SES verification link for `ber7583@gmail.com`
2. **Verizon** — forward unanswered calls to **ConnectInboundDid** (stack output):
   - `*71` + DID + `#`
   - Turn off Verizon voicemail first (`*86`)

## Greeting

> The person you called at 3 4 7, 7 9 8, 7 5 8 3 is not available. Please leave a message after the tone.
