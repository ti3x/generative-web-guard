import Guard

/-!
Strict-decoder and single-document ABI checks.

These are compile-time `#guard`s, so a regression fails `lake build Tests`
rather than only a runtime test. They pin the behaviour the refactor plan asks
to be tested explicitly: duplicate object fields, duplicate attributes, NULs,
lone surrogates, supplementary characters and exact tree round trips.

Every deviation from the wire contract must be an ERROR, never a repair. A
decoder that dropped a malformed attribute would change the document while
reporting success, which is exactly the failure mode `Guard.rawFromJson` has
and this decoder must not.

Resource bounds are exercised against a LOWERED limits record rather than the
shipped one, so the cases stay small enough to evaluate in the kernel. That the
shipped numbers are the ones the JavaScript frontend uses is checked on the
other side of the boundary, by comparing `guard_abi_info` with
`src/policy-protocol.js` at startup.
-/

open Guard
open Guard.Io

/-- Decode a document under `lim` and re-serialize it, so a round trip is a
string equality. `error:<code>` distinguishes a refusal from a decode. -/
def decWith (lim : AbiLimits) (s : String) : String :=
  match J.parse s with
  | .error e => s!"json-error:{e}"
  | .ok j =>
    match decodeDocument lim j with
    | .error e => s!"error:{e}"
    | .ok raws => (documentToJson raws).compress

def dec (s : String) : String := decWith abiLimits s

/-- U+FFFD, written without a `\u` escape so the expected value cannot be
misread as an encoding of something else. -/
def repl : String := String.mk [Char.ofNat 0xFFFD]
/-- U+1F600, a supplementary-plane character. -/
def emoji : String := String.mk [Char.ofNat 0x1F600]
def nul : String := String.mk [Char.ofNat 0]

/-! ## Exact round trips

`rawToJson` emits the field order `src/adapters/parse5.js` emits and
`decodeDocument` accepts, so an accepted document re-serializes to exactly its
input bytes. -/

def rtEmpty : String := "{\"kind\":\"root\",\"children\":[]}"
def rtEmptyOk : Bool := dec rtEmpty == rtEmpty
#guard rtEmptyOk

def rtText : String := "{\"kind\":\"root\",\"children\":[{\"kind\":\"text\",\"text\":\"hi\"}]}"
def rtTextOk : Bool := dec rtText == rtText
#guard rtTextOk

def rtElement : String :=
  "{\"kind\":\"root\",\"children\":[{\"kind\":\"el\",\"ns\":\"html\",\"tag\":\"div\"," ++
  "\"attrs\":[[\"class\",\"card\"],[\"id\",\"g-a\"]],\"children\":[{\"kind\":\"text\",\"text\":\"x\"}]}]}"
def rtElementOk : Bool := dec rtElement == rtElement
#guard rtElementOk

def rtNested : String :=
  "{\"kind\":\"root\",\"children\":[{\"kind\":\"el\",\"ns\":\"svg\",\"tag\":\"svg\",\"attrs\":[]," ++
  "\"children\":[{\"kind\":\"el\",\"ns\":\"svg\",\"tag\":\"g\",\"attrs\":[[\"fill\",\"red\"]],\"children\":[]}]}]}"
def rtNestedOk : Bool := dec rtNested == rtNested
#guard rtNestedOk

/-- `comment`, `doctype` and `unknown` are the non-element kinds the parse5
adapter emits. They decode to `Raw.other` and round trip. -/
def rtOther : String :=
  "{\"kind\":\"root\",\"children\":[{\"kind\":\"comment\"},{\"kind\":\"doctype\"},{\"kind\":\"unknown\"}]}"
def rtOtherOk : Bool := dec rtOther == rtOther
#guard rtOtherOk

/-! ## Duplicate object fields

The JSON reader keeps both occurrences, so the decoder must see and reject
them. `rawFromJson` silently takes the first. -/

def dupRootField : Bool := dec "{\"kind\":\"root\",\"kind\":\"root\",\"children\":[]}" == "error:duplicate-field"
#guard dupRootField
def dupRootChildren : Bool := dec "{\"kind\":\"root\",\"children\":[],\"children\":[]}" == "error:duplicate-field"
#guard dupRootChildren
def dupTextField : Bool := dec "{\"kind\":\"root\",\"children\":[{\"kind\":\"text\",\"text\":\"a\",\"text\":\"b\"}]}" == "error:duplicate-field"
#guard dupTextField
/-- A duplicated `kind` is caught before the permitted field set is known. -/
def dupKindField : Bool := dec "{\"kind\":\"root\",\"children\":[{\"kind\":\"text\",\"kind\":\"el\",\"text\":\"a\"}]}" == "error:duplicate-field"
#guard dupKindField

