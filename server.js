// Moss — tiny chat layer for OpenClaw.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const notes = require("./notes");
const uploads = require("./uploads");

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
const loginFails = new Map();

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

function allowedHosts() {
  return new Set(
    String(process.env.MOSS_ALLOWED_HOSTS || "")
      .split(/[,\s]+/)
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  );
}

function originOk(req) {
  const origin = (req.headers.origin || "").toString();
  if (!origin) {
    const referer = (req.headers.referer || "").toString();
    if (!referer) return req.method === "GET" || req.method === "HEAD";
    try {
      const u = new URL(referer);
      return allowedHosts().has(String(u.hostname || "").toLowerCase());
    } catch {
      return false;
    }
  }
  try {
    const u = new URL(origin);
    return allowedHosts().has(String(u.hostname || "").toLowerCase());
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
    p.startsWith("/vendor/")
  );
}

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

function gatewayToken() {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(process.env.HOME || "/home/claidler", ".openclaw/openclaw.json"), "utf8")
    );
    return (cfg.gateway && cfg.gateway.auth && cfg.gateway.auth.token) || "";
  } catch {
    return "";
  }
}

function nid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function titleFrom(messages) {
  const u = (messages || []).find((m) => m && m.role === "user" && m.content);
  if (!u) return "New chat";
  const t = String(u.content).trim().replace(/\s+/g, " ");
  return t.length > 42 ? t.slice(0, 42) + "…" : t;
}

function clipText(v, n) {
  if (v == null) return "";
  const s = typeof v === "string" ? v : (() => {
    try { return JSON.stringify(v); } catch { return String(v); }
  })();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function slimThinking(parts) {
  if (!Array.isArray(parts)) {
    const s = String(parts || "").trim();
    return s ? [clipText(s, 8000)] : [];
  }
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    const s = String(p || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(clipText(s, 8000));
    if (out.length >= 12) break;
  }
  return out;
}

function thinkingJoined(parts) {
  return slimThinking(parts).join("\n\n");
}

function ensureSentenceSpacing(s) {
  return String(s || "").replace(/([.!?:])(?=[A-Z("])/g, "$1 ");
}

function stripThinkTags(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\|im_start\|>thinking[\s\S]*?<\|im_end\|>/gi, "")
    .replace(/^\s+/, "");
}

function stripThinkingPrefix(text, parts) {
  let out = stripThinkTags(text);
  const original = out;
  const frags = slimThinking(parts).slice().sort((a, b) => b.length - a.length);
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 24) {
    changed = false;
    const trimmed = out.replace(/^\s+/, "");
    for (const f of frags) {
      if (!f) continue;
      if (trimmed === f) {
        out = "";
        changed = true;
        break;
      }
      if (trimmed.startsWith(f)) {
        out = trimmed.slice(f.length);
        changed = true;
        break;
      }
      const compact = f.replace(/\s+/g, " ").trim();
      if (!compact) continue;
      const src = trimmed;
      let i = 0;
      let j = 0;
      while (i < src.length && j < compact.length) {
        if (/\s/.test(src[i])) { i += 1; continue; }
        if (/\s/.test(compact[j])) { j += 1; continue; }
        if (src[i] !== compact[j]) break;
        i += 1;
        j += 1;
      }
      if (j >= compact.length) {
        out = src.slice(i);
        changed = true;
        break;
      }
    }
  }
  out = ensureSentenceSpacing(out.replace(/^\s+/, ""));
  if (!out && original.trim()) return ensureSentenceSpacing(original);
  return out;
}

function slimTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t) => t && typeof t === "object")
    .slice(0, 40)
    .map((t) => ({
      id: clipText(t.id || t.toolCallId || "", 80),
      name: clipText(t.name || "tool", 80),
      phase: t.phase === "result" || t.phase === "error" ? t.phase : (t.result ? "result" : "start"),
      args: clipText(t.args, 4000),
      result: clipText(t.result, 8000),
      isError: Boolean(t.isError),
    }))
    .filter((t) => t.name);
}

function slimQuestion(q) {
  if (!q || typeof q !== "object") return null;
  const id = clipText(q.id || "", 80);
  if (!id) return null;
  const status = q.status === "answered" || q.status === "cancelled" || q.status === "expired" ? q.status : "pending";
  const inner = (Array.isArray(q.questions) ? q.questions : []).slice(0, 3).map((item) => {
    if (!item || typeof item !== "object") return null;
    const secret = Boolean(item.isSecret);
    const questionId = clipText(item.questionId || item.id || "", 80);
    const question = clipText(item.question || "", 500);
    if (!questionId || !question) return null;
    return {
      questionId,
      header: clipText(item.header || "", 24),
      question,
      multiSelect: Boolean(item.multiSelect),
      isSecret: secret,
      options: secret
        ? []
        : (Array.isArray(item.options) ? item.options : []).slice(0, 4).map((o) => ({
            label: clipText((o && o.label) || "", 200),
            description: clipText((o && o.description) || "", 300),
          })).filter((o) => o.label),
    };
  }).filter(Boolean);
  if (!inner.length) return null;
  const row = {
    id,
    status,
    createdAtMs: Number(q.createdAtMs) || Date.now(),
    expiresAtMs: Number(q.expiresAtMs) || 0,
    questions: inner,
  };
  if (status === "answered" && q.answers && q.answers.answers && !inner.some((x) => x.isSecret)) {
    const answers = {};
    for (const [k, v] of Object.entries(q.answers.answers)) {
      if (!Array.isArray(v)) continue;
      answers[clipText(k, 80)] = v.map((s) => clipText(s, 500)).filter(Boolean).slice(0, 8);
    }
    row.answers = { answers };
  }
  return row;
}

function slimQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  const out = [];
  const seen = new Set();
  for (const q of questions) {
    const row = slimQuestion(q);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
    if (out.length >= 12) break;
  }
  return out;
}

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => {
      const row = { role: m.role, content: m.content };
      if (Array.isArray(m.images) && m.images.length) {
        row.images = m.images.filter((u) => typeof u === "string" && u).slice(0, 8);
        if (!row.images.length) delete row.images;
      }
      if (Array.isArray(m.imageNames) && m.imageNames.length) {
        row.imageNames = m.imageNames.map((n) => String(n || "")).filter(Boolean).slice(0, 8);
        if (!row.imageNames.length) delete row.imageNames;
      }
      const tools = slimTools(m.tools);
      if (tools.length) row.tools = tools;
      const questions = slimQuestions(m.questions);
      if (questions.length) row.questions = questions;
      const thinking = slimThinking(m.thinking);
      if (thinking.length) row.thinking = thinking;
      return row;
    });
}

function newChat() {
  return { id: nid(), title: "New chat", updatedAt: Date.now(), messages: [] };
}

function loadStore() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    if (s && Array.isArray(s.chats) && s.chats.length) {
      if (!s.activeId || !s.chats.some((c) => c.id === s.activeId)) s.activeId = s.chats[0].id;
      return s;
    }
  } catch {}
  try {
    const h = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    if (h && Array.isArray(h.messages) && h.messages.length) {
      const c = newChat();
      c.messages = cleanMessages(h.messages);
      c.title = titleFrom(c.messages);
      c.updatedAt = h.updatedAt || Date.now();
      const migrated = { activeId: c.id, chats: [c] };
      saveStore(migrated);
      return migrated;
    }
  } catch {}
  const c = newChat();
  const fresh = { activeId: c.id, chats: [c] };
  saveStore(fresh);
  return fresh;
}

function saveStore(s) {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(s));
}

const runs = new Map();
const questionsByChat = new Map();
let questionHub = null;
let questionHubTimer = null;

function chatIdFromSession(sessionKey) {
  if (!sessionKey) return "";
  const s = String(sessionKey);
  if (/^moss-[a-z0-9]+$/i.test(s)) return s.slice(5);
  const m = s.match(/:moss-([a-z0-9]+)$/i);
  return m ? m[1] : "";
}

function upsertRunTool(list, incoming) {
  if (!incoming || !Array.isArray(list)) return list;
  const id = incoming.id || incoming.toolCallId || "";
  const idx = incoming.idx;
  let slot = id ? list.find((x) => x.id === id) : null;
  if (!slot && idx != null) slot = list.find((x) => x.idx === idx);
  if (!slot) {
    slot = { id: id || "t" + list.length, name: "", args: "", result: "", phase: "start", isError: false, idx };
    list.push(slot);
  }
  if (incoming.name && !slot.name) slot.name = incoming.name;
  if (incoming.phase) slot.phase = incoming.phase;
  if (incoming.isError) slot.isError = true;
  if (typeof incoming.args === "string" && incoming.args) {
    if (incoming.appendArgs) slot.args = (slot.args || "") + incoming.args;
    else if (incoming.phase === "result" || incoming.replaceArgs || !slot.args || incoming.args.length >= slot.args.length) {
      slot.args = incoming.args;
    }
  }
  if (incoming.result) slot.result = incoming.result;
  return list;
}

function questionsFor(chatId) {
  return slimQuestions(questionsByChat.get(chatId) || []);
}

function askingPreview(qs) {
  const pending = (qs || []).find((q) => q && q.status === "pending");
  if (!pending) return "";
  const first = pending.questions && pending.questions[0];
  return (first && (first.question || first.header)) || "Asking…";
}

function injectQuestionToRun(chatId, q) {
  const run = runs.get(chatId);
  if (!run || run.done || !q) return;
  run.questions = slimQuestions((run.questions || []).concat([q]));
  if (typeof run.injectQuestion === "function") {
    try { run.injectQuestion(q); } catch {}
  }
}

function rememberQuestion(raw) {
  const q = slimQuestion(raw);
  if (!q) return null;
  const chatId = chatIdFromSession(raw && raw.sessionKey);
  if (!chatId) return q;
  const prev = questionsByChat.get(chatId) || [];
  const next = prev.filter((x) => x.id !== q.id).concat([q]);
  questionsByChat.set(chatId, next);
  injectQuestionToRun(chatId, q);
  return q;
}

function applyQuestionResolved(raw) {
  if (!raw || !raw.id) return null;
  const status = raw.status === "answered" || raw.status === "cancelled" || raw.status === "expired" ? raw.status : "cancelled";
  let found = null;
  for (const [chatId, list] of questionsByChat) {
    const idx = list.findIndex((x) => x.id === raw.id);
    if (idx < 0) continue;
    const q = Object.assign({}, list[idx], { status });
    if (status === "answered" && raw.answers) q.answers = raw.answers;
    else delete q.answers;
    list[idx] = q;
    questionsByChat.set(chatId, list);
    injectQuestionToRun(chatId, q);
    found = q;
  }
  return found;
}

