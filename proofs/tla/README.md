# MossStream — the chat client's streaming lifecycle, model-checked

First TLA+ exercise for Moss (Oct 2026). Spec: `MossStream.tla`, config: `MossStream.cfg`.
Run: `java -cp tla2tools.jar tlc2.TLC -continue -config MossStream.cfg MossStream.tla`
(446 states, ~140 distinct, ~6s on the Pi.)

## What is modeled

One chat's turn as `js/chats.js` + `js/stream.js` implement it. Variables are the real
flags: `pending`, `stopping`, `abortLive` (= `liveStream()`), `pollOn`/`pollInFlight`
(the 1s reconciler), `ui`, plus the server's truth `srv`. Actions correspond to code
sites (Send, StreamOk, StreamDrop, StreamFail, StopRequest/StopSettles, ServerStops,
PollTick/PollResult, Repaint...).

## What the model found (before the modeled fixes)

1. **Real bug — invisible reply on regex-miss errors.** `send()`'s catch treats any
   non-dropped error as final: paints "(error)", sets `pending=false`, leaves the
   poller off. If the turn is still running server-side (proxy 504 while gateway
   continues), the reply lands with no notification and no live view. Modeled fix:
   `StreamFailRunning` — route to the poller when `srv` may still be busy.
2. **Real bug — stale poll result clobbers a fresh turn.** `tickPending()` computes
   its chat list, then awaits `fetchChat`; a `send()` racing that await gets its
   flags overwritten by `rememberChat` (stop button hidden mid-stream). Modeled fix:
   `PollResult` discards the result when a live stream appeared mid-flight
   (one-line guard in tickPending).
3. **Two transient windows, benign:** `stopping` outlives `pending` by ≤1 fetch;
   the poll timer stays scheduled ≤1 tick after pending clears. Not invariants
   (transiently false) but covered by liveness: `StoppingSettles`, `QuietStopsPoller`.
4. **One too-strong property lesson:** `pollOn ~> ~pollOn` fails on a user who
   keeps sending — correct behavior, wrong property. Restated as: once the chat
   goes permanently quiet, the poller eventually stops.

## Final status

- Pass strictly: `TypeOK`, `StreamImpliesPending`, `AbortOnlyWhileStreaming`,
  `RecoveringImpliesPending`, `ErrorImpliesTurnEnded` (with modeled fixes).
- Transient/benign, documented in-module: `StoppingImpliesPending`,
  `PollerOnlyWhenNeeded`.
- Pass (liveness): `StoppingSettles`, `QuietStopsPoller`.

If you change the send/stop/poll paths in `js/chats.js`, re-read this spec first —
same rule as `Uploads.lean`.

---

# More specs (Oct 2026 session 2)

## MossGoal — the goal pill vs OpenClaw (`MossGoal.tla` + `.cfg`)

Models the real split: pill (js/goals.js) -> Moss server (goals.js cache) -> RPC ->
OpenClaw gateway. The gateway is an unconstrained oracle (the agent's create_goal
can appear mid-run with no broadcast). Key modeled facts from the real code:
`act()` writes chat.goal FROM the RPC response (no divergence window); a
`goal:null` erase is trusted only when the change is goal-scoped; scheduleFreshSync
retries 3x600ms for just-created goals.

Result: 1,540 states, 5 safety invariants + 3 liveness properties pass.
**No shipped-code changes needed** - the spec confirms the design.

## MossStatus — the header status dot (`MossStatus.tla` + `.cfg`)

The dot describes TWO things: Moss itself (/api/config) and the model path
(/v1/models proxied to the gateway). Old code probed /v1/models once at boot ->
false red stuck until reload. New code (js/app.js + js/chats.js) probes both in
parallel, re-probes every 30s while visible + on visibilitychange/pageshow/online,
guarded by a checking flag, 10s abort.

Result: 461 states, all invariants + liveness pass. `MossStatusOld.tla` is the old
design (re-probe loop deleted) and mechanically FAILS RedHeals - the user-reported
"red but online" bug, proven rather than asserted.
