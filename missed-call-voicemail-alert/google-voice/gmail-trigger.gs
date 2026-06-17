/**
 * Google Voice → AWS alerts with ORIGINAL voicemail audio.
 * Cookies go in GV_COOKIES below (from Cookie-Editor on voice.google.com).
 */

const WEBHOOK_URL = "https://7wo4ekjym9.execute-api.us-east-1.amazonaws.com/webhook";
const WEBHOOK_SECRET = "JDZwDjkR62dt1RyMG6VEMW2Sq2BfHt99";
const GV_API_KEY = "AIzaSyDTYc1N4xiODyrQYK0Kl6g_y279LjYkrBg";
const GV_API_BASE = "https://clients6.google.com/voice/v1/voiceclient/";
const GV_ORIGIN = "https://voice.google.com";

const GV_COOKIES = [];

function checkForVoicemailEmails() {
  var query = "from:(txt.voice.google.com OR voice-noreply@google.com) newer_than:2d";
  var threads = GmailApp.search(query, 0, 20);
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      if (!isGoogleVoiceEmail_(messages[m]) || wasProcessed_(messages[m].getId())) continue;
      sendAlert_(messages[m]);
      markProcessed_(messages[m].getId());
    }
  }
}

function testCheckNow() {
  checkForVoicemailEmails();
}

function testDownloadAudio() {
  var messages = listVoicemailMessages_();
  Logger.log("Found " + messages.length + " voicemails");
  if (!messages.length) {
    Logger.log("No voicemails found");
    return;
  }
  for (var i = 0; i < Math.min(messages.length, 5); i++) {
    var url = messages[i].recordingUrl;
    Logger.log("Try #" + (i + 1) + ": " + url.substring(0, 60) + "...");
    var bytes = downloadRecording_(url);
    if (bytes) {
      Logger.log("SUCCESS! Downloaded " + bytes.length + " bytes - ORIGINAL AUDIO WORKS!");
      return;
    }
  }
  Logger.log("Could not download. Re-export cookies from voice.google.com and update GV_COOKIES.");
}

function isGoogleVoiceEmail_(msg) {
  var text = ((msg.getFrom() || "") + " " + (msg.getSubject() || "") + " " + msg.getPlainBody().substring(0, 500)).toLowerCase();
  if (!/voice\.google|txt\.voice\.google/.test(text)) return false;
  return /missed call|voicemail|voice message|new text message from/.test(text);
}

function detectAlertType_(subject, snippet) {
  var text = (subject + " " + snippet).toLowerCase();
  if (/voicemail|voice message/.test(text)) return "voicemail";
  if (/missed call/.test(text)) return "missed_call";
  return "missed_call";
}

function extractVoicemailPlayUrl_(msg) {
  var blob = (msg.getBody() || "").replace(/&amp;/g, "&") + "\n" + (msg.getPlainBody() || "");
  var patterns = [
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
  if (marker) text = text.substring(text.search(/transcript\s*:?\s*/i) + marker[0].length);
  return text.replace(/play\s+message.*$/gim, "").replace(/https?:\/\/\S+/g, "").replace(/google voice/gi, "").replace(/\s+/g, " ").trim();
}

function phoneDigits_(number) {
  var digits = (number || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.charAt(0) === "1") return digits.substring(1);
  return digits;
}

function bytesToHex_(bytes) {
  return bytes.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? "0" + v : v;
  }).join("");
}

function getCookieList_() {
  return GV_COOKIES;
}

function cookieHeader_(cookies) {
  return cookies.map(function (c) { return c.name + "=" + c.value; }).join("; ");
}

function sapisidHash_(cookies) {
  var ts = Math.floor(Date.now() / 1000);
  var byName = {};
  cookies.forEach(function (c) { byName[c.name] = c.value; });
  var pairs = [
    ["SAPISIDHASH", "SAPISID"],
    ["SAPISID1PHASH", "__Secure-1PAPISID"],
    ["SAPISID3PHASH", "__Secure-3PAPISID"],
  ];
  var parts = [];
  pairs.forEach(function (p) {
    var secret = byName[p[1]];
    if (secret) {
      var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, ts + " " + secret + " " + GV_ORIGIN);
      parts.push(p[0] + " " + ts + "_" + bytesToHex_(digest));
    }
  });
  return parts.join(" ");
}

function gvPostHeaders_(cookies) {
  return {
    Authorization: sapisidHash_(cookies),
    "Content-Type": "application/json+protobuf",
    "X-Goog-Api-Key": GV_API_KEY,
    "X-Goog-AuthUser": "0",
    "X-Origin": GV_ORIGIN,
    "X-Referer": GV_ORIGIN,
    "X-Requested-With": "XMLHttpRequest",
    Cookie: cookieHeader_(cookies),
  };
}

function gvDownloadHeaders_(cookies) {
  return {
    Authorization: sapisidHash_(cookies),
    "X-Goog-AuthUser": "0",
    Referer: GV_ORIGIN,
    Cookie: cookieHeader_(cookies),
  };
}

