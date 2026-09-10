# Moss

A tiny chat layer for [OpenClaw](https://docs.openclaw.ai). Moss is a modular Node server that proxies a gateway's chat completions endpoint and serves a lightweight PWA chat UI, plus an Automations board for cron/automation output.

## What it does

- Serves a chat UI (`index.html`) with markdown rendering, syntax highlighting, and image attachments.
- Proxies `/v1` chat completions to the OpenClaw gateway (default `127.0.0.1:18789`).
- Cookie-based login with a per-install generated password (`data/PASSWORD`, `data/auth.json`).
- Notes and uploads support (`notes.js` plus `notes-text.js` / `notes-store.js` / `notes-enrich.js`, `uploads.js`).
- Progressive web app manifest + icons for install-on-phone.

## Layout

```
config.js            Gateway target, ports, cookie/auth constants
http-utils.js        JSON / body / static helpers
auth.js              Login + session cookie
text.js              Message slimming
store.js             Chat JSON store
gateway.js           WS / RPC / question hub
runs.js              Live run state
api.js               /api/chats
proxy.js             /v1 relay + streaming chat
sse.js               SSE / chunk helpers
notes.js             Automations poll + /api/notifications facade
notes-text.js        Heartbeat/progress/truncation classifiers
notes-store.js       notifications.json load/save/upsert
notes-enrich.js      Transcript/history body recovery
uploads.js           Upload handling
server.js            HTTP wiring only
index.html           Chat UI shell (markup + vendor + module entry)
css/app.css          Client styles
js/                  Client ES modules (app.js entry)
login.html           Login page
manifest.webmanifest PWA manifest
make-icons.py        Regenerates the icon PNG set from icon.svg
vendor/              Vendored deps (marked, DOMPurify, Prism) — no build step
data/                Runtime state (gitignored): store.json, notifications.json, auth
```

## Run

No build step, no dependencies to install — everything needed is vendored.

```bash
PORT=8190 HOST=127.0.0.1 node server.js
```

Environment:

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8190` | Listen port |
| `HOST` | `127.0.0.1` | Bind address |
| `MOSS_ALLOWED_HOSTS` | _(empty)_ | Comma-separated hostnames allowed as login Origin/Referer |

The gateway target is set in `config.js` (`GW`). `data/` is created on first run and holds the JSON stores plus the generated login password — show it on first boot and store it somewhere safe.

Typically run behind a reverse proxy (systemd unit `moss.service` + Caddy) so the PWA gets HTTPS on the LAN.
