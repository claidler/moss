import {
  log, input, sendBtn, statusEl, botsEl, chatTitle, headAvatar, askEl, state
} from "./state.js";
import { blobSvg, colorFor } from "./faces.js";
import { stripClaidler, timeLabel } from "./format.js";
import { setBubble } from "./markdown.js";
import { stickToBottom } from "./scroll.js";
import { attachmentHint, normalizeImages, clearStaged } from "./media.js";
import { streamChat } from "./stream.js";
import {
  thinkingList, stripThinkingPrefix, paintThinking, toolLabel,
  pendingQuestions, paintTools, upsertTool, upsertQuestion, paintQsums
} from "./tools.js";
import { renderAsk, slimClientQuestions } from "./ask.js";
import { renderBoardRow, refreshNotes, ensureNotesPoll, paintBoard, setView } from "./board.js";

export function setStatus(kind) {
  if (kind === "busy") {
    headAvatar.classList.add("working");
    return;
  }
  headAvatar.classList.remove("working");
  statusEl.className = "status " + kind;
  statusEl.title = kind === "ready" ? "Online" : "Offline";
}

export function clearComposer() {
  input.value = "";
  input.style.height = "auto";
  clearStaged();
}

export function setNav(open) {
  document.body.classList.toggle("nav-open", open);
}

export function showEmpty() {
  log.innerHTML = '<div id="empty"><h2>Hey</h2><p>Talk to OpenClaw from a quieter room.</p></div>';
  state.emptyEl = document.getElementById("empty");
  state.stamped = false;
}

export function add(role, text, tools, questions, opts) {
  if (state.emptyEl && state.emptyEl.parentNode) state.emptyEl.remove();
  state.emptyEl = null;
  if (!state.stamped) {
    const s = document.createElement("div");
    s.className = "stamp";
    s.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    log.appendChild(s);
    state.stamped = true;
  }
  const row = document.createElement("div");
  row.className = "msg " + role;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const toolsEl = document.createElement("div");
  toolsEl.className = "tools";
  const thinkEl = document.createElement("div");
  thinkEl.className = "think";
  const qEl = document.createElement("div");
  qEl.className = "qsums";
  const md = document.createElement("div");
  md.className = "md";
  bubble.appendChild(toolsEl);
  bubble.appendChild(thinkEl);
  bubble.appendChild(qEl);
  const imgs = opts && opts.images;
  if (imgs && imgs.length) {
    const imgsEl = document.createElement("div");
    imgsEl.className = "imgs";
    imgs.forEach((src) => {
      if (!src) return;
      const im = document.createElement("img");
      im.alt = "";
      im.loading = "lazy";
      im.src = src;
      imgsEl.appendChild(im);
    });
    bubble.appendChild(imgsEl);
  }
  bubble.appendChild(md);
  const thinking = opts && opts.thinking;
  setBubble(md, stripClaidler(stripThinkingPrefix(text, thinking)), opts);
  if (tools && tools.length) paintTools(toolsEl, tools);
  if (thinking && thinkingList(thinking).length) paintThinking(thinkEl, thinking, Boolean(opts && opts.liveThinking));
  if (questions && questions.length) paintQsums(qEl, questions);
  row.appendChild(bubble);
  log.appendChild(row);
  stickToBottom(true);
  return bubble;
}

export function chatStarted(c) {
  if (!c) return false;
  if (c.pending || c.partial || pendingQuestions(c.questions).length) return true;
  if ((c.messages || []).some((m) => m && m.role === "user" && m.content)) return true;
  if (c.title && c.title !== "New chat") return true;
  if (c.preview && c.preview !== "New chat") return true;
  return false;
}

export function runningPreview(c) {
  const pending = pendingQuestions(c.questions)[0];
  if (pending && pending.questions && pending.questions[0] && pending.questions[0].question) {
    return pending.questions[0].question;
  }
  if (c.partial) return c.partial;
  const live = c.liveTools && c.liveTools[0] && c.liveTools[0].name;
  if (live) return "Using " + toolLabel(live);
  if (c.preview && c.preview !== "New chat") return c.preview;
  return "Working\u2026";
}

