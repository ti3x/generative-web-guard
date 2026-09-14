#!/usr/bin/env bash
# Build the Lean checker to WebAssembly.
#
# Inputs:  Lean-generated C under .lake/build/ir (from `lake build`),
#          a Lean wasm32 distribution at $LEAN_WASM (include/ and lib/lean/),
#          an activated Emscripten SDK (emcc on PATH).
# Output:  wasm/dist/guard.mjs + guard.wasm (ES module, MODULARIZE).
#
# WHAT IS EXPORTED, AND WHAT IS NOT
#
# The module exposes only the versioned single-document ABI from
# Guard/Io/Abi.lean plus the bounded staging/response accessors in shim.c. In
# particular:
#
#   * The permissive batch interface (Guard.processRequest, which takes a list
#     of documents and a caller-supplied class list) is NOT exported. It has no
#     @[export] attribute any more and reaches only the native executable.
#   * `_malloc` and `_free` are NOT exported. The input path uses one static
#     staging buffer of fixed capacity, so a request cannot drive an arbitrary
#     allocation, and the only malloc is the response copy, which the shim owns
#     and releases itself.
#
# MEMORY AND STACK CEILINGS
#
# These are measured, not inherited. `scripts/wasm-audit.mjs` paints the unused
# stack region and scans it after the worst legal document to get the stack
# high-water mark, and reads the heap break and the memory size for the heap
# figures. The numbers recorded in that script's header are what the defaults
# below are derived from; re-run it after any change to the checker or the
# Lean toolchain.
#
#   INITIAL_MEMORY   allocated at instantiation. Sized to cover the worst
#                    legal document without growing, so a hostile document
#                    does not also pay for repeated growth.
#   MAXIMUM_MEMORY   hard ceiling. ALLOW_MEMORY_GROWTH without a maximum is
#                    unbounded growth, which is not a ceiling at all. Lean's
#                    termination proofs say nothing about cost, so this bound
#                    is an independent obligation.
#   STACK_SIZE       the checker and the JSON reader both recurse; the depth is
#                    bounded by the decoder's maxRawDepth, not by anything
#                    proved. Sized from the measured high-water mark with
#                    margin, and STACK_OVERFLOW_CHECK turns an overflow into a
#                    clean abort instead of silent memory corruption.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${LEAN_WASM:?set LEAN_WASM to the extracted lean-*-linux_wasm32 directory}"

# Phase 6 measurements with scripts/wasm-audit.mjs on Node 22 / V8:
#
#   after instantiation                heap break 11.30 MiB
#   largest direct-ABI adversarial     heap break 52.43 MiB
#   candidate (decoder backstops,      linear memory 80 MiB, no growth
#   not necessarily legal output)
#   linear-memory stack, every case    104 bytes
#
# So:
#   INITIAL_MEMORY=80MB   above the measured worst case, so a hostile document
#                         does not also pay for a whole-heap copy on growth.
#                         Lean's allocator does not return memory to the
#                         system, so an instance's footprint is the worst
#                         document it has ever seen, not the current one.
#   MAXIMUM_MEMORY=128MB  a real ceiling. ALLOW_MEMORY_GROWTH with no maximum
#                         is unbounded growth.
#   STACK_SIZE=1MB        the previous 16MB was address space for nothing: the
#                         measured linear-memory stack use is 104 bytes,
#                         because the checker's recursion compiles to wasm
#                         CALL FRAMES, which live on the engine's stack and are
#                         not configurable here at all. That depth is bounded
#                         by maxRawPathNodes on raw AND candidate input; see
#                         src/policy-protocol.js.
#   STACK_OVERFLOW_CHECK=1  turns a linear-stack overflow into a clean abort
#                         instead of silent corruption. The glue treats an
#                         abort as a poisoned instance and refuses to render.
INITIAL_MEMORY="${GUARD_WASM_INITIAL_MEMORY:-80MB}"
MAXIMUM_MEMORY="${GUARD_WASM_MAXIMUM_MEMORY:-128MB}"
STACK_SIZE="${GUARD_WASM_STACK_SIZE:-1MB}"
STACK_OVERFLOW_CHECK="${GUARD_WASM_STACK_OVERFLOW_CHECK:-1}"

lake build Guard.Wasm   # host build generates the IR C files we compile below
mkdir -p wasm/dist

# Derive the C file list from the current Lean sources so stale IR files from
# an earlier module layout can never be linked twice.
IR=.lake/build/ir
SOURCES=$(python3 wasm/import-closure.py)
SOURCES="$SOURCES wasm/shim.c"
for f in $SOURCES; do [ -f "$f" ] || { echo "missing IR file $f (run lake build Guard)"; exit 1; }; done

EXPORTS=_guard_init,_guard_info,_guard_configure_seal,_guard_is_configured,_guard_check
EXPORTS=$EXPORTS,_guard_input_buffer,_guard_input_capacity,_guard_config_capacity,_guard_response_capacity
EXPORTS=$EXPORTS,_guard_response_ptr,_guard_response_len,_guard_response_release
EXPORTS=$EXPORTS,_guard_stack_base,_guard_stack_end,_guard_stack_current,_guard_heap_break

echo "compiling $(echo $SOURCES | wc -w) C files with $(emcc --version | head -1)"
echo "ceilings: INITIAL_MEMORY=$INITIAL_MEMORY MAXIMUM_MEMORY=$MAXIMUM_MEMORY STACK_SIZE=$STACK_SIZE STACK_OVERFLOW_CHECK=$STACK_OVERFLOW_CHECK"
emcc -O2 \
  -I "$LEAN_WASM/include" \
  $SOURCES \
  -L "$LEAN_WASM/lib/lean" -lInit -lleanrt \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createGuardChecker \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY="$INITIAL_MEMORY" \
  -sMAXIMUM_MEMORY="$MAXIMUM_MEMORY" \
  -sSTACK_SIZE="$STACK_SIZE" \
  -sSTACK_OVERFLOW_CHECK="$STACK_OVERFLOW_CHECK" \
  -sENVIRONMENT=web,worker,node \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -sEXPORTED_RUNTIME_METHODS=cwrap,HEAPU8 \
  -sNO_EXIT_RUNTIME=1 -sASSERTIONS=0 \
  -o wasm/dist/guard.mjs
ls -la wasm/dist
