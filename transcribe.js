// Moss — Groq whisper speech-to-text for the composer (never local STT).
const fs = require("fs");
const path = require("path");
const https = require("https");
const { json, readBody } = require("./http-utils");
const { HOME, OPENCLAW_DIR } = require("./config");

const GROQ_HOST = "api.groq.com";
const GROQ_PATH = "/openai/v1/audio/transcriptions";
const MODEL = "whisper-large-v3-turbo";
const UA =
  "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const MIME_EXT = {
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/mp4": ".mp4",
  "audio/m4a": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/flac": ".flac",
};

function primaryMime(raw) {
  const base = String(raw || "").split(";")[0].trim().toLowerCase();
  return MIME_EXT[base] ? base : "";
}

function filenameFor(mime) {
  const ext = MIME_EXT[primaryMime(mime)] || ".webm";
  return "note" + ext;
}

function loadGroqKey() {
  const fromEnv = String(process.env.GROQ_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const files = [
    path.join(OPENCLAW_DIR, ".env"),
    path.join(HOME, ".hermes", ".env"),
    process.env.MOSS_ENV_FILE,
  ].filter(Boolean);
  for (const file of files) {
    let raw = "";
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*GROQ_API_KEY\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[1].trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      v = v.trim();
      if (v) return v;
    }
  }
  return "";
}

function groqMultipart(buf, mime) {
  const boundary = "----moss" + Date.now().toString(16);
  const type = primaryMime(mime) || "audio/webm";
  const filename = filenameFor(type);
  const head = Buffer.from(
    "--" +
      boundary +
      '\r\nContent-Disposition: form-data; name="model"\r\n\r\n' +
      MODEL +
      "\r\n--" +
      boundary +
      '\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n--' +
      boundary +
      '\r\nContent-Disposition: form-data; name="file"; filename="' +
      filename +
      '"\r\nContent-Type: ' +
      type +
      "\r\n\r\n"
  );
  const tail = Buffer.from("\r\n--" + boundary + "--\r\n");
  return { body: Buffer.concat([head, buf, tail]), boundary };
}

function groqTranscribe(buf, mime) {
  const key = loadGroqKey();
  if (!key) {
    const err = new Error("missing groq key");
    err.code = 503;
    return Promise.reject(err);
  }
  const { body, boundary } = groqMultipart(buf, mime);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: GROQ_HOST,
        path: GROQ_PATH,
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "multipart/form-data; boundary=" + boundary,
          "Content-Length": body.length,
          "User-Agent": UA,
          Accept: "application/json",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data = {};
          try {
            data = JSON.parse(raw);
          } catch {
            data = {};
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(String(data.text || ""));
            return;
          }
          const err = new Error("groq");
          err.status = res.statusCode;
          reject(err);
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(120000, () => req.destroy(new Error("timeout")));
    req.end(body);
  });
}

async function api(req, res) {
  const url = (req.url || "").split("?")[0];
  if (url !== "/api/transcribe") return false;
  if (req.method !== "POST") {
    json(res, 405, { error: "method" });
    return true;
  }
  let buf;
  try {
    buf = await readBody(req);
  } catch {
    json(res, 413, { error: "too large" });
    return true;
  }
  if (!buf || !buf.length) {
    json(res, 400, { error: "empty" });
    return true;
  }
  const mime = primaryMime(req.headers["content-type"]) || "audio/webm";
  try {
    const text = await groqTranscribe(buf, mime);
    console.log("moss-transcribe", buf.length, "ok");
    json(res, 200, { text });
  } catch (e) {
    const code = e && e.code === 503 ? 503 : 502;
    console.log("moss-transcribe", buf.length, code, (e && e.status) || (e && e.message) || "fail");
    json(res, code, { error: code === 503 ? "speech unavailable" : "transcribe failed" });
  }
  return true;
}

module.exports = {
  api,
  primaryMime,
  filenameFor,
  groqMultipart,
  MODEL,
};
