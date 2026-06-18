/**
 * YouMail → AWS SMS/MMS alerts.
 * YouMail emails have a PLAY MESSAGE link (not an MP3 attachment).
 * Downloads MP3 from media.youmail.com using the link token — no PIN.
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

function emailBlob_(msg) {
  return ((msg.getBody() || "") + "\n" + (msg.getPlainBody() || "")).replace(/&amp;/g, "&");
}

function detectAlertType_(subject, plain, msg) {
  var text = (subject + " " + plain).toLowerCase();
  if (/vm from|voicemail|voice message|play message/.test(text)) return "voicemail";
  if (/missed call/.test(text)) return "missed_call";
  if (msg && extractMessageKeyFromEmail_(msg)) return "voicemail";
  return "missed_call";
}

function extractCaller_(subject, plain) {
  var m = (subject + " " + plain.substring(0, 800)).match(/\+?1?\s*\(?(\d{3})\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  return m ? m[0] : "Unknown";
}

function extractMessageKeyFromEmail_(msg) {
  var blob = emailBlob_(msg);

  var patterns = [
    /\/messages\/view\/([A-Za-z0-9._-]+)/i,
    /[?&]mk=([A-Za-z0-9._-]+)/i,
    /shareKey\\?"\s*:\s*\\?"([A-Za-z0-9._-]+)/i,
    /dashboard\.youmail\.com\/messages\/view\/([A-Za-z0-9._-]+)/i,
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = blob.match(patterns[i]);
    if (m && m[1] && m[1].length > 20) return m[1];
  }

  var decoded = blob.replace(/https?:\/\/www\.google\.com\/url\?q=([^&"'\s>]+)/gi, function (_, u) {
    try {
      return decodeURIComponent(u);
    } catch (e) {
      return u;
    }
  });
  for (var j = 0; j < patterns.length; j++) {
    var m2 = decoded.match(patterns[j]);
    if (m2 && m2[1] && m2[1].length > 20) return m2[1];
  }
  return null;
}

function buildPlayUrl_(messageKey) {
  return "https://dashboard.youmail.com/messages/view/" + messageKey + "?ap=y";
}

function downloadMp3FromKey_(messageKey) {
  if (!messageKey) return null;
  var url =
    "https://media.youmail.com/mcs/voicemail/sh/message.do?dataonly=true&mk=" +
    encodeURIComponent(messageKey) +
    "&sh=1&type=2&att=true";
  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; YouMailAlert/1.0)" },
  });
  var code = resp.getResponseCode();
  if (code !== 200) {
    Logger.log("MP3 download HTTP " + code + " for key " + messageKey.substring(0, 20) + "...");
    return null;
  }
  var bytes = resp.getBlob().getBytes();
  if (!bytes || bytes.length < 500) {
    Logger.log("MP3 too small: " + (bytes ? bytes.length : 0));
    return null;
  }
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
  var messageKey = extractMessageKeyFromEmail_(msg);
  var playUrl = messageKey ? buildPlayUrl_(messageKey) : null;

  Logger.log("alertType=" + alertType + " caller=" + caller + " key=" + (messageKey ? "YES" : "NO"));

  var payload = {
    alertType: alertType,
    caller: caller,
    subject: subject,
    snippet: plain.substring(0, 1500),
    emailTimestamp: msg.getDate().toISOString(),
    emailSource: "youmail",
  };
  if (playUrl) payload.playUrl = playUrl;
  if (messageKey) payload.youmailMessageKey = messageKey;

  if (alertType === "voicemail" && messageKey) {
    var bytes = downloadMp3FromKey_(messageKey);
    if (bytes) {
      payload.audioFileName = "voicemail-" + (phoneDigits_(caller) || "unknown") + ".mp3";
      payload.audioContentType = "audio/mpeg";
      payload.audioBase64 = Utilities.base64Encode(bytes);
      payload.audioSource = "recording";
      Logger.log("Downloaded " + bytes.length + " byte MP3");
    } else {
      Logger.log("MP3 download failed — sending playUrl for AWS retry");
    }
  } else if (alertType === "voicemail") {
    Logger.log("WARNING: voicemail email but no message key found in email body");
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
  var threads = GmailApp.search("from:voicemail@youmail.com newer_than:14d", 0, 20);
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = messages.length - 1; m >= 0; m--) {
      var subj = (messages[m].getSubject() || "").toLowerCase();
      if (/vm from|voicemail/.test(subj) || extractMessageKeyFromEmail_(messages[m])) {
        Logger.log("Resending: " + messages[m].getSubject());
        sendAlert_(messages[m]);
        return;
      }
    }
  }
  Logger.log("No voicemail email found");
}

function diagnoseLatestEmail() {
  var threads = GmailApp.search("from:voicemail@youmail.com newer_than:14d", 0, 5);
  if (!threads.length) {
    Logger.log("No YouMail emails found");
    return;
  }
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = messages.length - 1; m >= 0; m--) {
      var msg = messages[m];
      var key = extractMessageKeyFromEmail_(msg);
      Logger.log("---");
      Logger.log("Subject: " + msg.getSubject());
      Logger.log("Message key found: " + (key ? key.substring(0, 30) + "..." : "NO"));
      if (key) {
        var bytes = downloadMp3FromKey_(key);
        Logger.log("MP3 download: " + (bytes ? bytes.length + " bytes OK" : "FAILED"));
      }
    }
  }
}

function testDownloadFromLink() {
  var key = "e1AArAHuHuO5PfLiMwT0YvzIOp2IereNlsldT9o4u6AitHnSooKKHopzpDw76uV_";
  var bytes = downloadMp3FromKey_(key);
  Logger.log(bytes ? "SUCCESS: " + bytes.length + " bytes" : "FAILED");
}
