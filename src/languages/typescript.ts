import type { Node } from 'web-tree-sitter';
import type { ImportEdge, Importer, UnresolvedImport } from '../imports.js';
import { createTreeSitterImporter } from './tree-sitter.js';
import { factsOf, resolveOne } from './ts-resolution.js';

/**
 * The TypeScript and JavaScript importer specs. Three specs share one AST walk and one
 * resolution core: `typescript` (`.ts`, `.d.ts`), `tsx` (`.tsx`), and `javascript` (`.js`,
 * `.jsx`, `.mjs`, `.cjs`). The TypeScript grammar cannot parse JSX, which is why the tsx
 * grammar has its own WASM file.
 *
 * The specifier semantics live in the deep `ts-resolution` core: tsconfig path aliases,
 * workspace package maps, NodeNext remaps, and the classification of broken-local against
 * external. This file contains only the AST extraction and the edge shaping.
 */

// --- From the AST to the specifiers ---

/** Return the first node of the given type in a statement subtree, or null. */
function findType(n: Node, type: string): Node | null {
  for (const c of n.namedChildren) {
    if (c.type === type) return c;
    const inner = findType(c, type);
    if (inner) return inner;
  }
  return null;
}

/** Return the first string node in a statement subtree, or null. */
function findString(n: Node): Node | null {
  return findType(n, 'string');
}

/** The data of one import statement for the resolver: the source specifier and the exported
 *  names consumed from it. Only named imports and exports count. `import x from`, `* as ns`,
 *  and a bare `import 'y'` consume no nameable surface, so their edges carry no symbols and
 *  the off-membrane check skips them. That result is honest. */
interface SpecEntry {
  spec: string;
  names: string[];
}

/** Return the exported name of a specifier node: `a`, or the `a` of `a as b`. The alias is
 *  local, so it is not the name of the provider. */
function specName(node: Node): string {
  // Remove a leading `type` import modifier, because it is not part of the exported name.
  // Then remove a trailing local alias, because the provides list carries the provider name.
  return node.text.replace(/^type\s+/, '').split(/\s+as\s+/)[0];
}

/** Extract every import specifier from a parsed TS or JS tree. The function handles import
 *  and export statements, including `export * from` and `import x = require(...)`, where
 *  the source is always the string child of the statement. It also handles a dynamic
 *  `import('x')` (a call_expression on the `import` keyword, where chained forms nest the
 *  same shape), a CommonJS `require('x')`, and a `/// <reference path="..." />` directive.
 *  The result is deduplicated per file. */