export function renderList() {
  botsEl.innerHTML = "";
  botsEl.appendChild(renderBoardRow());
  const ordered = state.chats.slice().sort((a, b) => {
    const ap = a.pending ? 1 : 0;
    const bp = b.pending ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  ordered.forEach((c) => {
    const row = document.createElement("div");
    row.className = "bot-row" + (state.view === "chat" && c.id === state.activeId ? " active" : "") + (c.pending ? " running" : "");
    if (c.pending) row.setAttribute("aria-busy", "true");
    row.innerHTML =
      `<div class="avatar${c.pending ? " working" : ""}">${blobSvg(colorFor(c.id), "b" + c.id)}</div>
       <div><div class="bot-name"></div><div class="bot-preview"></div></div>
       ` +
      (c.pending ? `<span class="bot-run${c.asking || pendingQuestions(c.questions).length ? " ask" : ""}">${c.asking || pendingQuestions(c.questions).length ? "Asking" : "Running"}</span>` : `<div class="bot-time"></div>`) +
      (chatStarted(c)
        ? `<button class="del" type="button" aria-label="Delete chat">
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V5h6v2M10 11v6M14 11v6M6 7l1 12h10l1-12"/></svg>
           </button>`
        : `<span></span>`);
    row.querySelector(".bot-name").textContent = c.title || "New chat";
    row.querySelector(".bot-preview").textContent = c.pending ? runningPreview(c) : (c.preview || "New chat");
    const time = row.querySelector(".bot-time");
    if (time) time.textContent = timeLabel(c.updatedAt);
    row.addEventListener("click", () => switchChat(c.id));
    const del = row.querySelector(".del");
    if (del) {
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteChat(c.id);
      });
    }
    botsEl.appendChild(row);
  });
}

export function chatById(id) {
  return state.chats.find((c) => c.id === id);
}

export function syncBusy() {
  if (state.view !== "chat") {
    sendBtn.disabled = true;
    input.placeholder = "Automations board";
    headAvatar.classList.remove("working");
    return;
  }
  const chat = chatById(state.activeId);
  const busy = !!(chat && chat.pending);
  sendBtn.disabled = false;
  input.placeholder = busy ? "Add a follow-up" : "Message Moss";
  headAvatar.classList.toggle("working", busy);
}

export function paintChat(chat) {
  setView("chat");
  state.noteOpen = null;
  log.innerHTML = "";
  state.stamped = false;
  state.emptyEl = null;
  chatTitle.textContent = chat.title || "Moss";
  headAvatar.className = "avatar";
  headAvatar.innerHTML = blobSvg(colorFor(chat.id), "head");
  const msgs = chat.messages || [];
  if (!msgs.length && !chat.partial && !pendingQuestions(chat.questions).length) {
    showEmpty();
    renderAsk(chat);
    syncBusy();
    return;
  }
  msgs.forEach((m) => {
    if (!m || (!m.content && !(m.tools && m.tools.length) && !(m.questions && m.questions.length) && !thinkingList(m.thinking).length)) return;
    add(m.role === "user" ? "user" : "bot", m.content || "", m.tools, m.questions, { thinking: m.thinking, images: m.images });
  });
  const last = msgs[msgs.length - 1];
  if (chat.pending && !(last && last.role === "assistant")) {
    add("bot", chat.partial || "", chat.liveTools, chat.questions, { preview: false, thinking: chat.thinking, liveThinking: true });
  } else if (last && last.role === "assistant" && chat.questions && chat.questions.length) {
    const bubble = log.querySelector(".msg.bot:last-of-type .bubble");
    const qEl = bubble && bubble.querySelector(".qsums");
    if (qEl) paintQsums(qEl, chat.questions);
  }
  renderAsk(chat);
  syncBusy();
}

