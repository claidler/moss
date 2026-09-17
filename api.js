// Moss — /api/chats REST endpoints + small public routes.
const notes = require("./notes");
const push = require("./push");
const models = require("./models");
const commands = require("./commands");
const transcribe = require("./transcribe");
const uploads = require("./uploads");
const goals = require("./goals");
const reconcile = require("./reconcile");
const { json, readBody } = require("./http-utils");
const { loadStore, saveStore, newChat } = require("./store");
const { cleanMessages, titleFrom } = require("./text");
const { OWNER_HANDLE, ANDROID_PACKAGE, ANDROID_FINGERPRINT } = require("./config");
const { gatewayRpc, steerFollowup, abortChatRun } = require("./gateway");
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
  const path0 = (req.url || "").split("?")[0];
  if (path0 === "/.well-known/assetlinks.json" && req.method === "GET") {
    // Synthesized from env when configured; otherwise fall through to the
    // committed placeholder file.
    if (ANDROID_PACKAGE && ANDROID_FINGERPRINT) {
      json(res, 200, [
        {
          relation: ["delegate_permission/common.handle_all_urls"],
          target: {
            namespace: "android_app",
            package_name: ANDROID_PACKAGE,
            sha256_cert_fingerprints: [ANDROID_FINGERPRINT],
          },
        },
      ]);
      return true;
    }
  }
  if (await notes.api(req, res)) return true;
  if (await push.api(req, res)) return true;
  if (await models.api(req, res)) return true;
  if (await commands.api(req, res)) return true;
  if (await transcribe.api(req, res)) return true;
  const url = path0;
  if (url === "/api/config" && req.method === "GET") {
    json(res, 200, { ownerHandle: OWNER_HANDLE });
    return true;
  }
  if (url === "/api/goals" && req.method === "GET") {
    json(res, 200, { goals: await goals.allFresh(false) });
    return true;
  }
  if (url === "/api/uploads" && req.method === "POST") {
    if (await uploadRaw(req, res)) return true;
    return false;
  }
  const m = url.match(/^\/api\/chats(?:\/([^/]+))?(?:\/(select|followup|answer|stop|goal))?$/);
  if (!m) return false;

  const store = loadStore();
  const id = m[1];
  const extra = m[2];

  if (!id && req.method === "GET") {
    json(res, 200, summarize(store));
    return true;
  }
  if (!id && req.method === "POST") {
    let body = {};
    try {
      const raw = (await readBody(req)).toString("utf8");
      if (raw) body = JSON.parse(raw);
    } catch {
      json(res, 400, { error: "bad json" });
      return true;
    }
    const noteId = typeof body.noteId === "string" ? body.noteId.trim().slice(0, 160) : "";
    if (noteId) {
      const existing = store.chats.find((c) => c && c.noteId === noteId);
      if (existing) {
        json(res, 200, applyRunOverlay(existing));
        return true;
      }
      const chat = newChat();
      chat.noteId = noteId;
      chat.title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 80) : "Automation";
      const seed = typeof body.seed === "string" ? body.seed.trim() : "";
      if (seed) chat.messages = [{ role: "assistant", content: seed.slice(0, 100000), seed: true }];
      store.chats.unshift(chat);
      saveStore(store);
      json(res, 200, chat);
      return true;
    }
    const empty = store.chats.find(
      (c) => !c.noteId && !(c.messages || []).some((m) => m && m.role === "user" && m.content)
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
    const chat = store.chats.find((c) => c.id === id);
    if (!chat) {
      json(res, 404, { error: "missing" });
      return true;
    }
    if (!chat.noteId) {
      store.activeId = id;
      saveStore(store);
    }
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
  if (id && extra === "stop" && req.method === "POST") {
    if (await stopChat(req, res, store, id)) return true;
    return false;
  }
  if (id && extra === "goal" && req.method === "POST") {
    if (await goalAction(req, res, id)) return true;
    return false;
  }
  if (id && req.method === "GET") {
    const chat = store.chats.find((c) => c.id === id);
    if (!chat) json(res, 404, { error: "missing" });
    else {
      // Heal a chat stranded by a restart/dropped run before rendering it:
      // pull the reply the gateway already has so it is not "question-only".
      try { await reconcile.healOnRead(id, chat); } catch {}
      json(res, 200, applyRunOverlay(chat));
    }
    return true;
  }
  if (id && req.method === "PUT") {
    if (await putChat(req, res, store, id)) return true;
    return false;
  }
  if (id && req.method === "DELETE") {
    cancelRun(id);
    goals.forget(id);
    const target = store.chats.find((c) => c.id === id);
    if (!target) {
      json(res, 404, { error: "missing" });
      return true;
    }
    const started = (target.messages || []).some((m) => m && m.role === "user" && m.content);
    if (!started && !target.noteId) {
      json(res, 400, { error: "not started" });
      return true;
    }
    const remaining = store.chats.filter((c) => c.id !== id);
    if (!remaining.some((c) => c && !c.noteId)) remaining.push(newChat());
    store.chats = remaining;
    if (store.activeId === id) {
      const side = remaining.find((c) => c && !c.noteId) || remaining[0];
      store.activeId = side.id;
    }
    saveStore(store);
    json(res, 200, summarize(store));
    return true;
  }
  json(res, 405, { error: "method" });
  return true;
}

