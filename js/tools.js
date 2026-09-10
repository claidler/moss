import { pretty, oneLine, ensureSentenceSpacing } from "./format.js";

export function thinkingList(parts) {
  if (!Array.isArray(parts)) {
    const s = String(parts || "").trim();
    return s ? [s] : [];
  }
  const out = [];
  const seen = new Set();
  parts.forEach((p) => {
    const s = String(p || "").trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  });
  return out;
}

export function thinkingJoined(parts) {
  return thinkingList(parts).join("\n\n");
}

export function stripThinkingPrefix(text, parts) {
  let out = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\|im_start\|>thinking[\s\S]*?<\|im_end\|>/gi, "");
  const original = out;
  const frags = thinkingList(parts).slice().sort((a, b) => b.length - a.length);
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 24) {
    changed = false;
    const trimmed = out.replace(/^\s+/, "");
    for (let n = 0; n < frags.length; n++) {
      const f = frags[n];
      if (!f) continue;
      if (trimmed === f) { out = ""; changed = true; break; }
      if (trimmed.startsWith(f)) { out = trimmed.slice(f.length); changed = true; break; }
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
      if (j >= compact.length) { out = src.slice(i); changed = true; break; }
    }
  }
  out = ensureSentenceSpacing(out.replace(/^\s+/, ""));
  if (!out && original.trim()) return ensureSentenceSpacing(original.trim());
  return out;
}

export function paintThinking(el, parts, liveOpen) {
  if (!el) return;
  const list = thinkingList(parts);
  if (!list.length) {
    el.innerHTML = "";
    return;
  }
  const prev = el.querySelector("details.think-group");
  const wasOpen = prev ? Boolean(prev.open) : Boolean(liveOpen);
  el.innerHTML = "";
  const group = document.createElement("details");
  group.className = "think-group";
  if (wasOpen) group.open = true;
  const head = document.createElement("summary");
  const nm = document.createElement("span");
  nm.className = "tname";
  nm.textContent = list.length === 1 ? "Thinking" : "Thinking · " + list.length;
  head.appendChild(nm);
  const body = document.createElement("div");
  body.className = "think-body";
  body.textContent = thinkingJoined(list);
  group.appendChild(head);
  group.appendChild(body);
  el.appendChild(group);
}

export function toolLabel(name) {
  const n = String(name || "tool");
  const labels = {
    sessions_search: "Search chats",
    sessions_list: "List chats",
    sessions_history: "Chat history",
    memory_search: "Search memory",
    memory_get: "Read memory",
    web_search: "Web search",
    web_fetch: "Open page",
    exec: "Run command",
    read: "Read file",
    write: "Write file",
    edit: "Edit file",
    apply_patch: "Patch file",
    ask_user: "Ask"
  };
  return labels[n] || n.replace(/_/g, " ");
}

export function visibleTools(tools) {
  return (tools || []).filter((t) => t && t.name !== "ask_user");
}

export function pendingQuestions(list) {
  return (list || []).filter((q) => q && q.status === "pending" && !(q.questions || []).some((item) => item && item.isSecret));
}

export function toolState(t) {
  if (t && t.isError) return "failed";
  if (t && (t.phase === "result" || t.phase === "error" || t.result)) return "done";
  return "running";
}

