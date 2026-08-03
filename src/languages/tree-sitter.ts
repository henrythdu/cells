import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, type Node, Parser, type Tree } from 'web-tree-sitter';
import type { ImportEdge, ImportResult, SourceFile, UnresolvedImport, Importer } from '../imports.js';
/**
 * Shared tree-sitter importer infrastructure: a grammar-WASM singleton cache +
 * a factory that owns the parse loop. Each language importer supplies only its
 * language-specific logic (module derivation, AST analysis, resolution).
 */

// --- grammar singleton cache (one Parser per grammar WASM; lazy + memoized) ---
const parsers = new Map<string, Promise<Parser>>();

// Serialize grammar loading: web-tree-sitter's Language.load shares WASM state, and two
// concurrent loads race it (one grammar loads corrupted → silent empty extraction). This
// chain makes loads strictly sequential even if callers parallelize; the chain survives
// individual failures so a broken grammar doesn't wedge the others.
let loadChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = loadChain.then(fn);
  loadChain = run.catch(() => {});
  return run;
}

/** Load (once) + cache the tree-sitter Parser for a bundled grammar WASM. */
export function getGrammarParser(wasmBasename: string): Promise<Parser> {
  let p = parsers.get(wasmBasename);
  if (!p) {
    p = serialized(async () => {
      await Parser.init();
      // WASMs ship as static assets in grammars/ (built ABI-matched to web-tree-sitter;
      // the prebuilt tree-sitter-wasms pack is OLD-CLI/incompatible — see memory 155).
      const wasm = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'grammars', wasmBasename);
      let lang: Language;
      try {
        lang = await Language.load(readFileSync(wasm));
      } catch {
        throw new Error(`Failed to load grammar WASM at ${wasm} — ensure the 'grammars/' directory is bundled with cells.`);
      }
      const parser = new Parser();
      parser.setLanguage(lang);
      return parser;
    });
    parsers.set(wasmBasename, p);
    p.catch(() => parsers.delete(wasmBasename)); // don't cache the rejection — allow retry on the next call
  }
  return p;
}

/** Verify the bundled grammar set (grammars/manifest.json): every declared wasm exists in
 *  the package and loads against the bundled runtime — the authoritative ABI check. A missing
 *  file or ABI mismatch here means the package is broken even if no repo currently has files
 *  of that language (the lazy per-language failure would otherwise stay silent). Called by
 *  `cells health`; runs loads through the same serialized chain as real parsing, so it can't
 *  race concurrent grammar loads. */
