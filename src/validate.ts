import { posix } from 'node:path';
import type { Cell } from './declaration.js';
import type { ImportEdge } from './imports.js';
import type { Ownership } from './ownership.js';

/**
 * A `provides` entry that the code of the cell never references. The membrane describes
 * something that the code does not deliver, which is the mirror image of a stale `requires`
 * entry.
 *
 * This is an information-level result. A model decides whether the export was removed (drop
 * the entry) or the code lost it (restore it). Never a gate.
 */
export interface StaleProvide {
  cell: string;
  provide: string;
}

/**
 * Test whether `content` contains `token` as a whole word (an identifier).
 *
 * The function uses `indexOf` and boundary characters and not RegExp, because the tokens are
 * identifiers that the caller controls. A non-literal RegExp would also trigger the
 * non-literal-regexp lint rule for no benefit.
 */
function containsIdentifier(content: string, token: string): boolean {
  let i = content.indexOf(token);
  while (i !== -1) {
    const before = i === 0 ? '' : content[i - 1];
    const after = i + token.length >= content.length ? '' : content[i + token.length];
    if (!/[$A-Za-z0-9_]/.test(before) && !/[$A-Za-z0-9_]/.test(after)) return true;
    i = content.indexOf(token, i + 1);
  }
  return false;
}

/**
 * A `provides` entry for which the system found no reader, in the owned files or in another
 * cell (through an import-edge symbol, a string literal, or a namespace-attribute tail).
 *
 * This is an information-level result. The label states the measurement and not the
 * conclusion, because the absence of a found reader is not proof of death. For example,
 * `import pkg.sub; pkg.attr` reads are invisible to the census.
 *
 * The result is biased toward silence: every evidence source suppresses and none raises.
 * Never a gate.
 */
export interface UnreadProvide {
  cell: string;
  provide: string;
}

/**
 * The leading token of a `provides` entry that the check can match, or null when the entry is
 * not identifier-shaped (prose, which the check skips and never reports).
 *
 * An identifier-shaped entry is one of these three:
 *
 * - function-call style, such as "collectImportEdges()";
 * - internal-uppercase camelCase, PascalCase, or SCREAMING_CASE;
 * - multi-segment snake_case, including a private underscore, such as "cap_output_width" and
 *   "_drawn_portions". Prose never joins words with underscores, so prose false positives are
 *   near zero in practice, and an underscored prose entry that matches is close to a real
 *   signal.
 *
 * A single lowercase word ("port", "stash") and a dunder name ("__all__") stay skipped,
 * because they are ambiguous with prose. The stale check and the unread check both use this
 * function. Pure.
 */
