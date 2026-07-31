import { existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { cruise, type ICruiseOptions, type ICruiseResult } from 'dependency-cruiser';
import type { ImportEdge, ImportResult, UnresolvedImport, Importer } from '../imports.js';

/** dep-cruiser importer — TS/JS. Source-based; handles aliases and `.js`→`.ts`. */
export const depCruiserImporter: Importer = {
  name: 'typescript',
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'],
  async extract({ codeDirs, baseDir }): Promise<ImportResult> {
    const dirs = codeDirs.map((d) => (d.endsWith('/') ? d : `${d}/`));
    const cruiseOpts: ICruiseOptions = {
      tsPreCompilationDeps: true,
      doNotFollow: { path: 'node_modules' },
    };
    // Point dep-cruiser at the repo tsconfig explicitly — its auto-discovery misses it when
    // cruising a subdir (src/), which silently drops `paths` alias imports (`@/x`) as unresolved.
    const root = baseDir && baseDir !== '.' ? baseDir : process.cwd();
    const tsConfigPath = join(root, 'tsconfig.json');
    if (existsSync(tsConfigPath)) cruiseOpts.tsConfig = { fileName: tsConfigPath };
    let result: ICruiseResult;
    try {
      const { output } = await cruise(dirs, cruiseOpts);
      // guard the shape — a future cruise() default that stops returning the result object
      // would silently fake an empty graph (false green) if unchecked
      if (typeof output !== 'object' || output === null || !Array.isArray((output as ICruiseResult).modules)) {
        throw new Error('dependency-cruiser returned a non-JSON result');
      }
      result = output as ICruiseResult;
    } catch (err) {
      // dep-cruiser couldn't handle the paths/language — surface it; silent zero-edges
      // would fake a green gate on a blind graph. (collectImportEdges turns this into
      // a gate failure.)
      throw new Error(`dependency-cruiser failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // dep-cruiser emits paths relative to cwd; when cruising a HEAD tree (baseDir) remap them
    // to repo-relative so they match ownership. (Tree-sitter importers already emit repo-relative.)
    const cwd = process.cwd();
    const norm = (p: string): string => {
      const n = p.replace(/^\.\//, '');
      return baseDir && baseDir !== '.' ? relative(baseDir, resolve(cwd, n)) : n;
    };
    const edges: ImportEdge[] = [];
    const unresolved: UnresolvedImport[] = [];
    for (const mod of result.modules ?? []) {
      for (const dep of mod.dependencies ?? []) {
        if (dep.couldNotResolve) {
          // Relative specifiers and alias prefixes (`@/`, `~/`) that can't resolve look local —
          // likely a broken import or a missing tsconfig `paths` mapping. Bare specifiers
          // (e.g. 'react', '@scope/pkg') are external packages — skip silently.
          if (dep.module.startsWith('.') || dep.module.startsWith('@/') || dep.module.startsWith('~/')) unresolved.push({ fromFile: norm(mod.source), import: dep.module });
          continue;
        }
        if (dep.coreModule) continue; // node built-in
        if (dep.matchesDoNotFollow) continue; // external package (node_modules) — keep the graph to repo files
        if (!dep.resolved) continue;
        edges.push({
          fromFile: norm(mod.source),
          toFile: norm(dep.resolved),
          import: dep.module,
        });
      }
    }
    return { edges, unresolved };
  },
};
