// Unit tests for the server-side Goal cache/bridge (goals.js).
// The gateway is a fake rpc function; no server or network involved.
const test = require("node:test");
const assert = require("node:assert/strict");

const goals = require("./goals");

let rpcCalls = [];
let rpcImpl = async () => ({});

goals.init({
  gatewayRpc: async (scopes, method, params) => {
    rpcCalls.push({ scopes, method, params });
    return rpcImpl(method, params);
  },
});

function reset() {
  rpcCalls = [];
  rpcImpl = async () => ({});
}

function goalRow(over) {
  return Object.assign({
    id: "g1", objective: "Ship the report", status: "active",
    tokensUsed: 500, createdAt: 1000, updatedAt: 2000,
  }, over || {});
}

test("slimGoal keeps only the render fields and rejects junk", () => {
  assert.equal(goals.slimGoal(null), null);
  assert.equal(goals.slimGoal({ objective: "no id" }), null);
  const slim = goals.slimGoal({ ...goalRow(), junk: "x", objective: "y".repeat(5000) });
  assert.deepEqual(Object.keys(slim).sort(), [
    "createdAt", "id", "objective", "status", "tokensUsed", "updatedAt",
  ]);
  assert.equal(slim.objective.length, 4000);
  assert.equal(slim.status, "active");
});

test("handleGoalEvent trusts goal rows on any reason", () => {
  reset();
  const change = goals.handleGoalEvent({
    event: "sessions.changed",
    payload: { sessionKey: "moss-c-ev1", reason: "chat.run.started", goal: goalRow() },
  });
  assert.ok(change);
  assert.equal(change.chatId, "c-ev1");
  assert.equal(change.goal.id, "g1");
  assert.deepEqual(goals.peek("c-ev1"), change.goal);
});

test("handleGoalEvent only erases on goal-scoped reasons", () => {
  reset();
  goals.remember("c-ev2", goals.slimGoal(goalRow()));
  // A pre-goal snapshot with an unrelated reason must not erase the goal.
  const ignored = goals.handleGoalEvent({
    event: "sessions.changed",
    payload: { sessionKey: "moss-c-ev2", reason: "send-callback" },
  });
  assert.equal(ignored, null);
  assert.ok(goals.peek("c-ev2"));
  // reason "goal" with no row means "cleared".
  const cleared = goals.handleGoalEvent({
    event: "sessions.changed",
    payload: { sessionKey: "moss-c-ev2", reason: "goal" },
  });
  assert.ok(cleared);
  assert.equal(cleared.goal, null);
  assert.equal(goals.peek("c-ev2"), null);
});

test("handleGoalEvent ignores unrelated events and unknown sessions", () => {
  reset();
  assert.equal(goals.handleGoalEvent({ event: "question.requested", payload: {} }), null);
  assert.equal(goals.handleGoalEvent({
    event: "sessions.changed",
    payload: { sessionKey: "agent:main:main", goal: goalRow() },
  }), null);
});

test("allFresh hydrates every chat from one sessions.list and caches by TTL", async () => {
  reset();
  let listCalls = 0;
  rpcImpl = async (method) => {
    if (method !== "sessions.list") return {};
    listCalls += 1;
    return {
      sessions: [
        { key: "moss-a1", goal: goalRow({ id: "ga" }) },
        { key: "moss-a2", goal: null },
      ],
    };
  };
  const snap = await goals.allFresh(true);
  assert.equal(listCalls, 1);
  assert.equal(snap.a1.id, "ga");
  assert.equal(snap.a2, null);
  // Within the TTL a non-forced call reuses the cache without another RPC.
  const again = await goals.allFresh(false);
  assert.equal(listCalls, 1);
  assert.deepEqual(again.a1, snap.a1);
});

test("allFresh clears chats that vanished from sessions.list", async () => {
  reset();
  goals.remember("a3", goals.slimGoal(goalRow()));
  rpcImpl = async () => ({ sessions: [] });
  const snap = await goals.allFresh(true);
  assert.equal(snap.a3, null);
});