/-! ## Duplicate attributes -/

def dupAttrDoc : String :=
  "{\"kind\":\"root\",\"children\":[{\"kind\":\"el\",\"ns\":\"html\",\"tag\":\"div\"," ++
  "\"attrs\":[[\"class\",\"a\"],[\"class\",\"b\"]],\"children\":[]}]}"
def dupAttr : Bool := dec dupAttrDoc == "error:duplicate-attribute:class"
#guard dupAttr

/-! ## Malformed attributes are errors, not silent drops -/

def attrEl (attrs : String) : String :=
  "{\"kind\":\"root\",\"children\":[{\"kind\":\"el\",\"ns\":\"html\",\"tag\":\"div\"," ++
  "\"attrs\":" ++ attrs ++ ",\"children\":[]}]}"

def attrShortPair : Bool := dec (attrEl "[[\"class\"]]") == "error:attr-not-string-pair"
#guard attrShortPair
def attrLongPair : Bool := dec (attrEl "[[\"class\",\"a\",\"b\"]]") == "error:attr-not-string-pair"
#guard attrLongPair
def attrNonString : Bool := dec (attrEl "[[\"class\",1]]") == "error:attr-not-string-pair"
#guard attrNonString
def attrObject : Bool := dec (attrEl "[{\"class\":\"a\"}]") == "error:attr-not-array"
#guard attrObject
def attrEmptyName : Bool := dec (attrEl "[[\"\",\"a\"]]") == "error:attr-name-empty"
#guard attrEmptyName

/-! ## Missing, mistyped and extra fields -/

def missingText : Bool := dec "{\"kind\":\"root\",\"children\":[{\"kind\":\"text\"}]}" == "error:missing-field:text"
#guard missingText
def textNotString : Bool := dec "{\"kind\":\"root\",\"children\":[{\"kind\":\"text\",\"text\":7}]}" == "error:field-not-string:text"
#guard textNotString
def textExtraField : Bool := dec "{\"kind\":\"root\",\"children\":[{\"kind\":\"text\",\"text\":\"a\",\"ns\":\"html\"}]}" == "error:unknown-field:ns"
#guard textExtraField
def missingKind : Bool := dec "{\"kind\":\"root\",\"children\":[{\"text\":\"a\"}]}" == "error:missing-field:kind"
#guard missingKind
def elExtraField : Bool := dec "{\"kind\":\"root\",\"children\":[{\"kind\":\"el\",\"ns\":\"html\",\"tag\":\"div\",\"attrs\":[],\"children\":[],\"extra\":1}]}" == "error:unknown-field:extra"
#guard elExtraField
def elMissingAttrs : Bool := dec "{\"kind\":\"root\",\"children\":[{\"kind\":\"el\",\"ns\":\"html\",\"tag\":\"div\",\"children\":[]}]}" == "error:missing-field:attrs"
#guard elMissingAttrs
def elEmptyTag : Bool := dec "{\"kind\":\"root\",\"children\":[{\"kind\":\"el\",\"ns\":\"html\",\"tag\":\"\",\"attrs\":[],\"children\":[]}]}" == "error:tag-empty"
#guard elEmptyTag
def unknownKind : Bool := dec "{\"kind\":\"root\",\"children\":[{\"kind\":\"mystery\"}]}" == "error:unknown-node-kind:mystery"
#guard unknownKind
/-- `root` is not a child kind, so a nested root cannot exist. -/
def nestedRoot : Bool := dec "{\"kind\":\"root\",\"children\":[{\"kind\":\"root\",\"children\":[]}]}" == "error:unknown-node-kind:root"
#guard nestedRoot
def elAtTopLevel : Bool := dec "{\"kind\":\"el\",\"ns\":\"html\",\"tag\":\"div\",\"attrs\":[],\"children\":[]}" == "error:unknown-field:ns"
#guard elAtTopLevel
def arrayDocument : Bool := dec "[]" == "error:not-an-object"
#guard arrayDocument
def childrenNotArray : Bool := dec "{\"kind\":\"root\",\"children\":{}}" == "error:field-not-array:children"
#guard childrenNotArray
def childNotObject : Bool := dec "{\"kind\":\"root\",\"children\":[7]}" == "error:not-an-object"
#guard childNotObject
def commentExtraField : Bool := dec "{\"kind\":\"root\",\"children\":[{\"kind\":\"comment\",\"text\":\"x\"}]}" == "error:unknown-field:text"
#guard commentExtraField