function collectSpecifiers(root: Node): SpecEntry[] {
  const byspec = new Map<string, string[]>();
  const add = (s: string, names: string[] = []): void => {
    byspec.set(s, [...(byspec.get(s) ?? []), ...names]);
  };
  // The named specifiers sit under the wrapper of the clause (import_clause, then named_imports,
  // then import_specifier), so collect them recursively inside the clause subtree.
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
      // The source string is a direct child (`import x from 'y'`, `import 'y'`). But
      // `import z = require('y')` nests it inside an import_require_clause. Search
      // recursively inside the statement, because its subtree holds only the clause and the
      // source.
      const src = findString(n);
      if (src && src.text.length >= 2) add(src.text.slice(1, -1), clauseNames(n, 'import_clause', 'import_specifier'));
    } else if (t === 'export_statement') {
      // The source string exists only when a from-clause is present: `export { x } from
      // 'y'` (export_clause), `export * as ns from 'y'` (namespace_export), or `export *
      // from 'y'` (the string is the only named child; `*` is anonymous and matched by
      // text). `export default 'x'` and `export const x = '.'` also carry strings, but they
      // are not imports.
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

/** Return the namespace aliases per file, from a local name to a specifier, for example
 *  `import * as views from './views'`.
 *
 *  The map holds namespaces only. The attributes of a default import (`def.helper`) are
 *  properties of the default export, not module-level names. To attach them would poison the
 *  provides check with symbols that can never appear there legitimately. The default as
 *  namespace pattern of CJS interop is the documented recall cost. */
function collectNamespaceAliases(root: Node): Map<string, string> {
  const aliases = new Map<string, string>();
  const visit = (n: Node): void => {
    if (n.type === 'import_statement') {
      const src = findString(n);
      const ns = findType(n, 'namespace_import');
      const alias = ns?.namedChildren.find((c) => c.type === 'identifier');
      if (src && src.text.length >= 2 && alias) aliases.set(alias.text, src.text.slice(1, -1));
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return aliases;
}

/** Return the attribute symbols consumed through namespace aliases: `views.portions` becomes
 *  `portions` on the edge of the spec. Only the first tail segment counts, so
 *  `views.sub.deep` becomes `sub`, because a deeper chain is internal traversal below the
 *  provides granularity.
 *
 *  The function excludes these forms by construction: subscript and computed access,
 *  destructured locals (scope work, out of the pilot), type positions (different node
 *  families), and non-binding bases (locals, parameters, and globals are silently skipped).
 *  A shadowed local is misattributed openly, because the analysis uses file-level bindings
 *  and no scope tracking. The shadow fixture pins this stated caveat. */
function collectNamespaceUses(root: Node, aliases: Map<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const visit = (n: Node): void => {
    if (n.type === 'member_expression') {
      // Descend the chain of objects. The outermost property is deep traversal, and the
      // first tail is the name at provides granularity.
      let node = n;
      let obj = node.childForFieldName('object');
      while (obj && obj.type === 'member_expression') {
        node = obj;
        obj = node.childForFieldName('object');
      }
      const prop = node.childForFieldName('property');
      if (obj?.type === 'identifier' && prop?.type === 'property_identifier') {
        const spec = aliases.get(obj.text);
        if (spec) {
          const names = out.get(spec) ?? [];
          if (!names.includes(prop.text)) names.push(prop.text);
          out.set(spec, names);
        }
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return out;
}

// --- The importers ---

/** Build the shared spec for the three importers of the TS family. The module key is the
 *  repository-relative path itself (the identity), and the resolution uses the shared
 *  `ts-resolution` core. */
function makeTsImporter(name: string, extensions: readonly string[], wasmBasename: string): Importer {
  return createTreeSitterImporter<SpecEntry[]>({
    name,
    extensions,
    wasmBasename,
    fileToModule: (path) => path,
    analyze: (root) => {
      const specs = collectSpecifiers(root);
      // Pilot: visibility of namespace attributes (`views.portions` next to
      // `from views import`). The function appends the names to the edge symbols of the
      // binding source and deduplicates them. The crossings aggregation does not change.
      const aliases = collectNamespaceAliases(root);
      if (aliases.size > 0) {
        for (const [spec, names] of collectNamespaceUses(root, aliases)) {
          const entry = specs.find((s) => s.spec === spec);
          if (entry) entry.names.push(...names.filter((x) => !entry.names.includes(x)));
        }
      }
      return { mods: [], reexports: [], uses: specs };
    },
    resolveEdges: (specs, sourcePath, _importerModule, ctx) => {
      const facts = factsOf(ctx); // One time per extract. The expensive maps build here.
      const edges: ImportEdge[] = [];
      const unresolved: UnresolvedImport[] = [];
      const flagged = new Set<string>();
      for (const { spec, names } of specs) {
        const { toFile, local } = resolveOne(spec, sourcePath, ctx, facts);
        if (toFile) {
          // Add an edge only when the target is a census file. An existing non-code target
          // (css, json, out of the census) is a real import with no owned file. The function
          // stays silent, the same way as the old pipeline that dropped unowned edges
          // downstream.
          if (ctx.files.has(toFile)) edges.push({ fromFile: sourcePath, toFile, import: spec, ...(names.length > 0 ? { symbols: names } : {}) });
        } else if (local && !flagged.has(spec)) {
          flagged.add(spec); // One flag per distinct broken specifier.
          unresolved.push({ fromFile: sourcePath, import: spec });
        }
      }
      return { edges, unresolved };
    },
  });
}

/** The TS importer for `.ts` and `.d.ts`. The typescript grammar cannot parse JSX, so
 *  `.tsx` has its own spec. */
export const typescriptImporter = makeTsImporter('typescript', ['.ts', '.d.ts'], 'tree-sitter-typescript.wasm');
/** The TSX importer for `.tsx`. tree-sitter-typescript ships a dedicated tsx grammar. */
export const tsxImporter = makeTsImporter('tsx', ['.tsx'], 'tree-sitter-tsx.wasm');
/** The JS importer for `.js`, `.jsx`, `.mjs`, and `.cjs`, which uses the javascript grammar.
 *  The TypeScript grammar would also parse most JS, but JSX in `.jsx` files and the CJS
 *  idioms are at home in the javascript grammar. */
export const javascriptImporter = makeTsImporter('javascript', ['.js', '.jsx', '.mjs', '.cjs'], 'tree-sitter-javascript.wasm');
