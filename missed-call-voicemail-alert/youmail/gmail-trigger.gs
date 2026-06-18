/**
 * YouMail → AWS SMS/MMS alerts.
 * Downloads MP3 from media.youmail.com — no PIN.
 */

const WEBHOOK_URL = "https://7wo4ekjym9.execute-api.us-east-1.amazonaws.com/webhook";
const WEBHOOK_SECRET = "JDZwDjkR62dt1RyMG6VEMW2Sq2BfHt99";
// Only alert on emails received in the last N minutes (avoids backlog texts).
const MAX_ALERT_AGE_MINUTES = 45;

function checkForYouMailEmails() {
  var query = "from:voicemail@youmail.com newer_than:2d";
  var threads = GmailApp.search(query, 0, 30);
  var cutoff = Date.now() - MAX_ALERT_AGE_MINUTES * 60 * 1000;
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      if (!isYouMailEmail_(messages[m]) || wasProcessed_(messages[m].getId())) continue;
      if (messages[m].getDate().getTime() < cutoff) {
        Logger.log("Skipping old email (no alert): " + messages[m].getSubject());
        markProcessed_(messages[m].getId());
        continue;
      }
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
  var parts = [msg.getBody() || "", msg.getPlainBody() || ""];
  try {
    if (typeof Gmail !== "undefined" && Gmail.Users && Gmail.Users.Messages) {
      var raw = Gmail.Users.Messages.get("me", msg.getId(), { format: "raw" });
      if (raw && raw.raw) {
        parts.push(
          Utilities.newBlob(
            Utilities.base64DecodeWebSafe(raw.raw)
          ).getDataAsString()
        );
      }
    }
  } catch (e) {
    Logger.log("Raw MIME not available (enable Gmail API service if needed): " + e);
  }
  return parts.join("\n").replace(/&amp;/g, "&");
}

