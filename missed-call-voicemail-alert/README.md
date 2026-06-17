# Missed-call voicemail alert

Google Voice records voicemail → Gmail → AWS SMS/MMS alert with the **original caller's voice** attached.

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

Paste the latest code from [`google-voice/gmail-trigger.gs`](google-voice/gmail-trigger.gs) into [script.google.com](https://script.google.com) and add a **Time-driven** trigger for `checkForVoicemailEmails` every minute.

---

## Original voicemail audio (required once)

Google does **not** attach MP3s to voicemail emails. To get the **real caller's voice** (not a robot reading the transcript), AWS downloads it from Google Voice's internal API using a one-time browser login.

**On your computer** (with Chrome installed):

```bash
cd missed-call-voicemail-alert
pip install nodriver
python3 scripts/gv-session-login.py
```

1. A Chrome window opens → sign in as `ber7583@gmail.com`
2. Wait until you see the Google Voice inbox
3. The script saves cookies to `~/.googlevoice/session.json`

**Upload the session to AWS:**

```bash
bash scripts/upload-gv-session.sh
```

Re-run the login + upload every few months if recordings stop attaching (session expired).

---

## One AWS step (if SMS doesn’t arrive)

AWS is still in SMS sandbox. Finish verifying your phone once:

**AWS Console → End User Messaging → Verified destination numbers → +13477987583 → enter the code** texted to your phone.

---

## How it works

```
Cell (+13477987583)
  → unanswered → Google Voice (+17249126268)
  → voicemail email → ber7583@gmail.com
  → Gmail Apps Script → API Gateway → Lambda
      → Google Voice API (recordingUrl) → original MP3
  → SMS/MMS from +19452025796 + email with MP3 attachment
```

Reply **STOP** / **HELP** on `+19452025796` for 10DLC compliance.
