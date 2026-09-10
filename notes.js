// Moss automations board — ingest cron runs as clickable newsletter items.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const MAX_NOTES = 120;
const POLL_MS = 45000;
const MAX_CONTENT = 100000;
const SQLITE_DB = path.join(
  process.env.HOME || "/home/claidler",
  ".openclaw/agents/main/agent/openclaw-agent.sqlite"
);

let ROOT = __dirname;
let clipText = (v, n) => String(v == null ? "" : v).slice(0, n);
let json = () => {};
let readBody = async () => Buffer.from("");
let gatewayRpc = null;

const HEARTBEAT_NAME = /heartbeat/i;
const HEARTBEAT_SUMMARY = /heartbeat wake requested/i;
const SILENT_TEXT = /^NO_REPLY$/i;
const PROGRESS_TEXT =
  /^(I['’]ll|I will|Let me|I am going to|I'?m going to|Checking|Searching|Looking)\b/i;

let ingestBusy = false;
let pollTimer = null;
const retrying = new Set();

function notesFile() {
  return path.join(ROOT, "data", "notifications.json");
}

function init(deps) {
  if (deps.root) ROOT = deps.root;
  if (typeof deps.clipText === "function") clipText = deps.clipText;
  if (typeof deps.json === "function") json = deps.json;
  if (typeof deps.readBody === "function") readBody = deps.readBody;
  if (typeof deps.gatewayRpc === "function") gatewayRpc = deps.gatewayRpc;
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

function isHeartbeatRun(run) {
  const name = String((run && (run.jobName || run.name || run.displayName)) || "");
  const key = String((run && run.declarationKey) || "");
  const summary = String((run && (run.summary || run.error)) || "");
  if (HEARTBEAT_NAME.test(name) || /^heartbeat:/i.test(key)) return true;
  if (HEARTBEAT_SUMMARY.test(summary)) return true;
  return false;
}

function isSilentText(text) {
  return SILENT_TEXT.test(String(text || "").trim());
}

function isProgressText(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (t.length >= 240) return false;
  return PROGRESS_TEXT.test(t);
}

function looksTruncated(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (t.endsWith("\n...(truncated)...") || t.endsWith("...(truncated)...")) return true;
  if (/[…]$/.test(t) && t.length >= 500) return true;
  if (t.endsWith("...") && t.length >= 1800 && t.length <= 2200) return true;
  return false;
}

function looksPartial(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (isSilentText(t) || isProgressText(t) || looksTruncated(t)) return true;
  return false;
}

function contentScore(text) {
  const t = String(text || "").trim();
  if (!t || isSilentText(t)) return 0;
  if (isProgressText(t)) return 1;
  if (looksTruncated(t)) return 2 + Math.min(t.length, 4000) / 10000;
  return 10 + Math.min(t.length, 80000) / 10000;
}

function usefulRun(run) {
  if (!run) return false;
  if (run.action && run.action !== "finished") return false;
  if (isHeartbeatRun(run)) return false;
  const status = run.status || "";
  const summary = String(run.summary || run.error || "").trim();
  if (isSilentText(summary) || isProgressText(summary)) return false;
  if (status === "error" && summary) return true;
  if (status === "skipped" && !summary) return false;
  if (summary.length < 8) return false;
  return true;
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

function prettyJobName(run) {
  const display = String((run && run.displayName) || "").trim();
  if (display && !HEARTBEAT_NAME.test(display)) {
    return display.replace(/\s*\(main\)\s*$/i, "").trim();
  }
  const name = String((run && (run.jobName || run.name)) || "Automation")
    .replace(/-main$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return name || "Automation";
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

function messageText(m) {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (m.text) return String(m.text);
  if (Array.isArray(m.content)) {
    return m.content.map((p) => (typeof p === "string" ? p : (p && p.text) || "")).join("\n");
  }
  return "";
}

function pickFinalAssistant(messages) {
  const assistants = [];
  (messages || []).forEach((m) => {
    if (!m) return;
    const role = m.role || m.sender || "";
    if (role !== "assistant" && role !== "bot") return;
    const text = String(messageText(m) || "").trim();
    if (text) assistants.push(text);
  });
  if (!assistants.length) return { text: "", silent: false };
  const last = assistants[assistants.length - 1];
  if (isSilentText(last)) return { text: "", silent: true };
  for (let i = assistants.length - 1; i >= 0; i--) {
    if (!isSilentText(assistants[i]) && !isProgressText(assistants[i])) {
      return { text: assistants[i], silent: false };
    }
  }
  return { text: "", silent: false };
}

function sessionIdFromRun(run) {
  const key = String((run && run.sessionKey) || "");
  const fromKey = key.match(/run:([0-9a-f-]{36})/i);
  if (fromKey) return fromKey[1];
  const rid = String((run && (run.runId || run.id)) || "");
  if (/^[0-9a-f-]{36}$/i.test(rid)) return rid;
  const fromId = rid.match(/([0-9a-f-]{36})/i);
  return fromId ? fromId[1] : "";
}

function readTranscriptAssistant(sessionId) {
  if (!sessionId) return null;
  const sessionsDir = path.join(process.env.HOME || "/home/claidler", ".openclaw/agents/main/sessions");
  const script = [
    "import json,sqlite3,sys,glob,os,subprocess",
    "sid,db,sdir=sys.argv[1],sys.argv[2],sys.argv[3]",
    "def texts_from_events(rows):",
    "    out=[]",
    "    for ev in rows:",
    "        if ev.get('type')!='message':",
    "            continue",
    "        msg=ev.get('message') or {}",
    "        role=msg.get('role') or ''",
    "        content=msg.get('content')",
    "        text=''",
    "        if isinstance(content,str): text=content",
    "        elif isinstance(content,list):",
    "            parts=[]",
    "            for c in content:",
    "                if isinstance(c,str): parts.append(c)",
    "                elif isinstance(c,dict): parts.append(c.get('text') or '')",
    "            text='\\n'.join(parts)",
    "        text=(text or '').strip()",
    "        if role in ('assistant','bot') and text: out.append(text)",
    "    return out",
    "out=[]",
    "if os.path.exists(db):",
    "    con=sqlite3.connect('file:'+db+'?mode=ro', uri=True)",
    "    cur=con.cursor()",
    "    cur.execute('SELECT event_json FROM transcript_events WHERE session_id=? ORDER BY seq',(sid,))",
    "    out=texts_from_events([json.loads(raw) for (raw,) in cur])",
    "if not out:",
    "    paths=sorted(glob.glob(os.path.join(sdir, sid+'*.zst')), key=os.path.getmtime, reverse=True)",
    "    if paths:",
    "        raw=subprocess.check_output(['zstdcat', paths[0]], stderr=subprocess.DEVNULL)",
    "        rows=[]",
    "        for line in raw.splitlines():",
    "            if not line.strip():",
    "                continue",
    "            try: rows.append(json.loads(line))",
    "            except Exception: pass",
    "        out=texts_from_events(rows)",
    "print(json.dumps(out))",
  ].join("\n");
  try {
    const proc = spawnSync("python3", ["-c", script, sessionId, SQLITE_DB, sessionsDir], {
      encoding: "utf8",
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (proc.status !== 0) return null;
    const list = JSON.parse(proc.stdout || "[]");
    if (!Array.isArray(list)) return null;
    return pickFinalAssistant(list.map((text) => ({ role: "assistant", content: text })));
  } catch (e) {
    console.log("moss-notes transcript skipped:", e.message);
    return null;
  }
}

async function historyMessages(sessionKey) {
  if (!sessionKey || typeof gatewayRpc !== "function") return [];
  const attempts = [
    ["chat.history", { sessionKey, limit: 80, maxChars: MAX_CONTENT }],
    ["sessions.get", { key: sessionKey, sessionKey, limit: 80 }],
  ];
  for (const [method, params] of attempts) {
    try {
      const hist = await gatewayRpc(["operator.read"], method, params, 12000);
      const messages = (hist && (hist.messages || hist.items)) || [];
      if (messages.length) return messages;
    } catch (e) {
      console.log("moss-notes", method, "skipped:", e.message);
    }
  }
  return [];
}

async function enrichRun(run) {
  if (!run) return run;
  const picked = { text: "", silent: false };
  const key = run.sessionKey;
  if (key) {
    const fromHist = pickFinalAssistant(await historyMessages(key));
    if (fromHist.silent || fromHist.text) {
      picked.text = fromHist.text;
      picked.silent = fromHist.silent;
    }
  }
  if (!picked.silent && looksPartial(picked.text || run.summary || "")) {
    const fromDb = readTranscriptAssistant(sessionIdFromRun(run));
    if (fromDb && (fromDb.silent || contentScore(fromDb.text) > contentScore(picked.text))) {
      picked.text = fromDb.text;
      picked.silent = fromDb.silent;
    }
  }
  if (picked.silent) return Object.assign({}, run, { summary: "NO_REPLY" });
  if (picked.text && contentScore(picked.text) > contentScore(run.summary || "")) {
    return Object.assign({}, run, { summary: picked.text });
  }
  return run;
}

function existingNeedsEnrich(notes, run) {
  const id = noteIdFor(run);
  const existing = (notes.items || []).find((n) => n && n.id === id);
  if (!existing) return true;
  return looksPartial(existing.content);
}

async function ingestCron() {
  if (ingestBusy || typeof gatewayRpc !== "function") return;
  ingestBusy = true;
  try {
    const notes = loadNotes();
    let changed = pruneNotes(notes);
    const listed = await gatewayRpc(["operator.read"], "cron.list", { includeDisabled: true }, 20000);
    const jobs = (listed && listed.jobs) || [];
    for (const job of jobs.slice(0, 50)) {
      const id = job.id || job.jobId;
      if (!id) continue;
      if (isHeartbeatRun({ jobName: job.name, displayName: job.displayName, declarationKey: job.declarationKey })) continue;
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
          if (!existingNeedsEnrich(notes, row) && usefulRun(row) && notes.seen[noteIdFor(row)]) continue;
          const full = await enrichRun(row);
          if (upsertNote(notes, full)) changed = true;
        }
      } catch (e) {
        console.log("moss-notes runs skipped", id, e.message);
      }
    }
    notes.lastIngestAt = Date.now();
    if (changed) saveNotes(notes);
    if (changed) console.log("moss-notes ingested", notes.items.length, "unread", unreadCount(notes));
  } catch (e) {
    console.log("moss-notes list skipped:", e.message);
  } finally {
    ingestBusy = false;
  }
}

function scheduleRetry(run) {
  const id = noteIdFor(run);
  if (!id || retrying.has(id)) return;
  retrying.add(id);
  setTimeout(() => {
    enrichRun(run)
      .then((full) => {
        ingestRun(full);
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
  enrichRun(run)
    .then((full) => {
      if (ingestRun(full)) console.log("moss-notes live", full.jobName, String(full.summary || "").slice(0, 60));
      if (looksPartial(full.summary || full.error || "")) scheduleRetry(full);
    })
    .catch(() => {
      ingestRun(run);
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

async function fillNoteIfPartial(item) {
  if (!item || !looksPartial(item.content)) return item;
  const full = await enrichRun({
    jobId: item.jobId,
    jobName: item.jobName,
    displayName: item.title,
    summary: item.content,
    status: item.status,
    runAtMs: item.createdAt,
    runId: item.runId || item.id,
    sessionKey: item.sessionKey,
    action: "finished",
  });
  const notes = loadNotes();
  if (upsertNote(notes, full)) saveNotes(notes);
  const fresh = loadNotes().items.find((n) => n && n.id === item.id);
  return fresh || item;
}

async function api(req, res) {
  const url = (req.url || "").split("?")[0];
  const m = url.match(/^\/api\/notifications(?:\/([^/]+))?(?:\/(read))?$/);
  if (!m) return false;
  const id = m[1] ? decodeURIComponent(m[1]) : "";
  const extra = m[2];
  const notes = loadNotes();

  if (!id && req.method === "GET") {
    const items = todayItems(notes);
    json(res, 200, {
      unread: items.filter((n) => !n.readAt).length,
      items: items.map((n) => slimNote(n, false)),
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
    ingestRun(run);
    json(res, 200, { ok: true, id: noteIdFor(run) });
    return true;
  }
  if (id === "read-all" && req.method === "POST") {
    const now = Date.now();
    (notes.items || []).forEach((n) => {
      if (n && !n.readAt) n.readAt = now;
    });
    saveNotes(notes);
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
    saveNotes(notes);
    json(res, 200, { ok: true, unread: unreadCount(notes) });
    return true;
  }
  if (id && req.method === "GET") {
    const item = (notes.items || []).find((n) => n && n.id === id);
    if (!item) {
      json(res, 404, { error: "missing" });
      return true;
    }
    const filled = await fillNoteIfPartial(item);
    json(res, 200, slimNote(filled, true));
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
    saveNotes(notes);
    json(res, 200, { ok: true, unread: unreadCount(notes) });
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
  unreadCount,
  loadNotes,
  todayItems,
};
