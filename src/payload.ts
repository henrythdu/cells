import type { Cell } from './declaration.js';

/** Size of a cell's payload: file count, raw chars, ~tokens. */
export interface CellSize {
  files: number;
  chars: number;
  tokens: number;
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
): string {
  const lines: string[] = [];

  lines.push(`# Cell: ${cell.name}`);
  lines.push('');
  lines.push('## Declaration');
  lines.push(`purpose: ${cell.purpose}`);
  lines.push(`provides: [${cell.provides.join(', ')}]`);
  lines.push(`requires: [${cell.requires.join(', ')}]`);
  lines.push('');
  lines.push('## Your code');
  for (const file of ownedFiles) {
    lines.push(`### ${file}`);
    lines.push(fileContents[file] ?? '');
    lines.push('');
  }
  lines.push('## Neighbor contracts');
  for (const neighbor of neighbors) {
    lines.push(`### Cell: ${neighbor.name}`);
    lines.push(`purpose: ${neighbor.purpose}`);
    lines.push(`provides: [${neighbor.provides.join(', ')}]`);
    lines.push(`requires: [${neighbor.requires.join(', ')}]`);
    lines.push('');
  }

  return lines.join('\n');
}
