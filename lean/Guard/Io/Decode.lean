import Guard.Core.Json
import Guard.Core.Tree
import Guard.Core.Chars

/-!
# Strict decoder for the single-document ABI

This is the decoder the production ABI (`Guard.Io.Abi`) uses. It is
deliberately NOT `Guard.rawFromJson`, and the difference matters:

| | `rawFromJson` (`Core/Tree.lean`) | `decodeDocument` (here) |
|---|---|---|
| totality | `partial def` | total: recursion on a `Nat` fuel |
| unknown `kind` | becomes `Raw.other kind` | error `unknown-node-kind` |
| missing `kind`/`tag`/`text` | silently `""` via `getStr` default | error `missing-field` |
| wrong field type | silently the default | error `field-not-string` |
| extra field | ignored | error `unknown-field` |
| duplicate object key | first wins silently | error `duplicate-field` |
| malformed attribute entry | dropped from the list | error `attr-not-string-pair` |
| duplicate attribute name | kept twice | error `duplicate-attribute` |
| size/depth | unbounded | every bound below is checked |

`rawFromJson` remains in use by the batch test interface, where dropping
malformed input is acceptable because that interface is a differential-testing
tool and not an authority. Nothing in this module repairs its input: every
deviation from the contract is an error, so a malformed candidate can only ever
produce a refusal, never a silently different document.

## What this decoder does NOT do

The raw reference decoder does not reject on *content*. A NUL, a bidi override, a lone-surrogate
replacement character or a supplementary-plane character in a name, an
attribute value or a text node is transported faithfully to `checkTree`, which
decides in reference tests. Production uses `decodeCandidateDocument` and
`acceptCandidate`: content is preserved by decoding and rejected if noncanonical.
Making the decoder reject content would move
policy decisions out of the checked checker and would make it disagree with
`src/policy.js`. The bounds below are *resource* bounds and mirror
`PREPROCESS_LIMITS` in `src/policy-protocol.js` exactly, so the decoder cannot
refuse a document that the JavaScript frontend already accepted. The glue
asserts that correspondence at startup from `guard_abi_info`.

Units follow `src/policy-protocol.js`: `*CodeUnits` are UTF-16 code units
(`utf16Length`), so a supplementary character counts as 2 on both sides.
-/

namespace Guard.Io

open Guard J

/-- Resource bounds compiled into the built instance. Not settable by a
request: a request that carries a `limits` field is rejected as an unknown
field. These mirror `PREPROCESS_LIMITS` in `src/policy-protocol.js`. -/
structure AbiLimits where
  maxRawNodes : Nat
  maxRawDepth : Nat
  maxRawAttrsPerElement : Nat
  maxRawNameCodeUnits : Nat
  maxRawTextCodeUnits : Nat
  maxRawTotalTextCodeUnits : Nat
  maxClasses : Nat
  maxClassCodeUnits : Nat
  maxRequestIdCodeUnits : Nat
  maxStylesheetHashCodeUnits : Nat
deriving Repr

def abiLimits : AbiLimits :=
  { maxRawNodes := 6000
  , maxRawDepth := 192
  , maxRawAttrsPerElement := 256
  , maxRawNameCodeUnits := 128
  , maxRawTextCodeUnits := 200000
  , maxRawTotalTextCodeUnits := 1000000
  , maxClasses := 512
  , maxClassCodeUnits := 128
  , maxRequestIdCodeUnits := 128
  , maxStylesheetHashCodeUnits := 128 }

/-- Accounting carried across the whole document, not per subtree. -/
structure DecSt where
  nodes : Nat := 0
  totalText : Nat := 0
deriving Repr

/-- True when a key list repeats any key. Lists here are at most five long. -/
def hasDuplicate : List String → Bool
  | [] => false
  | k :: ks => ks.contains k || hasDuplicate ks

/-- Require a JSON object with unique keys drawn from `allowed`. -/
def strictObject (allowed : List String) (j : Json) : Except String (List (String × Json)) :=
  match j with
  | .obj kvs =>
    let keys := kvs.map Prod.fst
    if hasDuplicate keys then .error "duplicate-field"
    else match keys.find? (fun k => !allowed.contains k) with
      | some k => .error s!"unknown-field:{k}"
      | none => .ok kvs
  | _ => .error "not-an-object"

