-- Minimal production root. Reference normalization, batch IO and proofs must
-- never enter this import graph; wasm/import-closure.py enforces that split.
import Guard.Io.Abi
