import Guard.Core.Chars

/-!
List and string helpers used by the validators: trimming, splitting on
whitespace runs, joining with spaces, all-or-nothing option collection and
digit helpers. Written with plain recursion so `Guard.Props` can reason about
them.
-/

namespace Guard.V

def trimChars (cs : List Char) : List Char :=
  ((cs.dropWhile isWs).reverse.dropWhile isWs).reverse

def trim (s : String) : String := String.mk (trimChars s.toList)

def cleanText (s : String) : String :=
  String.mk (s.toList.filter fun c => !(isControl c || isBidi c))

/-- Split on runs of whitespace (and commas when `commas`), dropping empties. -/
def splitRuns (commas : Bool) (cs : List Char) : List (List Char) :=
  let sep (c : Char) := isWs c || (commas && c == ',')
  let rec go (cs : List Char) (cur : List Char) (acc : List (List Char)) : List (List Char) :=
    match cs with
    | [] => (if cur.isEmpty then acc else cur.reverse :: acc).reverse
    | c :: rest =>
      if sep c then go rest [] (if cur.isEmpty then acc else cur.reverse :: acc)
      else go rest (c :: cur) acc
  go cs [] []

/-- Join with single spaces. -/
def joinSpace : List (List Char) → List Char
  | [] => []
  | [x] => x
  | x :: xs => x ++ ' ' :: joinSpace xs

/-- All-or-nothing collection of optional results. -/
def allSome : List (Option α) → Option (List α)
  | [] => some []
  | none :: _ => none
  | some x :: rest => (allSome rest).map (x :: ·)

def dropLeadingZeros (ds : List Char) : List Char :=
  match ds.dropWhile (· == '0') with
  | [] => ['0']
  | r => r

def dropTrailingZeros (ds : List Char) : List Char :=
  (ds.reverse.dropWhile (· == '0')).reverse

/-- Digits to Nat. Assumes all digits. -/
def digitsToNat (ds : List Char) : Nat :=
  ds.foldl (fun n c => n * 10 + (c.toNat - '0'.toNat)) 0

def splitOnChar (cs : List Char) (sep : Char) : List (List Char) :=
  let rec go (cs : List Char) (cur : List Char) (acc : List (List Char)) : List (List Char) :=
    match cs with
    | [] => (cur.reverse :: acc).reverse
    | c :: rest => if c == sep then go rest [] (cur.reverse :: acc) else go rest (c :: cur) acc
  go cs [] []

end Guard.V
