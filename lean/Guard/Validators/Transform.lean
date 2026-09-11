import Guard.Core.Limits
import Guard.Validators.Number

/-!
SVG transform lists: known functions with the right arity of canonical
numbers, total by fuel. Rule: R-VAL-TRANSFORM. Proofs: `Guard.Props.Transform`.
-/

namespace Guard.V

def transformNames : List (String × Nat × Nat) :=
  [("translate", 1, 2), ("scale", 1, 2), ("rotate", 1, 3), ("skewX", 1, 1), ("skewY", 1, 1), ("matrix", 6, 6)]

/-- One `name(args)` group. Returns the canonical group text and the rest of the input. -/
def transformGroup (cs : List Char) : Option (List Char × List Char) :=
  let name := cs.takeWhile isAlpha
  match transformNames.lookup (String.mk name) with
  | none => none
  | some (lo, hi) =>
    match (cs.drop name.length).dropWhile isWs with
    | '(' :: r =>
      let args := r.takeWhile (fun c => c != '(' && c != ')')
      match r.drop args.length with
      | ')' :: rest =>
        match numberListChars 6 args with
        | none => none
        | some nums =>
          let arity := (splitRuns false nums).length
          if arity < lo || arity > hi then none
          else some (name ++ '(' :: nums ++ [')'], rest)
      | _ => none
    | _ => none

/-- Up to `fuel` groups separated by whitespace. Total by fuel (at most 8 groups). -/
def transformParts : Nat → List Char → List (List Char) → Option (List (List Char))
  | 0, cs, acc => if (cs.dropWhile isWs).isEmpty && !acc.isEmpty then some acc.reverse else none
  | fuel + 1, cs, acc =>
    match cs.dropWhile isWs with
    | [] => if acc.isEmpty then none else some acc.reverse
    | cs' =>
      match transformGroup cs' with
      | none => none
      | some (g, rest) => transformParts fuel rest (g :: acc)

def transformChars (cs : List Char) : Option (List Char) :=
  let t := trimChars cs
  if utf16Length (String.mk t) > limits.maxAttrValueLength then none
  else if t.isEmpty then none
  else (transformParts 8 t []).map joinSpace

def transform (v : String) : Option String := (transformChars v.toList).map String.mk

end Guard.V
