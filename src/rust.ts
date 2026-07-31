import { existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { ImportEdge, UnresolvedImport } from './imports.js';
import { createTreeSitterImporter } from './tree-sitter.js';

// --- module-path derivation: file → Rust module path ---

/** Nearest ancestor dir holding a Cargo.toml → the crate root; null if none (scan root is
 *  not inside a crate). The walk starts at the file's dir and probes `baseDir`-relative
 *  (repo-relative paths; baseDir may point at an extracted HEAD tree for --diff).
 *  No cache — files-per-run is small and a cache would leak across baseDirs. */
function findCrateRoot(filePath: string, baseDir: string): string | null {
  let dir = dirname(filePath);
  for (;;) {
    if (existsSync(join(baseDir, dir, 'Cargo.toml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `crate-relative/src/lib.rs`|`main.rs` → `crate`; `src/app/mod.rs` → `crate::app`;
 *  `src/reading/tokenization.rs` → `crate::reading::tokenization`. Resolves the crate root
 *  by walking up for Cargo.toml — handles monorepos (crates/<name>/src/…) without
 *  hardcoding layout. Falls back to legacy `src/`-strip when no Cargo.toml is found
 *  (scan root is the crate root). Multi-crate workspaces are namespaced by the FACTORY
 *  (it sees all files; fileToModule can't know there are other crates).
 *  Pure-ish: reads FS for the Cargo.toml probe. */
export function fileToModule(path: string, _moduleRoot?: string, baseDir = '.'): string {
  const crateRoot = findCrateRoot(path, baseDir);
  if (!crateRoot) return toModule(path); // no Cargo.toml — legacy: scan root is the crate
  const rel = crateRoot === '.' ? path : path.slice(crateRoot.length + 1);
  return toModule(rel);
}

/** The crate root a file belongs to (or null when the scan root isn't inside a crate).
 *  The factory uses it to namespace module keys when a run spans multiple crates. */
export function crateRootOf(path: string, baseDir = '.'): string | null {
  return findCrateRoot(path, baseDir);
}

/** `src/…` → `crate::…` per Rust module rules. Pure. */
function toModule(rel: string): string {
  let p = rel.replace(/^src\//, '').replace(/\.rs$/, '');
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

/** All import paths declared anywhere in a Rust file (internal + external). `collectUses` walks the whole AST recursively, so `use` inside fn bodies counts. */
function extractImports(root: Node): string[] {
  const out: string[] = [];
  collectUses(root, out);
  return out;
}

/** Recursively walk the AST — local `use` inside function bodies must be found. */
function collectUses(node: Node, out: string[]): void {
  if (node.type === 'use_declaration') {
    for (const child of node.namedChildren) out.push(...expandClause(child));
    return; // use_declaration children are just path segments — no deeper uses
  }
  for (const child of node.namedChildren) collectUses(child, out);
}

// --- resolution: import path + importer module → file (via the module→file map) ---

/** Classify a use path + resolve it to an absolute module path.
 *  `crate::` is already absolute (namespaced to the importer's crate root in workspaces);
 *  `self::`/`super::` are relative to the importer; anything else is an external crate
 *  (std, serde, …) → null. Pure. */
function absoluteModulePath(imp: string, importerModule: string): string | null {
  if (imp === 'crate' || imp.startsWith('crate::')) {
    // workspace namespace = first segment of the importer's module (e.g. `crates/a::app` → `crates/a`);
    // plain `crate` = the legacy single-crate key, unchanged.
    const ns = importerModule.split('::')[0];
    if (ns !== 'crate') return imp === 'crate' ? ns : `${ns}::${imp.slice('crate::'.length)}`;
    return imp;
  }
  if (imp === 'self' || imp.startsWith('self::')) {
    const rest = imp === 'self' ? '' : imp.slice('self::'.length);
    return rest ? `${importerModule}::${rest}` : importerModule;
  }
  if (imp.startsWith('super::')) return resolveSuper(imp, importerModule);
  return null; // external crate (std, serde, …) — not an internal edge
}

/** Resolve one-or-more `super::` relative to the importer module; null if it escapes the crate root.
 *  In namespaced modules the FIRST segment is the crate root — never pop it. */
function resolveSuper(imp: string, importerModule: string): string | null {
  const parts = imp.split('::');
  let supers = 0;
  while (parts[supers] === 'super') supers++;
  const rest = parts.slice(supers).join('::');
  const base = importerModule.split('::');
  const min = base[0] === 'crate' ? 0 : 1; // keep the crate-root segment in workspaces
  for (let i = 0; i < supers && base.length > min; i++) base.pop();
  if (base.length <= min && supers > base.length - min) return null;
  return rest ? `${base.join('::')}::${rest}` : base.join('::');
}

/** Resolve a Rust use path to a source file via the module→file map.
 *  Matches the module OR module-minus-last-item (a use names a module OR an item in one) —
 *  no further fall-back, since `crate::a::b::c` reaching the crate root would be a false edge. Pure. */
export function resolveImportPath(imp: string, importerModule: string, moduleToFile: Map<string, string>): string | null {
  const abs = absoluteModulePath(imp, importerModule);
  if (abs === null) return null;
  const segs = abs.split('::');
  return moduleToFile.get(segs.join('::')) ?? moduleToFile.get(segs.slice(0, -1).join('::')) ?? null;
}

/** All `mod` declarations (inline blocks + `mod x;` file declarations), recursively, with
 *  their path chain relative to this file. Inline → targetFile null (module lives here);
 *  `mod x;` → the standard rust target: `name/` dir for a file-module (`src/frontend.rs` →
 *  `src/frontend/parser.rs`), the file's own dir for a mod.rs (`src/frontend/mod.rs` →
 *  `src/frontend/parser.rs`). Missing → null (nothing to map). Feeds the module→file map so
 *  deep `crate::a::b::c` paths (items inside nested mods) resolve to the file containing the
 *  deepest module instead of false "unresolved". */
function collectModDecls(root: Node, sourcePath: string, fileSet: Set<string>): { path: string[]; targetFile: string | null }[] {
  const out: { path: string[]; targetFile: string | null }[] = [];
  // a file-module (name.rs) nests submodules under name/; mod.rs AND the crate roots
  // (lib.rs/main.rs) use their own dir
  const base = basename(sourcePath);
  const dir = base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs' ? dirname(sourcePath) : sourcePath.slice(0, -'.rs'.length);
  const walk = (node: Node, prefix: string[]): void => {
    for (const child of node.namedChildren) {
      if (child.type !== 'mod_item') continue;
      const name = child.childForFieldName('name')?.text;
      if (!name) continue;
      const chain = [...prefix, name];
      const body = child.childForFieldName('body');
      if (body) {
        out.push({ path: chain, targetFile: null }); // inline block — lives in this file
        walk(body, chain); // nested inline mods chain further
      } else {
        // `mod x;` → sibling file x.rs or dir x/mod.rs
        const sibling = join(dir, `${name}.rs`);
        const dirMod = join(dir, name, 'mod.rs');
        let target: string | null = null;
        if (fileSet.has(sibling)) target = sibling;
        else if (fileSet.has(dirMod)) target = dirMod;
        out.push({ path: chain, targetFile: target });
      }
    }
  };
  walk(root, []);
  return out;
}

/** Rust importer — tree-sitter extraction + module→file resolution via ownership. */
export const rustImporter = createTreeSitterImporter({
  name: 'rust',
  extensions: ['.rs'],
  wasmBasename: 'tree-sitter-rust.wasm',
  fileToModule,
  crateRootOf,
  declareModules: (root, sourcePath, fileSet) => collectModDecls(root, sourcePath, fileSet),
  extractEdges: (root, sourcePath, importerModule, moduleToFile) => {
    const edges: ImportEdge[] = [];
    const unresolved: UnresolvedImport[] = [];
    for (const imp of extractImports(root)) {
      const toFile = resolveImportPath(imp, importerModule, moduleToFile);
      if (toFile && toFile !== sourcePath) {
        edges.push({ fromFile: sourcePath, toFile, import: imp });
      } else if (!toFile && absoluteModulePath(imp, importerModule) !== null) {
        // crate::/self::/super:: path that didn't resolve to any owned file.
        // (toFile === sourcePath is a self-import — use crate::my_mod::Symbol from within
        // my_mod — not unresolved, just self-referential.)
        unresolved.push({ fromFile: sourcePath, import: imp });
      }
    }
    return { edges, unresolved };
  },
});
