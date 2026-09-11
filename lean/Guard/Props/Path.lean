import Guard.Props.Number
import Guard.Validators.Path

/-!
Path data: every emitted character is a command letter, a digit, `.`, `-` or
a space. Rule: R-VAL-PATH.
-/

namespace Guard.Props

open V

def tokOk (t : List Char) : Prop := ∀ c ∈ t, pathCharOk c = true

theorem pathTokens_ok : ∀ (fuel : Nat) (cs : List Char) (count : Nat) (acc out : List (List Char)),
    pathTokens fuel cs count acc = some out → (∀ t ∈ acc, tokOk t) → ∀ t ∈ out, tokOk t
  | _, [], _, acc, out, h, hacc => by
    simp only [pathTokens, Option.some.injEq] at h
    subst h
    intro t ht
    exact hacc t (List.mem_reverse.mp ht)
  | 0, _ :: _, _, _, _, h, _ => by simp [pathTokens] at h
  | fuel + 1, c :: rest, count, acc, out, h, hacc => by
    simp only [pathTokens] at h
    split at h
    · exact pathTokens_ok fuel rest count acc out h hacc
    · split at h
      · refine pathTokens_ok fuel rest count ([c] :: acc) out h ?_
        intro t ht
        rcases List.mem_cons.mp ht with rfl | ht'
        · intro d hd
          simp at hd; subst hd
          simp_all [pathCharOk]
        · exact hacc t ht'
      · split at h
        · simp at h
        · split at h
          · simp at h
          · split at h
            · simp at h
            · refine pathTokens_ok fuel _ (count + 1) (_ :: acc) out h ?_
              intro t ht
              rcases List.mem_cons.mp ht with rfl | ht'
              · intro d hd
                have hok := canonicalNumberChars_ok (by assumption) d hd
                simp [pathCharOk, hok]
              · exact hacc t ht'

/-- Every character of emitted path data is a command letter, a digit, `.`, `-` or a space. -/
theorem pathDataChars_ok {cs r : List Char} (h : pathDataChars cs = some r) :
    ∀ c ∈ r, pathCharOk c = true ∨ c = ' ' := by
  unfold pathDataChars at h
  simp only at h
  split at h
  · simp at h
  · split at h
    · simp at h
    · simp at h
    · split at h
      · simp only [Option.some.injEq] at h; subst h
        intro c hc
        rcases mem_joinSpace hc with rfl | ⟨x, hx, hcx⟩
        · exact Or.inr rfl
        · exact Or.inl (pathTokens_ok _ _ _ _ _ (by assumption) (by simp) x hx c hcx)
      · simp at h

end Guard.Props
