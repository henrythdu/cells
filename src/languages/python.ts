import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { ImportEdge, UnresolvedImport } from '../imports.js';
import { createTreeSitterImporter } from './tree-sitter.js';

// --- module-path derivation: file → python module path ---

/** `src/domain/symbol.py` → `src.domain.symbol`; `src/domain/__init__.py` → `src.domain`.
 *  With `moduleRoot` (e.g. "src"): `src/domain/symbol.py` → `domain.symbol` (for Python src-layout).
 *  Cython: `algos.pyx`/`algos.pxd` → `algos` (a .pyx+.pxd pair is ONE module — the pair mapping
 *  to the same key is intentional; the factory's sorted order makes the .pyx implementation win). */
export function fileToModule(path: string, moduleRoot?: string): string {
  let p = path.replace(/\.(py|pyx|pxd)$/, '');
  if (moduleRoot && p.startsWith(moduleRoot + '/')) p = p.slice(moduleRoot.length + 1);
  const parts = p.split('/').filter(Boolean);
  if (parts[parts.length - 1] === '__init__') parts.pop();
  return parts.join('.');
}

// --- AST → import descriptors ---

interface ImportDesc {
  dots: number; // 0 = absolute; >0 = leading dots in a `from .` import
  module: string; // dotted path after any leading dots ('' for bare `from . import x`)
  names: string[]; // imported names (for `from M import a, b` — tried as submodules M.a, M.b)
}

/** Text of a `dotted_name` (or the inner one inside `dotted_as_name` for `import a as b`). */
function dottedText(node: Node): string | null {
  if (node.type === 'dotted_name') return node.text;
  if (node.type === 'dotted_as_name' || node.type === 'aliased_import') {
    const inner = node.namedChildren.find((c) => c.type === 'dotted_name');
    return inner ? inner.text : null;
  }
  return null;
}

function extractImports(root: Node): ImportDesc[] {
  const out: ImportDesc[] = [];
  collectImports(root, out);
  return out;
}

/** Recursively walk the AST — local imports inside function bodies must be found,
 *  not just top-level statements. */
function collectImports(node: Node, out: ImportDesc[]): void {
  if (node.type === 'import_statement') {
    for (const child of node.namedChildren) {
      const m = dottedText(child);
      if (m) out.push({ dots: 0, module: m, names: [] });
    }
    return; // named children of import nodes are just dotted_name/aliased_import — no deeper imports
  }
  if (node.type === 'import_from_statement') {
    const kids = node.namedChildren;
    const modNode = kids.find((n) => n.type === 'dotted_name' || n.type === 'relative_import');
    if (modNode) {
      const names = kids
        .filter((n) => n !== modNode)
        .map(dottedText)
        .filter((n): n is string => Boolean(n));
      const text = modNode.text;
      const dots = text.match(/^\.+/)?.[0].length ?? 0;
      const module = text.slice(dots);
      out.push({ dots, module, names });
    }
    return; // named children are module name + imported names — no deeper imports
  }
  for (const child of node.namedChildren) collectImports(child, out);
}

// --- resolution: descriptor + source file → candidate module paths → files ---

function resolveImportDesc(desc: ImportDesc, sourcePath: string, importerModule: string, moduleToFile: Map<string, string>, localPackages: Set<string>): { edges: ImportEdge[]; unresolved: UnresolvedImport[] } {
  let base: string;
  if (desc.dots === 0) {
    base = desc.module; // absolute
  } else {
    // The package containing this file. For __init__.py, the module IS the package;
    // for a regular file, the package is module minus the last segment.
    const isInit = sourcePath.endsWith('/__init__.py');
    const pkg = (isInit ? importerModule : importerModule.split('.').slice(0, -1).join('.')).split('.').filter(Boolean);
    // `.` = current package; each extra dot goes up one level.
    const keep = pkg.length - (desc.dots - 1);
    if (keep < 0) return { edges: [], unresolved: [] }; // relative import goes above the root — invalid; skip (avoid false edges).
    const targetPkg = pkg.slice(0, keep);
    base = desc.module ? [...targetPkg, ...desc.module.split('.')].join('.') : targetPkg.join('.');
  }
  const candidates = [base, ...desc.names.map((n) => (base ? `${base}.${n}` : n))];
  const edges: ImportEdge[] = [];
  const seen = new Set<string>();
  for (const cand of candidates) {
    const toFile = moduleToFile.get(cand);
    if (toFile && !seen.has(toFile)) {
      seen.add(toFile);
      edges.push({ fromFile: sourcePath, toFile, import: cand });
    }
  }
  // Only flag unresolved if NO candidate from this import descriptor resolved.
  // If the base module resolved, the name candidates are symbols (functions/classes) within
  // it, not missing submodules — don't false-positive on them.
  const unresolved: UnresolvedImport[] = [];
  if (edges.length === 0 && base && looksLocal(base, desc.dots, localPackages)) {
    // A compiled extension module (pyo3/cython: `headroom._core` → _core.cpython-*.so) is
    // legitimately unresolvable — the file exists but isn't code. Silencing it keeps the
    // unresolved list honest (wave-3 #5: headroom's 73/81 entries were this one specifier).
    if (!isCompiledModule(base, moduleToFile)) unresolved.push({ fromFile: sourcePath, import: base });
  }
  return { edges, unresolved };
}