// Pause / complete / block / edit / clear the chat's OpenClaw Goal.
// Resume is a "/goal resume" chat turn from the client so it streams live.
async function goalAction(req, res, id) {
  let body = {};
  try {
    const raw = (await readBody(req)).toString("utf8");
    if (raw) body = JSON.parse(raw);
  } catch {
    json(res, 400, { error: "bad json" });
    return true;
  }
  try {
    const goal = await goals.mutate(id, body || {});
    json(res, 200, { ok: true, goal });
  } catch (e) {
    json(res, e.status || 502, { error: (e && e.message) || "goal update failed" });
  }
  return true;
}

// Abort the in-flight OpenClaw turn without deleting the chat.
async function stopChat(req, res, store, id) {
  const chat = store.chats.find((c) => c.id === id);
  const run = runs.get(id);
  if (!chat && !(run && !run.done)) {
    json(res, 404, { error: "missing" });
    return true;
  }
  const qs = questionsFor(id).filter((q) => q && q.status === "pending");
  console.log("moss-stop", id);
  const abortP = abortChatRun(id).catch((e) => {
    console.log("moss-stop abort skipped:", e && e.message);
  });
  cancelRun(id);
  for (const q of qs) {
    try {
      const result = await gatewayRpc(
        ["operator.questions"],
        "question.resolve",
        { id: q.id, cancel: true, resolvedBy: "moss" },
        8000
      );
      if (result && result.status) applyQuestionResolved(Object.assign({ id: q.id }, result));
      else applyQuestionResolved({ id: q.id, status: "cancelled" });
    } catch {
      applyQuestionResolved({ id: q.id, status: "cancelled" });
    }
  }
  await abortP;
  json(res, 200, chat ? applyRunOverlay(chat) : { ok: true, id, pending: false });
  return true;
}

// Stage any file type (photo, PDF, doc, sheet, audio, ...) to the workspace.
// The client uploads raw bytes once, keeps the returned path, and references
// it on send; the model opens the file from disk with its own tools.
async function uploadRaw(req, res) {
  let u;
  try {
    u = new URL(req.url || "/api/uploads", "http://moss.local");
  } catch {
    u = new URL("/api/uploads", "http://moss.local");
  }
  const name = String(u.searchParams.get("name") || "upload").slice(0, 200);
  const type = String(u.searchParams.get("type") || req.headers["content-type"] || "application/octet-stream").slice(0, 120);
  const chat = String(u.searchParams.get("chat") || "").slice(0, 40);
  let buf;
  try {
    buf = await readBody(req);
  } catch (e) {
    json(res, 413, { error: String((e && e.message) || "too large") });
    return true;
  }
  if (!buf || !buf.length) {
    json(res, 400, { error: "empty" });
    return true;
  }
  if (buf.length > 20 * 1024 * 1024) {
    json(res, 413, { error: "too large" });
    return true;
  }
  const out = uploads.persistUpload(chat || "chat", 0, name, buf, type);
  if (!out) {
    json(res, 500, { error: "store failed" });
    return true;
  }
  console.log("moss-upload", chat || "chat", out.fileName, out.size);
  json(res, 200, out);
  return true;
}

// Steer an in-flight run with a follow-up message (plus persisted images/files).
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
  let files = null;
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
    if (Array.isArray(body.files) && body.files.length) {
      // Non-image files are already staged in the managed upload dir; only
      // paths inside it are accepted (no arbitrary file references).
      files = body.files
        .filter((f) => f && typeof f.path === "string" && uploads.isManagedUploadPath(f.path))
        .slice(0, 8)
        .map((f) => ({
          path: String(f.path),
          fileName: f.fileName ? String(f.fileName).slice(0, 160) : "",
          mime: f.mime ? String(f.mime).slice(0, 120) : "",
          size: Number(f.size) || 0
        }));
      if (!files.length) files = null;
    }
  } catch {
    json(res, 400, { error: "bad json" });
    return true;
  }
  if (!message) {
    if (attachments) message = "(photo)";
    else if (files) message = "(file)";
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
    if (files && files.length) row.files = files;
    chat.messages = msgs.concat([row]);
    chat.updatedAt = Date.now();
    store.chats = [chat].concat(store.chats.filter((c) => c.id !== id));
    if (!chat.noteId) store.activeId = id;
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
        if (paths.length) steerText = steerText + "\n\n" + uploads.attachmentNote(paths, attachments.map((a) => a.fileName).filter(Boolean));
      } catch (e) {
        console.log("moss-uploads followup skipped:", e && e.message);
      }
    }
    if (files && files.length) {
      const note = uploads.fileAttachmentNote(files.map((f) => f.path), files.map((f) => f.fileName).filter(Boolean));
      if (note) steerText = steerText + "\n\n" + note;
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
    if (!chat.noteId) store.activeId = id;
    saveStore(store);
    json(res, 200, applyRunOverlay(chat));
  } catch {
    json(res, 400, { error: "bad json" });
  }
  return true;
}

module.exports = { api };
