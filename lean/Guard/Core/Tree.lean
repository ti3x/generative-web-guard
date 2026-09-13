import Guard.Core.Json
import Guard.Core.Chars

/-!
Tree types shared with `src/tree.js`.

`Raw` is what a parser adapter produces: untrusted, any namespace, any tag.
`Node` is what the policy emits: only `html` or `svg`, attributes as a sorted
list of pairs. A validated document is a `Node` list paired with the fact that
the policy accepts it unchanged (see `Guard.Props`).
-/

namespace Guard

open J

inductive Ns where
  | html
  | svg
deriving Repr, BEq, DecidableEq, Inhabited

def Ns.toString : Ns → String
  | .html => "html"
  | .svg => "svg"

/-- Parser output. Faithful, unfiltered. -/
inductive Raw where
  | text (s : String)
  | el (ns : String) (tag : String) (attrs : List (String × String)) (children : List Raw)
  | other (kind : String)
deriving Repr, Inhabited

/-- Policy output. -/
inductive Node where
  | text (s : String)
  | el (ns : Ns) (tag : String) (attrs : List (String × String)) (children : List Node)
deriving Repr, BEq, Inhabited

mutual
def Node.decEq (x y : Node) : Decidable (x = y) :=
  match x, y with
  | .text a, .text b =>
    match decEq a b with
    | .isTrue h => .isTrue (by cases h; rfl)
    | .isFalse h => .isFalse (by intro e; cases e; exact h rfl)
  | .el n t a cs, .el n' t' a' cs' =>
    match decEq n n', decEq t t', decEq a a', nodesDecEq cs cs' with
    | .isTrue hn, .isTrue ht, .isTrue ha, .isTrue hc => .isTrue (by cases hn; cases ht; cases ha; cases hc; rfl)
    | .isFalse h, _, _, _ => .isFalse (by intro e; cases e; exact h rfl)
    | _, .isFalse h, _, _ => .isFalse (by intro e; cases e; exact h rfl)
    | _, _, .isFalse h, _ => .isFalse (by intro e; cases e; exact h rfl)
    | _, _, _, .isFalse h => .isFalse (by intro e; cases e; exact h rfl)
  | .text _, .el .. => .isFalse (by intro h; cases h)
  | .el .., .text _ => .isFalse (by intro h; cases h)
termination_by sizeOf x + sizeOf y

def nodesDecEq (xs ys : List Node) : Decidable (xs = ys) :=
  match xs, ys with
  | [], [] => .isTrue rfl
  | x :: xs, y :: ys =>
    match Node.decEq x y, nodesDecEq xs ys with
    | .isTrue h, .isTrue hs => .isTrue (by cases h; cases hs; rfl)
    | .isFalse h, _ => .isFalse (by intro e; cases e; exact h rfl)
    | _, .isFalse h => .isFalse (by intro e; cases e; exact h rfl)
  | [], _ :: _ => .isFalse (by intro h; cases h)
  | _ :: _, [] => .isFalse (by intro h; cases h)
termination_by sizeOf xs + sizeOf ys
end

instance : DecidableEq Node := Node.decEq

mutual
def Raw.weight : Raw → Nat
  | .text _ | .other _ => 1
  | .el _ _ _ children => 1 + rawWeight children

def rawWeight : List Raw → Nat
  | [] => 0
  | r :: rs => r.weight + rawWeight rs
end

mutual
def Node.toRaw : Node → Raw
  | .text s => .text s
  | .el ns tag attrs children => .el ns.toString tag attrs (nodesToRaw children)

def nodesToRaw : List Node → List Raw
  | [] => []
  | n :: ns => n.toRaw :: nodesToRaw ns
end

/--
LENIENT decoder. Used only by the batch test interface (`Guard.processRequest`,
native executable) and not by the production ABI.

This is not a strict candidate decoder and must not be described as one. Its
actual behaviour:

* `partial` recursion, so it is not total and nothing is proved about it;
* a missing or non-string `kind` becomes `""`, which falls into the catch-all
  and yields `Raw.other ""`;
* a missing or non-string `text`, `tag` or `ns` silently becomes the
  `getStr` default (`""`, or `"other"` for `ns`);
* an attribute entry that is not a two-element array of strings is silently
  DROPPED by `filterMap`;
* duplicate object keys resolve to the first occurrence (`List.lookup`);
* duplicate attribute names are preserved and left to `checkAttrs`;
* extra object fields are ignored;
* there is no bound on node count, depth, attribute count or string length.

Dropping malformed input is acceptable for a differential-testing tool, whose
job is to feed the two implementations the same parser output. It is not
acceptable for an authority, because "repair silently" and "decide" must not
live in the same function. `Guard.Io.decodeDocument` is the strict, total,
bounded decoder the shipped module uses; every deviation there is an error.
-/
partial def rawFromJson (j : Json) : Raw :=
  match j.getStr "kind" with
  | "text" => .text (j.getStr "text")
  | "el" =>
    let attrs : List (String × String) := (j.getArr "attrs").filterMap fun p =>
      match p with
      | .arr [.str k, .str v] => some (k, v)
      | _ => none
    .el (j.getStr "ns" "other") (j.getStr "tag") attrs ((j.getArr "children").map rawFromJson)
  | k => .other k

def rawRootChildren (j : Json) : List Raw := (j.getArr "children").map rawFromJson

partial def Node.toJson : Node → Json
  | .text s => .obj [("kind", .str "text"), ("text", .str s)]
  | .el ns tag attrs children =>
    .obj
      [ ("kind", .str "el")
      , ("ns", .str ns.toString)
      , ("tag", .str tag)
      , ("attrs", .arr (attrs.map fun (k, v) => .arr [.str k, .str v]))
      , ("children", .arr (children.map Node.toJson)) ]

end Guard
