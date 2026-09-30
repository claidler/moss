/-!
# Upload containment proof (`uploads.js :: isManagedUploadPath`)

A chat client may name an on-disk file and Moss will open it, but only when
`isManagedUploadPath` accepts the path. The bank-transfer lesson applies
verbatim: a guard of the shape "the path starts with the managed directory"
has a `..` hidden inside it exactly like a transfer of −£50 has a negative
number hidden inside it.

Model (see proofs/README.md for the mapping and the known gaps):
* paths are absolute, as segment lists (`/srv/uploads/a.png` = `["srv","uploads","a.png"]`);
* `normalize` is `path.resolve`'s `.` / `..` folding (POSIX: `..` at root stays at root);
* `IsPrefix managed p` is "p is managed extended with some tail" — the
  containment property the JS guard (`abs === DIR || abs.startsWith(DIR + sep)`)
  decides;
* `acceptedNaive` / `acceptedFixed` are the careless guard (prefix-check the
  raw, unresolved path) and the real guard (resolve first, then whole-segment
  prefix).

Results:
* `naive_unsound` — Lean's counterexample: `srv/uploads/../.ssh/id_rsa`
  passes the naive guard but resolves *outside* the managed directory;
* `fixed_rejects_sneaky` — the resolved guard rejects the same path;
* `fixed_sound` — the vault property: whatever the real guard accepts
  provably resolves to `managed ++ tail`, for every path in the universe;
* `fixed_accepts_upload` — ordinary filenames still get through (the guard
  is not vacuous).
-/

namespace Uploads

/-- Absolute paths as segment lists. -/
abbrev Path := List String

/-- The managed upload directory (`UPLOAD_DIR` in uploads.js), generic form. -/
def managed : Path := ["srv", "uploads"]

/-- `pre` is a whole-segment prefix of `p` — "p lives under pre". -/
inductive IsPrefix : Path → Path → Prop where
  | base : IsPrefix [] bs
  | step : a = b → IsPrefix as bs → IsPrefix (a :: as) (b :: bs)

/-- `path.resolve`'s dot-folding, accumulator style. -/
def normGo : Path → Path → Path
  | [], acc => acc.reverse
  | s :: t, acc =>
    if s = "." then normGo t acc
    else if s = ".." then
      match acc with
      | [] => normGo t []
      | _ :: acc' => normGo t acc'
    else normGo t (s :: acc)

/-- `path.resolve`: fold away `.` and `..`. -/
def normalize (p : Path) : Path := normGo p []

/-- The guard uploads.js actually writes: resolve, then whole-segment prefix. -/
def acceptedFixed (p : Path) : Prop := IsPrefix managed (normalize p)

/-- The careless guard: `abs.startsWith(UPLOAD_DIR)` on an unresolved path. -/
def acceptedNaive (p : Path) : Prop := IsPrefix managed p

/-- The vault property: the accepted file really lives under `managed`. -/
def contained (p : Path) : Prop := ∃ tail, normalize p = managed ++ tail

/-! ### IsPrefix means "is an extension of" -/

/-- Every `IsPrefix` witness is a concrete extension. -/
theorem isPrefix_append {as p : Path} (h : IsPrefix as p) : ∃ s, p = as ++ s := by
  cases h with
  | base => exact ⟨p, rfl⟩
  | @step a as b bs e h' =>
    obtain ⟨s, es⟩ := isPrefix_append h'
    subst e
    exact ⟨s, by rw [es, List.cons_append]⟩

/-! ### The counterexample — negative fifty, but for paths -/

/-- `srv/uploads/../.ssh/id_rsa`: starts with the managed dir, resolves out of it. -/
def sneaky : Path := ["srv", "uploads", "..", ".ssh", "id_rsa"]

private theorem sneaky_norm : normalize sneaky = ["srv", ".ssh", "id_rsa"] := by decide

private theorem managed_not_prefix_of_sneaky_norm :
    ¬ IsPrefix managed ["srv", ".ssh", "id_rsa"] := by
  intro h
  have h1 : IsPrefix ["srv", "uploads"] ["srv", ".ssh", "id_rsa"] := h
  cases h1 with
  | @step _ _ _ _ _ h' =>
    cases h' with
    | @step _ _ _ _ e _ => exact absurd e (by decide)

