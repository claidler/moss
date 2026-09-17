// Moss — shared configuration constants.
// Everything deployment-specific comes from env vars (see README); the only
// personal details in a checkout are the ones you set yourself.
const os = require("os");
const path = require("path");

const HOME = os.homedir();
// Where the OpenClaw state directory lives (config, .env, workspace, agent data).
const OPENCLAW_DIR = process.env.MOSS_OPENCLAW_DIR || path.join(HOME, ".openclaw");
// OpenClaw agent id used for transcript/session lookups (the automations board).
const AGENT_ID = /^[a-z0-9][a-z0-9_-]*$/i.test(process.env.MOSS_AGENT_ID || "")
  ? process.env.MOSS_AGENT_ID
  : "main";
// Mentions of this handle (e.g. "@someone") are stripped from note/chat text.
// Empty (default) disables stripping.
const OWNER_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,}$/.test(process.env.MOSS_OWNER_HANDLE || "")
  ? process.env.MOSS_OWNER_HANDLE
  : "";

// Optional Android TWA identity: when both are set, /.well-known/assetlinks.json
// is served from these instead of the committed placeholder file.
const ANDROID_PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i.test(process.env.MOSS_ANDROID_PACKAGE || "")
  ? process.env.MOSS_ANDROID_PACKAGE
  : "";
const ANDROID_FINGERPRINT = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){31}$/.test(String(process.env.MOSS_ANDROID_FINGERPRINT || "").trim())
  ? String(process.env.MOSS_ANDROID_FINGERPRINT).trim().toUpperCase()
  : "";

const GW = {
  host: process.env.MOSS_GW_HOST || "127.0.0.1",
  port: Number(process.env.MOSS_GW_PORT || 18789),
};
const PORT = Number(process.env.PORT || 8190);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const STORE_FILE = process.env.MOSS_STORE_FILE || path.join(ROOT, "data", "store.json");
const HISTORY_FILE = process.env.MOSS_HISTORY_FILE || path.join(ROOT, "data", "history.json");
const AUTH_FILE = path.join(ROOT, "data", "auth.json");
const PASSWORD_FILE = path.join(ROOT, "data", "PASSWORD");
const VAPID_FILE = process.env.MOSS_VAPID_FILE || path.join(ROOT, "data", "vapid.json");
const PUSH_SUBS_FILE = process.env.MOSS_PUSH_SUBS_FILE || path.join(ROOT, "data", "push-subs.json");
const COOKIE = "moss_session";
const SESSION_MS = 30 * 24 * 3600 * 1000;

// Headers that must not be copied between client and gateway.
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

module.exports = {
  HOME,
  OPENCLAW_DIR,
  AGENT_ID,
  OWNER_HANDLE,
  ANDROID_PACKAGE,
  ANDROID_FINGERPRINT,
  GW,
  PORT,
  HOST,
  ROOT,
  STORE_FILE,
  HISTORY_FILE,
  AUTH_FILE,
  PASSWORD_FILE,
  VAPID_FILE,
  PUSH_SUBS_FILE,
  COOKIE,
  SESSION_MS,
  HOP,
};
