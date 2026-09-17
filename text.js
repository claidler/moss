// Moss — pure text/message normalization helpers (no I/O).
const { AGENT_ID } = require("./config");

function clipText(v, n) {
  if (v == null) return "";
  const s = typeof v === "string" ? v : (() => {
    try { return JSON.stringify(v); } catch { return String(v); }
  })();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function titleFrom(messages) {
  const u = (messages || []).find((m) => m && m.role === "user" && m.content);
  if (!u) return "New chat";
  const t = String(u.content).trim().replace(/\s+/g, " ");
  return t.length > 42 ? t.slice(0, 42) + "…" : t;
}

function slimThinking(parts) {
  if (!Array.isArray(parts)) {
    const s = String(parts || "").trim();
    return s ? [clipText(s, 8000)] : [];
  }
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    const s = String(p || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(clipText(s, 8000));
    if (out.length >= 12) break;
  }
  return out;
}

function thinkingJoined(parts) {
  return slimThinking(parts).join("\n\n");
}

function ensureSentenceSpacing(s) {
  // Never insert after `!` when it is part of `<!` (HTML/doctype markup):
  // the Moss client detects inline-HTML messages by `<!DOCTYPE`/`<html`, so
  // mangling it into `<! DOCTYPE` silently kills the preview. Lookahead +
  // offset check (no lookbehind) for older engines.
  return String(s || "").replace(/[.!?:](?=[A-Z("])/g, (m, off, str) =>
    (m === "!" && str[off - 1] === "<") ? m : m + " ");
}

function stripThinkTags(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\|im_start\|>thinking[\s\S]*?<\|im_end\|>/gi, "")
    .replace(/^\s+/, "");
}

// Remove thinking-fragment prefixes that leak into the answer text.
function stripThinkingPrefix(text, parts) {
  let out = stripThinkTags(text);
  const original = out;
  const frags = slimThinking(parts).slice().sort((a, b) => b.length - a.length);
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 24) {
    changed = false;
    const trimmed = out.replace(/^\s+/, "");
    for (const f of frags) {
      if (!f) continue;
      if (trimmed === f) {
        out = "";
        changed = true;
        break;
      }
      if (trimmed.startsWith(f)) {
        out = trimmed.slice(f.length);
        changed = true;
        break;
      }
      const compact = f.replace(/\s+/g, " ").trim();
      if (!compact) continue;
      const src = trimmed;
      let i = 0;
      let j = 0;
      while (i < src.length && j < compact.length) {
        if (/\s/.test(src[i])) { i += 1; continue; }
        if (/\s/.test(compact[j])) { j += 1; continue; }
        if (src[i] !== compact[j]) break;
        i += 1;
        j += 1;
      }
      if (j >= compact.length) {
        out = src.slice(i);
        changed = true;
        break;
      }
    }
  }
  out = ensureSentenceSpacing(out.replace(/^\s+/, ""));
  if (!out && original.trim()) return ensureSentenceSpacing(original);
  return out;
}

function slimTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t) => t && typeof t === "object")
    .slice(0, 40)
    .map((t) => ({
      id: clipText(t.id || t.toolCallId || "", 80),
      name: clipText(t.name || "tool", 80),
      phase: t.phase === "result" || t.phase === "error" ? t.phase : (t.result ? "result" : "start"),
      args: clipText(t.args, 4000),
      result: clipText(t.result, 8000),
      isError: Boolean(t.isError),
    }))
    .filter((t) => t.name);
}

function slimQuestion(q) {
  if (!q || typeof q !== "object") return null;
  const id = clipText(q.id || "", 80);
  if (!id) return null;
  const status = q.status === "answered" || q.status === "cancelled" || q.status === "expired" ? q.status : "pending";
  const inner = (Array.isArray(q.questions) ? q.questions : []).slice(0, 3).map((item) => {
    if (!item || typeof item !== "object") return null;
    const secret = Boolean(item.isSecret);
    const questionId = clipText(item.questionId || item.id || "", 80);
    const question = clipText(item.question || "", 500);
    if (!questionId || !question) return null;
    return {
      questionId,
      header: clipText(item.header || "", 24),
      question,
      multiSelect: Boolean(item.multiSelect),
      isSecret: secret,
      options: secret
        ? []
        : (Array.isArray(item.options) ? item.options : []).slice(0, 4).map((o) => ({
            label: clipText((o && o.label) || "", 200),
            description: clipText((o && o.description) || "", 300),
          })).filter((o) => o.label),
    };
  }).filter(Boolean);
  if (!inner.length) return null;
  const row = {
    id,
    status,
    createdAtMs: Number(q.createdAtMs) || Date.now(),
    expiresAtMs: Number(q.expiresAtMs) || 0,
    questions: inner,
  };
  if (status === "answered" && q.answers && q.answers.answers && !inner.some((x) => x.isSecret)) {
    const answers = {};
    for (const [k, v] of Object.entries(q.answers.answers)) {
      if (!Array.isArray(v)) continue;
      answers[clipText(k, 80)] = v.map((s) => clipText(s, 500)).filter(Boolean).slice(0, 8);
    }
    row.answers = { answers };
  }
  return row;
}

function slimQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  const out = [];
  const seen = new Set();
  for (const q of questions) {
    const row = slimQuestion(q);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
    if (out.length >= 12) break;
  }
  return out;
}

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => {
      const row = { role: m.role, content: m.content };
      if (typeof m.goalSend === "string" && m.goalSend) row.goalSend = m.goalSend.slice(0, 16200);
      if (Array.isArray(m.images) && m.images.length) {
        row.images = m.images.filter((u) => typeof u === "string" && u).slice(0, 8);
        if (!row.images.length) delete row.images;
      }
      if (Array.isArray(m.imageNames) && m.imageNames.length) {
        row.imageNames = m.imageNames.map((n) => String(n || "")).filter(Boolean).slice(0, 8);
        if (!row.imageNames.length) delete row.imageNames;
      }
      if (Array.isArray(m.files) && m.files.length) {
        row.files = m.files
          .filter((f) => f && typeof f.path === "string" && f.path)
          .slice(0, 8)
          .map((f) => ({
            path: String(f.path),
            fileName: String(f.fileName || ""),
            mime: String(f.mime || ""),
            size: Number(f.size) || 0
          }));
        if (!row.files.length) delete row.files;
      }
      const tools = slimTools(m.tools);
      if (tools.length) row.tools = tools;
      const questions = slimQuestions(m.questions);
      if (questions.length) row.questions = questions;
      const thinking = slimThinking(m.thinking);
      if (thinking.length) row.thinking = thinking;
      if (m.seed) row.seed = true;
      return row;
    });
}

// "agent:<agentId>:moss-abc123" / "moss-abc123" -> "abc123"
function chatIdFromSession(sessionKey) {
  if (!sessionKey) return "";
  const s = String(sessionKey);
  if (/^moss-[a-z0-9]+$/i.test(s)) return s.slice(5);
  const m = s.match(/:moss-([a-z0-9]+)$/i);
  return m ? m[1] : "";
}

function sameMossSession(eventKey, want, canonical) {
  if (!want || !eventKey) return false;
  if (eventKey === want || eventKey === canonical) return true;
  const key = String(eventKey);
  return key.endsWith(":" + want) || key === "agent:" + AGENT_ID + ":" + want;
}

module.exports = {
  clipText,
  titleFrom,
  slimThinking,
  thinkingJoined,
  ensureSentenceSpacing,
  stripThinkTags,
  stripThinkingPrefix,
  slimTools,
  slimQuestion,
  slimQuestions,
  cleanMessages,
  chatIdFromSession,
  sameMossSession,
};
