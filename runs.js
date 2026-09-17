// Moss — in-memory run/question state and chat-commit logic.
const notes = require("./notes");
const push = require("./push");
const goals = require("./goals");
const { loadStore, saveStore } = require("./store");
const {
  titleFrom,
  slimTools,
  slimQuestion,
  slimQuestions,
  slimThinking,
  chatIdFromSession,
} = require("./text");

// In-flight assistant runs and pending questions, keyed by chat id.
const runs = new Map();
const questionsByChat = new Map();

function chatIdFromRaw(raw) {
  return chatIdFromSession(raw && raw.sessionKey);
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
  const chatId = chatIdFromRaw(raw);
  if (!chatId) return q;
  const prev = questionsByChat.get(chatId) || [];
  const existed = prev.some((x) => x.id === q.id && x.status === "pending");
  const next = prev.filter((x) => x.id !== q.id).concat([q]);
  questionsByChat.set(chatId, next);
  injectQuestionToRun(chatId, q);
  if (q.status === "pending" && !existed) {
    const first = q.questions && q.questions[0];
    push.notifyAsk(chatId, "Moss needs a decision", (first && (first.question || first.header)) || "");
  }
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
  const change = goals.handleGoalEvent(msg);
  if (change) {
    console.log("moss-goal", change.chatId, change.goal ? change.goal.status : "cleared");
    const run = runs.get(change.chatId);
    if (run) {
      run.goal = change.goal;
      if (typeof run.injectGoal === "function") {
        try { run.injectGoal(change.goal); } catch {}
      }
    }
    // Goal completion is when a detached run's final reply becomes available;
    // reconcile pulls it into the store so the chat never renders question-only.
    try { require("./reconcile").onGoalChange(change); } catch {}
  }
}

// Overlay live run state onto a persisted chat for GET responses.
function applyRunOverlay(chat) {
  if (!chat) return chat;
  const run = runs.get(chat.id);
  const qs = questionsFor(chat.id);
  const asking = askingPreview(qs);
  const runLive = !!(run && !run.done);
  const goal = goals.peek(chat.id) || (run && run.goal !== undefined ? run.goal : null);
  if (!runLive) {
    return Object.assign({}, chat, {
      pending: Boolean(asking),
      asking: Boolean(asking),
      partial: "",
      liveTools: [],
      thinking: [],
      questions: qs,
      goal,
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
    goal,
    preview: asking || run.partial || toolHint,
  });
}

// Keep the last assistant reply when a client PUTs a stale message list.
// Newer rule (stale-wipe guard): never let a stale tab replace server history
// wholesale — match rows by role + normalized content, adopt the client's
// extras, append genuinely new rows, and keep server-only rows. This is what
// stopped "whole chat disappears" when a tab that missed a goal run's reply
// PUT its short list over the full server history.
function normContent(m) {
  return String((m && m.content) || "").replace(/\s+/g, " ").trim();
}

function sameContent(a, b) {
  return normContent(a) === normContent(b);
}

function extrasInto(dst, src) {
  for (const k of ["images", "imageNames", "files", "questions", "thinking"]) {
    if (Array.isArray(src[k]) ? src[k].length : src[k]) dst[k] = src[k];
  }
  if (Array.isArray(src.tools) && src.tools.length) dst.tools = src.tools;
  if (src.seed) dst.seed = true;
}

function lastUserIndex(list) {
  for (let i = list.length - 1; i >= 0; i--) if (list[i] && list[i].role === "user") return i;
  return -1;
}

function mergeKeepAssistant(prev, incoming) {
  const prevMsgs = (Array.isArray(prev) ? prev : []).filter(Boolean).map((m) => ({ ...m }));
  const inc = (Array.isArray(incoming) ? incoming : []).filter(Boolean);
  const used = new Set();
  const serverHasTailAssistant = () => {
    const lu = lastUserIndex(prevMsgs);
    return lu >= 0 && prevMsgs.slice(lu + 1).some((m) => m.role === "assistant");
  };
  for (const m of inc) {
    const match = prevMsgs.find((x) => !used.has(x) && x.role === m.role && sameContent(x, m));
    if (match) {
      used.add(match);
      extrasInto(match, m);
      // A client finishing a live turn re-PUTs the assistant tail: let it own
      // that content, same as the old replace-the-list behaviour.
      if (match.role === "assistant") {
        const lu = lastUserIndex(prevMsgs);
        if (lu >= 0 && prevMsgs.indexOf(match) > lu) match.content = m.content;
      }
      continue;
    }
    if (m.role === "user") {
      prevMsgs.push({ ...m });
      used.add(prevMsgs[prevMsgs.length - 1]);
      continue;
    }
    // Unmatched assistant: only append when the server has no reply after its
    // last user (a client that saw a reply the server somehow missed).
    if (!serverHasTailAssistant()) {
      prevMsgs.push({ ...m });
      used.add(prevMsgs[prevMsgs.length - 1]);
    }
  }
  return prevMsgs;
}

// Append (or replace) the assistant reply for the latest user turn.
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
  if (run) {
    run.stopRequested = true;
    if (typeof run.cancel === "function") {
      try { run.cancel(); } catch {}
    }
  }
  runs.delete(chatId);
}

function sidebarChats(store) {
  return (store.chats || []).filter((c) => c && !c.noteId);
}

function summarize(store) {
  const chats = sidebarChats(store);
  let activeId = store.activeId;
  if (!chats.some((c) => c.id === activeId)) activeId = chats[0] ? chats[0].id : null;
  return {
    activeId,
    unreadNotes: notes.unreadCount(),
    chats: chats.map((c) => {
      const over = applyRunOverlay(c);
      const last = (c.messages || []).slice().reverse().find((m) => m && !m.seed);
      const previewText = last && last.content ? String(last.content).replace(/\s+/g, " ").trim().slice(0, 180) : "New chat";
      return {
        id: c.id,
        title: c.title || "New chat",
        updatedAt: over.pending ? Date.now() : c.updatedAt,
        preview: over.pending ? (over.preview || (over.asking ? "Asking…" : "Working…")) : previewText,
        pending: !!over.pending,
        asking: !!over.asking,
        goal: over.goal || null,
      };
    }),
  };
}

module.exports = {
  runs,
  upsertRunTool,
  questionsFor,
  askingPreview,
  rememberQuestion,
  applyQuestionResolved,
  handleQuestionEvent,
  handleGatewayEvent,
  applyRunOverlay,
  mergeKeepAssistant,
  commitAssistant,
  cancelRun,
  summarize,
};
