// Moss — Web Push (VAPID + RFC 8291) for automations and finished chats.
const fs = require("fs");
const crypto = require("crypto");
const { json, readBody } = require("./http-utils");
const { VAPID_FILE, PUSH_SUBS_FILE } = require("./config");

const SUB = process.env.MOSS_PUSH_SUBJECT || "mailto:admin@localhost";
const MAX_SUBS = 12;

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function b64decode(s) {
  return Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function generateVapid() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const pub = publicKey.export({ type: "spki", format: "der" }).slice(-65);
  return { publicKey: b64url(pub), privateKey: jwk.d };
}

function ensureVapid() {
  try {
    const s = JSON.parse(fs.readFileSync(VAPID_FILE, "utf8"));
    if (s && s.publicKey && s.privateKey) return s;
  } catch {}
  const keys = generateVapid();
  fs.mkdirSync(require("path").dirname(VAPID_FILE), { recursive: true });
  fs.writeFileSync(VAPID_FILE, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

function vapidJwt(audience, keys) {
  const pub = b64decode(keys.publicKey);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64url(pub.slice(1, 33)),
    y: b64url(pub.slice(33, 65)),
    d: keys.privateKey,
  };
  const key = crypto.createPrivateKey({ key: jwk, format: "jwk" });
  const unsigned =
    b64url(JSON.stringify({ typ: "JWT", alg: "ES256" })) +
    "." +
    b64url(JSON.stringify({
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: SUB,
    }));
  const sign = crypto.createSign("SHA256");
  sign.update(unsigned);
  sign.end();
  const sig = sign.sign({ key, dsaEncoding: "ieee-p1363" });
  return unsigned + "." + b64url(sig);
}

function asUncompressed(buf) {
  if (buf.length === 65 && buf[0] === 4) return buf;
  if (buf.length === 64) return Buffer.concat([Buffer.from([4]), buf]);
  throw new Error("bad p256 key");
}

function encrypt(p256dh, auth, plaintext) {
  const userPublic = asUncompressed(b64decode(p256dh));
  const userAuth = b64decode(auth);
  const local = crypto.createECDH("prime256v1");
  const localPublic = local.generateKeys();
  const shared = local.computeSecret(userPublic);
  const authInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), userPublic, localPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, userAuth, authInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12));
  const padded = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);
  return Buffer.concat([salt, rs, Buffer.from([localPublic.length]), localPublic, ciphertext]);
}

function loadSubs() {
  try {
    const s = JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, "utf8"));
    if (Array.isArray(s)) return s.filter((x) => x && x.endpoint && x.keys && x.keys.p256dh && x.keys.auth);
  } catch {}
  return [];
}

function saveSubs(list) {
  fs.mkdirSync(require("path").dirname(PUSH_SUBS_FILE), { recursive: true });
  fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify(list));
}

function upsertSub(sub) {
  const endpoint = String((sub && sub.endpoint) || "");
  const keys = sub && sub.keys;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) return false;
  const row = {
    endpoint,
    keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) },
    createdAt: Date.now(),
  };
  const list = loadSubs().filter((x) => x.endpoint !== endpoint);
  list.unshift(row);
  saveSubs(list.slice(0, MAX_SUBS));
  return true;
}

function removeSub(endpoint) {
  const next = loadSubs().filter((x) => x.endpoint !== endpoint);
  saveSubs(next);
}

function previewText(s, n) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, n || 140);
}

async function pushOne(sub, plaintext) {
  const keys = ensureVapid();
  const url = new URL(sub.endpoint);
  const jwt = vapidJwt(url.origin, keys);
  const body = encrypt(sub.keys.p256dh, sub.keys.auth, plaintext);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: "vapid t=" + jwt + ", k=" + keys.publicKey,
      TTL: "86400",
      Urgency: "high",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
    },
    body,
  });
  if (res.status === 404 || res.status === 410) {
    const err = new Error("gone");
    err.status = res.status;
    throw err;
  }
  if (!res.ok && res.status !== 201 && res.status !== 202) {
    console.log("moss-push", res.status, String(await res.text().catch(() => "")).slice(0, 180));
  }
}

function send(payload) {
  const list = loadSubs();
  if (!list.length) return Promise.resolve();
  const body = Buffer.from(JSON.stringify(payload || {}));
  return Promise.all(list.map((sub) => pushOne(sub, body).catch((err) => {
    if (err && (err.status === 404 || err.status === 410)) removeSub(sub.endpoint);
    else console.log("moss-push send skipped", err && err.message);
  })));
}

function notifyChat(chatId, title, body) {
  const text = previewText(body);
  if (!chatId || !text || /^NO_REPLY$/i.test(text)) return Promise.resolve();
  return send({
    type: "chat",
    chatId,
    title: title || "Moss",
    body: text,
    url: "/?chat=" + encodeURIComponent(chatId),
  });
}

function notifyAsk(chatId, title, body) {
  if (!chatId) return Promise.resolve();
  return send({
    type: "ask",
    chatId,
    title: title || "Moss needs a decision",
    body: previewText(body) || "Tap to answer",
    url: "/?chat=" + encodeURIComponent(chatId),
  });
}

function notifyAutomation(item) {
  if (!item || !item.id) return Promise.resolve();
  return send({
    type: "automation",
    noteId: item.id,
    title: item.title || "Automation",
    body: previewText(item.preview || item.content) || "New automation",
    url: "/?note=" + encodeURIComponent(item.id),
  });
}

async function api(req, res) {
  const url = (req.url || "").split("?")[0];
  if (url === "/api/push/vapid" && req.method === "GET") {
    json(res, 200, { publicKey: ensureVapid().publicKey });
    return true;
  }
  if (url === "/api/push/subscribe" && req.method === "POST") {
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    } catch {
      json(res, 400, { error: "bad json" });
      return true;
    }
    if (!upsertSub(body)) {
      json(res, 400, { error: "bad subscription" });
      return true;
    }
    json(res, 200, { ok: true });
    return true;
  }
  if (url === "/api/push/subscribe" && req.method === "DELETE") {
    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    } catch {}
    if (body.endpoint) removeSub(body.endpoint);
    json(res, 200, { ok: true });
    return true;
  }
  return false;
}

if (require.main === module) {
  const keys = generateVapid();
  const pub = b64decode(keys.publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("vapid public key");
  vapidJwt("https://fcm.googleapis.com", keys);
  const user = crypto.createECDH("prime256v1");
  const userPub = user.generateKeys();
  const userAuth = crypto.randomBytes(16);
  const packed = encrypt(b64url(userPub), b64url(userAuth), Buffer.from('{"title":"Moss"}'));
  if (packed.length < 16 + 4 + 1 + 65 + 16) throw new Error("encrypt short");
  if (packed.readUInt32BE(16) !== 4096) throw new Error("rs");
  if (packed[20] !== 65) throw new Error("idlen");
  console.log("push self-test ok", packed.length);
}

module.exports = {
  api,
  send,
  notifyChat,
  notifyAsk,
  notifyAutomation,
  ensureVapid,
};
