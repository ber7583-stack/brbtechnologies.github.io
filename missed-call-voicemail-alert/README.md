# Missed-call voicemail alert

## One-time setup (you do this once, not per agent)

### 1. GitHub secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
|------|--------|
| `AWS_ACCESS_KEY_ID` | your key |
| `AWS_SECRET_ACCESS_KEY` | your secret |

### 2. Deploy
Merge PR to `main`, or run **Actions → Deploy missed-call voicemail → Run workflow**.

No Cursor agent needed for deploy after this.

---

## You only do on phone/email

1. **Gmail** — click AWS SES verification link for `ber7583@gmail.com`
2. **Verizon** — `*71` + Connect DID from GitHub Actions output + `#`
3. Turn off Verizon voicemail (`*86`)

## What CDK deploys automatically

Connect DID, voicemail flow, recordings bucket, SES identity, inbound SMS → SNS, email + MMS alerts.
