// Moss — in-memory run/question state and chat-commit logic.
const notes = require("./notes");
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

// Overlay live run state onto a persisted chat for GET responses.
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

// Keep the last assistant reply when a client PUTs a stale message list.
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
