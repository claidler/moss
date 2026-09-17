// Moss — Goal pill: live OpenClaw session-goal status + controls above the composer.
import { state, input, viewingChatId } from "./state.js";
import { chatById, send } from "./chats.js";

const pill = document.getElementById("goalPill");
const toggle = document.getElementById("goalToggle");

const STATUS = {
  active: { label: "Pursuing goal", cls: "on" },
  paused: { label: "Goal paused", cls: "wait" },
  blocked: { label: "Goal blocked", cls: "wait" },
  budget_limited: { label: "Goal out of budget", cls: "wait" },
  usage_limited: { label: "Goal out of budget", cls: "wait" },
  complete: { label: "Goal achieved", cls: "done" }
};

let editing = false;
let busy = false;
let ticker = null;
let errText = "";
// Goal mode is scoped to the chat where it was switched on. Flipping chats
// must not carry it over — that once sent an accidental goal.
let modeChatId = null;

function goalMode() {
  return !!state.goalMode && modeChatId === viewingChatId();
}

// True only when goal mode is on *for the chat now on screen*.
export function goalModeActive() {
  return goalMode();
}

export function setGoalMode(on) {
  state.goalMode = !!on;
  modeChatId = on ? viewingChatId() : null;
  syncToggle();
}

export function clearGoalMode() {
  setGoalMode(false);
}

function syncToggle() {
  if (!toggle) return;
  toggle.setAttribute("aria-pressed", goalMode() ? "true" : "false");
  toggle.classList.toggle("on", goalMode());
  if (input && state.view === "chat") {
    input.placeholder = goalMode() ? "Describe the goal" : "Message Moss";
  }
}

// Repainted on every chat switch/view change so the goal-mode chrome can
// never go stale on a chat that does not have goal mode.
function syncGoalChrome() {
  syncToggle();
  const form = document.getElementById("form");
  if (form) form.classList.toggle("goal-mode", goalMode());
}

function onToggle() {
  const chat = chatById(viewingChatId());
  if (state.view !== "chat" || !chat || chat.pending) return;
  setGoalMode(!goalMode());
  if (goalMode() && input) input.focus();
}

function fmtCount(n) {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1e6) return Math.round(n / 1e6) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(Math.round(n));
}

function fmtElapsed(ts) {
  const s = Math.max(0, Math.floor((Date.now() - (ts || Date.now())) / 1000));
  if (s < 90) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 48) return h + "h " + String(m % 60).padStart(2, "0") + "m";
  return Math.floor(h / 24) + "d";
}

function btn(cls, label, title, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "goal-btn " + cls;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

async function act(body, chatId) {
  if (busy) return;
  busy = true;
  errText = "";
  try {
    const res = await fetch("/api/chats/" + chatId + "/goal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.error) || "HTTP " + res.status);
    const chat = chatById(chatId);
    if (chat) chat.goal = data.goal || null;
  } catch (e) {
    errText = (e && e.message) || "Goal update failed";
  } finally {
    busy = false;
    renderGoalPill();
  }
}

function goalOfActive() {
  const chat = chatById(viewingChatId());
  return chat && chat.goal ? chat.goal : null;
}

function paintEdit(g) {
  pill.innerHTML = "";
  pill.className = "goal-pill editing";
  const row = document.createElement("div");
  row.className = "goal-edit";
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = g.objective || "";
  inp.maxLength = 2000;
  inp.placeholder = "Goal objective";
  inp.setAttribute("aria-label", "Goal objective");
  const save = btn("goal-save", "Save", "Save objective", () => {
    editing = false;
    const v = inp.value.trim();
    if (v && v !== g.objective) act({ action: "edit", objective: v }, chatOf().id);
    else renderGoalPill();
  });
  const cancel = btn("goal-cancel", "Cancel", "Cancel", () => {
    editing = false;
    renderGoalPill();
  });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); save.click(); }
    if (e.key === "Escape") { editing = false; renderGoalPill(); }
  });
  row.appendChild(inp);
  row.appendChild(save);
  row.appendChild(cancel);
  pill.appendChild(row);
  setTimeout(() => { try { inp.focus(); inp.select(); } catch (e) {} }, 0);
}

