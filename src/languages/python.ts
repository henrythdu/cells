import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { ImportEdge, UnresolvedImport } from '../imports.js';
import { createTreeSitterImporter, nearestCandidate, type ResolveCtx } from './tree-sitter.js';

// --- Module-path derivation: from a file to a Python module path ---

/** Map `src/domain/symbol.py` to `src.domain.symbol`, and `src/domain/__init__.py` to
 *  `src.domain`. With `moduleRoot` (for example `"src"`), `src/domain/symbol.py` becomes
 *  `domain.symbol`, which serves the src layout of Python.
 *
 *  For Cython, `algos.pyx` and `algos.pxd` become `algos`. The pair of a `.pyx` file and its
 *  `.pxd` file is one module, so both files intentionally map to the same key. The sorted
 *  order of the factory makes the `.pyx` implementation win. */
export function fileToModule(path: string, moduleRoot?: string): string {
  let p = path.replace(/\.(py|pyx|pxd)$/, '');
  if (moduleRoot && p.startsWith(`${moduleRoot}/`)) p = p.slice(moduleRoot.length + 1);
  const parts = p.split('/').filter(Boolean);
  if (parts[parts.length - 1] === '__init__') parts.pop();
  return parts.join('.');
}

// --- From the AST to the import descriptors ---

interface ImportDesc {
  dots: number; // 0 is absolute. A value above 0 is the count of leading dots in a `from .` import.
  module: string; // The dotted path after the leading dots. Empty for a bare `from . import x`.
  names: string[]; // The imported names. For `from M import a, b`, the resolver tries the submodules M.a and M.b.
}

/** A namespace-like binding, from a local name to the gate module whose edge carries its
 *  attribute tails. `import views as v` makes `v` the module `views`, and `from m import a`
 *  makes `a` the module `m.a`. The attachment needs an edge whose import equals the path,
 *  which is the discriminator between a module and a symbol. With no edge, the function stays
 *  silent. */
interface NsAlias {
  name: string;
  path: string;
}

/** One attribute use: the full dotted chain. `v.sub.deep` becomes `[v, sub, deep]`.
 *  Resolution replaces the root with its gate module and attaches the segment after the
 *  longest prefix that has an edge. The module of the edge is literally part of the access
 *  path, so a wrong module attribution is impossible by construction. For `os.getcwd` with
 *  only an `os.path` edge, no prefix matches and the function stays silent. */
interface AttrUse {
  segs: string[];
}

/** Return the text of a `dotted_name`, or of the inner one inside `dotted_as_name` for `import a as b`. */
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

/** Walk the AST recursively. Local imports inside function bodies must be found, and not only
 *  the top-level statements. */
function collectImports(node: Node, out: ImportDesc[]): void {
  if (node.type === 'import_statement') {
    for (const child of node.namedChildren) {
      const m = dottedText(child);
      if (m) out.push({ dots: 0, module: m, names: [] });
    }
    return; // The named children of an import node are only dotted_name or aliased_import nodes, so there are no deeper imports.
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
    return; // The named children are the module name and the imported names, so there are no deeper imports.
  }
  for (const child of node.namedChildren) collectImports(child, out);
}

/** Return the bindings of the import statements. The as-form binds the full path, so
 *  `import X.Y as W` makes W the module X.Y, which is exact. The plain form binds the top
 *  segment only, so `import X.Y` binds X. That binding is gated on an X edge that rarely
 *  exists, because to attach the X tails to the X.Y edge would attribute the wrong module.
 *  The gate therefore silences them, and the recall cost is stated: the result is silence,
 *  which is safe. */
