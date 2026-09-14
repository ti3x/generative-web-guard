import Guard.Io.Decode
import Guard.Policy.Candidate
import Guard.Policy.Capabilities

/-!
# Versioned single-document ABI

This is the **production** boundary: the only entry point compiled into the
shipped WebAssembly module. `Guard.processRequest` (`Guard/Io/Api.lean`) is a
batch interface that takes a list of documents and a caller-supplied class
list; it stays available to the native executable for differential testing and
is deliberately **not** exported from the Wasm build, because a permissive
batch interface is the wrong shape for an authority.

## What is bound to the built instance rather than to the request

* **The profile** — element/attribute tables, validators and limits — is
  `defaultProfile`, compiled in. There is no profile field in any request and
  no profile loader. `profileName` names it; `capabilityVersion` versions the
  reviewed kernel it certifies against.
* **The checker version** is `checkerVersion`, compiled in and echoed in every
  response. The glue compares it against its own build-time expectation, so a
  module from a different build is refused instead of silently answering.
* **The resource bounds** are `Guard.Io.abiLimits`, compiled in and reported by
  `guard_abi_info`. A request cannot raise them; a request carrying a `limits`
  field is an `unknown-field` error.
* **The class allowlist and the stylesheet identity** arrive once, through
  `configure`, from trusted host build configuration (the frame manifest). The
  C shim (`lean/wasm/shim.c`) seals them: the first accepted configuration is
  the instance's configuration, and a later differing one is refused. A
  document request has no class or stylesheet field at all, so generated
  content cannot influence either.

The two operations therefore have different trust: `configure` carries build
configuration and is sealed; `check` carries a candidate document and is
untrusted. The seal is what makes "bound to the instance" true for the classes,
and the compile-time constants are what make it true for everything else.

## Wire format

```text
configure request   { "abi": 2, "op": "configure", "profile": "default",
                      "classes": ["card", ...], "stylesheetHash": "<base64>" }
check request       { "abi": 2, "op": "check", "requestId": "<=128 chars",
                      "document": { "kind": "root", "children": [...] } }

response            { "abi": 2, "op": <op>, "requestId": <echo>,
                      "checker": { "abi", "checkerVersion",
                                   "capabilityVersion", "profile" },
                      "status": "accepted" | "rejected" | "configured" | "error",
                      ... }
```

`accepted` carries only `tree`; builder diagnostics are not an authority verdict.
`rejected` carries `reasons`. `error` carries `error`, a bounded machine code,
and is what every malformed or unknown protocol datum produces. No status other
than `accepted` ever carries a `tree`, and `accepted` always carries the tree
that `acceptCandidate` checked, unchanged. Noncanonical candidates are rejected.
-/

namespace Guard.Io

open Guard J

/-- ABI generation. Increment on any wire-format change. Both sides check it. -/
def abiVersion : Nat := 2

/-- The only profile this build can apply. -/
def profileName : String := "default"

/-- Identity of the compiled checker. States intent; it does not establish that
the bytes are the bytes built. The asset hashes in the build manifest are what
detect a content mismatch. -/
def checkerVersion : String := s!"guard-checker/{abiVersion}.{capabilityVersion}"

def checkerJson : Json :=
  .obj
    [ ("abi", .num (toString abiVersion))
    , ("checkerVersion", .str checkerVersion)
    , ("capabilityVersion", .num (toString capabilityVersion))
    , ("profile", .str profileName) ]

def limitsJson : Json :=
  .obj
    [ ("maxRawNodes", .num (toString abiLimits.maxRawNodes))
    , ("maxRawDepth", .num (toString abiLimits.maxRawDepth))
    , ("maxRawAttrsPerElement", .num (toString abiLimits.maxRawAttrsPerElement))
    , ("maxRawNameCodeUnits", .num (toString abiLimits.maxRawNameCodeUnits))
    , ("maxRawTextCodeUnits", .num (toString abiLimits.maxRawTextCodeUnits))
    , ("maxRawTotalTextCodeUnits", .num (toString abiLimits.maxRawTotalTextCodeUnits))
    , ("maxClasses", .num (toString abiLimits.maxClasses))
    , ("maxClassCodeUnits", .num (toString abiLimits.maxClassCodeUnits))
    , ("maxRequestIdCodeUnits", .num (toString abiLimits.maxRequestIdCodeUnits))
    , ("maxStylesheetHashCodeUnits", .num (toString abiLimits.maxStylesheetHashCodeUnits)) ]

private def envelope (op : String) (requestId : String) (fields : List (String × Json)) : String :=
  (Json.obj
    ([ ("abi", .num (toString abiVersion))
     , ("op", .str op)
     , ("requestId", .str requestId)
     , ("checker", checkerJson) ] ++ fields)).compress