function handleQuestionEvent(msg) {
  if (!msg) return;
  if (msg.event === "question.requested") rememberQuestion(msg.payload);
  else if (msg.event === "question.resolved") applyQuestionResolved(msg.payload);
}

function handleGatewayEvent(msg) {
  handleQuestionEvent(msg);
  notes.handleCronEvent(msg);
}

function startQuestionHub() {
  if (questionHubTimer) {
    clearTimeout(questionHubTimer);
    questionHubTimer = null;
  }
  connectGatewayWs(handleGatewayEvent, {
    scopes: ["operator.read", "operator.questions"],
    caps: ["tool-events"],
  }).then(async (h) => {
    questionHub = h;
    h.ws.addEventListener("close", () => {
      if (questionHub === h) questionHub = null;
      if (!questionHubTimer) questionHubTimer = setTimeout(startQuestionHub, 2000);
    });
    try {
      const listed = await h.rpc("question.list", {});
      (listed && listed.questions ? listed.questions : []).forEach((q) => rememberQuestion(q));
      console.log("moss-questions hub ready", (listed && listed.questions ? listed.questions : []).length);
    } catch (e) {
      console.log("moss-questions list skipped:", e.message);
    }
  }).catch((e) => {
    console.log("moss-questions hub skipped:", e.message);
    if (!questionHubTimer) questionHubTimer = setTimeout(startQuestionHub, 4000);
  });
}

async function gatewayRpc(scopes, method, params, timeoutMs) {
  const wait = (rpc) => Promise.race([
    rpc(method, params),
    new Promise((_, reject) => setTimeout(() => reject(new Error(method + " timeout")), timeoutMs || 12000)),
  ]);
  if (questionHub && questionHub.ws && questionHub.ws.readyState === 1 && typeof questionHub.rpc === "function") {
    return wait(questionHub.rpc);
  }
  const h = await connectGatewayWs(null, { scopes, caps: ["tool-events"] });
  try {
    return await wait(h.rpc);
  } finally {
    try { h.ws.close(); } catch {}
  }
}

function applyRunOverlay(chat) {
  if (!chat) return chat;
  const run = runs.get(chat.id);
  const qs = questionsFor(chat.id);
  const asking = askingPreview(qs);
  const runLive = !!(run && !run.done);
  if (!runLive) {
    return Object.assign({}, chat, {
      pending: Boolean(asking),
      asking: Boolean(asking),
      partial: "",
      liveTools: [],
      thinking: [],
      questions: qs,
      preview: asking || chat.preview,
    });
  }
  const toolHint = run.tools && run.tools[0] && run.tools[0].name ? "Using " + run.tools[0].name : "Working…";
  return Object.assign({}, chat, {
    pending: true,
    asking: Boolean(asking),
    partial: run.partial || "",
    liveTools: run.tools || [],
    thinking: run.thinking || [],
    questions: qs,
    preview: asking || run.partial || toolHint,
  });
}

function mergeKeepAssistant(prev, incoming) {
  const inc = Array.isArray(incoming) ? incoming.slice() : [];
  const prevMsgs = Array.isArray(prev) ? prev : [];
  const lastInc = inc[inc.length - 1];
  const lastPrev = prevMsgs[prevMsgs.length - 1];
  if (lastInc && lastInc.role === "user" && lastPrev && lastPrev.role === "assistant") {
    let prevUser = null;
    for (let i = prevMsgs.length - 1; i >= 0; i--) {
      if (prevMsgs[i] && prevMsgs[i].role === "user") {
        prevUser = prevMsgs[i];
        break;
      }
    }
    if (prevUser && prevUser.content === lastInc.content) inc.push(lastPrev);
  }
  return inc;
}

function commitAssistant(chatId, payload) {
  if (!chatId) return;
  const store = loadStore();
  const chat = store.chats.find((c) => c.id === chatId);
  if (!chat) return;
  const text = payload && payload.content
    ? String(payload.content)
    : (payload && payload.error ? String(payload.error) : "");
  const slim = slimTools(payload && payload.tools);
  const asked = slimQuestions(payload && payload.questions);
  const think = slimThinking(payload && payload.thinking);
  if (!text && !slim.length && !asked.length && !think.length) return;
  const msgs = Array.isArray(chat.messages) ? chat.messages.slice() : [];
  let lastUser = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  const row = { role: "assistant", content: text };
  if (slim.length) row.tools = slim;
  if (asked.length) row.questions = asked;
  if (think.length) row.thinking = think;
  const after = lastUser >= 0 ? msgs.slice(lastUser + 1) : [];
  const existingA = after.find((m) => m && m.role === "assistant");
  if (existingA) {
    existingA.content = row.content;
    if (row.tools) existingA.tools = row.tools;
    else delete existingA.tools;
    if (row.questions) existingA.questions = row.questions;
    else delete existingA.questions;
    if (row.thinking) existingA.thinking = row.thinking;
    else delete existingA.thinking;
  } else {
    msgs.push(row);
  }
  chat.messages = msgs;
  chat.title = titleFrom(msgs);
  chat.updatedAt = Date.now();
  store.chats = [chat].concat(store.chats.filter((c) => c.id !== chatId));
  saveStore(store);
}

