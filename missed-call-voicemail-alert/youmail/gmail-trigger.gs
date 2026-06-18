/**
 * YouMail → AWS SMS/MMS alerts.
 * YouMail emails have a PLAY MESSAGE link (not an MP3 attachment).
 * This script downloads the MP3 from that link (no PIN) and sends it to AWS.
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
  return (msg.getFrom() || "").toLowerCase().indexOf("voicemail@youmail.com") >= 0;
}

function detectAlertType_(subject, plain, msg) {
  var text = (subject + " " + plain).toLowerCase();
  if (/vm from|voicemail|voice message|play message/.test(text)) return "voicemail";
  if (/missed call/.test(text)) return "missed_call";
  if (msg && extractPlayUrl_(msg)) return "voicemail";
  return "missed_call";
}

function extractCaller_(subject, plain) {
  var m = (subject + " " + plain.substring(0, 800)).match(/\+?1?\s*\(?(\d{3})\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  return m ? m[0] : "Unknown";
}

function extractPlayUrl_(msg) {
  var blob = (msg.getBody() || "").replace(/&amp;/g, "&") + "\n" + (msg.getPlainBody() || "");
  var m = blob.match(/https?:\/\/dashboard\.youmail\.com\/messages\/view\/[A-Za-z0-9._-]+[^\s"'<>]*/i);
  return m ? m[0] : null;
}

function extractMessageKey_(playUrl) {
  var m = (playUrl || "").match(/\/messages\/view\/([A-Za-z0-9._-]+)/);
  return m ? m[1] : null;
}

function downloadYouMailAudio_(playUrl) {
  var mk = extractMessageKey_(playUrl);
  if (!mk) return null;
  var url =
    "https://media.youmail.com/mcs/voicemail/sh/message.do?dataonly=true&mk=" +
    encodeURIComponent(mk) +
    "&sh=1&type=2&att=true";
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  if (resp.getResponseCode() !== 200) {
    Logger.log("YouMail download failed: HTTP " + resp.getResponseCode());
    return null;
  }
  var bytes = resp.getBlob().getBytes();
  if (!bytes || bytes.length < 500) return null;
  return bytes;
}

function phoneDigits_(number) {
  return (number || "").replace(/\D/g, "").replace(/^1/, "");
}

function sendAlert_(msg) {
  var subject = msg.getSubject() || "";
  var plain = msg.getPlainBody() || "";
  var caller = extractCaller_(subject, plain);
  var alertType = detectAlertType_(subject, plain, msg);
  var playUrl = extractPlayUrl_(msg);

  var payload = {
    alertType: alertType,
    caller: caller,
    subject: subject,
    snippet: plain.substring(0, 1500),
    emailTimestamp: msg.getDate().toISOString(),
    emailSource: "youmail",
  };
  if (playUrl) payload.playUrl = playUrl;

  if (alertType === "voicemail" && playUrl) {
    var bytes = downloadYouMailAudio_(playUrl);
    if (bytes) {
      payload.audioFileName = "voicemail-" + (phoneDigits_(caller) || "unknown") + ".mp3";
      payload.audioContentType = "audio/mpeg";
      payload.audioBase64 = Utilities.base64Encode(bytes);
      payload.audioSource = "recording";
      Logger.log("Downloaded " + bytes.length + " byte MP3 from YouMail play link");
    } else {
      Logger.log("Could not download MP3 — AWS will try from play link");
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
  if (res.getResponseCode() !== 200) throw new Error("Alert failed: " + res.getContentText());
}

function wasProcessed_(messageId) {
  return PropertiesService.getScriptProperties().getProperty("ym:" + messageId) === "1";
}

function markProcessed_(messageId) {
  PropertiesService.getScriptProperties().setProperty("ym:" + messageId, "1");
}

function resetProcessed() {
  var props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(function (k) {
    if (k.indexOf("ym:") === 0) props.deleteProperty(k);
  });
}

function resendLatestVoicemail() {
  var threads = GmailApp.search("from:voicemail@youmail.com subject:(VM OR Voicemail) newer_than:7d", 0, 1);
  if (!threads.length) {
    Logger.log("No YouMail voicemail emails found");
    return;
  }
  var messages = threads[0].getMessages();
  sendAlert_(messages[messages.length - 1]);
}

function testDownloadFromLink() {
  var url =
    "https://dashboard.youmail.com/messages/view/e1AArAHuHuO5PfLiMwT0YvzIOp2IereNlsldT9o4u6AitHnSooKKHopzpDw76uV_?ap=y";
  var bytes = downloadYouMailAudio_(url);
  Logger.log(bytes ? "SUCCESS: " + bytes.length + " bytes" : "FAILED");
}
