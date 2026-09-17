// Moss — cookie-session authentication: bootstrap, session signing, login flow.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { AUTH_FILE, PASSWORD_FILE, COOKIE, SESSION_MS } = require("./config");
const { json, readBody, serveStatic, clientIp, isHttps, parseCookies } = require("./http-utils");

function parseAllowedHosts(raw) {
  return new Set(
    String(raw || "")
      .split(/[,\s]+/)
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  );
}
const ALLOWED_HOSTS = parseAllowedHosts(process.env.MOSS_ALLOWED_HOSTS);

const loginFails = new Map();

function ensureAuth() {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  if (fs.existsSync(AUTH_FILE)) {
    return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  }
  const password = crypto.randomBytes(18).toString("base64url");
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const auth = {
    kdf: "scrypt",
    N: 16384,
    r: 8,
    p: 1,
    keylen: 32,
    salt: salt.toString("hex"),
    hash: hash.toString("hex"),
    sessionSecret: crypto.randomBytes(32).toString("hex"),
  };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth), { mode: 0o600 });
  fs.writeFileSync(PASSWORD_FILE, password + "\n", { mode: 0o600 });
  return auth;
}

const AUTH = ensureAuth();

function signSession(exp) {
  const payload = Buffer.from(JSON.stringify({ exp, v: 1 })).toString("base64url");
  const mac = crypto.createHmac("sha256", AUTH.sessionSecret).update(payload).digest("base64url");
  return payload + "." + mac;
}

function validSession(token) {
  if (!token || !token.includes(".")) return false;
  const [payload, mac] = token.split(".");
  const expect = crypto.createHmac("sha256", AUTH.sessionSecret).update(payload).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function setSessionCookie(req, res) {
  const token = signSession(Date.now() + SESSION_MS);
  const parts = [
    COOKIE + "=" + token,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=" + Math.floor(SESSION_MS / 1000),
  ];
  if (isHttps(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(req, res) {
  const parts = [COOKIE + "=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isHttps(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function hostOk(hostname) {
  return ALLOWED_HOSTS.has(String(hostname || "").toLowerCase());
}

function originOk(req) {
  const origin = (req.headers.origin || "").toString();
  if (!origin) {
    const referer = (req.headers.referer || "").toString();
    if (!referer) return req.method === "GET" || req.method === "HEAD";
    try {
      return hostOk(new URL(referer).hostname);
    } catch {
      return false;
    }
  }
  try {
    return hostOk(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function rateLimited(ip) {
  const now = Date.now();
  const rec = loginFails.get(ip);
  if (!rec) return false;
  if (now > rec.reset) {
    loginFails.delete(ip);
    return false;
  }
  return rec.n >= 8;
}

function recordFail(ip) {
  const now = Date.now();
  const rec = loginFails.get(ip);
  if (!rec || now > rec.reset) loginFails.set(ip, { n: 1, reset: now + 15 * 60 * 1000 });
  else rec.n += 1;
}

function passwordOk(password) {
  const salt = Buffer.from(AUTH.salt, "hex");
  const expect = Buffer.from(AUTH.hash, "hex");
  const got = crypto.scryptSync(String(password || ""), salt, AUTH.keylen || 32, {
    N: AUTH.N || 16384,
    r: AUTH.r || 8,
    p: AUTH.p || 1,
  });
  return got.length === expect.length && crypto.timingSafeEqual(got, expect);
}

function isPublicPath(p) {
  return (
    p === "/login" ||
    p === "/login.html" ||
    p === "/api/login" ||
    p === "/icon.svg" ||
    p === "/favicon-32.png" ||
    p === "/apple-touch-icon.png" ||
    p === "/icon-192.png" ||
    p === "/icon-512.png" ||
    p === "/icon-512-maskable.png" ||
    p === "/manifest.webmanifest" ||
    p === "/sw.js" ||
    p === "/.well-known/assetlinks.json" ||
    p.startsWith("/vendor/")
  );
}

// Handles login/logout endpoints. Returns true when the request was handled.
async function handleLogin(req, res) {
  const p = (req.url || "").split("?")[0];
  if (p === "/api/logout" && req.method === "POST") {
    clearSessionCookie(req, res);
    json(res, 200, { ok: true });
    return true;
  }
  if (p === "/login" || p === "/login.html") {
    req.url = "/login.html";
    serveStatic(req, res);
    return true;
  }
  if (p !== "/api/login" || req.method !== "POST") return false;
  if (!originOk(req)) {
    json(res, 403, { error: "origin" });
    return true;
  }
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    res.setHeader("Retry-After", "900");
    json(res, 429, { error: "rate" });
    return true;
  }
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  } catch {
    json(res, 400, { error: "bad json" });
    return true;
  }
  if (!passwordOk(body.password)) {
    recordFail(ip);
    json(res, 401, { error: "auth" });
    return true;
  }
  loginFails.delete(ip);
  setSessionCookie(req, res);
  json(res, 200, { ok: true });
  return true;
}

function deny(req, res) {
  const p = (req.url || "").split("?")[0];
  const wantsHtml = (req.headers.accept || "").includes("text/html") || p === "/" || p.endsWith(".html");
  if (wantsHtml && req.method === "GET") {
    res.writeHead(302, { Location: "/login", "Cache-Control": "no-store" });
    res.end();
    return;
  }
  json(res, 401, { error: "auth" });
}

function isAuthenticated(req) {
  return validSession(parseCookies(req)[COOKIE]);
}

module.exports = {
  handleLogin,
  deny,
  isAuthenticated,
  validSession,
  isPublicPath,
};
