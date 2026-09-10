// Moss — gateway connectivity: ws client, RPC, question hub, follow-up steering.
const fs = require("fs");
const path = require("path");
const { GW } = require("./config");
const { nid } = require("./http-utils");

function gatewayToken() {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(process.env.HOME || "/home/claidler", ".openclaw/openclaw.json"), "utf8")
    );
    return (cfg.gateway && cfg.gateway.auth && cfg.gateway.auth.token) || "";
  } catch {
    return "";
  }
}

// Open a ws to the gateway, complete the connect handshake, resolve with {ws, rpc}.
function connectGatewayWs(onEvent, opts) {
  const scopes = opts && Array.isArray(opts.scopes) && opts.scopes.length ? opts.scopes : ["operator.read"];
  const caps = opts && Array.isArray(opts.caps) ? opts.caps : ["tool-events"];
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket("ws://" + GW.host + ":" + GW.port);
    const pending = new Map();
    let n = 0;
    let connecting = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const rpc = (method, params) => {
      const id = "moss-" + (++n);
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ type: "req", id, method, params }));
      });
    };
    const timer = setTimeout(() => fail(new Error("gateway ws timeout")), 8000);
    const sendConnect = () => {
      if (connecting || settled) return;
      if (ws.readyState !== 1) return;
      connecting = true;
      rpc("connect", {
        minProtocol: 4,
        maxProtocol: 4,
        client: { id: "gateway-client", version: "1.0.0", platform: "linux", mode: "backend" },
        role: "operator",
        scopes,
        caps,
        auth: { token: gatewayToken() },
      }).then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ws, rpc });
      }).catch(fail);
    };
    ws.addEventListener("error", () => fail(new Error("gateway ws error")));
    ws.addEventListener("close", () => {
      if (!settled) fail(new Error("gateway ws closed"));
    });
    ws.addEventListener("open", () => setTimeout(sendConnect, 250));
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type === "event" && msg.event === "connect.challenge") {
        sendConnect();
        return;
      }
      if (msg.type === "res" && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.ok) p.res(msg.payload);
        else p.rej(new Error((msg.error && msg.error.message) || "rpc failed"));
        return;
      }
      if (msg.type === "event" && typeof onEvent === "function") onEvent(msg);
    });
  });
}

// Persistent hub connection shared for cheap RPCs and question events.
let hub = null;
let hubTimer = null;

async function gatewayRpc(scopes, method, params, timeoutMs) {
  const wait = (rpc) => Promise.race([
    rpc(method, params),
    new Promise((_, reject) => setTimeout(() => reject(new Error(method + " timeout")), timeoutMs || 12000)),
  ]);
  if (hub && hub.ws && hub.ws.readyState === 1 && typeof hub.rpc === "function") {
    return wait(hub.rpc);
  }
  const h = await connectGatewayWs(null, { scopes, caps: ["tool-events"] });
  try {
    return await wait(h.rpc);
  } finally {
    try { h.ws.close(); } catch {}
  }
}

// `onEvent` receives every gateway event on the hub connection (question + cron).
function startHub(onEvent) {
  if (hubTimer) {
    clearTimeout(hubTimer);
    hubTimer = null;
  }
  connectGatewayWs(onEvent, {
    scopes: ["operator.read", "operator.questions"],
    caps: ["tool-events"],
  }).then(async (h) => {
    hub = h;
    h.ws.addEventListener("close", () => {
      if (hub === h) hub = null;
      if (!hubTimer) hubTimer = setTimeout(() => startHub(onEvent), 2000);
    });
    try {
      const listed = await h.rpc("question.list", {});
      (listed && listed.questions ? listed.questions : []).forEach((q) =>
        onEvent({ event: "question.requested", payload: q })
      );
      console.log("moss-questions hub ready", (listed && listed.questions ? listed.questions : []).length);
    } catch (e) {
      console.log("moss-questions list skipped:", e.message);
    }
  }).catch((e) => {
    console.log("moss-questions hub skipped:", e.message);
    if (!hubTimer) hubTimer = setTimeout(() => startHub(onEvent), 4000);
  });
}

async function steerFollowup(chatId, message, attachments) {
  const sessionKey = "moss-" + chatId;
  const h = await connectGatewayWs(null, {
    scopes: ["operator.read", "operator.write"],
    caps: ["tool-events"],
  });
  try {
    return await Promise.race([
      h.rpc("chat.send", {
        sessionKey,
        agentId: "main",
        message,
        ...(attachments && attachments.length ? { attachments } : {}),
        queueMode: "steer",
        idempotencyKey: "moss-fu-" + nid(),
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("steer timeout")), 12000)),
    ]);
  } finally {
    try { h.ws.close(); } catch {}
  }
}

module.exports = { gatewayToken, connectGatewayWs, gatewayRpc, startHub, steerFollowup };
