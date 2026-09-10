# Moss

A tiny chat layer for [OpenClaw](https://docs.openclaw.ai). Moss is a single-file-ish Node server that proxies a gateway's chat completions endpoint and serves a lightweight PWA chat UI, plus an Automations board for cron/automation output.

## What it does

- Serves a chat UI (`index.html`) with markdown rendering, syntax highlighting, and image attachments.
- Proxies `/v1` chat completions to the OpenClaw gateway (default `127.0.0.1:18789`).
- Cookie-based login with a per-install generated password (`data/PASSWORD`, `data/auth.json`).
- Notes and uploads support (`notes.js`, `uploads.js`).
- Progressive web app manifest + icons for install-on-phone.

## Layout

```
server.js           HTTP server + gateway proxy + auth
notes.js            Notes store and rendering helpers
uploads.js          Upload handling
index.html          Chat UI
login.html          Login page
manifest.webmanifest PWA manifest
make-icons.py       Regenerates the icon PNG set from icon.svg
vendor/             Vendored deps (marked, DOMPurify, Prism) — no build step
data/               Runtime state (gitignored): store.json, notifications.json, auth
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

The gateway target is set in `server.js` (`GW` constant). `data/` is created on first run and holds the JSON stores plus the generated login password — show it on first boot and store it somewhere safe.

Typically run behind a reverse proxy (systemd unit `moss.service` + Caddy) so the PWA gets HTTPS on the LAN.
