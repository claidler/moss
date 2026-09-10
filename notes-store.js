// Moss automations board — notifications.json store.
const fs = require("fs");
const path = require("path");
const {
  isSilentText,
  isProgressText,
  contentScore,
  usefulRun,
  prettyJobName,
} = require("./notes-text");

const MAX_NOTES = 120;
const MAX_CONTENT = 100000;

let ROOT = __dirname;
let clipText = (v, n) => String(v == null ? "" : v).slice(0, n);

function init(deps) {
  if (deps.root) ROOT = deps.root;
  if (typeof deps.clipText === "function") clipText = deps.clipText;
}

function notesFile() {
  return path.join(ROOT, "data", "notifications.json");
}

function loadNotes() {
  try {
    const s = JSON.parse(fs.readFileSync(notesFile(), "utf8"));
    if (s && Array.isArray(s.items)) {
      if (!s.seen || typeof s.seen !== "object") {
        s.seen = {};
        s.items.forEach((n) => {
          if (n && n.id) s.seen[n.id] = 1;
        });
      }
      s.items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return s;
    }
  } catch {}
  return { lastIngestAt: 0, seen: {}, items: [] };
}

function saveNotes(n) {
  if (Array.isArray(n.items)) {
    n.items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  fs.mkdirSync(path.dirname(notesFile()), { recursive: true });
  fs.writeFileSync(notesFile(), JSON.stringify(n));
}

function pruneNotes(notes) {
  const keep = (notes.items || []).filter((n) => {
    const text = String((n && n.content) || "").trim();
    if (!n || !n.id || !text || isSilentText(text) || isProgressText(text)) return false;
    return true;
  });
  if (keep.length === (notes.items || []).length) return false;
  notes.items = keep;
  notes.seen = {};
  keep.forEach((n) => {
    if (n.id) notes.seen[n.id] = 1;
  });
  return true;
}

function noteIdFor(run) {
  const raw = run.runId || ((run.jobId || run.jobName || "job") + ":" + (run.runAtMs || run.ts || Date.now()));
  return clipText(raw, 160);
}

function noteFromRun(run) {
  const content = String(run.error || run.summary || "")
    .replace(/[ \t]*@claidler\b/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const status = run.status === "error" ? "error" : run.status === "skipped" ? "skipped" : "ok";
  return {
    id: noteIdFor(run),
    jobId: clipText(run.jobId || "", 80),
    jobName: clipText(run.jobName || run.name || "", 120),
    title: clipText(prettyJobName(run), 120),
    content: content.slice(0, MAX_CONTENT),
    preview: content.replace(/\s+/g, " ").trim().slice(0, 180),
    status,
    createdAt: Number(run.runAtMs || run.ts) || Date.now(),
    readAt: null,
    runId: clipText(run.runId || "", 160),
    sessionKey: clipText(run.sessionKey || "", 240),
    source: "automation",
  };
}

function dropNote(notes, id) {
  if (!id) return false;
  const next = (notes.items || []).filter((n) => n && n.id !== id);
  if (next.length === (notes.items || []).length) return false;
  notes.items = next;
  delete notes.seen[id];
  return true;
}

function upsertNote(notes, run) {
  const item = noteFromRun(run);
  if (!item.id) return false;
  const existing = (notes.items || []).find((n) => n && n.id === item.id);
  if (!usefulRun(run)) {
    if (existing && (isSilentText(item.content) || isProgressText(item.content))) {
      return dropNote(notes, item.id);
    }
    return false;
  }
  if (existing) {
    if (contentScore(item.content) <= contentScore(existing.content)) return false;
    existing.content = item.content;
    existing.preview = item.preview;
    existing.status = item.status;
    if (item.sessionKey) existing.sessionKey = item.sessionKey;
    if (item.runId) existing.runId = item.runId;
    if (item.jobName) existing.jobName = item.jobName;
    if (item.title) existing.title = item.title;
    return true;
  }
  notes.seen[item.id] = 1;
  notes.items.unshift(item);
  if (notes.items.length > MAX_NOTES) {
    const dropped = notes.items.splice(MAX_NOTES);
    dropped.forEach((d) => {
      if (d && d.id) delete notes.seen[d.id];
    });
  }
  return true;
}

function sameLocalDay(ts, nowMs) {
  const a = new Date(ts);
  const b = new Date(nowMs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// Board shows today's runs only, newest first; older days stay on disk unread.
function todayItems(notes, nowMs) {
  const now = nowMs || Date.now();
  const list = (notes.items || []).filter((n) => n && n.createdAt && sameLocalDay(n.createdAt, now));
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return list;
}

function slimNote(n, full) {
  if (!n) return null;
  const row = {
    id: n.id,
    title: n.title,
    preview: n.preview,
    status: n.status,
    createdAt: n.createdAt,
    read: Boolean(n.readAt),
    jobName: n.jobName,
    source: n.source || "automation",
  };
  if (full) row.content = n.content;
  return row;
}

function unreadCount(notes) {
  const n = notes || loadNotes();
  return (n.items || []).filter((item) => item && !item.readAt).length;
}

function ingestRun(run) {
  const notes = loadNotes();
  if (!upsertNote(notes, run)) return false;
  saveNotes(notes);
  return true;
}

module.exports = {
  MAX_CONTENT,
  init,
  notesFile,
  loadNotes,
  saveNotes,
  pruneNotes,
  noteIdFor,
  noteFromRun,
  dropNote,
  upsertNote,
  sameLocalDay,
  todayItems,
  slimNote,
  unreadCount,
  ingestRun,
};
