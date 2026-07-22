import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language, type Node } from 'web-tree-sitter';
import type { ImportEdge } from './crossings.js';
import type { Importer } from './importers.js';

// --- grammar singleton (lazy: init web-tree-sitter + load the bundled python WASM once) ---
let parserPromise: Promise<Parser> | null = null;
async function getParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init();
      // The WASM ships as a static asset in grammars/ (no native build → distributable).
      const wasm = join(dirname(fileURLToPath(import.meta.url)), '..', 'grammars', 'tree-sitter-python.wasm');
      let lang: Language;
      try {
        lang = await Language.load(readFileSync(wasm));
      } catch {
        throw new Error(`Failed to load Python grammar WASM at ${wasm} — ensure the 'grammars/' directory is bundled with cells.`);
      }
      const parser = new Parser();
      parser.setLanguage(lang);
      return parser;
    })().catch((err) => {
      parserPromise = null; // don't cache the rejection — allow retry on the next call
      throw err;
    });
  }
  return parserPromise;
}

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
export const pythonImporter: Importer = {
  extensions: ['.py'],
  needsContent: true,
  async extract({ files }): Promise<ImportEdge[]> {
    // Build module-path → file from ownership (the reframe: resolve via ownership, not the filesystem).
    const moduleToFile = new Map<string, string>();
    for (const f of files) moduleToFile.set(fileToModule(f.path), f.path);

    const parser = await getParser();
    const edges: ImportEdge[] = [];
    for (const f of files) {
      if (!f.path.endsWith('.py')) continue;
      const tree = parser.parse(f.content);
      if (!tree) continue;
      try {
        for (const desc of extractImports(tree.rootNode)) {
          edges.push(...resolveEdges(desc, f.path, moduleToFile));
        }
      } finally {
        tree.delete(); // web-tree-sitter Trees are WASM-backed — free each one to avoid leaking.
      }
    }
    return edges;
  },
};
