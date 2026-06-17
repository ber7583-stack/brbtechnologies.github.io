/**
 * Google Voice missed calls + voicemails → AWS SMS/MMS + email alerts
 *
 * Google Voice emails contain a PLAY LINK, not an audio attachment.
 * This script tries to download audio from that link; if Google blocks it,
 * the alert email still includes the clickable play link.
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

/** GV emails use a play link in HTML — not a file attachment. */
function extractVoicemailPlayUrl_(msg) {
  const html = (msg.getBody() || "").replace(/&amp;/g, "&");
  const plain = msg.getPlainBody() || "";
  const blob = html + "\n" + plain;

  const patterns = [
    /https?:\/\/www\.google\.com\/voice\/fm\/[A-Za-z0-9._-]+/i,
    /https?:\/\/voice\.google\.com\/u\/\d+\/voicemail\/[A-Za-z0-9._-]+/i,
    /https?:\/\/voice\.google\.com\/voicemail\/[A-Za-z0-9._-]+/i,
    /https?:\/\/account\.google\.com\/voice[^\s"'<>]*/i,
  ];

  for (var i = 0; i < patterns.length; i++) {
    var match = blob.match(patterns[i]);
    if (match) return match[0];
  }
  return null;
}

/** Try to download MP3 from GV play link (works for some accounts; Google may block). */
function tryDownloadVoicemailAudio_(playUrl) {
  var urls = [playUrl];
  if (playUrl.indexOf("/voice/fm/") >= 0) {
    urls.push(playUrl.replace("/voice/fm/", "/voice/media/svm/"));
  }

  for (var i = 0; i < urls.length; i++) {
    try {
      var resp = UrlFetchApp.fetch(urls[i], {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
      });
      if (resp.getResponseCode() !== 200) continue;

      var blob = resp.getBlob();
      var bytes = blob.getBytes();
      if (!bytes || bytes.length < 500) continue;

      var type = (blob.getContentType() || "").toLowerCase();
      if (
        type.indexOf("audio/") === 0 ||
        type.indexOf("application/octet") === 0 ||
        type.indexOf("mpeg") >= 0
      ) {
        return {
          fileName: "voicemail.mp3",
          contentType: type.indexOf("audio/") === 0 ? type : "audio/mpeg",
          dataBase64: Utilities.base64Encode(bytes),
        };
      }
    } catch (e) {
      Logger.log("Audio download failed for " + urls[i] + ": " + e);
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
    const playUrl = extractVoicemailPlayUrl_(msg);
    if (playUrl) payload.playUrl = playUrl;

    const audio = playUrl ? tryDownloadVoicemailAudio_(playUrl) : null;
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
