// Moss — gateway proxying: plain pass-through and streaming chat completion.
const http = require("http");
const uploads = require("./uploads");
const { GW, HOP, AGENT_ID } = require("./config");
const { json, readBody } = require("./http-utils");
const push = require("./push");
const { loadStore } = require("./store");
const { stripThinkingPrefix, slimQuestions, chatIdFromSession, sameMossSession, extractInlineThinking } = require("./text");
const { gatewayToken, ensureHub, subscribeSession, unsubscribeSession } = require("./gateway");
const { chatOverrides, applyChatSession } = require("./models");
const goals = require("./goals");
const {
  runs,
  upsertRunTool,
  questionsFor,
  handleQuestionEvent,
  commitAssistant,
} = require("./runs");
const {
  fromAgentTool,
  fromThinkingPayload,
  toolSse,
  thinkingSse,
  questionSse,
  goalSse,
} = require("./sse");

function sessionKeyFromUser(user) {
  return typeof user === "string" && /^moss-[a-z0-9_-]+$/i.test(user) ? user : "";
}

// Agent tools that mutate session-goal state; a result event means the
// gateway session row just changed goal-wise.
const GOAL_TOOLS = new Set(["create_goal", "update_goal"]);

function upstreamHeaders(req, bodyLength) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP.has(k.toLowerCase())) headers[k] = v;
  }
  headers.host = `${GW.host}:${GW.port}`;
  headers.authorization = "Bearer " + gatewayToken();
  if (bodyLength) headers["content-length"] = String(bodyLength);
  else delete headers["content-length"];
  return headers;
}

// Non-streaming and generic requests: straight pass-through both ways.
function relay(req, res, body) {
  const upstream = http.request(
    { ...GW, method: req.method, path: req.url, headers: upstreamHeaders(req, body.length) },
    (up) => {
      const out = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (!HOP.has(k.toLowerCase())) out[k] = v;
      }
      res.writeHead(up.statusCode || 502, out);
      up.pipe(res);
    }
  );
  upstream.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("gateway unreachable: " + e.message);
  });
  upstream.end(body);
}

function proxy(req, res) {
  readBody(req)
    .then((body) => relay(req, res, body))
    .catch((e) => {
      if (!res.headersSent) res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(e.message);
    });
}

