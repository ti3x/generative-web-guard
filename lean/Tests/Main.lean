import Guard

/-!
Executable smoke test for the request/response API (`lake test`). Runs the
pure `processRequest` on an embedded request and checks the response.
-/

open Guard

def request : String :=
  "{\"classes\":[\"card\"],\"inputs\":[{\"kind\":\"root\",\"children\":[{\"kind\":\"el\",\"ns\":\"html\",\"tag\":\"DIV\"," ++
  "\"attrs\":[[\"class\",\"card evil\"],[\"onclick\",\"x\"],[\"id\",\"t\"]],\"children\":[{\"kind\":\"text\",\"text\":\"hi\"}," ++
  "{\"kind\":\"el\",\"ns\":\"svg\",\"tag\":\"svg\",\"attrs\":[[\"viewbox\",\"0 0 10.50 5\"]],\"children\":[]}]}]}]}"

def expect (out : String) (needle : String) : IO Bool := do
  if (out.splitOn needle).length > 1 then pure true
  else
    IO.eprintln s!"missing: {needle}"
    pure false

def main : IO UInt32 := do
  let out := processRequest request
  let checks ← [ "\"status\":\"validated\"", "\"tag\":\"div\"", "[\"class\",\"card\"]", "[\"id\",\"g-t\"]",
                 "[\"viewBox\",\"0 0 10.5 5\"]", "\"changes\":4" ].mapM (expect out)
  let okBad ← expect (processRequest "not json") "\"error\""
  if checks.all id && okBad then
    IO.println "guard-tests: ok"
    pure 0
  else
    IO.eprintln out
    pure 1
