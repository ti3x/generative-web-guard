import Guard.Props.ListLemmas
import Guard.Validators.Number

/-!
Numbers: every character of a canonical number is a digit, `.` or `-`; a
number list adds only single spaces. Rule: R-VAL-NUMBER.
-/

namespace Guard.Props

open V

theorem mem_dropLeadingZeros {c : Char} {ds : List Char} (hc : c ∈ dropLeadingZeros ds) :
    c = '0' ∨ c ∈ ds := by
  unfold dropLeadingZeros at hc
  generalize hd : ds.dropWhile (· == '0') = r at hc
  cases r with
  | nil => simp at hc; exact Or.inl hc
  | cons x xs =>
    have hc' : c ∈ x :: xs := hc
    rw [← hd] at hc'
    exact Or.inr (mem_of_mem_dropWhile' hc')

theorem dropLeadingZeros_digits (ds : List Char) (h : ∀ c ∈ ds, isDigit c = true) :
    ∀ c ∈ dropLeadingZeros ds, isDigit c = true := by
  intro c hc
  rcases mem_dropLeadingZeros hc with h0 | hm
  · subst h0; decide
  · exact h c hm

theorem dropTrailingZeros_digits (ds : List Char) (h : ∀ c ∈ ds, isDigit c = true) :
    ∀ c ∈ dropTrailingZeros ds, isDigit c = true := by
  intro c hc
  unfold dropTrailingZeros at hc
  rw [List.mem_reverse] at hc
  have hm := mem_of_mem_dropWhile' hc
  rw [List.mem_reverse] at hm
  exact h c hm

theorem splitFrac_digits :
    ∀ {rest fr : List Char}, splitFrac rest = some fr → ∀ c ∈ fr, isDigit c = true
  | [], fr, h => by
    simp [splitFrac] at h; subst h; simp
  | c :: r, fr, h => by
    by_cases hc : (c == '.' && !r.isEmpty && r.all isDigit) = true
    · simp only [splitFrac, hc, ite_true, Option.some.injEq] at h
      subst h
      exact fun d hd => List.all_eq_true.mp ((Bool.and_eq_true _ _).mp hc).2 d hd
    · simp [splitFrac, hc] at h

theorem assembleNumber_ok {neg : Bool} {int frac : List Char}
    (hi : ∀ c ∈ int, isDigit c = true) (hf : ∀ c ∈ frac, isDigit c = true) :
    ∀ c ∈ assembleNumber neg int frac, numberCharOk c = true := by
  intro c hc
  unfold assembleNumber at hc
  rw [List.mem_append, List.mem_append] at hc
  rcases hc with (hc | hc) | hc
  · split at hc
    · simp at hc; subst hc; decide
    · simp at hc
  · simp [numberCharOk, hi c hc]
  · split at hc
    · simp at hc
    · rcases List.mem_cons.mp hc with rfl | hc'
      · decide
      · simp [numberCharOk, hf c hc']

theorem canonicalFromParts_ok {neg : Bool} {intDs fracDs r : List Char}
    (hi : ∀ c ∈ intDs, isDigit c = true) (hf : ∀ c ∈ fracDs, isDigit c = true)
    (h : canonicalFromParts neg intDs fracDs = some r) :
    ∀ c ∈ r, numberCharOk c = true := by
  unfold canonicalFromParts at h
  simp only at h
  split at h
  · simp at h
  · split at h
    · simp at h
    · split at h
      · simp at h
      · split at h
        · simp only [Option.some.injEq] at h; subst h
          intro c hc; simp at hc; subst hc; decide
        · simp only [Option.some.injEq] at h; subst h
          exact assembleNumber_ok (dropLeadingZeros_digits _ hi) (dropTrailingZeros_digits _ hf)

/-- Every character of a canonical number is a digit, `.` or `-`. -/
theorem canonicalNumberChars_ok {cs r : List Char} (h : canonicalNumberChars cs = some r) :
    ∀ c ∈ r, numberCharOk c = true := by
  unfold canonicalNumberChars at h
  simp only at h
  split at h
  · simp at h
  · exact canonicalFromParts_ok (fun c hc => mem_of_mem_takeWhile' hc) (splitFrac_digits (by assumption)) h

def numberListCharOk (c : Char) : Bool := numberCharOk c || c == ' '

/-- Every character of a number list is a digit, `.`, `-` or a single space. -/
theorem numberListChars_ok {max : Nat} {cs r : List Char} (h : numberListChars max cs = some r) :
    ∀ c ∈ r, numberListCharOk c = true := by
  unfold numberListChars at h
  simp only at h
  split at h
  · simp at h
  · cases hall : allSome ((splitRuns true (trimChars cs)).map canonicalNumberChars) with
    | none => simp [hall] at h
    | some nums =>
      simp only [hall, Option.map_some', Option.some.injEq] at h
      subst h
      intro c hc
      rcases mem_joinSpace hc with rfl | ⟨x, hx, hcx⟩
      · decide
      · have hsome := mem_allSome hall hx
        rcases List.mem_map.mp hsome with ⟨src, _, hsrc⟩
        simp [numberListCharOk, canonicalNumberChars_ok hsrc c hcx]

end Guard.Props
