--------------------------- MODULE MossStatusOld ---------------------------
(***************************************************************************)
(* Model of the Moss header status dot (js/chats.js setStatus/checkGateway *)
(* + app.js timers). The dot claims to describe TWO things:                 *)
(*   1. Moss itself      - answered by /api/config (served by Moss)         *)
(*   2. The model path   - answered by /v1/models (proxied to OpenClaw)     *)
(* The user's complaint: "red but the thing is online" - the OLD code       *)
(* probed /v1/models ONCE at boot and never again, so one slow/failed      *)
(* boot probe painted the dot red until the next full page reload. It also *)
(* never checked Moss separately, so "red" was ambiguous: server? model?    *)
(* both? The FIX probes both, re-probes every 30s while visible, on        *)
(* visibilitychange, pageshow(persisted) and window online, with a         *)
(* checking-guard against overlapping probes and a 10s abort timeout.      *)
(*                                                                         *)
(* JS is single-threaded: the fetches, the result inspection and the paint  *)
(* are one atomic step (ProbeDone) - no other client code can interleave.   *)
(***************************************************************************)

EXTENDS Naturals

VARIABLES
  \* ---- the world (environment, not under the client's control) ----
  visible,     \* app in foreground (phone screen on, TWA open)
  mossUp,      \* would a probe of /api/config succeed right now?
  modelUp,     \* would a probe of /v1/models succeed right now?
  \* ---- the client (js/chats.js) ----
  mossSeen,    \* result of the last COMPLETED Moss probe
  modelSeen,   \* result of the last COMPLETED model probe
  shown,       \* "boot" (grey, unchecked) | "ready" (green) | "bad" (red)
  checking,    \* a probe pair is in flight (gwChecking guard)
  due          \* a scheduled re-probe is pending (30s tick / visibility /
               \* pageshow / online fired)

vars == <<visible, mossUp, modelUp, mossSeen, modelSeen, shown, checking, due>>

TypeOK ==
  /\ visible \in BOOLEAN
  /\ mossUp \in BOOLEAN
  /\ modelUp \in BOOLEAN
  /\ mossSeen \in BOOLEAN
  /\ modelSeen \in BOOLEAN
  /\ shown \in {"boot", "ready", "bad"}
  /\ checking \in BOOLEAN
  /\ due \in BOOLEAN

Init ==
  /\ visible = TRUE
  /\ mossUp = TRUE          \* the world starts healthy; env may break it
  /\ modelUp = TRUE
  /\ mossSeen = FALSE       \* nothing probed yet
  /\ modelSeen = FALSE
  /\ shown = "boot"
  /\ checking = FALSE
  /\ due = FALSE

(* ===================== environment ===================== *)

\*\* the world moves on its own: either endpoint may flap at any time
WorldFlap ==
  /\ mossUp' \in BOOLEAN
  /\ modelUp' \in BOOLEAN
  /\ UNCHANGED <<visible, mossSeen, modelSeen, shown, checking, due>>

\* phone screen off/on, app backgrounded/foregrounded
Hide == visible /\ visible' = FALSE /\ UNCHANGED vars
Show == /\ ~visible
        /\ visible' = TRUE
        /\ due' = TRUE          \* the visibilitychange listener
        /\ UNCHANGED <<mossUp, modelUp, mossSeen, modelSeen, shown, checking>>

(* ===================== the probe (checkGateway) ===================== *)

\* fired when due (or on boot): checking-guard prevents overlap
ProbeStart ==
  /\ ~checking
  /\ due
  /\ visible                  \* js/app.js: only probes while visible
  /\ checking' = TRUE
  /\ due' = FALSE
  /\ UNCHANGED <<visible, mossUp, modelUp, mossSeen, modelSeen, shown>>

\* both fetches settle (10s abort caps them) and the dot is painted in the
\* same step: mossSeen/modelSeen record what the world actually did,
\* shown reflects it. OLD DESIGN: no 30s interval and no listeners, so
\* after the boot probe fires, ProbeStart is never enabled again.
ProbeDone ==
  /\ checking
  /\ mossSeen' = mossUp
  /\ modelSeen' = modelUp
  /\ shown' = IF mossUp /\ modelUp THEN "ready" ELSE "bad"
  /\ checking' = FALSE
  /\ UNCHANGED <<visible, mossUp, modelUp, due>>

\* FINDING (the old bug, kept as documentation): the pre-fix code ran
\* checkGateway() exactly once at boot. In this spec, delete TickDue's
\* reachability (no 30s interval, no visibilitychange/online listeners):
\* then after a boot-time ProbeDone with a flap, no ProbeStart is ever
\* enabled again, shown sticks at "bad" while mossUp/modelUp recover.
\* RedHeals below is exactly the property that fails, and the 30s
\* self-heal loop is exactly what restores it.

Next ==
  \/ WorldFlap
  \/ Hide
  \/ Show
  \/ ProbeStart
  \/ ProbeDone

Fair ==
  /\ WF_vars(ProbeStart)     \* a due probe is always eventually sent
  /\ WF_vars(ProbeDone)      \* fetches settle: abort() caps them at 10s

Spec == Init /\ [][Next]_vars /\ Fair

(* ===================== invariants (safety) ===================== *)

\* Green is never a lie: the dot only says ready when the last completed
\* probe of BOTH endpoints succeeded.
GreenMeansBoth ==
  (shown = "ready") => (mossSeen /\ modelSeen)

\* Red is never a guess: it always records an observed failure, never
\* "unchecked". (The boot state is grey - a third, honest state.)
RedIsObserved ==
  (shown = "bad") => (~mossSeen \/ ~modelSeen)

\* What the dot shows is exactly the last probe; nothing else may move it.
ShownBacked ==
  \/ shown = "boot"
  \/ shown = IF mossSeen /\ modelSeen THEN "ready" ELSE "bad"

\* at most one probe in flight: ProbeStart requires ~checking, and only
\* ProbeDone clears it. (due may be TRUE while checking - a probe started
\* mid-interval is fine; the next one just waits. That's why there is no
\* "checking => ~due" invariant: visibilitychange mid-probe is legitimate.)

(* ===================== liveness ===================== *)

\* A probe always settles - the 10s AbortController caps both fetches.
ProbeSettles == checking ~> ~checking

\* THE PAYOFF: if the app stays open (visible) and both endpoints stay up
\* from some point on, the dot eventually settles green. The old boot-only
\* design violates this: one failed boot probe and the dot is red forever
\* even with everything healthy. The 30s re-probe loop is the fix.
RedHeals ==
  ( <>[] visible /\ <>[] (mossUp /\ modelUp) ) => ( <>[] (shown = "ready") )

\* The dot is never stuck grey: a first probe always happens.
EventuallyProbed == <> (shown # "boot")

=============================================================================
