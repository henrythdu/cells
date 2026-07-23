import type { Node } from 'web-tree-sitter';
import type { ImportEdge } from './crossings.js';
import { createTreeSitterImporter } from './tree-sitter.js';

// --- module-path derivation: file → python module path ---

/** `src/domain/symbol.py` → `src.domain.symbol`; `src/domain/__init__.py` → `src.domain`. */
export function fileToModule(path: string): string {
  const noExt = path.replace(/\.py$/, '');
  const parts = noExt.split('/').filter(Boolean);
  if (parts[parts.length - 1] === '__init__') parts.pop();
  return parts.join('.');
}

/** The package containing a file (for relative-import resolution). */
function filePackage(path: string): string {
  const mod = fileToModule(path);
  const basename = path.split('/').pop() ?? '';
  if (basename === '__init__.py') return mod; // __init__ IS its package
  const parts = mod.split('.');
  parts.pop();
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
  for (const stmt of root.namedChildren) {
    if (stmt.type === 'import_statement') {
      for (const child of stmt.namedChildren) {
        const m = dottedText(child);
        if (m) out.push({ dots: 0, module: m, names: [] });
      }
    } else if (stmt.type === 'import_from_statement') {
      const kids = stmt.namedChildren;
      const modNode = kids.find((n) => n.type === 'dotted_name' || n.type === 'relative_import');
      if (!modNode) continue;
      const names = kids
        .filter((n) => n !== modNode)
        .map(dottedText)
        .filter((n): n is string => Boolean(n));
      const text = modNode.text;
      const dots = text.match(/^\.+/)?.[0].length ?? 0;
      const module = text.slice(dots);
      out.push({ dots, module, names });
    }
  }
  return out;
}

// --- resolution: descriptor + source file → candidate module paths → files ---

function resolveEdges(desc: ImportDesc, sourcePath: string, moduleToFile: Map<string, string>): ImportEdge[] {
  let base: string;
  if (desc.dots === 0) {
    base = desc.module; // absolute
  } else {
    const pkg = filePackage(sourcePath).split('.');
    // `.` = current package; each extra dot goes up one level.
    const keep = pkg.length - (desc.dots - 1);
    if (keep < 0) return []; // relative import goes above the root — invalid; skip (avoid false edges).
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
  return edges;
}

/** Python importer — tree-sitter extraction + module→file resolution via ownership. */
export const pythonImporter = createTreeSitterImporter({
  extensions: ['.py'],
  wasmBasename: 'tree-sitter-python.wasm',
  fileToModule,
  extractEdges: (root, sourcePath, _importerModule, moduleToFile) =>
    extractImports(root).flatMap((desc) => resolveEdges(desc, sourcePath, moduleToFile)),
});