function cancelRun(chatId) {
  const run = runs.get(chatId);
  if (run && typeof run.cancel === "function") {
    try { run.cancel(); } catch {}
  }
  runs.delete(chatId);
}

function summarize(store) {
  return {
    activeId: store.activeId,
    unreadNotes: notes.unreadCount(),
    chats: store.chats.map((c) => {
      const over = applyRunOverlay(c);
      const last = c.messages && c.messages[c.messages.length - 1];
      return {
        id: c.id,
        title: c.title || "New chat",
        updatedAt: over.pending ? Date.now() : c.updatedAt,
        preview: over.pending ? (over.preview || (over.asking ? "Asking…" : "Working…")) : (last ? last.content : "New chat"),
        pending: !!over.pending,
        asking: !!over.asking,
      };
    }),
  };
}

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
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\\\])+/, ""));
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const ext = path.extname(file);
    const types = {
      ".css": "text/css",
      ".js": "text/javascript",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".webmanifest": "application/manifest+json",
      ".json": "application/json",
      ".html": "text/html; charset=utf-8",
    };
    const type = types[ext] || "text/html; charset=utf-8";
    const cache = ext === ".png" || ext === ".svg" ? "public, max-age=86400" : "no-store";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": cache });
    res.end(buf);
  });
}

function sessionKeyFromUser(user) {
  return typeof user === "string" && /^moss-[a-z0-9]+$/i.test(user) ? user : "";
}

function connectGatewayWs(onEvent, opts) {
  const scopes = opts && Array.isArray(opts.scopes) && opts.scopes.length ? opts.scopes : ["operator.read"];
  const caps = opts && Array.isArray(opts.caps) ? opts.caps : ["tool-events"];
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket("ws://" + GW.host + ":" + GW.port);
    const pending = new Map();
    let n = 0;
    let connecting = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const rpc = (method, params) => {
      const id = "moss-" + (++n);
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ type: "req", id, method, params }));
      });
    };
    const timer = setTimeout(() => fail(new Error("gateway ws timeout")), 8000);
    const sendConnect = () => {
      if (connecting || settled) return;
      if (ws.readyState !== 1) return;
      connecting = true;
      rpc("connect", {
        minProtocol: 4,
        maxProtocol: 4,
        client: { id: "gateway-client", version: "1.0.0", platform: "linux", mode: "backend" },
        role: "operator",
        scopes,
        caps,
        auth: { token: gatewayToken() },
      }).then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ws, rpc });
      }).catch(fail);
    };
    ws.addEventListener("error", () => fail(new Error("gateway ws error")));
    ws.addEventListener("close", () => {
      if (!settled) fail(new Error("gateway ws closed"));
    });
    ws.addEventListener("open", () => setTimeout(sendConnect, 250));
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type === "event" && msg.event === "connect.challenge") {
        sendConnect();
        return;
      }
      if (msg.type === "res" && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.ok) p.res(msg.payload);
        else p.rej(new Error((msg.error && msg.error.message) || "rpc failed"));
        return;
      }
      if (msg.type === "event" && typeof onEvent === "function") onEvent(msg);
    });
  });
}


async function steerFollowup(chatId, message, attachments) {
  const sessionKey = "moss-" + chatId;
  const h = await connectGatewayWs(null, {
    scopes: ["operator.read", "operator.write"],
    caps: ["tool-events"],
  });
  try {
    return await Promise.race([
      h.rpc("chat.send", {
        sessionKey,
        agentId: "main",
        message,
        ...(attachments && attachments.length ? { attachments } : {}),
        queueMode: "steer",
        idempotencyKey: "moss-fu-" + nid(),
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("steer timeout")), 12000)),
    ]);
  } finally {
    try { h.ws.close(); } catch {}
  }
}

function fromAgentTool(payload) {
  const data = payload && payload.data;
  if (!data || typeof data !== "object") return null;
  const name = String(data.name || "tool");
  const id = String(data.toolCallId || data.id || name);
  const phase = String(data.phase || "");
  if (phase !== "start" && phase !== "result" && phase !== "update" && phase !== "error") return null;
  return {
    id,
    name,
    phase: phase === "update" ? "start" : phase,
    args: clipText(data.args, 4000),
    result: clipText(data.result, 8000),
    isError: Boolean(data.isError),
  };
}

function fromThinkingPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const stream = String(payload.stream || "");
  const data = payload.data && typeof payload.data === "object" ? payload.data : payload;
  if (stream === "thinking") {
    const text = String(data.text || data.delta || "").trim();
    if (!text) return null;
    return { id: String(data.itemId || "thinking"), text: clipText(text, 8000), replace: true };
  }
  if (stream === "item") {
    const kind = String(data.kind || "");
    const phase = String(data.phase || "");
    if (kind !== "preamble" && kind !== "commentary") return null;
    if (phase && phase !== "update" && phase !== "start") return null;
    const text = String(data.progressText || data.text || data.delta || "").trim();
    if (!text) return null;
    return { id: String(data.itemId || data.title || "preamble"), text: clipText(text, 8000), replace: true };
  }
  if (String(data.phase || "") === "commentary") {
    const text = String(data.text || data.delta || "").trim();
    if (!text) return null;
    return { id: String(data.itemId || "commentary"), text: clipText(text, 8000), replace: true };
  }
  return null;
}

