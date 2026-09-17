import { state } from "./state.js";

let swReg = null;
let uiFrame = 0;

export function notifySupported() {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && "Notification" in window;
}

function urlBase64ToUint8Array(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function shouldAlert(kind, id) {
  if (document.visibilityState !== "hidden" && document.hasFocus()) {
    if ((kind === "chat" || kind === "ask") && state.view === "chat" && state.activeId === id) return false;
    if ((kind === "chat" || kind === "ask") && state.view === "article" && state.noteChatId === id) return false;
    if (kind === "automation" && (state.view === "board" || state.noteOpen === id)) return false;
  }
  return true;
}

export function syncUi() {
  if (uiFrame) return;
  uiFrame = requestAnimationFrame(() => {
    uiFrame = 0;
    const payload = {
      type: "moss-ui",
      hidden: document.visibilityState === "hidden",
      focused: document.hasFocus(),
      view: state.view,
      chatId: state.activeId,
      noteChatId: state.noteChatId || null,
      noteOpen: state.noteOpen
    };
    const worker = (swReg && swReg.active) || (navigator.serviceWorker && navigator.serviceWorker.controller);
    if (worker) worker.postMessage(payload);
  });
}

export function handleOpen(url) {
  try {
    const u = new URL(url, location.origin);
    const note = u.searchParams.get("note");
    const chat = u.searchParams.get("chat");
    if (note && state.hooks.openNote) {
      state.hooks.openNote(note);
      return;
    }
    if (chat && state.hooks.switchChat) state.hooks.switchChat(chat);
  } catch (e) {}
}

async function subscribePush() {
  if (!notifySupported() || Notification.permission !== "granted") return false;
  try {
    const reg = swReg || await navigator.serviceWorker.ready;
    if (!reg.pushManager) return false;
    const vapid = await fetch("/api/push/vapid", { cache: "no-store" }).then((r) => r.json());
    if (!vapid || !vapid.publicKey) return false;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid.publicKey)
      });
    }
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON())
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

export function enableNotifications() {
  if (!notifySupported()) return Promise.resolve(false);
  const go = async (perm) => {
    if (perm !== "granted") return false;
    await subscribePush();
    syncUi();
    return true;
  };
  if (Notification.permission === "default") {
    return Notification.requestPermission().then(go);
  }
  return go(Notification.permission);
}

export async function showMossNote(opts) {
  if (!opts || !notifySupported() || Notification.permission !== "granted") return;
  if (!shouldAlert(opts.kind, opts.id)) return;
  const title = opts.title || "Moss";
  const body = String(opts.body || "").replace(/\s+/g, " ").trim().slice(0, 140);
  const tag = opts.tag || ("moss-" + (opts.kind || "msg") + "-" + (opts.id || ""));
  const data = { url: opts.url || "/", kind: opts.kind, id: opts.id };
  try {
    const reg = swReg || await navigator.serviceWorker.ready;
    if (reg && reg.showNotification) {
      await reg.showNotification(title, {
        body,
        tag,
        data,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        renotify: true
      });
      return;
    }
  } catch (e) {}
  try {
    const n = new Notification(title, { body, tag, icon: "/icon-192.png" });
    n.onclick = () => {
      window.focus();
      handleOpen(data.url);
    };
  } catch (e) {}
}

export async function bootNotify() {
  if (!notifySupported()) return;
  try {
    swReg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
  } catch (e) {}
  navigator.serviceWorker.addEventListener("message", (e) => {
    const d = e.data || {};
    if (d.type === "moss-open") handleOpen(d.url);
  });
  window.addEventListener("focus", syncUi);
  window.addEventListener("blur", syncUi);
  if (Notification.permission === "granted") await subscribePush();
  syncUi();
  handleOpen(location.href);
}
