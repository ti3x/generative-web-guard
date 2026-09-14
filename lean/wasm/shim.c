// C shim between the Emscripten module boundary and the Lean-exported
// single-document ABI (`lean/Guard/Io/Abi.lean`). Compiled together with the
// Lean-generated C.
//
// DESIGN RULES, all of them load-bearing:
//
//  1. ONE bounded staging buffer for input, allocated once with a fixed
//     capacity. A request cannot make this module allocate an arbitrary
//     amount of memory, and there is no per-request malloc/free pair on the
//     input path at all. `_malloc`/`_free` are deliberately NOT exported to
//     JavaScript any more.
//  2. EXPLICIT LENGTHS everywhere. Nothing scans for a NUL to find the end of
//     a request or a response. A NUL inside a string can therefore neither
//     truncate a document nor truncate a verdict.
//  3. UTF-8 IS VALIDATED before it becomes a Lean string. `lean_mk_string`
//     assumes valid UTF-8; handing it invalid bytes is undefined behaviour in
//     the Lean runtime, so the bytes are checked here first. Overlong forms,
//     surrogates encoded as UTF-8 and out-of-range code points are all
//     rejected.
//  4. THE CONFIGURATION IS SEALED. `guard_configure_seal` accepts a
//     configuration once. A later call with identical bytes is a no-op; a
//     later call with different bytes fails. The class allowlist and the
//     stylesheet identity are therefore properties of the instance, set by
//     trusted glue before any document is checked, and no document request can
//     change them. The profile, the tables, the limits and the checker version
//     are compile-time constants in Lean and are not settable at all.
//  5. ONE OUTSTANDING RESPONSE. The response buffer is owned here and released
//     by `guard_response_release`, which is idempotent, so there is no path to
//     a double free and no path to reading a freed buffer.
//  6. EVERY FAILURE IS A CODE, NEVER A PARTIAL RESULT. A failing call leaves
//     no response installed, so a caller that ignores the return value reads a
//     zero-length response rather than stale bytes.
#include <lean/lean.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// Request capacity. `maxCandidateUtf8Bytes` in src/policy-protocol.js is
// 2,000,000; the rest is the JSON envelope around the document. The JS glue
// checks `guard_input_capacity()` against its own limit at startup rather than
// assuming this number.
#define GUARD_MAX_INPUT_BYTES 2200000u
#define GUARD_MAX_CONFIG_BYTES 65536u
// A response is the accepted tree plus change records. The checker's own
// output limits bound the tree; this is the hard ceiling on the copy.
#define GUARD_MAX_RESPONSE_BYTES 8000000u

// Status codes returned to JavaScript. Negative values never install a
// response.
#define GUARD_OK 0
#define GUARD_ERR_INIT (-1)
#define GUARD_ERR_LENGTH (-2)
#define GUARD_ERR_UTF8 (-3)
#define GUARD_ERR_SEALED (-4)
#define GUARD_ERR_NOT_CONFIGURED (-5)
#define GUARD_ERR_ALLOC (-6)
#define GUARD_ERR_RESPONSE_TOO_LARGE (-7)
#define GUARD_ERR_RESPONSE_NUL (-8)
#define GUARD_ERR_CONFIG_REFUSED (-9)
#define GUARD_ERR_BUSY (-10)

// Lean runtime and module initializers. The module initializer name is
// derived from the module path: Guard.Wasm -> initialize_Guard_Wasm.
extern void lean_initialize_runtime_module(void);
extern lean_object *initialize_Guard_Wasm(uint8_t builtin, lean_object *w);
// Exported by Guard/Io/Abi.lean. Each consumes its arguments.
extern lean_object *guard_abi_info(lean_object *unit);
extern lean_object *guard_configure(lean_object *config);
extern lean_object *guard_check_document(lean_object *config, lean_object *request);

static int initialized = 0;

// Input staging. Static, so its address never moves and its size is fixed at
// link time rather than chosen by a caller.
static char input_buffer[GUARD_MAX_INPUT_BYTES];

// Sealed configuration.
static char config_buffer[GUARD_MAX_CONFIG_BYTES];
static unsigned config_len = 0;
static int configured = 0;

// The single outstanding response.
static char *response = NULL;
static unsigned response_len = 0;

// Reentrancy guard: Lean is single-threaded here, and a nested call would
// corrupt the staging buffer. There is no legitimate caller that reenters.
static int in_call = 0;

