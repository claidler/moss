// Moss — chat store persistence (data/store.json) with history.json migration.
const fs = require("fs");
const path = require("path");
const { STORE_FILE, HISTORY_FILE } = require("./config");
const { nid } = require("./http-utils");
const { cleanMessages, titleFrom } = require("./text");

function newChat() {
  return { id: nid(), title: "New chat", updatedAt: Date.now(), messages: [] };
}

function loadStore() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    if (s && Array.isArray(s.chats) && s.chats.length) {
      if (!s.activeId || !s.chats.some((c) => c.id === s.activeId)) s.activeId = s.chats[0].id;
      return s;
    }
  } catch {}
  try {
    const h = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    if (h && Array.isArray(h.messages) && h.messages.length) {
      const c = newChat();
      c.messages = cleanMessages(h.messages);
      c.title = titleFrom(c.messages);
      c.updatedAt = h.updatedAt || Date.now();
      const migrated = { activeId: c.id, chats: [c] };
      saveStore(migrated);
      return migrated;
    }
  } catch {}
  const c = newChat();
  const fresh = { activeId: c.id, chats: [c] };
  saveStore(fresh);
  return fresh;
}

function saveStore(s) {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(s));
}

// Move `chat` to the front so recency order survives the next save.
function touchChat(store, chat) {
  store.chats = [chat].concat(store.chats.filter((c) => c.id !== chat.id));
}

module.exports = { newChat, loadStore, saveStore, touchChat };
