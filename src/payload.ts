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
  dependedByCount?: number,
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