function providesToken(provide: string): string | null {
  const token = provide.match(/^[$\w]+/)?.[0];
  if (!token) return null;
  const rest = provide.slice(token.length);
  // Function-call style, internal uppercase, or multi-segment snake_case with an optional private underscore.
  const looksLikeId = rest.startsWith('(') || /[A-Z]/.test(token.slice(1)) || /^_?[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(token);
  return looksLikeId ? token : null;
}

/**
 * Report the `provides` entries whose leading token never appears in the owned files of the
 * cell.
 *
 * The check is conservative by design: it is a nudge and not a verdict. The function checks
 * only the entries whose leading token LOOKS like a real identifier: function-call style
 * ("collectImportEdges()"), internal-uppercase camelCase or SCREAMING ("ResolveCtx",
 * "DEFAULT_IMPORTERS"), or multi-segment snake_case ("cap_output_width"). It skips a pure
 * prose entry ("the parse loop"): the function cannot match it, and to report it would be a
 * false positive.
 *
 * Textual presence suppresses the report. This is the mirror of the unread caveat: the absence
 * of a found reader is not proof of death, and the presence of a mention is not proof of life.
 * A docstring that cites deleted code suppresses the report, which is intended, because the
 * check is biased toward silence. Pure.
 */
export function staleProvidesOf(cell: Cell, ownedFiles: string[], fileContents: Record<string, string>): StaleProvide[] {
  const contents = ownedFiles.map((f) => fileContents[f] ?? '').join('\n');
  const out: StaleProvide[] = [];
  for (const provide of cell.provides) {
    const token = providesToken(provide);
    if (!token) continue; // The entry is ambiguous prose. Skip it and never report it.
    if (!containsIdentifier(contents, token)) out.push({ cell: cell.name, provide });
  }
  return out;
}

/**
 * Refine the stale provides into unread provides: an entry is stale AND has no reader in any
 * other cell.
 *
 * A reader is an import-edge symbol that lands on a file of this cell, or a string literal
 * occurrence anywhere in the repository. A string binding in the TOOL_MAP style is an example.
 * If the check used only imports, it would report a false positive.
 *
 * The namespace-attribute tails come with the edge symbols, and both pilots supply them. The
 * function takes the stale list, because unread is a subset of stale by construction. One
 * name, one verdict: a caller shows the stale entry ONLY when the entry is not unread. Pure.
 */
export function unreadProvidesOf(stale: StaleProvide[], inboundSymbols: Set<string>, repoText: string): UnreadProvide[] {
  const out: UnreadProvide[] = [];
  for (const s of stale) {
    const token = providesToken(s.provide);
    if (!token) continue;
    if (inboundSymbols.has(token)) continue; // A reader found it through an import edge, including the attribute tails.
    if (containsIdentifier(repoText, token)) continue; // A reader found it through a string literal, or anywhere else.
    out.push({ cell: s.cell, provide: s.provide });
  }
  return out;
}

/**
 * The provides drift of the whole repository, with subsumption applied: a stale entry that is
 * also unread prints ONLY as unread (one name, one verdict).
 *
 * The function aggregates the inbound symbols by the owning cell of the target file and skips
 * the edges inside one cell, because the owned text already covers them. `repoText` must
 * include the whole repository, including the orphans, because a missed file is a missed
 * suppressor. The bias toward silence cuts both ways, so callers pass every file they have.
 *
 * Pure. The caller supplies the contents that it already read.
 */
export function providesDrift(
  declarations: Record<string, Cell>,
  ownership: Ownership,
  edges: ImportEdge[],
  contents: Record<string, string>,
): {
  stale: StaleProvide[];
  unread: UnreadProvide[];
  evaluated: number;
} {
  const fileToCell = new Map<string, string>();
  for (const [cell, files] of Object.entries(ownership)) for (const f of files) fileToCell.set(f, cell);
  const inbound = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!e.symbols?.length) continue;
    const to = fileToCell.get(e.toFile);
    if (!to || fileToCell.get(e.fromFile) === to) continue;
    let set = inbound.get(to);
    if (!set) {
      set = new Set();
      inbound.set(to, set);
    }
    for (const s of e.symbols) set.add(s);
  }
  const repoText = Object.values(contents).join('\n');
  const stale: StaleProvide[] = [];
  const unread: UnreadProvide[] = [];
  let evaluated = 0;
  for (const name of Object.keys(declarations)) {
    const cell = declarations[name];
    const full = cell.provides.length === 0 ? [] : staleProvidesOf(cell, ownership[name] ?? [], contents);
    evaluated += cell.provides.filter((p) => providesToken(p) !== null).length;
    const un = unreadProvidesOf(full, inbound.get(name) ?? new Set(), repoText);
    const unSet = new Set(un.map((u) => u.provide));
    stale.push(...full.filter((s) => !unSet.has(s.provide)));
    unread.push(...un);
  }
  return { stale, unread, evaluated };
}
/**
 * A path that would read outside the repository: an absolute path, or a path that still has a
 * `..` segment after normalization.
 *
 * This is a lexical check only, and symlinks are out of scope. The census already follows
 * them, and `assign` removes duplicates by real path.
 *
 * `validatePartition` uses the function to report the violation, and `io.readFiles` uses it to
 * refuse the read. One definition, both ends. Pure.
 */
export function isUnsafePath(p: string): boolean {
  const norm = posix.normalize(p);
  return posix.isAbsolute(p) || /^[A-Za-z]:/.test(p) || norm === '..' || norm.startsWith('../') || norm.split('/').includes('..');
}