/-- The naive guard is unsound: it accepts a path that escapes. -/
theorem naive_unsound : acceptedNaive sneaky ∧ ¬ contained sneaky := by
  refine ⟨IsPrefix.step rfl (IsPrefix.step rfl IsPrefix.base), ?_⟩
  rintro ⟨tail, h⟩
  have h2 : normalize sneaky = managed ++ tail := h
  rw [sneaky_norm, managed] at h2
  cases tail with
  | nil => exact absurd h2 (by decide)
  | cons t1 _ => simp at h2

/-- The resolved guard rejects the very same path. -/
theorem fixed_rejects_sneaky : ¬ acceptedFixed sneaky := by
  intro h
  have h2 : IsPrefix managed (normalize sneaky) := h
  rw [sneaky_norm] at h2
  exact managed_not_prefix_of_sneaky_norm h2

/-! ### The fixed guard, proved for every path -/

/-- Vault property: the real guard never admits an escaping path. -/
theorem fixed_sound (p : Path) (h : acceptedFixed p) : contained p :=
  isPrefix_append h

private theorem normGo_noDots :
    ∀ (x : Path), (∀ s ∈ x, s ≠ "." ∧ s ≠ "..") → ∀ y, normGo x y = y.reverse ++ x := by
  intro x
  induction x with
  | nil => intro _ y; exact (List.append_nil _).symm
  | cons s t ih =>
    intro h y
    have hs := h s List.mem_cons_self
    have step : normGo (s :: t) y = normGo t (s :: y) := by simp [normGo, hs.1, hs.2]
    rw [step, ih (fun a ha => h a (List.mem_cons_of_mem s ha)) (s :: y)]
    rw [List.reverse_cons, List.append_assoc, List.singleton_append]

private theorem normalize_noDots {p : Path} (h : ∀ s ∈ p, s ≠ "." ∧ s ≠ "..") :
    normalize p = p := normGo_noDots p h []

/-- Non-vacuity: every ordinary filename under the managed dir is accepted. -/
theorem fixed_accepts_upload (name : String) (hdot : name ≠ ".") (hup : name ≠ "..") :
    acceptedFixed (managed ++ [name]) := by
  show IsPrefix managed (normalize (managed ++ [name]))
  rw [normalize_noDots]
  · exact IsPrefix.step rfl (IsPrefix.step rfl IsPrefix.base)
  · intro x hx
    rw [List.mem_append] at hx
    cases hx with
    | inl hm =>
      have hcase : x = "srv" ∨ x = "uploads" := by simpa [managed] using hm
      cases hcase with
      | inl e => subst e; exact ⟨by decide, by decide⟩
      | inr e => subst e; exact ⟨by decide, by decide⟩
    | inr hn =>
      rw [List.mem_singleton] at hn
      subst hn
      exact ⟨hdot, hup⟩

/-! ### Executable counterexample search (runs at build time)

The theorems above are the proof; this block is the *search*: a decidable
shadow of both guards (plain `List.isPrefixOf`, matching the JS `startsWith`
literally) replayed over a candidate corpus, printed by `lake build`. -/

/-- Decidable shadow of the naive guard (raw `startsWith`). -/
def naiveDec (p : Path) : Bool := List.isPrefixOf managed p

/-- Decidable shadow of the real guard (resolve, then `startsWith DIR + sep`). -/
def fixedDec (p : Path) : Bool := List.isPrefixOf managed (normalize p)

def candidates : List Path :=
  [ ["srv", "uploads", "a.png"]
  , ["srv", "uploads", "..", ".ssh", "id_rsa"]
  , ["srv", "uploads", "sub", "..", "b.pdf"]
  , ["etc", "passwd"] ]

-- Paths the naive guard waves through that actually escape:
#eval candidates.filter fun p => naiveDec p && ! (fixedDec p)
-- expected: [["srv", "uploads", "..", ".ssh", "id_rsa"]]

end Uploads

#print axioms Uploads.fixed_sound
#print axioms Uploads.naive_unsound
#print axioms Uploads.fixed_rejects_sneaky
#print axioms Uploads.fixed_accepts_upload