// Streaming chat completion: relay upstream SSE while merging live tool,
// thinking, and question events from the gateway websocket into the stream.
async function proxyChat(req, res) {
  const body = await readBody(req);
  let payload = {};
  try { payload = JSON.parse(body.toString("utf8") || "{}"); } catch {}
  if (!payload || payload.stream !== true) {
    relay(req, res, body);
    return;
  }

  const sessionKey = sessionKeyFromUser(payload.user);
  const chatId = chatIdFromSession(sessionKey);
  const body0 = payload && typeof payload === "object" ? payload : {};
  if (Array.isArray(body0.messages)) {
    // Goal-mode turns: the client keeps the bubble clean and marks the raw
    // objective in goalSend; upstream we rewrite only the newest message to
    // "/goal <objective>" so the gateway creates the goal and runs the turn.
    const lastMsg = body0.messages[body0.messages.length - 1];
    if (chatId && lastMsg && typeof lastMsg === "object" && lastMsg.goalSend) {
      // A finished goal must not block the replacement goal.
      await goals.clearTerminal(chatId);
    }
    const lastIdx = body0.messages.length - 1;
    payload.messages = body0.messages.map((msg, i) => {
      if (!msg || typeof msg !== "object" || !msg.goalSend) return msg;
      const out = { ...msg };
      const objective = String(out.goalSend).trim();
      delete out.goalSend;
      if (i === lastIdx && objective) out.content = "/goal " + objective.slice(0, 16000);
      return out;
    });
  }
  try {
    uploads.persistMessageImages(payload.messages, chatId || sessionKey || "chat");
  } catch (e) {
    console.log("moss-uploads skipped:", e && e.message);
  }
  const bodyOut = Buffer.from(JSON.stringify(payload));
  let finished = false;
  let clientAttached = true;
  const identity = { id: "", created: 0, model: "openclaw/default" };
  let heartbeat = null;
  let answer = "";
  const tools = [];
  const thinkingMap = new Map();
  const thinkingOrder = [];
  const thinkingList = () => thinkingOrder.map((id) => thinkingMap.get(id)).filter(Boolean);
  const run = { partial: "", tools, thinking: [], done: false, cancel: null };
  if (chatId) {
    const prev = runs.get(chatId);
    if (prev && !prev.done) {
      // A dropped phone stream must not kill the in-flight turn.
      json(res, 409, {
        pending: true,
        partial: prev.partial || "",
        liveTools: prev.tools || [],
        thinking: prev.thinking || [],
        questions: questionsFor(chatId),
      });
      return;
    }
    run.questions = questionsFor(chatId);
    run.goal = goals.peek(chatId);
    runs.set(chatId, run);
    run.injectGoal = (goal) => {
      run.goal = goal || null;
      if (finished || !clientAttached) return;
      startSse();
      writeClient(goalSse(identity, run.goal));
    };
  }

  const startSse = () => {
    if (!clientAttached || res.headersSent) return;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    try {
      res.write(": connected\n\n");
      res.write(": " + " ".repeat(2048) + "\n\n");
    } catch {}
    heartbeat = setInterval(() => {
      if (!clientAttached || finished || res.writableEnded) return;
      try { res.write(": keepalive\n\n"); } catch {}
    }, 15000);
    if (heartbeat.unref) heartbeat.unref();
  };

  const writeClient = (chunk) => {
    if (!clientAttached || res.writableEnded) return;
    try { res.write(chunk); } catch { clientAttached = false; }
  };

  // `finished` is set by the upstream [DONE] frame, but the commit happens in
  // finishRun (upstream `end`). A ws event can still land between those two,
  // so data upsert is gated on run.done; only the client write stops at
  // `finished`. Gating both on `finished` dropped the last tool result.
  const inject = (tool) => {
    if (run.done || !tool) return;
    upsertRunTool(tools, tool);
    run.partial = answer;
    if (finished || !clientAttached) return;
    startSse();
    writeClient(toolSse(identity, tool));
  };

  const injectThinking = (entry) => {
    if (run.done || !entry || !entry.text) return;
    const id = entry.id || "thinking";
    if (!thinkingMap.has(id)) thinkingOrder.push(id);
    if (entry.replace === false) thinkingMap.set(id, (thinkingMap.get(id) || "") + entry.text);
    else thinkingMap.set(id, entry.text);
    run.thinking = thinkingList();
    run.partial = stripThinkingPrefix(answer, run.thinking);
    if (finished || !clientAttached) return;
    startSse();
    writeClient(thinkingSse(identity, run.thinking));
  };

  run.injectQuestion = (question) => {
    if (run.done || !question) return;
    run.questions = slimQuestions((run.questions || []).concat([question]));
    if (finished || !clientAttached) return;
    startSse();
    writeClient(questionSse(identity, question));
  };
  if (chatId) {
    questionsFor(chatId).forEach((q) => {
      try { run.injectQuestion(q); } catch {}
    });
  }

  const stopHeartbeat = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const cleanup = () => {
    finished = true;
    stopHeartbeat();
    if (sessionKey) unsubscribeSession(sessionKey).catch(() => {});
  };

  const finishRun = (err) => {
    if (run.done) return;
    run.done = true;
    let think = thinkingList();
    if (!think.length) {
      const inline = extractInlineThinking(answer);
      if (inline.length) think = inline;
    }
    const content = stripThinkingPrefix(answer, think);
    run.thinking = think;
    run.partial = content;
    commitAssistant(chatId, { content, thinking: think, tools, questions: questionsFor(chatId), error: err || "" });
    runs.delete(chatId);
    cleanup();
    if (chatId && !run.stopRequested) {
      const text = content || err || "";
      if (text && !/^NO_REPLY$/i.test(String(text).trim())) {
        try {
          const chat = (loadStore().chats || []).find((c) => c.id === chatId);
          push.notifyChat(chatId, (chat && chat.title) || "Moss", text);
        } catch (e) {}
      }
    }
    if (clientAttached && !res.writableEnded) {
      if (err && !run.stopRequested) {
        startSse();
        writeClient("data: " + JSON.stringify({ error: { message: String(err) } }) + "\n\n");
        writeClient("data: [DONE]\n\n");
      }
      try { res.end(); } catch {}
    }
  };

  const writeSseError = (message) => {
    finishRun(message);
  };

  const detachClient = () => {
    if (!clientAttached) return;
    clientAttached = false;
    stopHeartbeat();
    if (!res.writableEnded) try { res.end(); } catch {}
  };

  // Headers first so a phone is not sitting on a headerless HTTP/2 stream
  // while we open the tool-events websocket (that delay was aborting Chrome).
  startSse();

  run.injectTool = (tool) => {
    console.log("moss-tools", tool.phase, tool.name);
    inject(tool);
    // Goal tools do not broadcast sessions.changed when they mutate, and on
    // the /goal chat-turn path the goal is created by the agent's own
    // create_goal call mid-run. Sync the goal cache the moment such a tool
    // returns and push the snapshot into this stream, so the Goal pill shows
    // live instead of after a reload.
    if (GOAL_TOOLS.has(tool.name) && tool.phase === "result" && chatId && !run.done) {
      goals
        .scheduleFreshSync(chatId)
        .then((goal) => {
          const next = goal || null;
          if (JSON.stringify(next) === JSON.stringify(run.goal || null)) return;
          console.log("moss-goal-sync", chatId, next ? next.status : "cleared");
          if (!run.done && typeof run.injectGoal === "function") run.injectGoal(next);
        })
        .catch(() => {});
    }
  };

  run.injectThinking = (entry) => {
    injectThinking(entry);
  };

  let over = { model: "", thinkingLevel: "" };
  if (chatId) {
    over = chatOverrides(chatId);
    if (over.model || over.thinkingLevel) {
      await applyChatSession(chatId, over.model, over.thinkingLevel);
    }
  }

  // Ensure persistent hub connection is ready to receive tool/thinking events.
  // When hub is already connected (normal state), this resolves immediately (0ms).
  try { await ensureHub(2000); } catch {}
  if (sessionKey) {
    try { await subscribeSession(sessionKey); } catch {}
  }

  const headers = upstreamHeaders(req, bodyOut.length);
  if (sessionKey) headers["x-openclaw-session-key"] = sessionKey;
  if (over.model) headers["x-openclaw-model"] = over.model;

  const upstream = http.request({ ...GW, method: "POST", path: req.url, headers }, (up) => {
    const ctype = String(up.headers["content-type"] || "");
    if ((up.statusCode && up.statusCode >= 400) || !ctype.includes("text/event-stream")) {
      let raw = "";
      up.setEncoding("utf8");
      up.on("data", (c) => { raw += c; });
      up.on("end", () => {
        let msg = "HTTP " + (up.statusCode || 502);
        try {
          const j = JSON.parse(raw);
          msg = (j.error && (j.error.message || j.error.type || j.error)) || raw.slice(0, 300) || msg;
        } catch {
          if (raw) msg = raw.slice(0, 300);
        }
        const isConflict = up.statusCode === 409 || /SessionWorkStartChangedError|changed while starting work|already running/i.test(msg);
        if (isConflict) {
          console.log("moss-chat session already active in OpenClaw", chatId, msg);
          if (clientAttached && !res.writableEnded) {
            writeClient("data: " + JSON.stringify({ error: { message: msg, code: "pending" } }) + "\n\n");
            writeClient("data: [DONE]\n\n");
            try { res.end(); } catch {}
          }
          finished = true;
          stopHeartbeat();
          return;
        }
        writeSseError(msg);
      });
      return;
    }
    let buf = "";
    up.setEncoding("utf8");
    up.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i + 1);
        buf = buf.slice(i + 1);
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) {
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") finished = true;
          else {
            try {
              const j = JSON.parse(data);
              if (j.id) identity.id = j.id;
              if (j.created) identity.created = j.created;
              if (j.model) identity.model = j.model;
              const delta = j.choices && j.choices[0] && j.choices[0].delta;
              if (delta && typeof delta.reasoning_content === "string" && delta.reasoning_content) {
                injectThinking({ id: "reasoning", text: delta.reasoning_content, replace: false });
              }
              if (delta && Array.isArray(delta.tool_calls)) {
                delta.tool_calls.forEach((t) => {
                  const fn = t.function || {};
                  inject({
                    id: t.id || "",
                    idx: t.index,
                    name: fn.name || "",
                    args: typeof fn.arguments === "string" ? fn.arguments : "",
                    phase: "start",
                    appendArgs: !fn.name && typeof fn.arguments === "string",
                  });
                });
              }
              if (delta && typeof delta.content === "string" && delta.content) {
                answer += delta.content;
                run.partial = stripThinkingPrefix(answer, thinkingList());
              }
            } catch {}
          }
        }
        writeClient(line);
      }
    });
    up.on("end", () => {
      if (buf) writeClient(buf);
      finishRun("");
    });
    up.on("error", () => {
      if (finished || run.done || run.stopRequested) {
        if (!run.done) finishRun("");
        return;
      }
      writeSseError("gateway stream error");
    });
  });
  run.cancel = () => {
    run.stopRequested = true;
    try { upstream.destroy(); } catch {}
    finishRun("");
  };
  req.on("aborted", detachClient);
  res.on("close", () => {
    if (!res.writableEnded) detachClient();
  });
  upstream.on("error", (e) => {
    if (finished || run.done || run.stopRequested) {
      if (!run.done) finishRun("");
      return;
    }
    writeSseError("gateway unreachable: " + e.message);
  });
  upstream.end(bodyOut);
}

function handleV1(req, res) {
  if (!(req.url || "/").startsWith("/v1")) return false;
  const pathOnly = (req.url || "/").split("?")[0];
  if (req.method === "POST" && pathOnly === "/v1/chat/completions") {
    return proxyChat(req, res)
      .catch((e) => {
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
        if (!res.writableEnded) res.end("proxy failed: " + e.message);
      })
      .then(() => true);
  }
  proxy(req, res);
  return true;
}

module.exports = { proxy, proxyChat, handleV1 };
