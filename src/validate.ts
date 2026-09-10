import { posix } from 'node:path';
import type { Cell } from './declaration.js';
import type { ImportEdge } from './imports.js';
import type { Ownership } from './ownership.js';

/** A provides entry the cell's own code never references — the membrane describes
 *  something the code doesn't deliver (mirror of stale requires). Info-level: the LLM
 *  decides whether the export was removed (drop the entry) or the code lost it (restore
 *  it). Never a gate. */
export interface StaleProvide {
  cell: string;
  provide: string;
}

/** Word-boundary membership: does `content` contain `token` as a whole word (identifier)?
 *  indexOf + boundary chars instead of RegExp — tokens are caller-constrained identifiers,
 *  and a non-literal RegExp would trip the non-literal-regexp lint for zero benefit. */
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

/** A provides entry no reader was found for — neither in owned files nor in other cells
 *  (import-edge symbol, string-literal occurrence, or namespace-attribute tail). Info-level:
 *  the label states the measurement, not the conclusion — absence of a found reader is not
 *  proof of death (e.g. `import pkg.sub; pkg.attr` reads are invisible to the census).
 *  Silence-biased by construction: every evidence source suppresses, never raises. Never a gate. */
export interface UnreadProvide {
  cell: string;
  provide: string;
}

/** The matchable leading token of a provides entry, or null when the entry isn't
 *  identifier-shaped (prose — skipped, never flagged). Shared by stale + unread. Pure. */
function providesToken(provide: string): string | null {
  const token = provide.match(/^[$\w]+/)?.[0];
  if (!token) return null;
  const rest = provide.slice(token.length);
  const looksLikeId = rest.startsWith('(') || /[A-Z]/.test(token.slice(1)); // fn-call style, or internal-uppercase (camelCase/Pascal/SCREAMING)
  return looksLikeId ? token : null;
}

/** Flag provides entries whose leading token never appears in the cell's owned files.
 *  Conservative by design (a nudge, not a verdict): only entries whose leading token
 *  LOOKS like a real identifier are checked — function-call style ("collectImportEdges()") or internal-uppercase camelCase/SCREAMING ("ResolveCtx", "DEFAULT_IMPORTERS"). Pure
 *  prose entries ("the parse loop") are skipped — they can't be matched, and flagging
 *  them would be a false positive. Pure. */
export function staleProvidesOf(cell: Cell, ownedFiles: string[], fileContents: Record<string, string>): StaleProvide[] {
  const contents = ownedFiles.map((f) => fileContents[f] ?? '').join('\n');
  const out: StaleProvide[] = [];
  for (const provide of cell.provides) {
    const token = providesToken(provide);
    if (!token) continue; // ambiguous prose — skip, never flag
    if (!containsIdentifier(contents, token)) out.push({ cell: cell.name, provide });
  }
  return out;
}

/** Refine stale provides into unread: stale AND no reader in any other cell. Readers are
 *  import-edge symbols landing on this cell's files plus string-literal occurrences
 *  anywhere in the repo (TOOL_MAP-style string binding — import-only readership would
 *  false-flag). Namespace-attribute tails ride the edge symbols (both pilots feed this).
 *  Takes the stale list (unread ⊆ stale by construction) — one name, one verdict: callers
 *  display the stale entry ONLY when it isn't unread. Pure. */
export function unreadProvidesOf(stale: StaleProvide[], inboundSymbols: Set<string>, repoText: string): UnreadProvide[] {
  const out: UnreadProvide[] = [];
  for (const s of stale) {
    const token = providesToken(s.provide);
    if (!token) continue;
    if (inboundSymbols.has(token)) continue; // read via import edge (incl. attribute tails)
    if (containsIdentifier(repoText, token)) continue; // read via string literal (or anywhere at all)
    out.push({ cell: s.cell, provide: s.provide });
  }
  return out;
}

/** Repo-wide provides drift with subsumption applied: stale entries that are also unread
 *  print ONLY as unread (one name, one verdict). Inbound symbols aggregate edge symbols
 *  by owning cell of the target file (same-cell edges skipped — owned text already
 *  covers them); repoText should span the whole repo, orphans included (a missed file is
 *  a missed suppressor — the silence bias cuts both ways, so callers pass everything).
 *  Pure — callers supply contents they already read. */
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
/** A path that would read outside the repo: absolute, or normalized to still contain a `..`
 *  segment. Lexical only — symlinks are out of scope (the census already follows them and
 *  assign dedupes by realpath). Shared by validatePartition (the gate flags it) and
 *  io.readFiles (the read seam refuses it) — one definition, both ends. Pure. */
export function isUnsafePath(p: string): boolean {
  const norm = posix.normalize(p);
  return posix.isAbsolute(p) || /^[A-Za-z]:/.test(p) || norm === '..' || norm.startsWith('../') || norm.split('/').includes('..');
}

type ViolationKind =
  | 'duplicate' // a file owned by 2+ cells (violates non-overlap)
  | 'dangling' // an owned file missing from disk
  | 'outside-census' // an owned file that exists on disk but the census never sees (skip-listed dir / non-code ext / outside code-dirs)
  | 'undeclared-cell' // ownership references a cell with no declaration
  | 'unknown-require' // a cell requires a cell with no declaration
  | 'unsafe-path'; // an owned path that is absolute or escapes the repo root

export interface Violation {
  kind: ViolationKind;
  detail: string;
}

/**
 * Check partition integrity. Pure: takes parsed ownership + declarations +
 * the list of code files on disk + a disk-truth probe (the CLI does the IO),
 * returns violations.
 *
 * Non-overlap is the structural invariant; the rest surface the partition's
 * health. (Unowned files are NOT a violation — they're neutral visibility,
 * surfaced by `list`; `.cells/ignore` declares intentional cell-free files.)
 *
 * Legal ownership states: owned ∧ in-census (normal), owned ∧ on-disk ∧
 * ¬in-census (illegal — `outside-census`: the census skipped it; ownership
 * partitions the census, so the file is invisible to importers forever),
 * owned ∧ ¬on-disk (dangling — vanished file, prune the entry).
 */
export function validatePartition(ownership: Ownership, declarations: Record<string, Cell>, codeFiles: string[], onDisk: (file: string) => boolean): Violation[] {
  const violations: Violation[] = [];
  const codeSet = new Set(codeFiles);

  // 1. single-valued: a file in 2+ cells. Unsafe paths are flagged and excluded from the
  //    other checks (they are not real files — a read would escape the repo).
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

  // 2. dangling/outside-census: owned file the census never saw. On disk → the census
  //    excluded it (skip-listed dir / non-code ext / outside code-dirs) — an illegal
  //    state, ownership partitions the census. Not on disk → a vanished file (prune).
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

  // 3. undeclared-cell: ownership key with no declaration.
  for (const cell of Object.keys(ownership)) {
    if (!(cell in declarations)) {
      violations.push({ kind: 'undeclared-cell', detail: `${cell} has no declaration` });
    }
  }

  // 4. unknown-require: a cell requires a cell with no declaration (both keys — a
  //    dangling data-requires ref is the same integrity break).
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