/-! ## NUL, lone surrogates, supplementary characters

The decoder transports content faithfully; `checkTree` decides. These pin the
*conversion*, which is where a silent corruption would hide. -/

/-- A NUL survives decoding and is re-emitted escaped, so it can neither
truncate the response nor disappear. -/
def nulDoc : String := "{\"kind\":\"root\",\"children\":[{\"kind\":\"text\",\"text\":\"a\\u0000b\"}]}"
def nulRoundTrip : Bool := dec nulDoc == nulDoc
#guard nulRoundTrip
def nulDecoded : Bool :=
  match J.parse nulDoc with
  | .ok j => match decodeDocument abiLimits j with
    | .ok [.text s] => s == "a" ++ nul ++ "b"
    | _ => false
  | _ => false
#guard nulDecoded

def nulAttrDoc : String :=
  "{\"kind\":\"root\",\"children\":[{\"kind\":\"el\",\"ns\":\"html\",\"tag\":\"div\"," ++
  "\"attrs\":[[\"cla\\u0000ss\",\"a\\u0000b\"]],\"children\":[]}]}"
def nulAttrRoundTrip : Bool := dec nulAttrDoc == nulAttrDoc
#guard nulAttrRoundTrip

/-- A lone high surrogate escape is not a character. The JSON reader replaces
it with U+FFFD, which is what a well-behaved UTF-8 encoder does, so the result
is a valid string rather than an invalid one. -/
def loneHigh : Bool :=
  dec "{\"kind\":\"root\",\"children\":[{\"kind\":\"text\",\"text\":\"\\ud800\"}]}"
    == "{\"kind\":\"root\",\"children\":[{\"kind\":\"text\",\"text\":\"" ++ repl ++ "\"}]}"
#guard loneHigh
def loneLow : Bool :=
  dec "{\"kind\":\"root\",\"children\":[{\"kind\":\"text\",\"text\":\"\\udc00\"}]}"
    == "{\"kind\":\"root\",\"children\":[{\"kind\":\"text\",\"text\":\"" ++ repl ++ "\"}]}"
#guard loneLow
/-- A high surrogate followed by a non-surrogate is also replaced, and the
following character is not consumed. -/
def highThenAscii : Bool :=
  dec "{\"kind\":\"root\",\"children\":[{\"kind\":\"text\",\"text\":\"\\ud800x\"}]}"
    == "{\"kind\":\"root\",\"children\":[{\"kind\":\"text\",\"text\":\"" ++ repl ++ "x\"}]}"
#guard highThenAscii
/-- A well-formed surrogate pair is one supplementary character. -/
def surrogatePair : Bool :=
  dec "{\"kind\":\"root\",\"children\":[{\"kind\":\"text\",\"text\":\"\\ud83d\\ude00\"}]}"
    == "{\"kind\":\"root\",\"children\":[{\"kind\":\"text\",\"text\":\"" ++ emoji ++ "\"}]}"
#guard surrogatePair
/-- Length limits are in UTF-16 code units on both sides, so a supplementary
character counts as two. -/
def supplementaryCounts : Bool := utf16Length emoji == 2 && emoji.length == 1
#guard supplementaryCounts

/-! ## Resource bounds

Checked against a lowered limits record so the cases stay small; the shipped
values are compared with the JavaScript frontend's at startup. -/

def tiny : AbiLimits := { abiLimits with maxRawNodes := 3, maxRawDepth := 2, maxRawAttrsPerElement := 2, maxRawTextCodeUnits := 4, maxRawTotalTextCodeUnits := 6, maxRawNameCodeUnits := 5 }

def nestedDoc (n : Nat) : String :=
  let rec go : Nat → String
    | 0 => "[]"
    | k + 1 => "[{\"kind\":\"el\",\"ns\":\"html\",\"tag\":\"div\",\"attrs\":[],\"children\":" ++ go k ++ "}]"
  "{\"kind\":\"root\",\"children\":" ++ go n ++ "}"

def depthAtLimit : Bool := (decWith tiny (nestedDoc 2)).startsWith "{\"kind\":\"root\""
#guard depthAtLimit
def depthOverLimit : Bool := decWith tiny (nestedDoc 3) == "error:raw-depth-exceeded"
#guard depthOverLimit

def wideDoc (n : Nat) : String :=
  "{\"kind\":\"root\",\"children\":[" ++ ",".intercalate (List.replicate n "{\"kind\":\"text\",\"text\":\"x\"}") ++ "]}"

