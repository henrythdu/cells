import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language, type Node } from 'web-tree-sitter';
import type { ImportEdge, Importer } from './crossings.js';

// --- grammar singleton (lazy: init web-tree-sitter + load the bundled rust WASM once) ---
let parserPromise: Promise<Parser> | null = null;
async function getParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init();
      // The WASM ships as a static asset in grammars/ (built with tree-sitter-cli 0.26.11 → ABI-matched
      // to web-tree-sitter; the prebuilt tree-sitter-wasms pack is OLD-CLI/incompatible — see memory 155).
      const wasm = join(dirname(fileURLToPath(import.meta.url)), '..', 'grammars', 'tree-sitter-rust.wasm');
      let lang: Language;
      try {
        lang = await Language.load(readFileSync(wasm));
      } catch {
        throw new Error(`Failed to load Rust grammar WASM at ${wasm} — ensure the 'grammars/' directory is bundled with cells.`);
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
 *  Matches the longest module prefix (a use names a module OR an item in one). Pure. */
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
export const rustImporter: Importer = {
  extensions: ['.rs'],
  needsContent: true,
  async extract({ files }): Promise<ImportEdge[]> {
    // Build module-path → file from the census (resolve via the file list, like Python).
    const moduleToFile = new Map<string, string>();
    for (const f of files) if (f.path.endsWith('.rs')) moduleToFile.set(fileToModule(f.path), f.path);

    const parser = await getParser();
    const edges: ImportEdge[] = [];
    for (const f of files) {
      if (!f.path.endsWith('.rs')) continue;
      const importerModule = fileToModule(f.path);
      const tree = parser.parse(f.content);
      if (!tree) continue;
      try {
        const seen = new Set<string>();
        for (const imp of extractImports(tree.rootNode)) {
          const toFile = resolveImportPath(imp, importerModule, moduleToFile);
          if (toFile && toFile !== f.path && !seen.has(toFile)) {
            seen.add(toFile);
            edges.push({ fromFile: f.path, toFile, import: imp });
          }
        }
      } finally {
        tree.delete(); // web-tree-sitter Trees are WASM-backed — free each one to avoid leaking.
      }
    }
    return edges;
  },
};
