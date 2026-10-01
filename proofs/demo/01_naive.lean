/-! ## Step 1 — the banking guard, as written by everyone. -/

def withdraw (balance amount : Int) : Int :=
  if amount ≤ balance then balance - amount else balance

-- A withdrawal of -50 from a zero balance. Nobody typed a negative test case;
-- the computer just tells us what the code does:
#eval withdraw 0 (-50)   -- expect: 50. Alice just stole money.

-- The property we BELIEVE: a withdrawal never grows your balance.
-- Note: no test values. This is FOR EVERY balance and EVERY amount.
theorem never_grows (balance amount : Int) :
    withdraw balance amount ≤ balance := by
  unfold withdraw
  split <;> omega