export async function checkGrammars(): Promise<{ lang: string; ok: boolean; error?: string }[]> {
  const grammarsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'grammars');
  let manifest: { grammars: { lang: string; wasm: string }[] };
  try {
    manifest = JSON.parse(readFileSync(join(grammarsDir, 'manifest.json'), 'utf8')) as typeof manifest;
  } catch {
    // never throw — health renders this as a failing grammars line (broken package = gate failure)
    return [{ lang: 'manifest', ok: false, error: `missing or unreadable at ${grammarsDir}` }];
  }
  const results: { lang: string; ok: boolean; error?: string }[] = [];
  if (!Array.isArray(manifest.grammars)) {
    // malformed shape (bad edit/merge) must fail the gate, not crash health
    return [{ lang: 'manifest', ok: false, error: `malformed manifest (no grammars array) at ${grammarsDir}` }];
  }
  for (const g of manifest.grammars) {
    try {
      await serialized(async () => {
        await Parser.init();
        await Language.load(readFileSync(join(grammarsDir, g.wasm)));
      });
      results.push({ lang: g.lang, ok: true });
    } catch (err) {
      results.push({ lang: g.lang, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/** Run-wide resolution facts every language importer resolves against — ONE object instead of
 *  a positional param list (the external ImportContext already set that precedent; the internal
 *  seam kept growing a param per wave — crateNames in wave-1, reexports in wave-3). */
export interface ResolveCtx {
  /** module path → source file. Enriched by the factory (fileToModule keys + declared
   *  submodules + name aliases) BEFORE any resolution runs. */
  moduleToFile: Map<string, string>;
  /** every code file's path (for `mod x;` sibling-target lookups). */
  files: ReadonlySet<string>;
  /** package names of workspace member crates (rust): a bare first segment matching one is a
   *  cross-crate internal import (vs a silently-dropped external like serde). */
  crateNames: ReadonlySet<string>;
  /** pub-use re-export chains: module → alias → absolute target. The language registers BOTH
   *  namespaced and crate-name keys itself (crate semantics are the language's, not the
   *  factory's); complete by the time resolveEdges runs. */
  reexports: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Re-export aliases pointing OUTSIDE the partition (external crates — `pub use owo_colors;`).
   *  module → alias set. Registered by the language during analyze; resolution SILENCES imports
   *  that route through one — the target is real but has no owned file, so flagging it as a
   *  broken local import would be a false alarm (same principle as compiled .so silencing). */
  externalReexports: ReadonlyMap<string, ReadonlySet<string>>;
  /** crate-root path → Cargo.toml package name (rust, multi-crate runs only) — used by the
   *  language's analyze to register re-exports under the crate-name form. */
  crateNameByRoot?: ReadonlyMap<string, string | null>;
  /** Where code lives ('.' = the working repo; a HEAD-tree dir for --diff). */
  baseDir?: string;
}

/** The key separator of the module→file map: the factory joins module-path segments with it
 *  (`${importerModule}::${path.join('::')}`) and language resolvers split/join on it (go's
 *  candidateKeys, java's KEY_PREFIX). Exporting it keeps the couple honest — a separator
 *  change breaks the resolvers' key construction loudly (via tests), not silently. */
export const MODULE_SEP = '::';

/** A declared submodule (from `mod x;` or inline `mod x {}`). */
export interface ModDecl {
  path: string[];
  targetFile: string | null; // null = inline block (lives in the containing file)
}

/** A pub-use re-export the module exposes (module → alias → absolute target). `external`
 *  marks a re-export that points OUTSIDE the partition (an external crate — `pub use owo_colors;`):
 *  target is empty, and the factory registers it in ctx.externalReexports (resolution silences
 *  imports routing through it) instead of the chain map. */
export interface Reexport {
  module: string;
  alias: string;
  target: string;
  external?: boolean;
}

/** What one AST analysis pass extracts: declared submodules, pub-use re-exports, and every use
 *  path (language-specific shape in `uses`). */
export interface Analysis<U> {
  mods: ModDecl[];
  reexports: Reexport[];
  uses: U;
}

/** Spec for a tree-sitter language importer: the language-specific pieces. Two hooks — analyze
 *  (one AST walk: what imports exist) and resolveEdges (semantics: where they land). A new
 *  language implements both; the factory runs one uniform flow (parse once, analyze once,
 *  resolve from facts) for every language. */
export interface TreeSitterImporterSpec<U = unknown> {
  /** Human name for error messages (e.g. "rust"). */
  name: string;
  extensions: readonly string[];
  wasmBasename: string;
  fileToModule(path: string, moduleRoot?: string, baseDir?: string): string;
  /** Optional: content transform BEFORE parsing (e.g. Cython — blank cimport lines so
   *  tree-sitter-python's error recovery can't swallow neighboring real from-imports). */
  preprocess?(content: string): string;
  /** Optional: the crate root a file belongs to (null = none). When a run spans MULTIPLE
   *  crates, the factory namespaces every module key by crate root so two crates' `crate::…`
   *  paths can't collide in the shared module→file map (single-crate runs keep plain keys). */
  crateRootOf?(path: string, baseDir?: string): string | null;
  /** The crate's package name from its manifest (hyphens→underscores — the Rust-visible name).
   *  The factory aliases namespaced module keys by it so `use sibling_crate::…` resolves. */
  crateNameOf?(crateRoot: string, baseDir?: string): string | null;
  /** One AST pass per file: declared submodules (enrich the module→file map so deep
   *  `crate::a::b::c` paths resolve), pub-use re-exports (register in the global chain map),
   *  and every use path (handed to resolveEdges). The factory parses each file once and runs
   *  this once — no second parse, no second walk. */
  analyze(root: Node, sourcePath: string, importerModule: string, ctx: ResolveCtx): Analysis<U>;
  /** Resolve a file's extracted uses to file→file edges + unresolved local imports. Pure over
   *  the facts from analyze; ctx.reexports is complete by the time this runs. */
  resolveEdges(uses: U, sourcePath: string, importerModule: string, ctx: ResolveCtx): { edges: ImportEdge[]; unresolved: UnresolvedImport[] };
}

/**
 * Build an Importer from a tree-sitter spec. Owns the shared loop scaffolding:
 * build the module→file map, parse each matching file ONCE, run the spec's
 * `analyze` (one AST walk), enrich the map from mods + re-exports, then hand
 * the facts to `resolveEdges`. Self-loops and duplicate targets are de-duped
 * by the factory; each WASM-backed Tree is freed.
 */
export function createTreeSitterImporter<U = unknown>(spec: TreeSitterImporterSpec<U>): Importer {
  const matches = (path: string) => spec.extensions.some((e) => path.endsWith(e));
  return {
    name: spec.name,
    extensions: spec.extensions,
    needsContent: true,
    async extract({ files, moduleRoot, baseDir }): Promise<ImportResult> {
      // Deterministic module-key winners: two files mapping to ONE module key (python's
      // .pxd+.pyx pair) — the last-set file wins, so sorted order picks the same one every
      // run (readdir order is OS-dependent). .pxd sorts before .pyx → the implementation wins.
      files = [...files].sort((a, b) => a.path.localeCompare(b.path));
      // Namespace module keys by crate root when the run spans multiple crates — two crates
      // both mapping `crate::app` to DIFFERENT files would silently mis-resolve imports.
      let moduleKey = (f: SourceFile): string => spec.fileToModule(f.path, moduleRoot, baseDir);
      // Package names of workspace member crates — the factory aliases their namespaced
      // module keys by name so `use sibling_crate::…` resolves (rust.ts crates only).
      const crateNames = new Set<string>();
      let nameByRoot: Map<string, string | null> | undefined;
      let aliasByName: (key: string, root: string | null) => void = () => {};
      if (spec.crateRootOf) {
        const roots = new Set(
          files
            .filter((f) => matches(f.path))
            .map((f) => spec.crateRootOf!(f.path, baseDir))
            .filter((r): r is string => r !== null),
        );
        if (roots.size > 1) {
          moduleKey = (f) => {
            const m = spec.fileToModule(f.path, moduleRoot, baseDir);
            const r = spec.crateRootOf!(f.path, baseDir);
            if (!r || r === '.') return m; // scan-root crate — no prefix
            return m === 'crate' ? r : `${r}::${m.slice('crate::'.length)}`;
          };
          if (spec.crateNameOf) {
            // Read each manifest ONCE — aliasByName runs per file/submodule, and re-reading
            // the same few Cargo.tomls hundreds of times synchronously would dominate a big
            // workspace scan. Also handed to the spec's analyze (ctx.crateNameByRoot) for
            // re-export registration under the crate-name form.
            nameByRoot = new Map<string, string | null>();
            for (const r of roots) {
              const name = spec.crateNameOf(r, baseDir);
              nameByRoot.set(r, name);
              if (name) crateNames.add(name);
            }
            // The scan-root crate ('.') keeps plain `crate::…` keys — it is NEVER aliased by
            // name. Its name must NOT count as a workspace member: a bin referencing the root
            // lib by name would otherwise classify internal, fail to resolve, and false-flag as
            // unresolved (it was silently external before). Rare; stays external, as pre-fix.
            const scanRootName = roots.has('.') ? (nameByRoot.get('.') ?? null) : null;
            if (scanRootName) crateNames.delete(scanRootName);
            // Namespaced keys are addressed by crate ROOT PATH; a use addresses the crate by
            // its Cargo.toml NAME. Alias every key so `headroom_core::…` → `crates/headroom-core::…`.
            aliasByName = (key, root) => {
              if (!root || root === '.' || !nameByRoot) return;
              const name = nameByRoot.get(root);
              if (!name) return;
              const prefix = `${root}::`;
              let rest: string | null = null;
              if (key === root) rest = '';
              else if (key.startsWith(prefix)) rest = key.slice(prefix.length);
              if (rest === null) return;
              const alias = rest ? `${name}::${rest}` : name;
              if (!moduleToFile.has(alias)) moduleToFile.set(alias, moduleToFile.get(key)!);
            };
          }
        }
      }
      const moduleToFile = new Map<string, string>();
      for (const f of files) {
        if (!matches(f.path)) continue;
        const key = moduleKey(f);
        moduleToFile.set(key, f.path);
        aliasByName(key, spec.crateRootOf?.(f.path, baseDir) ?? null);
      }

      const parser = await getGrammarParser(spec.wasmBasename);
      // parse + tree ownership: the Tree is WASM-backed — the caller must delete() it.
      const parse = (content: string): Tree | null => {
        const tree = parser.parse(content);
        return tree ?? null;
      };

      // Phase 1 — one parse + one analyze walk per file: declared submodules enrich the
      // module→file map, re-exports register into the chain map, uses are stashed for phase 2.
      // The enrichment MUST precede any resolution (a use in file A may target a module
      // declared in file B), which is why extraction is two-phased — but each file is parsed
      // and walked exactly once across both phases.
      const reexportMap = new Map<string, Map<string, string>>();
      const externalReexports = new Map<string, Set<string>>();
      const ctx: ResolveCtx = {
        moduleToFile,
        files: new Set(files.map((f) => f.path)),
        crateNames,
        reexports: reexportMap,
        externalReexports,
        crateNameByRoot: nameByRoot,
        baseDir,
      };
      const analyses = new Map<string, Analysis<U>>();
      for (const f of files) {
        if (!matches(f.path)) continue;
        const tree = parse(spec.preprocess ? spec.preprocess(f.content) : f.content);
        if (!tree) continue;
        try {
          const importerModule = moduleKey(f);
          const a = spec.analyze(tree.rootNode, f.path, importerModule, ctx);
          analyses.set(f.path, a);
          const root = spec.crateRootOf?.(f.path, baseDir) ?? null;
          for (const m of a.mods) {
            const key = `${importerModule}${MODULE_SEP}${m.path.join(MODULE_SEP)}`;
            moduleToFile.set(key, m.targetFile ?? f.path);
            aliasByName(key, root);
          }
          for (const r of a.reexports) {
            if (r.external) {
              // points outside the partition — resolution silences imports routing through it
              // (the target is real code, but no owned file exists to draw an edge to).
              let s = externalReexports.get(r.module);
              if (!s) {
                s = new Set();
                externalReexports.set(r.module, s);
              }
              s.add(r.alias);
              continue;
            }
            let m = reexportMap.get(r.module);
            if (!m) {
              m = new Map();
              reexportMap.set(r.module, m);
            }
            if (!m.has(r.alias)) m.set(r.alias, r.target);
          }
        } finally {
          tree.delete(); // web-tree-sitter Trees are WASM-backed — free each one to avoid leaking.
        }
      }

      // Phase 2 — resolve from the stashed facts (no re-parse, no re-walk).
      const edges: ImportEdge[] = [];
      const unresolved: UnresolvedImport[] = [];
      for (const f of files) {
        if (!matches(f.path)) continue;
        const a = analyses.get(f.path);
        if (!a) continue;
        const { edges: fileEdges, unresolved: fileUnresolved } = spec.resolveEdges(a.uses, f.path, moduleKey(f), ctx);
        const seen = new Set<string>();
        for (const e of fileEdges) {
          if (e.toFile !== f.path && !seen.has(e.toFile)) {
            seen.add(e.toFile);
            edges.push(e);
          }
        }
        unresolved.push(...fileUnresolved);
      }
      return { edges, unresolved };
    },
  };
}