export function paintTools(rowEl, tools) {
  if (!rowEl) return;
  const list = visibleTools(tools);
  if (!list.length) {
    rowEl.innerHTML = "";
    return;
  }
  const prevGroup = rowEl.querySelector("details.tool-group");
  const wasOpen = Boolean(prevGroup && prevGroup.open);
  const prevToolOpen = [];
  if (prevGroup) {
    prevGroup.querySelectorAll("details.tool").forEach((d, i) => { prevToolOpen[i] = d.open; });
  }
  rowEl.innerHTML = "";
  const running = list.filter((t) => toolState(t) === "running").length;
  const failed = list.filter((t) => toolState(t) === "failed").length;
  const groupState = running ? "running" : (failed ? "failed" : "done");
  const group = document.createElement("details");
  group.className = "tool-group" + (failed ? " error" : "");
  if (wasOpen) group.open = true;
  const head = document.createElement("summary");
  const nm = document.createElement("span");
  nm.className = "tname";
  nm.textContent = running
    ? (list.length === 1 ? "Using " + toolLabel(list[0].name) : "Using " + list.length + " tools")
    : (list.length === 1 ? toolLabel(list[0].name) : list.length + " tools");
  const st = document.createElement("span");
  st.className = "tstate " + groupState;
  st.textContent = groupState;
  head.appendChild(nm);
  head.appendChild(st);
  const inner = document.createElement("div");
  inner.className = "tool-list";
  list.forEach((t, i) => {
    const state = toolState(t);
    const d = document.createElement("details");
    d.className = "tool" + (t.isError ? " error" : "");
    const s = document.createElement("summary");
    const tn = document.createElement("span");
    tn.className = "tname";
    tn.textContent = toolLabel(t.name);
    const ts = document.createElement("span");
    ts.className = "tstate " + state;
    ts.textContent = state;
    s.appendChild(tn);
    s.appendChild(ts);
    s.title = (t.name || "tool") + (t.args ? " · " + oneLine(t.args) : "");
    const body = document.createElement("div");
    body.className = "tbody";
    const pre = document.createElement("pre");
    const parts = [];
    const args = pretty(t.args);
    const result = pretty(t.result);
    if (args) parts.push(args);
    if (result) parts.push(result);
    pre.textContent = parts.join("\n\n") || "(no details)";
    body.appendChild(pre);
    d.appendChild(s);
    d.appendChild(body);
    if (prevToolOpen[i] === true) d.open = true;
    inner.appendChild(d);
  });
  group.appendChild(head);
  group.appendChild(inner);
  rowEl.appendChild(group);
}

export function upsertTool(list, incoming) {
  if (!incoming) return list;
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
    else if (incoming.phase === "result" || incoming.replaceArgs || !slot.args || incoming.args.length >= slot.args.length) slot.args = incoming.args;
  }
  if (incoming.result) slot.result = incoming.result;
  return list;
}

export function upsertQuestion(list, incoming) {
  if (!incoming || !incoming.id) return list;
  const row = {
    id: incoming.id,
    status: incoming.status || "pending",
    createdAtMs: incoming.createdAtMs || Date.now(),
    expiresAtMs: incoming.expiresAtMs || 0,
    questions: incoming.questions || [],
    answers: incoming.answers
  };
  const idx = list.findIndex((x) => x.id === row.id);
  if (idx >= 0) list[idx] = Object.assign({}, list[idx], row);
  else list.push(row);
  return list;
}

export function paintQsums(rowEl, questions) {
  if (!rowEl) return;
  const list = (questions || []).filter((q) => q && q.status && q.status !== "pending");
  rowEl.innerHTML = "";
  if (!list.length) return;
  list.forEach((q) => {
    const card = document.createElement("div");
    card.className = "qsum";
    const title = document.createElement("div");
    title.style.marginBottom = "4px";
    const b = document.createElement("b");
    b.textContent = q.status === "answered" ? "Answered" : (q.status === "expired" ? "Timed out" : "Skipped");
    title.appendChild(b);
    card.appendChild(title);
    (q.questions || []).forEach((item) => {
      const line = document.createElement("div");
      line.className = "qline";
      const lab = document.createElement("b");
      lab.textContent = (item.header || item.question || "Question") + "";
      const val = document.createElement("span");
      const picked = q.answers && q.answers.answers && q.answers.answers[item.questionId];
      val.textContent = q.status === "answered"
        ? (Array.isArray(picked) && picked.length ? picked.join(", ") : "—")
        : (q.status === "expired" ? "no answer" : "skipped");
      line.appendChild(lab);
      line.appendChild(val);
      card.appendChild(line);
    });
    rowEl.appendChild(card);
  });
}