function toolSse(identity, tool) {
  return (
    "data: " +
    JSON.stringify({
      id: identity.id || "chatcmpl_moss",
      object: "chat.completion.chunk",
      created: identity.created || Math.floor(Date.now() / 1000),
      model: identity.model || "openclaw/default",
      choices: [{ index: 0, delta: { moss_tool: tool }, finish_reason: null }],
    }) +
    "\n\n"
  );
}

function thinkingSse(identity, thinking) {
  return (
    "data: " +
    JSON.stringify({
      id: identity.id || "chatcmpl_moss",
      object: "chat.completion.chunk",
      created: identity.created || Math.floor(Date.now() / 1000),
      model: identity.model || "openclaw/default",
      choices: [{ index: 0, delta: { moss_thinking: { items: thinking } }, finish_reason: null }],
    }) +
    "\n\n"
  );
}

function questionSse(identity, question) {
  return (
    "data: " +
    JSON.stringify({
      id: identity.id || "chatcmpl_moss",
      object: "chat.completion.chunk",
      created: identity.created || Math.floor(Date.now() / 1000),
      model: identity.model || "openclaw/default",
      choices: [{ index: 0, delta: { moss_question: question }, finish_reason: null }],
    }) +
    "\n\n"
  );
}

function sameMossSession(eventKey, want, canonical) {
  if (!want || !eventKey) return false;
  if (eventKey === want || eventKey === canonical) return true;
  const key = String(eventKey);
  return key.endsWith(":" + want) || key === "agent:main:" + want;
}

