/**
 * Google Voice → AWS alerts
 *
 * Google Voice emails contain a play LINK + transcript, not an MP3 attachment.
 * This script tries several ways to fetch the real recording. If Google blocks
 * that, AWS turns the transcript into a spoken MP3 (Amazon Polly) so you still
 * get a playable file on phone/email.
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
    /https?:\/\/account\.google\.com\/voice[^\s"'<>]*/i,
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = blob.match(patterns[i]);
    if (m) return m[0];
  }
  return null;
}

function extractVoicemailId_(playUrl, html) {
  var blob = (playUrl || "") + "\n" + (html || "");
  var patterns = [
    /voicemail\/([A-Za-z0-9._-]+)/i,
    /\/voice\/fm\/([A-Za-z0-9._-]+)/i,
    /\/media\/svm\/([A-Za-z0-9._-]+)/i,
    /[?&]e=([A-Za-z0-9._-]+)/i,
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = blob.match(patterns[i]);
    if (m) return m[1];
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

function fetchAudioUrl_(url) {
  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
  });
  if (resp.getResponseCode() !== 200) return null;
  var bytes = resp.getBlob().getBytes();
  if (!bytes || bytes.length < 500) return null;
  var type = (resp.getBlob().getContentType() || "").toLowerCase();
  if (
    type.indexOf("audio/") === 0 ||
    type.indexOf("application/octet") === 0 ||
    type.indexOf("mpeg") >= 0
  ) {
    return {
      fileName: "voicemail-recording.mp3",
      contentType: type.indexOf("audio/") === 0 ? type : "audio/mpeg",
      dataBase64: Utilities.base64Encode(bytes),
      source: "recording",
    };
  }
  return null;
}

function scrapeAudioUrlsFromHtml_(html) {
  var found = [];
  var patterns = [
    /https?:\/\/[^"'\s]+\.googleusercontent\.com\/[^"'\s]+/gi,
    /https?:\/\/[^"'\s]+\/voice\/media\/[^"'\s]+/gi,
    /https?:\/\/[^"'\s]+\/media\/svm\/[^"'\s]+/gi,
  ];
  for (var p = 0; p < patterns.length; p++) {
    var matches = html.match(patterns[p]) || [];
    for (var i = 0; i < matches.length; i++) {
      if (found.indexOf(matches[i]) < 0) found.push(matches[i]);
    }
  }
  return found;
}

function tryDownloadVoicemailAudio_(msg, playUrl) {
  var html = (msg.getBody() || "").replace(/&amp;/g, "&");
  var candidates = [];

  if (playUrl) {
    candidates.push(playUrl);
    if (playUrl.indexOf("/voice/fm/") >= 0) {
      candidates.push(playUrl.replace("/voice/fm/", "/voice/media/svm/"));
    }
  }

  var id = extractVoicemailId_(playUrl, html);
  if (id) {
    candidates.push("https://www.google.com/voice/media/send_voicemail/" + id + "/");
    candidates.push("https://www.google.com/voice/b/0/downloadvoicemail?e=" + id);
  }

  scrapeAudioUrlsFromHtml_(html).forEach(function (u) {
    if (candidates.indexOf(u) < 0) candidates.push(u);
  });

  for (var i = 0; i < candidates.length; i++) {
    var audio = fetchAudioUrl_(candidates[i]);
    if (audio) return audio;
  }

  if (playUrl) {
    try {
      var page = UrlFetchApp.fetch(playUrl, {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
      });
      if (page.getResponseCode() === 200) {
        var pageUrls = scrapeAudioUrlsFromHtml_(page.getContentText());
        for (var j = 0; j < pageUrls.length; j++) {
          var scraped = fetchAudioUrl_(pageUrls[j]);
          if (scraped) return scraped;
        }
      }
    } catch (e) {
      Logger.log("Page scrape failed: " + e);
    }
  }

  return null;
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
  };

  if (alertType === "voicemail") {
    const playUrl = extractVoicemailPlayUrl_(msg);
    if (playUrl) payload.playUrl = playUrl;

    const transcript = extractTranscript_(plain);
    if (transcript) payload.transcript = transcript;

    const audio = tryDownloadVoicemailAudio_(msg, playUrl);
    if (audio) {
      payload.audioFileName = audio.fileName;
      payload.audioContentType = audio.contentType;
      payload.audioBase64 = audio.dataBase64;
      payload.audioSource = audio.source;
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
  PropertiesService.getScriptProperties().deleteAllProperties();
}
