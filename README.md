# Moss

A tiny chat layer for [OpenClaw](https://docs.openclaw.ai). Moss is a modular Node server that proxies a gateway's chat completions endpoint and serves a lightweight PWA chat UI, plus an Automations board for cron/automation output.

## What it does

- Serves a chat UI (`index.html`) with markdown rendering, syntax highlighting, image attachments, and Groq speech-to-text dictation into the composer (confirm before send).
- Proxies `/v1` chat completions to the OpenClaw gateway.
- Cookie-based login with a per-install generated password (`data/PASSWORD`, `data/auth.json`).
- Notes and uploads support (`notes.js` plus `notes-text.js` / `notes-store.js` / `notes-enrich.js`, `uploads.js`).
- Web Push (VAPID) for automation output and finished chats.
- Progressive web app manifest + icons for install-on-phone.
- Optional Android app (`android/`) — Trusted Web Activity wrapping your deployed PWA.

Nothing personal is baked in: everything deployment-specific (gateway address, your agent id, your @handle, push contact, Android package/host) comes from environment variables. Defaults are localhost / neutral placeholders, so a fresh clone runs as-is and leaks nothing when forked publicly.

## Layout

```
config.js            Env-derived constants: gateway target, ports, paths, agent id
http-utils.js        JSON / body / static helpers
auth.js              Login + session cookie
text.js              Message slimming
store.js             Chat JSON store
gateway.js           WS / RPC / question hub
runs.js              Live run state
api.js               /api/chats + /api/config
proxy.js             /v1 relay + streaming chat
sse.js               SSE / chunk helpers
notes.js             Automations poll + /api/notifications facade
notes-text.js        Heartbeat/progress/truncation classifiers
notes-store.js       notifications.json load/save/upsert
notes-enrich.js      Transcript/history body recovery
push.js              Web Push (VAPID) for automations and finished chats
uploads.js           Upload handling
transcribe.js        POST /api/transcribe → Groq whisper-large-v3-turbo
commands.js          GET /api/commands skill catalog for the composer slash menu
server.js            HTTP wiring only
index.html           Chat UI shell (markup + vendor + module entry)
css/app.css          Client styles
js/                  Client ES modules (app.js entry)
js/notify.js         Notification permission, SW register, local toasts
sw.js                Service worker for Web Push and notification clicks
login.html           Login page
manifest.webmanifest PWA manifest
make-icons.py        Regenerates the icon PNG set from icon.svg
android/             Trusted Web Activity wrapper (sideload APK)
.well-known/         Digital Asset Links for the Android app (generated, see Android)
vendor/              Vendored deps (marked, DOMPurify, Prism) — no build step
data/                Runtime state (gitignored): store.json, notifications.json, auth, vapid, push-subs
```

## Run

No build step, no dependencies to install — everything needed is vendored.

```bash
PORT=8190 HOST=127.0.0.1 node server.js
```

First boot prints (and `data/PASSWORD` holds) the generated login password — store it somewhere safe. Typically run behind a reverse proxy so the PWA gets HTTPS (any TLS-terminating proxy works; a systemd user unit is a convenient supervisor).

## Configuration (environment variables)

Defaults in parentheses. Only `GROQ_API_KEY` and the Android variables are needed if you skip dictation / the phone app.

### Server

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8190` | Listen port |
| `HOST` | `127.0.0.1` | Bind address |
| `MOSS_ALLOWED_HOSTS` | _(empty)_ | Comma-separated hostnames allowed as login Origin/Referer. Set this to your deployed hostname(s), e.g. `moss.example.com,127.0.0.1`, or logins from the browser will be rejected. |
| `MOSS_GW_HOST` | `127.0.0.1` | OpenClaw gateway host |
| `MOSS_GW_PORT` | `18789` | OpenClaw gateway port |
| `OPENCLAW_GATEWAY_TOKEN` | _(auto)_ | Gateway auth token. Unset → read from `<openclaw dir>/openclaw.json` at runtime. Set it explicitly if the config file isn't on this machine. |
| `MOSS_OPENCLAW_DIR` | `~/.openclaw` | OpenClaw state directory (config, `.env`, workspace, agent data) |
| `MOSS_AGENT_ID` | `main` | OpenClaw agent id Moss talks to (RPC, sessions, goals, slash commands, board transcripts) |
| `MOSS_OWNER_HANDLE` | _(empty)_ | Your chat handle (e.g. `alice`). Automation output that pings `@alice` gets the mention stripped from board notes and chat bubbles. Empty → no stripping. Exposed to the client via `/api/config`. |
| `MOSS_ANDROID_PACKAGE` | _(unset)_ | When set **with** `MOSS_ANDROID_FINGERPRINT`, the server synthesizes `/.well-known/assetlinks.json` from these at runtime — your app identity never has to be committed |
| `MOSS_PUSH_SUBJECT` | `mailto:admin@localhost` | VAPID `sub` contact sent to push services; any `mailto:` or `https:` URL works |
| `MOSS_ANDROID_FINGERPRINT` | _(unset)_ | SHA-256 release-cert fingerprint (`AA:BB:…`, 32 hex pairs) used in the synthesized assetlinks response |
| `MOSS_ENV_FILE` | _(none)_ | Extra `KEY=value` file to read `GROQ_API_KEY` from |
| `GROQ_API_KEY` | from `MOSS_ENV_FILE`, `~/.openclaw/.env`, or `~/.hermes/.env` | Groq Whisper for composer dictation (`whisper-large-v3-turbo`). Never local STT. Dictation is disabled without a key. |
| `MOSS_STORE_FILE` | `data/store.json` | Chat store location |
| `MOSS_HISTORY_FILE` | `data/history.json` | Chat history location |
| `MOSS_VAPID_FILE` | `data/vapid.json` | VAPID key pair location |
| `MOSS_PUSH_SUBS_FILE` | `data/push-subs.json` | Push subscription store location |

`data/` is created on first run and holds the JSON stores, the generated login password, the VAPID private key, and push subscriptions. It is gitignored — chat history never ends up in the repo.

## Tests

```bash
node --test
```

## Android app

`android/` is a Trusted Web Activity for **your** deployed Moss URL, with a launcher icon and no browser chrome once Digital Asset Links verify. Chrome 72+ is used when present; devices without a TWA-capable browser fall back to a full-screen WebView.

Your identity stays in two places, both env:

| Var / property | Default | Purpose |
| --- | --- | --- |
| `MOSS_ANDROID_PACKAGE` | `com.example.moss` | Application id / Java package (also `./gradlew -PmossPackage=…`) |
| `MOSS_ANDROID_HOST` | `moss.example.com` | Hostname of your deployed PWA |
| `MOSS_KEYSTORE_DN` | `CN=Moss, OU=Moss, O=Moss` | X.500 subject for the generated release keystore |

### Set up once

1. Edit `android/local-defaults`-style values by exporting the three variables above, then run:

   ```bash
   MOSS_ANDROID_PACKAGE=com.you.moss MOSS_ANDROID_HOST=moss.example.com \
   MOSS_KEYSTORE_DN="CN=Moss, OU=Moss, O=Moss" \
   python3 android/scripts/generate-assets.py
   ```

   The script regenerates icons, creates `android/keystore.jks` + `keystore.properties` (gitignored) if missing, and rewrites `android/app/src/main/res/values/strings.xml`, `.well-known/assetlinks.json`, and `android/sha256.txt` with **your** package, host, and fresh keystore fingerprint. Those three generated files ship as neutral placeholders — keep your generated versions as local changes (or commit them if you don't mind).

2. Serve the repo's `.well-known/assetlinks.json` at `https://<your-host>/.well-known/assetlinks.json` (the Moss server already does — it's a public path).

3. Export your keystore for CI:

   ```bash
   base64 -w0 android/keystore.jks     # → ANDROID_KEYSTORE_BASE64
   cat android/.keypass                # → ANDROID_KEYSTORE_PASSWORD
   ```

   Save both as repository secrets (Actions → Secrets → Actions), then copy `android/github-workflow-android.yml` to `.github/workflows/android.yml`.

### Build

**Actions → Android APK → Run workflow**, then download the `moss-android` artifact (`app-release.apk`). Sideload it; first launch shows Moss login. Once Digital Asset Links verify, Chrome hides the URL bar.

Locally: needs JDK 17 and an Android SDK; signing reads the gitignored `android/keystore.properties`.

```bash
cd android && ./gradlew assembleRelease
```

APK: `app/build/outputs/apk/release/app-release.apk`.

## Adapting to your setup

- Different gateway machine? `MOSS_GW_HOST=… MOSS_GW_PORT=…`
- Multiple OpenClaw agents? `MOSS_AGENT_ID=…` points Moss at one of them.
- Fork-and-run on a laptop with no OpenClaw config dir? Nothing breaks on boot; `/v1` calls just report the gateway as unreachable until you point them at one.
