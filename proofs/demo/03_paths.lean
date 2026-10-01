/-! ## Step 3 — same trick on the real Moss guard (uploads.js).
Paths as segment lists; `normalize` = what path.resolve does. -/

def Path := List String
def managed : Path := ["srv", "uploads"]

def normGo : Path -> Path -> Path
  | [], acc => acc.reverse
  | s :: t, acc =>
    if s = "." then normGo t acc
    else if s = ".." then match acc with
      | [] => normGo t []
      | _ :: acc' => normGo t acc'
    else normGo t (s :: acc)

def normalize (p : Path) : Path := normGo p []

/-- The careless guard: raw startsWith(UPLOAD_DIR). -/
def naiveOK (p : Path) : Bool := List.isPrefixOf managed p

/-- The real guard: resolve FIRST, then prefix. -/
def realOK (p : Path) : Bool := List.isPrefixOf managed (normalize p)

/-- The path no unit test thinks of: traversal BURIED MID-PATH. -/
def sneaky : Path := ["srv", "uploads", "..", ".ssh", "id_rsa"]

#eval naiveOK sneaky        -- expect true: the careless guard waves it through
#eval normalize sneaky      -- expect ["srv", ".ssh", "id_rsa"]: OUTSIDE the vault
#eval realOK sneaky         -- expect false: the shipped guard rejects it

-- And we didn't need to pick this witness by hand. Sweep EVERY path of
-- length <= 4 over a small alphabet; the escapes find themselves:
def segs : List String := ["srv", "uploads", "..", ".", "a", "etc"]
def allLists : Nat -> List Path
  | 0 => [[]]
  | n+1 => (allLists n).flatMap fun t => segs.map fun s => s :: t
def slice : List Path := allLists 4   -- 1296 paths

#eval (slice.filter fun p => naiveOK p && ! realOK p).length
-- expect 6 escapes, all shaped srv/uploads/.. + anything

#eval (slice.filter fun p => realOK p && ! List.isPrefixOf managed (normalize p)).length
-- expect 0: the real guard never leaks, across the whole slice