/-- Every malformed or unknown protocol datum ends here. Codes are bounded and
never echo decoded content. -/
def errorResponse (op : String) (requestId : String) (code : String) : String :=
  envelope op requestId [("status", .str "error"), ("error", .str code)]

/-! ### configure -/

structure Config where
  classes : List String
  stylesheetHash : String
deriving Repr

def decodeConfig (input : String) : Except String Config := do
  let j ← match J.parse input with
    | .error e => throw s!"config-json:{e}"
    | .ok j => pure j
  let kvs ← strictObject ["abi", "op", "profile", "classes", "stylesheetHash"] j
  if (← requireNat kvs "abi") != abiVersion then throw "abi-mismatch"
  if (← requireStr kvs "op") != "configure" then throw "op-mismatch"
  if (← requireStr kvs "profile") != profileName then throw "unknown-profile"
  let hash ← requireStr kvs "stylesheetHash"
  if hash.isEmpty then throw "stylesheet-hash-empty"
  if utf16Length hash > abiLimits.maxStylesheetHashCodeUnits then throw "stylesheet-hash-too-long"
  let raw ← requireArr kvs "classes"
  if raw.length > abiLimits.maxClasses then throw "too-many-classes"
  let mut classes : List String := []
  for entry in raw do
    match entry with
    | .str c =>
      if c.isEmpty then throw "class-empty"
      if utf16Length c > abiLimits.maxClassCodeUnits then throw "class-too-long"
      if classes.contains c then throw "duplicate-class"
      classes := c :: classes
    | _ => throw "class-not-string"
  return { classes := classes.reverse, stylesheetHash := hash }

/-- Validate a configuration and report what the instance is. The seal itself
lives in the C shim: this function is pure and says only whether the bytes are
an acceptable configuration for this build. -/
def configureResponse (input : String) : String :=
  match decodeConfig input with
  | .error e => errorResponse "configure" "" e
  | .ok cfg =>
    envelope "configure" ""
      [ ("status", .str "configured")
      , ("limits", limitsJson)
      , ("classes", .num (toString cfg.classes.length))
      , ("stylesheetHash", .str cfg.stylesheetHash) ]

/-! ### check -/

structure Request where
  requestId : String
  document : Json

def decodeRequest (input : String) : Except String Request := do
  let j ← match J.parse input with
    | .error e => throw s!"request-json:{e}"
    | .ok j => pure j
  let kvs ← strictObject ["abi", "op", "requestId", "document"] j
  if (← requireNat kvs "abi") != abiVersion then throw "abi-mismatch"
  if (← requireStr kvs "op") != "check" then throw "op-mismatch"
  let requestId ← requireStr kvs "requestId"
  if requestId.isEmpty then throw "request-id-empty"
  if utf16Length requestId > abiLimits.maxRequestIdCodeUnits then throw "request-id-too-long"
  match kvs.lookup "document" with
  | none => throw "missing-field:document"
  | some document => return { requestId, document }

def acceptedResponse (requestId : String) (tree : List Node) : String :=
  envelope "check" requestId
    [ ("status", .str "accepted")
    , ("tree", .obj [("kind", .str "root"), ("children", .arr (tree.map Node.toJson))])
 ]

def rejectedResponse (requestId : String) (reasons : List String) : String :=
  envelope "check" requestId
    [("status", .str "rejected"), ("reasons", .arr (reasons.map Json.str))]

/--
The whole production path, as one pure function of the sealed configuration and
one request.

`acceptCandidate` validates the decoded candidate without normalization. Its
reference fixed-point theorem is proved separately; replay is not executed.
-/
def checkDocument (config : String) (request : String) : String :=
  match decodeConfig config with
  | .error e => errorResponse "check" "" s!"config:{e}"
  | .ok cfg =>
    match decodeRequest request with
    | .error e => errorResponse "check" "" s!"request:{e}"
    | .ok req =>
      match decodeCandidateDocument abiLimits req.document with
      | .error e => errorResponse "check" req.requestId s!"document:{e}"
      | .ok tree =>
        if acceptCandidate defaultProfile { classes := cfg.classes } tree then
          acceptedResponse req.requestId tree
        else rejectedResponse req.requestId ["candidate-policy"]

/-! ### C symbols

See `lean/wasm/shim.c`. `Unit` arguments keep these compiled as functions
rather than as initialized globals.
-/

@[export guard_abi_info]
def guardAbiInfo (_ : Unit) : String :=
  envelope "info" "" [("status", .str "info"), ("limits", limitsJson)]

@[export guard_configure]
def guardConfigure (config : String) : String := configureResponse config

@[export guard_check_document]
def guardCheckDocument (config : String) (request : String) : String :=
  checkDocument config request

end Guard.Io
