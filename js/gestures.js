import { log } from "./state.js";
import { setNav } from "./chats.js";

const EDGE = 32;
const DECIDE = 10;
const OPEN_DX = 56;
const HOLD_MS = 520;

function overlayNav() {
  return window.matchMedia("(max-width: 720px)").matches;
}

function navOpen() {
  return document.body.classList.contains("nav-open");
}

function sidebar() {
  return document.querySelector(".sidebar");
}

function scrim() {
  return document.getElementById("scrim");
}

function navWidth() {
  const el = sidebar();
  return (el && el.getBoundingClientRect().width) || Math.min(320, window.innerWidth * 0.88);
}

function ignoreNavStart(t) {
  if (!t || !t.closest) return true;
  if (t.closest("input, textarea, select, iframe, audio, video")) return true;
  if (t.closest("#openNav, #closeNav, #newChat, #send, #stop, #attachBtn, .del, .icon-btn, .attach, .send, .stop")) return true;
  return false;
}

function dragX(origin, dx) {
  const w = navWidth();
  return Math.max(-w, Math.min(0, origin + dx));
}

function paintDrag(x) {
  const el = sidebar();
  const w = navWidth();
  if (el) el.style.transform = "translateX(" + x + "px)";
  const s = scrim();
  if (s) s.style.opacity = String(Math.max(0, Math.min(1, (x + w) / w)));
}

function bindNavSwipe() {
  const drag = {
    pointerId: null,
    startX: 0,
    startY: 0,
    lastX: 0,
    origin: 0,
    tracking: false,
    armed: false,
    closing: false
  };

  const reset = () => {
    drag.pointerId = null;
    drag.tracking = false;
    drag.armed = false;
    drag.closing = false;
    document.body.classList.remove("nav-dragging");
  };

  const finish = (dx) => {
    const open = drag.closing ? dx > -OPEN_DX : dx > OPEN_DX;
    reset();
    setNav(open);
  };

  const onTouchMove = (e) => {
    if (!drag.armed) return;
    e.preventDefault();
  };

  document.addEventListener("touchmove", onTouchMove, { passive: false });

  document.addEventListener("pointerdown", (e) => {
    if (!overlayNav() || drag.tracking || e.isPrimary === false) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (ignoreNavStart(e.target)) return;
    const open = navOpen();
    if (!open && e.clientX > EDGE) return;
    if (open && !e.target.closest(".sidebar, #scrim")) return;
    drag.pointerId = e.pointerId;
    drag.startX = e.clientX;
    drag.startY = e.clientY;
    drag.lastX = e.clientX;
    drag.tracking = true;
    drag.armed = false;
    drag.closing = open;
    drag.origin = open ? 0 : -navWidth();
  });

  document.addEventListener("pointermove", (e) => {
    if (!drag.tracking || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    drag.lastX = e.clientX;
    if (!drag.armed) {
      if (Math.abs(dx) < DECIDE && Math.abs(dy) < DECIDE) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        reset();
        return;
      }
      if (!drag.closing && dx < 0) {
        reset();
        return;
      }
      drag.armed = true;
      document.body.classList.add("nav-dragging");
      try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
    }
    paintDrag(dragX(drag.origin, dx));
  });

  const end = (e) => {
    if (!drag.tracking || (e && e.pointerId !== drag.pointerId)) return;
    const x = e && e.type !== "pointercancel" ? e.clientX : drag.lastX;
    const dx = x - drag.startX;
    if (!drag.armed) {
      reset();
      return;
    }
    finish(dx);
  };

  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", end);
}

function skipBubbleHold(t) {
  if (!t || !t.closest) return true;
  return !!t.closest("a, button, input, textarea, select, iframe, img, summary, .code-head, .html-frame, .note-card, .note-back");
}

function bubbleText(bubble) {
  if (bubble.mossCopy) return String(bubble.mossCopy).trim();
  const md = bubble.querySelector(".md");
  return ((md && md.innerText) || "").trim();
}

function copyText(text) {
  const t = String(text || "");
  if (!t) return Promise.reject(new Error("empty"));
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(t);
  }
  return new Promise((resolve, reject) => {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (err) {}
    ta.remove();
    if (ok) resolve();
    else reject(new Error("copy"));
  });
}

let toastEl = null;
let toastTimer = null;

function toast(msg) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    toastEl.setAttribute("role", "status");
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1400);
}

function copied(bubble) {
  bubble.classList.add("copied");
  toast("Copied");
  try { if (navigator.vibrate) navigator.vibrate(12); } catch (err) {}
  setTimeout(() => bubble.classList.remove("copied"), 700);
}

function copyBubble(bubble) {
  const text = bubbleText(bubble);
  if (!text) return;
  copyText(text).then(() => copied(bubble)).catch(() => {});
}

function bindBubbleCopy() {
  if (!log) return;
  const press = {
    timer: null,
    pointerId: null,
    startX: 0,
    startY: 0,
    bubble: null,
    touchish: false,
    did: false
  };

  const clear = () => {
    if (press.timer) {
      clearTimeout(press.timer);
      press.timer = null;
    }
    press.pointerId = null;
    press.bubble = null;
  };

  const fire = (bubble) => {
    if (!bubble || press.did) return;
    press.did = true;
    copyBubble(bubble);
  };

  log.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (skipBubbleHold(e.target)) return;
    const bubble = e.target.closest(".msg .bubble");
    if (!bubble) return;
    press.pointerId = e.pointerId;
    press.startX = e.clientX;
    press.startY = e.clientY;
    press.bubble = bubble;
    press.touchish = e.pointerType !== "mouse";
    press.did = false;
    if (press.timer) clearTimeout(press.timer);
    press.timer = setTimeout(() => {
      press.timer = null;
      fire(press.bubble);
    }, HOLD_MS);
  });

  log.addEventListener("pointermove", (e) => {
    if (press.pointerId !== e.pointerId || !press.timer) return;
    if (Math.abs(e.clientX - press.startX) > 12 || Math.abs(e.clientY - press.startY) > 12) clear();
  });

  log.addEventListener("pointerup", clear);
  log.addEventListener("pointercancel", clear);
  log.addEventListener("selectstart", (e) => {
    if (press.timer && e.target.closest(".msg .bubble")) e.preventDefault();
  });
  log.addEventListener("contextmenu", (e) => {
    if (!press.touchish) return;
    const bubble = e.target.closest(".msg .bubble");
    if (!bubble || skipBubbleHold(e.target)) return;
    e.preventDefault();
    if (press.timer) {
      clearTimeout(press.timer);
      press.timer = null;
    }
    fire(bubble);
  });
}

export function bindGestures() {
  bindNavSwipe();
  bindBubbleCopy();
}
