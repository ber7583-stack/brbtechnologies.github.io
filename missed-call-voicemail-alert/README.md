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

This is a small program that lives inside your Gmail account. When Google Voice emails you a voicemail, it automatically tells AWS to text your phone.

**Step A — Open the editor**

1. Go to [script.google.com](https://script.google.com) in your browser (use the same Google account as `ber7583@gmail.com`)
2. Click the blue **New project** button (top left)
3. You’ll see a blank file called `Code.gs` with a few lines of sample code
4. Click inside that file, press **Ctrl+A** (or **Cmd+A** on Mac) to select everything, then **Delete** so the file is empty

**Step B — Paste this code**

Copy **all** of the code below (from `const WEBHOOK_URL` through the last `}`) and paste it into the empty `Code.gs` file:

```javascript
const WEBHOOK_URL = "https://7wo4ekjym9.execute-api.us-east-1.amazonaws.com/webhook";
const WEBHOOK_SECRET = "JDZwDjkR62dt1RyMG6VEMW2Sq2BfHt99";

function triggerVoicemailAlert(e) {
  if (!e || !e.messages || e.messages.length === 0) return;

  const msg = e.messages[0];
  const subject = msg.getSubject() || "";
  const snippet = msg.getPlainBody().substring(0, 500);
  const from = msg.getFrom() || "";

  if (!/voice\.google|txt\.voice\.google/i.test(from + subject)) return;

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
```

5. Click the **Save** icon (floppy disk) or press **Ctrl+S**
6. Name the project something like `Voicemail SMS Alert` when prompted

**Step C — Turn it on (add a trigger)**

1. In the left sidebar, click the **clock icon** labeled **Triggers**
2. Click **+ Add Trigger** (bottom right)
3. Fill in exactly:
   - **Choose which function to run:** `triggerVoicemailAlert`
   - **Choose which deployment should run:** `Head`
   - **Select event source:** `From Gmail`
   - **Select event type:** `Email received`
   - **Gmail account:** your `ber7583@gmail.com` account
   - **Error notification settings:** `Notify me immediately` (recommended)
4. Click **Save**
5. Google will ask you to **Allow** permissions — click through and approve (this lets the script read new Gmail messages and send the alert)

**Step D — Test it**

Leave yourself a voicemail on Google Voice. Within a minute you should get an SMS on `347-798-7583` saying who called.

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