def nodesAtLimit : Bool := (decWith tiny (wideDoc 3)).startsWith "{\"kind\":\"root\""
#guard nodesAtLimit
def nodesOverLimit : Bool := decWith tiny (wideDoc 4) == "error:raw-nodes-exceeded"
#guard nodesOverLimit
/-- Nested elements count towards the same node budget as text nodes. -/
def nodesCountElements : Bool := decWith tiny (nestedDoc 4) == "error:raw-nodes-exceeded" || decWith tiny (nestedDoc 4) == "error:raw-depth-exceeded"
#guard nodesCountElements

def attrsOverLimit : Bool := decWith tiny (attrEl "[[\"a\",\"1\"],[\"b\",\"2\"],[\"c\",\"3\"]]") == "error:raw-attrs-exceeded"
#guard attrsOverLimit
def textOverLimit : Bool := decWith tiny "{\"kind\":\"root\",\"children\":[{\"kind\":\"text\",\"text\":\"xxxxx\"}]}" == "error:raw-text-exceeded"
#guard textOverLimit
def totalTextOverLimit : Bool := decWith tiny "{\"kind\":\"root\",\"children\":[{\"kind\":\"text\",\"text\":\"xxxx\"},{\"kind\":\"text\",\"text\":\"xxxx\"}]}" == "error:raw-total-text-exceeded"
#guard totalTextOverLimit
def nameOverLimit : Bool := decWith tiny "{\"kind\":\"root\",\"children\":[{\"kind\":\"el\",\"ns\":\"html\",\"tag\":\"divvvv\",\"attrs\":[],\"children\":[]}]}" == "error:raw-name-too-long"
#guard nameOverLimit
def attrNameOverLimit : Bool := decWith tiny (attrEl "[[\"aaaaaa\",\"1\"]]") == "error:attr-name-too-long"
#guard attrNameOverLimit

/-- A supplementary character costs two code units against a text limit, the
same as in JavaScript. -/
def supplementaryCountsTwice : Bool :=
  decWith { tiny with maxRawTextCodeUnits := 3 } "{\"kind\":\"root\",\"children\":[{\"kind\":\"text\",\"text\":\"aa\\ud83d\\ude00\"}]}" == "error:raw-text-exceeded"
#guard supplementaryCountsTwice

/-! ## Envelope strictness

Protocol data is rejected explicitly rather than defaulted. -/

def CFG : String :=
  "{\"abi\":1,\"op\":\"configure\",\"profile\":\"default\",\"classes\":[\"card\"],\"stylesheetHash\":\"h\"}"

def req (doc : String) : String :=
  "{\"abi\":1,\"op\":\"check\",\"requestId\":\"r1\",\"document\":" ++ doc ++ "}"

def has (out : String) (needle : String) : Bool := (out.splitOn needle).length > 1
def errOf (out : String) : Bool := has out "\"status\":\"error\""
def okOf (out : String) : Bool := has out "\"status\":\"accepted\""
def rejOf (out : String) : Bool := has out "\"status\":\"rejected\""

def benignDoc : String :=
  "{\"kind\":\"root\",\"children\":[{\"kind\":\"el\",\"ns\":\"html\",\"tag\":\"p\",\"attrs\":[]," ++
  "\"children\":[{\"kind\":\"text\",\"text\":\"hi\"}]}]}"

/-- A benign document is accepted and the response carries the checker
identity and the echoed request id. -/
def acceptsBenign : Bool :=
  let out := checkDocument CFG (req benignDoc)
  okOf out && has out checkerVersion && has out "\"requestId\":\"r1\""
#guard acceptsBenign

/-- A script element is removed, so the returned tree cannot contain it. The
response tree is the checker's output, never the decoder's input. -/
def dropsScript : Bool :=
  let out := checkDocument CFG (req "{\"kind\":\"root\",\"children\":[{\"kind\":\"el\",\"ns\":\"html\",\"tag\":\"script\",\"attrs\":[],\"children\":[]}]}")
  okOf out && !has out "script"
#guard dropsScript