def requireStr (kvs : List (String × Json)) (key : String) : Except String String :=
  match kvs.lookup key with
  | some (.str s) => .ok s
  | some _ => .error s!"field-not-string:{key}"
  | none => .error s!"missing-field:{key}"

def requireArr (kvs : List (String × Json)) (key : String) : Except String (List Json) :=
  match kvs.lookup key with
  | some (.arr xs) => .ok xs
  | some _ => .error s!"field-not-array:{key}"
  | none => .error s!"missing-field:{key}"

/-- A JSON number written as an exact non-negative decimal integer. The JSON
reader keeps numbers as source text, so this is a string check and never
touches a float. -/
def requireNat (kvs : List (String × Json)) (key : String) : Except String Nat :=
  match kvs.lookup key with
  | some (.num raw) =>
    if raw.isEmpty || !raw.all (fun c => c ≥ '0' && c ≤ '9') then .error s!"field-not-nat:{key}"
    else .ok (raw.foldl (fun n c => n * 10 + (c.toNat - 48)) 0)
  | some _ => .error s!"field-not-number:{key}"
  | none => .error s!"missing-field:{key}"

/-- One attribute: exactly a two-element array of two strings. -/
def decodeAttr (lim : AbiLimits) (j : Json) : Except String (String × String) :=
  match j with
  | .arr [.str k, .str v] =>
    if k.isEmpty then .error "attr-name-empty"
    else if utf16Length k > lim.maxRawNameCodeUnits then .error "attr-name-too-long"
    else .ok (k, v)
  | .arr _ => .error "attr-not-string-pair"
  | _ => .error "attr-not-array"

def decodeAttrs (lim : AbiLimits) (xs : List Json) : Except String (List (String × String)) := do
  if xs.length > lim.maxRawAttrsPerElement then throw "raw-attrs-exceeded"
  let mut out : List (String × String) := []
  let mut names : List String := []
  for x in xs do
    let (k, v) ← decodeAttr lim x
    if names.contains k then throw s!"duplicate-attribute:{k}"
    names := k :: names
    out := (k, v) :: out
  return out.reverse

/-- The kinds a raw node may declare. `comment`, `doctype` and `unknown` are
what `src/adapters/parse5.js` emits for non-element, non-text nodes; they
become `Raw.other` and the checker discards them, but they are decoded
explicitly rather than by falling through a default. -/
private def otherKinds : List String := ["comment", "doctype", "unknown"]

