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

/** Resolve a cell's neighbor declarations (for payload assembly). */
export function neighborsOf(cell: Cell, declarations: Record<string, Cell>): Cell[] {
  return cell.requires.map((r) => declarations[r]).filter((c): c is Cell => Boolean(c));
}

/** Assemble a cell's payload and measure it — the context-fit metric (what the model consumes).
 *  Includes test files so the size gate (health/size) matches what `payload` actually emits.
 *  Pure: file contents are passed in (the caller reads them via io) — same seam as
 *  assemblePayload, so the module has no hidden IO dependency. */
export function computePayloadSize(cell: Cell, ownedFiles: string[], fileContents: Record<string, string>, neighbors: Cell[], testContents?: Record<string, string>): CellSize {
  const testFiles = cell.tests ?? [];
  const chars = assemblePayload(cell, ownedFiles, fileContents, neighbors, undefined, testFiles, testContents).length;
  return { files: ownedFiles.length + testFiles.length, chars, tokens: estimateTokens(chars) };
}

/**
 * Assemble a cell's completeness payload as a single markdown document:
 * the cell's declaration + full owned source + neighbor membranes (surfaces only).
 *
 * Pure: takes resolved data (no FS access). The CLI layer reads files
 * from disk and resolves neighbors from the declarations map.
 */
export function assemblePayload(cell: Cell, ownedFiles: string[], fileContents: Record<string, string>, neighbors: Cell[], dependedByCount?: number, testFiles?: string[], testContents?: Record<string, string>, dependents?: Cell[]): string {
  const lines: string[] = [];

  lines.push(`# Cell: ${cell.name}`);
  lines.push('');
  lines.push('## Declaration');
  lines.push(`purpose: ${cell.purpose}`);
  lines.push(`provides: [${cell.provides.join(', ')}]`);
  lines.push(`requires: [${cell.requires.join(', ')}]`);
  if (dependedByCount !== undefined) {
    lines.push('');
    lines.push('## Context');
    lines.push(dependedByCount > 0 ? `impact: ${dependedByCount} cell(s) directly depend on this cell. Run \`cells impact ${cell.name}\` for full transitive blast radius.` : `impact: no cells depend on this cell (leaf).`);
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
    lines.push(`### Cell: ${neighbor.name}`);
    lines.push(`purpose: ${neighbor.purpose}`);
    lines.push(`provides: [${neighbor.provides.join(', ')}]`);
    if (neighbor.signatures && neighbor.signatures.length > 0) {
      lines.push('signatures:');
      for (const sig of neighbor.signatures) lines.push(`  - ${sig}`);
    }
    lines.push(`requires: [${neighbor.requires.join(', ')}]`);
    lines.push('');
  }
  if (dependents && dependents.length > 0) {
    lines.push('## Cells that depend on you');
    for (const dep of dependents) {
      lines.push(`### Cell: ${dep.name}`);
      lines.push(`purpose: ${dep.purpose}`);
      lines.push(`requires: [${dep.requires.join(', ')}]`); // what it expects from you (and others)
      lines.push('');
    }
  }

  return lines.join('\n');
}