function gvPost_(endpoint, body) {
  var url = GV_API_BASE + endpoint + "?alt=json&key=" + GV_API_KEY;
  var resp = UrlFetchApp.fetch(url, {
    method: "post",
    headers: gvPostHeaders_(getCookieList_()),
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) {
    Logger.log("GV API failed: " + resp.getResponseCode() + " " + resp.getContentText().substring(0, 200));
    return null;
  }
  return JSON.parse(resp.getContentText());
}

function listVoicemailMessages_() {
  var data = gvPost_("api2thread/list", [4, 20, 15, null, null, [null, 1, 1, 1]]);
  if (!data) return [];
  var out = [];
  (data.thread || []).forEach(function (thread) {
    (thread.item || []).forEach(function (item) {
      if ((item.type || "").toLowerCase().indexOf("voicemail") >= 0 && item.recordingUrl) {
        item._contact_phone = (item.contact || {}).phoneNumber || "";
        out.push(item);
      }
    });
  });
  return out;
}

function findVoicemail_(caller, emailDate) {
  var target = phoneDigits_(caller);
  if (!target) return null;
  var messages = listVoicemailMessages_();
  var best = null;
  var bestDelta = 999999999;
  var aroundMs = emailDate ? emailDate.getTime() : 0;
  var latestFromCaller = null;
  var latestStart = 0;

  messages.forEach(function (msg) {
    if (phoneDigits_(msg._contact_phone) !== target || !msg.recordingUrl) return;
    var startMs = parseInt(msg.startTime, 10);
    if (startMs > latestStart) {
      latestFromCaller = msg;
      latestStart = startMs;
    }
    if (aroundMs && startMs) {
      var delta = Math.abs(startMs - aroundMs);
      if (delta > 1800000) return;
      if (delta < bestDelta) {
        best = msg;
        bestDelta = delta;
      }
    } else if (!best) {
      best = msg;
    }
  });
  return best || latestFromCaller;
}

function sendLatestVoicemailNow() {
  var messages = listVoicemailMessages_();
  if (!messages.length) {
    Logger.log("No voicemails in Google Voice");
    return;
  }
  var msg = messages[0];
  var caller = msg._contact_phone || "Unknown";
  var payload = {
    alertType: "voicemail",
    caller: caller,
    subject: "Voicemail from " + caller,
    snippet: msg.messageText || "",
    emailTimestamp: new Date(parseInt(msg.startTime, 10)).toISOString(),
  };
  var bytes = downloadRecording_(msg.recordingUrl);
  if (bytes) {
    payload.audioFileName = "voicemail-" + phoneDigits_(caller) + ".mp3";
    payload.audioContentType = "audio/mpeg";
    payload.audioBase64 = Utilities.base64Encode(bytes);
    payload.audioSource = "recording";
    Logger.log("Attached " + bytes.length + " byte recording");
  }
  var res = UrlFetchApp.fetch(WEBHOOK_URL, {
    method: "post",
    contentType: "application/json",
    headers: { "X-Webhook-Secret": WEBHOOK_SECRET },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  Logger.log(res.getResponseCode() + " " + res.getContentText());
}

function downloadRecording_(url) {
  var cookies = getCookieList_();
  var headerSets = [
    gvDownloadHeaders_(cookies),
    { Cookie: cookieHeader_(cookies), Referer: GV_ORIGIN },
    gvPostHeaders_(cookies),
  ];
  for (var h = 0; h < headerSets.length; h++) {
    var resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: headerSets[h],
    });
    var code = resp.getResponseCode();
    if (code !== 200 && code !== 206) continue;
    var bytes = resp.getBlob().getBytes();
    if (bytes && bytes.length >= 500) return bytes;
  }
  return null;
}

function tryDownloadOriginalAudio_(caller, emailDate) {
  try {
    var messages = listVoicemailMessages_();
    if (!messages.length) {
      Logger.log("No voicemails in Google Voice inbox");
      return null;
    }
    var match = findVoicemail_(caller, emailDate);
    if (!match) {
      match = messages[0];
      Logger.log(
        "Using latest GV voicemail from " +
          match._contact_phone +
          " (caller match failed for " +
          caller +
          ")"
      );
    }
    var bytes = downloadRecording_(match.recordingUrl);
    if (!bytes) {
      Logger.log("Recording download failed for " + match.recordingUrl.substring(0, 60));
      return null;
    }
    var who = phoneDigits_(match._contact_phone) || phoneDigits_(caller) || "unknown";
    return {
      fileName: "voicemail-" + who + ".mp3",
      dataBase64: Utilities.base64Encode(bytes),
    };
  } catch (e) {
    Logger.log("Audio failed: " + e);
    return null;
  }
}

function sendAlert_(msg) {
  var subject = msg.getSubject() || "";
  var plain = msg.getPlainBody() || "";
  var snippet = plain.substring(0, 1500);
  var callerMatch = (subject + " " + snippet).match(/\+?1?\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  var caller = callerMatch ? callerMatch[0] : "Unknown";
  var alertType = detectAlertType_(subject, snippet);
  var payload = {
    alertType: alertType,
    caller: caller,
    subject: subject,
    snippet: snippet,
    emailTimestamp: msg.getDate().toISOString(),
  };
  if (alertType === "voicemail") {
    var playUrl = extractVoicemailPlayUrl_(msg);
    if (playUrl) payload.playUrl = playUrl;
    var transcript = extractTranscript_(plain);
    if (transcript) payload.transcript = transcript;
    try {
      var audio = tryDownloadOriginalAudio_(caller, msg.getDate());
      if (audio) {
        payload.audioFileName = audio.fileName;
        payload.audioContentType = "audio/mpeg";
        payload.audioBase64 = audio.dataBase64;
        payload.audioSource = "recording";
        Logger.log("Attached " + audio.dataBase64.length + " chars of audio");
      } else {
        Logger.log("No audio matched for caller " + caller + " — sending text alert anyway");
      }
    } catch (e) {
      Logger.log("Audio download error (sending text alert anyway): " + e);
    }
  }
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
  return PropertiesService.getScriptProperties().getProperty("processed:" + messageId) === "1";
}

function markProcessed_(messageId) {
  PropertiesService.getScriptProperties().setProperty("processed:" + messageId, "1");
}

function resetProcessed() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf("processed:") === 0) props.deleteProperty(k);
  });
}
