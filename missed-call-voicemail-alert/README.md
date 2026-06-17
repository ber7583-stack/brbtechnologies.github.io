# Missed-call voicemail alert

Standalone — not PingTweets.

**Every voicemail → email with MP3 attached** (play on any device). Phone gets MMS if small enough, else a short text pointing to email. No links.

## Flow

Missed call → Connect DID → voicemail → S3 → Lambda → **email + MMS/SMS**

## Setup

1. Edit `config/defaults.json` — set `recipientEmail` and `senderEmail` (verify sender in SES console).
2. `bash scripts/deploy.sh`
3. Connect console: claim DID, enable recordings, assign **MissedCallVoicemail** flow.
4. Phone: forward **when unanswered** to Connect DID (~25s ring).
5. End User Messaging: wire inbound SMS to SNS topic from stack output.

## Phone vs email

| Channel | What you get |
|---------|--------------|
| **Email** | Always — MP3 attachment, any size up to SES limits |
| **Phone** | MMS with audio if ≤600 KB, else text only ("check email") |

Max voicemail: **60 seconds** recommended.

## Cost

~$2–4/mo at low volume (Connect DID + MMS + SES).

## Verify 10DLC

`bash scripts/verify-10dlc.sh` — confirm `+19452025796` is Active with MMS, campaign `CJDA4Y5`.