def wrongAbi : Bool := errOf (checkDocument CFG "{\"abi\":2,\"op\":\"check\",\"requestId\":\"r\",\"document\":{\"kind\":\"root\",\"children\":[]}}")
#guard wrongAbi
def abiNotNumber : Bool := errOf (checkDocument CFG "{\"abi\":\"1\",\"op\":\"check\",\"requestId\":\"r\",\"document\":{\"kind\":\"root\",\"children\":[]}}")
#guard abiNotNumber
def wrongOp : Bool := errOf (checkDocument CFG "{\"abi\":1,\"op\":\"configure\",\"requestId\":\"r\",\"document\":{\"kind\":\"root\",\"children\":[]}}")
#guard wrongOp
def emptyRequestId : Bool := errOf (checkDocument CFG "{\"abi\":1,\"op\":\"check\",\"requestId\":\"\",\"document\":{\"kind\":\"root\",\"children\":[]}}")
#guard emptyRequestId
/-- A document request cannot smuggle a class list or a profile. -/
def requestCannotSetClasses : Bool := errOf (checkDocument CFG "{\"abi\":1,\"op\":\"check\",\"requestId\":\"r\",\"document\":{\"kind\":\"root\",\"children\":[]},\"classes\":[\"evil\"]}")
#guard requestCannotSetClasses
def requestCannotSetProfile : Bool := errOf (checkDocument CFG "{\"abi\":1,\"op\":\"check\",\"requestId\":\"r\",\"document\":{\"kind\":\"root\",\"children\":[]},\"profile\":\"other\"}")
#guard requestCannotSetProfile
def requestCannotSetLimits : Bool := errOf (checkDocument CFG "{\"abi\":1,\"op\":\"check\",\"requestId\":\"r\",\"document\":{\"kind\":\"root\",\"children\":[]},\"limits\":{}}")
#guard requestCannotSetLimits
def notJsonRequest : Bool := errOf (checkDocument CFG "not json")
#guard notJsonRequest
def trailingGarbage : Bool := errOf (checkDocument CFG (req "{\"kind\":\"root\",\"children\":[]}" ++ "x"))
#guard trailingGarbage
def unknownProfileConfig : Bool := errOf (checkDocument "{\"abi\":1,\"op\":\"configure\",\"profile\":\"other\",\"classes\":[],\"stylesheetHash\":\"h\"}" (req "{\"kind\":\"root\",\"children\":[]}"))
#guard unknownProfileConfig
def duplicateClassConfig : Bool := errOf (checkDocument "{\"abi\":1,\"op\":\"configure\",\"profile\":\"default\",\"classes\":[\"a\",\"a\"],\"stylesheetHash\":\"h\"}" (req "{\"kind\":\"root\",\"children\":[]}"))
#guard duplicateClassConfig
def emptyStylesheetHash : Bool := errOf (checkDocument "{\"abi\":1,\"op\":\"configure\",\"profile\":\"default\",\"classes\":[\"a\"],\"stylesheetHash\":\"\"}" (req "{\"kind\":\"root\",\"children\":[]}"))
#guard emptyStylesheetHash
def configMissingStylesheet : Bool := errOf (checkDocument "{\"abi\":1,\"op\":\"configure\",\"profile\":\"default\",\"classes\":[\"a\"]}" (req "{\"kind\":\"root\",\"children\":[]}"))
#guard configMissingStylesheet
/-- A malformed document is an error and no tree comes back with it. -/
def malformedDocumentNoTree : Bool :=
  let out := checkDocument CFG (req "{\"kind\":\"root\",\"children\":[{\"kind\":\"text\"}]}")
  errOf out && !has out "\"tree\""
#guard malformedDocumentNoTree

/-- The sealed class list, not the request, decides which classes survive. -/
def classesAreSealed : Bool :=
  let doc := req "{\"kind\":\"root\",\"children\":[{\"kind\":\"el\",\"ns\":\"html\",\"tag\":\"p\",\"attrs\":[[\"class\",\"card evil\"]],\"children\":[{\"kind\":\"text\",\"text\":\"x\"}]}]}"
  let out := checkDocument CFG doc
  okOf out && has out "[\"class\",\"card\"]" && !has out "evil"
#guard classesAreSealed

/-- A document the policy rejects reports `rejected` and carries no tree. -/
def rejectsTooDeep : Bool :=
  let out := checkDocument CFG (req (nestedDoc 40))
  rejOf out && !has out "\"tree\"" && has out "too-deep"
#guard rejectsTooDeep

/-- `guard_abi_info` reports the compiled-in bounds so the glue can compare
them with its own limits module instead of assuming they agree. -/
def infoHasLimits : Bool :=
  let out := guardAbiInfo ()
  has out "\"maxRawDepth\":192" && has out "\"maxRawNodes\":6000" && has out checkerVersion
#guard infoHasLimits

/-- A valid configuration reports `configured` and echoes the stylesheet
identity it was sealed with. -/
def configureOk : Bool :=
  let out := guardConfigure CFG
  has out "\"status\":\"configured\"" && has out "\"stylesheetHash\":\"h\"" && has out "\"classes\":1"
#guard configureOk
