/**
 * Google Voice missed calls + voicemails → AWS SMS/MMS + email with audio
 *
 * Trigger: Time-driven → checkForVoicemailEmails → Every minute
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
  const from = msg.getFrom() || "";
  const subject = msg.getSubject() || "";
  const body = msg.getPlainBody().substring(0, 300).toLowerCase();
  const text = (from + " " + subject + " " + body).toLowerCase();
  if (!/voice\.google|txt\.voice\.google/.test(text)) return false;
  return /missed call|voicemail|voice message|new text message from/.test(text);
}

function detectAlertType_(subject, snippet) {
  const text = (subject + " " + snippet).toLowerCase();
  if (/voicemail|voice message/.test(text)) return "voicemail";
  if (/missed call/.test(text)) return "missed_call";
  return "missed_call";
}

function getVoicemailAttachment_(msg) {
  const attachments = msg.getAttachments();
  for (const att of attachments) {
    const name = (att.getName() || "").toLowerCase();
    const type = (att.getContentType() || "").toLowerCase();
    if (/\.(mp3|wav|m4a|ogg|amr|3gp)$/.test(name) || type.indexOf("audio/") === 0) {
      return {
        fileName: att.getName() || "voicemail.mp3",
        contentType: att.getContentType() || "audio/mpeg",
        dataBase64: Utilities.base64Encode(att.getBytes()),
      };
    }
  }
  return null;
}

function sendAlert_(msg) {
  const subject = msg.getSubject() || "";
  const snippet = msg.getPlainBody().substring(0, 500);
  const callerMatch = (subject + " " + snippet).match(
    /\+?1?\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/
  );
  const alertType = detectAlertType_(subject, snippet);

  const payload = {
    alertType: alertType,
    caller: callerMatch ? callerMatch[0] : "Unknown",
    subject: subject,
    snippet: snippet,
  };

  if (alertType === "voicemail") {
    const audio = getVoicemailAttachment_(msg);
    if (audio) {
      payload.audioFileName = audio.fileName;
      payload.audioContentType = audio.contentType;
      payload.audioBase64 = audio.dataBase64;
    }
  }

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

function wasProcessed_(messageId) {
  return (
    PropertiesService.getScriptProperties().getProperty("processed:" + messageId) ===
    "1"
  );
}

function markProcessed_(messageId) {
  PropertiesService.getScriptProperties().setProperty("processed:" + messageId, "1");
}

function resetProcessed() {
  PropertiesService.getScriptProperties().deleteAllProperties();
}
