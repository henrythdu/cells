import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, type Node, Parser, type Tree } from 'web-tree-sitter';
import type { ImportEdge, ImportResult, SourceFile, UnresolvedImport, Importer } from '../imports.js';
/**
 * Shared tree-sitter importer infrastructure: a grammar-WASM singleton cache +
 * a factory that owns the parse loop. Each language importer supplies only its
 * language-specific logic (module derivation, AST extraction, resolution).
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
export async function checkGrammars(): Promise<{ lang: string; wasm: string; ok: boolean; error?: string }[]> {
  const grammarsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'grammars');
  let manifest: { grammars: { lang: string; wasm: string }[] };
  try {
    manifest = JSON.parse(readFileSync(join(grammarsDir, 'manifest.json'), 'utf8')) as typeof manifest;
  } catch {
    // never throw — health renders this as a failing grammars line (broken package = gate failure)
    return [{ lang: 'manifest', wasm: 'manifest.json', ok: false, error: `missing or unreadable at ${grammarsDir}` }];
  }
  const results: { lang: string; wasm: string; ok: boolean; error?: string }[] = [];
  if (!Array.isArray(manifest.grammars)) {
    // malformed shape (bad edit/merge) must fail the gate, not crash health
    return [{ lang: 'manifest', wasm: 'manifest.json', ok: false, error: `malformed manifest (no grammars array) at ${grammarsDir}` }];
  }
  for (const g of manifest.grammars) {
    try {
      await serialized(async () => {
        await Parser.init();
        await Language.load(readFileSync(join(grammarsDir, g.wasm)));
      });
      results.push({ lang: g.lang, wasm: g.wasm, ok: true });
    } catch (err) {
      results.push({ lang: g.lang, wasm: g.wasm, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/** Spec for a tree-sitter language importer: the language-specific pieces. */
export interface TreeSitterImporterSpec {
  /** Human name for error messages (e.g. "rust"). */
  name: string;
  extensions: readonly string[];
  wasmBasename: string;
  fileToModule(path: string, moduleRoot?: string, baseDir?: string): string;
  /** Optional: the crate root a file belongs to (null = none). When a run spans MULTIPLE
   *  crates, the factory namespaces every module key by crate root so two crates' `crate::…`
   *  paths can't collide in the shared module→file map (single-crate runs keep plain keys). */
  crateRootOf?(path: string, baseDir?: string): string | null;
  /** Declared submodules with their module-path chain relative to the containing file,
   *  e.g. `mod x;` → [['x'], 'x.rs'], inline `mod x {}` → [['x'], null] (lives in this file),
   *  nested inline blocks → [['x','y'], null]. null targetFile = inline block. The factory
   *  enriches the module→file map with these so deep `crate::a::b::c` paths resolve to the
   *  file containing the deepest module instead of reporting false "unresolved". */
  declareModules?(root: Node, sourcePath: string, fileSet: Set<string>): { path: string[]; targetFile: string | null }[];
  /** Parse a tree's root into import edges + unresolved local imports (extraction + resolution).
   *  Self-loops and duplicate targets are de-duped by the factory. */
  extractEdges(root: Node, sourcePath: string, importerModule: string, moduleToFile: Map<string, string>): { edges: ImportEdge[]; unresolved: UnresolvedImport[] };
}

/**
 * Build an Importer from a tree-sitter spec. Owns the shared loop scaffolding:
 * build the module→file map, parse each matching file, hand the tree to
 * `extractEdges`, de-dupe, and free each WASM-backed Tree. The per-language
 * logic lives in the spec; this is the language-agnostic engine.
 */
export function createTreeSitterImporter(spec: TreeSitterImporterSpec): Importer {
  const matches = (path: string) => spec.extensions.some((e) => path.endsWith(e));
  return {
    name: spec.name,
    extensions: spec.extensions,
    needsContent: true,
    async extract({ files, moduleRoot, baseDir }): Promise<ImportResult> {
      // Namespace module keys by crate root when the run spans multiple crates — two crates
      // both mapping `crate::app` to DIFFERENT files would silently mis-resolve imports.
      let moduleKey = (f: SourceFile): string => spec.fileToModule(f.path, moduleRoot, baseDir);
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
        }
      }
      const moduleToFile = new Map<string, string>();
      for (const f of files) if (matches(f.path)) moduleToFile.set(moduleKey(f), f.path);

      const parser = await getGrammarParser(spec.wasmBasename);
      // parse + tree ownership: the Tree is WASM-backed — the caller must delete() it.
      const parse = (content: string): Tree | null => {
        const tree = parser.parse(content);
        return tree ?? null;
      };

      // Enrich the module→file map with every declared submodule (inline + `mod x;`). The
      // declared key always equals the target's own path-derived module (rust `mod x;` targets
      // are path-aligned: sibling or name/ dir), so one pass over all files is order-free.
      if (spec.declareModules) {
        const fileSet = new Set(files.map((f) => f.path));
        for (const f of files) {
          if (!matches(f.path)) continue;
          const tree = parse(f.content);
          if (!tree) continue;
          try {
            const base = moduleKey(f);
            for (const m of spec.declareModules(tree.rootNode, f.path, fileSet)) {
              moduleToFile.set(`${base}::${m.path.join('::')}`, m.targetFile ?? f.path);
            }
          } finally {
            tree.delete();
          }
        }
      }

      const edges: ImportEdge[] = [];
      const unresolved: UnresolvedImport[] = [];
      for (const f of files) {
        if (!matches(f.path)) continue;
        const tree = parse(f.content);
        if (!tree) continue;
        try {
          const importerModule = moduleKey(f);
          const seen = new Set<string>();
          const { edges: fileEdges, unresolved: fileUnresolved } = spec.extractEdges(tree.rootNode, f.path, importerModule, moduleToFile);
          for (const e of fileEdges) {
            if (e.toFile !== f.path && !seen.has(e.toFile)) {
              seen.add(e.toFile);
              edges.push(e);
            }
          }
          unresolved.push(...fileUnresolved);
        } finally {
          tree.delete(); // web-tree-sitter Trees are WASM-backed — free each one to avoid leaking.
        }
      }
      return { edges, unresolved };
    },
  };
}
