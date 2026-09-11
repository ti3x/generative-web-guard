import Guard.Core.ListUtil

/-!
List lemmas proved locally so the proofs do not depend on library lemma names
that move between Lean releases.
-/

namespace Guard.Props

open V

theorem mem_of_mem_dropWhile' {p : Char → Bool} {c : Char} :
    ∀ {l : List Char}, c ∈ l.dropWhile p → c ∈ l
  | [], h => by simp [List.dropWhile] at h
  | x :: xs, h => by
    by_cases hp : p x = true
    · simp [List.dropWhile, hp] at h
      exact List.mem_cons_of_mem _ (mem_of_mem_dropWhile' h)
    · simpa [List.dropWhile, hp] using h

theorem mem_of_mem_takeWhile' {p : Char → Bool} {c : Char} :
    ∀ {l : List Char}, c ∈ l.takeWhile p → p c = true
  | [], h => by simp [List.takeWhile] at h
  | x :: xs, h => by
    by_cases hp : p x = true
    · simp [List.takeWhile, hp] at h
      rcases h with rfl | h
      · exact hp
      · exact mem_of_mem_takeWhile' h
    · simp [List.takeWhile, hp] at h

theorem mem_joinSpace {c : Char} :
    ∀ {xs : List (List Char)}, c ∈ joinSpace xs → c = ' ' ∨ ∃ x ∈ xs, c ∈ x
  | [], h => by simp [joinSpace] at h
  | [x], h => by
    simp only [joinSpace] at h
    exact Or.inr ⟨x, by simp, h⟩
  | x :: y :: ys, h => by
    simp only [joinSpace, List.mem_append, List.mem_cons] at h
    rcases h with h | h | h
    · exact Or.inr ⟨x, by simp, h⟩
    · exact Or.inl h
    · rcases mem_joinSpace h with h' | ⟨z, hz, hc⟩
      · exact Or.inl h'
      · exact Or.inr ⟨z, by simp [hz], hc⟩

theorem mem_allSome {α} {y : α} :
    ∀ {xs : List (Option α)} {ys : List α}, allSome xs = some ys → y ∈ ys → some y ∈ xs
  | [], ys, h, hy => by
    simp [allSome] at h; subst h; simp at hy
  | none :: _, _, h, _ => by simp [allSome] at h
  | some x :: rest, ys, h, hy => by
    cases hrest : allSome rest with
    | none => simp [allSome, hrest] at h
    | some zs =>
      simp [allSome, hrest] at h
      subst h
      rcases List.mem_cons.mp hy with rfl | hy'
      · simp
      · exact List.mem_cons_of_mem _ (mem_allSome hrest hy')

end Guard.Props
