/**
 * Google Voice voicemail → AWS SMS alert
 *
 * Setup (one time):
 * 1. script.google.com → New project → paste this file
 * 2. Set WEBHOOK_URL and WEBHOOK_SECRET below (from AWS deploy output)
 * 3. Triggers → Add → run triggerVoicemailAlert → From Gmail → email received
 * 4. Filter: from:(txt.voice.google.com OR voice-noreply@google.com OR @txt.voice.google.com)
 */

const WEBHOOK_URL = "PASTE_WEBHOOK_URL_HERE";
const WEBHOOK_SECRET = "PASTE_WEBHOOK_SECRET_HERE";

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
