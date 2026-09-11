import Guard.Core.ListUtil

/-!
Solid paint values: named colors, hex, rgb()/rgba(). Rule: R-VAL-COLOR.
Proofs: `Guard.Props.Color`.
-/

namespace Guard.V

def namedColors : List String :=
  ["black", "silver", "gray", "grey", "white", "maroon", "red", "purple",
   "fuchsia", "green", "lime", "olive", "yellow", "navy", "blue", "teal",
   "aqua", "orange", "none", "currentcolor", "transparent"]

/-- `rgb(` or `rgba(` with three integer-or-percent parts and optional alpha. -/
def rgbOk (cs : List Char) : Bool :=
  let comp (cs : List Char) : Option (List Char) :=
    let ds := cs.takeWhile isDigit
    if ds.isEmpty || ds.length > 3 then none
    else match cs.drop ds.length with
      | '%' :: r => some r
      | r => some r
  let ws (cs : List Char) := cs.dropWhile isWs
  let alpha (cs : List Char) : Option (List Char) :=
    -- 0 | 1 | 0?\.\d+ | \d{1,3}%
    match cs with
    | '.' :: r => let ds := r.takeWhile isDigit; if ds.isEmpty then none else some (r.drop ds.length)
    | '0' :: '.' :: r => let ds := r.takeWhile isDigit; if ds.isEmpty then none else some (r.drop ds.length)
    | _ =>
      let ds := cs.takeWhile isDigit
      match cs.drop ds.length with
      | '%' :: r => if ds.isEmpty || ds.length > 3 then none else some r
      | r => if ds == ['0'] || ds == ['1'] then some r else none
  let afterName := match cs with
    | 'r' :: 'g' :: 'b' :: 'a' :: '(' :: r => some r
    | 'r' :: 'g' :: 'b' :: '(' :: r => some r
    | _ => none
  let result : Option (List Char) := do
    let r ← afterName
    let r ← comp (ws r)
    let r ← match ws r with | ',' :: r => some r | _ => none
    let r ← comp (ws r)
    let r ← match ws r with | ',' :: r => some r | _ => none
    let r ← comp (ws r)
    let r := ws r
    let r ← match r with
      | ',' :: r => do let r ← alpha (ws r); pure (ws r)
      | r => some r
    match r with
    | [')'] => some []
    | _ => none
  result.isSome

/-- Hex colors keep their original case; named and rgb() forms are lowercased. -/
def colorChars (cs : List Char) : Option (List Char) :=
  let t := trimChars cs
  let lower := t.map lowerChar
  if namedColors.contains (String.mk lower) then
    some (if lower == "currentcolor".toList then "currentColor".toList else lower)
  else
    match t with
    | '#' :: hs =>
      if hs.all isHex && (hs.length == 3 || hs.length == 4 || hs.length == 6 || hs.length == 8) then some ('#' :: hs) else none
    | _ => if rgbOk lower then some lower else none

def color (v : String) : Option String := (colorChars v.toList).map String.mk

end Guard.V
