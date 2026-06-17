/**
 * Google Voice → AWS alerts (with ORIGINAL voicemail audio)
 *
 * ONE-TIME SETUP (5 min, all in Chrome + Apps Script — no folders, no Python):
 *   1. voice.google.com → sign in
 *   2. Install Cookie-Editor extension
 *   3. Export cookies as JSON
 *   4. Run saveCookiesOnce() in this script (paste JSON — see below)
 */

const WEBHOOK_URL = "https://7wo4ekjym9.execute-api.us-east-1.amazonaws.com/webhook";
const WEBHOOK_SECRET = "JDZwDjkR62dt1RyMG6VEMW2Sq2BfHt99";

const GV_API_KEY = "AIzaSyDTYc1N4xiODyrQYK0Kl6g_y279LjYkrBg";
const GV_API_BASE = "https://clients6.google.com/voice/v1/voiceclient/";
const GV_ORIGIN = "https://voice.google.com";

// ── ONE-TIME: paste Cookie-Editor JSON between the quotes, run saveCookiesOnce(), then delete paste ──
const COOKIE_PASTE_HERE = "";

function saveCookiesOnce() {
  var raw = COOKIE_PASTE_HERE;
  if (!raw || raw.length < 50) {
    throw new Error(
      "Paste your Cookie-Editor JSON into COOKIE_PASTE_HERE at the top of this file, then run saveCookiesOnce again."
    );
  }
  JSON.parse(raw);
  PropertiesService.getScriptProperties().setProperty("gv_cookies", raw);
  Logger.log("Saved! You can clear COOKIE_PASTE_HERE now. Run testDownloadAudio to verify.");
}

function cookiesAreSet_() {
  return !!PropertiesService.getScriptProperties().getProperty("gv_cookies");
}

function checkCookieSetup() {
  if (cookiesAreSet_()) {
    Logger.log("OK — cookies saved. Run testDownloadAudio to test.");
    return;
  }
  Logger.log("Not set yet. Follow saveCookiesOnce() instructions at top of file.");
}

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

function testDownloadAudio() {
  var messages = listVoicemailMessages_();
  Logger.log("Found " + messages.length + " voicemails in Google Voice");
  if (messages.length) {
    var url = messages[0].recordingUrl;
    var bytes = downloadRecording_(url);
    Logger.log("Downloaded " + bytes.length + " bytes from latest voicemail — original audio works!");
  }
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
  var raw = PropertiesService.getScriptProperties().getProperty("gv_cookies");
  if (!raw) return null;
  var parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.cookies || [];
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
      var digest = Utilities.computeDigest(
        Utilities.DigestAlgorithm.SHA_1,
        ts + " " + secret + " " + GV_ORIGIN
      );
      parts.push(p[0] + " " + ts + "_" + bytesToHex_(digest));
    }
  });
  if (!parts.length) throw new Error("Missing SAPISID cookies — export from voice.google.com");
  return parts.join(" ");
}

function gvHeaders_(cookies) {
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

function gvPost_(endpoint, body) {
  var url = GV_API_BASE + endpoint + "?alt=json&key=" + GV_API_KEY;
  var resp = UrlFetchApp.fetch(url, {
    method: "post",
    headers: gvHeaders_(getCookieList_()),
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) {
    Logger.log("GV API " + endpoint + " failed: " + resp.getResponseCode());
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
        var contact = item.contact || {};
        item._contact_phone = contact.phoneNumber || "";
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

  messages.forEach(function (msg) {
    if (phoneDigits_(msg._contact_phone) !== target) return;
    if (!msg.recordingUrl) return;
    var startMs = parseInt(msg.startTime, 10);
    if (aroundMs && startMs) {
      var delta = Math.abs(startMs - aroundMs);
      if (delta > 600000) return;
      if (delta < bestDelta) {
        best = msg;
        bestDelta = delta;
      }
    } else if (!best) {
      best = msg;
    }
  });
  return best;
}

function downloadRecording_(url) {
  var cookies = getCookieList_();
  if (!cookies) return null;
  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: gvHeaders_(cookies),
  });
  if (resp.getResponseCode() !== 200) return null;
  var bytes = resp.getBlob().getBytes();
  return bytes.length >= 500 ? bytes : null;
}

function tryDownloadOriginalAudio_(caller, emailDate) {
  if (!cookiesAreSet_()) return null;
  try {
    var match = findVoicemail_(caller, emailDate);
    if (!match) return null;
    var bytes = downloadRecording_(match.recordingUrl);
    if (!bytes) return null;
    return {
      fileName: "voicemail-" + phoneDigits_(caller) + ".mp3",
      dataBase64: Utilities.base64Encode(bytes),
    };
  } catch (e) {
    Logger.log("Audio download failed: " + e);
    return null;
  }
}

function sendAlert_(msg) {
  const subject = msg.getSubject() || "";
  const plain = msg.getPlainBody() || "";
  const snippet = plain.substring(0, 1500);
  const callerMatch = (subject + " " + snippet).match(
    /\+?1?\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/
  );
  const caller = callerMatch ? callerMatch[0] : "Unknown";
  const alertType = detectAlertType_(subject, snippet);

  const payload = {
    alertType: alertType,
    caller: caller,
    subject: subject,
    snippet: snippet,
    emailTimestamp: msg.getDate().toISOString(),
  };

  if (alertType === "voicemail") {
    const playUrl = extractVoicemailPlayUrl_(msg);
    if (playUrl) payload.playUrl = playUrl;

    const transcript = extractTranscript_(plain);
    if (transcript) payload.transcript = transcript;

    const audio = tryDownloadOriginalAudio_(caller, msg.getDate());
    if (audio) {
      payload.audioFileName = audio.fileName;
      payload.audioContentType = "audio/mpeg";
      payload.audioBase64 = audio.dataBase64;
      payload.audioSource = "recording";
    }
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
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf("processed:") === 0) props.deleteProperty(k);
  });
}
