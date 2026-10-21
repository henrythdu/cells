/**
 * The importer contract. This module defines how the system models file-to-file imports
 * and how a per-language plugin reports them. It is more fundamental than crossings:
 * importers produce these edges, and crossings derive cell-to-cell pairs from them.
 */

/**
 * A raw import edge: file A imports file B through the specifier `import`.
 *
 * `symbols`, when the importer keeps them, holds the exported names that the importing
 * file consumes. These are named imports, from-import names, and use-path tail items. The
 * off-membrane check compares this list with the `provides` list of the target cell.
 *
 * An absent `symbols` value means that the importer cannot see the named consumption. The
 * cause is a module dependency, a namespace import, or a language importer that does not
 * keep symbols.
 */
export interface ImportEdge {
  fromFile: string;
  toFile: string;
  import: string;
  symbols?: string[];
}

/**
 * An import that looks local (it is relative, or it matches a local package) but resolves
 * to no owned file. The system reports it as a diagnostic. The usual cause is a broken
 * import or a module-root mismatch.
 */
export interface UnresolvedImport {
  fromFile: string;
  import: string; // The raw specifier as written in the source.
}

/** A source file with its content. This is the unit that importers parse. */
export interface SourceFile {
  path: string;
  content: string;
}

/** The context that every importer receives. */
export interface ImportContext {
  codeDirs: string[];
  files: SourceFile[];
  /**
   * The directory where the code is. The value '.' means the working repository. For
   * `crossings --diff`, the value is a directory of the HEAD tree. An importer that reads
   * the file system maps its output paths back to repository-relative paths.
   */
  baseDir?: string;
  /**
   * The path prefix that the system removes from module names. Example: "src" for the
   * Python src layout. The value is passed to `fileToModule` of each importer. A language
   * with a fixed or a derived root, such as the `src/` root of Rust or the root from
   * `go.mod` of Go, ignores it.
   */
  moduleRoot?: string;
}

/** The result of one importer: resolved edges, plus imports that look local but did not resolve. */
export interface ImportResult {
  edges: ImportEdge[];
  unresolved: UnresolvedImport[];
}

/**
 * An importer extracts file-to-file import edges for a set of file extensions. There is one
 * importer for each language, and the extension selects it automatically.
 *
 * Resolution uses the module maps that the system derives from ownership, plus probes on
 * disk. The importer specification for each language in `src/languages/` decides its own
 * resolution.
 *
 * The importer must never return zero silently. An import that cannot resolve must become
 * one of three results: an edge, an `unresolved` entry, or a classification that evidence
 * supports. The importer may skip an external package. But a target that exists in the
 * repository MUST appear, even when a configuration value (module-root, aliases) does not
 * align the maps. An absent import is invisible, and a dropped import reads as "this
 * repository has no dependencies", so the gate stays green. See
 * `probeModuleRootMismatch` in the Python importer for the pattern.
 */
export interface Importer {
  /** A name for error messages, for example "python". */
  name: string;
  /** The extensions that this importer handles, for example ['.ts', '.tsx']. */
  extensions: readonly string[];
  /** When true, the importer needs the file contents, not only the paths. */
  needsContent?: boolean;
  /**
   * Extract the file-to-file edges and the unresolved local imports. The function is
   * deterministic for the same inputs and the same file system state, and it may read the
   * file system through a library.
   */
  extract(ctx: ImportContext): Promise<ImportResult>;
}
