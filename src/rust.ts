import type { Node } from 'web-tree-sitter';
import type { ImportEdge } from './crossings.js';
import { createTreeSitterImporter } from './tree-sitter.js';

// --- module-path derivation: file → Rust module path ---

/** `src/lib.rs`|`src/main.rs` → `crate`; `src/app/mod.rs` → `crate::app`;
 *  `src/reading/tokenization.rs` → `crate::reading::tokenization`. Pure. */
export function fileToModule(path: string): string {
  let p = path.replace(/^src\//, '').replace(/\.rs$/, '');
  if (p.endsWith('/mod')) p = p.slice(0, -'/mod'.length);
  if (p === 'lib' || p === 'main') return 'crate';
  return 'crate::' + p.split('/').join('::');
}

// --- AST → import paths (recursively expand `use` declarations) ---

/** Expand a use-clause node into full `::`-separated paths. scoped_identifier/identifier → [text];
 *  scoped_use_list → path × each item; use_as_clause → the inner path; use_wildcard → its module. */
function expandClause(node: Node): string[] {
  switch (node.type) {
    case 'scoped_identifier':
    case 'identifier':
      return [node.text];
    case 'scoped_use_list': {
      // children: a path (scoped_identifier|identifier) + a use_list
      const pathNode = node.namedChildren.find((c) => c.type === 'scoped_identifier' || c.type === 'identifier');
      const listNode = node.namedChildren.find((c) => c.type === 'use_list');
      const prefix = pathNode ? pathNode.text : '';
      const items = listNode ? listNode.namedChildren.flatMap(expandClause) : [];
      return items.map((it) => (prefix ? `${prefix}::${it}` : it));
    }
    case 'use_list':
      return node.namedChildren.flatMap(expandClause);
    case 'use_as_clause': {
      // `<path> as <alias>` — the path is the first named child
      const inner = node.namedChildren[0];
      return inner ? expandClause(inner) : [];
    }
    case 'use_wildcard': {
      // `crate::app::*` → the module `crate::app`; bare `*` → nothing precise
      const t = node.text.replace(/::\*$/, '');
      return t === '*' ? [] : [t];
    }
    default:
      return [];
  }
}

/** All import paths declared at the top level of a Rust file (internal + external). */
function extractImports(root: Node): string[] {
  const out: string[] = [];
  for (const stmt of root.namedChildren) {
    if (stmt.type === 'use_declaration') {
      // flatMap direct children — visibility (`pub`) is anonymous; expandClause ignores unknowns.
      for (const child of stmt.namedChildren) out.push(...expandClause(child));
    }
  }
  return out;
}

// --- resolution: import path + importer module → file (via the module→file map) ---

/** Resolve a Rust use path to a source file via the module→file map.
 *  `crate::` = absolute; `super::`/`self::` = relative to the importer; else = external (null).
 *  Matches the module OR module-minus-last-item (a use names a module OR an item in one). Pure. */
export function resolveImportPath(imp: string, importerModule: string, moduleToFile: Map<string, string>): string | null {
  let abs: string;
  if (imp === 'crate' || imp.startsWith('crate::')) {
    abs = imp;
  } else if (imp === 'self' || imp.startsWith('self::')) {
    const rest = imp === 'self' ? '' : imp.slice('self::'.length);
    abs = rest ? `${importerModule}::${rest}` : importerModule;
  } else if (imp.startsWith('super::')) {
    const parts = imp.split('::');
    let supers = 0;
    while (parts[supers] === 'super') supers++;
    const rest = parts.slice(supers).join('::');
    const base = importerModule.split('::');
    for (let i = 0; i < supers && base.length > 0; i++) base.pop();
    if (base.length === 0) return null; // super above the crate root — invalid
    abs = rest ? `${base.join('::')}::${rest}` : base.join('::');
  } else {
    return null; // external crate (std, serde, …) — not an internal edge
  }

  // A `use` names a module OR an item in one: try the full path (module import),
  // then full-minus-last (item in a module). Don't fall further back — `crate::a::b::c`
  // resolving to the crate root would be a false edge.
  const segs = abs.split('::');
  return moduleToFile.get(segs.join('::')) ?? moduleToFile.get(segs.slice(0, -1).join('::')) ?? null;
}

/** Rust importer — tree-sitter extraction + module→file resolution via ownership. */
export const rustImporter = createTreeSitterImporter({
  extensions: ['.rs'],
  wasmBasename: 'tree-sitter-rust.wasm',
  fileToModule,
  extractEdges: (root, sourcePath, importerModule, moduleToFile) => {
    const edges: ImportEdge[] = [];
    for (const imp of extractImports(root)) {
      const toFile = resolveImportPath(imp, importerModule, moduleToFile);
      if (toFile && toFile !== sourcePath) edges.push({ fromFile: sourcePath, toFile, import: imp });
    }
    return edges;
  },
});
