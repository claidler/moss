// Moss — chat store persistence (data/store.json) with history.json migration.
const fs = require("fs");
const path = require("path");
const { STORE_FILE, HISTORY_FILE } = require("./config");
const { nid } = require("./http-utils");
const { cleanMessages, titleFrom } = require("./text");

let cachedStore = null;
let cachedMtime = 0;

function storePath() {
  return process.env.MOSS_STORE_FILE || STORE_FILE;
}

function historyPath() {
  return process.env.MOSS_HISTORY_FILE || HISTORY_FILE;
}

function resetStoreCache() {
  cachedStore = null;
  cachedMtime = 0;
}

function newChat() {
  return { id: nid(), title: "New chat", updatedAt: Date.now(), messages: [] };
}

function loadStore() {
  const file = storePath();
  try {
    const st = fs.statSync(file);
    if (cachedStore && st.mtimeMs === cachedMtime) return cachedStore;
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (s && Array.isArray(s.chats) && s.chats.length) {
      if (!s.activeId || !s.chats.some((c) => c.id === s.activeId && !c.noteId)) {
        const side = s.chats.find((c) => c && !c.noteId);
        s.activeId = side ? side.id : s.chats[0].id;
      }
      cachedStore = s;
      cachedMtime = st.mtimeMs;
      return s;
    }
  } catch {}
  try {
    const h = JSON.parse(fs.readFileSync(historyPath(), "utf8"));
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
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s));
  cachedStore = s;
  try {
    cachedMtime = fs.statSync(file).mtimeMs;
  } catch {
    cachedMtime = Date.now();
  }
}

// Move `chat` to the front so recency order survives the next save.
function touchChat(store, chat) {
  store.chats = [chat].concat(store.chats.filter((c) => c.id !== chat.id));
}

module.exports = { newChat, loadStore, saveStore, touchChat, resetStoreCache };
