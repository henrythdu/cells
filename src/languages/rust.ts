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
  const m = toModule(rel);
  // bin+lib crate: lib.rs is the canonical item root, but both files map to `crate` and the
  // factory's last-set-wins (sorted order) hands the key to main.rs — root-item imports
  // (`use crate::Item`) would then edge to the bin, not the lib. Map main.rs to `crate::main`
  // when a sibling lib.rs exists so `crate` resolves to lib.rs; a bin-only crate keeps `crate`.
  if (m === 'crate' && basename(path) === 'main.rs' && existsSync(join(baseDir, dirname(path), 'lib.rs'))) {
    return 'crate::main';
  }
  return m;
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
      // children: a path + a use_list. The path is scoped_identifier|identifier for `a::b`, but
      // the keyword roots `super`/`self`/`crate` are their OWN node types (`use super::{A,B}`) —
      // matching only identifier/scoped_identifier silently drops the prefix and the items
      // resolve as bare first segments (false root edges). Accept all three.
      const pathNode = node.namedChildren.find((c) => c.type === 'scoped_identifier' || c.type === 'identifier' || c.type === 'super' || c.type === 'self' || c.type === 'crate');
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

/** The module key that anchors `crate::` for a file: the deepest ancestor module (or the file
 *  itself) whose target file is a crate ROOT — lib.rs/main.rs, or a file directly under
 *  tests/benches/examples. Integration tests are separate crates: `crate::http_util` in
 *  tests/it/ssl_certs.rs anchors to the `tests/it` dir (whose root file is tests/it/main.rs),
 *  NOT the lib's root (stress: uv-client's 8). Falls back to null (caller uses the
 *  namespace's first segment). Pure over the module map. */
function crateRootOfModule(importerModule: string, moduleToFile: Map<string, string>): string | null {
  const parts = importerModule.split('::');
  const inTestsDir = (dir: string) => /(^|\/)(tests|benches|examples)(\/|$)/.test(dir);
  const directBoundary = (dir: string) => /(^|\/)(tests|benches|examples)$/.test(dir);
  for (let i = parts.length; i >= 1; i--) {
    const key = parts.slice(0, i).join('::');
    const file = moduleToFile.get(key);
    if (file) {
      const base = file.split('/').pop() ?? '';
      const dir = file.slice(0, file.lastIndexOf('/'));
      if (base === 'lib.rs' || base === 'main.rs') {
        // a lib/main under tests/ is the test crate's root FILE — but `crate::` anchors to
        // the enclosing dir namespace (its modules are siblings of main, not children); at
        // i === 1 there is no enclosing dir — this module IS the crate root
        if (inTestsDir(dir)) return i > 1 ? parts.slice(0, i - 1).join('::') : key;
        // a normal-crate root file: `crate::` anchors to the crate NAMESPACE (first segment).
        // key === parts[0] for lib.rs, but a bin alongside a lib maps to `crate::main` —
        // its own crate:: imports still anchor to `crate` (the shared module files).
        return parts[0];
      }
      // a file directly in the tests/ boundary is its own crate root (each tests/*.rs is one)
      if (directBoundary(dir)) return key;
    }
    // a sibling main.rs/lib.rs in a tests-ish dir marks THIS dir as a crate root
    // (tests/it/main.rs is the root of every module under tests/it)
    const sibling = moduleToFile.get(`${key}::main`) ?? moduleToFile.get(`${key}::lib`);
    if (sibling && inTestsDir(sibling.slice(0, sibling.lastIndexOf('/')))) return key;
  }
  return null;
}

/** Classify a use path + resolve it to an absolute module path.
 *  `crate::` is already absolute (anchored to the importer's crate root — the lib root, or the
 *  test/bench/example crate's own root when the file lives there); `self::`/`super::` are
 *  relative to the importer; a bare first segment that names a workspace member crate
 *  (`use sibling_crate::…`) is a cross-crate internal import (resolved via the factory's
 *  name→module aliases); anything else is an external crate (std, serde, …) → null. Pure. */