// ---------------------------------------------------------------------------
// UTF-8 validation
//
// Rejects: truncated sequences, bad continuation bytes, overlong encodings,
// the surrogate range D800..DFFF encoded as three bytes, and anything above
// U+10FFFF. A NUL byte is VALID UTF-8 and is accepted: it is content, and the
// Lean writer escapes it as \u0000 on the way out. Nothing downstream uses a
// NUL as a terminator.
// ---------------------------------------------------------------------------
static int utf8_valid(const unsigned char *s, unsigned n) {
  unsigned i = 0;
  while (i < n) {
    unsigned char c = s[i];
    if (c < 0x80u) { i += 1; continue; }
    unsigned need;
    uint32_t cp;
    if ((c & 0xe0u) == 0xc0u) { need = 1; cp = c & 0x1fu; }
    else if ((c & 0xf0u) == 0xe0u) { need = 2; cp = c & 0x0fu; }
    else if ((c & 0xf8u) == 0xf0u) { need = 3; cp = c & 0x07u; }
    else return 0;                                  /* 0x80..0xBF, 0xF8..0xFF */
    if (i + need >= n) return 0;                     /* truncated sequence */
    for (unsigned k = 1; k <= need; k++) {
      unsigned char cc = s[i + k];
      if ((cc & 0xc0u) != 0x80u) return 0;
      cp = (cp << 6) | (uint32_t)(cc & 0x3fu);
    }
    if (need == 1 && cp < 0x80u) return 0;           /* overlong */
    if (need == 2 && cp < 0x800u) return 0;          /* overlong */
    if (need == 3 && cp < 0x10000u) return 0;        /* overlong */
    if (cp >= 0xd800u && cp <= 0xdfffu) return 0;    /* UTF-8-encoded surrogate */
    if (cp > 0x10ffffu) return 0;
    i += need + 1;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Returns 0 on success, GUARD_ERR_INIT if module initialization failed.
int guard_init(void) {
  if (initialized) return GUARD_OK;
  lean_initialize_runtime_module();
  lean_object *res = initialize_Guard_Wasm(1 /* builtin */, lean_io_mk_world());
  int ok = lean_io_result_is_ok(res);
  if (ok) lean_dec_ref(res); else { lean_io_result_show_error(res); lean_dec(res); }
  lean_io_mark_end_initialization();
  initialized = ok;
  return ok ? GUARD_OK : GUARD_ERR_INIT;
}

char *guard_input_buffer(void) { return input_buffer; }
int guard_input_capacity(void) { return (int)GUARD_MAX_INPUT_BYTES; }
int guard_config_capacity(void) { return (int)GUARD_MAX_CONFIG_BYTES; }
int guard_response_capacity(void) { return (int)GUARD_MAX_RESPONSE_BYTES; }

const char *guard_response_ptr(void) { return response ? response : ""; }
int guard_response_len(void) { return response ? (int)response_len : 0; }

// Idempotent. Safe to call with no response installed.
void guard_response_release(void) {
  if (response) { free(response); response = NULL; }
  response_len = 0;
}

// Install a Lean string as the response, then drop the Lean object. Returns a
// status; on any failure no response is installed.
static int install_response(lean_object *out) {
  guard_response_release();
  // lean_string_size counts the bytes INCLUDING the NUL terminator Lean keeps.
  size_t size = lean_string_size(out);
  if (size == 0) { lean_dec(out); return GUARD_ERR_ALLOC; }
  size_t len = size - 1;
  if (len > (size_t)GUARD_MAX_RESPONSE_BYTES) { lean_dec(out); return GUARD_ERR_RESPONSE_TOO_LARGE; }
  const char *src = lean_string_cstr(out);
  // The JSON writer escapes every code point below 0x20, so a raw NUL in the
  // response would mean the writer is broken. Refuse rather than ship bytes
  // whose framing cannot be trusted.
  if (memchr(src, 0, len) != NULL) { lean_dec(out); return GUARD_ERR_RESPONSE_NUL; }
  char *copy = (char *)malloc(len + 1);
  if (!copy) { lean_dec(out); return GUARD_ERR_ALLOC; }
  memcpy(copy, src, len);
  copy[len] = 0;
  lean_dec(out);
  response = copy;
  response_len = (unsigned)len;
  return GUARD_OK;
}

// Build a Lean string from validated bytes. Caller has already bounds- and
// UTF-8-checked them.
static lean_object *lean_string_of(const char *data, unsigned len) {
  return lean_mk_string_from_bytes(data, len);
}

// ---------------------------------------------------------------------------
// configure: sealed, one time
// ---------------------------------------------------------------------------

// `len` bytes of the staging buffer are the configuration. Returns GUARD_OK
// and installs the `configured` response on success.
//
// Sealing rule: the first accepted configuration wins. An identical repeat is
// accepted (idempotent startup), a different one is refused with
// GUARD_ERR_SEALED. Lean validates the CONTENT; this function owns the SEAL.
int guard_configure_seal(int len) {
  if (guard_init() != GUARD_OK) return GUARD_ERR_INIT;
  if (in_call) return GUARD_ERR_BUSY;
  if (len < 0 || (unsigned)len > GUARD_MAX_CONFIG_BYTES) return GUARD_ERR_LENGTH;
  if (!utf8_valid((const unsigned char *)input_buffer, (unsigned)len)) return GUARD_ERR_UTF8;
  if (configured) {
    if ((unsigned)len != config_len || memcmp(config_buffer, input_buffer, (size_t)len) != 0) {
      return GUARD_ERR_SEALED;
    }
  }
  in_call = 1;
  lean_object *out = guard_configure(lean_string_of(input_buffer, (unsigned)len));
  int rc = install_response(out);
  in_call = 0;
  if (rc != GUARD_OK) return rc;
  // Lean decides whether these bytes are an acceptable configuration for this
  // build. Only then do they become the seal.
  if (strstr(guard_response_ptr(), "\"status\":\"configured\"") == NULL) {
    return GUARD_ERR_CONFIG_REFUSED;
  }
  if (!configured) {
    memcpy(config_buffer, input_buffer, (size_t)len);
    config_len = (unsigned)len;
    configured = 1;
  }
  return GUARD_OK;
}

int guard_is_configured(void) { return configured; }

// ---------------------------------------------------------------------------
// check: one document
// ---------------------------------------------------------------------------

// `len` bytes of the staging buffer are the request. The configuration comes
// from the seal, never from the request.
int guard_check(int len) {
  if (guard_init() != GUARD_OK) return GUARD_ERR_INIT;
  if (in_call) return GUARD_ERR_BUSY;
  if (!configured) return GUARD_ERR_NOT_CONFIGURED;
  if (len < 0 || (unsigned)len > GUARD_MAX_INPUT_BYTES) return GUARD_ERR_LENGTH;
  if (!utf8_valid((const unsigned char *)input_buffer, (unsigned)len)) return GUARD_ERR_UTF8;
  in_call = 1;
  lean_object *cfg = lean_string_of(config_buffer, config_len);
  lean_object *req = lean_string_of(input_buffer, (unsigned)len);
  lean_object *out = guard_check_document(cfg, req);
  int rc = install_response(out);
  in_call = 0;
  return rc;
}

// The compiled-in ABI version, limits and checker identity. Computed once and
// installed as the response, so the glue reads it through the same path it
// reads everything else.
int guard_info(void) {
  if (guard_init() != GUARD_OK) return GUARD_ERR_INIT;
  if (in_call) return GUARD_ERR_BUSY;
  in_call = 1;
  lean_object *out = guard_abi_info(lean_box(0));
  int rc = install_response(out);
  in_call = 0;
  return rc;
}

// ---------------------------------------------------------------------------
// Memory audit instrumentation
//
// These expose three integers so the linear-memory and stack ceilings can be
// MEASURED rather than assumed (scripts/wasm-audit.mjs). They grant no
// capability: they read the module's own bookkeeping and return sizes.
//
// The stack high-water mark is measured from JavaScript by painting the unused
// stack region with a pattern before a call and scanning for the deepest
// modified byte afterwards, which needs these two bounds and no rebuild.
// ---------------------------------------------------------------------------
#include <emscripten/stack.h>

unsigned guard_stack_base(void) { return (unsigned)emscripten_stack_get_base(); }
unsigned guard_stack_end(void) { return (unsigned)emscripten_stack_get_end(); }
unsigned guard_stack_current(void) { return (unsigned)emscripten_stack_get_current(); }

extern void *sbrk(intptr_t increment);
// Current heap break: the high-water mark of allocator-reserved memory.
unsigned guard_heap_break(void) { return (unsigned)(uintptr_t)sbrk(0); }

// ---------------------------------------------------------------------------
// Lean's runtime (4.15) references a handful of libuv functions for temp-file
// helpers in IO.FS. The checker never touches the filesystem, and the wasm32
// distribution does not ship libuv, so these resolve the link with stubs that
// report failure if ever called.
#include <errno.h>
const char *uv_strerror(int err) { (void)err; return "libuv is not available in this build"; }
int uv_os_tmpdir(char *buffer, size_t *size) { (void)buffer; (void)size; return -ENOSYS; }
int uv_fs_mkstemp(void *loop, void *req, const char *tpl, void *cb) { (void)loop; (void)req; (void)tpl; (void)cb; return -ENOSYS; }
int uv_fs_mkdtemp(void *loop, void *req, const char *tpl, void *cb) { (void)loop; (void)req; (void)tpl; (void)cb; return -ENOSYS; }
