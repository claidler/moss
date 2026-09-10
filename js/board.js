import { log, chatTitle, headAvatar, askEl, state } from "./state.js";
import { timeLabel, splitNoteBody, isProgressOnlyNote } from "./format.js";

export function visibleNotes() {
  return (state.notes || []).filter((n) => n && !isProgressOnlyNote(n));
}

export function boardGlyph() {
  return `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="6" y="7" width="20" height="18" rx="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 12h12M10 16h12M10 20h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
}

export function setView(next) {
  state.view = next;
  document.body.classList.toggle("board", next !== "chat");
}

export function renderBoardRow() {
  const row = document.createElement("div");
  row.className = "bot-row board-row" + (state.view !== "chat" ? " active" : "");
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

export function paintBoard() {
  setView("board");
  state.noteOpen = null;
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
  const shown = visibleNotes();
  if (!shown.length) {
    log.innerHTML = '<div id="empty"><h2>Automations</h2><p>When scheduled jobs finish, they land here like a newsletter. Tap one to read it in full.</p></div>';
    state.emptyEl = document.getElementById("empty");
    return;
  }
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
}

export async function openNote(id) {
  setView("article");
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
    const split = splitNoteBody(item.content || item.preview || "");
    if (!split.body) {
      const empty = document.createElement("div");
      empty.id = "empty";
      empty.innerHTML = "<h2>No update</h2><p>This run had nothing to report.</p>";
      log.appendChild(empty);
    } else {
      state.hooks.add("bot", split.body, null, null, split.thinking.length ? { thinking: split.thinking } : undefined);
    }
    const n = state.notes.find((x) => x.id === id);
    if (n) n.read = true;
    state.notesUnread = state.notes.filter((x) => !x.read).length;
    fetch("/api/notifications/" + encodeURIComponent(id) + "/read", { method: "POST" }).catch(() => {});
    state.hooks.renderList();
    maybeRequestNotifyPerm();
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
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (state.view !== "chat") return;
  try {
    const n = new Notification(item.title || "Automation", { body: item.preview || "", tag: item.id });
    n.onclick = () => { window.focus(); openNote(item.id); };
  } catch (e) {}
}

export function maybeRequestNotifyPerm() {
  if (!("Notification" in window) || Notification.permission !== "default") return;
  Notification.requestPermission().catch(() => {});
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
    if (document.visibilityState === "hidden") return;
    refreshNotes().then(() => {
      if (state.view === "board") paintBoard();
    });
  }, 8000);
}
