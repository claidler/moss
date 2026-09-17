// Moss automations board — pull a full assistant body when cron text is partial.
const path = require("path");
const { spawnSync } = require("child_process");
const {
  looksPartial,
  contentScore,
  pickFinalAssistant,
  sessionIdFromRun,
} = require("./notes-text");
const { MAX_CONTENT, loadNotes, saveNotes, noteIdFor, upsertNote } = require("./notes-store");
const { OPENCLAW_DIR, AGENT_ID } = require("./config");

const SQLITE_DB = path.join(OPENCLAW_DIR, "agents", AGENT_ID, "agent", "openclaw-agent.sqlite");

let gatewayRpc = null;

function init(deps) {
  if (typeof deps.gatewayRpc === "function") gatewayRpc = deps.gatewayRpc;
}

function readTranscriptAssistant(sessionId) {
  if (!sessionId) return null;
  const sessionsDir = path.join(OPENCLAW_DIR, "agents", AGENT_ID, "sessions");
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

module.exports = {
  init,
  readTranscriptAssistant,
  historyMessages,
  enrichRun,
  existingNeedsEnrich,
  fillNoteIfPartial,
};