async function proxyChat(req, res) {
  const body = await readBody(req);
  let payload = {};
  try { payload = JSON.parse(body.toString("utf8") || "{}"); } catch {}
  if (!payload || payload.stream !== true) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP.has(k.toLowerCase())) headers[k] = v;
    }
    headers.host = `${GW.host}:${GW.port}`;
    headers.authorization = "Bearer " + gatewayToken();
    if (body.length) headers["content-length"] = String(body.length);
    else delete headers["content-length"];
    const upstream = http.request({ ...GW, method: req.method, path: req.url, headers }, (up) => {
      const out = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (!HOP.has(k.toLowerCase())) out[k] = v;
      }
      res.writeHead(up.statusCode || 502, out);
      up.pipe(res);
    });
    upstream.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("gateway unreachable: " + e.message);
    });
    upstream.end(body);
    return;
  }

  const sessionKey = sessionKeyFromUser(payload.user);
  const chatId = chatIdFromSession(sessionKey);
  try {
    uploads.persistMessageImages(payload.messages, chatId || sessionKey || "chat");
  } catch (e) {
    console.log("moss-uploads skipped:", e && e.message);
  }
  const bodyOut = Buffer.from(JSON.stringify(payload));
  let wsHandle = null;
  let canonical = sessionKey;
  let finished = false;
  let clientAttached = true;
  const identity = { id: "", created: 0, model: "openclaw/default" };
  let heartbeat = null;
  let answer = "";
  const tools = [];
  const thinkingMap = new Map();
  const thinkingOrder = [];
  const thinkingList = () => thinkingOrder.map((id) => thinkingMap.get(id)).filter(Boolean);
  const run = { partial: "", tools, thinking: [], done: false, cancel: null };
  if (chatId) {
    const prev = runs.get(chatId);
    if (prev && !prev.done) {
      // A dropped phone stream must not kill the in-flight turn.
      json(res, 409, {
        pending: true,
        partial: prev.partial || "",
        liveTools: prev.tools || [],
        thinking: prev.thinking || [],
        questions: questionsFor(chatId),
      });
      return;
    }
    run.questions = questionsFor(chatId);
    runs.set(chatId, run);
  }

  const startSse = () => {
    if (!clientAttached || res.headersSent) return;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    try {
      res.write(": connected\n\n");
      res.write(": " + " ".repeat(2048) + "\n\n");
    } catch {}
    heartbeat = setInterval(() => {
      if (!clientAttached || finished || res.writableEnded) return;
      try { res.write(": keepalive\n\n"); } catch {}
    }, 15000);
    if (heartbeat.unref) heartbeat.unref();
  };

  const writeClient = (chunk) => {
    if (!clientAttached || res.writableEnded) return;
    try { res.write(chunk); } catch { clientAttached = false; }
  };

  const inject = (tool) => {
    if (finished || !tool) return;
    upsertRunTool(tools, tool);
    run.partial = answer;
    if (!clientAttached) return;
    startSse();
    writeClient(toolSse(identity, tool));
  };

  const injectThinking = (entry) => {
    if (finished || !entry || !entry.text) return;
    const id = entry.id || "thinking";
    if (!thinkingMap.has(id)) thinkingOrder.push(id);
    if (entry.replace === false) thinkingMap.set(id, (thinkingMap.get(id) || "") + entry.text);
    else thinkingMap.set(id, entry.text);
    run.thinking = thinkingList();
    run.partial = stripThinkingPrefix(answer, run.thinking);
    if (!clientAttached) return;
    startSse();
    writeClient(thinkingSse(identity, run.thinking));
  };

  run.injectQuestion = (question) => {
    if (finished || !question) return;
    run.questions = slimQuestions((run.questions || []).concat([question]));
    if (!clientAttached) return;
    startSse();
    writeClient(questionSse(identity, question));
  };
  if (chatId) {
    questionsFor(chatId).forEach((q) => {
      try { run.injectQuestion(q); } catch {}
    });
  }

  const stopHeartbeat = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const cleanup = () => {
    finished = true;
    stopHeartbeat();
    try { if (wsHandle && wsHandle.ws) wsHandle.ws.close(); } catch {}
  };

  const finishRun = (err) => {
    if (run.done) return;
    run.done = true;
    const think = thinkingList();
    const content = stripThinkingPrefix(answer, think);
    run.thinking = think;
    run.partial = content;
    commitAssistant(chatId, { content, thinking: think, tools, questions: questionsFor(chatId), error: err || "" });
    runs.delete(chatId);
    cleanup();
    if (clientAttached && !res.writableEnded) {
      if (err) {
        startSse();
        writeClient("data: " + JSON.stringify({ error: { message: String(err) } }) + "\n\n");
        writeClient("data: [DONE]\n\n");
      }
      try { res.end(); } catch {}
    }
  };

  const writeSseError = (message) => {
    finishRun(message);
  };

  const detachClient = () => {
    if (!clientAttached) return;
    clientAttached = false;
    stopHeartbeat();
    if (!res.writableEnded) try { res.end(); } catch {}
  };

  // Headers first so a phone is not sitting on a headerless HTTP/2 stream
  // while we open the tool-events websocket (that delay was aborting Chrome).
  startSse();

  const handleToolEvent = (msg) => {
    if (!msg) return;
    if (msg.event === "question.requested" || msg.event === "question.resolved") {
      const p = msg.payload || {};
      if (p.sessionKey && !sameMossSession(p.sessionKey, sessionKey, canonical) && chatIdFromSession(p.sessionKey) !== chatId) {
        return;
      }
      handleQuestionEvent(msg);
      return;
    }
    if (msg.event !== "session.tool" && msg.event !== "agent") return;
    const p = msg.payload || {};
    if (!sameMossSession(p.sessionKey, sessionKey, canonical)) return;
    if (msg.event === "agent" && (p.stream === "thinking" || p.stream === "item")) {
      const entry = fromThinkingPayload(p);
      if (entry) {
        console.log("moss-thinking", p.stream, (entry.text || "").slice(0, 80));
        injectThinking(entry);
      }
      return;
    }
    if (msg.event === "agent" && p.stream && p.stream !== "tool") return;
    const tool = fromAgentTool(p);
    if (tool) {
      console.log("moss-tools", tool.phase, tool.name);
      inject(tool);
    }
  };

  if (sessionKey) {
    connectGatewayWs(handleToolEvent, {
      scopes: ["operator.read", "operator.questions"],
      caps: ["tool-events"],
    })
      .then(async (h) => {
        if (finished) {
          try { h.ws.close(); } catch {}
          return;
        }
        wsHandle = h;
        try {
          await h.rpc("sessions.subscribe", {});
        } catch (e) {
          console.log("moss-tools sessions.subscribe skipped:", e.message);
        }
        if (finished) return;
        const sub = await h.rpc("sessions.messages.subscribe", { key: sessionKey, agentId: "main" });
        if (sub && sub.key) canonical = sub.key;
        console.log("moss-tools subscribed", canonical);
      })
      .catch((e) => {
        console.log("moss-tools ws skipped:", e.message);
        wsHandle = null;
      });
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP.has(k.toLowerCase())) headers[k] = v;
  }
  headers.host = `${GW.host}:${GW.port}`;
  headers.authorization = "Bearer " + gatewayToken();
  headers["content-length"] = String(bodyOut.length);
  if (sessionKey) headers["x-openclaw-session-key"] = sessionKey;

  const upstream = http.request({ ...GW, method: "POST", path: req.url, headers }, (up) => {
    const ctype = String(up.headers["content-type"] || "");
    if ((up.statusCode && up.statusCode >= 400) || !ctype.includes("text/event-stream")) {
      let raw = "";
      up.setEncoding("utf8");
      up.on("data", (c) => { raw += c; });
      up.on("end", () => {
        let msg = "HTTP " + (up.statusCode || 502);
        try {
          const j = JSON.parse(raw);
          msg = (j.error && (j.error.message || j.error.type || j.error)) || raw.slice(0, 300) || msg;
        } catch {
          if (raw) msg = raw.slice(0, 300);
        }
        writeSseError(msg);
      });
      return;
    }
    let buf = "";
    up.setEncoding("utf8");
    up.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i + 1);
        buf = buf.slice(i + 1);
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) {
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") finished = true;
          else {
            try {
              const j = JSON.parse(data);
              if (j.id) identity.id = j.id;
              if (j.created) identity.created = j.created;
              if (j.model) identity.model = j.model;
              const delta = j.choices && j.choices[0] && j.choices[0].delta;
              if (delta && typeof delta.reasoning_content === "string" && delta.reasoning_content) {
                injectThinking({ id: "reasoning", text: delta.reasoning_content, replace: false });
              }
              if (delta && typeof delta.content === "string" && delta.content) {
                answer += delta.content;
                run.partial = stripThinkingPrefix(answer, thinkingList());
              }
            } catch {}
          }
        }
        writeClient(line);
      }
    });
    up.on("end", () => {
      if (buf) writeClient(buf);
      finishRun("");
    });
    up.on("error", () => {
      writeSseError("gateway stream error");
    });
  });
  run.cancel = () => {
    try { upstream.destroy(); } catch {}
    finishRun("cancelled");
  };
  req.on("aborted", detachClient);
  res.on("close", () => {
    if (!res.writableEnded) detachClient();
  });
  upstream.on("error", (e) => {
    writeSseError("gateway unreachable: " + e.message);
  });
  upstream.end(bodyOut);
}

