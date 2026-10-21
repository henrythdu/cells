import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { ImportEdge, UnresolvedImport } from '../imports.js';
import { createTreeSitterImporter, type Reexport, type ResolveCtx } from './tree-sitter.js';

// --- Module-path derivation: from a file to a Rust module path ---

/** The directories that hold the `[[bin]]` targets of the ROOT manifest. A `[[bin]]` path of
 *  `crates/core/main.rs` gives the directory `crates/core`. A workspace root can attach a
 *  binary to a directory without its own `Cargo.toml` (ripgrep does this), and the binary
 *  directory is then the crate root for the module tree of that binary. In that case,
 *  `mod flags;` in `main.rs` resolves to `crates/core/flags/mod.rs`, and a use path inside
 *  that file works. Without this mapping those files fall to the workspace root crate and
 *  derive bogus modules. The result is memoized per `baseDir`, because `--diff` extracts a
 *  different tree. */
const binCrateDirsMemo = new Map<string, Set<string> | null>();
function binCrateDirs(baseDir: string): Set<string> | null {
  const key = resolve(baseDir); // An absolute path, because baseDir '.' shifts when the tests change directory.
  if (binCrateDirsMemo.has(key)) return binCrateDirsMemo.get(key)!;
  let dirs: Set<string> | null = null;
  try {
    const content = readFileSync(join(key, 'Cargo.toml'), 'utf8');
    // The pattern `(?:(?!^\[\[)[\s\S])*?` never lets the span cross into the next `[[bin]]`
    // block. A `[[bin]]` without a path is legal and defaults to `src/main.rs`.
    const matches = [...content.matchAll(/^\[\[bin\]\]((?:(?!^\[\[)[\s\S])*?)^\s*path\s*=\s*["']([^"']+)["']/gm)];
    if (matches.length > 0) {
      dirs = new Set(matches.map((m) => dirname(m[2]).replace(/^\.\//, '') || '.'));
    }
  } catch {
    /* There is no root manifest. */
  }
  binCrateDirsMemo.set(key, dirs);
  return dirs;
}

/** Return the crate root: the nearest ancestor directory that holds a `Cargo.toml`, or null
 *  when there is none, which means that the scan root is not inside a crate. The walk starts
 *  at the directory of the file and probes paths relative to `baseDir`, which may point at an
 *  extracted HEAD tree for `--diff`. The function keeps no cache, because a run has few files
 *  and a cache would leak across `baseDir` values. */
function findCrateRoot(filePath: string, baseDir: string): string | null {
  let dir = dirname(filePath);
  const bins = binCrateDirs(baseDir);
  for (;;) {
    if (existsSync(join(baseDir, dir, 'Cargo.toml'))) return dir;
    // A `[[bin]]` directory with no manifest of its own is a crate root too. This mapping is
    // harmless for a normal layout: a `[[bin]]` path of `src/main.rs` makes `src/` the root,
    // which derives IDENTICAL modules, because `toModule` strips `src/` and maps `main.rs` to
    // `crate` in the same way as the repository root would.
    if (bins?.has(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Map `crate-relative/src/lib.rs` or `.../main.rs` to `crate`, `src/app/mod.rs` to
 *  `crate::app`, and `src/reading/tokenization.rs` to `crate::reading::tokenization`. The
 *  function finds the crate root by walking up for a `Cargo.toml`, so it handles a monorepo
 *  (`crates/<name>/src/...`) without a hardcoded layout. When no `Cargo.toml` exists, it falls
 *  back to the legacy strip of `src/`, because the scan root is then the crate root. The
 *  FACTORY namespaces a multi-crate workspace, because it sees all files and `fileToModule`
 *  cannot know that other crates exist. The function is mostly pure: it reads the file system
 *  for the `Cargo.toml` probe. */
export function fileToModule(path: string, _moduleRoot?: string, baseDir = '.'): string {
  const crateRoot = findCrateRoot(path, baseDir);
  if (!crateRoot) return toModule(path); // There is no Cargo.toml, so use the legacy rule: the scan root is the crate.
  const rel = crateRoot === '.' ? path : path.slice(crateRoot.length + 1);
  const m = toModule(rel);
  // In a crate with a binary and a library, `lib.rs` is the canonical item root. Both files map
  // to `crate`, and the last-set-wins rule of the factory, with sorted order, gives the key to
  // `main.rs`. An import of a root item (`use crate::Item`) would then edge to the binary and
  // not to the library. The code maps `main.rs` to `crate::main` when a sibling `lib.rs`
  // exists, so `crate` resolves to `lib.rs`. A crate with only a binary keeps `crate`.
  if (m === 'crate' && basename(path) === 'main.rs' && existsSync(join(baseDir, dirname(path), 'lib.rs'))) {
    return 'crate::main';
  }
  return m;
}

/** Return the crate root that a file belongs to, or null when the scan root is not inside a
 *  crate. The factory uses it to namespace the module keys when a run spans multiple crates. */
function crateRootOf(path: string, baseDir = '.'): string | null {
  return findCrateRoot(path, baseDir);
}

/** Return the Rust-visible name of the crate from `[package] name` in its `Cargo.toml`. A use
 *  path addresses a crate by this name, with hyphens changed to underscores (`headroom-core`
 *  becomes `headroom_core`), and the name need not match the directory. A virtual workspace
 *  manifest has no `[package]` section, so the function returns null. The factory uses the
 *  name to alias the workspace module keys, so that `use sibling_crate::...` resolves.
 *
 *  LIMITATION: a workspace-inherited name (`name.workspace = true`) resolves to null, so a
 *  cross-crate import of such a crate stays silently external. This is a documented
 *  limitation and not a false positive. Package names are almost always literal in practice,
 *  so revisit this if a real repository hits it. */
function crateNameOf(crateRoot: string, baseDir = '.'): string | null {
  let content: string;
  try {
    content = readFileSync(join(baseDir, crateRoot, 'Cargo.toml'), 'utf8');
  } catch {
    return null;
  }
  const section = content.match(/^\[package\][^[]*/m);
  const name = section?.[0].match(/^\s*name\s*=\s*["']([^"']+)["']/m); // The TOML string can use double or single quotes.
  return name ? name[1].replace(/-/g, '_') : null;
}

/** Map a `src/...` path to `crate::...` by the module rules of Rust. The function is pure. */
function toModule(rel: string): string {
  let p = rel.replace(/^src\//, '').replace(/\.rs$/, '');
  if (p.endsWith('/mod')) p = p.slice(0, -'/mod'.length);
  if (p === 'lib' || p === 'main') return 'crate';
  return `crate::${p.split('/').join('::')}`;
}

// --- From the AST to the import paths, with recursive expansion of the `use` declarations ---

/** One expanded use path: the import as a `::`-joined string, the name that the re-export
 *  exposes (the explicit `as` alias when there is one), and a glob marker. A `pub use foo::*`
 *  re-exports every public item, which a single alias cannot represent, so the registration of
 *  the re-export must skip it. */
interface UseClause {
  imp: string;
  alias?: string;
  glob?: boolean;
}

/** Expand a node of a use clause into full paths separated by `::`. A scoped_identifier or an
 *  identifier gives its text. A scoped_use_list gives the path times each item, and the
 *  aliases propagate (`a::{b as x}` gives the import `a::b` with the alias `x`). A
 *  use_as_clause gives the inner path and the explicit alias. A use_wildcard gives its module
 *  and sets the glob marker. */
function expandClause(node: Node): UseClause[] {
  switch (node.type) {
    case 'scoped_identifier':
    case 'identifier':
      return [{ imp: node.text }];
    case 'scoped_use_list': {
      // The children are a path and a use_list. The path is a scoped_identifier or an
      // identifier for `a::b`, but the keyword roots `super`, `self`, and `crate` have their
      // OWN node types (`use super::{A,B}`). To match only an identifier or a scoped_identifier
      // would silently drop the prefix, and the items would resolve as bare first segments,
      // which are false edges to the root. Accept all three node types.
      const pathNode = node.namedChildren.find((c) => c.type === 'scoped_identifier' || c.type === 'identifier' || c.type === 'super' || c.type === 'self' || c.type === 'crate');
      const listNode = node.namedChildren.find((c) => c.type === 'use_list');
      const prefix = pathNode ? pathNode.text : '';
      const items = listNode ? listNode.namedChildren.flatMap(expandClause) : [];
      return items.map((it) => ({ ...it, imp: prefix ? `${prefix}::${it.imp}` : it.imp }));
    }
    case 'use_list':
      return node.namedChildren.flatMap(expandClause);
    case 'use_as_clause': {
      // `<path> as <alias>`: the path is the first named child, and the alias is the `alias` field.
      const inner = node.namedChildren[0];
      const alias = node.childForFieldName('alias')?.text;
      return inner ? expandClause(inner).map((p) => ({ ...p, alias: alias ?? p.alias })) : [];
    }
    case 'use_wildcard': {
      // `crate::app::*` becomes the module `crate::app` with the glob marker set. A bare `*` gives nothing precise.
      const t = node.text.replace(/::\*$/, '');
      return t === '*' ? [] : [{ imp: t, glob: true }];
    }
    default:
      return [];
  }
}

/** A use declaration: the import path, the chain of enclosing inline modules (for the
 *  arithmetic of `super` and `self`, because `mod tests { use super::super::ir::X }` sits two
 *  levels above the file), and the alias information of a pub use (for re-export chains). */
interface UseDesc {
  imp: string;
  modChain: string[];
  isPub: boolean;
  alias?: string; // The explicit `as` alias of a pub use, as in `pub use x as y`.
}

/** Return every import path that a Rust file declares, internal and external. `collectUses`
 *  walks the whole AST recursively, so a `use` inside a function body counts, and so does one
 *  inside an inline `mod {}` block. */
function extractUses(root: Node): UseDesc[] {
  const out: UseDesc[] = [];
  collectUses(root, out, []);
  return out;
}

/** Walk the AST recursively. A local `use` inside a function body must be found, and an inline
 *  mod block deepens the module, which matters for the arithmetic of `super` and `self` and
 *  for the location of a re-export. */
function collectUses(node: Node, out: UseDesc[], modChain: string[]): void {
  if (node.type === 'use_declaration') {
    // `pub`, `pub(crate)`, `pub(super)`, and `pub(in ...)` all expose the re-export to the
    // crate. A private use declaration has no visibility_modifier node at all, so any present
    // modifier is a pub form.
    const isPub = node.namedChildren.some((c) => c.type === 'visibility_modifier' && c.text.startsWith('pub'));
    for (const child of node.namedChildren) {
      if (child.type === 'visibility_modifier') continue;
      for (const { imp, alias: explicit, glob } of expandClause(child)) {
        // The re-export name is the explicit `as` alias, or the last segment of the path for a
        // bare pub use. A glob re-exports every public item, which a single alias cannot
        // represent, so no alias is set.
        const alias = explicit ?? (isPub && !glob ? imp.split('::').pop() : undefined);
        out.push({ imp, modChain, isPub, alias });
      }
    }
    return; // The children of a use_declaration are only path segments, so there are no deeper uses.
  }
  if (node.type === 'mod_item') {
    const body = node.childForFieldName('body');
    if (body) {
      const name = node.childForFieldName('name')?.text;
      collectUses(body, out, name ? [...modChain, name] : modChain);
      return; // Do not walk the body two times.
    }
  }
  for (const child of node.namedChildren) collectUses(child, out, modChain);
}

// --- Resolution: from an import path and the importer module to a file, through the module-to-file map ---

/** Return the module key that anchors `crate::` for a file: the deepest ancestor module (or
 *  the file itself) whose target file is a crate ROOT. A crate root file is `lib.rs`,
 *  `main.rs`, or a file directly under `tests/`, `benches/`, or `examples/`.
 *
 *  An integration test is a separate crate. The use `crate::http_util` in
 *  `tests/it/ssl_certs.rs` anchors to the directory `tests/it`, whose root file is
 *  `tests/it/main.rs`, and not to the root of the library. uv-client has eight test crates of
 *  this kind. The function returns null when it finds no anchor, and the caller then uses the
 *  first segment of the namespace. The function is pure over the module map. */
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
        // A lib or main file under tests/ is the root FILE of the test crate. But `crate::`
        // anchors to the namespace of the enclosing directory, because its modules are
        // siblings of main and not children. At i === 1 there is no enclosing directory, so
        // this module IS the crate root.
        if (inTestsDir(dir)) return i > 1 ? parts.slice(0, i - 1).join('::') : key;
        // A root file of a normal crate: `crate::` anchors to the crate NAMESPACE (the first
        // segment). For `lib.rs` the key is `parts[0]`, but a binary next to a library maps to
        // `crate::main`. Its own `crate::` imports still anchor to `crate`, which is the set of
        // shared module files.
        return parts[0];
      }
      // A file directly in the boundary of tests/ is its own crate root, because each
      // `tests/*.rs` file is one crate.
      if (directBoundary(dir)) return key;
    }
    // A sibling `main.rs` or `lib.rs` in a tests-like directory marks THIS directory as a
    // crate root: `tests/it/main.rs` is the root of every module under `tests/it`.
    const sibling = moduleToFile.get(`${key}::main`) ?? moduleToFile.get(`${key}::lib`);
    if (sibling && inTestsDir(sibling.slice(0, sibling.lastIndexOf('/')))) return key;
  }
  return null;
}

/** Classify a use path and resolve it to an absolute module path.
 *
 *  A `crate::` path is already absolute, anchored to the crate root of the importer: the root
 *  of the library, or the root of the test, bench, or example crate when the file lives there.
 *  A `self::` or `super::` path is relative to the importer. A bare first segment that names a
 *  workspace member crate (`use sibling_crate::...`) is an internal import across crates,
 *  resolved through the name-to-module aliases of the factory. Anything else is an external
 *  crate (std, serde, and others), and the function returns null. The function is pure. */
function absoluteModulePath(imp: string, importerModule: string, crateNames: ReadonlySet<string>, moduleToFile?: Map<string, string>): string | null {
  if (imp === 'crate' || imp.startsWith('crate::')) {
    // The anchor of the crate root, which differs for a test crate and for a library file.
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
  return crateNames.has(imp.split('::')[0]) ? imp : null; // A workspace sibling, or an external crate (std, serde, and others).
}

/** Resolve one or more `super::` prefixes relative to the importer module. The function
 *  returns null when the path escapes the crate root. The FIRST segment is always the crate
 *  root (the `crate` keyword, or the namespaced root in a workspace), and the code never pops
 *  it: to land exactly on it is legal (`use super::X` from a module directly under the root),
 *  and only a pop past it escapes. The path therefore escapes when the count of `super`
 *  segments is greater than or equal to the depth of the module. */
function resolveSuper(imp: string, importerModule: string): string | null {
  const parts = imp.split('::');
  let supers = 0;
  while (parts[supers] === 'super') supers++;
  const rest = parts.slice(supers).join('::');
  const base = importerModule.split('::');
  if (supers >= base.length) return null;
  for (let i = 0; i < supers; i++) base.pop();
  return rest ? `${base.join('::')}::${rest}` : base.join('::');
}

/** Resolve a bare first segment, as in `use tokenization::foo` inside `crate::reading`. Rust
 *  resolves it relative to the module, walking up the module chain of the importer
 *  (`crate::reading::tokenization`, then `crate::tokenization`, then the root). The function
 *  returns the absolute path of the first ancestor under which the first segment names a real
 *  module, or null. The probe must test that `ancestor::firstSeg` is a real module key, and it
 *  must not use the prefix fallback of `look`, which would match the ancestor itself and give
 *  a false self-import. The first segment of an external crate is never a module under any
 *  ancestor, so it gives null. `resolveImportPath` and `collectReexports` share this function,
 *  because the two must agree, and a fix on one side alone breaks the other path without an
 *  error. */
function resolveBareFirstSegment(effective: string, imp: string, moduleToFile: Map<string, string>): string | null {
  const firstSeg = imp.split('::')[0];
  const effSegs = effective.split('::');
  for (let i = effSegs.length; i >= 1; i--) {
    const probe = `${effSegs.slice(0, i).join('::')}::${firstSeg}`;
    if (moduleToFile.has(probe) || [...moduleToFile.keys()].some((k) => k.startsWith(`${probe}::`))) {
      return `${effSegs.slice(0, i).join('::')}::${imp}`;
    }
  }
  return null;
}

/** Resolve a Rust use path to a source file through the module-to-file map.
 *
 *  The function matches the module or the deepest owned module prefix. A use path names either
 *  a module or an item chain inside a module, for example an enum variant inside the module
 *  `crate::token`. The function drops the trailing segments until it finds a module in the
 *  map, but never below 2 segments. A path whose only hit in the map is the crate root has no
 *  real intermediate module, so it is a broken import and stays unresolved, because an edge to
 *  the root would be a false hit.
 *
 *  The `reexports` argument is the map of pub-use aliases (module to alias to absolute target),
 *  and the function follows the chains, so `pub use service::osv;` and
 *  `use crate::osv::Filter` both resolve. The function is pure. */
export function resolveImportPath(imp: string, importerModule: string, moduleToFile: Map<string, string>, crateNames: ReadonlySet<string> = new Set(), reexports: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map()): string | null {
  // The crate root of the importer, which is the first segment of the namespace: `crate` or
  // the root path. A two-segment `crate::Item` resolves to it legitimately, because the item
  // lives in the root `lib.rs`. A path of 3 or more segments with a break in the middle
  // (`crate::bogus::X`) must NOT fall back to it, because that would be a false edge. A
  // DIFFERENT first segment is the crate-name alias of a workspace sibling, which is a real
  // one-segment target (`turbopath::PathError` is an item in the `lib.rs` of turbopath).
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
  // A bare first segment: Rust resolves `use foo::bar` to a crate-LOCAL module when foo is not
  // an external crate, relative to the module, walking up the chain of the importer
  // (`pub use service::osv` refers to `crate::service::osv`). No ancestor matches when the
  // crate is external (std::..., owo_colors) or the local import is broken, so the result is
  // null. A fallback to the crate root here would draw a false edge to the root file for an
  // external path of two segments.
  if (abs === null) abs = resolveBareFirstSegment(importerModule, imp, moduleToFile);
  if (abs === null) return null;
  // A direct hit wins, and the code rewrites a re-export only on a miss. Otherwise an item
  // alias, such as a function named `metadata`, would hijack a genuine module reference such
  // as `crate::metadata::X`.
  const direct = look(abs);
  if (direct) return direct;
  // Follow the chains of pub-use re-exports, with a bound: `crate::osv` becomes `service::osv` through `pub use service::osv`.
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

/** Return all `mod` declarations (inline blocks and `mod x;` file declarations), recursively,
 *  with the chain of their paths relative to this file. An inline block names this file as
 *  its target, because the module lives here. A `mod x;` gives the standard Rust target: the
 *  directory `name/` for a file module (`src/frontend.rs` gives `src/frontend/parser.rs`),
 *  and the directory of the file itself for a `mod.rs` (`src/frontend/mod.rs` gives
 *  `src/frontend/parser.rs`). A missing file gives null, and the importer then reports an
 *  import of that module as unresolved, because a false edge to any file would hide it.
 *
 *  The declarations feed the module-to-file map, so a deep `crate::a::b::c` path, which names
 *  an item inside nested mods, resolves to the file that holds the deepest module, and not to
 *  a false "unresolved". */
function collectModDecls(root: Node, sourcePath: string, fileSet: ReadonlySet<string>): { path: string[]; targetFile: string | null }[] {
  const out: { path: string[]; targetFile: string | null }[] = [];
  // A file module (`name.rs`) nests its submodules under `name/`. A `mod.rs` file and the crate
  // roots (`lib.rs` and `main.rs`) use their own directory.
  const base = basename(sourcePath);
  const dir = base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs' ? dirname(sourcePath) : sourcePath.slice(0, -'.rs'.length);
  const walk = (node: Node, prefix: string[]): void => {
    let pathAttr: string | null = null; // A `#[path = "..."]` attribute that belongs to the next item.
    for (const child of node.namedChildren) {
      // An outer attribute is a sibling that precedes the item it decorates. More than one can
      // stack, in any order (`#[path]` then `#[cfg(unix)]` is common), so a later attribute
      // keeps the pending path and does not clear it.
      if (child.type === 'attribute_item') {
        const m = child.text.match(/^#\[\s*path\s*=\s*"([^"]+)"\s*\]/);
        if (m) pathAttr = m[1];
        continue;
      }
      if (child.type !== 'mod_item') {
        pathAttr = null; // The attribute decorated something else.
        continue;
      }
      const name = child.childForFieldName('name')?.text;
      if (!name) continue;
      const chain = [...prefix, name];
      const declared = pathAttr; // Consume it, so a later `mod` without an attribute does not inherit it.
      pathAttr = null;
      const body = child.childForFieldName('body');
      if (body) {
        out.push({ path: chain, targetFile: sourcePath }); // An inline block, which lives in this file.
        walk(body, chain); // A nested inline mod chains further.
      } else {
        // `mod x;` points to the sibling file `x.rs` or the directory module `x/mod.rs`, unless
        // `#[path = "..."]` names the file. That attribute is relative to the directory of the
        // declaring file. The `join()` call emits a backslash on Windows, so normalize the path
        // to posix: the keys of `fileSet` come from the census, which is posix-normalized, so a
        // sibling with a backslash never matches.
        const sibling = join(dir, `${name}.rs`).replace(/\\/g, '/');
        const dirMod = join(dir, name, 'mod.rs').replace(/\\/g, '/');
        const attrTarget = declared === null ? null : join(dirname(sourcePath), declared).replace(/\\/g, '/');
        let target: string | null = null;
        if (attrTarget !== null && fileSet.has(attrTarget)) target = attrTarget;
        else if (fileSet.has(sibling)) target = sibling;
        else if (fileSet.has(dirMod)) target = dirMod;
        out.push({ path: chain, targetFile: target });
      }
    }
  };
  walk(root, []);
  return out;
}

/** Collect the pub-use re-exports, `pub use <path> [as <alias>];`, which are the aliases that
 *  this module exposes to the rest of the crate and beyond. The function returns absolute
 *  target modules with the crate namespace, and it registers each one under BOTH the
 *  namespaced module key and the crate-NAME form. A use path addresses
 *  `uv_audit::osv::Filter` by name, while the module key carries the root-path prefix, so
 *  `use crate::osv::Filter` resolves through `pub use service::osv;`. The registration under
 *  the crate name follows the resolution semantics of Rust, so it lives here and not in the
 *  generic factory.
 *
 *  A `pub use` of an EXTERNAL crate (`pub use owo_colors;`) is marked `external` and has an
 *  empty target instead, because the alias points outside the partition. A chain target would
 *  then never match a file, and an import that routes through the alias would raise a false
 *  broken-local flag. The factory registers an external re-export in `ctx.externalReexports`
 *  and not in the chain map. */
function collectReexports(uses: UseDesc[], sourcePath: string, importerModule: string, ctx: ResolveCtx): Reexport[] {
  const out: Reexport[] = [];
  // The crate root and the crate name are invariant across the uses of this file, so hoist them
  // out of the loop. `crateRootOf` walks the file system to probe for `Cargo.toml`, and a
  // repetition per use would walk again.
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
      // A bare first segment, which is either a crate-LOCAL module (`pub use service::osv;` or
      // `pub use tokenization::tokenize_text;`) or an external crate (`pub use owo_colors;`).
      // Rust 2018 resolves it relative to the module, up the chain of effective modules. A
      // probe of the crate root only misclassified a nested re-export as EXTERNAL, and every
      // import that routed through it was silently dropped: no edge and no unresolved import.
      // This was a real failure mode in a workspace.
      const resolved = resolveBareFirstSegment(effective, imp, ctx.moduleToFile);
      local = resolved !== null;
      real = resolved ?? '';
    } else {
      local = true;
      real = target;
    }
    if (!local) {
      // The external crate: the re-export leaves the partition, so register it as external,
      // which silences it at resolution, under both the module key and the crate-name form.
      push(effective, '', true, alias);
      if (name) push(name, '', true, alias);
      continue;
    }
    push(effective, real, false, alias);
    // Register ALSO under the crate-NAME form: a use path addresses `uv_audit::osv::Filter` by
    // name, while the module key carries the root-path prefix.
    if (name) {
      const namedTarget = real.startsWith(`${effective}::`) || real === effective ? name + real.slice(effective.length) : real;
      push(name, namedTarget, false, alias);
    }
  }
  return out;
}

/** Say whether this import routes through a re-export of an EXTERNAL crate, which is an alias
 *  registered in `ctx.externalReexports`. The target is real code but outside the partition,
 *  so there is no edge to draw and no broken-local flag to raise. The example is
 *  `uv_warnings::owo_colors::OwoColorize` through `pub use owo_colors;`. The function walks
 *  the module prefixes of the path, longest first. It is pure and takes the absolute path that
 *  is already computed, which the callers compute one time per import. */
function isExternalReexport(abs: string, external: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  const segs = abs.split('::');
  for (let i = segs.length - 1; i >= 1; i--) {
    if (external.get(segs.slice(0, i).join('::'))?.has(segs[i])) return true;
  }
  return false;
}

/** The Rust importer: tree-sitter analysis and module-to-file resolution through ownership. */
export const rustImporter = createTreeSitterImporter<UseDesc[]>({
  name: 'rust',
  extensions: ['.rs'],
  wasmBasename: 'tree-sitter-rust.wasm',
  fileToModule,
  crateRootOf,
  crateNameOf,
  analyze: (root, sourcePath, importerModule, ctx) => {
    const uses = extractUses(root); // One walk, reused for the re-exports AND the resolution.
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
      // An inline mod block deepens the module of the importer, and the arithmetic of `super`
      // and `self` must count it: `mod tests { use super::super::ir::X }` is two levels above
      // the file.
      const effective = modChain.length > 0 ? `${importerModule}::${modChain.join('::')}` : importerModule;
      const abs = absoluteModulePath(imp, effective, ctx.crateNames, ctx.moduleToFile);
      // Does the import route through a re-export of an EXTERNAL crate? The target is real code
      // but outside the partition, so there is no edge to draw and no broken-local flag to
      // raise. The check runs BEFORE the resolution, because the fallback to the deepest module
      // would otherwise draw a false edge to the re-exporting module
      // (`uv_warnings::owo_colors::OwoColorize` would edge to `warnings.rs`).
      if (abs && isExternalReexport(abs, ctx.externalReexports)) continue;
      const toFile = resolveImportPath(imp, effective, ctx.moduleToFile, ctx.crateNames, ctx.reexports);
      if (toFile && toFile !== sourcePath) {
        // The symbol data for the off-membrane check. When the own module key of the use path
        // misses but a shorter prefix resolves (`use a::b::Item` gives `b.rs`), the tail is the
        // consumed item, so audit it against the provides of the target cell. An exact-key hit
        // is a module dependency, with no named surface consumed.
        const symbols = abs !== null && ctx.moduleToFile.get(abs) !== toFile ? [abs.split('::').pop() ?? ''] : undefined;
        edges.push({ fromFile: sourcePath, toFile, import: imp, ...(symbols ? { symbols } : {}) });
      } else if (!toFile && abs !== null) {
        // A `crate::`, `self::`, `super::`, or workspace-sibling path that did not resolve to
        // any owned file. A target equal to the source path is a self-import, which is a use of
        // a symbol from the same module, and it is not unresolved.
        unresolved.push({ fromFile: sourcePath, import: imp });
      }
    }
    return { edges, unresolved };
  },
});
