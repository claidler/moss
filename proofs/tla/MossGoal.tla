--------------------------- MODULE MossGoal ---------------------------
(***************************************************************************)
(* Model of the Moss goal pill: client chat.goal <-> OpenClaw gateway goal. *)
(*                                                                         *)
(* Real code:                                                              *)
(*   js/goals.js    -- act(): POST /api/chats/:id/goal, sets chat.goal     *)
(*                     from the response; busy flag; errText on failure.   *)
(*                     warmGoals(): GET /api/goals, bulk-refreshes every   *)
(*                     chat's goal; 30s ticker re-renders the pill.        *)
(*   goals.js (srv) -- byChat cache; mutate() -> RPC sessions.goal.update/ *)
(*                     clear -> remember(); allFresh() bulk sessions.list; *)
(*                     scheduleFreshSync (3 attempts, 600ms apart);        *)
(*                     sessions.changed handler trusts goal-bearing        *)
(*                     snapshots on ANY reason, goal:null only on "goal".  *)
(*   OpenClaw       -- the REAL goal state. Moss never touches it except   *)
(*                     via RPC; the agent's own create_goal/update_goal    *)
(*                     tools write it directly. Modeled here as an         *)
(*                     unconstrained oracle: GwStep/GwCreate/GwClear.      *)
(*                                                                         *)
(* The client NEVER talks to OpenClaw directly: pill -> Moss -> RPC -> gw. *)
(* "gw" is the gateway's truth; "cache" is the Moss server's byChat;       *)
(* "shown" is what the pill displays; "dirty" marks shown<>cache (a        *)
(* repaint is due - the 30s ticker / next renderGoalPill guarantees it).   *)
(***************************************************************************)

VARIABLES
  \* ---- gateway (OpenClaw, source of truth) ----
  gw,          \* "none" | "active" | "paused" | "blocked" | "complete" | "cleared"
  gwBudget,    \* token budget present? (create_goal may set one)
  \* ---- Moss server cache (goals.js byChat) ----
  cache,       \* "none" | "active" | "paused" | "blocked" | "complete"
  cacheStale,  \* TRUE if cache may lag a gateway change not yet pushed
  \* ---- client pill (js/goals.js) ----
  shown,       \* what the pill displays
  dirty,       \* shown /= cache -> a repaint is due
  busy,        \* an act() POST is in flight
  syncing      \* a warmGoals()/allFresh fetch is in flight

vars == <<gw, gwBudget, cache, cacheStale, shown, dirty, busy, syncing>>

TypeOK ==
  /\ gw \in {"none", "active", "paused", "blocked", "complete"}
  /\ gwBudget \in {0, 1}            \* coarse: budget set or not
  /\ cache \in {"none", "active", "paused", "blocked", "complete"}
  /\ cacheStale \in BOOLEAN
  /\ shown \in {"none", "active", "paused", "blocked", "complete"}
  /\ dirty \in BOOLEAN
  /\ busy \in BOOLEAN
  /\ syncing \in BOOLEAN

Init ==
  /\ gw = "none"
  /\ gwBudget = 0
  /\ cache = "none"
  /\ cacheStale = FALSE
  /\ shown = "none"
  /\ dirty = FALSE
  /\ busy = FALSE
  /\ syncing = FALSE

(* ===================== gateway side (the oracle) ===================== *)

\* The agent works on the goal on its own schedule. Order not under the
\* client's control - that's the whole point of modeling it freely.
GwStep ==
  /\ gw \in {"active", "paused", "blocked", "complete"}
  /\ gw' \in {"active", "paused", "blocked", "complete"}
  /\ UNCHANGED <<gwBudget, cache, cacheStale, shown, dirty, busy, syncing>>

\* gateway forgets the goal (clear from another origin, session reset).
\* The server cache doesn't change here - it only learns via push/sync,
\* and until then cacheStale marks the possible divergence.
GwClear ==
  /\ gw # "none"
  /\ gw' = "none"
  /\ gwBudget' = 0
  /\ cacheStale' = IF cache # "none" THEN TRUE ELSE FALSE
  /\ UNCHANGED <<cache, shown, dirty, busy, syncing>>

\* a NEW goal appears where there was none (agent's create_goal mid-run -
\* no broadcast at creation, which is why scheduleFreshSync retries).
GwCreate ==
  /\ gw = "none"
  /\ gw' = "active"
  /\ gwBudget' \in {0, 1}
  /\ UNCHANGED <<cache, cacheStale, shown, dirty, busy, syncing>>

(* ===================== push path: sessions.changed ===================== *)

\* goal-bearing snapshot on any reason: trusted, fresh. dirty if the
\* client's shown no longer matches.
PushGoal ==
  /\ gw # "none"
  /\ cache' = gw
  /\ cacheStale' = FALSE
  /\ dirty' = (gw # shown)
  /\ UNCHANGED <<gw, gwBudget, shown, busy, syncing>>

\* reason="goal" with goal:null: trusted erase. Any other reason with a
\* null payload is ignored (a pre-goal snapshot must not erase a goal).
PushNullGoalScoped ==
  /\ gw = "none"
  /\ cache' = "none"
  /\ cacheStale' = FALSE
  /\ dirty' = (shown # "none")
  /\ UNCHANGED <<gw, gwBudget, shown, busy, syncing>>

(* ===================== client act(): POST /goal {action} ============== *)

ActStart ==
  /\ ~busy
  /\ busy' = TRUE
  /\ UNCHANGED <<gw, gwBudget, cache, cacheStale, shown, dirty, syncing>>

\* RPC succeeds: chat.goal is set FROM THE RESPONSE (write-then-read),
\* so shown and cache move together - no divergence window.
ActOk ==
  /\ busy
  /\ gw # "none"
  /\ cache' = gw
  /\ cacheStale' = FALSE
  /\ shown' = gw
  /\ dirty' = FALSE
  /\ busy' = FALSE
  /\ UNCHANGED <<gw, gwBudget, syncing>>

\* RPC fails (gateway down, timeout): errText shown, chat.goal untouched -
\* the pill keeps the last known goal; no false erase, no stuck busy.
ActFail ==
  /\ busy
  /\ busy' = FALSE
  /\ dirty' = dirty
  /\ UNCHANGED <<gw, gwBudget, cache, cacheStale, shown, syncing>>

(* ===================== pull path: warmGoals / allFresh ================ *)

SyncStart ==
  /\ ~syncing
  /\ syncing' = TRUE
  /\ UNCHANGED <<gw, gwBudget, cache, cacheStale, shown, dirty, busy>>

\* bulk fetch resolves with the gateway truth; if the pill's shown no
\* longer matches, the 30s ticker/next render owes a repaint (dirty).
SyncResult ==
  /\ syncing
  /\ syncing' = FALSE
  /\ cache' = gw
  /\ cacheStale' = FALSE
  /\ dirty' = (gw # shown)
  /\ UNCHANGED <<gw, gwBudget, shown, busy>>

(* ===================== client repaint (30s ticker / render) =========== *)

Repaint ==
  /\ shown' = cache
  /\ dirty' = FALSE
  /\ UNCHANGED <<gw, gwBudget, cache, cacheStale, busy, syncing>>

Next ==
  \/ GwStep
  \/ GwClear
  \/ GwCreate
  \/ PushGoal
  \/ PushNullGoalScoped
  \/ ActStart
  \/ ActOk
  \/ ActFail
  \/ SyncStart
  \/ SyncResult
  \/ Repaint

Spec == Init /\ [][Next]_vars

Fair ==
  /\ WF_vars(ActOk)
  /\ WF_vars(ActFail)
  /\ WF_vars(SyncStart)      \* warmGoals fires on visibilitychange/ticker
  /\ WF_vars(SyncResult)
  /\ WF_vars(Repaint)

SpecF == Spec /\ Fair

(* ===================== invariants (safety) ===================== *)

\* The pill never claims a goal state the server cache doesn't back,
\* unless a correction is already in flight or due (dirty).
ShownSound ==
  /\ (shown # "none" /\ gw = "none") =>
       (cache # "none" \/ dirty \/ busy \/ syncing)
  /\ (shown = "none" /\ gw # "none") =>
       (cache = "none" \/ dirty \/ busy \/ syncing)

\* The server cache never invents a goal the gateway doesn't have,
\* outside the marked stale window.
CacheSound == (cache # "none") => (gw # "none" \/ cacheStale)

\* dirty is exact: it is TRUE iff shown and cache disagree.
DirtyExact == dirty <=> (shown # cache)

\* a goal visible on the pill is backed by the gateway OR flagged stale
ShownBacked ==
  (shown # "none") => (gw # "none" \/ cacheStale \/ busy \/ dirty)

(* ===================== liveness ===================== *)

\* act() never leaves busy stuck.
BusySettles == busy ~> ~busy

\* A phantom goal (pill shows one, gateway+cache say none) is always
\* marked as needing correction - follows from DirtyExact, kept as
\* documentation of the intent.
PhantomMarked ==
  (shown # "none" /\ cache = "none") => dirty

\* The pill never stays stale forever: any shown/cache divergence is
\* cleared by a fair repaint (the 30s ticker guarantees these fire).
StaleViewHeals == dirty ~> ~dirty

\* If the gateway settles forever with a goal, the pill eventually
\* shows it (push or sync lands, then repaint).
GoalEventuallyShown ==
  (<>[] (gw # "none" /\ gw # "cleared")) => (<> (shown # "none"))

=============================================================================
