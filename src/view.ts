import type { Cell } from './declaration.js';
import type { Ownership } from './ownership.js';
import type { CellMetrics, Crossing } from './crossings.js';
import type { CellSize } from './payload.js';

/**
 * Format the partition overview: one row per cell (file count, ~tokens,
 * requires) + a header with totals and orphan count. Pure.
 */
export function formatCellList(
  declarations: Record<string, Cell>,
  _ownership: Ownership,
  sizes: Record<string, CellSize>,
  metrics: Record<string, CellMetrics>,
  orphanFiles: string[],
): string {
  const names = Object.keys(declarations).sort();
  const totalFiles = names.reduce((n, name) => n + (sizes[name]?.files ?? 0), 0);
  const width = Math.max(...names.map((n) => n.length), 4);
  const orphans = orphanFiles.length === 1 ? 'orphan' : 'orphans';

  const lines: string[] = [
    `${names.length} cells · ${totalFiles} files · ${orphanFiles.length} ${orphans}`,
  ];
  for (const name of names) {
    const s = sizes[name];
    const fileStr = s ? `${s.files} file${s.files === 1 ? '' : 's'}` : '? files';
    const tokStr = s ? `${s.tokens} tok` : '? tok';
    const requires = declarations[name]?.requires ?? [];
    const reqStr = requires.length > 0 ? `→ ${requires.join(', ')}` : '—';
    const m = metrics[name];
    const coupling = m ? `${m.fanIn}/${m.fanOut}` : '—';
    lines.push(
      `  ${name.padEnd(width)}  ${fileStr.padEnd(9)} ${tokStr.padEnd(8)} ${coupling.padEnd(5)} ${reqStr}`,
    );
  }
  if (orphanFiles.length > 0) {
    lines.push('');
    lines.push('unowned (assign or add to .cells/ignore):');
    for (const f of orphanFiles.sort()) lines.push(`  ${f}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Format one cell's detail: declaration, owned files, the crossings it makes
 * (imports) and the crossings made against it (imported by). Pure.
 */
export function formatCellShow(
  cell: Cell,
  ownedFiles: string[],
  outCrossings: Crossing[],
  inCrossings: Crossing[],
  size: CellSize,
  metrics: CellMetrics,
): string {
  const lines: string[] = [`cell: ${cell.name}`];
  lines.push(`purpose: ${cell.purpose}`);
  if (cell.provides.length > 0) lines.push(`provides: ${cell.provides.join(', ')}`);
  lines.push(`requires: ${cell.requires.length > 0 ? cell.requires.join(', ') : '—'}`);
  if (cell.layer !== undefined) lines.push(`layer: ${cell.layer}`);
  lines.push(`deps: fan-in ${metrics.fanIn} · fan-out ${metrics.fanOut} · instability ${metrics.instability.toFixed(2)}`);
  lines.push('');
  lines.push(`owned (${size.files} file${size.files === 1 ? '' : 's'}, ~${size.tokens} tok):`);
  for (const f of ownedFiles) lines.push(`  ${f}`);
  lines.push('');
  lines.push(`imports (${outCrossings.length}):`);
  for (const c of outCrossings) {
    lines.push(`  → ${c.toCell}   (${c.fromFile} → ${c.toFile})`);
  }
  lines.push('');
  lines.push(`imported by (${inCrossings.length}):`);
  for (const c of inCrossings) {
    lines.push(`  ← ${c.fromCell}   (${c.fromFile} → ${c.toFile})`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Context-fit report: cells ranked by payload (biggest first), each with a
 * budget bar vs the ceiling; ⚠ on over-ceiling. Pure. (Exit 0 — it's a warning.)
 */
export function formatSizeReport(
  entries: { name: string; size: CellSize }[],
  ceiling: number,
): string {
  const ranked = [...entries].sort((a, b) => b.size.tokens - a.size.tokens);
  const width = Math.max(...ranked.map((e) => e.name.length), 4);
  const lines: string[] = [`context-fit — ceiling: ${ceiling} tok (max-payload-tokens)`];
  for (const { name, size } of ranked) {
    const over = size.tokens > ceiling;
    const segs = Math.min(10, Math.round((size.tokens / ceiling) * 10));
    const bar = '█'.repeat(segs).padEnd(10, '░');
    const mark = over ? ' ⚠ over ceiling' : '';
    lines.push(`  ${name.padEnd(width)}  [${bar}]  ${size.tokens} tok${mark}`);
  }
  const overCount = ranked.filter((e) => e.size.tokens > ceiling).length;
  lines.push(
    overCount > 0
      ? `${overCount} cell(s) over ceiling — consider dividing (cells assign <new-cell> <file...>).`
      : 'all cells within ceiling.',
  );
  return `${lines.join('\n')}\n`;
}