export function rememberChat(chat) {
  const existing = chatById(chat.id);
  const row = existing || {
    id: chat.id,
    title: chat.title || "New chat",
    preview: chat.preview || "New chat",
    updatedAt: chat.updatedAt || Date.now(),
    messages: [],
    pending: false,
    asking: false,
    partial: "",
    liveTools: [],
    questions: [],
    saveChain: Promise.resolve()
  };
  if (!existing) state.chats.unshift(row);
  row.title = chat.title || row.title;
  row.updatedAt = chat.updatedAt || row.updatedAt;
  if (Array.isArray(chat.messages)) row.messages = chat.messages;
  row.pending = !!chat.pending;
  row.asking = !!chat.asking;
  row.partial = chat.partial || "";
  row.liveTools = chat.liveTools || [];
  row.thinking = Array.isArray(chat.thinking) ? chat.thinking : thinkingList(chat.thinking);
  if (Array.isArray(chat.questions)) row.questions = chat.questions;
  const last = row.messages && row.messages[row.messages.length - 1];
  row.preview = chat.preview || row.partial || (last && last.content) || row.preview || "New chat";
  return row;
}

export function liveStream(chat) {
  return !!(chat && chat.pending && chat.abort && !chat.abort.signal.aborted);
}

export async function fetchChat(id) {
  const res = await fetch("/api/chats/" + id, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

export function ensurePoll() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(() => { tickPending(); }, 1000);
}

export function stopPollIfIdle() {
  if (state.chats.some((c) => c.pending)) return;
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

export async function tickPending() {
  if (state.pollInFlight) return;
  const pending = state.chats.filter((c) => c.pending && !liveStream(c));
  if (!pending.length) {
    stopPollIfIdle();
    return;
  }
  state.pollInFlight = true;
  try {
    for (const chat of pending) {
      if (chat.gone) continue;
      try {
        const full = await fetchChat(chat.id);
        rememberChat(full);
        if (chat.id === state.activeId) paintChat(chatById(chat.id) || chat);
      } catch (e) {}
    }
    renderList();
    syncBusy();
  } finally {
    state.pollInFlight = false;
    stopPollIfIdle();
  }
}

export async function refreshVisible() {
  if (document.visibilityState === "hidden") return;
  await refreshNotes();
  if (state.view !== "chat") {
    if (state.view === "board") paintBoard();
    if (state.chats.some((c) => c.pending)) ensurePoll();
    await tickPending();
    return;
  }
  if (state.activeId) {
    const chat = chatById(state.activeId);
    if (!liveStream(chat)) {
      try {
        const full = await fetchChat(state.activeId);
        const next = rememberChat(full);
        paintChat(next);
      } catch (e) {}
    }
  }
  if (state.chats.some((c) => c.pending)) ensurePoll();
  await tickPending();
}

export function saveChat(chat) {
  const msgs = (chat.messages || []).map((m) => {
    const row = { role: m.role, content: m.content };
    if (m.tools && m.tools.length) row.tools = m.tools;
    if (m.questions && m.questions.length) row.questions = m.questions;
    if (Array.isArray(m.images) && m.images.length) row.images = m.images;
    if (Array.isArray(m.imageNames) && m.imageNames.length) row.imageNames = m.imageNames;
    const think = thinkingList(m.thinking);
    if (think.length) row.thinking = think;
    return row;
  });
  const first = msgs.find((m) => m.role === "user");
  const title = first ? first.content.trim().replace(/\s+/g, " ").slice(0, 42) : "New chat";
  const last = msgs[msgs.length - 1];
  const liveName = chat.liveTools && chat.liveTools[0] && chat.liveTools[0].name;
  const lastTools = last && last.tools;
  const toolHint = liveName ? "Using " + liveName : (lastTools && lastTools.length ? "Used " + lastTools.map((t) => t.name).filter(Boolean).join(", ") : "");
  chat.title = title;
  chat.preview = chat.partial || (last && last.content) || toolHint || "New chat";
  chat.updatedAt = Date.now();
  state.chats = [chat].concat(state.chats.filter((x) => x.id !== chat.id));
  if (state.activeId === chat.id) chatTitle.textContent = title;
  renderList();
  chat.saveChain = (chat.saveChain || Promise.resolve()).then(async () => {
    if (chat.gone) return;
    await fetch("/api/chats/" + chat.id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: msgs, title })
    });
  }).catch(() => {});
  return chat.saveChain;
}

