// Moss — small HTTP helpers shared by the server modules.
const fs = require("fs");
const path = require("path");
const { ROOT } = require("./config");

const STATIC_TYPES = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
};

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > 24_000_000) {
        reject(new Error("too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/" || p === "") p = "/index.html";
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const ext = path.extname(file);
    const type = STATIC_TYPES[ext] || "text/html; charset=utf-8";
    const cache = ext === ".png" || ext === ".svg" ? "public, max-age=86400" : "no-store";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": cache });
    res.end(buf);
  });
}

function clientIp(req) {
  const fwd = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim();
  return fwd || req.socket.remoteAddress || "";
}

function isHttps(req) {
  return (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim() === "https";
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  String(raw).split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function nid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

module.exports = {
  json,
  readBody,
  serveStatic,
  clientIp,
  isHttps,
  parseCookies,
  nid,
};
