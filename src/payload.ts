import type { Cell } from './declaration.js';

/** The payload size of one cell: file count, raw character count, and estimated token count. */
export interface CellSize {
  files: number;
  chars: number;
  tokens: number;
}

/**
 * Estimate a token count from a character count. The payload heuristic uses about 3
 * characters per token. This is the single home for the estimate, so all size displays
 * agree.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3);
}

/**
 * Resolve the declarations of a cell's neighbors for payload assembly. The function reads
 * both keys. A `data-requires` partner contributes its membrane to the context in the
 * same way as an import neighbor. The check semantics differ, but the payload needs both.
 */
export function neighborsOf(cell: Cell, declarations: Record<string, Cell>): Cell[] {
  const names = [...cell.requires, ...(cell.dataRequires ?? [])];
  return [...new Set(names)].map((r) => declarations[r]).filter((c): c is Cell => Boolean(c));
}

/**
 * Assemble a cell's payload and measure it. This is the context-fit metric: the context
 * that a model consumes. The function includes test files, so the size check in
 * `health` and `size` matches the output of `payload`.
 *
 * Pure. The caller passes the file contents in, which it reads through `io`. This is the
 * same seam as `assemblePayload`, so the module has no hidden IO dependency.
 */
export function computePayloadSize(cell: Cell, ownedFiles: string[], fileContents: Record<string, string>, neighbors: Cell[], testContents?: Record<string, string>): CellSize {
  const testFiles = cell.tests ?? [];
  const chars = assemblePayload({ cell, ownedFiles, fileContents, neighbors, testFiles, testContents }).length;
  return { files: ownedFiles.length + testFiles.length, chars, tokens: estimateTokens(chars) };
}

/**
 * Write the summary block for one cell to the neighbor or dependent sections of a payload.
 *
 * A neighbor gets its membrane surface: `provides` and `signatures`. A dependent gets only
 * its `requires`, because the surface is not necessary to know who depends on this cell.
 * Both forms end with the blank line that the caller adds.
 */
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
 * Assemble the completeness payload for one cell as a single Markdown document. The
 * payload contains the cell's declaration, its full owned source, and the membranes of
 * its neighbors (surfaces only).
 *
 * Pure. The function takes resolved data and does not access the file system. The CLI
 * layer reads the files from disk and resolves the neighbors from the declaration map.
 *
 * The function takes one options object. The earlier positional parameters included two
 * `Record<string, string>` values and two `Cell[]` values that callers could swap by
 * mistake. Named fields remove that risk.
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
    // ADR 0002: an unexplained change partner makes this payload incomplete. The model
    // cannot see the other cell, and a change to that cell fails the undeclared-crossing
    // gate. This block adds no tokens when the cell is clean, so it appears only in the
    // coupled case.
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