export async function boot() {
  const res = await fetch("/api/chats", { cache: "no-store" });
  const data = await res.json();
  state.chats = (data.chats || []).map((c) => ({
    ...c,
    messages: c.messages || [],
    pending: !!c.pending,
    asking: !!c.asking,
    partial: c.partial || "",
    liveTools: c.liveTools || [],
    questions: c.questions || [],
    saveChain: Promise.resolve()
  }));
  state.activeId = data.activeId;
  if (!state.activeId && state.chats[0]) state.activeId = state.chats[0].id;
  if (!state.activeId) {
    await createChat();
    await refreshNotes();
    ensureNotesPoll();
    return;
  }
  const full = await fetchChat(state.activeId);
  const chat = rememberChat(full);
  paintChat(chat);
  await refreshNotes();
  ensureNotesPoll();
  renderList();
  if (state.chats.some((c) => c.pending)) ensurePoll();
}

export async function createChat() {
  const existing = state.chats.find((c) => !chatStarted(c));
  if (existing) {
    await switchChat(existing.id);
    return;
  }
  const created = await (await fetch("/api/chats", { method: "POST" })).json();
  const chat = rememberChat({ ...created, messages: created.messages || [], preview: "New chat" });
  state.activeId = chat.id;
  paintChat(chat);
  renderList();
  setNav(false);
  clearComposer();
  input.focus();
}

export async function deleteChat(id) {
  const doomed = chatById(id);
  if (!chatStarted(doomed)) return;
  if (doomed) {
    doomed.gone = true;
    if (doomed.abort) doomed.abort.abort();
  }
  const res = await fetch("/api/chats/" + id, { method: "DELETE" });
  if (!res.ok) return;
  const data = await res.json();
  const wasActive = id === state.activeId;
  const kept = new Map(state.chats.filter((c) => c.id !== id).map((c) => [c.id, c]));
  state.chats = (data.chats || []).map((c) => kept.get(c.id) || { ...c, messages: c.messages || [], pending: !!c.pending, asking: !!c.asking, partial: c.partial || "", liveTools: c.liveTools || [], questions: c.questions || [], saveChain: Promise.resolve() });
  state.activeId = data.activeId;
  if (wasActive) {
    const full = await (await fetch("/api/chats/" + state.activeId, { cache: "no-store" })).json();
    paintChat(rememberChat(full));
  }
  renderList();
}

export async function switchChat(id) {
  if (id === state.activeId) {
    setNav(false);
    return;
  }
  let chat = chatById(id);
  if (!liveStream(chat)) {
    const full = await fetchChat(id);
    chat = rememberChat(full);
  }
  await fetch("/api/chats/" + id + "/select", { method: "POST" });
  state.activeId = id;
  paintChat(chat);
  renderList();
  setNav(false);
  if (state.chats.some((c) => c.pending)) ensurePoll();
  input.focus();
}

export async function sendFollowup(chat, text, images) {
  const items = normalizeImages(images);
  const atts = items.map((item) => {
    const url = item.url;
    const comma = url.indexOf(",");
    return {
      type: "image",
      mimeType: item.mime || "image/jpeg",
      fileName: item.fileName || undefined,
      content: comma >= 0 ? url.slice(comma + 1) : url
    };
  });
  const urls = items.map((i) => i.url);
  const names = items.map((i) => i.fileName).filter(Boolean);
  if (state.activeId === chat.id) add("user", text, undefined, undefined, { images: urls.length ? urls : undefined });
  try {
    const res = await fetch("/api/chats/" + chat.id + "/followup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, attachments: atts.length ? atts : undefined })
    });
    if (res.ok) {
      const last = (chat.messages || [])[(chat.messages || []).length - 1];
      if (!(last && last.role === "user" && last.content === text)) {
        chat.messages = (chat.messages || []).concat([{ role: "user", content: text, images: urls.length ? urls : undefined, imageNames: names.length ? names : undefined }]);
      }
      await saveChat(chat);
      return;
    }
    if (res.status === 409) {
      const next = rememberChat(await fetchChat(chat.id));
      const last = (next.messages || [])[(next.messages || []).length - 1];
      if (!(last && last.role === "user" && last.content === text)) {
        next.messages = (next.messages || []).concat([{ role: "user", content: text, images: urls.length ? urls : undefined, imageNames: names.length ? names : undefined }]);
      }
      if (!next.pending) await startTurn(next);
      else if (state.activeId === next.id) paintChat(next);
      return;
    }
    throw new Error("HTTP " + res.status);
  } catch (e) {
    const last = (chat.messages || [])[(chat.messages || []).length - 1];
    if (!(last && last.role === "user" && last.content === text)) {
      chat.messages = (chat.messages || []).concat([{ role: "user", content: text, images: urls.length ? urls : undefined, imageNames: names.length ? names : undefined }]);
      await saveChat(chat);
    }
    if (state.activeId === chat.id) setStatus("bad");
  } finally {
    if (state.activeId === chat.id) {
      syncBusy();
      input.focus();
    }
  }
}

