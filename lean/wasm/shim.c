// C shim between the Emscripten module boundary and the Lean-exported
// guard_check function. Compiled together with the Lean-generated C.
#include <lean/lean.h>
#include <stdlib.h>
#include <string.h>

// Lean runtime and module initializers. The module initializer name is
// derived from the module path: Guard.Api -> initialize_Guard_Api.
extern void lean_initialize_runtime_module(void);
extern lean_object *initialize_Guard(uint8_t builtin, lean_object *w);
// Exported by `@[export guard_check]` in Guard/Api.lean. Consumes its argument.
extern lean_object *guard_check(lean_object *input);

static int initialized = 0;

// Returns 0 on success, 1 if module initialization failed.
int guard_init(void) {
  if (initialized) return 0;
  lean_initialize_runtime_module();
  lean_object *res = initialize_Guard(1 /* builtin */, lean_io_mk_world());
  int ok = lean_io_result_is_ok(res);
  if (ok) lean_dec_ref(res); else { lean_io_result_show_error(res); lean_dec(res); }
  lean_io_mark_end_initialization();
  initialized = ok;
  return ok ? 0 : 1;
}

// Takes a NUL-terminated UTF-8 request, returns a malloc'd NUL-terminated
// UTF-8 response. The caller frees it with guard_free.
char *guard_check_c(const char *input) {
  if (!initialized && guard_init() != 0) return strdup("{\"error\":\"lean runtime failed to initialize\"}");
  lean_object *s = lean_mk_string(input);
  lean_object *out = guard_check(s);
  char *copy = strdup(lean_string_cstr(out));
  lean_dec(out);
  return copy;
}

void guard_free(char *p) { free(p); }

// Lean's runtime (4.15) references a handful of libuv functions for temp-file
// helpers in IO.FS. The checker never touches the filesystem, and the wasm32
// distribution does not ship libuv, so these resolve the link with stubs that
// report failure if ever called.
#include <errno.h>
const char *uv_strerror(int err) { (void)err; return "libuv is not available in this build"; }
int uv_os_tmpdir(char *buffer, size_t *size) { (void)buffer; (void)size; return -ENOSYS; }
int uv_fs_mkstemp(void *loop, void *req, const char *tpl, void *cb) { (void)loop; (void)req; (void)tpl; (void)cb; return -ENOSYS; }
int uv_fs_mkdtemp(void *loop, void *req, const char *tpl, void *cb) { (void)loop; (void)req; (void)tpl; (void)cb; return -ENOSYS; }
