// Moss — gateway tail recovery.
//
// The proxy only owns a run's commit while it is attached. When the service
// restarts mid-run — or the gateway agent keeps pursuing after the client
// stream died — the store keeps just the user line while the gateway session
// already has the final assistant reply; the chat then renders as
// "question-only" and the sidebar preview goes stale. reconcile pulls the
// last assistant text from gateway chat.history for those stale chats and
// commits it to the store (same idea notes-enrich uses for automation bodies).
const runs = require("./runs");
const { AGENT_ID } = require("./config");
const push = require("./push");
const { loadStore } = require("./store");

let gatewayRpc = null;

function init(deps) {
  if (deps && typeof deps.gatewayRpc === "function") gatewayRpc = deps.gatewayRpc;
}

const COOLDOWN_COMMIT_MS = 60000;
const COOLDOWN_NONE_MS = 3000;
const COOLDOWN_ERROR_MS = 20000;
const nextTry = new Map();

function normText(s) {
  return String(s || "").replace(/^\s*\/goal\s+/i, "").replace(/\s+/g, " ").trim();
}

function assistantText(m) {
  if (!m) return "";
  const c = m.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) {
    return c
      .filter((p) => p && typeof p === "object" && typeof p.text === "string")
      .map((p) => p.text)
      .join("")
      .trim();
  }
  return "";
}

function runLive(chatId) {
  const run = runs.runs.get(chatId);
  return !!(run && !run.done);
}

// A chat needs healing when the store is waiting on a reply that never
// landed: started, no live run, tail is a user line (or an empty assistant).
function storeNeedsHeal(chat, live) {
  if (!chat || live) return false;
  const msgs = chat.messages || [];
  if (!msgs.some((m) => m && m.role === "user" && m.content)) return false;
  const last = msgs[msgs.length - 1];
  if (last && last.role === "assistant" && String(last.content || "").trim()) return false;
  return true;
}

const NOTIFY_FRESH_MS = 10 * 60 * 1000;

async function heal(chatId, chat, opts) {
  // Notifications only for fresh goal-event recoveries; startup sweeps and
  // read-time repairs of old chats must stay silent (that burst of "other
  // chat" pushes was the goal-notification leak users saw in unrelated chats).
  const notify = !!(opts && opts.notify === true) && Date.now() - (chat.updatedAt || 0) < NOTIFY_FRESH_MS;
  const now = Date.now();
  if ((nextTry.get(chatId) || 0) > now) return null;
  if (typeof gatewayRpc !== "function") return null;
  let hist = null;
  try {
    hist = await gatewayRpc(
      ["operator.read"],
      "chat.history",
      { sessionKey: "moss-" + chatId, agentId: AGENT_ID, limit: 8 },
      6000
    );
  } catch {
    nextTry.set(chatId, now + COOLDOWN_ERROR_MS);
    return null;
  }
  const gm = (hist && hist.messages) || [];
  let lu = -1;
  for (let i = gm.length - 1; i >= 0; i--) {
    if (gm[i] && gm[i].role === "user") {
      lu = i;
      break;
    }
  }
  let text = "";
  {
    for (let i = gm.length - 1; i >= 0; i--) {
      const t = assistantText(gm[i]);
      if (gm[i] && gm[i].role === "assistant" && t) {
        text = t;
        break;
      }
    }
  }
  const storeMsgs = chat.messages || [];
  const prev = storeMsgs
    .slice()
    .reverse()
    .find((m) => m && m.role === "assistant");
  if (!text || (prev && normText(prev.content) === normText(text))) {
    nextTry.set(chatId, now + COOLDOWN_NONE_MS);
    return null;
  }
  nextTry.set(chatId, now + COOLDOWN_COMMIT_MS);
  runs.commitAssistant(chatId, { content: text });
  console.log("moss-heal", chatId, String(text).replace(/\s+/g, " ").slice(0, 80));
  if (notify) {
    try {
      const row = (loadStore().chats || []).find((c) => c && c.id === chatId);
      push.notifyChat(chatId, (row && row.title) || "Moss", text);
    } catch {}
  }
  return text;
}

async function tryHeal(chatId, opts) {
  const store = loadStore();
  const chat = (store.chats || []).find((c) => c && c.id === chatId);
  if (!chat || chat.noteId) return null;
  if (!storeNeedsHeal(chat, runLive(chatId))) return null;
  return heal(chatId, chat, opts);
}

// Synchronous heal on GET /api/chats/:id so opening a stale chat renders the
// reply instead of the question-only shell the restart left behind.
async function healOnRead(chatId, chat) {
  try {
    if (!storeNeedsHeal(chat, runLive(chatId))) return false;
    return (await heal(chatId, chat, { notify: false })) !== null;
  } catch {
    return false;
  }
}

// Goal completion is the moment a detached run's reply becomes available.
// The final text can land slightly after the goal event, so retry a few
// times; commitAssistant dedupe keeps this single-shot in practice.
function onGoalChange(change) {
  if (!change || !change.goal || change.goal.status !== "complete") return;
  for (const delay of [2000, 8000, 20000]) {
    const t = setTimeout(() => {
      tryHeal(change.chatId, { notify: true }).catch(() => {});
    }, delay);
    if (t.unref) t.unref();
  }
}

let timer = null;

async function sweep() {
  const store = loadStore();
  const ids = (store.chats || []).filter((c) => c && !c.noteId).map((c) => c.id);
  for (const id of ids) {
    if ((nextTry.get(id) || 0) > Date.now()) continue;
    try {
      await tryHeal(id);
    } catch {}
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    sweep().catch(() => {});
  }, 30000);
  if (timer.unref) timer.unref();
}

module.exports = { init, healOnRead, onGoalChange, storeNeedsHeal, start };
