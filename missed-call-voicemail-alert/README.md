# Missed-call voicemail alert

Google Voice records voicemail → Gmail → AWS SMS alert to your phone.

## Your phone setup (3 steps)

### 1. Verizon — forward unanswered calls to Google Voice

Dial on your cell (`+13477987583`):

```
*71*7249126268#
```

Turn off Verizon voicemail: dial `*86` and follow prompts.

### 2. Google Voice — voicemail to email

In [voice.google.com](https://voice.google.com) → Settings → Voicemail → turn on **Get voicemail via email**.

### 3. Gmail Apps Script — trigger SMS alert

1. Open [script.google.com](https://script.google.com) → **New project**
2. Paste `google-voice/gmail-trigger.gs`
3. Set `WEBHOOK_URL` and `WEBHOOK_SECRET` from deploy output (below)
4. **Triggers** → Add → `triggerVoicemailAlert` → From Gmail → email received
5. Filter: `from:(txt.voice.google.com OR voice-noreply@google.com)`

## Deploy output

After deploy, note these values:

| Output | Use |
|--------|-----|
| `WebhookUrl` | Apps Script `WEBHOOK_URL` |
| `WebhookSecret` | Apps Script `WEBHOOK_SECRET` |
| `GoogleVoiceNumber` | `+17249126268` — Verizon forward target |

Run `bash scripts/deploy.sh` or GitHub Actions **Deploy missed-call voicemail**.

## How it works

```
Cell (+13477987583)
  → unanswered → Google Voice (+17249126268)
  → voicemail email → ber7583@gmail.com
  → Gmail Apps Script → API Gateway → Lambda
  → SMS from +19452025796 to +13477987583
```

Voicemail audio stays in your Gmail. SMS tells you who called and when.

Reply **STOP** / **HELP** on `+19452025796` for 10DLC compliance.