/** Does this candidate import look local? Relative imports (dots > 0) always do.
 *  Absolute imports look local if the first segment matches a known local package. */
function looksLocal(candidate: string, dots: number, localPackages: Set<string>): boolean {
  if (dots > 0) return true;
  return localPackages.has(candidate.split('.')[0]);
}

const COMPILED_EXTS = ['.so', '.pyd']; // Python extension modules — .so everywhere incl. macOS, .pyd on Windows

/** Directory listings for compiled-module checks — memoized per process (many unresolved imports
 *  may probe the same package dir; the census doesn't change mid-run). */
const compiledDirCache = new Map<string, string[]>();

/** Does `module` (dotted, e.g. `headroom._core`) resolve to a compiled extension file on disk
 *  (`headroom/_core.cpython-312-….so`)? The parent package's dir is derived from the module→file
 *  map (moduleRoot/src-layout aware — `src/headroom/__init__.py` → dir `src/headroom`), so the
 *  compiled artifact is found wherever the package actually lives. Only called for local-looking
 *  unresolved imports; a missing dir (or no parent in the map) → false. */
function isCompiledModule(module: string, moduleToFile: Map<string, string>): boolean {
  const lastDot = module.lastIndexOf('.');
  if (lastDot === -1) return false;
  const parentMod = module.slice(0, lastDot);
  const name = module.slice(lastDot + 1);
  const parentFile = moduleToFile.get(parentMod);
  if (!parentFile) return false;
  const dir = dirname(parentFile);
  try {
    let entries = compiledDirCache.get(dir);
    if (!entries) {
      entries = readdirSync(dir);
      compiledDirCache.set(dir, entries);
    }
    return entries.some((entry) => entry.startsWith(`${name}.`) && COMPILED_EXTS.some((ext) => entry.endsWith(ext)));
  } catch {
    return false; // dir missing → not compiled
  }
}

/** Python importer — tree-sitter analysis + module→file resolution via ownership.
 *  Also handles Cython .pyx/.pxd: their regular Python imports produce edges; `cimport` is
 *  compiled-time and deliberately blind (blanked in preprocess — which ALSO prevents
 *  tree-sitter-python's error recovery from swallowing real imports next to cimport lines). */
export const pythonImporter = createTreeSitterImporter<ImportDesc[]>({
  name: 'python',
  extensions: ['.py', '.pyx', '.pxd'],
  wasmBasename: 'tree-sitter-python.wasm',
  fileToModule,
  preprocess: (content) =>
    content.replace(/^\s*from\s+\S+\s+cimport\b.*$/gm, '').replace(/^\s*cimport\b.*$/gm, ''),
  analyze: (root, _sourcePath, _importerModule, _ctx) => ({
    mods: [],
    reexports: [],
    uses: extractImports(root), // per-file: this file's import descriptors
  }),
  resolveEdges: (descs, sourcePath, importerModule, ctx) => {
    // Local top-level packages = first segment of each module in the map — derived HERE in
    // phase 2, when the module→file map is complete (phase-1 analyze would see a map still
    // being enriched). Distinguishes local-but-unresolved imports (warn) from external
    // packages (skip silently).
    const localPackages = new Set<string>();
    for (const mod of ctx.moduleToFile.keys()) {
      const firstSeg = mod.split('.')[0];
      if (firstSeg) localPackages.add(firstSeg);
    }
    const edges: ImportEdge[] = [];
    const unresolved: UnresolvedImport[] = [];
    for (const desc of descs) {
      const r = resolveImportDesc(desc, sourcePath, importerModule, ctx.moduleToFile, localPackages);
      edges.push(...r.edges);
      unresolved.push(...r.unresolved);
    }
    return { edges, unresolved };
  },
});