function chatOf() {
  return chatById(viewingChatId());
}

export function renderGoalPill() {
  if (!pill) return;
  const chat = chatOf();
  const g = state.view === "chat" && chat ? chat.goal : null;
  if (!g || !g.id) {
    editing = false;
    if (!pill.hidden) { pill.hidden = true; pill.innerHTML = ""; pill.className = "goal-pill"; }
    stopTicker();
    return;
  }
  if (editing) { pill.hidden = false; paintEdit(g); startTicker(); return; }
  const st = STATUS[g.status] || STATUS.active;
  pill.hidden = false;
  pill.className = "goal-pill " + st.cls;
  pill.innerHTML = "";

  const dot = document.createElement("span");
  dot.className = "goal-dot";
  pill.appendChild(dot);

  const body = document.createElement("div");
  body.className = "goal-body";
  const line = document.createElement("div");
  line.className = "goal-line";
  const label = document.createElement("b");
  label.textContent = st.label;
  line.appendChild(label);
  const meta = document.createElement("span");
  meta.className = "goal-usage";
  const bits = [fmtElapsed(g.status === "complete" ? g.completedAt || g.updatedAt : g.createdAt)];
  bits.unshift(fmtCount(g.tokensUsed) + " tok");
  meta.textContent = bits.join(" · ");
  line.appendChild(meta);
  body.appendChild(line);
  const obj = document.createElement("div");
  obj.className = "goal-obj";
  obj.textContent = g.objective || "";
  body.appendChild(obj);
  if (errText) {
    const err = document.createElement("div");
    err.className = "goal-err";
    err.textContent = errText;
    body.appendChild(err);
  }
  pill.appendChild(body);

  const btns = document.createElement("div");
  btns.className = "goal-btns";
  if (g.status === "active") {
    btns.appendChild(btn("goal-pause", "❚❚", "Pause goal", () => act({ action: "pause" }, chat.id)));
    btns.appendChild(btn("goal-done", "✓", "Mark complete", () => act({ action: "complete" }, chat.id)));
  } else if (g.status !== "complete") {
    btns.appendChild(btn("goal-resume", "▶", "Resume goal", () => {
      setGoalMode(false);
      send("/goal resume");
    }));
  }
  if (g.status === "active" || g.status === "paused" || g.status === "blocked") {
    btns.appendChild(btn("goal-edit", "✎", "Edit objective", () => { editing = true; renderGoalPill(); }));
  }
  btns.appendChild(btn("goal-clear", "✕", "Clear goal", () => act({ action: "clear" }, chat.id)));
  pill.appendChild(btns);
  startTicker();
}

function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (pill && !pill.hidden && !editing) renderGoalPill();
  }, 30000);
  if (ticker.unref) ticker.unref();
}

function stopTicker() {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

// Warm chat.goal for every sidebar row from the server cache.
export async function warmGoals() {
  try {
    const res = await fetch("/api/goals", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const map = (data && data.goals) || {};
    let changed = false;
    for (const chat of state.chats) {
      const g = map[chat.id] || null;
      const prev = chat.goal ? JSON.stringify(chat.goal) : "";
      const next = g ? JSON.stringify(g) : "";
      if (prev !== next) {
        chat.goal = g;
        changed = true;
      }
    }
    if (changed) {
      if (state.hooks.renderList) state.hooks.renderList();
      renderGoalPill();
    }
  } catch (e) {}
}

export function bootGoals() {
  state.hooks.renderGoal = renderGoalPill;
  state.hooks.warmGoals = warmGoals;
  state.hooks.setGoalMode = setGoalMode;
  state.hooks.syncGoalChrome = syncGoalChrome;
  state.hooks.goalModeActive = goalModeActive;
  if (toggle) toggle.addEventListener("click", onToggle);
  syncToggle();
}
