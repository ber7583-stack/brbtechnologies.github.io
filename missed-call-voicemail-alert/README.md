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

This is a small program inside your Gmail. Every minute it checks for new Google Voice voicemail emails and texts your phone.

> **Note:** Google removed the old “From Gmail” trigger. Use **Time-driven** instead (checks every minute).

**Step A — Open the editor**

1. Go to [script.google.com](https://script.google.com) (log in as `ber7583@gmail.com`)
2. Click **New project**
3. Select all text in `Code.gs` (**Ctrl+A** / **Cmd+A**) and **Delete**

**Step B — Paste this code**

Copy everything below and paste into `Code.gs`:

```javascript
const WEBHOOK_URL = "https://7wo4ekjym9.execute-api.us-east-1.amazonaws.com/webhook";
const WEBHOOK_SECRET = "JDZwDjkR62dt1RyMG6VEMW2Sq2BfHt99";
const PROCESSED_LABEL = "voicemail-sms-alerted";

function checkForVoicemailEmails() {
  ensureLabel_();
  const query =
    "from:(txt.voice.google.com OR voice-noreply@google.com) newer_than:2d -label:" +
    PROCESSED_LABEL;
  const threads = GmailApp.search(query, 0, 20);
  for (const thread of threads) {
    const messages = thread.getMessages();
    for (const msg of messages) {
      if (!isVoicemailEmail_(msg) || wasProcessed_(msg.getId())) continue;
      sendAlert_(msg);
      markProcessed_(thread, msg.getId());
    }
  }
}

function testCheckNow() {
  checkForVoicemailEmails();
}

function isVoicemailEmail_(msg) {
  const from = msg.getFrom() || "";
  const subject = msg.getSubject() || "";
  return /voice\.google|txt\.voice\.google/i.test(from + subject);
}

function sendAlert_(msg) {
  const subject = msg.getSubject() || "";
  const snippet = msg.getPlainBody().substring(0, 500);
  const callerMatch = (subject + " " + snippet).match(
    /\+?1?\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/
  );
  const payload = {
    caller: callerMatch ? callerMatch[0] : "Unknown",
    subject: subject,
    snippet: snippet,
  };
  const options = {
    method: "post",
    contentType: "application/json",
    headers: { "X-Webhook-Secret": WEBHOOK_SECRET },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
  const res = UrlFetchApp.fetch(WEBHOOK_URL, options);
  Logger.log(res.getResponseCode() + " " + res.getContentText());
}

function ensureLabel_() {
  const labels = GmailApp.getUserLabels();
  for (const label of labels) {
    if (label.getName() === PROCESSED_LABEL) return;
  }
  GmailApp.createLabel(PROCESSED_LABEL);
}

function wasProcessed_(messageId) {
  return PropertiesService.getScriptProperties().getProperty("processed:" + messageId) === "1";
}

function markProcessed_(thread, messageId) {
  const label = GmailApp.getUserLabelByName(PROCESSED_LABEL);
  if (label) thread.addLabel(label);
  PropertiesService.getScriptProperties().setProperty("processed:" + messageId, "1");
}
```

4. Click **Save** (floppy disk icon)
5. Name the project `Voicemail SMS Alert`

**Step C — Add the trigger (what you see in your screenshot)**

1. Click the **clock icon** (Triggers) on the left
2. Click **+ Add Trigger**
3. Set these exactly:

| Field | Pick this |
|-------|-----------|
| Choose which function to run | `checkForVoicemailEmails` |
| Choose which deployment should run | `Head` |
| Select event source | **Time-driven** |
| Select type of time based trigger | **Minutes timer** |
| Select minute interval | **Every minute** |
| Failure notification settings | Notify me immediately |

4. Click **Save**
5. Google asks for permission → click **Allow** (lets it read Gmail and send the alert)

**Step D — Test it**

1. At the top, change the function dropdown from `checkForVoicemailEmails` to **`testCheckNow`**
2. Click **Run** (play button) — approve permissions if asked again
3. Leave yourself a Google Voice voicemail, wait up to 1 minute, check for SMS on `347-798-7583`

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
  → SMS from +19452025796 to +13477987583
```

Voicemail audio stays in your Gmail. SMS tells you who called and when.

Reply **STOP** / **HELP** on `+19452025796` for 10DLC compliance.
