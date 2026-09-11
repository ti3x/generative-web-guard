#!/usr/bin/env bash
# Build the Lean checker to WebAssembly.
#
# Inputs:  Lean-generated C under .lake/build/ir (from `lake build`),
#          a Lean wasm32 distribution at $LEAN_WASM (include/ and lib/lean/),
#          an activated Emscripten SDK (emcc on PATH).
# Output:  wasm/dist/guard.mjs + guard.wasm (ES module, MODULARIZE).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${LEAN_WASM:?set LEAN_WASM to the extracted lean-*-linux_wasm32 directory}"

lake build Guard   # host build generates the IR C files we compile below
mkdir -p wasm/dist

# Derive the C file list from the current Lean sources so stale IR files from
# an earlier module layout can never be linked twice.
IR=.lake/build/ir
SOURCES=$(cd . && find Guard -name '*.lean' | sort | sed "s#^\(.*\)\.lean\$#$IR/\1.c#")
SOURCES="$SOURCES $IR/Guard.c wasm/shim.c"
for f in $SOURCES; do [ -f "$f" ] || { echo "missing IR file $f (run lake build Guard)"; exit 1; }; done

echo "compiling $(echo $SOURCES | wc -w) C files with $(emcc --version | head -1)"
emcc -O2 \
  -I "$LEAN_WASM/include" \
  $SOURCES \
  -L "$LEAN_WASM/lib/lean" -lInit -lleanrt \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createGuard \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sSTACK_SIZE=16MB \
  -sENVIRONMENT=web,worker,node \
  -sEXPORTED_FUNCTIONS=_guard_init,_guard_check_c,_guard_free,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8 \
  -sNO_EXIT_RUNTIME=1 -sASSERTIONS=0 \
  -o wasm/dist/guard.mjs
ls -la wasm/dist
