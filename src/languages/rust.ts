import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { ImportEdge, UnresolvedImport } from '../imports.js';
import { createTreeSitterImporter, type ResolveCtx, type Reexport } from './tree-sitter.js';

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

/** The crate's Rust-visible name from its Cargo.toml `[package] name` — `use` paths address
 *  crates by this name with hyphens normalized to underscores (`headroom-core` → `headroom_core`),
 *  which need NOT match the directory. Virtual workspace manifests have no [package] → null.
 *  The factory uses it to alias workspace module keys so `use sibling_crate::…` resolves.
 *  LIMITATION: `name.workspace = true` (workspace-inherited name) resolves to null — such a
 *  crate's cross-crate imports stay silently external (pre-fix behavior, not a false positive).
 *  Package names are overwhelmingly literal in practice; revisit if a real repo hits it. */
export function crateNameOf(crateRoot: string, baseDir = '.'): string | null {
  let content: string;
  try {
    content = readFileSync(join(baseDir, crateRoot, 'Cargo.toml'), 'utf8');
  } catch {
    return null;
  }
  const section = content.match(/^\[package\][^[]*/m);
  const name = section?.[0].match(/^\s*name\s*=\s*["']([^"']+)["']/m); // double OR single-quoted TOML string
  return name ? name[1].replace(/-/g, '_') : null;
}

/** `src/…` → `crate::…` per Rust module rules. Pure. */
function toModule(rel: string): string {
  let p = rel.replace(/^src\//, '').replace(/\.rs$/, '');
  if (p.endsWith('/mod')) p = p.slice(0, -'/mod'.length);
  if (p === 'lib' || p === 'main') return 'crate';
  return 'crate::' + p.split('/').join('::');
}

// --- AST → import paths (recursively expand `use` declarations) ---

/** One expanded use path: the `::`-joined import + the exposed re-export name (explicit `as`
 *  alias when present) + a glob marker (`pub use foo::*` re-exports every public item — not
 *  representable as a single alias, so re-export registration must skip it). */
interface UseClause {
  imp: string;
  alias?: string;
  glob?: boolean;
}

/** Expand a use-clause node into full `::`-separated paths. scoped_identifier/identifier → [text];
 *  scoped_use_list → path × each item (aliases propagate: `a::{b as x}` → {imp: 'a::b', alias: 'x'});
 *  use_as_clause → the inner path + the explicit alias; use_wildcard → its module, marked glob. */
function expandClause(node: Node): UseClause[] {
  switch (node.type) {
    case 'scoped_identifier':
    case 'identifier':
      return [{ imp: node.text }];
    case 'scoped_use_list': {
      // children: a path (scoped_identifier|identifier) + a use_list
      const pathNode = node.namedChildren.find((c) => c.type === 'scoped_identifier' || c.type === 'identifier');
      const listNode = node.namedChildren.find((c) => c.type === 'use_list');
      const prefix = pathNode ? pathNode.text : '';
      const items = listNode ? listNode.namedChildren.flatMap(expandClause) : [];
      return items.map((it) => ({ ...it, imp: prefix ? `${prefix}::${it.imp}` : it.imp }));
    }
    case 'use_list':
      return node.namedChildren.flatMap(expandClause);
    case 'use_as_clause': {
      // `<path> as <alias>` — the path is the first named child, the alias the `alias` field
      const inner = node.namedChildren[0];
      const alias = node.childForFieldName('alias')?.text;
      return inner ? expandClause(inner).map((p) => ({ ...p, alias: alias ?? p.alias })) : [];
    }
    case 'use_wildcard': {
      // `crate::app::*` → the module `crate::app` (glob marker set); bare `*` → nothing precise
      const t = node.text.replace(/::\*$/, '');
      return t === '*' ? [] : [{ imp: t, glob: true }];
    }
    default:
      return [];
  }
}

/** A use declaration: the import path + the enclosing inline-mod chain (for super/self
 *  arithmetic — `mod tests { use super::super::ir::X }` sits two levels above the file) +
 *  pub-use alias info (for re-export chains). */
interface UseDesc {
  imp: string;
  modChain: string[];
  isPub: boolean;
  alias?: string; // explicit `as` alias (pub use x as y)
}

/** All import paths declared anywhere in a Rust file (internal + external). `collectUses` walks
 *  the whole AST recursively, so `use` inside fn bodies AND inline `mod {}` blocks counts. */
function extractUses(root: Node): UseDesc[] {
  const out: UseDesc[] = [];
  collectUses(root, out, []);
  return out;
}

/** Recursively walk the AST — local `use` inside function bodies must be found, and inline
 *  mod blocks deepen the module (super/self arithmetic + re-export locations). */
function collectUses(node: Node, out: UseDesc[], modChain: string[]): void {
  if (node.type === 'use_declaration') {
    // pub, pub(crate), pub(super), pub(in …) all expose the re-export to the crate; private use
    // declarations have no visibility_modifier node at all, so any present one is pub-something.
    const isPub = node.namedChildren.some((c) => c.type === 'visibility_modifier' && c.text.startsWith('pub'));
    for (const child of node.namedChildren) {
      if (child.type === 'visibility_modifier') continue;
      for (const { imp, alias: explicit, glob } of expandClause(child)) {
        // Re-export name: the explicit `as` alias, else the last path segment for a bare pub use;
        // a glob re-exports every public item — not representable as one alias, so none is set.
        const alias = explicit ?? (isPub && !glob ? imp.split('::').pop() : undefined);
        out.push({ imp, modChain, isPub, alias });
      }
    }
    return; // use_declaration children are just path segments — no deeper uses
  }
  if (node.type === 'mod_item') {
    const body = node.childForFieldName('body');
    if (body) {
      const name = node.childForFieldName('name')?.text;
      collectUses(body, out, name ? [...modChain, name] : modChain);
      return; // don't double-walk the body
    }
  }
  for (const child of node.namedChildren) collectUses(child, out, modChain);
}

// --- resolution: import path + importer module → file (via the module→file map) ---

/** Classify a use path + resolve it to an absolute module path.
 *  `crate::` is already absolute (namespaced to the importer's crate root in workspaces);
 *  `self::`/`super::` are relative to the importer; a bare first segment that names a
 *  workspace member crate (`use sibling_crate::…`) is a cross-crate internal import
 *  (resolved via the factory's name→module aliases); anything else is an external crate
 *  (std, serde, …) → null. Pure. */
function absoluteModulePath(imp: string, importerModule: string, crateNames: ReadonlySet<string>): string | null {
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
  return crateNames.has(imp.split('::')[0]) ? imp : null; // workspace sibling, or external (std, serde, …)
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
 *  no further fall-back, since `crate::a::b::c` reaching the crate root would be a false edge.
 *  `reexports` = pub-use alias map (module → alias → absolute target) — followed through
 *  chains so `pub use service::osv;` + `use crate::osv::Filter` both resolve. Pure. */
export function resolveImportPath(imp: string, importerModule: string, moduleToFile: Map<string, string>, crateNames: ReadonlySet<string> = new Set(), reexports: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map()): string | null {
  const look = (a: string): string | null => {
    const segs = a.split('::');
    return moduleToFile.get(segs.join('::')) ?? moduleToFile.get(segs.slice(0, -1).join('::')) ?? null;
  };
  let abs = absoluteModulePath(imp, importerModule, crateNames) ?? `${importerModule.split('::')[0]}::${imp}`;
  // Bare first segment: Rust resolves `use foo::bar` to a crate-LOCAL module when foo isn't
  // an extern crate (wave-3 #2 target — `pub use service::osv` refers to crate::service::osv).
  // The fallback probes the crate-namespaced path — an external crate never has one, so no
  // false edge.
  // Direct hit wins — re-export rewriting only on miss, else item aliases (e.g. a function
  // named `metadata`) would hijack genuine module references like `crate::metadata::X`.
  const direct = look(abs);
  if (direct) return direct;
  // Follow pub-use re-export chains (bounded): crate::osv → service::osv via `pub use service::osv`.
  if (reexports.size > 0) {
    for (let i = 0; i < 10; i++) {
      const segs = abs.split('::');
      let next: string = abs;
      for (let j = segs.length - 1; j >= 1; j--) {
        const target = reexports.get(segs.slice(0, j).join('::'))?.get(segs[j]);
        if (target) {
          next = `${target}::${segs.slice(j + 1).join('::')}`.replace(/::$/, '');
          break;
        }
      }
      if (next === abs) return null;
      abs = next;
      const hit = look(abs);
      if (hit) return hit;
    }
  }
  return null;
}

/** All `mod` declarations (inline blocks + `mod x;` file declarations), recursively, with
 *  their path chain relative to this file. Inline → targetFile null (module lives here);
 *  `mod x;` → the standard rust target: `name/` dir for a file-module (`src/frontend.rs` →
 *  `src/frontend/parser.rs`), the file's own dir for a mod.rs (`src/frontend/mod.rs` →
 *  `src/frontend/parser.rs`). Missing → null (nothing to map). Feeds the module→file map so
 *  deep `crate::a::b::c` paths (items inside nested mods) resolve to the file containing the
 *  deepest module instead of false "unresolved". */
function collectModDecls(root: Node, sourcePath: string, fileSet: ReadonlySet<string>): { path: string[]; targetFile: string | null }[] {
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

/** Pub-use re-exports: `pub use <path> [as <alias>];` — the alias this module exposes to the
 *  rest of the crate (and beyond). Returns absolute target modules (crate-namespaced; external
 *  crates get a bogus-but-harmless crate:: path that never matches a file), registered under
 *  BOTH the namespaced module key and the crate-NAME form — a use addresses `uv_audit::osv::Filter`
 *  by name while the module key is root-path-prefixed. So `use crate::osv::Filter` resolves
 *  through `pub use service::osv;`. Crate-name registration is Rust resolution semantics — it
 *  lives here, not in the generic factory. */
function collectReexports(uses: UseDesc[], sourcePath: string, importerModule: string, ctx: ResolveCtx): Reexport[] {
  const out: Reexport[] = [];
  // The crate root + name are invariant across this file's uses — hoisted out of the loop
  // (crateRootOf walks the FS probing for Cargo.toml; per-use repetition would re-walk).
  const root = crateRootOf(sourcePath, ctx.baseDir ?? '.');
  const name = root && root !== '.' ? ctx.crateNameByRoot?.get(root) : undefined;
  for (const { imp, modChain, isPub, alias } of uses) {
    if (!isPub || !alias) continue;
    const effective = modChain.length > 0 ? `${importerModule}::${modChain.join('::')}` : importerModule;
    const ns = effective.split('::')[0];
    const target = absoluteModulePath(imp, effective, ctx.crateNames) ?? `${ns}::${imp}`; // local module or (harmlessly wrong) external
    out.push({ module: effective, alias, target });
    // ALSO under the crate-NAME form: a use addresses `uv_audit::osv::Filter` by name while
    // the module key is root-path-prefixed.
    if (name) {
      const namedTarget = target.startsWith(`${effective}::`) || target === effective ? name + target.slice(effective.length) : target;
      out.push({ module: name, alias, target: namedTarget });
    }
  }
  return out;
}

/** Rust importer — tree-sitter analysis + module→file resolution via ownership. */
export const rustImporter = createTreeSitterImporter<UseDesc[]>({
  name: 'rust',
  extensions: ['.rs'],
  wasmBasename: 'tree-sitter-rust.wasm',
  fileToModule,
  crateRootOf,
  crateNameOf,
  analyze: (root, sourcePath, importerModule, ctx) => {
    const uses = extractUses(root); // one walk — reused for re-exports AND resolution
    return {
      mods: collectModDecls(root, sourcePath, ctx.files),
      reexports: collectReexports(uses, sourcePath, importerModule, ctx),
      uses,
    };
  },
  resolveEdges: (uses, sourcePath, importerModule, ctx) => {
    const edges: ImportEdge[] = [];
    const unresolved: UnresolvedImport[] = [];
    for (const { imp, modChain } of uses) {
      // Inline mod blocks deepen the importer's module — super/self arithmetic must count
      // them (wave-3 #1: `mod tests { use super::super::ir::X }` is 2 levels above the file).
      const effective = modChain.length > 0 ? `${importerModule}::${modChain.join('::')}` : importerModule;
      const toFile = resolveImportPath(imp, effective, ctx.moduleToFile, ctx.crateNames, ctx.reexports);
      if (toFile && toFile !== sourcePath) {
        edges.push({ fromFile: sourcePath, toFile, import: imp });
      } else if (!toFile && absoluteModulePath(imp, effective, ctx.crateNames) !== null) {
        // crate::/self::/super::/workspace-sibling path that didn't resolve to any owned file.
        // (toFile === sourcePath is a self-import — use crate::my_mod::Symbol from within
        // my_mod — not unresolved, just self-referential.)
        unresolved.push({ fromFile: sourcePath, import: imp });
      }
    }
    return { edges, unresolved };
  },
});
