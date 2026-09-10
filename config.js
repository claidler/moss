// Moss — shared configuration constants.
const path = require("path");

const GW = { host: "127.0.0.1", port: 18789 };
const PORT = Number(process.env.PORT || 8190);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const STORE_FILE = path.join(ROOT, "data", "store.json");
const HISTORY_FILE = path.join(ROOT, "data", "history.json");
const AUTH_FILE = path.join(ROOT, "data", "auth.json");
const PASSWORD_FILE = path.join(ROOT, "data", "PASSWORD");
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
  GW,
  PORT,
  HOST,
  ROOT,
  STORE_FILE,
  HISTORY_FILE,
  AUTH_FILE,
  PASSWORD_FILE,
  COOKIE,
  SESSION_MS,
  HOP,
};
