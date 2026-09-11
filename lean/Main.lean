import Guard

/-!
Batch checker executable: reads one JSON request from stdin, writes the JSON
response to stdout. The request format is documented in `Guard/Api.lean`.
-/

open Guard

partial def readAll (h : IO.FS.Stream) (acc : String) : IO String := do
  let line ← h.getLine
  if line.isEmpty then pure acc else readAll h (acc ++ line)

def main : IO UInt32 := do
  let input ← readAll (← IO.getStdin) ""
  IO.println (processRequest input)
  return 0
