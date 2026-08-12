import { posix } from 'node:path';
import type { Cell } from './declaration.js';
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
    if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) return true;
    i = content.indexOf(token, i + 1);
  }
  return false;
}

/** Flag provides entries whose leading token never appears in the cell's owned files.
 *  Conservative by design (a nudge, not a verdict): only entries whose leading token
 *  LOOKS like a real identifier are checked — function-call style ("collectImportEdges()")or internal-uppercase camelCase/SCREAMING ("ResolveCtx", "DEFAULT_IMPORTERS"). Pure
 *  prose entries ("the parse loop") are skipped — they can't be matched, and flagging
 *  them would be a false positive. Pure. */
export function staleProvidesOf(cell: Cell, ownedFiles: string[], fileContents: Record<string, string>): StaleProvide[] {
  const contents = ownedFiles.map((f) => fileContents[f] ?? '').join('\n');
  const out: StaleProvide[] = [];
  for (const provide of cell.provides) {
    const token = provide.match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
    if (!token) continue;
    const rest = provide.slice(token.length);
    const looksLikeId = rest.startsWith('(') || /[A-Z]/.test(token.slice(1)); // fn-call style, or internal-uppercase (camelCase/Pascal/SCREAMING)
    if (!looksLikeId) continue; // ambiguous prose — skip, never flag
    if (!containsIdentifier(contents, token)) out.push({ cell: cell.name, provide });
  }
  return out;
}
/** A path that would read outside the repo: absolute, or normalized to still contain a `..`
 *  segment. Lexical only — symlinks are out of scope (the census already follows them and
 *  assign dedupes by realpath). Shared by validatePartition (the gate flags it) and
 *  io.readFiles (the read seam refuses it) — one definition, both ends. Pure. */
export function isUnsafePath(p: string): boolean {
  const norm = posix.normalize(p);
  return posix.isAbsolute(p) || /^[A-Za-z]:/.test(p) || norm === '..' || norm.startsWith('../') || norm.split('/').includes('..');
}

export type ViolationKind =
  | 'duplicate' // a file owned by 2+ cells (violates non-overlap)
  | 'dangling' // an owned file missing from disk
  | 'undeclared-cell' // ownership references a cell with no declaration
  | 'unknown-require' // a cell requires a cell with no declaration
  | 'unsafe-path'; // an owned path that is absolute or escapes the repo root

export interface Violation {
  kind: ViolationKind;
  detail: string;
}

/**
 * Check partition integrity. Pure: takes parsed ownership + declarations +
 * the list of code files on disk (the CLI does the IO), returns violations.
 *
 * Non-overlap is the structural invariant; the rest surface the partition's
 * health. (Unowned files are NOT a violation — they're neutral visibility,
 * surfaced by `list`; `.cells/ignore` declares intentional cell-free files.)
 */
export function validatePartition(ownership: Ownership, declarations: Record<string, Cell>, codeFiles: string[]): Violation[] {
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

  // 2. dangling: owned file not on disk.
  for (const file of owned) {
    if (!codeSet.has(file)) {
      violations.push({ kind: 'dangling', detail: `${file} listed but not on disk` });
    }
  }

  // 3. undeclared-cell: ownership key with no declaration.
  for (const cell of Object.keys(ownership)) {
    if (!(cell in declarations)) {
      violations.push({ kind: 'undeclared-cell', detail: `${cell} has no declaration` });
    }
  }

  // 4. unknown-require: a cell requires a cell with no declaration.
  for (const [cell, decl] of Object.entries(declarations)) {
    for (const req of decl.requires) {
      if (!(req in declarations)) {
        const owning = Object.entries(declarations).find(([, d]) => d.provides.includes(req));
        const hint = owning ? ` — hint: '${req}' is a provides label of ${owning[0]}. Use '${owning[0]}' instead.` : '';
        violations.push({
          kind: 'unknown-require',
          detail: `${cell} requires unknown cell '${req}'${hint}`,
        });
      }
    }
  }

  return violations;
}