/--
Decode a list of raw child nodes. Total: `fuel` bounds nesting and strictly
decreases on every descent, so this needs no `partial` and no
`decreasing_by`. Exhausting it is `raw-depth-exceeded`, the same code the
JavaScript frontend uses for the same condition.
-/
def decodeRawList (lim : AbiLimits) (fuel : Nat) (js : List Json) (st : DecSt) :
    Except String (List Raw × DecSt) :=
  match fuel with
  | 0 => .error "raw-depth-exceeded"
  | fuel + 1 => do
    let mut out : List Raw := []
    let mut s := st
    for j in js do
      s := { s with nodes := s.nodes + 1 }
      if s.nodes > lim.maxRawNodes then throw "raw-nodes-exceeded"
      -- `kind` decides the exact permitted field set, so read it from a
      -- minimally-constrained object first and then re-check the field set.
      let kind ←
        match j with
        | .obj kvs =>
          if hasDuplicate (kvs.map Prod.fst) then throw "duplicate-field"
          else match kvs.lookup "kind" with
            | some (.str k) => pure k
            | some _ => throw "field-not-string:kind"
            | none => throw "missing-field:kind"
        | _ => throw "not-an-object"
      if kind == "text" then
        let kvs ← strictObject ["kind", "text"] j
        let text ← requireStr kvs "text"
        let len := utf16Length text
        if len > lim.maxRawTextCodeUnits then throw "raw-text-exceeded"
        s := { s with totalText := s.totalText + len }
        if s.totalText > lim.maxRawTotalTextCodeUnits then throw "raw-total-text-exceeded"
        out := .text text :: out
      else if kind == "el" then
        let kvs ← strictObject ["kind", "ns", "tag", "attrs", "children"] j
        let ns ← requireStr kvs "ns"
        let tag ← requireStr kvs "tag"
        if tag.isEmpty then throw "tag-empty"
        if utf16Length tag > lim.maxRawNameCodeUnits then throw "raw-name-too-long"
        if utf16Length ns > lim.maxRawNameCodeUnits then throw "raw-name-too-long"
        let attrs ← decodeAttrs lim (← requireArr kvs "attrs")
        let (kids, s') ← decodeRawList lim fuel (← requireArr kvs "children") s
        s := s'
        out := .el ns tag attrs kids :: out
      else if otherKinds.contains kind then
        let kvs ← strictObject ["kind"] j
        let _ ← requireStr kvs "kind"
        out := .other kind :: out
      else
        throw s!"unknown-node-kind:{kind}"
    return (out.reverse, s)

/--
Decode a whole document: exactly `{ "kind": "root", "children": [...] }`.

A `root` nested inside another node is an `unknown-node-kind` error, so the
root marker cannot appear twice and a child list cannot smuggle one in.
-/
def decodeDocument (lim : AbiLimits) (j : Json) : Except String (List Raw) := do
  let kvs ← strictObject ["kind", "children"] j
  let kind ← requireStr kvs "kind"
  if kind != "root" then throw s!"document-kind:{kind}"
  let children ← requireArr kvs "children"
  -- One unit of fuel per permitted level, plus one for the root itself.
  let (raws, _) ← decodeRawList lim (lim.maxRawDepth + 1) children {}
  return raws

/-- `Raw` back to JSON, for round-trip tests. Mirrors the shape
`src/adapters/parse5.js` emits and `decodeDocument` accepts. -/
partial def rawToJson : Raw → Json
  | .text s => .obj [("kind", .str "text"), ("text", .str s)]
  | .other k => .obj [("kind", .str k)]
  | .el ns tag attrs children =>
    .obj
      [ ("kind", .str "el")
      , ("ns", .str ns)
      , ("tag", .str tag)
      , ("attrs", .arr (attrs.map fun (k, v) => .arr [.str k, .str v]))
      , ("children", .arr (children.map rawToJson)) ]

def documentToJson (raws : List Raw) : Json :=
  .obj [("kind", .str "root"), ("children", .arr (raws.map rawToJson))]

/-- Production candidate decoding constructs `Node` directly. No raw-tree
normalization, namespace coercion, dropped nodes, or repaired fields. -/
def decodeCandidateList (lim : AbiLimits) (fuel : Nat) (js : List Json) (st : DecSt) :
    Except String (List Node × DecSt) :=
  match fuel with
  | 0 => .error "raw-depth-exceeded"
  | fuel + 1 => do
    let mut out : List Node := []
    let mut s := st
    for j in js do
      s := { s with nodes := s.nodes + 1 }
      if s.nodes > lim.maxRawNodes then throw "raw-nodes-exceeded"
      let kvs ← strictObject ["kind", "text", "ns", "tag", "attrs", "children"] j
      let kind ← requireStr kvs "kind"
      if kind == "text" then
        let fields ← strictObject ["kind", "text"] j
        let text ← requireStr fields "text"
        let len := utf16Length text
        if len > lim.maxRawTextCodeUnits then throw "raw-text-exceeded"
        s := { s with totalText := s.totalText + len }
        if s.totalText > lim.maxRawTotalTextCodeUnits then throw "raw-total-text-exceeded"
        out := .text text :: out
      else if kind == "el" then
        let fields ← strictObject ["kind", "ns", "tag", "attrs", "children"] j
        let nsString ← requireStr fields "ns"
        let ns ← if nsString == "html" then pure Ns.html
          else if nsString == "svg" then pure Ns.svg else throw "unknown-namespace"
        let tag ← requireStr fields "tag"
        if tag.isEmpty then throw "tag-empty"
        if utf16Length tag > lim.maxRawNameCodeUnits then throw "raw-name-too-long"
        let attrs ← decodeAttrs lim (← requireArr fields "attrs")
        let (kids, next) ← decodeCandidateList lim fuel (← requireArr fields "children") s
        s := next
        out := .el ns tag attrs kids :: out
      else throw "unknown-node-kind"
    return (out.reverse, s)

def decodeCandidateDocument (lim : AbiLimits) (j : Json) : Except String (List Node) := do
  let fields ← strictObject ["kind", "children"] j
  if (← requireStr fields "kind") != "root" then throw "document-kind"
  let (tree, _) ← decodeCandidateList lim (lim.maxRawDepth + 1) (← requireArr fields "children") {}
  return tree

end Guard.Io
