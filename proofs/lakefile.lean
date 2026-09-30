import Lake
open Lake DSL

package moss_proofs where
  -- Pure core Lean; no Mathlib. `lake build` takes seconds on the Pi.

@[default_target]
lean_lib Uploads
