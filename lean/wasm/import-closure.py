"""Emit precisely the current production Lean import closure, not all stale IR."""
from pathlib import Path
import re

seen = set()
def visit(module):
    if module in seen:
        return
    seen.add(module)
    path = Path(module.replace('.', '/') + '.lean')
    if not path.exists():
        raise SystemExit(f'missing production module: {module}')
    for imported in re.findall(r'^import\s+(\S+)', path.read_text(), re.M):
        if imported.startswith('Guard'):
            visit(imported)

visit('Guard.Wasm')
for module in seen:
    if module.startswith('Guard.Props') or module in {'Guard.Policy.Check', 'Guard.Io.Api', 'Guard'}:
        raise SystemExit(f'reference code in production closure: {module}')
modules = sorted(seen)
Path('wasm/dist/import-closure.txt').write_text('\n'.join(modules) + '\n')
print(' '.join('.lake/build/ir/' + module.replace('.', '/') + '.c' for module in modules))
