const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moss-store-"));
process.env.MOSS_STORE_FILE = path.join(dir, "store.json");
process.env.MOSS_HISTORY_FILE = path.join(dir, "history.json");

const { loadStore, saveStore, resetStoreCache } = require("./store");

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MOSS_STORE_FILE;
  delete process.env.MOSS_HISTORY_FILE;
  resetStoreCache();
});

test("loadStore caches the same object until mtime changes", () => {
  resetStoreCache();
  const first = loadStore();
  first.chats[0].title = "Cached";
  const again = loadStore();
  assert.equal(again, first);
  assert.equal(again.chats[0].title, "Cached");
});

test("saveStore persists and keeps the cache", () => {
  resetStoreCache();
  const s = loadStore();
  s.chats[0].title = "Saved";
  saveStore(s);
  resetStoreCache();
  const loaded = loadStore();
  assert.equal(loaded.chats[0].title, "Saved");
});

test("loadStore prefers a non-note chat as activeId", () => {
  resetStoreCache();
  saveStore({
    activeId: "note-1",
    chats: [
      { id: "note-1", noteId: "job", title: "Automation", messages: [] },
      { id: "chat-1", title: "Hello", messages: [] },
    ],
  });
  resetStoreCache();
  const s = loadStore();
  assert.equal(s.activeId, "chat-1");
});
