#!/usr/bin/env bash
# Moss Lean demo — run from ~/moss.  export PATH="$HOME/.elan/bin:$PATH" first.
set -u
cd "$(dirname "$0")/.."   # -> ~/moss/proofs
L="export PATH=$HOME/.elan/bin:$PATH"
step() { echo; echo "==== $1 ===="; echo; sleep 1; }

step "STEP 1: the guard everyone writes. Watch the proof FAIL."
echo "--- 01_naive.lean: naive withdraw, #eval, and a theorem we BELIEVE ---"
lake env lean demo/01_naive.lean   # error is the point
echo ">>> Lean printed '50' (Alice stole money) and rejected the proof,"
echo ">>> naming the bug's address: amount <= -1."
read -r -p "press enter to fix it..." _

step "STEP 2: add '0 <= amount'. Same theorem, now GREEN."
lake env lean demo/02_fixed.lean
echo ">>> No error = proved, for EVERY pair of integers. And the axiom"
echo ">>> audit shows no sorry: a fake proof can't pass this build."
read -r -p "press enter for the real-world version..." _

step "STEP 3: the same move on Moss's upload guard (uploads.js)."
lake env lean demo/03_paths.lean
echo ">>> true / [srv,.ssh,id_rsa] / false: the careless guard accepts"
echo ">>> srv/uploads/../.ssh/id_rsa, it resolves OUT of the vault, our"
echo ">>> shipped guard rejects it. The sweep found 6 escapes for the"
echo ">>> naive guard and ZERO leaks for ours - without being told where"
echo ">>> to look."
read -r -p "press enter to pin the proof against the REAL code..." _

step "STEP 4: the proof's counterexample, run against the actual JS."
node --test ../uploads.test.js 2>&1 | tail -8
echo ">>> Same witness, two worlds: Lean proved it of the model, Node"
echo ">>> checks it against the shipping function. Refactor away"
echo ">>> path.resolve and this test goes red."
