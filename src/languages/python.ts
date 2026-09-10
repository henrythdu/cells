import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { ImportEdge, UnresolvedImport } from '../imports.js';
import { createTreeSitterImporter, nearestCandidate, type ResolveCtx } from './tree-sitter.js';

// --- module-path derivation: file → python module path ---

/** `src/domain/symbol.py` → `src.domain.symbol`; `src/domain/__init__.py` → `src.domain`.
 *  With `moduleRoot` (e.g. "src"): `src/domain/symbol.py` → `domain.symbol` (for Python src-layout).
 *  Cython: `algos.pyx`/`algos.pxd` → `algos` (a .pyx+.pxd pair is ONE module — the pair mapping
 *  to the same key is intentional; the factory's sorted order makes the .pyx implementation win). */
export function fileToModule(path: string, moduleRoot?: string): string {
  let p = path.replace(/\.(py|pyx|pxd)$/, '');
  if (moduleRoot && p.startsWith(`${moduleRoot}/`)) p = p.slice(moduleRoot.length + 1);
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

/** A namespace-ish binding: local name → the gate module whose edge carries its attribute
 *  tails (`import views as v` → v is views; `from m import a` → a is m.a). Attachment requires
 *  an edge with import == path (the module-vs-symbol discriminator) — no edge, silence. */
interface NsAlias {
  name: string;
  path: string;
}

/** One attribute use: the full dotted chain (`v.sub.deep` → [v, sub, deep]). Resolution
 *  replaces the root with its gate module and attaches the segment after the LONGEST prefix
 *  with an edge — the edge's module is literally part of the access path, so wrong-module
 *  attribution is impossible by construction (`os.getcwd` with only an os.path edge: no
 *  prefix matches, silence). */
interface AttrUse {
  segs: string[];
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

/** Import-statement bindings: as-form binds the FULL path (`import X.Y as W` → W is X.Y —
 *  exact); plain form binds the TOP segment only (`import X.Y` binds X, gated on an X edge
 *  that rarely exists — attaching X-tails to the X.Y edge would be wrong-module, so the
 *  gate silences them; the recall cost is stated, silence-safe). */
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

/** Attribute uses through bindings: full dotted chains (`views.portions` → [views, portions]).
 *  Excluded by construction: subscript/computed (`views['y']`), assigned-away aliases
 *  (`v = views` — scope work, out), call-result bases (`get_views().x` — non-binding),
 *  unresolvable roots (params/locals/globals silently skipped; `self.x` falls out free).
 *  No name-shape filtering — privates consumed cross-cell (`_drawn_portions`) are couplings too. */
function collectAttrUses(root: Node): AttrUse[] {
  const out: AttrUse[] = [];
  // Full chain root-first, or null when the shape isn't a plain identifier chain.
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
      // Nested attributes visit twice (outer + inner sub-chain); the sub-chain's prefixes
      // are a subset of the outer's, so longest-prefix + dedupe subsume it harmlessly.
      if (segs) out.push({ segs });
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return out;
}

/** The analysis payload: import descriptors + namespace bindings + attribute uses. */
interface Uses {
  descs: ImportDesc[];
  aliases: NsAlias[];
  attrs: AttrUse[];
}

// --- resolution: descriptor + source file → candidate module paths → files ---

/** Module-root mismatch probe: `from util.logger import …` in a src-layout WITHOUT
 *  module-root — the module map knows `src.util`, never `util`, so the first segment
 *  isn't a local package and the import would be classified external and silently
 *  dropped (the lie: an LLM payload sees "zero dependencies" on a repo full of them).
 *  Physical existence in the file census (a path under a code-dir root) beats the
 *  map's silence — report it as unresolved (the view already hints "check the
 *  specifier or module-root") instead of dropping. Memoized per extract (ctx.memo) —
 *  the census is the ground truth, so the probe never needs the disk. */
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

/** Per-extract derived facts, memoized on the ResolveCtx object (resolveEdges runs once
 *  per FILE — deriving these inline was O(files×modules)). The WeakMap key is the ctx the
 *  factory builds once per extract, so distinct extracts (working tree vs a HEAD tree for
 *  --diff) never share a derivation. Fields:
 *  - localPackages: first segment of every module in the map — distinguishes
 *    local-but-unresolved imports (warn) from external packages (silent). Derived after
 *    phase-1 enrichment completes (a map still being enriched would under-count).
 *  - codeDirs: repo-relative (baseDir-stripped) — the file census is always repo-relative,
 *    even for HEAD-tree runs; the mismatch probe matches against it. */
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

/** The absolute module a descriptor addresses, before candidate expansion (null when a
 *  relative import escapes the root — invalid; skip to avoid false edges). Pure. */
function descBase(desc: ImportDesc, sourcePath: string, importerModule: string): string | null {
  if (desc.dots === 0) return desc.module; // absolute
  // The package containing this file. For __init__.py/.pyx/.pxd, the module IS the package;
  // for a regular file, the package is module minus the last segment.
  const isInit = /\/__init__\.(py|pyx|pxd)$/.test(sourcePath);
  const pkg = (isInit ? importerModule : importerModule.split('.').slice(0, -1).join('.')).split('.').filter(Boolean);
  // `.` = current package; each extra dot goes up one level.
  const keep = pkg.length - (desc.dots - 1);
  if (keep < 0) return null; // relative import goes above the root — invalid; skip.
  const targetPkg = pkg.slice(0, keep);
  return desc.module ? [...targetPkg, ...desc.module.split('.')].join('.') : targetPkg.join('.');
}

function resolveImportDesc(desc: ImportDesc, sourcePath: string, importerModule: string, ctx: ResolveCtx): { edges: ImportEdge[]; unresolved: UnresolvedImport[] } {
  const { moduleCandidates, files, memo } = ctx;
  const { localPackages, codeDirs, baseDir } = derivedFacts(ctx);
  let base = descBase(desc, sourcePath, importerModule);
  if (base === null) return { edges: [], unresolved: [] };
  // Self-package absolute import (`python -m uv` style): base is a
  // package dir under a code-dir, but map keys are code-dir-prefixed (python.uv), so the
  // bare name misses the map. The probe proved the physical target exists; if exactly one
  // map key ends with '.'+base IN THE IMPORTER'S OWN code-dir family, the resolution is
  // unambiguous — resolve it (completes the probe instead of flagging a standard pattern).
  if (desc.dots === 0 && !moduleCandidates.has(base) && probeModuleRootMismatch(base.split('.')[0], codeDirs, files, memo)) {
    const family = importerModule.split('.')[0];
    const suffix = `.${base}`;
    let match: string | null = null;
    for (const key of moduleCandidates.keys()) {
      if (key.endsWith(suffix) && key.split('.')[0] === family) {
        if (match !== null) {
          match = null; // two same-family packages share the name — ambiguous, stay unresolved
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
    // Duplicate module names (mirror trees) resolve same-tree via nearestCandidate —
    // a winner map would give every import whichever file won the census walk.
    const toFile = nearestCandidate(moduleCandidates.get(cand) ?? [], sourcePath);
    if (toFile && !seen.has(toFile)) {
      seen.add(toFile);
      // `from M import a, b` where M itself resolved: a, b are symbols consumed from
      // M's file — the off-membrane check audits them against M's cell's provides.
      // (A `M.a` that resolved as its own submodule file is a module dependency — no symbols.)
      const symbols = cand === base && desc.names.length > 0 ? desc.names : undefined;
      edges.push({ fromFile: sourcePath, toFile, import: cand, ...(symbols ? { symbols } : {}) });
    }
  }
  // Only flag unresolved if NO candidate from this import descriptor resolved.
  // If the base module resolved, the name candidates are symbols (functions/classes) within
  // it, not missing submodules — don't false-positive on them.
  const unresolved: UnresolvedImport[] = [];
  if (edges.length === 0 && base && (looksLocal(base, desc.dots, localPackages) || probeModuleRootMismatch(base.split('.')[0], codeDirs, files, memo))) {
    // A compiled extension module (pyo3/cython: `headroom._core` → _core.cpython-*.so) is
    // legitimately unresolvable — the file exists but isn't code. Silencing it keeps the
    // unresolved list honest (on a pyo3-heavy repo, 73/81 flagged entries collapsed to one real issue).
    if (!isCompiledModule(base, moduleCandidates, sourcePath, baseDir)) unresolved.push({ fromFile: sourcePath, import: base });
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
 *  may probe the same package dir; the census doesn't change mid-run). Keyed by the ABSOLUTE
 *  dir path (resolve(baseDir, …)) so distinct baseDirs — a HEAD-tree run alongside the working
 *  tree — never collide; a relative key would list the CWD instead. */
const compiledDirCache = new Map<string, string[]>();

/** Does `module` (dotted, e.g. `headroom._core`) resolve to a compiled extension file on disk
 *  (`headroom/_core.cpython-312-….so`)? The parent package's dir is derived from the module→file
 *  map (moduleRoot/src-layout aware — `src/headroom/__init__.py` → dir `src/headroom`), so the
 *  compiled artifact is found wherever the package actually lives. Only called for local-looking
 *  unresolved imports; a missing dir (or no parent in the map) → false. */
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
    return false; // dir missing → not compiled
  }
}

/** Python importer — tree-sitter analysis + module→file resolution through the census.
 *  Also handles Cython .pyx/.pxd: their regular Python imports produce edges; `cimport` is
 *  compiled-time and deliberately blind (blanked in preprocess — which ALSO prevents
 *  tree-sitter-python's error recovery from swallowing real imports next to cimport lines). */
export const pythonImporter = createTreeSitterImporter<Uses>({
  name: 'python',
  extensions: ['.py', '.pyx', '.pxd'],
  wasmBasename: 'tree-sitter-python.wasm',
  fileToModule,
  // Also blank the continuation of a parenthesized cimport (`from foo cimport (\n a,\n b,\n)`) —
  // the orphan `a,`/`)` lines parse as bare errors; harmless alone, but keeping the block whole
  // leaves nothing for error recovery to attach to a neighboring real import.
  preprocess: (content) =>
    content
      .replace(/^\s*from\s+\S+\s+cimport\s*\([\s\S]*?\)\s*$/gm, '')
      .replace(/^\s*cimport\s*\([\s\S]*?\)\s*$/gm, '')
      .replace(/^\s*from\s+\S+\s+cimport\b.*$/gm, '')
      .replace(/^\s*cimport\b.*$/gm, ''),
  analyze: (root) => ({
    mods: [],
    reexports: [],
    // per-file: this file's import descriptors + namespace bindings + attribute uses
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
    // Attribute gate: local name → absolute module. Import-statement bindings first,
    // from-bound names fill gaps (a from-name maps to base.name — the submodule candidate
    // the resolver itself tries). Contested roots keep the import-statement binding;
    // attachment still gates on a real edge, so the worst case is silence, never a false edge.
    const gate = new Map<string, string>();
    for (const a of aliases) if (!gate.has(a.name)) gate.set(a.name, a.path);
    for (const desc of descs) {
      const base = descBase(desc, sourcePath, importerModule);
      if (base === null) continue;
      for (const n of desc.names) {
        if (!gate.has(n)) gate.set(n, base ? `${base}.${n}` : n);
      }
    }
    // Attach: the segment after the LONGEST chain prefix with an edge. The root resolves
    // through the gate (v → src.views), then prefixes extend down the chain — the first
    // (longest) hit wins. A from-name that resolved as a symbol has no such edge and drops
    // (the module-vs-symbol discriminator). Symbols-only: edges never move here.
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