export async function send(text, images) {
  if (state.view !== "chat") return;
  const chat = chatById(state.activeId);
  if (!chat) return;
  if (chat.pending) {
    await sendFollowup(chat, text, images);
    return;
  }
  clearComposer();
  if (!chat.messages) chat.messages = [];
  const items = normalizeImages(images);
  const imgs = items.length ? items.map((i) => i.url) : undefined;
  const imageNames = items.map((i) => i.fileName).filter(Boolean);
  chat.messages.push({ role: "user", content: text, images: imgs, imageNames: imageNames.length ? imageNames : undefined });
  if (state.activeId === chat.id) add("user", text, undefined, undefined, { images: imgs });
  await startTurn(chat);
}

export async function startTurn(chat) {
  if (!chat || chat.pending) return;
  const chatId = chat.id;
  chat.pending = true;
  chat.partial = "";
  chat.thinking = [];
  chat.abort = new AbortController();
  ensurePoll();
  let liveBubble = null;
  if (state.activeId === chatId) liveBubble = add("bot", "");
  syncBusy();
  const payload = chat.messages.map((m) => {
    if (m.role === "user" && Array.isArray(m.images) && m.images.length) {
      const parts = [];
      const names = Array.isArray(m.imageNames) ? m.imageNames : [];
      const items = m.images.slice(0, 8).map((url, i) => ({ url, fileName: names[i] || "" })).filter((x) => x.url);
      const hint = attachmentHint(items);
      const text = [m.content, hint].filter(Boolean).join("\n\n");
      if (text) parts.push({ type: "text", text });
      items.forEach((item) => {
        parts.push({ type: "image_url", image_url: { url: item.url } });
      });
      if (parts.length) return { role: m.role, content: parts };
    }
    return { role: m.role, content: m.content };
  });
  await saveChat(chat);
  let answer = "";
  const tools = [];
  chat.liveTools = tools;
  const paintLive = (done) => {
    chat.partial = stripThinkingPrefix(answer, chat.thinking);
    chat.liveTools = tools;
    if (state.activeId !== chatId) return;
    const bubble = liveBubble || log.querySelector(".msg.bot:last-of-type .bubble");
    if (!bubble) return;
    const md = bubble.querySelector(".md") || bubble;
    setBubble(md, chat.partial, { preview: !!done });
    const row = bubble.querySelector(".tools");
    if (row) paintTools(row, tools);
    const thEl = bubble.querySelector(".think");
    if (thEl) paintThinking(thEl, chat.thinking, !done);
    const qEl = bubble.querySelector(".qsums");
    if (qEl) paintQsums(qEl, chat.questions);
    renderAsk(chat);
    stickToBottom();
  };
  try {
    let streamErr = null;
    await streamChat({
      model: "openclaw/default",
      stream: true,
      user: "moss-" + chatId,
      messages: payload
    }, chat.abort.signal, (j) => {
      if (j.error) {
        streamErr = new Error(j.error.message || j.error.code || "OpenClaw error");
        return;
      }
      try {
        const delta = j.choices && j.choices[0] && j.choices[0].delta;
        if (!delta) return;
        let changed = false;
        if (delta.moss_tool) {
          upsertTool(tools, delta.moss_tool);
          changed = true;
        }
        if (delta.moss_question) {
          chat.questions = upsertQuestion(chat.questions || [], delta.moss_question);
          chat.asking = (chat.questions || []).some((q) => q.status === "pending");
          if (chat.asking) chat.pending = true;
          changed = true;
        }
        if (delta.moss_thinking) {
          const items = delta.moss_thinking.items || delta.moss_thinking.text || delta.moss_thinking;
          chat.thinking = thinkingList(items);
          changed = true;
        }
        if (Array.isArray(delta.tool_calls)) {
          delta.tool_calls.forEach((t) => {
            const fn = t.function || {};
            upsertTool(tools, {
              id: t.id || "",
              idx: t.index,
              name: fn.name || "",
              args: typeof fn.arguments === "string" ? fn.arguments : "",
              phase: "start",
              appendArgs: !fn.name && typeof fn.arguments === "string"
            });
          });
          changed = true;
        }
        if (delta.content) {
          answer += delta.content;
          changed = true;
        }
        if (changed) paintLive();
      } catch (e) {}
    });
    if (chat.gone) return;
    if (streamErr) throw streamErr;
    const last = chat.messages[chat.messages.length - 1];
    const asked = slimClientQuestions(chat.questions);
    const think = thinkingList(chat.thinking);
    const visible = stripThinkingPrefix(answer, think);
    if (last && last.role === "assistant") {
      last.content = visible;
      if (tools.length) last.tools = tools;
      else delete last.tools;
      if (asked.length) last.questions = asked;
      else delete last.questions;
      if (think.length) last.thinking = think;
      else delete last.thinking;
    } else {
      chat.messages.push({ role: "assistant", content: visible, tools: tools.length ? tools : undefined, questions: asked.length ? asked : undefined, thinking: think.length ? think : undefined });
    }
    chat.partial = "";
    chat.liveTools = [];
    chat.pending = pendingQuestions(chat.questions).length > 0;
    chat.asking = chat.pending;
    chat.abort = null;
    await saveChat(chat);
    if (state.activeId === chatId) {
      paintLive(true);
      setStatus("ready");
    }
  } catch (e) {
    if (chat.gone) return;
    const raw = (e && e.message) || "request failed";
    const dropped = e.name === "AbortError" || e.code === "pending" || /failed to fetch|networkerror|load failed|connection|aborted/i.test(raw);
    if (dropped) {
      chat.abort = null;
      chat.pending = true;
      chat.partial = answer || chat.partial || "";
      chat.liveTools = tools.length ? tools : (chat.liveTools || []);
      ensurePoll();
      tickPending();
      if (state.activeId === chatId) syncBusy();
      return;
    }
    const errText = "(error) " + raw;
    if (state.activeId === chatId) {
      const bubble = liveBubble || log.querySelector(".msg.bot:last-of-type .bubble");
      const md = bubble && (bubble.querySelector(".md") || bubble);
      if (md) md.textContent = answer ? answer + "\n\n" + errText : errText;
      const row = bubble && bubble.querySelector(".tools");
      if (row && tools.length) paintTools(row, tools);
      setStatus("bad");
    }
    if (answer || tools.length || thinkingList(chat.thinking).length) {
      const think = thinkingList(chat.thinking);
      chat.messages.push({
        role: "assistant",
        content: stripThinkingPrefix(answer, think) || errText,
        tools: tools.length ? tools : undefined,
        questions: slimClientQuestions(chat.questions).length ? slimClientQuestions(chat.questions) : undefined,
        thinking: think.length ? think : undefined
      });
      chat.partial = "";
      chat.liveTools = [];
      await saveChat(chat);
    }
    chat.pending = false;
  } finally {
    chat.partial = chat.partial || "";
    if (state.activeId === chatId) {
      syncBusy();
      input.focus();
    }
    if (state.chats.some((c) => c.pending)) ensurePoll();
    else stopPollIfIdle();
  }
}

export async function checkGateway() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch("/v1/models", { cache: "no-store", signal: ctrl.signal });
    if (res.ok) setStatus("ready");
    else setStatus("bad");
  } catch (e) {
    setStatus("bad");
  } finally {
    clearTimeout(t);
  }
}

Object.assign(state.hooks, {
  renderList,
  paintChat,
  startTurn,
  saveChat,
  add,
  syncBusy,
  setNav,
  setStatus,
  clearComposer,
  showEmpty,
  send,
  createChat,
  deleteChat,
  switchChat
});