function extractAllUrls_(blob) {
  var urls = [];
  var patterns = [
    /href\s*=\s*["']([^"']+)["']/gi,
    /data-saferedirecturl\s*=\s*["']([^"']+)["']/gi,
    /https?:\/\/[^\s"'<>\)]+/gi,
  ];
  for (var p = 0; p < patterns.length; p++) {
    var m;
    while ((m = patterns[p].exec(blob)) !== null) {
      urls.push((m[1] || m[0]).replace(/&amp;/g, "&"));
    }
  }
  var seen = {};
  return urls.filter(function (u) {
    if (!u || seen[u]) return false;
    seen[u] = true;
    return true;
  });
}

function decodeNestedUrl_(url) {
  if (!url) return "";
  var decoded = url;
  for (var i = 0; i < 4; i++) {
    try {
      decoded = decodeURIComponent(decoded.replace(/\+/g, " "));
    } catch (e) {}
    var nested = decoded.match(/[?&](?:url|q|u|redirect)=([^&"'\s]+)/i);
    if (nested) {
      decoded = nested[1];
      continue;
    }
    break;
  }
  return decoded;
}

function keyFromUrl_(url) {
  if (!url) return null;
  var decoded = decodeNestedUrl_(url);
  var patterns = [
    /\/messages\/view\/([A-Za-z0-9._-]{20,})/i,
    /[?&]mk=([A-Za-z0-9._-]{20,})/i,
    /"shareKey"\s*:\s*"([A-Za-z0-9._-]{20,})"/i,
    /shareKey\\?"\s*:\s*\\?"([A-Za-z0-9._-]{20,})/i,
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = (decoded + " " + url).match(patterns[i]);
    if (m && m[1]) return m[1];
  }
  return null;
}

function keyFromHtml_(html) {
  if (!html) return null;
  return keyFromUrl_(html) || (html.match(/"shareKey"\s*:\s*"([A-Za-z0-9._-]{20,})"/) || [])[1] || null;
}

function followUrlForKey_(url, depth) {
  depth = depth || 0;
  if (!url || depth > 6) return null;

  var direct = keyFromUrl_(url);
  if (direct) return direct;

  if (!/youmail|ymail/i.test(url)) return null;

  try {
    var resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: false,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; YouMailAlert/1.0)" },
    });
    var code = resp.getResponseCode();
    var headers = resp.getHeaders();
    var loc = headers.Location || headers.location;

    if (code >= 300 && code < 400 && loc) {
      var fromLoc = keyFromUrl_(loc) || followUrlForKey_(loc, depth + 1);
      if (fromLoc) return fromLoc;
    }

    if (code === 200) {
      var html = resp.getContentText();
      var fromHtml = keyFromHtml_(html);
      if (fromHtml) return fromHtml;
      var media = html.match(/https?:\/\/media\.youmail\.com[^"'\s<>]+/i);
      if (media) {
        var mk = keyFromUrl_(media[0]);
        if (mk) return mk;
      }
    }
  } catch (e) {
    Logger.log("followUrl failed: " + e);
  }
  return null;
}

function extractMessageKeyFromEmail_(msg) {
  var blob = emailBlob_(msg);

  var direct = keyFromUrl_(blob);
  if (direct) return direct;

  var urls = extractAllUrls_(blob);
  for (var i = 0; i < urls.length; i++) {
    var k = keyFromUrl_(urls[i]);
    if (k) return k;
  }

  for (var j = 0; j < urls.length; j++) {
    if (/youmail|ymail|play-message/i.test(urls[j])) {
      var k2 = followUrlForKey_(urls[j]);
      if (k2) return k2;
    }
  }

  for (var h = 0; h < urls.length; h++) {
    if (/play|message|voicemail/i.test(urls[h])) {
      var k3 = followUrlForKey_(urls[h]);
      if (k3) return k3;
    }
  }

  return null;
}

function detectAlertType_(subject, plain, msg) {
  var text = (subject + " " + plain).toLowerCase();
  var subj = (subject || "").toLowerCase();

  // Missed-call emails always say "Missed Call" in the subject; check before YouMail branding.
  if (/missed call/.test(subj)) return "missed_call";
  if (/no message left|no voicemail left|did not leave|didn't leave/.test(text)) return "missed_call";

  if (/vm from|voicemail from|new voicemail|voice message|left you a message|play message/.test(text)) {
    return "voicemail";
  }
  if (/^voicemail\b/.test(subj)) return "voicemail";

  return "missed_call";
}

function extractCaller_(subject, plain) {
  var m = (subject + " " + plain.substring(0, 800)).match(/\+?1?\s*\(?(\d{3})\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  return m ? m[0] : "Unknown";
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
  if (resp.getResponseCode() !== 200) return null;
  var bytes = resp.getBlob().getBytes();
  return bytes && bytes.length >= 500 ? bytes : null;
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

/** Run once to silence backlog — marks all YouMail emails processed without texting. */
function markAllOldAsDone() {
  var threads = GmailApp.search("from:voicemail@youmail.com newer_than:14d", 0, 50);
  var count = 0;
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      if (!isYouMailEmail_(messages[m])) continue;
      markProcessed_(messages[m].getId());
      count++;
    }
  }
  Logger.log("Marked " + count + " YouMail emails as done (no alerts sent).");
}

function resendLatestVoicemail() {
  var threads = GmailApp.search("from:voicemail@youmail.com newer_than:14d", 0, 20);
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = messages.length - 1; m >= 0; m--) {
      var subj = (messages[m].getSubject() || "").toLowerCase();
      if (/vm from|voicemail/.test(subj)) {
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
      var subj = msg.getSubject() || "";
      if (!/vm from|voicemail/i.test(subj)) continue;

      Logger.log("---");
      Logger.log("Subject: " + subj);
      var blob = emailBlob_(msg);
      var urls = extractAllUrls_(blob);
      Logger.log("URLs in email: " + urls.length);
      for (var u = 0; u < Math.min(urls.length, 8); u++) {
        Logger.log("  url[" + u + "]: " + urls[u].substring(0, 120));
      }

      var key = extractMessageKeyFromEmail_(msg);
      Logger.log("Message key: " + (key ? key.substring(0, 30) + "..." : "NO"));
      if (key) {
        var bytes = downloadMp3FromKey_(key);
        Logger.log("MP3: " + (bytes ? bytes.length + " bytes OK" : "FAILED"));
      }
    }
  }
}

function testDownloadFromLink() {
  var key = "e1AArAHuHuO5PfLiMwT0YvzIOp2IereNlsldT9o4u6AitHnSooKKHopzpDw76uV_";
  var bytes = downloadMp3FromKey_(key);
  Logger.log(bytes ? "SUCCESS: " + bytes.length + " bytes" : "FAILED");
}
