import type { Cell } from './declaration.js';

/** Size of a cell's payload: file count, raw chars, ~tokens. */
export interface CellSize {
  files: number;
  chars: number;
  tokens: number;
}

/** chars → token estimate (the payload heuristic: ~3 chars/token). Single home — all
 *  size displays must route through here so they never disagree. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3);
}

/** Resolve a cell's neighbor declarations (for payload assembly) — both keys: a
 *  data-requires partner's membrane belongs in the context exactly like an import
 *  neighbor's (context completeness; the check semantics differ, the payload need doesn't). */
export function neighborsOf(cell: Cell, declarations: Record<string, Cell>): Cell[] {
  const names = [...cell.requires, ...(cell.dataRequires ?? [])];
  return [...new Set(names)].map((r) => declarations[r]).filter((c): c is Cell => Boolean(c));
}

/** Assemble a cell's payload and measure it — the context-fit metric (what the model consumes).
 *  Includes test files so the size gate (health/size) matches what `payload` actually emits.
 *  Pure: file contents are passed in (the caller reads them via io) — same seam as
 *  assemblePayload, so the module has no hidden IO dependency. */
export function computePayloadSize(cell: Cell, ownedFiles: string[], fileContents: Record<string, string>, neighbors: Cell[], testContents?: Record<string, string>): CellSize {
  const testFiles = cell.tests ?? [];
  const chars = assemblePayload({ cell, ownedFiles, fileContents, neighbors, testFiles, testContents }).length;
  return { files: ownedFiles.length + testFiles.length, chars, tokens: estimateTokens(chars) };
}

/** Render a cell's summary block for the neighbor / dependents sections of a payload.
 *  Neighbors get their membrane surface (provides + signatures); dependents get only
 *  their requires (what they expect from this cell) — the surface isn't needed to know
 *  who depends on you. Both close with the blank line the caller appends. */
function pushCellSummary(lines: string[], cell: Cell, opts: { provides: boolean }): void {
  lines.push(`### Cell: ${cell.name}`);
  lines.push(`purpose: ${cell.purpose}`);
  if (opts.provides) {
    lines.push(`provides: [${cell.provides.join(', ')}]`);
    if (cell.signatures && cell.signatures.length > 0) {
      lines.push('signatures:');
      for (const sig of cell.signatures) lines.push(`  - ${sig}`);
    }
  }
  lines.push(`requires: [${cell.requires.join(', ')}]`);
  if (cell.dataRequires && cell.dataRequires.length > 0) lines.push(`data-requires: [${cell.dataRequires.join(', ')}] (declared, not import-checked)`);
}

/**
 * Assemble a cell's completeness payload as a single markdown document:
 * the cell's declaration + full owned source + neighbor membranes (surfaces only).
 *
 * Pure: takes resolved data (no FS access). The CLI layer reads files
 * from disk and resolves neighbors from the declarations map. Single options
 * object — the two Record<string,string> and two Cell[] params were positionally
 * swappable; named fields remove the ordering hazard.
 */
export function assemblePayload(options: {
  cell: Cell;
  ownedFiles: string[];
  fileContents: Record<string, string>;
  neighbors: Cell[];
  dependedByCount?: number;
  testFiles?: string[];
  testContents?: Record<string, string>;
  dependents?: Cell[];
  coupled?: { cell: string; count: number; window: number; files?: string[] }[];
}): string {
  const { cell, ownedFiles, fileContents, neighbors, dependedByCount, testFiles, testContents, dependents, coupled } = options;
  const lines: string[] = [];

  lines.push(`# Cell: ${cell.name}`);
  lines.push('');
  lines.push('## Declaration');
  lines.push(`purpose: ${cell.purpose}`);
  lines.push(`provides: [${cell.provides.join(', ')}]`);
  lines.push(`requires: [${cell.requires.join(', ')}]`);
  if (cell.dataRequires && cell.dataRequires.length > 0) lines.push(`data-requires: [${cell.dataRequires.join(', ')}] (declared, not import-checked)`);
  if (dependedByCount !== undefined) {
    lines.push('');
    lines.push('## Context');
    lines.push(dependedByCount > 0 ? `impact: ${dependedByCount} cell(s) directly depend on this cell. Run \`cells impact ${cell.name}\` for full transitive blast radius.` : `impact: no cells depend on this cell (leaf).`);
  }
  if (coupled && coupled.length > 0) {
    // ADR 0002: unexplained change partners make THIS payload incomplete — the model
    // can't see the other cell, and touching it would trip the undeclared-crossing gate.
    // Only in the coupled case: zero tokens when the cell is clean.
    lines.push('');
    lines.push('## Change coupling');
    for (const c of coupled) {
      const files = c.files && c.files.length > 0 ? `; co-changing files: ${c.files.join(', ')}` : '';
      lines.push(`- ⚠ ${c.cell} co-changes with you (${c.count}/${c.window} commits, no import edge) — pull ${c.cell}'s payload before touching its code, its context is invisible to you${files}`);
    }
  }
  lines.push('');
  lines.push('## Your code');
  for (const file of ownedFiles) {
    lines.push(`### ${file}`);
    lines.push(fileContents[file] ?? '');
    lines.push('');
  }
  if (testFiles && testFiles.length > 0) {
    lines.push('## Tests');
    for (const file of testFiles) {
      lines.push(`### ${file}`);
      lines.push(testContents?.[file] ?? '');
      lines.push('');
    }
  }
  lines.push('## Neighbor contracts');
  for (const neighbor of neighbors) {
    pushCellSummary(lines, neighbor, { provides: true });
    lines.push('');
  }
  if (dependents && dependents.length > 0) {
    lines.push('## Cells that depend on you');
    for (const dep of dependents) {
      pushCellSummary(lines, dep, { provides: false });
      lines.push('');
    }
  }

  return lines.join('\n');
}
