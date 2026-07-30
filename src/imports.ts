import type { Ownership } from './ownership.js';

/**
 * The importer contract — how the system models file→file imports and the
 * per-language plugin interface. More fundamental than crossings: importers
 * PRODUCE these edges; crossings DERIVE cell→cell pairs from them.
 */

/** A raw import edge: file A imports file B via specifier `import`. */
export interface ImportEdge {
  fromFile: string;
  toFile: string;
  import: string;
}

/** A source file with its content — the unit importers parse. */
export interface SourceFile {
  path: string;
  content: string;
}

/** Context handed to every importer. */
export interface ImportContext {
  codeDirs: string[];
  files: SourceFile[];
  ownership: Ownership;
  /** Where code lives ('.' = the working repo). Set to a HEAD-tree dir for `crossings --diff`;
   *  importers that cruise the FS (dep-cruiser) remap their output paths to repo-relative. */
  baseDir?: string;
}

/**
 * An importer extracts file→file import edges for a set of file extensions.
 * One per language; selection is automatic by extension. Resolving an import to
 * a file may use `ownership` (e.g. Python derives a module→file map) rather than
 * filesystem heuristics — landing on a cell via ownership, not by competing with
 * the IDE on file resolution. (TS/JS impl: dep-cruiser; Python: tree-sitter.)
 */
export interface Importer {
  /** Extensions this importer handles, e.g. ['.ts', '.tsx']. */
  extensions: readonly string[];
  /** If true, the importer needs file *contents* (not just paths). */
  needsContent?: boolean;
  /** Extract file→file edges. Pure wrt its inputs (may read the FS via a lib). */
  extract(ctx: ImportContext): Promise<ImportEdge[]>;
}
