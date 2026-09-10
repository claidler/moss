export function pretty(v) {
  if (v == null || v === "") return "";
  if (typeof v !== "string") {
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }
  try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
}

export function oneLine(v) {
  return pretty(v).replace(/\s+/g, " ").trim();
}

export function timeLabel(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function stripClaidler(text) {
  return String(text || "").replace(/[ \t]*@claidler\b/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function isProgressLead(text) {
  const t = String(text || "").trim();
  if (!t || t.length >= 240) return false;
  return /^(I['\u2019]ll|I will|Let me|I am going to|I'?m going to|Checking|Searching|Looking)\b/.test(t);
}

export function splitNoteBody(text) {
  const cleaned = stripClaidler(text);
  if (!cleaned || /^NO_REPLY$/i.test(cleaned)) return { thinking: [], body: "" };
  const para = (cleaned.match(/^[\s\S]+?(?:\n\s*\n|$)/) || [cleaned])[0].trim();
  if (!isProgressLead(para)) return { thinking: [], body: cleaned };
  const rest = cleaned.slice(para.length).trim();
  if (!rest || /^NO_REPLY$/i.test(rest)) return { thinking: [para], body: "" };
  return { thinking: [para], body: rest };
}

export function isProgressOnlyNote(n) {
  if (!n) return true;
  return !splitNoteBody(n.content || n.preview || "").body;
}

export function ensureSentenceSpacing(s) {
  return String(s || "").replace(/([.!?:])(?=[A-Z("])/g, "$1 ");
}