function absoluteModulePath(imp: string, importerModule: string, crateNames: ReadonlySet<string>, moduleToFile?: Map<string, string>): string | null {
  if (imp === 'crate' || imp.startsWith('crate::')) {
    // the crate root anchor — test crates anchor differently from lib files
    const root = moduleToFile ? crateRootOfModule(importerModule, moduleToFile) : null;
    const ns = root ?? importerModule.split('::')[0];
    if (ns !== 'crate') return imp === 'crate' ? ns : `${ns}::${imp.slice('crate::'.length)}`;
    return imp;
  }
  if (imp === 'self' || imp.startsWith('self::')) {
    const rest = imp === 'self' ? '' : imp.slice('self::'.length);
    return rest ? `${importerModule}::${rest}` : importerModule;
  }
  if (imp === 'super' || imp.startsWith('super::')) return resolveSuper(imp, importerModule);
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
 *  Matches the module OR the deepest owned module prefix — a use names a module OR an item
 *  chain in one (`crate::token::TokenKind::Wildcard` = an enum variant inside the module
 *  `crate::token`; stress #5). Trailing segments are dropped until a module in the map is
 *  found, but never below 2 — a path whose only map hit is the crate root has no real
 *  intermediate module (broken import: stays unresolved; a root edge would be a false hit).
 *  `reexports` = pub-use alias map (module → alias → absolute target) — followed through
 *  chains so `pub use service::osv;` + `use crate::osv::Filter` both resolve. Pure. */
/** Bare first segment (`use tokenization::foo` inside crate::reading) — Rust resolves it
 *  MODULE-RELATIVE, walking up the importer's module chain (crate::reading::tokenization,
 *  then crate::tokenization, then the root). Returns the absolute path of the first ancestor
 *  under which the first segment names a real module, else null. The probe must test that
 *  `ancestor::firstSeg` is a real module key — NOT look()'s prefix-fallback, which would match
 *  the ancestor itself (a false self-import). An external crate's first segment is never a
 *  module under any ancestor → null. Shared by resolveImportPath and collectReexports (the
 *  two must agree — a one-sided fix re-breaks one path silently). */
function resolveBareFirstSegment(effective: string, imp: string, moduleToFile: Map<string, string>): string | null {
  const firstSeg = imp.split('::')[0];
  const effSegs = effective.split('::');
  for (let i = effSegs.length; i >= 1; i--) {
    const probe = `${effSegs.slice(0, i).join('::')}::${firstSeg}`;
    if (moduleToFile.has(probe) || [...moduleToFile.keys()].some((k) => k.startsWith(probe + '::'))) {
      return `${effSegs.slice(0, i).join('::')}::${imp}`;
    }
  }
  return null;
}

export function resolveImportPath(imp: string, importerModule: string, moduleToFile: Map<string, string>, crateNames: ReadonlySet<string> = new Set(), reexports: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map()): string | null {
  // The importer's own crate root (the namespace's first segment: 'crate' or the root path).
  // A 2-segment `crate::Item` resolves to it legitimately (the item lives in root lib.rs); a
  // 3+ segment path with a mid-chain break (`crate::bogus::X`) must NOT fall back to it — that
  // would be a false edge. A DIFFERENT first segment is a workspace sibling's crate-name
  // alias — a real 1-segment target (`turbopath::PathError` = an item in turbopath's lib.rs).
  const ownRoot = importerModule.split('::')[0];
  const look = (a: string): string | null => {
    const exact = moduleToFile.get(a);
    if (exact) return exact;
    const segs = a.split('::');
    for (let i = segs.length - 1; i >= 1; i--) {
      if (i === 1 && segs.length > 2 && segs[0] === ownRoot) return null;
      const hit = moduleToFile.get(segs.slice(0, i).join('::'));
      if (hit) return hit;
    }
    return null;
  };
  let abs: string | null = absoluteModulePath(imp, importerModule, crateNames, moduleToFile);
  // Bare first segment: Rust resolves `use foo::bar` to a crate-LOCAL module when foo isn't
  // an extern crate — module-relative, walking up the importer's chain (wave-3 #2 target —
  // `pub use service::osv` refers to crate::service::osv; Speedy bug 4). No ancestor matches
  // = external crate (std::…, owo_colors) or broken local — null (the old crate-root fallback
  // drew a false edge to the root file for 2-segment externals).
  if (abs === null) abs = resolveBareFirstSegment(importerModule, imp, moduleToFile);
  if (abs === null) return null;
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
 *  rest of the crate (and beyond). Returns absolute target modules (crate-namespaced), registered
 *  under BOTH the namespaced module key and the crate-NAME form — a use addresses `uv_audit::osv::Filter`
 *  by name while the module key is root-path-prefixed. So `use crate::osv::Filter` resolves
 *  through `pub use service::osv;`. Crate-name registration is Rust resolution semantics — it
 *  lives here, not in the generic factory.
 *  A `pub use` of an EXTERNAL crate (`pub use owo_colors;`) is marked `external` (empty target)
 *  instead — the alias points outside the partition, so a chain target would never match a file
 *  and imports routing through it would false-flag as broken local (stress #7). The factory
 *  registers external re-exports in ctx.externalReexports, not the chain map. */
function collectReexports(uses: UseDesc[], sourcePath: string, importerModule: string, ctx: ResolveCtx): Reexport[] {
  const out: Reexport[] = [];
  // The crate root + name are invariant across this file's uses — hoisted out of the loop
  // (crateRootOf walks the FS probing for Cargo.toml; per-use repetition would re-walk).
  const root = crateRootOf(sourcePath, ctx.baseDir ?? '.');
  const name = root && root !== '.' ? ctx.crateNameByRoot?.get(root) : undefined;
  const push = (module: string, target: string, external: boolean, alias: string): void => {
    out.push({ module, alias, target, external });
  };
  for (const { imp, modChain, isPub, alias } of uses) {
    if (!isPub || !alias) continue;
    const effective = modChain.length > 0 ? `${importerModule}::${modChain.join('::')}` : importerModule;
    const target = absoluteModulePath(imp, effective, ctx.crateNames, ctx.moduleToFile);
    let local: boolean;
    let real: string;
    if (target === null) {
      // Bare first segment — either a crate-LOCAL module (`pub use service::osv;`,
      // `pub use tokenization::tokenize_text;`) or an external crate (`pub use owo_colors;`).
      // Rust 2018 resolves it module-relative up the effective module chain; probing only the
      // crate root misclassified a nested re-export as EXTERNAL and every import routed
      // through it was silently dropped (no edge, no unresolved — Speedy bug 4).
      const resolved = resolveBareFirstSegment(effective, imp, ctx.moduleToFile);
      local = resolved !== null;
      real = resolved ?? '';
    } else {
      local = true;
      real = target;
    }
    if (!local) {
      // external crate — the re-export leaves the partition; registered as external (silenced
      // at resolution — stress #7), under both the module key and the crate-name form.
      push(effective, '', true, alias);
      if (name) push(name, '', true, alias);
      continue;
    }
    push(effective, real, false, alias);
    // ALSO under the crate-NAME form: a use addresses `uv_audit::osv::Filter` by name while
    // the module key is root-path-prefixed.
    if (name) {
      const namedTarget = real.startsWith(`${effective}::`) || real === effective ? name + real.slice(effective.length) : real;
      push(name, namedTarget, false, alias);
    }
  }
  return out;
}

/** Does this import route through a re-export of an EXTERNAL crate (an alias registered in
 *  ctx.externalReexports)? The target is real code but outside the partition — no edge to draw
 *  and no broken-local to flag (stress #7: `uv_warnings::owo_colors::OwoColorize` via
 *  `pub use owo_colors;`). Walks the path's module prefixes longest-first. Pure — takes the
 *  already-computed absolute path (callers compute it once per import). */
function isExternalReexport(abs: string, external: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  const segs = abs.split('::');
  for (let i = segs.length - 1; i >= 1; i--) {
    if (external.get(segs.slice(0, i).join('::'))?.has(segs[i])) return true;
  }
  return false;
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
      const abs = absoluteModulePath(imp, effective, ctx.crateNames, ctx.moduleToFile);
      // Routes through a re-export of an EXTERNAL crate? The target is real code but outside
      // the partition — no edge to draw, no broken-local to flag. Checked BEFORE resolution:
      // the deepest-module fallback would otherwise draw a false edge to the re-exporting
      // module (stress #7: `uv_warnings::owo_colors::OwoColorize` → warnings.rs).
      if (abs && isExternalReexport(abs, ctx.externalReexports)) continue;
      const toFile = resolveImportPath(imp, effective, ctx.moduleToFile, ctx.crateNames, ctx.reexports);
      if (toFile && toFile !== sourcePath) {
        edges.push({ fromFile: sourcePath, toFile, import: imp });
      } else if (!toFile && abs !== null) {
        // crate::/self::/super::/workspace-sibling path that didn't resolve to any owned file.
        // (toFile === sourcePath is a self-import — use crate::my_mod::Symbol from within
        // my_mod — not unresolved, just self-referential.)
        unresolved.push({ fromFile: sourcePath, import: imp });
      }
    }
    return { edges, unresolved };
  },
});
