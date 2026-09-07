import type { Node } from 'web-tree-sitter';
import type { ImportEdge, Importer, UnresolvedImport } from '../imports.js';
import { createTreeSitterImporter } from './tree-sitter.js';
import { factsOf, resolveOne } from './ts-resolution.js';

/**
 * TypeScript/JavaScript importer specs — three specs share one AST walk and one resolution
 * core: `typescript` (.ts/.d.ts), `tsx` (.tsx), `javascript` (.js/.jsx/.mjs/.cjs — the TS
 * grammar can't parse JSX, hence the tsx wasm). Specifier semantics (tsconfig paths aliases,
 * workspace package maps, NodeNext remaps, broken-local vs external classification) live in
 * the deep `ts-resolution` core; this file is only the AST extraction + edge shaping.
 */

// --- AST → specifiers ---

/** First string node in a statement subtree, or null. */
function findString(n: Node): Node | null {
  for (const c of n.namedChildren) {
    if (c.type === 'string') return c;
    const inner = findString(c);
    if (inner) return inner;
  }
  return null;
}

/** One import statement's data for the resolver: the source specifier + the EXPORTED names
 *  consumed from it (named imports/exports only - `import x from`, `* as ns`, and bare
 *  `import 'y'` consume no nameable surface, so their edges carry no symbols and the
 *  off-membrane check skips them honestly). */
interface SpecEntry {
  spec: string;
  names: string[];
}

/** Exported name of a specifier node - `a`, or the `a` of `a as b` (the alias is local,
 *  not the provider's name). */
function specName(node: Node): string {
  // strip a leading `type` import modifier (it is not part of the exported name)
  // and a trailing local alias — the provider's name is what provides lists carry
  return node.text.replace(/^type\s+/, '').split(/\s+as\s+/)[0];
}

/** Extract every import specifier from a parsed TS/JS tree: import/export statements (incl.
 *  `export * from` and `import x = require(...)` — the source is always the statement's string
 *  child), dynamic `import('x')` (call_expression on the `import` keyword — chained forms nest
 *  the same shape), CommonJS `require('x')`, and `/// <reference path="..." />` directives.
 *  Deduped per file. */
function collectSpecifiers(root: Node): SpecEntry[] {
  const byspec = new Map<string, string[]>();
  const add = (s: string, names: string[] = []): void => {
    byspec.set(s, [...(byspec.get(s) ?? []), ...names]);
  };
  // Named specifiers sit under the clause's own wrapper (import_clause → named_imports →
  // import_specifier), so collect recursively within the clause subtree.
  const clauseNames = (n: Node, clauseType: string, specType: string): string[] => {
    const names: string[] = [];
    const walk = (node: Node): void => {
      for (const c of node.namedChildren) {
        if (c.type === specType) names.push(specName(c));
        else walk(c);
      }
    };
    for (const c of n.namedChildren) if (c.type === clauseType) walk(c);
    return names;
  };
  const visit = (n: Node): void => {
    const t = n.type;
    if (t === 'import_statement') {
      // The source string is a direct child (`import x from 'y'`, `import 'y'`) — but
      // `import z = require('y')` nests it inside an import_require_clause. Recursive search
      // within the statement (its subtree holds nothing but the clause + the source).
      const src = findString(n);
      if (src && src.text.length >= 2) add(src.text.slice(1, -1), clauseNames(n, 'import_clause', 'import_specifier'));
    } else if (t === 'export_statement') {
      // Source string only when a from-clause is present: `export { x } from 'y'`
      // (export_clause), `export * as ns from 'y'` (namespace_export), or `export * from 'y'`
      // (the string is the ONLY named child — `*` is anonymous; matched by text).
      // `export default 'x'` and `export const x = '.'` also carry strings but are not imports.
      if (n.namedChildren.some((c) => c.type === 'export_clause' || c.type === 'namespace_export') || n.text.startsWith('export *')) {
        const src = n.namedChildren.find((c) => c.type === 'string');
        if (src && src.text.length >= 2) add(src.text.slice(1, -1), clauseNames(n, 'export_clause', 'export_specifier'));
      }
    } else if (t === 'call_expression') {
      const fn = n.namedChildren[0];
      if (fn && (fn.type === 'import' || (fn.type === 'identifier' && fn.text === 'require'))) {
        const lit = n.namedChildren[1]?.namedChildren.find((c) => c.type === 'string');
        if (lit && lit.text.length >= 2) add(lit.text.slice(1, -1));
      }
    } else if (t === 'comment') {
      const m = n.text.match(/^\/\/\/\s*<reference\s+path="([^"]+)"\s*\/>/);
      if (m) add(m[1]);
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return [...byspec].map(([spec, names]) => ({ spec, names }));
}

// --- the importers ---

/** Shared spec for the three TS-family importers: module key = the repo-relative path itself
 *  (identity), resolution via the shared ts-resolution core. */
function makeTsImporter(name: string, extensions: readonly string[], wasmBasename: string): Importer {
  return createTreeSitterImporter<SpecEntry[]>({
    name,
    extensions,
    wasmBasename,
    fileToModule: (path) => path,
    analyze: (root) => ({ mods: [], reexports: [], uses: collectSpecifiers(root) }),
    resolveEdges: (specs, sourcePath, _importerModule, ctx) => {
      const facts = factsOf(ctx); // once per extract — the expensive maps build here
      const edges: ImportEdge[] = [];
      const unresolved: UnresolvedImport[] = [];
      const flagged = new Set<string>();
      for (const { spec, names } of specs) {
        const { toFile, local } = resolveOne(spec, sourcePath, ctx, facts);
        if (toFile) {
          // Edge only when the target is a census file; an existing non-code target (css,
          // json, out-of-census) is a real import with no owned file — silent, like the
          // old pipeline dropping unowned edges downstream.
          if (ctx.files.has(toFile)) edges.push({ fromFile: sourcePath, toFile, import: spec, ...(names.length > 0 ? { symbols: names } : {}) });
        } else if (local && !flagged.has(spec)) {
          flagged.add(spec); // one flag per distinct broken specifier
          unresolved.push({ fromFile: sourcePath, import: spec });
        }
      }
      return { edges, unresolved };
    },
  });
}

/** TS importer — .ts/.d.ts (the typescript grammar can't parse JSX; .tsx gets its own spec). */
export const typescriptImporter = makeTsImporter('typescript', ['.ts', '.d.ts'], 'tree-sitter-typescript.wasm');
/** TSX importer — .tsx (tree-sitter-typescript ships a dedicated tsx grammar). */
export const tsxImporter = makeTsImporter('tsx', ['.tsx'], 'tree-sitter-tsx.wasm');
/** JS importer — .js/.jsx/.mjs/.cjs (the javascript grammar; the TS grammar would also parse
 *  most JS, but JSX in .jsx and CJS idioms are its grammar's home turf). */
export const javascriptImporter = makeTsImporter('javascript', ['.js', '.jsx', '.mjs', '.cjs'], 'tree-sitter-javascript.wasm');
