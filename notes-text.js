// Moss automations board — classifiers and run text helpers.
const HEARTBEAT_NAME = /heartbeat/i;
const HEARTBEAT_SUMMARY = /heartbeat wake requested/i;
const SILENT_TEXT = /^NO_REPLY$/i;
const PROGRESS_TEXT =
  /^(I['’]ll|I will|Let me|I am going to|I'?m going to|Checking|Searching|Looking)\b/i;

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

module.exports = {
  isHeartbeatRun,
  isSilentText,
  isProgressText,
  looksTruncated,
  looksPartial,
  contentScore,
  usefulRun,
  prettyJobName,
  messageText,
  pickFinalAssistant,
  sessionIdFromRun,
};