function collectImportAliases(root: Node): NsAlias[] {
  const out: NsAlias[] = [];
  const visit = (n: Node): void => {
    if (n.type === 'import_statement') {
      for (const child of n.namedChildren) {
        if (child.type === 'aliased_import') {
          const path = child.namedChildren.find((c) => c.type === 'dotted_name');
          const alias = child.namedChildren.find((c) => c.type === 'identifier');
          if (path && alias) out.push({ name: alias.text, path: path.text });
        } else if (child.type === 'dotted_name') {
          const top = child.text.split('.')[0];
          out.push({ name: top, path: top });
        }
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return out;
}

/** Return the attribute uses through the bindings, as full dotted chains: `views.portions`
 *  becomes `[views, portions]`.
 *
 *  The function excludes these forms by construction: subscript and computed access
 *  (`views['y']`), an alias assigned to another name (`v = views`, which is scope work and out
 *  of scope), a base that is a call result (`get_views().x`, which is not a binding), and an
 *  unresolvable root (parameters, locals, and globals are silently skipped, and `self.x` falls
 *  out for free). The function does not filter by the shape of the name, because a private
 *  name consumed across cells (`_drawn_portions`) is a coupling too. */
function collectAttrUses(root: Node): AttrUse[] {
  const out: AttrUse[] = [];
  // The full chain, root first. Null when the shape is not a plain chain of identifiers.
  const chain = (n: Node): string[] | null => {
    const obj = n.childForFieldName('object');
    const prop = n.childForFieldName('attribute');
    if (!obj || !prop || prop.type !== 'identifier') return null;
    if (obj.type === 'identifier') return [obj.text, prop.text];
    if (obj.type === 'attribute') {
      const inner = chain(obj);
      return inner ? [...inner, prop.text] : null;
    }
    return null;
  };
  const visit = (n: Node): void => {
    if (n.type === 'attribute') {
      const segs = chain(n);
      // A nested attribute is visited two times, as the outer chain and as the inner
      // sub-chain. The prefixes of the sub-chain are a subset of the prefixes of the outer
      // chain, so the longest-prefix rule and the deduplication subsume it without harm.
      if (segs) out.push({ segs });
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return out;
}

/** The analysis payload: the import descriptors, the namespace bindings, and the attribute uses. */
interface Uses {
  descs: ImportDesc[];
  aliases: NsAlias[];
  attrs: AttrUse[];
}

// --- Resolution: from a descriptor and the source file to candidate module paths, then files ---

/** Probe for a module-root mismatch. Example: `from util.logger import ...` in a src layout
 *  without `module-root`. The module map knows `src.util` and never `util`, so the first
 *  segment is not a local package and the import would be classified external and silently
 *  dropped. That result is a lie: an LLM payload sees "zero dependencies" on a repository
 *  full of them.
 *
 *  Physical existence in the file census (a path under a code-directory root) beats the
 *  silence of the map. The function reports the import as unresolved, and the view already
 *  hints "check the specifier or module-root". The result is memoized per extract in
 *  `ctx.memo`. The census is the ground truth, so the probe never needs the disk. */
function probeModuleRootMismatch(firstSeg: string, codeDirs: string[], files: ReadonlySet<string>, memo: Map<string, boolean>): boolean {
  const key = `${codeDirs.join('\u0000')}\u0000${firstSeg}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let found = false;
  for (const dir of codeDirs) {
    const base = `${dir}/${firstSeg}`;
    if (files.has(`${base}.py`) || files.has(`${base}.pyx`) || files.has(`${base}.pxd`) || files.has(base)) {
      found = true;
      break;
    }
    for (const f of files) {
      if (f.startsWith(`${base}/`)) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  memo.set(key, found);
  return found;
}

/** The facts derived per extract, memoized on the `ResolveCtx` object. `resolveEdges` runs
 *  once per file, and to derive these facts inline was O(files × modules). The `WeakMap` key
 *  is the `ctx` that the factory builds once per extract, so distinct extracts (the working
 *  tree and a HEAD tree for `--diff`) never share a derivation. The fields are:
 *  - `localPackages`: the first segment of every module in the map. It separates a
 *    local-but-unresolved import (a warning) from an external package (silent). The function
 *    derives it after the enrichment of phase 1 completes, because a map still being enriched
 *    would under-count.
 *  - `codeDirs`: repository-relative, with `baseDir` stripped. The file census is always
 *    repository-relative, even for a HEAD-tree run, and the mismatch probe matches against
 *    it. */
const factsByCtx = new WeakMap<ResolveCtx, { localPackages: Set<string>; codeDirs: string[]; baseDir: string }>();

function derivedFacts(ctx: ResolveCtx): { localPackages: Set<string>; codeDirs: string[]; baseDir: string } {
  let facts = factsByCtx.get(ctx);
  if (facts === undefined) {
    const localPackages = new Set<string>();
    for (const mod of ctx.moduleCandidates.keys()) {
      const firstSeg = mod.split('.')[0];
      if (firstSeg) localPackages.add(firstSeg);
    }
    const bd = ctx.baseDir;
    const codeDirs = bd ? ctx.codeDirs.map((d) => (d.startsWith(`${bd}/`) ? d.slice(bd.length + 1) : d)) : ctx.codeDirs;
    facts = { localPackages, codeDirs, baseDir: bd ?? '.' };
    factsByCtx.set(ctx, facts);
  }
  return facts;
}

/** Return the absolute module that a descriptor addresses, before the expansion of
 *  candidates. The function returns null when a relative import escapes the root, because the
 *  import is invalid, and returns null to avoid false edges. The function is pure. */
function descBase(desc: ImportDesc, sourcePath: string, importerModule: string): string | null {
  if (desc.dots === 0) return desc.module; // An absolute import.
  // The package that contains this file. For an `__init__.py`, `.pyx`, or `.pxd` file, the
  // module IS the package. For a regular file, the package is the module without the last
  // segment.
  const isInit = /\/__init__\.(py|pyx|pxd)$/.test(sourcePath);
  const pkg = (isInit ? importerModule : importerModule.split('.').slice(0, -1).join('.')).split('.').filter(Boolean);
  // One dot means the current package, and each extra dot goes up one level.
  const keep = pkg.length - (desc.dots - 1);
  if (keep < 0) return null; // The relative import goes above the root, so it is invalid and the function skips it.
  const targetPkg = pkg.slice(0, keep);
  return desc.module ? [...targetPkg, ...desc.module.split('.')].join('.') : targetPkg.join('.');
}

function resolveImportDesc(desc: ImportDesc, sourcePath: string, importerModule: string, ctx: ResolveCtx): { edges: ImportEdge[]; unresolved: UnresolvedImport[] } {
  const { moduleCandidates, files, memo } = ctx;
  const { localPackages, codeDirs, baseDir } = derivedFacts(ctx);
  let base = descBase(desc, sourcePath, importerModule);
  if (base === null) return { edges: [], unresolved: [] };
  // A self-package absolute import, in the style of `python -m uv`. The base is a package
  // directory under a code directory, but the map keys carry the code-directory prefix
  // (`python.uv`), so the bare name misses the map. The probe proved that the physical
  // target exists. If exactly one map key ends with `'.' + base` in the code-directory
  // family of the importer, the resolution is unambiguous, so resolve it. This completes the
  // probe instead of flagging a standard pattern.
  if (desc.dots === 0 && !moduleCandidates.has(base) && probeModuleRootMismatch(base.split('.')[0], codeDirs, files, memo)) {
    const family = importerModule.split('.')[0];
    const suffix = `.${base}`;
    let match: string | null = null;
    for (const key of moduleCandidates.keys()) {
      if (key.endsWith(suffix) && key.split('.')[0] === family) {
        if (match !== null) {
          match = null; // Two packages of the same family share the name, so the result is ambiguous and stays unresolved.
          break;
        }
        match = key;
      }
    }
    if (match !== null) base = match;
  }
  const candidates = [base, ...desc.names.map((n) => (base ? `${base}.${n}` : n))];
  const edges: ImportEdge[] = [];
  const seen = new Set<string>();
  for (const cand of candidates) {
    // A duplicate module name (a mirror tree) resolves in the same tree through
    // `nearestCandidate`. A winner map would give every import whichever file won the census
    // walk.
    const toFile = nearestCandidate(moduleCandidates.get(cand) ?? [], sourcePath);
    if (toFile && !seen.has(toFile)) {
      seen.add(toFile);
      // In `from M import a, b` where M itself resolved, a and b are symbols consumed from
      // the file of M, and the off-membrane check audits them against the provides of the cell
      // of M. A `M.a` that resolved as its own submodule file is a module dependency, and it
      // has no symbols.
      const symbols = cand === base && desc.names.length > 0 ? desc.names : undefined;
      edges.push({ fromFile: sourcePath, toFile, import: cand, ...(symbols ? { symbols } : {}) });
    }
  }
  // Flag the import as unresolved only when NO candidate of this descriptor resolved. If the
  // base module resolved, the name candidates are symbols (functions and classes) inside it,
  // not missing submodules, so the code must not raise a false positive on them.
  const unresolved: UnresolvedImport[] = [];
  if (edges.length === 0 && base && (looksLocal(base, desc.dots, localPackages) || probeModuleRootMismatch(base.split('.')[0], codeDirs, files, memo))) {
    // A compiled extension module (pyo3 or Cython, where `headroom._core` becomes
    // `_core.cpython-*.so`) is legitimately unresolvable, because the file exists but is not
    // code. To silence it keeps the unresolved list honest. On a repository with many pyo3
    // modules, 73 of 81 flagged entries collapsed to one real issue.
    if (!isCompiledModule(base, moduleCandidates, sourcePath, baseDir)) unresolved.push({ fromFile: sourcePath, import: base });
  }
  return { edges, unresolved };
}

/** Say whether this candidate import looks local. A relative import (dots above 0) always
 *  looks local. An absolute import looks local when its first segment matches a known local
 *  package. */
function looksLocal(candidate: string, dots: number, localPackages: Set<string>): boolean {
  if (dots > 0) return true;
  return localPackages.has(candidate.split('.')[0]);
}

const COMPILED_EXTS = ['.so', '.pyd']; // The extension modules of Python: `.so` everywhere, including macOS, and `.pyd` on Windows.

/** The directory listings for the compiled-module checks, memoized per process. Many
 *  unresolved imports may probe the same package directory, and the census does not change
 *  during a run. The key is the absolute directory path (`resolve(baseDir, ...)`), so
 *  distinct `baseDir` values never collide, for example a HEAD-tree run next to the working
 *  tree. A relative key would list the current working directory instead. */
const compiledDirCache = new Map<string, string[]>();

/** Say whether `module` (dotted, for example `headroom._core`) resolves to a compiled
 *  extension file on disk, such as `headroom/_core.cpython-312-....so`. The function derives
 *  the directory of the parent package from the module-to-file map, so it is aware of
 *  `moduleRoot` and the src layout: `src/headroom/__init__.py` gives the directory
 *  `src/headroom`. The function therefore finds the compiled artifact wherever the package
 *  lives. The function runs only for a local-looking unresolved import. A missing directory,
 *  or no parent in the map, gives false. */
function isCompiledModule(module: string, moduleCandidates: Map<string, string[]>, sourcePath: string, baseDir: string): boolean {
  const lastDot = module.lastIndexOf('.');
  if (lastDot === -1) return false;
  const parentMod = module.slice(0, lastDot);
  const name = module.slice(lastDot + 1);
  const parentFile = nearestCandidate(moduleCandidates.get(parentMod) ?? [], sourcePath);
  if (!parentFile) return false;
  const absDir = resolve(baseDir, dirname(parentFile));
  try {
    let entries = compiledDirCache.get(absDir);
    if (!entries) {
      entries = readdirSync(absDir);
      compiledDirCache.set(absDir, entries);
    }
    return entries.some((entry) => entry.startsWith(`${name}.`) && COMPILED_EXTS.some((ext) => entry.endsWith(ext)));
  } catch {
    return false; // The directory is missing, so the module is not compiled.
  }
}

/** The Python importer: tree-sitter analysis and module-to-file resolution through the census.
 *  It also handles Cython `.pyx` and `.pxd` files, whose regular Python imports produce edges.
 *  A `cimport` happens at compile time and is deliberately blind. The preprocess step blanks
 *  it, which also stops the error recovery of tree-sitter-python from swallowing real imports
 *  next to `cimport` lines. */
export const pythonImporter = createTreeSitterImporter<Uses>({
  name: 'python',
  extensions: ['.py', '.pyx', '.pxd'],
  wasmBasename: 'tree-sitter-python.wasm',
  fileToModule,
  // Also blank the continuation of a parenthesized cimport (`from foo cimport (\n a,\n b,\n)`).
  // The orphan `a,` and `)` lines parse as bare errors. These errors are harmless alone, but
  // to keep the block whole leaves nothing for the error recovery to attach to a neighboring
  // real import.
  preprocess: (content) =>
    content
      .replace(/^\s*from\s+\S+\s+cimport\s*\([\s\S]*?\)\s*$/gm, '')
      .replace(/^\s*cimport\s*\([\s\S]*?\)\s*$/gm, '')
      .replace(/^\s*from\s+\S+\s+cimport\b.*$/gm, '')
      .replace(/^\s*cimport\b.*$/gm, ''),
  analyze: (root) => ({
    mods: [],
    reexports: [],
    // Per file: the import descriptors, the namespace bindings, and the attribute uses of this file.
    uses: { descs: extractImports(root), aliases: collectImportAliases(root), attrs: collectAttrUses(root) },
  }),
  resolveEdges: ({ descs, aliases, attrs }, sourcePath, importerModule, ctx) => {
    const edges: ImportEdge[] = [];
    const unresolved: UnresolvedImport[] = [];
    for (const desc of descs) {
      const r = resolveImportDesc(desc, sourcePath, importerModule, ctx);
      edges.push(...r.edges);
      unresolved.push(...r.unresolved);
    }
    // The attribute gate, from a local name to an absolute module. The bindings of the import
    // statements come first, and the from-bound names fill the gaps: a from-name maps to
    // `base.name`, the submodule candidate that the resolver itself tries. A contested root
    // keeps the binding of the import statement, and the attachment still gates on a real
    // edge, so the worst case is silence and never a false edge.
    const gate = new Map<string, string>();
    for (const a of aliases) if (!gate.has(a.name)) gate.set(a.name, a.path);
    for (const desc of descs) {
      const base = descBase(desc, sourcePath, importerModule);
      if (base === null) continue;
      for (const n of desc.names) {
        if (!gate.has(n)) gate.set(n, base ? `${base}.${n}` : n);
      }
    }
    // Attach the segment after the LONGEST chain prefix that has an edge. The root resolves
    // through the gate (`v` becomes `src.views`), then the prefixes extend down the chain, and
    // the first hit, which is the longest one, wins. A from-name that resolved as a symbol has
    // no such edge and drops, which is the discriminator between a module and a symbol. The
    // code adds symbols only and never moves an edge.
    for (const { segs } of attrs) {
      const g = gate.get(segs[0]);
      if (!g) continue;
      const gsegs = g.split('.');
      const full = [...gsegs, ...segs.slice(1)];
      for (let k = full.length - 2; k >= gsegs.length - 1; k--) {
        const edge = edges.find((e) => e.import === full.slice(0, k + 1).join('.'));
        if (edge) {
          if (!edge.symbols) edge.symbols = [];
          const tail = full[k + 1];
          if (!edge.symbols.includes(tail)) edge.symbols.push(tail);
          break;
        }
      }
    }
    return { edges, unresolved };
  },
});
