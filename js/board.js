import { log, chatTitle, headAvatar, askEl, state, syncDayNav } from "./state.js";
import { syncToBottom } from "./scroll.js";
import { timeLabel, splitNoteBody, isProgressOnlyNote, dayKey, dayLabel } from "./format.js";
import { showMossNote, syncUi } from "./notify.js";

export function visibleNotes() {
  return (state.notes || []).filter((n) => n && !isProgressOnlyNote(n));
}

export function boardGlyph() {
  return `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="6" y="7" width="20" height="18" rx="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 12h12M10 16h12M10 20h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
}

export function setView(next) {
  state.view = next;
  document.body.classList.toggle("board", next === "board" || next === "article");
  document.body.classList.toggle("article", next === "article");
  document.body.classList.toggle("diff", next === "diff");
  syncUi();
}

export function renderBoardRow() {
  const boardish = state.view === "board" || state.view === "article";
  const row = document.createElement("div");
  row.className = "bot-row board-row" + (boardish ? " active" : "");
  if (boardish) row.setAttribute("aria-current", "true");
  const third = state.notesUnread > 0
    ? `<span class="badge">${state.notesUnread > 99 ? "99+" : state.notesUnread}</span>`
    : `<div class="bot-time"></div>`;
  row.innerHTML =
    `<div class="avatar board-face">${boardGlyph()}</div>
     <div><div class="bot-name"></div><div class="bot-preview"></div></div>
     ${third}
     <span></span>`;
  row.querySelector(".bot-name").textContent = "Automations";
  const latest = visibleNotes()[0];
  row.querySelector(".bot-preview").textContent = latest
    ? (latest.title + (latest.preview ? " · " + latest.preview : ""))
    : "Newsletter board";
  const time = row.querySelector(".bot-time");
  if (time && latest) time.textContent = timeLabel(latest.createdAt);
  row.addEventListener("click", (e) => {
    if (state.suppressBoardClick) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    openBoard();
  });
  bindLongPress(row, () => showNoteMenuFor(row));
  return row;
}

export function hideNoteMenu() {
  const menu = document.getElementById("noteMenu");
  if (menu) menu.hidden = true;
}

export function showNoteMenuFor(el) {
  const menu = document.getElementById("noteMenu");
  const btn = document.getElementById("markAllRead");
  if (!menu || !btn) return;
  btn.disabled = state.notesUnread <= 0;
  btn.textContent = state.notesUnread > 0 ? "Mark all as read" : "All read";
  menu.hidden = false;
  const pad = 8;
  const r = el.getBoundingClientRect();
  let left = r.left;
  let top = r.bottom + 6;
  const w = menu.offsetWidth || 196;
  const h = menu.offsetHeight || 48;
  if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad;
  if (top + h > window.innerHeight - pad) top = Math.max(pad, r.top - h - 6);
  if (left < pad) left = pad;
  menu.style.left = left + "px";
  menu.style.top = top + "px";
}

export function bindLongPress(el, onLong, gate) {
  let startX = 0;
  let startY = 0;
  const ok = () => !gate || gate();
  const clear = () => {
    if (state.noteMenuTimer) {
      clearTimeout(state.noteMenuTimer);
      state.noteMenuTimer = null;
    }
  };
  el.addEventListener("pointerdown", (e) => {
    if (!ok()) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    startX = e.clientX;
    startY = e.clientY;
    state.suppressBoardClick = false;
    clear();
    state.noteMenuTimer = setTimeout(() => {
      state.noteMenuTimer = null;
      state.suppressBoardClick = true;
      try { if (navigator.vibrate) navigator.vibrate(12); } catch (err) {}
      onLong(e);
      setTimeout(() => { state.suppressBoardClick = false; }, 400);
    }, 520);
  });
  el.addEventListener("pointermove", (e) => {
    if (!state.noteMenuTimer) return;
    if (Math.abs(e.clientX - startX) > 12 || Math.abs(e.clientY - startY) > 12) clear();
  });
  el.addEventListener("pointerup", clear);
  el.addEventListener("pointercancel", clear);
  el.addEventListener("contextmenu", (e) => {
    if (!ok()) return;
    e.preventDefault();
    clear();
    state.suppressBoardClick = true;
    onLong(e);
    setTimeout(() => { state.suppressBoardClick = false; }, 400);
  });
}

export async function markAllRead() {
  hideNoteMenu();
  if (!state.notesUnread) return;
  state.notes.forEach((n) => { n.read = true; });
  state.notesUnread = 0;
  state.hooks.renderList();
  if (state.view === "board") paintBoard();
  try {
    await fetch("/api/notifications/read-all", { method: "POST" });
  } catch (e) {}
  await refreshNotes();
  if (state.view === "board") paintBoard();
}

// The board pages one calendar day at a time, newest day first. Pages are
// rebuilt from state.notes on every paint and the cursor follows the day KEY,
// so a note landing on today's page cannot shift the reader off their day.
function buildBoardDayPages() {
  const ordered = visibleNotes().slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const pages = [];
  const index = new Map();
  ordered.forEach((n) => {
    const key = dayKey(n.createdAt) || "undated";
    if (!index.has(key)) {
      index.set(key, pages.length);
      pages.push({ key, label: dayLabel(n.createdAt), notes: [] });
    }
    pages[index.get(key)].notes.push(n);
  });
  let cursor = 0;
  const prev = state.boardDayPages;
  if (prev && prev.keys && prev.keys.length) {
    const wanted = state.boardDayKey || (prev.keys[prev.cursor] || "");
    const found = prev.keys.indexOf(wanted);
    cursor = found >= 0 ? found : 0;
  }
  if (cursor >= pages.length) cursor = pages.length - 1;
  state.boardDayPages = { keys: pages.map((p) => p.key), cursor };
  return { pages, cursor };
}

export function stepBoardDay(dir) {
  const { pages } = buildBoardDayPages();
  if (!pages.length) return;
  const next = Math.max(0, Math.min(pages.length - 1, state.boardDayPages.cursor + dir));
  state.boardDayPages.cursor = next;
  state.boardDayKey = pages[next] ? pages[next].key : "";
  paintBoard();
}

// Opening a note keeps the board on the day that contains it.
export function focusBoardDay(id) {
  const { pages, cursor } = buildBoardDayPages();
  if (pages.length < 2) return;
  const idx = pages.findIndex((p) => p.notes.some((n) => n.id === id));
  if (idx < 0 || idx === cursor) return;
  state.boardDayPages.cursor = idx;
  state.boardDayKey = pages[idx].key;
}

export function paintBoard() {
  setView("board");
  state.noteOpen = null;
  state.noteChatId = null;
  log.innerHTML = "";
  state.stamped = false;
  state.emptyEl = null;
  chatTitle.textContent = "Automations";
  headAvatar.className = "avatar board-face";
  headAvatar.innerHTML = boardGlyph();
  headAvatar.classList.remove("working");
  askEl.hidden = true;
  askEl.innerHTML = "";
  state.hooks.syncBusy();
  const { pages, cursor } = buildBoardDayPages();
  if (!pages.length) {
    log.innerHTML = '<div id="empty"><h2>Automations</h2><p>When scheduled jobs finish, they land here like a newsletter. Tap one to read it in full.</p></div>';
    state.emptyEl = document.getElementById("empty");
    syncDayNav([], 0);
    return;
  }
  const day = document.createElement("div");
  day.className = "day-label board-day";
  day.textContent = pages[cursor].label;
  log.appendChild(day);
  const shown = pages[cursor].notes;
  const wrap = document.createElement("div");
  wrap.className = "notes";
  shown.forEach((n) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "note-card" + (n.read ? "" : " unread") + (n.status === "error" ? " error" : "");
    btn.innerHTML = `<div class="note-kicker"></div><div class="note-title"></div><div class="note-preview"></div><div class="note-meta"></div>`;
    btn.querySelector(".note-kicker").textContent = (n.status === "error" ? "Failed · " : "") + "Automation";
    btn.querySelector(".note-title").textContent = n.title || "Automation";
    btn.querySelector(".note-preview").textContent = splitNoteBody(n.preview || n.content || "").body || n.preview || "";
    btn.querySelector(".note-meta").textContent = timeLabel(n.createdAt);
    btn.addEventListener("click", () => openNote(n.id));
    wrap.appendChild(btn);
  });
  log.appendChild(wrap);
  syncDayNav(pages, cursor);
}

export async function openNote(id) {
  setView("article");
  focusBoardDay(id);
  state.noteOpen = id;
  state.hooks.setNav(false);
  log.innerHTML = "";
  state.stamped = true;
  state.emptyEl = null;
  const back = document.createElement("button");
  back.type = "button";
  back.className = "note-back";
  back.textContent = "All automations";
  back.addEventListener("click", () => openBoard());
  log.appendChild(back);
  chatTitle.textContent = "Automation";
  headAvatar.className = "avatar board-face";
  headAvatar.innerHTML = boardGlyph();
  try {
    const res = await fetch("/api/notifications/" + encodeURIComponent(id), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const item = await res.json();
    chatTitle.textContent = item.title || "Automation";
    const kicker = document.createElement("div");
    kicker.className = "stamp";
    kicker.textContent = (item.status === "error" ? "Failed · " : "Automation · ") + timeLabel(item.createdAt);
    log.appendChild(kicker);
    syncDayNav([], 0);
    const split = splitNoteBody(item.content || item.preview || "");
    if (!split.body) {
      const empty = document.createElement("div");
      empty.id = "empty";
      empty.innerHTML = "<h2>No update</h2><p>This run had nothing to report.</p>";
      log.appendChild(empty);
    } else {
      const bodyOpts = split.thinking.length ? { thinking: split.thinking } : {};
      bodyOpts.stick = false;
      state.hooks.add("bot", split.body, null, null, bodyOpts);
      // Opened automations read top-down: land at the start, not the end.
      log.scrollTop = 0;
      syncToBottom();
    }
    const n = state.notes.find((x) => x.id === id);
    if (n) n.read = true;
    state.notesUnread = state.notes.filter((x) => !x.read).length;
    fetch("/api/notifications/" + encodeURIComponent(id) + "/read", { method: "POST" }).catch(() => {});
    state.hooks.renderList();
    if (state.hooks.hydrateNoteThread) await state.hooks.hydrateNoteThread(item);
    else {
      state.noteContent = item.content || item.preview || "";
      state.hooks.syncBusy();
    }
  } catch (e) {
    const empty = document.createElement("div");
    empty.id = "empty";
    empty.innerHTML = "<h2>Missing</h2><p>That automation could not be opened.</p>";
    log.appendChild(empty);
  }
}

export async function openBoard() {
  setView("board");
  state.noteOpen = null;
  state.hooks.setNav(false);
  await refreshNotes();
  paintBoard();
  state.hooks.renderList();
}

export function maybeDesktopNote(item) {
  if (!item || isProgressOnlyNote(item)) return;
  showMossNote({
    kind: "automation",
    id: item.id,
    title: item.title || "Automation",
    body: item.preview || "",
    url: "/?note=" + encodeURIComponent(item.id),
    tag: "moss-note-" + item.id
  });
}

export async function refreshNotes() {
  try {
    const res = await fetch("/api/notifications", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const items = (data.items || []).filter((n) => n && !isProgressOnlyNote(n));
    if (state.notesReady) {
      items.forEach((n) => {
        if (!n.read && n.id && !state.notesSeen.has(n.id)) maybeDesktopNote(n);
      });
    }
    state.notes = items;
    state.notes.forEach((n) => { if (n && n.id) state.notesSeen.add(n.id); });
    state.notesUnread = state.notes.filter((n) => !n.read).length;
    state.notesReady = true;
    state.hooks.renderList();
  } catch (e) {}
}

export function ensureNotesPoll() {
  if (state.notesTimer) return;
  state.notesTimer = setInterval(() => {
    refreshNotes().then(() => {
      if (state.view === "board" && document.visibilityState === "visible") paintBoard();
    });
  }, 8000);
}
