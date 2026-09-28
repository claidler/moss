// Moss e2e/integration harness — boots the real Moss server against a
// FakeGateway in a temp sandbox, logs in, and exposes a tiny API client.
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { FakeGateway } = require("./fake-gateway");

const REPO = path.join(__dirname, "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moss-e2e-"));
  const gw = new FakeGateway();
  const gwPort = await gw.listen();
  const port = await freePort();
  const env = Object.assign({}, process.env, {
    PORT: String(port),
    HOST: "127.0.0.1",
    MOSS_GW_HOST: "127.0.0.1",
    MOSS_GW_PORT: String(gwPort),
    MOSS_ALLOWED_HOSTS: "127.0.0.1",
    MOSS_STORE_FILE: path.join(dir, "store.json"),
    MOSS_HISTORY_FILE: path.join(dir, "history.json"),
    MOSS_VAPID_FILE: path.join(dir, "vapid.json"),
    MOSS_PUSH_SUBS_FILE: path.join(dir, "push-subs.json"),
    OPENCLAW_GATEWAY_TOKEN: "e2e-token",
  });
  const child = spawn(process.execPath, [path.join(REPO, "server.js")], {
    cwd: REPO,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => { logs += d; });
  child.stderr.on("data", (d) => { logs += d; });

  const deadline = Date.now() + 15000;
  while (!logs.includes("moss on ") && Date.now() < deadline) {
    if (child.exitCode != null) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!logs.includes("moss on ")) {
    throw new Error("moss server did not start:\n" + logs);
  }

  const password = fs.readFileSync(path.join(REPO, "data", "PASSWORD"), "utf8").trim();
  const base = "http://127.0.0.1:" + port;

  // One login, one cookie, shared by every request in the scenario.
  const loginRes = await fetch(base + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ password }),
  });
  if (!loginRes.ok) throw new Error("login failed: HTTP " + loginRes.status);
  const cookie = String(loginRes.headers.get("set-cookie") || "")
    .split(";")[0];
  if (!cookie.startsWith("moss_session=")) throw new Error("no session cookie");

  async function api(p, opts) {
    const o = Object.assign({ headers: {} }, opts || {});
    o.headers.Cookie = cookie;
    const res = await fetch(base + p, o);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  }

  // POST a streaming chat turn; resolves with the concatenated SSE text.
  async function chatTurn(chatId, message) {
    const res = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Cookie: cookie,
      },
      body: JSON.stringify({
        model: "openclaw/default",
        stream: true,
        user: "moss-" + chatId,
        messages: [message],
      }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let all = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      all += decoder.decode(value, { stream: true });
    }
    return all;
  }

  function goalDeltas(sseText) {
    const out = [];
    for (const line of sseText.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      try {
        const j = JSON.parse(t.slice(5).trim());
        const delta = j.choices && j.choices[0] && j.choices[0].delta;
        if (delta && "moss_goal" in delta) out.push(delta.moss_goal);
      } catch {}
    }
    return out;
  }

  async function close() {
    try { child.kill("SIGKILL"); } catch {}
    await gw.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  return { base, gw, api, chatTurn, goalDeltas, close, logs: () => logs };
}

module.exports = { boot };
