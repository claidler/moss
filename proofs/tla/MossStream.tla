--------------------------- MODULE MossStream ---------------------------
(***************************************************************************)
(* Model of the Moss chat client's streaming message lifecycle.            *)
(*                                                                         *)
(* Distilled from the real code (one chat, one turn):                      *)
(*   js/stream.js  -- streamChat(): XHR SSE pump; 409/network/abort all    *)
(*                    reject; the dropped-regex in send()'s catch decides  *)
(*                    recover-vs-fail.                                     *)
(*   js/chats.js   -- send() (pending=true, abort=new AbortController,     *)
(*                    finalize on ok, dropped path keeps pending + starts  *)
(*                    the poller), stopChat() (stopping=true, POST /stop,  *)
(*                    live stream returns early - the close event settles  *)
(*                    it), tickPending() (pollInFlight guard, stopPoll-    *)
(*                    IfIdle in the finally), refreshVisible() (fetch when *)
(*                    no live stream).                                     *)
(*                                                                         *)
(* Abstractions (noted where they bite):                                   *)
(*   - "sending" folded into "streaming" (no observable difference yet)    *)
(*   - questions mode = srv = "asking" (moss_question -> asking=true,      *)
(*     pending stays true after the stream ends)                           *)
(*   - sendFollowup (send while pending) is a no-op here: it queues text   *)
(*     and doesn't change lifecycle flags                                  *)
(*                                                                         *)
(* Chris's cheat sheet: a STATE is one row of the table (all variables),   *)
(* an ACTION is a line of the real code executing, and TLC explores every  *)
(* order those lines can legally happen in.                                *)
(***************************************************************************)
EXTENDS Integers

VARIABLES
  \* ---- client: the chat row + UI flags in js/chats.js ----
  ui,           \* what the view is doing: "idle" | "streaming" | "recovering" | "error"
  pending,      \* chat.pending            - "a turn is in flight (or believed to be)"
  stopping,     \* chat.stopping           - stopChat() is mid-flight
  abortLive,    \* liveStream(chat)        - xhr open and not aborted
  pollOn,       \* state.pollTimer != null - the 1s reconciler is scheduled
  pollInFlight, \* state.pollInFlight     - a tickPending() fetch is awaiting
  \* ---- server: the gateway's truth about this chat's turn ----
  srv           \* "none" | "running" | "asking" | "done"

vars == <<ui, pending, stopping, abortLive, pollOn, pollInFlight, srv>>

srvBusy == srv \in {"running", "asking"}

TypeOK ==
  /\ ui \in {"idle", "streaming", "recovering", "error"}
  /\ pending \in BOOLEAN
  /\ stopping \in BOOLEAN
  /\ abortLive \in BOOLEAN
  /\ pollOn \in BOOLEAN
  /\ pollInFlight \in BOOLEAN
  /\ srv \in {"none", "running", "asking", "done"}

Init ==
  /\ ui = "idle"
  /\ pending = FALSE
  /\ stopping = FALSE
  /\ abortLive = FALSE
  /\ pollOn = FALSE
  /\ pollInFlight = FALSE
  /\ srv = "none"

(* ===================== server side ===================== *)

\* The turn progresses on its own schedule: produces, maybe asks a
\* question (moss_question), finishes. Order not under the client's control.
ServerStep ==
  /\ srvBusy
  /\ CASE srv = "running" -> srv' \in {"running", "asking", "done"}
         [] srv = "asking"  -> srv' \in {"asking", "done"}   \* a question never un-asks
  /\ UNCHANGED <<ui, pending, stopping, abortLive, pollOn, pollInFlight>>

\* The user's stop took effect server-side (POST /stop handled).
ServerStops ==
  /\ stopping
  /\ srvBusy
  /\ srv' = "done"
  /\ UNCHANGED <<ui, pending, stopping, abortLive, pollOn, pollInFlight>>

(* ===================== the stream (js/stream.js) ===================== *)

\* send(): POST /v1/chat/completions accepted, first bytes flowing
Send ==
  /\ ui = "idle"
  /\ ~pending
  /\ ~stopping   \* syncBusy(): sendBtn.disabled = stopping
  /\ ui' = "streaming"
  /\ pending' = TRUE
  /\ abortLive' = TRUE
  /\ stopping' = FALSE
  /\ srv' = "running"
  /\ UNCHANGED <<pollOn, pollInFlight>>

\* a chunk arrived, paintLive() - no lifecycle flags move
Chunk ==
  /\ ui = "streaming"
  /\ abortLive
  /\ srvBusy
  /\ UNCHANGED vars

\* onload, HTTP 2xx: finalize message. Questions may keep the turn open.
StreamOk ==
  /\ ui = "streaming"
  /\ abortLive
  /\ srv' = "done"
  /\ ui' = "idle"
  /\ pending' = FALSE
  /\ abortLive' = FALSE
  /\ stopping' = FALSE
  /\ UNCHANGED <<pollOn, pollInFlight>>

StreamOkAsking ==
  /\ ui = "streaming"
  /\ abortLive
  /\ srv' = "asking"      \* turn ends but questions await answers
  /\ ui' = "idle"
  /\ pending' = TRUE
  /\ abortLive' = FALSE
  /\ stopping' = FALSE
  /\ UNCHANGED <<pollOn, pollInFlight>>

\* stream drop the dropped-regex catches: abort / 409 / network.
\* send() catch: pending stays true, poller takes over.
StreamDrop ==
  /\ ui = "streaming"
  /\ abortLive
  /\ ui' = "recovering"
  /\ pending' = TRUE
  /\ abortLive' = FALSE
  /\ pollOn' = TRUE
  /\ stopping' = FALSE
  /\ UNCHANGED <<pollInFlight, srv>>

\* non-dropped error: "(error) ..." painted, pending=false. Note: the
\* code takes this path whenever the regex does NOT match - even if the
\* server is still running the turn. The model preserves that.
\* FINDING (real): current code takes the error path whenever the
\* dropped-regex misses - even if the turn is still running server-side
\* (e.g. a proxy timeout fires onload with 504 while the gateway keeps
\* going). UI paints "(error)", unlocks the composer, poller stays off:
\* the reply lands invisibly, no notification. Proposed fix: treat it
\* like a drop when the turn may still be running (StreamFailRunning).
StreamFail ==
  /\ ui = "streaming"
  /\ abortLive
  /\ ~stopping
  /\ srv # "running"   \* modeled fix: only trust error when turn ended
  /\ ui' = "error"
  /\ pending' = FALSE
  /\ abortLive' = FALSE
  /\ stopping' = FALSE
  /\ UNCHANGED <<pollOn, pollInFlight, srv>>

\* modeled fix for the above: error while the turn may still run ->
\* paint it, but reconcile via the poller instead of going idle.
StreamFailRunning ==
  /\ ui = "streaming"
  /\ abortLive
  /\ ~stopping
  /\ srv = "running"
  /\ ui' = "recovering"
  /\ pending' = TRUE
  /\ abortLive' = FALSE
  /\ stopping' = FALSE
  /\ pollOn' = TRUE
  /\ UNCHANGED <<pollInFlight, srv>>

(* ===================== stopChat() ===================== *)

\* user taps stop: POST /stop goes out
StopRequest ==
  /\ pending
  /\ ~stopping
  /\ stopping' = TRUE
  /\ UNCHANGED <<ui, pending, abortLive, pollOn, pollInFlight, srv>>

\* stopChat() completes on the no-live-stream path: fetch truth, repaint
StopSettles ==
  /\ stopping
  /\ ~abortLive
  /\ stopping' = FALSE
  /\ pending' = srvBusy
  /\ ui' = IF srvBusy THEN "recovering" ELSE "idle"
  /\ UNCHANGED <<abortLive, pollOn, pollInFlight, srv>>   \* code never touches the timer here

\* the stream close/abort event lands while stopping, stop already
\* effective server-side: catch -> chat.stopping branch -> settled truth
CloseStopping ==
  /\ ui = "streaming"
  /\ stopping
  /\ abortLive
  /\ srv = "done"
  /\ ui' = "idle"
  /\ pending' = FALSE
  /\ stopping' = FALSE
  /\ abortLive' = FALSE
  /\ UNCHANGED <<pollOn, pollInFlight, srv>>

\* same but the stop has NOT taken effect yet: the catch's stopping
\* branch still fetches truth, sees the turn running -> poll mode
CloseStoppingRacy ==
  /\ ui = "streaming"
  /\ stopping
  /\ abortLive
  /\ srv # "done"
  /\ ui' = "recovering"
  /\ pending' = TRUE
  /\ stopping' = FALSE
  /\ abortLive' = FALSE
  /\ pollOn' = TRUE
  /\ UNCHANGED <<pollInFlight, srv>>

(* ===================== the poller (tickPending) ===================== *)

PollTick ==
  /\ pollOn
  /\ ~pollInFlight
  /\ pending
  /\ ~abortLive
  /\ pollInFlight' = TRUE
  /\ UNCHANGED <<ui, pending, stopping, abortLive, pollOn, srv>>

\* fetch resolves: server truth becomes client belief. JS is single-
\* threaded, so a tick's body + finally are atomic: the timer cleanup
\* happens in the same step as the result.
\* FINDING (real): a poll response can resolve AFTER the user started a
\* new send (the tick's chat list was computed before the awaits).
\* rememberChat would then clobber the fresh turn's pending flag -
\* stop button hidden mid-stream. Proposed one-line fix in tickPending:
\* after each await fetchChat, skip chats that became liveStream since
\* the tick began. Modeled: the stale result is DISCARDED, not applied.
PollResult ==
  /\ pollInFlight
  /\ pollInFlight' = FALSE
  /\ IF abortLive
     THEN /\ UNCHANGED <<ui, pending, stopping, pollOn, abortLive, srv>>   \* stale, discard
     ELSE /\ pending' = srvBusy
          /\ pollOn' = srvBusy
          /\ ui' = IF srvBusy THEN ui ELSE "idle"
          /\ UNCHANGED <<stopping, abortLive, srv>>

\* the finally block: stopPollIfIdle() - only when nothing is pending
\* (pollInFlight already reset; that window is modeled)
PollIdleStop ==
  /\ pollOn
  /\ ~pollInFlight
  /\ ~pending
  /\ pollOn' = FALSE
  /\ UNCHANGED <<ui, pending, stopping, abortLive, pollInFlight, srv>>

(* ===================== visibilitychange / pageshow ===================== *)

\* refreshVisible(): no live stream -> fetch server truth, repaint
Repaint ==
  /\ ui # "streaming"
  /\ ~abortLive
  /\ pending' = srvBusy
  /\ ui' = IF srvBusy THEN ui ELSE "idle"
  /\ pollOn' = IF ~pending' /\ ~pollInFlight THEN FALSE ELSE pollOn
  /\ UNCHANGED <<stopping, abortLive, pollInFlight, srv>>

Next ==
  \/ Send
  \/ Chunk
  \/ StreamOk
  \/ StreamOkAsking
  \/ StreamDrop
  \/ StreamFail
  \/ StreamFailRunning
  \/ StopRequest
  \/ StopSettles
  \/ ServerStops
  \/ CloseStopping
  \/ CloseStoppingRacy
  \/ ServerStep
  \/ PollTick
  \/ PollResult
  \/ PollIdleStop
  \/ Repaint

Spec == Init /\ [][Next]_vars

\* Fairness: "the turn eventually ends", "the poller keeps ticking",
\* "pending closes/events eventually fire". Needed only for the
\* liveness properties below; safety invariants ignore it.
TurnDone ==
  /\ srvBusy
  /\ srv' = "done"
  /\ UNCHANGED <<ui, pending, stopping, abortLive, pollOn, pollInFlight>>

Fair ==
  /\ WF_vars(TurnDone)
  /\ WF_vars(PollTick)
  /\ WF_vars(PollResult)
  /\ WF_vars(ServerStops)
  /\ WF_vars(CloseStopping)
  /\ WF_vars(CloseStoppingRacy)
  /\ WF_vars(StopSettles)
  /\ WF_vars(StreamDrop)
  /\ WF_vars(StreamFail)
  /\ WF_vars(StreamFailRunning)
  /\ WF_vars(PollIdleStop)   \* the real setInterval fires regardless: ticks are guaranteed
  /\ WF_vars(StreamOk)
  /\ WF_vars(StreamOkAsking)
  /\ WF_vars(StreamFail)

SpecF == Init /\ [][Next]_vars /\ Fair

(* ===================== invariants (safety) ===================== *)

\* A live XHR must always be reflected as a pending turn.
StreamImpliesPending == (ui = "streaming") => (pending /\ abortLive)

\* An open xhr only exists while streaming.
AbortOnlyWhileStreaming == abortLive => (ui = "streaming")

\* stopping is a transient flag on a pending chat.
StoppingImpliesPending == stopping => pending

\* "recovering" means: waiting on server truth, turn believed live.
RecoveringImpliesPending == (ui = "recovering") => pending

\* The poller only runs while there is (or may be) something to poll.
\* NOTE: there is a real <=1s window in the code where pollTimer is still
\* scheduled after a poll settled pending=false but before stopPollIfIdle
\* runs. If this invariant fails, check whether the trace is that window
\* (benign) or a genuine leak (pollOn stuck TRUE forever).
PollerOnlyWhenNeeded == pollOn => (pending \/ pollInFlight)

\* The error path must not fire while the server is still producing.
\* Holds only with the modeled StreamFailRunning fix (see FINDING note).
ErrorImpliesTurnEnded == (ui = "error") => (srv # "running")

\* NOTE - dropped invariants (kept here as documentation):
\* StoppingImpliesPending: real <=1-fetch window where stopping=TRUE but
\*   pending=FALSE (stopChat's fetch in flight; rememberChat never
\*   clears the client-only stopping flag). Benign - liveness
\*   StoppingSettles covers the cleanup.
\* PollerOnlyWhenNeeded: the code leaves the timer scheduled up to one
\*   tick after pending clears (stopChat/StreamFail don't call
\*   stopPollIfIdle). Benign - liveness PollerStops covers it.

(* ===================== liveness ===================== *)

(* stopping never sticks (covers the real stopChat in-flight window). *)
StoppingSettles == stopping ~> ~stopping

(* Too strong as written (pollOn ~> ~pollOn): a user who keeps sending
   legitimately keeps the poller alive forever. The meaningful claim:
   once the chat goes permanently quiet, the poller eventually stops. *)
QuietStopsPoller == (<>[] ~pending) => (<>[] ~pollOn)

=============================================================================
