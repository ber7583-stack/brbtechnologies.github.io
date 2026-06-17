/**
 * Google Voice missed calls + voicemails → AWS SMS + email alerts
 *
 * Trigger: Time-driven → checkForVoicemailEmails → Every minute
 */

const WEBHOOK_URL = "https://7wo4ekjym9.execute-api.us-east-1.amazonaws.com/webhook";
const WEBHOOK_SECRET = "JDZwDjkR62dt1RyMG6VEMW2Sq2BfHt99";
const PROCESSED_LABEL = "voicemail-sms-alerted";

/** Runs every minute. Checks Gmail for Google Voice missed-call and voicemail emails. */
function checkForVoicemailEmails() {
  ensureLabel_();

  const query =
    "from:(txt.voice.google.com OR voice-noreply@google.com) newer_than:2d -label:" +
    PROCESSED_LABEL;
  const threads = GmailApp.search(query, 0, 20);

  for (const thread of threads) {
    const messages = thread.getMessages();
    for (const msg of messages) {
      if (!isGoogleVoiceEmail_(msg) || wasProcessed_(msg.getId())) continue;
      sendAlert_(msg);
      markProcessed_(thread, msg.getId());
    }
  }
}

/** Run manually from the editor to test right away. */
function testCheckNow() {
  checkForVoicemailEmails();
}

function isGoogleVoiceEmail_(msg) {
  const from = msg.getFrom() || "";
  const subject = msg.getSubject() || "";
  const text = (from + " " + subject).toLowerCase();
  return (
    /voice\.google|txt\.voice\.google/.test(text) &&
    (/missed call|voicemail|voice message|new text message from/.test(
      (subject + " " + msg.getPlainBody().substring(0, 300)).toLowerCase()
    ))
  );
}

function detectAlertType_(subject, snippet) {
  const text = (subject + " " + snippet).toLowerCase();
  if (/voicemail|voice message/.test(text)) return "voicemail";
  if (/missed call/.test(text)) return "missed_call";
  return "missed_call";
}

function sendAlert_(msg) {
  const subject = msg.getSubject() || "";
  const snippet = msg.getPlainBody().substring(0, 500);
  const callerMatch = (subject + " " + snippet).match(
    /\+?1?\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/
  );

  const payload = {
    alertType: detectAlertType_(subject, snippet),
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
    throw new Error("Alert failed (" + code + "): " + body);
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
  return (
    PropertiesService.getScriptProperties().getProperty("processed:" + messageId) ===
    "1"
  );
}

function markProcessed_(thread, messageId) {
  const label = GmailApp.getUserLabelByName(PROCESSED_LABEL);
  if (label) thread.addLabel(label);
  PropertiesService.getScriptProperties().setProperty("processed:" + messageId, "1");
}
