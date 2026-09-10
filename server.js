// Moss — tiny chat layer for OpenClaw. Entry point: wiring only.
//
// Modules: config.js (constants) · http-utils.js (json/body/static helpers) ·
// auth.js (login + session cookie) · text.js (message slimming) ·
// store.js (chat JSON store) · gateway.js (ws/RPC/question hub) ·
// runs.js (live run state) · api.js (/api/chats) · proxy.js (/v1 completions) ·
// sse.js (SSE/chunk helpers) · notes.js (+ notes-text/store/enrich) · uploads.js
const http = require("http");
const notes = require("./notes");
const { GW, PORT, HOST, ROOT } = require("./config");
const { json, readBody, serveStatic } = require("./http-utils");
const { clipText } = require("./text");
const auth = require("./auth");
const gateway = require("./gateway");
const runs = require("./runs");
const chatApi = require("./api");
const proxy = require("./proxy");

function route(req, res) {
  return chatApi.api(req, res).then(async (hit) => {
    if (hit) return;
    if (await proxy.handleV1(req, res)) return;
    serveStatic(req, res);
  });
}

http
  .createServer((req, res) => {
    const p = (req.url || "/").split("?")[0];
    auth.handleLogin(req, res).then((loginHit) => {
      if (loginHit) return;
      const authed = auth.isAuthenticated(req);
      if (!authed && !auth.isPublicPath(p)) {
        auth.deny(req, res);
        return;
      }
      if (p === "/" && req.method === "GET" && !authed) {
        auth.deny(req, res);
        return;
      }
      return route(req, res);
    }).catch(() => {
      json(res, 500, { error: "server" });
    });
  })
  .listen(PORT, HOST, () => {
    console.log(`moss on ${HOST}:${PORT} -> gateway :${GW.port}`);
    notes.init({ root: ROOT, clipText, json, readBody, gatewayRpc: gateway.gatewayRpc });
    gateway.startHub(runs.handleGatewayEvent);
    notes.startPoll();
  });
