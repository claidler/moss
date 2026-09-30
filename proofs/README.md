# Formal proofs (`lake build`)

Machine-checked invariants for Moss's pure logic, in the spirit of "make the
compiler find the edge case your unit tests assumed away". Same lesson as the
classic negative-transfer bug: a guard that looks obviously right hides a
corner nobody imagined, and a proof assistant enumerates every input instead
of the three you tested.

## Upload containment — `Uploads.lean`

Models `isManagedUploadPath` in `uploads.js`: the guard deciding whether a
client-supplied path may be opened from disk.

| Lean | JS (`uploads.js`) |
|---|---|
| `Path` (segment lists) | absolute paths |
| `normalize` | `path.resolve` (`.`/`..` folding) |
| `IsPrefix managed p` | `abs === UPLOAD_DIR \|\| abs.startsWith(UPLOAD_DIR + path.sep)` |
| `acceptedFixed` | the real guard (resolve, then segment prefix) |
| `acceptedNaive` | the careless guard (prefix-check the raw string) |

Proved:

* `naive_unsound` — `srv/uploads/../.ssh/id_rsa` passes the naive guard but
  escapes the managed dir. This is Lean's "negative fifty": the counterexample
  a human doesn't imagine.
* `fixed_sound` — for **every** path, if the real guard accepts it, its
  resolved form is `managed ++ tail`. The vault property. Because the model
  works on whole segments, this also covers the string-level sibling bug:
  `moss-uploads-evil` fails the prefix check since `"uploads-evil" ≠
  "uploads"` is a segment mismatch — no `startsWith` string artefact can
  hide there.
* `fixed_rejects_sneaky`, `fixed_accepts_upload` — the traversal is rejected
  and normal filenames still pass (the guard isn't vacuous).

Pinned on the JS side by `uploads.test.js` (same counterexamples, so model
and code share one witness).

## Known gaps (what the proof does NOT cover)

* **Symlinks.** `fs.statSync` follows links, so a symlink inside
  `moss-uploads` pointing at `/etc/shadow` is accepted. Lexical containment
  is not physical containment. Fix candidates: `lstat` + `realpath` check,
  or open with `O_NOFOLLOW`.
* **Windows.** The model is POSIX: `..` at root stays at root, one separator
  kind. `path.win32` (drive letters, `\` and `/`) is out of scope — the Pi
  only ever runs the POSIX branch.
* The Lean model mirrors the JS by comments + shared tests, not by extraction.
  If you change `isManagedUploadPath`, re-read this file.

## Building

Lean 4 via elan (`~/.elan/bin` on PATH). Pure core Lean — no Mathlib, so a
cold build is seconds even on a Pi:

```sh
export PATH="$HOME/.elan/bin:$PATH"
cd proofs && lake build
```

A green build also prints the counterexample search and the axiom audit
(`#print axioms`) for each theorem — any `sorryAx` in that list means a
"proof" that isn't one.

CI: add `- run: (cd proofs && lake build)` next to `node --test`.

## Adding a proof

1. Pick a small **pure** function with a guard (history merge, pagination
   cursor clamp, name sanitiser).
2. Model its inputs as inductive/structural data, transcribe the guard,
   write the property you actually believe.
3. Expect the first build to fail — the failed proof *is* the deliverable.
   Turn Lean's counterexample into a `node --test` case in the matching
   `*.test.js` so JS and Lean stay pinned to the same witness.
