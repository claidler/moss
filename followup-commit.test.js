// Pin: a follow-up row can sit after the previous turn's reply. A later
// commit must append, not overwrite that reply.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moss-fu-"));
process.env.MOSS_STORE_FILE = path.join(dir, "store.json");
process.env.MOSS_HISTORY_FILE = path.join(dir, "history.json");

const { loadStore, saveStore, resetStoreCache } = require("./store");
const { commitAssistant } = require("./runs");

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetStoreCache();
});

test("commitAssistant appends a different reply instead of overwriting", () => {
  resetStoreCache();
  const store = loadStore();
  const chat = store.chats[0];
  chat.messages = [
    { role: "user", content: "first" },
    { role: "user", content: "follow-up" },
    { role: "assistant", content: "answer to first" }
  ];
  saveStore(store);
  commitAssistant(chat.id, { content: "answer to follow-up" });
  resetStoreCache();
  const msgs = loadStore().chats.find((c) => c.id === chat.id).messages;
  assert.equal(msgs[2].content, "answer to first");
  assert.equal(msgs[3].role, "assistant");
  assert.equal(msgs[3].content, "answer to follow-up");
});

test("commitAssistant still fills an empty assistant shell", () => {
  resetStoreCache();
  const store = loadStore();
  const chat = store.chats[0];
  chat.messages = [
    { role: "user", content: "only" },
    { role: "assistant", content: "" }
  ];
  saveStore(store);
  commitAssistant(chat.id, { content: "filled" });
  resetStoreCache();
  const msgs = loadStore().chats.find((c) => c.id === chat.id).messages;
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].content, "filled");
});
