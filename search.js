// Moss — full-text search over chat messages and automations notes.
//
// store.js already caches the parsed store by mtime, and notifications.json
// is small, so a query is a plain lowercase substring scan over message
// content (~500KB today, a couple of ms). No separate index file to invalidate.
const { json } = require("./http-utils");
const { loadStore } = require("./store");
const notesStore = require("./notes-store");

const MIN_Q = 2;
const MAX_Q = 200;
const MAX_CHAT_HITS = 12;
const MAX_NOTE_HITS = 8;
const SNIPPET = 160;
const PREFIX = 60;

function snippetAround(text, tokens) {
  const low = text.toLowerCase();
  let pos = -1;
  for (const t of tokens) {
    const p = low.indexOf(t);
    if (p >= 0 && (pos < 0 || p < pos)) pos = p;
  }
  const clean = (s) => s.replace(/\s+/g, " ").trim();
  if (pos < 0) {
    const head = clean(text.slice(0, SNIPPET));
    return { snippet: head + (text.length > SNIPPET ? "…" : ""), prefix: head.slice(0, PREFIX) };
  }
  const start = Math.max(0, pos - Math.floor(SNIPPET * 0.3));
  const end = Math.min(text.length, start + SNIPPET);
  return {
    snippet: (start > 0 ? "…" : "") + clean(text.slice(start, end)) + (end < text.length ? "…" : ""),
    prefix: clean(text.slice(0, PREFIX)),
  };
}

function matches(hay, tokens) {
  for (const t of tokens) if (!hay.includes(t)) return false;
  return true;
}

// Mirror of the client's paintChat render filter (js/chats.js): seed rows and
// fully-empty rows are not painted, so visible-bubble indices must skip them.
function renders(m) {
  if (!m || m.seed) return false;
  if (typeof m.content === "string" && m.content) return true;
  if (Array.isArray(m.tools) && m.tools.length) return true;
  if (Array.isArray(m.questions) && m.questions.length) return true;
  const t = m.thinking;
  if (Array.isArray(t) && t.length) return true;
  if (typeof t === "string" && t.trim()) return true;
  return false;
}

function searchQuery(rawQ) {
  const q = String(rawQ || "").trim().slice(0, MAX_Q);
  if (q.length < MIN_Q) return { q, chats: [], notes: [] };
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  const store = loadStore();

  const chatHits = [];
  for (const c of store.chats || []) {
    if (!c || !c.id || c.noteId) continue;
    const title = String(c.title || "New chat");
    const titleMatch = matches(title.toLowerCase(), tokens);
    let bodyMatch = null;
    // `mi` is the index among messages the client actually renders (seed rows
    // are skipped there too), so the hit can scroll the right bubble into view.
    let visible = -1;
    for (const m of c.messages || []) {
      if (!renders(m)) continue;
      visible += 1;
      if (typeof m.content !== "string" || !m.content) continue;
      const low = m.content.toLowerCase();
      if (!matches(low, tokens)) continue;
      bodyMatch = {
        mi: visible,
        role: m.role === "user" ? "You" : "Moss",
        ...snippetAround(m.content, tokens),
      };
      break;
    }
    if (!titleMatch && !bodyMatch) continue;
    const snip = bodyMatch || {
      mi: -1,
      role: "",
      snippet: title,
      prefix: title.replace(/\s+/g, " ").trim().slice(0, PREFIX),
    };
    chatHits.push({
      id: c.id,
      title,
      updatedAt: c.updatedAt || 0,
      mi: snip.mi,
      role: snip.role,
      snippet: snip.snippet,
      prefix: snip.prefix,
    });
  }
  chatHits.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const noteHits = [];
  const notesData = notesStore.loadNotes();
  for (const n of notesData.items || []) {
    if (!n || !n.id) continue;
    const title = String(n.title || "Automation");
    const text = String(n.content || n.preview || "");
    const hay = (title + "\u0000" + text).toLowerCase();
    if (!matches(hay, tokens)) continue;
    const body = text && matches(text.toLowerCase(), tokens)
      ? snippetAround(text, tokens)
      : { snippet: title, prefix: "" };
    noteHits.push({
      id: n.id,
      title,
      createdAt: n.createdAt || 0,
      snippet: body.snippet,
    });
  }
  noteHits.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return {
    q,
    chats: chatHits.slice(0, MAX_CHAT_HITS),
    notes: noteHits.slice(0, MAX_NOTE_HITS),
  };
}

async function api(req, res) {
  if ((req.url || "").split("?")[0] !== "/api/search") return false;
  if (req.method !== "GET") {
    json(res, 405, { error: "method" });
    return true;
  }
  let q = "";
  try {
    q = new URL(req.url, "http://moss.local").searchParams.get("q") || "";
  } catch {}
  json(res, 200, searchQuery(q));
  return true;
}

module.exports = { api, searchQuery };