function proxy(req, res) {
  readBody(req)
    .then((body) => {
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (!HOP.has(k.toLowerCase())) headers[k] = v;
      }
      headers.host = `${GW.host}:${GW.port}`;
      headers.authorization = "Bearer " + gatewayToken();
      if (body.length) headers["content-length"] = String(body.length);
      else delete headers["content-length"];

      const upstream = http.request(
        { ...GW, method: req.method, path: req.url, headers },
        (up) => {
          const out = {};
          for (const [k, v] of Object.entries(up.headers)) {
            if (!HOP.has(k.toLowerCase())) out[k] = v;
          }
          res.writeHead(up.statusCode || 502, out);
          up.pipe(res);
        }
      );
      upstream.on("error", (e) => {
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("gateway unreachable: " + e.message);
      });
      upstream.end(body);
    })
    .catch((e) => {
      if (!res.headersSent) res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(e.message);
    });
}

async function api(req, res) {
  if (await notes.api(req, res)) return true;
  const url = (req.url || "").split("?")[0];
  const m = url.match(/^\/api\/chats(?:\/([^/]+))?(?:\/(select|followup|answer))?$/);
  if (!m) return false;

  const store = loadStore();
  const id = m[1];
  const extra = m[2];

  if (!id && req.method === "GET") {
    json(res, 200, summarize(store));
    return true;
  }
  if (!id && req.method === "POST") {
    const empty = store.chats.find(
      (c) => !(c.messages || []).some((m) => m && m.role === "user" && m.content)
    );
    if (empty) {
      store.activeId = empty.id;
      saveStore(store);
      json(res, 200, empty);
      return true;
    }
    const chat = newChat();
    store.chats.unshift(chat);
    store.activeId = chat.id;
    saveStore(store);
    json(res, 200, chat);
    return true;
  }
  if (id && extra === "select" && req.method === "POST") {
    if (!store.chats.some((c) => c.id === id)) {
      json(res, 404, { error: "missing" });
      return true;
    }
    store.activeId = id;
    saveStore(store);
    json(res, 200, { ok: true });
    return true;
  }
  if (id && extra === "followup" && req.method === "POST") {
    const chat = store.chats.find((c) => c.id === id);
    if (!chat) {
      json(res, 404, { error: "missing" });
      return true;
    }
    const run = runs.get(id);
    if (!run || run.done) {
      json(res, 409, { pending: false });
      return true;
    }
    let message = "";
    let attachments = null;
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      message = String(body.message || "").trim();
      if (Array.isArray(body.attachments) && body.attachments.length) {
        attachments = body.attachments
          .filter((a) => a && typeof a.content === "string" && a.content)
          .slice(0, 8)
          .map((a) => ({
            type: String(a.type || "image"),
            mimeType: String(a.mimeType || "image/jpeg"),
            fileName: a.fileName ? String(a.fileName) : undefined,
            content: a.content
          }));
        if (!attachments.length) attachments = null;
      }
    } catch {
      json(res, 400, { error: "bad json" });
      return true;
    }
    if (!message) {
      if (attachments) message = "(photo)";
      else {
        json(res, 400, { error: "empty" });
        return true;
      }
    }
    const msgs = Array.isArray(chat.messages) ? chat.messages : [];
    const last = msgs[msgs.length - 1];
    if (!(last && last.role === "user" && last.content === message)) {
      const row = { role: "user", content: message };
      if (attachments && attachments.length) {
        row.images = attachments.map((a) => "data:" + a.mimeType + ";base64," + a.content);
        const names = attachments.map((a) => a.fileName).filter(Boolean);
        if (names.length) row.imageNames = names;
      }
      chat.messages = msgs.concat([row]);
      chat.updatedAt = Date.now();
      store.chats = [chat].concat(store.chats.filter((c) => c.id !== id));
      store.activeId = id;
      saveStore(store);
    }
    try {
      console.log("moss-followup", id, message.slice(0, 80));
      let steerText = message;
      if (attachments && attachments.length) {
        try {
          const paths = attachments.map((a, i) => {
            const dataUrl = "data:" + a.mimeType + ";base64," + a.content;
            const out = uploads.persistDataUrlImage(id, i, a.fileName || "image.jpg", dataUrl);
            return out && out.path;
          }).filter(Boolean);
          if (paths.length) steerText = message + "\n\n" + uploads.attachmentNote(paths, attachments.map((a) => a.fileName).filter(Boolean));
        } catch (e) {
          console.log("moss-uploads followup skipped:", e && e.message);
        }
      }
      await steerFollowup(id, steerText, attachments);
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 502, { error: (e && e.message) || "steer failed" });
    }
    return true;
  }
  if (id && extra === "answer" && req.method === "POST") {
    const chat = store.chats.find((c) => c.id === id);
    if (!chat) {
      json(res, 404, { error: "missing" });
      return true;
    }
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    } catch {
      json(res, 400, { error: "bad json" });
      return true;
    }
    const questionId = String(body.id || body.questionId || "").trim();
    if (!questionId) {
      json(res, 400, { error: "id" });
      return true;
    }
    const known = questionsFor(id).find((q) => q.id === questionId);
    if (!known) {
      json(res, 404, { error: "question" });
      return true;
    }
    const params = body.cancel === true
      ? { id: questionId, cancel: true, resolvedBy: "moss" }
      : (() => {
          const src = body.answers && typeof body.answers === "object" ? (body.answers.answers || body.answers) : {};
          const answers = {};
          for (const q of known.questions) {
            const raw = src[q.questionId];
            const list = Array.isArray(raw) ? raw : (raw == null || raw === "" ? [] : [raw]);
            const values = list.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 8);
            if (q.isSecret) continue;
            answers[q.questionId] = values.length ? values : [];
          }
          const filled = Object.values(answers).some((v) => v.length);
          if (!filled) return null;
          return { id: questionId, answers: { answers }, resolvedBy: "moss" };
        })();
    if (!params) {
      json(res, 400, { error: "answers" });
      return true;
    }
    try {
      console.log("moss-answer", id, questionId, params.cancel ? "skip" : "send");
      const result = await gatewayRpc(["operator.questions"], "question.resolve", params, 15000);
      if (result && result.status) applyQuestionResolved(Object.assign({ id: questionId }, result));
      json(res, 200, { ok: true, result: result || { status: params.cancel ? "cancelled" : "answered" }, questions: questionsFor(id) });
    } catch (e) {
      json(res, 502, { error: (e && e.message) || "resolve failed" });
    }
    return true;
  }
  if (id && req.method === "GET") {
    const chat = store.chats.find((c) => c.id === id);
    if (!chat) json(res, 404, { error: "missing" });
    else json(res, 200, applyRunOverlay(chat));
    return true;
  }
  if (id && req.method === "PUT") {
    const chat = store.chats.find((c) => c.id === id);
    if (!chat) {
      json(res, 404, { error: "missing" });
      return true;
    }
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const incoming = cleanMessages(body.messages);
      const run = runs.get(id);
      if (run && !run.done) {
        // Keep the user turn; do not let a stale PUT wipe the live reply.
        const users = incoming.filter((m) => m.role === "user");
        const lastUser = users[users.length - 1];
        if (lastUser) {
          const prevUsers = (chat.messages || []).filter((m) => m && m.role === "user");
          const prevLast = prevUsers[prevUsers.length - 1];
          if (!prevLast || prevLast.content !== lastUser.content) {
            chat.messages = (chat.messages || []).concat([lastUser]);
          }
        }
      } else {
        chat.messages = mergeKeepAssistant(chat.messages, incoming);
      }
      chat.title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : titleFrom(chat.messages);
      chat.updatedAt = Date.now();
      store.chats = [chat].concat(store.chats.filter((c) => c.id !== id));
      store.activeId = id;
      saveStore(store);
      json(res, 200, applyRunOverlay(chat));
    } catch {
      json(res, 400, { error: "bad json" });
    }
    return true;
  }
  if (id && req.method === "DELETE") {
    cancelRun(id);
    const target = store.chats.find((c) => c.id === id);
    if (!target) {
      json(res, 404, { error: "missing" });
      return true;
    }
    const started = (target.messages || []).some((m) => m && m.role === "user" && m.content);
    if (!started) {
      json(res, 400, { error: "not started" });
      return true;
    }
    const remaining = store.chats.filter((c) => c.id !== id);
    if (!remaining.length) remaining.push(newChat());
    store.chats = remaining;
    if (store.activeId === id) store.activeId = remaining[0].id;
    saveStore(store);
    json(res, 200, summarize(store));
    return true;
  }
  json(res, 405, { error: "method" });
  return true;
}

http
  .createServer((req, res) => {
    const p = (req.url || "/").split("?")[0];
    handleLogin(req, res).then((loginHit) => {
      if (loginHit) return;
      const authed = validSession(parseCookies(req)[COOKIE]);
      if (!authed && !isPublicPath(p)) {
        deny(req, res);
        return;
      }
      if (p === "/" && req.method === "GET" && !authed) {
        deny(req, res);
        return;
      }
      return api(req, res).then((hit) => {
        if (hit) return;
        if ((req.url || "/").startsWith("/v1")) {
          const pathOnly = (req.url || "/").split("?")[0];
          if (req.method === "POST" && pathOnly === "/v1/chat/completions") {
            proxyChat(req, res).catch((e) => {
              if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
              if (!res.writableEnded) res.end("proxy failed: " + e.message);
            });
          } else proxy(req, res);
        } else serveStatic(req, res);
      });
    }).catch(() => {
      json(res, 500, { error: "server" });
    });
  })
  .listen(PORT, HOST, () => {
    console.log(`moss on ${HOST}:${PORT} -> gateway :${GW.port}`);
    notes.init({ root: ROOT, clipText, json, readBody, gatewayRpc });
    startQuestionHub();
    notes.startPoll();
  });
