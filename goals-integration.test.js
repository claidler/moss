// Integration tests for the Goal feature: real Moss server + FakeGateway.
// Covers the full loop: goalSend rewrite, goal-broadcast -> SSE moss_goal,
// REST mutate actions, warm cache, replacement of finished goals, 409 guard.
const test = require("node:test");
const assert = require("node:assert/strict");

const { boot } = require("./e2e/harness");

let h = null;

test.before(async () => {
  h = await boot();
  // Wait until the gateway hub finished its handshake (sessions.subscribe).
  const deadline = Date.now() + 8000;
  while (!h.gw.rpcLog.some((r) => r.method === "sessions.subscribe")) {
    if (Date.now() > deadline) throw new Error("hub never became ready:\n" + h.logs());
    await new Promise((r) => setTimeout(r, 50));
  }
});

test.after(async () => {
  if (h) await h.close();
});

async function newChat() {
  const res = await h.api("/api/chats", { method: "POST", body: "{}" });
  assert.equal(res.status, 200);
  return res.json.id;
}

test("auth: api and app require a session", async () => {
  const anon = await fetch(h.base + "/api/chats");
  assert.equal(anon.status, 401);
  const home = await fetch(h.base + "/", { redirect: "manual", headers: { Accept: "text/html" } });
  assert.equal(home.status, 302);
  assert.match(home.headers.get("location") || "", /\/login/);
});

test("goal-mode turn creates a goal, surfaces it live, and persists it", async () => {
  const chatId = await newChat();
  const sse = await h.chatTurn(chatId, { role: "user", content: "Tidy the garden", goalSend: "Tidy the garden" });

  // The gateway received the rewritten /goal command, not the raw bubble text.
  const turn = h.gw.completions.find((c) => c.user === "moss-" + chatId);
  assert.ok(turn, "gateway saw the proxied turn");
  assert.equal(turn.content, "/goal Tidy the garden");

  // The goal reached the client inside the same stream.
  const deltas = h.goalDeltas(sse).filter(Boolean);
  assert.ok(deltas.length >= 1, "stream carried a moss_goal delta");
  assert.equal(deltas[0].status, "active");
  assert.equal(deltas[0].objective, "Tidy the garden");

  // And it is queryable afterwards (chat fetch + warm endpoint + sidebar row).
  const chat = await h.api("/api/chats/" + chatId);
  assert.equal(chat.status, 200);
  assert.equal(chat.json.goal.status, "active");
  const warm = await h.api("/api/goals");
  assert.equal(warm.json.goals[chatId].objective, "Tidy the garden");
  const list = await h.api("/api/chats");
  const row = list.json.chats.find((c) => c.id === chatId);
  assert.equal(row.goal.status, "active");
});

test("pause then clear round-trips through the gateway Goal API", async () => {
  const chatId = await newChat();
  await h.chatTurn(chatId, { role: "user", content: "Fix the shed", goalSend: "Fix the shed" });

  const paused = await h.api("/api/chats/" + chatId + "/goal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "pause", note: "lunch" }),
  });
  assert.equal(paused.status, 200);
  assert.equal(paused.json.goal.status, "paused");
  const update = h.gw.rpcLog.find(
    (r) => r.method === "sessions.goal.update" && r.params.sessionKey === "moss-" + chatId
  );
  assert.ok(update, "gateway received sessions.goal.update");
  assert.equal(update.params.action, "pause");
  assert.equal(update.params.note, "lunch");

  const cleared = await h.api("/api/chats/" + chatId + "/goal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "clear" }),
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.goal, null);
  const warm = await h.api("/api/goals");
  assert.equal(warm.json.goals[chatId], null);
});

test("mutate on a goal-less chat is 409, bogus action is 400", async () => {
  const chatId = await newChat();
  const conflict = await h.api("/api/chats/" + chatId + "/goal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "pause" }),
  });
  assert.equal(conflict.status, 409);

  await h.chatTurn(chatId, { role: "user", content: "Paint the fence", goalSend: "Paint the fence" });
  const bogus = await h.api("/api/chats/" + chatId + "/goal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "frobnicate" }),
  });
  assert.equal(bogus.status, 400);
});

test("a finished goal does not block the replacement goal", async () => {
  const chatId = await newChat();
  await h.chatTurn(chatId, { role: "user", content: "First objective", goalSend: "First objective" });
  const done = await h.api("/api/chats/" + chatId + "/goal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "complete" }),
  });
  assert.equal(done.json.goal.status, "complete");
  const clearsBefore = h.gw.clearCalls;

  const sse = await h.chatTurn(chatId, { role: "user", content: "Second objective", goalSend: "Second objective" });
  assert.ok(h.gw.clearCalls > clearsBefore, "terminal goal was cleared before replacement");
  const deltas = h.goalDeltas(sse).filter(Boolean);
  const last = deltas[deltas.length - 1];
  assert.equal(last.objective, "Second objective");
  assert.equal(last.status, "active");
});

test("mid-run create_goal tool event pushes the goal into the live stream", async () => {
  h.gw.mode = "tool-event";
  try {
    const chatId = await newChat();
    const sse = await h.chatTurn(chatId, { role: "user", content: "Just chat" });
    const deltas = h.goalDeltas(sse).filter(Boolean);
    assert.ok(deltas.length >= 1, "moss_goal delta arrived from the tool-event sync");
    assert.equal(deltas[0].objective, "Tool-created goal");
    const chat = await h.api("/api/chats/" + chatId);
    assert.equal(chat.json.goal.status, "active");
  } finally {
    h.gw.mode = "sessions-changed";
  }
});

test("a second turn while one is running is rejected with 409 pending", async () => {
  const chatId = await newChat();
  const first = h.chatTurn(chatId, { role: "user", content: "Long objective", goalSend: "Long objective" });
  await new Promise((r) => setTimeout(r, 30));
  const second = await h.chatTurn(chatId, { role: "user", content: "too soon" });
  assert.match(second, /"pending":true/);
  await first;
});