type ViolationKind =
  | 'duplicate' // A file that 2 or more cells own. This violates non-overlap.
  | 'dangling' // An owned file that is missing from disk.
  | 'outside-census' // An owned file that exists on disk but that the census never sees: a skip-listed directory, a non-code extension, or a path outside code-dirs.
  | 'undeclared-cell' // Ownership refers to a cell that has no declaration.
  | 'unknown-require' // A cell requires a cell that has no declaration.
  | 'unsafe-path'; // An owned path that is absolute or that escapes the repository root.

export interface Violation {
  kind: ViolationKind;
  detail: string;
}

/**
 * Check the integrity of the partition.
 *
 * Pure. The function takes the parsed ownership, the declarations, the list of code files on
 * disk, and a probe for disk truth (the CLI reads the disk). It returns the violations.
 *
 * Non-overlap is the structural invariant, and the other checks report the health of the
 * partition. An unowned file is NOT a violation: it is neutral visibility that `list` shows,
 * and `.cells/ignore` declares the files that are intentionally free of cells.
 *
 * The legal ownership states:
 *
 * - owned and in the census: normal;
 * - owned, on disk, and not in the census (illegal, `outside-census`): the census skipped the
 *   file, and ownership partitions the census, so the file is invisible to the importers
 *   permanently;
 * - owned and not on disk (`dangling`): the file disappeared, so remove the entry.
 */
export function validatePartition(ownership: Ownership, declarations: Record<string, Cell>, codeFiles: string[], onDisk: (file: string) => boolean): Violation[] {
  const violations: Violation[] = [];
  const codeSet = new Set(codeFiles);

  // 1. Single-valued check: a file that 2 or more cells own. The function reports an unsafe
  //    path and removes it from the other checks, because it is not a real file and a read
  //    would escape the repository.
  const ownerOf: Record<string, string> = {};
  const owned = new Set<string>();
  for (const [cell, files] of Object.entries(ownership)) {
    for (const file of files) {
      if (isUnsafePath(file)) {
        violations.push({ kind: 'unsafe-path', detail: `${file} (cell ${cell}) is absolute or escapes the repo root` });
        continue;
      }
      owned.add(file);
      if (ownerOf[file]) {
        violations.push({
          kind: 'duplicate',
          detail: `${file} owned by both ${ownerOf[file]} and ${cell}`,
        });
      } else {
        ownerOf[file] = cell;
      }
    }
  }

  // 2. Dangling and outside-census: an owned file that the census never saw. When the file is
  //    on disk, the census excluded it (a skip-listed directory, a non-code extension, or a
  //    path outside code-dirs), which is an illegal state because ownership partitions the
  //    census. When the file is not on disk, it disappeared, so remove the entry.
  for (const file of owned) {
    if (codeSet.has(file)) continue;
    if (onDisk(file)) {
      violations.push({
        kind: 'outside-census',
        detail: `${file} exists on disk but is not in the code census (skip-listed dir, non-code extension, or outside code-dirs) — ownership partitions the census; remove the entry, un-skip via skip-dirs, or fix code-dirs/code-exts`,
      });
    } else {
      violations.push({ kind: 'dangling', detail: `${file} listed but not on disk` });
    }
  }

  // 3. Undeclared cell: an ownership key with no declaration.
  for (const cell of Object.keys(ownership)) {
    if (!(cell in declarations)) {
      violations.push({ kind: 'undeclared-cell', detail: `${cell} has no declaration` });
    }
  }

  // 4. Unknown require: a cell requires a cell with no declaration. The check reads both
  //    keys, because a dangling `data-requires` reference is the same integrity break.
  for (const [cell, decl] of Object.entries(declarations)) {
    const refs: [key: string, names: string[]][] = [
      ['requires', decl.requires],
      ['data-requires', decl.dataRequires ?? []],
    ];
    for (const [key, names] of refs) {
      for (const req of names) {
        if (!(req in declarations)) {
          const owning = Object.entries(declarations).find(([, d]) => d.provides.includes(req));
          const hint = owning ? ` — hint: '${req}' is a provides label of ${owning[0]}. Use '${owning[0]}' instead.` : '';
          violations.push({
            kind: 'unknown-require',
            detail: `${cell} ${key} unknown cell '${req}'${hint}`,
          });
        }
      }
    }
  }

  return violations;
}
