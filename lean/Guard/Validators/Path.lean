import Guard.Core.Limits
import Guard.Validators.Number

/-!
SVG path data: strict tokenizer over commands and canonical numbers, total by
fuel. Rule: R-VAL-PATH. Proofs: `Guard.Props.Path`.
-/

namespace Guard.V

def pathCommands : List Char := "MmZzLlHhVvCcSsQqTtAa".toList

def pathCharOk (c : Char) : Bool := pathCommands.contains c || numberCharOk c

/-- Greedy number token: `-? (digits+ .? digits* | . digits+)`. Returns token and rest. -/
def takeNumberToken (cs : List Char) : Option (List Char × List Char) :=
  let p := splitSign cs
  let sign := if p.1 then ['-'] else []
  let r := p.2
  let ds := r.takeWhile isDigit
  if ds.isEmpty then
    match r with
    | '.' :: r2 =>
      let fs := r2.takeWhile isDigit
      if fs.isEmpty then none else some (sign ++ '.' :: fs, r2.drop fs.length)
    | _ => none
  else
    match r.drop ds.length with
    | '.' :: r2 =>
      let fs := r2.takeWhile isDigit
      some (sign ++ ds ++ '.' :: fs, r2.drop fs.length)
    | r2 => some (sign ++ ds, r2)

/--
Strict path tokenizer: commands, numbers, whitespace and commas only.
Total by fuel: every step consumes at least one character, and `fuel` starts
at the input length, so running out of fuel cannot happen on real input and
is treated as rejection.
-/
def pathTokens : Nat → List Char → Nat → List (List Char) → Option (List (List Char))
  | _, [], _, acc => some acc.reverse
  | 0, _ :: _, _, _ => none
  | fuel + 1, c :: rest, count, acc =>
    if isWs c || c == ',' then pathTokens fuel rest count acc
    else if pathCommands.contains c then pathTokens fuel rest count ([c] :: acc)
    else
      match takeNumberToken (c :: rest) with
      | none => none
      | some (tok, rest') =>
        if count + 1 > limits.maxPathNumbers then none
        else match canonicalNumberChars tok with
          | none => none
          | some n => pathTokens fuel rest' (count + 1) (n :: acc)

def pathDataChars (cs : List Char) : Option (List Char) :=
  let t := trimChars cs
  if utf16Length (String.mk t) > limits.maxAttrValueLength * 10 then none
  else
    match pathTokens t.length t 0 [] with
    | none => none
    | some [] => none
    | some (tok :: toks) => if tok == ['M'] || tok == ['m'] then some (joinSpace (tok :: toks)) else none

def pathData (v : String) : Option String := (pathDataChars v.toList).map String.mk

end Guard.V
