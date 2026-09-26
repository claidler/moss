// Moss — OpenClaw session Goals: per-chat cache, live events, REST bridge.
// Goal state lives in the gateway; this module caches the latest snapshot per
// chat so GET /api/chats and the Goal pill render stay fast, keeps the cache
// warm from hub sessions.changed events that carry a goal row, and proxies
// operator writes through sessions.goal.update / sessions.goal.clear.
const { chatIdFromSession } = require("./text");
const { AGENT_ID } = require("./config");
const { nid } = require("./http-utils");

let gatewayRpc = null;

function init(deps) {
  if (deps && typeof deps.gatewayRpc === "function") gatewayRpc = deps.gatewayRpc;
}

// chatId -> { goal, fetchedAt }; goal === null means "known: no goal".
const byChat = new Map();
const FETCH_TTL_MS = 15000;
let allFetchedAt = 0;
let allInFlight = null;

function slimGoal(g) {
  if (!g || !g.id) return null;
  const out = {
    id: String(g.id),
    objective: String(g.objective || "").slice(0, 4000),
    status: String(g.status || "active"),
    tokensUsed: Number(g.tokensUsed) || 0,
    createdAt: Number(g.createdAt) || 0,
    updatedAt: Number(g.updatedAt) || 0,
  };
  if ("tokenBudget" in g) out.tokenBudget = g.tokenBudget;
  if (Number.isFinite(g.completedAt)) out.completedAt = g.completedAt;
  if (g.lastStatusNote) out.lastStatusNote = String(g.lastStatusNote).slice(0, 500);
  return out;
}

function remember(chatId, goal) {
  if (!chatId) return null;
  byChat.set(chatId, { goal: goal || null, fetchedAt: Date.now() });
  return goal || null;
}

function peek(chatId) {
  const e = byChat.get(chatId);
  return e ? e.goal : null;
}

function forget(chatId) {
  byChat.delete(chatId);
}

// One forced cache refresh per chat at a time, with a short retry loop: on the
// HTTP completion path the goal is created by the agent's own create_goal tool
// call mid-run (no broadcast at creation), and it can land a beat after the
// tool event that triggered the sync. Resolves with the chat's goal (or null).
const freshSyncs = new Map();
function scheduleFreshSync(chatId) {
  if (!chatId) return Promise.resolve(null);
  const existing = freshSyncs.get(chatId);
  if (existing) return existing;
  const p = (async () => {
    let goal = null;
    for (let attempt = 0; attempt < 3 && !goal; attempt++) {
      goal = (await allFresh(true))[chatId] || null;
      if (!goal) await new Promise((r) => setTimeout(r, 600));
    }
    freshSyncs.delete(chatId);
    return goal || peek(chatId);
  })();
  freshSyncs.set(chatId, p);
  return p;
}

// sessions.changed carrying a goal snapshot or a goal-scoped mutation.
// Note: the gateway broadcasts the goal row on several reasons (goal,
// command-metadata, chat.run.started, send-callback, ...), so a goal-bearing
// snapshot is trusted on any reason; `goal: null` alone only counts when the
// change is goal-scoped, otherwise a pre-goal snapshot could erase a goal.
function handleGoalEvent(msg) {
  if (!msg || msg.event !== "sessions.changed") return null;
  const p = msg.payload || {};
  const chatId = chatIdFromSession(p.sessionKey || p.key);
  if (!chatId) return null;
  const raw = p.goal || (p.session && p.session.goal);
  if (raw && raw.id) return { chatId, goal: remember(chatId, slimGoal(raw)) };
  if (String(p.reason || "") === "goal") return { chatId, goal: remember(chatId, null) };
  return null;
}

// One sessions.list refreshes every chat's goal at once.
function allFresh(force) {
  if (allInFlight && !(force && allFetchedAt && Date.now() - allFetchedAt >= FETCH_TTL_MS)) return allInFlight;
  const now = Date.now();
  if (!force && allFetchedAt && now - allFetchedAt < FETCH_TTL_MS) {
    return Promise.resolve(snapshot());
  }
  if (typeof gatewayRpc !== "function") return Promise.resolve(snapshot());
  allInFlight = (async () => {
    try {
      const listed = await gatewayRpc(["operator.read"], "sessions.list", { agentId: AGENT_ID, limit: 400 }, 20000);
      const rows = (listed && listed.sessions) || [];
      const seen = new Set();
      for (const r of rows) {
        if (!r || !r.key) continue;
        const chatId = chatIdFromSession(r.key);
        if (!chatId) continue;
        seen.add(chatId);
        remember(chatId, r.goal ? slimGoal(r.goal) : null);
      }
      for (const chatId of [...byChat.keys()]) if (!seen.has(chatId)) remember(chatId, null);
      allFetchedAt = Date.now();
    } catch {
      /* keep last-known cache */
    }
    allInFlight = null;
    return snapshot();
  })();
  return allInFlight;
}

function snapshot() {
  return Object.fromEntries([...byChat.entries()].map(([id, e]) => [id, e.goal]));
}

// A finished goal must not block a replacement goal sent from Goal mode.
async function clearTerminal(chatId) {
  let cur = peek(chatId);
  if (!cur || !cur.id) cur = (await allFresh(true))[chatId];
  if (!cur || !cur.id || cur.status !== "complete") return;
  try {
    await gatewayRpc(["operator.read", "operator.write"], "sessions.goal.clear", {
      sessionKey: "moss-" + chatId,
      agentId: AGENT_ID,
      goalId: cur.id,
      operationId: "moss-goal-" + nid(),
      issuedAtMs: Date.now(),
    }, 15000);
    remember(chatId, null);
  } catch {
    /* stale cache; the chat turn will surface any real error */
  }
}

// Pause / complete / block / edit / clear through the gateway Goal API.
// Resume is deliberately NOT here: the client sends a "/goal resume" chat turn
// instead, so the continuation streams and commits like any other Moss reply.
async function mutate(chatId, body) {
  const action = String((body && body.action) || "");
  const current = peek(chatId) || (await allFresh(true))[chatId];
  if (!current || !current.id) {
    const e = new Error("This chat has no Goal right now.");
    e.status = 409;
    throw e;
  }
  const identity = {
    sessionKey: "moss-" + chatId,
    agentId: AGENT_ID,
    goalId: current.id,
    operationId: "moss-goal-" + nid(),
    issuedAtMs: Date.now(),
  };
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 2000) : "";
  let method = "sessions.goal.update";
  let params = identity;
  if (action === "clear") {
    method = "sessions.goal.clear";
  } else if (action === "edit") {
    const objective = String(body.objective || "").trim().slice(0, 16000);
    if (!objective) {
      const e = new Error("A Goal needs an objective.");
      e.status = 400;
      throw e;
    }
    params = { ...identity, action: "edit", objective };
  } else if (action === "pause" || action === "complete" || action === "block") {
    params = { ...identity, action, ...(note ? { note } : {}) };
  } else {
    const e = new Error("Unsupported Goal action.");
    e.status = 400;
    throw e;
  }
  const result = await gatewayRpc(["operator.read", "operator.write"], method, params, 20000);
  if (result && result.status === "cleared") return remember(chatId, null);
  return remember(chatId, result && result.goal ? slimGoal(result.goal) : null);
}

module.exports = {
  init,
  peek,
  forget,
  remember,
  handleGoalEvent,
  allFresh,
  mutate,
  clearTerminal,
  slimGoal,
  scheduleFreshSync,
};