test("allFresh keeps the last-known cache when the gateway call fails", async () => {
  reset();
  goals.remember("a4", goals.slimGoal(goalRow()));
  rpcImpl = async () => { throw new Error("gateway down"); };
  const snap = await goals.allFresh(true);
  assert.equal(snap.a4.id, "g1");
});

test("mutate rejects when the chat has no goal", async () => {
  reset();
  goals.forget("m0");
  rpcImpl = async () => ({ sessions: [] });
  await assert.rejects(goals.mutate("m0", { action: "pause" }), (e) => e.status === 409);
});

test("mutate pause sends sessions.goal.update with the goal identity", async () => {
  reset();
  goals.remember("m1", goals.slimGoal(goalRow()));
  rpcImpl = async () => ({ goal: goalRow({ status: "paused" }) });
  const goal = await goals.mutate("m1", { action: "pause", note: "later" });
  assert.equal(goal.status, "paused");
  const call = rpcCalls.find((c) => c.method === "sessions.goal.update");
  assert.ok(call);
  assert.deepEqual(call.scopes, ["operator.read", "operator.write"]);
  assert.equal(call.params.sessionKey, "moss-m1");
  assert.equal(call.params.goalId, "g1");
  assert.equal(call.params.action, "pause");
  assert.equal(call.params.note, "later");
  assert.ok(String(call.params.operationId).startsWith("moss-goal-"));
  assert.equal(goals.peek("m1").status, "paused");
});

test("mutate edit validates and forwards the objective", async () => {
  reset();
  goals.remember("m2", goals.slimGoal(goalRow()));
  await assert.rejects(goals.mutate("m2", { action: "edit", objective: "   " }), (e) => e.status === 400);
  rpcImpl = async () => ({ goal: goalRow({ objective: "New objective" }) });
  const goal = await goals.mutate("m2", { action: "edit", objective: "  New objective  " });
  assert.equal(goal.objective, "New objective");
  const call = rpcCalls.find((c) => c.method === "sessions.goal.update");
  assert.equal(call.params.action, "edit");
});

test("mutate clear returns null and empties the cache", async () => {
  reset();
  goals.remember("m3", goals.slimGoal(goalRow()));
  rpcImpl = async () => ({ status: "cleared" });
  const goal = await goals.mutate("m3", { action: "clear" });
  assert.equal(goal, null);
  assert.equal(goals.peek("m3"), null);
  assert.ok(rpcCalls.some((c) => c.method === "sessions.goal.clear"));
});

test("mutate rejects unsupported actions with 400", async () => {
  reset();
  goals.remember("m4", goals.slimGoal(goalRow()));
  rpcImpl = async () => ({ goal: goalRow() });
  await assert.rejects(goals.mutate("m4", { action: "frobnicate" }), (e) => e.status === 400);
});

test("clearTerminal only clears a completed goal", async () => {
  reset();
  goals.remember("t1", goals.slimGoal(goalRow({ status: "active" })));
  await goals.clearTerminal("t1");
  assert.equal(rpcCalls.length, 0);
  assert.ok(goals.peek("t1"));

  goals.remember("t2", goals.slimGoal(goalRow({ id: "g2", status: "complete" })));
  rpcImpl = async () => ({ status: "cleared" });
  await goals.clearTerminal("t2");
  assert.ok(rpcCalls.some((c) => c.method === "sessions.goal.clear" && c.params.goalId === "g2"));
  assert.equal(goals.peek("t2"), null);
});

test("scheduleFreshSync retries until the goal shows up", async () => {
  reset();
  goals.forget("s1");
  let calls = 0;
  rpcImpl = async (method) => {
    if (method !== "sessions.list") return {};
    calls += 1;
    return { sessions: calls >= 2 ? [{ key: "moss-s1", goal: goalRow({ id: "gs" }) }] : [] };
  };
  const goal = await goals.scheduleFreshSync("s1");
  assert.ok(goal, "goal should surface after a retry");
  assert.equal(goal.id, "gs");
  assert.ok(calls >= 2);
});
