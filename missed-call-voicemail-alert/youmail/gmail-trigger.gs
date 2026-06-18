/**
 * YouMail email → AWS SMS/MMS alerts.
 *
 * YouMail FREE plan: email has a PLAY LINK (not an MP3 attachment).
 * This script reads voicemail@youmail.com, grabs that link, sends it to AWS.
 * AWS downloads the audio and texts you with the recording attached.
 */

const WEBHOOK_URL = "https://7wo4ekjym9.execute-api.us-east-1.amazonaws.com/webhook";
const WEBHOOK_SECRET = "JDZwDjkR62dt1RyMG6VEMW2Sq2BfHt99";

function checkForYouMailEmails() {
  var query = "from:voicemail@youmail.com newer_than:2d";
  var threads = GmailApp.search(query, 0, 30);
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      if (!isYouMailEmail_(messages[m]) || wasProcessed_(messages[m].getId())) continue;
      sendAlert_(messages[m]);
      markProcessed_(messages[m].getId());
    }
  }
}

function testCheckNow() {
  checkForYouMailEmails();
}

function isYouMailEmail_(msg) {
  var from = (msg.getFrom() || "").toLowerCase();
  return from.indexOf("voicemail@youmail.com") >= 0;
}

function detectAlertType_(subject, plain, msg) {
  var text = (subject + " " + plain).toLowerCase();
  if (/vm from|voicemail|voice message|play message/.test(text)) return "voicemail";
  if (/missed call/.test(text)) return "missed_call";
  if (msg && (extractPlayUrl_(msg) || extractAttachmentAudio_(msg))) return "voicemail";
  return "missed_call";
}

function extractCaller_(subject, plain) {
  var text = subject + " " + plain.substring(0, 800);
  var m = text.match(/\+?1?\s*\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})/);
  return m ? m[0] : "Unknown";
}

function extractPlayUrl_(msg) {
  var blob = (msg.getBody() || "").replace(/&amp;/g, "&") + "\n" + (msg.getPlainBody() || "");
  var m = blob.match(/https?:\/\/dashboard\.youmail\.com\/messages\/view\/[A-Za-z0-9._-]+[^\s"'<>]*/i);
  return m ? m[0] : null;
}

function extractDuration_(plain) {
  var m = (plain || "").match(/,\s*(\d+)s\b/i);
  return m ? parseInt(m[1], 10) : 0;
}

function extractTranscript_(plain) {
  if (!plain) return "";
  return plain
    .replace(/play\s*message/gi, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/youmail/gi, "")
    .replace(/called\s*\(\d{3}\)[\s\d-]+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAttachmentAudio_(msg) {
  var attachments = msg.getAttachments();
  for (var i = 0; i < attachments.length; i++) {
    var name = attachments[i].getName() || "";
    var type = attachments[i].getContentType() || "";
    if (/\.(mp3|wav|m4a)$/i.test(name) || type.indexOf("audio") >= 0) {
      var bytes = attachments[i].getBytes();
      if (bytes && bytes.length >= 500) {
        return {
          fileName: name || "voicemail.mp3",
          dataBase64: Utilities.base64Encode(bytes),
        };
      }
    }
  }
  return null;
}

function sendAlert_(msg) {
  var subject = msg.getSubject() || "";
  var plain = msg.getPlainBody() || "";
  var caller = extractCaller_(subject, plain);
  var alertType = detectAlertType_(subject, plain, msg);
  if (alertType === "missed_call" && extractPlayUrl_(msg)) {
    alertType = "voicemail";
  }
  if (alertType === "voicemail" && extractDuration_(plain) > 0) {
    alertType = "voicemail";
  }

  var payload = {
    alertType: alertType,
    caller: caller,
    subject: subject,
    snippet: plain.substring(0, 1500),
    emailTimestamp: msg.getDate().toISOString(),
    emailSource: "youmail",
  };

  var playUrl = extractPlayUrl_(msg);
  if (playUrl) payload.playUrl = playUrl;

  if (alertType === "voicemail") {
    var transcript = extractTranscript_(plain);
    if (transcript) payload.transcript = transcript;
    var audio = extractAttachmentAudio_(msg);
    if (audio) {
      payload.audioFileName = audio.fileName;
      payload.audioContentType = "audio/mpeg";
      payload.audioBase64 = audio.dataBase64;
      payload.audioSource = "recording";
      Logger.log("Using MP3 from email attachment (" + Math.round(audio.dataBase64.length * 0.75) + " bytes)");
    } else if (playUrl) {
      Logger.log("Sending play link for Lambda to fetch audio: " + playUrl.substring(0, 60) + "...");
    }
  }

  postWebhook_(payload);
}

function postWebhook_(payload) {
  var res = UrlFetchApp.fetch(WEBHOOK_URL, {
    method: "post",
    contentType: "application/json",
    headers: { "X-Webhook-Secret": WEBHOOK_SECRET },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  Logger.log(res.getResponseCode() + " " + res.getContentText());
  if (res.getResponseCode() !== 200) {
    throw new Error("Alert failed: " + res.getContentText());
  }
}

function wasProcessed_(messageId) {
  return PropertiesService.getScriptProperties().getProperty("ym:" + messageId) === "1";
}

function markProcessed_(messageId) {
  PropertiesService.getScriptProperties().setProperty("ym:" + messageId, "1");
}

function resetProcessed() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf("ym:") === 0) props.deleteProperty(k);
  });
}

function resendLatestVoicemail() {
  var query = "from:voicemail@youmail.com subject:(VM OR Voicemail) newer_than:7d";
  var threads = GmailApp.search(query, 0, 1);
  if (!threads.length) {
    Logger.log("No YouMail voicemail emails found");
    return;
  }
  var messages = threads[0].getMessages();
  var msg = messages[messages.length - 1];
  sendAlert_(msg);
}
