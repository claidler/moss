// Moss e2e — minimal OpenClaw gateway stand-in.
//
// Speaks just enough of the gateway protocol for the real Moss server:
//  - WS JSON-RPC (connect, sessions.list, sessions.goal.update/clear,
//    chat.history, models.list, cron.*, question.list, sessions.subscribe…)
//  - POST /v1/chat/completions as OpenAI-style SSE.
// Goal behaviour is scriptable:
//  - mode "sessions-changed": a "/goal …" completion creates a goal row and
//    broadcasts sessions.changed (the gateway's goal-broadcast path).
//  - mode "tool-event": a plain completion emits a create_goal session.tool
//    event and sessions.list starts returning the goal (the mid-run
//    create_goal path the proxy syncs on).
const http = require("http");

function requireWs() {
  try {
    return require("ws");
  } catch {
    return require("/home/claidler/.local/node/lib/node_modules/openclaw/node_modules/ws");
  }
}
const { WebSocketServer } = requireWs();

let goalSeq = 0;

class FakeGateway {
  constructor(opts) {
    this.opts = opts || {};
    this.goals = new Map(); // sessionKey -> goal row
    this.sockets = new Set();
    this.rpcLog = [];
    this.mode = "sessions-changed";
    this.clearCalls = 0;
    this.completions = []; // {user, content} of every proxied turn
    this.completionText = "Working on it.";
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on("connection", (ws) => this.handleWs(ws));
  }

  listen() {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => resolve(this.server.address().port));
    });
  }

  async close() {
    for (const ws of this.sockets) {
      try { ws.terminate(); } catch {}
    }
    await new Promise((resolve) => this.server.close(() => resolve()));
  }

  broadcast(event, payload) {
    const frame = JSON.stringify({ type: "event", event, payload });
    for (const ws of this.sockets) {
      if (ws.readyState === 1) ws.send(frame);
    }
  }

  newGoal(sessionKey, objective) {
    const now = Date.now();
    const goal = {
      id: "goal-" + (++goalSeq),
      objective,
      status: "active",
      tokensUsed: 1234,
      createdAt: now,
      updatedAt: now,
    };
    this.goals.set(sessionKey, goal);
    return goal;
  }

  handleWs(ws) {
    this.sockets.add(ws);
    ws.on("close", () => this.sockets.delete(ws));
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!msg || msg.type !== "req") return;
      this.rpcLog.push({ method: msg.method, params: msg.params || {} });
      let payload;
      let error = null;
      try {
        payload = this.route(msg.method, msg.params || {});
      } catch (e) {
        error = { message: e.message };
      }
      ws.send(JSON.stringify(
        error
          ? { type: "res", id: msg.id, ok: false, error }
          : { type: "res", id: msg.id, ok: true, payload }
      ));
    });
  }

  route(method, params) {
    switch (method) {
      case "connect":
        return { protocol: 4 };
      case "question.list":
        return { questions: [] };
      case "sessions.subscribe":
        return { ok: true };
      case "sessions.messages.subscribe":
      case "sessions.messages.unsubscribe":
        return { key: params.key };
      case "sessions.list":
        return {
          sessions: [...this.goals.entries()].map(([key, goal]) => ({ key, goal })),
        };
      case "sessions.goal.update": {
        const row = this.goals.get(params.sessionKey);
        if (!row || row.id !== params.goalId) throw new Error("goal not found");
        const action = String(params.action || "");
        if (action === "pause") row.status = "paused";
        else if (action === "complete") { row.status = "complete"; row.completedAt = Date.now(); }
        else if (action === "block") row.status = "blocked";
        else if (action === "edit") row.objective = String(params.objective || row.objective);
        else throw new Error("unsupported goal action: " + action);
        row.updatedAt = Date.now();
        return { goal: row };
      }
      case "sessions.goal.clear": {
        this.clearCalls += 1;
        this.goals.delete(params.sessionKey);
        return { status: "cleared" };
      }
      case "sessions.patch":
      case "sessions.abort":
      case "chat.send":
        return { ok: true };
      case "chat.history":
        // Match the streamed reply so reconcile's dedupe stays quiet.
        return {
          messages: [
            { role: "user", content: "/goal …" },
            { role: "assistant", content: this.completionText },
          ],
        };
      case "models.list":
        return { models: [] };
      case "cron.list":
        return { jobs: [] };
      case "cron.runs":
        return { runs: [] };
      default:
        return {};
    }
  }

  handleHttp(req, res) {
    const pathOnly = (req.url || "").split("?")[0];
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (req.method !== "POST" || pathOnly !== "/v1/chat/completions") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch {}
      const sessionKey = String(payload.user || "");
      const msgs = Array.isArray(payload.messages) ? payload.messages : [];
      const last = msgs[msgs.length - 1] || {};
      const content = String(last.content || "");
      const isGoalTurn = content.startsWith("/goal ");
      this.completions.push({ user: sessionKey, content });

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "close",
      });
      const chunk = (delta) => {
        res.write("data: " + JSON.stringify({
          id: "chatcmpl_fake", object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000), model: "openclaw/default",
          choices: [{ index: 0, delta, finish_reason: null }],
        }) + "\n\n");
      };
      chunk({ content: "Working" });
      setTimeout(() => {
        if (isGoalTurn || this.mode === "tool-event") {
          const objective = isGoalTurn ? content.slice(6) : "Tool-created goal";
          const goal = this.newGoal(sessionKey, objective);
          if (this.mode === "tool-event") {
            this.broadcast("session.tool", {
              sessionKey,
              data: { name: "create_goal", phase: "result", toolCallId: "tc-1", result: "ok", isError: false },
            });
          } else {
            this.broadcast("sessions.changed", { sessionKey, reason: "goal", goal });
          }
        }
      }, 60);
      setTimeout(() => {
        chunk({ content: " on it." });
        res.write("data: [DONE]\n\n");
        res.end();
      }, 180);
    });
  }
}

module.exports = { FakeGateway };
