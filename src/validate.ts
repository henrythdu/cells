import type { Cell } from './declaration.js';
import type { Ownership } from './ownership.js';

export type ViolationKind =
  | 'duplicate' // a file owned by 2+ cells (violates non-overlap)
  | 'dangling' // an owned file missing from disk
  | 'undeclared-cell' // ownership references a cell with no declaration
  | 'unknown-require'; // a cell requires a cell with no declaration

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
export function validatePartition(
  ownership: Ownership,
  declarations: Record<string, Cell>,
  codeFiles: string[],
): Violation[] {
  const violations: Violation[] = [];
  const codeSet = new Set(codeFiles);

  // 1. single-valued: a file in 2+ cells.
  const ownerOf: Record<string, string> = {};
  for (const [cell, files] of Object.entries(ownership)) {
    for (const file of files) {
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

  const owned = new Set(Object.values(ownership).flat());

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
        violations.push({
          kind: 'unknown-require',
          detail: `${cell} requires unknown cell ${req}`,
        });
      }
    }
  }

  return violations;
}
