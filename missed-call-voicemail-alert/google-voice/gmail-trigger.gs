/**
 * Google Voice voicemail → AWS SMS alert
 *
 * Setup:
 * 1. script.google.com → New project → paste this code into Code.gs → Save
 * 2. Triggers → Add Trigger:
 *      Function: checkForVoicemailEmails
 *      Event source: Time-driven
 *      Type: Minutes timer → Every minute
 * 3. Approve permissions when asked
 */

const WEBHOOK_URL = "https://7wo4ekjym9.execute-api.us-east-1.amazonaws.com/webhook";
const WEBHOOK_SECRET = "JDZwDjkR62dt1RyMG6VEMW2Sq2BfHt99";
const PROCESSED_LABEL = "voicemail-sms-alerted";

/** Runs every minute via time trigger. Checks Gmail for new Google Voice voicemails. */
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

/** Run once manually (Run button) to test without waiting for the timer. */
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
  const code = res.getResponseCode();
  const body = res.getContentText();
  Logger.log("AWS response: " + code + " " + body);
  if (code !== 200) {
    throw new Error("SMS alert failed (" + code + "): " + body);
  }
}

function ensureLabel_() {
  const labels = GmailApp.getUserLabels();
  for (const label of labels) {
    if (label.getName() === PROCESSED_LABEL) return;
  }
  GmailApp.createLabel(PROCESSED_LABEL);
}

function wasProcessed_(messageId) {
  const key = "processed:" + messageId;
  return PropertiesService.getScriptProperties().getProperty(key) === "1";
}

function markProcessed_(thread, messageId) {
  const label = GmailApp.getUserLabelByName(PROCESSED_LABEL);
  if (label) thread.addLabel(label);
  PropertiesService.getScriptProperties().setProperty("processed:" + messageId, "1");
}
