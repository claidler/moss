/* Moss service worker — Web Push + notification clicks. */
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(Promise.resolve());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Per-client UI state. One global copy let a background tab's blur message
// (focused:false) overwrite the state of the tab the user was actually
// looking at, so a finished chat's notification popped even while that chat
// was on screen — the "goal notice leaked into my other chats" effect.
const uiByClient = new Map();

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "moss-ui") return;
  const id = event.source && event.source.id;
  if (!id) return;
  uiByClient.set(id, {
    hidden: !!data.hidden,
    focused: !!data.focused,
    view: data.view || "chat",
    chatId: data.chatId || null,
    noteChatId: data.noteChatId || null,
    noteOpen: data.noteOpen || null,
  });
});

function suppresses(ui, data) {
  if (ui.hidden || !ui.focused) return false;
  const chatOrAsk = data.type === "chat" || data.type === "ask";
  if (chatOrAsk && ui.view === "chat" && ui.chatId && ui.chatId === data.chatId) return true;
  if (chatOrAsk && ui.view === "article" && ui.noteChatId && ui.noteChatId === data.chatId) return true;
  if (data.type === "automation" && (ui.view === "board" || (data.noteId && ui.noteOpen === data.noteId))) return true;
  return false;
}

// Suppress when a live, visible, focused client is already looking at the
// target. Dead clients' last-known state is dropped, never trusted.
async function suppress(data) {
  if (!data) return false;
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const live = new Set(clients.map((c) => c.id));
  let keep = false;
  for (const [id, ui] of uiByClient) {
    if (!live.has(id)) {
      uiByClient.delete(id);
      continue;
    }
    if (!keep && suppresses(ui, data)) keep = true;
  }
  return keep;
}

function noteOpts(data) {
  const kind = data.type || "chat";
  const id = data.chatId || data.noteId || "";
  const tag = kind === "automation" ? "moss-note-" + id : kind === "ask" ? "moss-ask-" + id : "moss-chat-" + id;
  const url = data.url || (data.noteId ? "/?note=" + encodeURIComponent(data.noteId) : data.chatId ? "/?chat=" + encodeURIComponent(data.chatId) : "/");
  return {
    body: data.body || "",
    tag,
    renotify: true,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url, kind, id },
  };
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch {
      try { data = { body: event.data.text() }; } catch {}
    }
    if (await suppress(data)) return;
    const title = data.title || "Moss";
    await self.registration.showNotification(title, noteOpts(data));
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(openMoss(url));
});

async function openMoss(url) {
  const abs = new URL(url, self.location.origin).href;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    try {
      await client.focus();
      client.postMessage({ type: "moss-open", url: abs });
      return;
    } catch {}
  }
  await self.clients.openWindow(abs);
}
