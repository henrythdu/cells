import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language, type Node } from "web-tree-sitter";
import type { ImportEdge, Importer } from "./crossings.js";

/**
 * Shared tree-sitter importer infrastructure: a grammar-WASM singleton cache +
 * a factory that owns the parse loop. Each language importer supplies only its
 * language-specific logic (module derivation, AST extraction, resolution).
 */

// --- grammar singleton cache (one Parser per grammar WASM; lazy + memoized) ---
const parsers = new Map<string, Promise<Parser>>();

/** Load (once) + cache the tree-sitter Parser for a bundled grammar WASM. */
export function getGrammarParser(wasmBasename: string): Promise<Parser> {
	let p = parsers.get(wasmBasename);
	if (!p) {
		p = (async () => {
			await Parser.init();
			// WASMs ship as static assets in grammars/ (built ABI-matched to web-tree-sitter;
			// the prebuilt tree-sitter-wasms pack is OLD-CLI/incompatible — see memory 155).
			const wasm = join(
				dirname(fileURLToPath(import.meta.url)),
				"..",
				"grammars",
				wasmBasename,
			);
			let lang: Language;
			try {
				lang = await Language.load(readFileSync(wasm));
			} catch {
				throw new Error(
					`Failed to load grammar WASM at ${wasm} — ensure the 'grammars/' directory is bundled with cells.`,
				);
			}
			const parser = new Parser();
			parser.setLanguage(lang);
			return parser;
		})().catch((err) => {
			parsers.delete(wasmBasename); // don't cache the rejection — allow retry on the next call
			throw err;
		});
		parsers.set(wasmBasename, p);
	}
	return p;
}

/** Spec for a tree-sitter language importer: the language-specific pieces. */
export interface TreeSitterImporterSpec {
	extensions: readonly string[];
	wasmBasename: string;
	fileToModule(path: string): string;
	/** Parse a tree's root into import edges (extraction + resolution). Self-loops
	 *  and duplicate targets are de-duped by the factory. */
	extractEdges(
		root: Node,
		sourcePath: string,
		importerModule: string,
		moduleToFile: Map<string, string>,
	): ImportEdge[];
}

/**
 * Build an Importer from a tree-sitter spec. Owns the shared loop scaffolding:
 * build the module→file map, parse each matching file, hand the tree to
 * `extractEdges`, de-dupe, and free each WASM-backed Tree. The per-language
 * logic lives in the spec; this is the language-agnostic engine.
 */
export function createTreeSitterImporter(
	spec: TreeSitterImporterSpec,
): Importer {
	const matches = (path: string) =>
		spec.extensions.some((e) => path.endsWith(e));
	return {
		extensions: spec.extensions,
		needsContent: true,
		async extract({ files }): Promise<ImportEdge[]> {
			const moduleToFile = new Map<string, string>();
			for (const f of files)
				if (matches(f.path))
					moduleToFile.set(spec.fileToModule(f.path), f.path);

			const parser = await getGrammarParser(spec.wasmBasename);
			const edges: ImportEdge[] = [];
			for (const f of files) {
				if (!matches(f.path)) continue;
				const tree = parser.parse(f.content);
				if (!tree) continue;
				try {
					const importerModule = spec.fileToModule(f.path);
					const seen = new Set<string>();
					for (const e of spec.extractEdges(
						tree.rootNode,
						f.path,
						importerModule,
						moduleToFile,
					)) {
						if (e.toFile !== f.path && !seen.has(e.toFile)) {
							seen.add(e.toFile);
							edges.push(e);
						}
					}
				} finally {
					tree.delete(); // web-tree-sitter Trees are WASM-backed — free each one to avoid leaking.
				}
			}
			return edges;
		},
	};
}
