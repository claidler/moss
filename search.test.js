const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moss-search-"));
process.env.MOSS_STORE_FILE = path.join(dir, "store.json");
process.env.MOSS_HISTORY_FILE = path.join(dir, "history.json");

const { saveStore, resetStoreCache } = require("./store");
const notesStore = require("./notes-store");
notesStore.init({ root: dir, clipText: (v, n) => String(v == null ? "" : v).slice(0, n) });
const { searchQuery } = require("./search");

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MOSS_STORE_FILE;
  delete process.env.MOSS_HISTORY_FILE;
  resetStoreCache();
});

function seed() {
  saveStore({
    activeId: "a1",
    chats: [
      {
        id: "a1",
        title: "Kitchen redesign",
        updatedAt: 300,
        messages: [
          { role: "user", content: "Find a joiner for the breakfast nook" },
          { role: "assistant", content: "Three local cabinet makers quoted the nook." },
        ],
      },
      {
        id: "a2",
        title: "Vendor contracts",
        updatedAt: 200,
        messages: [
          { role: "assistant", content: "seed", seed: true },
          { role: "assistant", content: "", tools: [{ name: "exec", phase: "result" }] },
          { role: "user", content: "the contractor email is contact@example.com for the joiner" },
        ],
      },
      { id: "a3", title: "Empty", updatedAt: 100, messages: [] },
      {
        id: "a4",
        noteId: "note-x",
        title: "Automation thread about a joiner",
        updatedAt: 900,
        messages: [{ role: "assistant", content: "joiner" }],
      },
    ],
  });
  notesStore.saveNotes({
    seen: {},
    items: [
      { id: "n1", title: "School digest", content: "The bake sale needs a joiner for tables", createdAt: 500, status: "ok" },
      { id: "n2", title: "Weather brief", content: "dry all week", createdAt: 400, status: "ok" },
    ],
  });
  resetStoreCache();
}

test("queries under 2 characters return no results", () => {
  seed();
  assert.deepEqual(searchQuery("j"), { q: "j", chats: [], notes: [] });
  assert.deepEqual(searchQuery("   "), { q: "", chats: [], notes: [] });
});

test("matches chat message text with role and snippet", () => {
  seed();
  const r = searchQuery("joiner");
  const ids = r.chats.map((c) => c.id);
  // noteId threads are board follow-ups, not sidebar chats: excluded.
  assert.ok(!ids.includes("a4"));
  assert.deepEqual(ids.sort(), ["a1", "a2"]);
  const hit = r.chats.find((c) => c.id === "a1");
  assert.equal(hit.role, "You");
  assert.ok(/breakfast nook/.test(hit.snippet));
});

test("message index skips seed rows and empty rows so client scrolling lines up", () => {
  seed();
  const hit = searchQuery("contact").chats.find((c) => c.id === "a2");
  assert.equal(hit.mi, 1, "seed skipped, tools-only empty-content bubble still painted");
});

test("multiple tokens must all appear in the same chat", () => {
  seed();
  const both = searchQuery("cabinet quoted");
  assert.deepEqual(both.chats.map((c) => c.id), ["a1"]);
  assert.deepEqual(searchQuery("cabinet weather").chats, []);
});

test("automations notes are searchable and sorted by recency", () => {
  seed();
  const r = searchQuery("bake sale");
  assert.deepEqual(r.notes.map((n) => n.id), ["n1"]);
  assert.ok(/joiner/.test(r.notes[0].snippet));
});

test("title-only match still returns the chat", () => {
  seed();
  const r = searchQuery("Vendor contracts");
  assert.deepEqual(r.chats.map((c) => c.id), ["a2"]);
  assert.equal(r.chats[0].mi, -1, "no message to jump to");
});

test("index is rebuilt after the store changes", () => {
  seed();
  assert.deepEqual(searchQuery("greenhouse").chats, []);
  const s = {
    activeId: "b1",
    chats: [{ id: "b1", title: "Garden", updatedAt: 999, messages: [{ role: "user", content: "plan the greenhouse" }] }],
  };
  saveStore(s);
  // mtime granularity: force a change so the cache/mtime path is exercised.
  const file = process.env.MOSS_STORE_FILE;
  fs.utimesSync(file, new Date(), new Date(Date.now() + 2000));
  const r = searchQuery("greenhouse");
  assert.deepEqual(r.chats.map((c) => c.id), ["b1"]);
});
