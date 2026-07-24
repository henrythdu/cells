import { extname, join, resolve, relative } from "node:path";
import { cruise, type ICruiseResult } from "dependency-cruiser";
import type { ImportEdge, SourceFile, Importer } from "./crossings.js";
import { loadConfig, loadOwnership, listCodeFiles, readFiles } from "./io.js";

/** dep-cruiser importer — TS/JS. Source-based; handles aliases and `.js`→`.ts`. */
export const depCruiserImporter: Importer = {
	extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"],
	async extract({ codeDirs, baseDir }): Promise<ImportEdge[]> {
		const dirs = codeDirs.map((d) => (d.endsWith("/") ? d : `${d}/`));
		let result: ICruiseResult;
		try {
			const { output } = await cruise(dirs, {
				tsPreCompilationDeps: true,
				doNotFollow: { path: "node_modules" },
			});
			result = output as ICruiseResult;
		} catch {
			return []; // dep-cruiser couldn't handle the paths/language — no edges.
		}
		// dep-cruiser emits paths relative to cwd; when cruising a HEAD tree (baseDir) remap them
		// to repo-relative so they match ownership. (Tree-sitter importers already emit repo-relative.)
		const cwd = process.cwd();
		const norm = (p: string): string => {
			const n = p.replace(/^\.\//, "");
			return baseDir && baseDir !== "." ? relative(baseDir, resolve(cwd, n)) : n;
		};
		const edges: ImportEdge[] = [];
		for (const mod of result.modules ?? []) {
			for (const dep of mod.dependencies ?? []) {
				if (dep.couldNotResolve || dep.coreModule) continue; // external / node built-in
				if (!dep.resolved) continue;
				edges.push({
					fromFile: norm(mod.source),
					toFile: norm(dep.resolved),
					import: dep.module,
				});
			}
		}
		return edges;
	},
};

// Python importer lives in ./python.js; Rust importer in ./rust.js (tree-sitter extraction + module→file resolution via ownership).
import { pythonImporter } from "./python.js";
import { rustImporter } from "./rust.js";
export { pythonImporter, rustImporter };

/** Default importer registry (add a language = add an importer here). */
export const DEFAULT_IMPORTERS: readonly Importer[] = [
	depCruiserImporter,
	pythonImporter,
	rustImporter,
];

/** Which importers run for the given extensions. Pure — unit-testable. */
export function selectImporters(
	exts: readonly string[],
	importers: readonly Importer[],
): Importer[] {
	const present = new Set(exts);
	return importers.filter((imp) => imp.extensions.some((e) => present.has(e)));
}

/** Extensions present in the census that NO importer handles. Non-empty means the
 * crossings graph is BLIND for those files — crossings/impact/structure/graph are
 * unverified. Sorted + deduped. Pure — unit-testable. */
export function uncoveredImporterExts(
	exts: readonly string[],
	importers: readonly Importer[],
): string[] {
	const covered = new Set(importers.flatMap((i) => i.extensions));
	return [...new Set(exts)].filter((e) => !covered.has(e)).sort();
}

/**
 * Collect raw file→file import edges by dispatching to importers by extension.
 * The only language-coupled seam in Cells; everything downstream consumes ImportEdge[].
 */
export async function collectImportEdges(baseDir = "."): Promise<{
	edges: ImportEdge[];
	uncoveredExts: string[];
}> {
	const { codeDirs } = loadConfig();
	const ownership = loadOwnership();
	const paths = listCodeFiles(baseDir);
	const exts = Array.from(new Set(paths.map((p) => extname(p))));
	const selected = selectImporters(exts, DEFAULT_IMPORTERS);
	const uncoveredExts = uncoveredImporterExts(exts, DEFAULT_IMPORTERS);
	let files: SourceFile[];
	if (selected.some((i) => i.needsContent)) {
		const contents = readFiles(paths, baseDir);
		files = paths.map((p) => ({ path: p, content: contents[p] ?? "" }));
	} else {
		files = paths.map((p) => ({ path: p, content: "" }));
	}
	// dep-cruiser cruises dirs (FS); tree-sitter reads `files`. Point both at `baseDir` so a
	// HEAD tree can be derived for `crossings --diff`. `.cells/` stays in the working repo.
	const dirs = codeDirs.map((d) => join(baseDir, d));
	const results = await Promise.all(
		selected.map((imp) =>
			imp.extract({ codeDirs: dirs, files, ownership, baseDir }).catch(() => []),
		),
	);
	const edges: ImportEdge[] = [];
	for (const result of results) edges.push(...result);
	return { edges, uncoveredExts };
}
