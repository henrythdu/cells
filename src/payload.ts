import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cell } from './declaration.js';

/** Size of a cell's payload: file count, raw chars, ~tokens. */
export interface CellSize {
  files: number;
  chars: number;
  tokens: number;
}

/** Read files into a {path→content} map (missing files skipped — validate flags them).
 *  `baseDir` lets callers read from elsewhere (e.g. an extracted HEAD tree for `--diff`). */
export function readFiles(paths: string[], baseDir = '.'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of paths) {
    try {
      out[p] = readFileSync(join(baseDir, p), 'utf8');
    } catch {
      // missing — validate flags as dangling
    }
  }
  return out;
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
 *  Includes test files so the size gate (health/size) matches what `payload` actually emits. */
export function computePayloadSize(cell: Cell, ownedFiles: string[], neighbors: Cell[]): CellSize {
  const fileContents = readFiles(ownedFiles);
  const testFiles = cell.tests ?? [];
  const testContents = testFiles.length > 0 ? readFiles(testFiles) : undefined;
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
export function assemblePayload(
  cell: Cell,
  ownedFiles: string[],
  fileContents: Record<string, string>,
  neighbors: Cell[],
  dependedByCount?: number,
  testFiles?: string[],
  testContents?: Record<string, string>,
): string {
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
    lines.push(
      dependedByCount > 0
        ? `impact: ${dependedByCount} cell(s) directly depend on this cell. Run \`cells impact ${cell.name}\` for full transitive blast radius.`
        : `impact: no cells depend on this cell (leaf).`,
    );
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

  return lines.join('\n');
}
