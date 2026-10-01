/-! ## Step 2 — the fix the compiler dictated: amounts are nonnegative. -/

def withdraw (balance amount : Int) : Int :=
  if 0 ≤ amount ∧ amount ≤ balance then balance - amount else balance

theorem never_grows (balance amount : Int) :
    withdraw balance amount ≤ balance := by
  unfold withdraw
  split <;> omega

-- Audit trail: no `sorryAx` below means this is a real proof, not a stub.
#print axioms never_grows
