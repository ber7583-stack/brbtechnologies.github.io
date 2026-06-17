/**
 * Google Voice → AWS alerts
 *
 * Gmail notifies us of new voicemails. AWS downloads the ORIGINAL recording
 * from Google Voice's internal API (requires a one-time browser login — see README).
 */

const WEBHOOK_URL = "https://7wo4ekjym9.execute-api.us-east-1.amazonaws.com/webhook";
const WEBHOOK_SECRET = "JDZwDjkR62dt1RyMG6VEMW2Sq2BfHt99";

function checkForVoicemailEmails() {
  const query =
    "from:(txt.voice.google.com OR voice-noreply@google.com) newer_than:2d";
  const threads = GmailApp.search(query, 0, 20);

  for (const thread of threads) {
    const messages = thread.getMessages();
    for (const msg of messages) {
      if (!isGoogleVoiceEmail_(msg) || wasProcessed_(msg.getId())) continue;
      sendAlert_(msg);
      markProcessed_(msg.getId());
    }
  }
}

function testCheckNow() {
  checkForVoicemailEmails();
}

function isGoogleVoiceEmail_(msg) {
  const text = (
    (msg.getFrom() || "") +
    " " +
    (msg.getSubject() || "") +
    " " +
    msg.getPlainBody().substring(0, 500)
  ).toLowerCase();
  if (!/voice\.google|txt\.voice\.google/.test(text)) return false;
  return /missed call|voicemail|voice message|new text message from/.test(text);
}

function detectAlertType_(subject, snippet) {
  const text = (subject + " " + snippet).toLowerCase();
  if (/voicemail|voice message/.test(text)) return "voicemail";
  if (/missed call/.test(text)) return "missed_call";
  return "missed_call";
}

function extractVoicemailPlayUrl_(msg) {
  const blob = (msg.getBody() || "").replace(/&amp;/g, "&") + "\n" + (msg.getPlainBody() || "");
  const patterns = [
    /https?:\/\/www\.google\.com\/voice\/fm\/[A-Za-z0-9._-]+/i,
    /https?:\/\/voice\.google\.com\/u\/\d+\/voicemail\/[A-Za-z0-9._-]+/i,
    /https?:\/\/voice\.google\.com\/voicemail\/[A-Za-z0-9._-]+/i,
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = blob.match(patterns[i]);
    if (m) return m[0];
  }
  return null;
}

function extractTranscript_(plainBody) {
  if (!plainBody) return "";
  var text = plainBody;
  var marker = text.match(/transcript\s*:?\s*/i);
  if (marker) {
    text = text.substring(text.search(/transcript\s*:?\s*/i) + marker[0].length);
  }
  text = text.replace(/play\s+message.*$/gim, "");
  text = text.replace(/https?:\/\/\S+/g, "");
  text = text.replace(/google voice/gi, "");
  return text.replace(/\s+/g, " ").trim();
}

function sendAlert_(msg) {
  const subject = msg.getSubject() || "";
  const plain = msg.getPlainBody() || "";
  const snippet = plain.substring(0, 1500);
  const callerMatch = (subject + " " + snippet).match(
    /\+?1?\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/
  );
  const alertType = detectAlertType_(subject, snippet);

  const payload = {
    alertType: alertType,
    caller: callerMatch ? callerMatch[0] : "Unknown",
    subject: subject,
    snippet: snippet,
    emailTimestamp: msg.getDate().toISOString(),
  };

  if (alertType === "voicemail") {
    const playUrl = extractVoicemailPlayUrl_(msg);
    if (playUrl) payload.playUrl = playUrl;

    const transcript = extractTranscript_(plain);
    if (transcript) payload.transcript = transcript;
  }

  const res = UrlFetchApp.fetch(WEBHOOK_URL, {
    method: "post",
    contentType: "application/json",
    headers: { "X-Webhook-Secret": WEBHOOK_SECRET },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const body = res.getContentText();
  Logger.log("AWS response: " + code + " " + body);
  if (code !== 200) {
    throw new Error("Alert failed (" + code + "): " + body);
  }
}

function wasProcessed_(messageId) {
  return (
    PropertiesService.getScriptProperties().getProperty("processed:" + messageId) === "1"
  );
}

function markProcessed_(messageId) {
  PropertiesService.getScriptProperties().setProperty("processed:" + messageId, "1");
}

function resetProcessed() {
  PropertiesService.getScriptProperties().deleteAllProperties();
}
