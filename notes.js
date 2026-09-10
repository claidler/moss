// Moss automations board — poll, live cron events, and /api/notifications.
const text = require("./notes-text");
const store = require("./notes-store");
const enrich = require("./notes-enrich");

const POLL_MS = 45000;

let json = () => {};
let readBody = async () => Buffer.from("");
let gatewayRpc = null;
let ingestBusy = false;
let pollTimer = null;
const retrying = new Set();

function init(deps) {
  store.init(deps);
  enrich.init(deps);
  if (typeof deps.json === "function") json = deps.json;
  if (typeof deps.readBody === "function") readBody = deps.readBody;
  if (typeof deps.gatewayRpc === "function") gatewayRpc = deps.gatewayRpc;
}

async function ingestCron() {
  if (ingestBusy || typeof gatewayRpc !== "function") return;
  ingestBusy = true;
  try {
    const notes = store.loadNotes();
    let changed = store.pruneNotes(notes);
    const listed = await gatewayRpc(["operator.read"], "cron.list", { includeDisabled: true }, 20000);
    const jobs = (listed && listed.jobs) || [];
    for (const job of jobs.slice(0, 50)) {
      const id = job.id || job.jobId;
      if (!id) continue;
      if (text.isHeartbeatRun({ jobName: job.name, displayName: job.displayName, declarationKey: job.declarationKey })) continue;
      try {
        const runs = await gatewayRpc(["operator.read"], "cron.runs", { id, limit: 8 }, 15000);
        const entries = (runs && runs.entries) || [];
        for (const run of entries.slice(0, 4)) {
          const row = Object.assign(
            {
              jobId: id,
              jobName: job.name || job.displayName,
              displayName: job.displayName || job.name,
              declarationKey: job.declarationKey,
            },
            run
          );
          if (!enrich.existingNeedsEnrich(notes, row) && text.usefulRun(row) && notes.seen[store.noteIdFor(row)]) continue;
          const full = await enrich.enrichRun(row);
          if (store.upsertNote(notes, full)) changed = true;
        }
      } catch (e) {
        console.log("moss-notes runs skipped", id, e.message);
      }
    }
    notes.lastIngestAt = Date.now();
    if (changed) store.saveNotes(notes);
    if (changed) console.log("moss-notes ingested", notes.items.length, "unread", store.unreadCount(notes));
  } catch (e) {
    console.log("moss-notes list skipped:", e.message);
  } finally {
    ingestBusy = false;
  }
}

function scheduleRetry(run) {
  const id = store.noteIdFor(run);
  if (!id || retrying.has(id)) return;
  retrying.add(id);
  setTimeout(() => {
    enrich.enrichRun(run)
      .then((full) => {
        store.ingestRun(full);
      })
      .catch(() => {})
      .finally(() => {
        retrying.delete(id);
      });
  }, 8000);
}

function handleCronEvent(msg) {
  if (!msg) return;
  const ev = String(msg.event || "");
  if (ev !== "cron" && !ev.startsWith("cron.")) return;
  const p = msg.payload || {};
  const job = p.job || {};
  const run = {
    jobId: p.jobId || job.id,
    jobName: job.name || job.displayName || p.jobName,
    displayName: job.displayName || job.name,
    declarationKey: job.declarationKey,
    action: p.action || "finished",
    status: p.status,
    summary: p.summary,
    error: p.error,
    runAtMs: p.runAtMs,
    ts: p.ts,
    runId: p.runId,
    sessionKey: p.sessionKey,
    deliveryStatus: p.deliveryStatus,
  };
  console.log("moss-cron", ev, run.action, run.jobName || run.jobId, String(run.summary || "").slice(0, 80));
  if (run.action && run.action !== "finished") return;
  enrich.enrichRun(run)
    .then((full) => {
      if (store.ingestRun(full)) console.log("moss-notes live", full.jobName, String(full.summary || "").slice(0, 60));
      if (text.looksPartial(full.summary || full.error || "")) scheduleRetry(full);
    })
    .catch(() => {
      store.ingestRun(run);
      scheduleRetry(run);
    });
}

function startPoll() {
  if (pollTimer) return;
  ingestCron().catch(() => {});
  pollTimer = setInterval(() => {
    ingestCron().catch(() => {});
  }, POLL_MS);
  if (pollTimer.unref) pollTimer.unref();
}

async function api(req, res) {
  const url = (req.url || "").split("?")[0];
  const m = url.match(/^\/api\/notifications(?:\/([^/]+))?(?:\/(read))?$/);
  if (!m) return false;
  const id = m[1] ? decodeURIComponent(m[1]) : "";
  const extra = m[2];
  const notes = store.loadNotes();

  if (!id && req.method === "GET") {
    const items = store.todayItems(notes);
    json(res, 200, {
      unread: items.filter((n) => !n.readAt).length,
      items: items.map((n) => store.slimNote(n, false)),
    });
    return true;
  }
  if (!id && extra === undefined && req.method === "POST") {
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    } catch {
      json(res, 400, { error: "bad json" });
      return true;
    }
    const content = String(body.content || body.summary || "").trim();
    const title = String(body.title || body.jobName || "Automation").trim() || "Automation";
    if (!content) {
      json(res, 400, { error: "empty" });
      return true;
    }
    const run = {
      runId: "manual-" + Date.now().toString(36),
      jobName: body.jobName || title,
      displayName: title,
      summary: content,
      status: body.status === "error" ? "error" : "ok",
      runAtMs: Date.now(),
      action: "finished",
    };
    store.ingestRun(run);
    json(res, 200, { ok: true, id: store.noteIdFor(run) });
    return true;
  }
  if (id === "read-all" && req.method === "POST") {
    const now = Date.now();
    (notes.items || []).forEach((n) => {
      if (n && !n.readAt) n.readAt = now;
    });
    store.saveNotes(notes);
    json(res, 200, { ok: true, unread: 0 });
    return true;
  }
  if (id && extra === "read" && req.method === "POST") {
    const item = (notes.items || []).find((n) => n && n.id === id);
    if (!item) {
      json(res, 404, { error: "missing" });
      return true;
    }
    if (!item.readAt) item.readAt = Date.now();
    store.saveNotes(notes);
    json(res, 200, { ok: true, unread: store.unreadCount(notes) });
    return true;
  }
  if (id && req.method === "GET") {
    const item = (notes.items || []).find((n) => n && n.id === id);
    if (!item) {
      json(res, 404, { error: "missing" });
      return true;
    }
    const filled = await enrich.fillNoteIfPartial(item);
    json(res, 200, store.slimNote(filled, true));
    return true;
  }
  if (id && req.method === "DELETE") {
    const next = (notes.items || []).filter((n) => n && n.id !== id);
    if (next.length === (notes.items || []).length) {
      json(res, 404, { error: "missing" });
      return true;
    }
    delete notes.seen[id];
    notes.items = next;
    store.saveNotes(notes);
    json(res, 200, { ok: true, unread: store.unreadCount(notes) });
    return true;
  }
  json(res, 405, { error: "method" });
  return true;
}

module.exports = {
  init,
  handleCronEvent,
  ingestCron,
  startPoll,
  api,
  unreadCount: store.unreadCount,
  loadNotes: store.loadNotes,
  todayItems: store.todayItems,
};
