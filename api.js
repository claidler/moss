// Moss — /api/chats REST endpoints.
const notes = require("./notes");
const uploads = require("./uploads");
const { json, readBody } = require("./http-utils");
const { loadStore, saveStore, newChat } = require("./store");
const { cleanMessages, titleFrom } = require("./text");
const { gatewayRpc, steerFollowup } = require("./gateway");
const {
  runs,
  questionsFor,
  applyQuestionResolved,
  applyRunOverlay,
  mergeKeepAssistant,
  cancelRun,
  summarize,
} = require("./runs");

// Returns true when the request matched a /api route.
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
    if (await followup(req, res, store, id)) return true;
    return false;
  }
  if (id && extra === "answer" && req.method === "POST") {
    if (await answer(req, res, store, id)) return true;
    return false;
  }
  if (id && req.method === "GET") {
    const chat = store.chats.find((c) => c.id === id);
    if (!chat) json(res, 404, { error: "missing" });
    else json(res, 200, applyRunOverlay(chat));
    return true;
  }
  if (id && req.method === "PUT") {
    if (await putChat(req, res, store, id)) return true;
    return false;
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

// Steer an in-flight run with a follow-up message (plus persisted images).
async function followup(req, res, store, id) {
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

// Resolve or cancel a pending question via gateway RPC.
async function answer(req, res, store, id) {
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

// Client sync of a chat's message list, protecting the live reply.
async function putChat(req, res, store, id) {
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

module.exports = { api };
