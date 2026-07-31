import { STUB_PURPOSE, type Cell } from './declaration.js';
import type { Ownership } from './ownership.js';
import type { CellMetrics, Crossing } from './crossings.js';
import type { CellSize } from './payload.js';

/**
 * Format the partition overview: one row per cell (file count, ~tokens,
 * requires) + a header with totals and orphan count. Pure.
 */
export function formatCellList(declarations: Record<string, Cell>, _ownership: Ownership, sizes: Record<string, CellSize>, metrics: Record<string, CellMetrics>, orphanFiles: string[]): string {
  const names = Object.keys(declarations).sort();
  const totalFiles = names.reduce((n, name) => n + (sizes[name]?.files ?? 0), 0);
  const stubSuffix = ' (stub)';
  // width must fit the rendered label (stub cells get a 7-char suffix), else columns misalign
  const width = Math.max(...names.map((n) => (declarations[n]?.purpose === STUB_PURPOSE ? n.length + stubSuffix.length : n.length)), 4);
  const orphans = orphanFiles.length === 1 ? 'orphan' : 'orphans';

  const lines: string[] = [`${names.length} cells · ${totalFiles} files · ${orphanFiles.length} ${orphans}`];
  for (const name of names) {
    const s = sizes[name];
    const fileStr = s ? `${s.files} file${s.files === 1 ? '' : 's'}` : '? files';
    const tokStr = s ? `${s.tokens} tok` : '? tok';
    const requires = declarations[name]?.requires ?? [];
    const reqStr = requires.length > 0 ? `→ ${requires.join(', ')}` : '—';
    const m = metrics[name];
    const coupling = m ? `${m.fanIn}/${m.fanOut}` : '—';
    const label = declarations[name]?.purpose === STUB_PURPOSE ? `${name}${stubSuffix}` : name;
    lines.push(`  ${label.padEnd(width)}  ${fileStr.padEnd(9)} ${tokStr.padEnd(8)} ${coupling.padEnd(5)} ${reqStr}`);
  }
  if (orphanFiles.length > 0) {
    lines.push('');
    lines.push('unowned (assign or add to .cells/ignore):');
    for (const f of orphanFiles.sort()) lines.push(`  ${f}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Above this many edges, `show` collapses per-file lines into a per-cell aggregate
 *  (e.g. `placement×18, infra×8`) — raw detail via `--verbose`. High-fan-in cells otherwise
 *  dump dozens of lines of noise. */
const AGG_THRESHOLD = 8;

/** Collapse crossings to a per-cell count string, most-coupled first. Pure. */
function aggregateByCell(crossings: Crossing[], byFrom: boolean): string {
  const counts = new Map<string, number>();
  for (const c of crossings) {
    const key = byFrom ? c.fromCell : c.toCell;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cell, n]) => `${cell}×${n}`)
    .join(', ');
}

export function formatCellShow(cell: Cell, ownedFiles: { file: string; tokens: number }[], outCrossings: Crossing[], inCrossings: Crossing[], size: CellSize, metrics: CellMetrics, verbose = false): string {
  const lines: string[] = [`cell: ${cell.name}`];
  lines.push(`purpose: ${cell.purpose}`);
  if (cell.purpose === STUB_PURPOSE) lines.push(`⚠ stub — edit .cells/${cell.name}.cell.toml to fill in purpose, provides, requires`);
  if (cell.provides.length > 0) lines.push(`provides: ${cell.provides.join(', ')}`);
  if (cell.signatures && cell.signatures.length > 0) {
    for (const sig of cell.signatures) lines.push(`  • ${sig}`);
  }
  lines.push(`requires: ${cell.requires.length > 0 ? cell.requires.join(', ') : '—'}`);
  if (cell.layer !== undefined) lines.push(`layer: ${cell.layer}`);
  lines.push(`deps: fan-in ${metrics.fanIn} · fan-out ${metrics.fanOut} · instability ${metrics.instability.toFixed(2)}`);
  lines.push('');
  lines.push(`owned (${size.files} file${size.files === 1 ? '' : 's'}, ~${size.tokens} tok):`);
  for (const f of ownedFiles) lines.push(`  ${f.file}  (~${f.tokens} tok)`);
  if (cell.tests && cell.tests.length > 0) {
    lines.push('');
    lines.push(`tests (${cell.tests.length} file${cell.tests.length === 1 ? '' : 's'}):`);
    for (const f of cell.tests) lines.push(`  ${f}`);
  }
  lines.push('');
  lines.push(`imports (${outCrossings.length}):`);
  if (outCrossings.length > AGG_THRESHOLD && !verbose) {
    lines.push(`  → ${aggregateByCell(outCrossings, false)}`);
    lines.push('  (--verbose for per-file detail)');
  } else {
    for (const c of outCrossings) lines.push(`  → ${c.toCell}   (${c.fromFile} → ${c.toFile})`);
  }
  lines.push('');
  lines.push(`imported by (${inCrossings.length}):`);
  if (inCrossings.length > AGG_THRESHOLD && !verbose) {
    lines.push(`  ← ${aggregateByCell(inCrossings, true)}`);
    lines.push('  (--verbose for per-file detail)');
  } else {
    for (const c of inCrossings) lines.push(`  ← ${c.fromCell}   (${c.fromFile} → ${c.toFile})`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Context-fit report: cells ranked by payload (biggest first), each with a
 * budget bar vs the ceiling; ⚠ on over-ceiling. Pure. (Exit 0 — it's a warning.)
 */
export interface PeelCandidate {
  file: string;
  tokens: number;
  fanIn: number;
}

export function formatSizeReport(entries: { name: string; size: CellSize; peel?: PeelCandidate[] }[], ceiling: number): string {
  const ranked = [...entries].sort((a, b) => b.size.tokens - a.size.tokens);
  const width = Math.max(...ranked.map((e) => e.name.length), 4);
  const lines: string[] = [`context-fit — ceiling: ${ceiling} tok (max-payload-tokens)`];
  for (const { name, size, peel } of ranked) {
    const over = size.tokens > ceiling;
    const segs = Math.min(10, Math.round((size.tokens / ceiling) * 10));
    const bar = '█'.repeat(segs).padEnd(10, '░');
    const mark = over ? ' ⚠ over ceiling' : '';
    lines.push(`  ${name.padEnd(width)}  [${bar}]  ${size.tokens} tok${mark}`);
    if (over && peel && peel.length > 0) {
      const top = peel.slice(0, 2);
      lines.push(`    peel candidates: ${top.map((p) => `${p.file} (${p.tokens} tok, ${p.fanIn} importer${p.fanIn === 1 ? '' : 's'})`).join(', ')}`);
    }
  }
  const overCount = ranked.filter((e) => e.size.tokens > ceiling).length;
  lines.push(overCount > 0 ? `${overCount} cell(s) over ceiling — consider dividing (cells assign <new-cell> <file...>).` : 'all cells within ceiling.');
  return `${lines.join('\n')}\n`;
}

/** Pre-computed values for the health report — `cmdHealth` gathers these (with I/O),
 *  `formatHealthReport` renders them (pure). Kept free of domain types so view stays
 *  decoupled from validate/crossings/structure. */
export interface HealthValues {
  cellCount: number;
  fileCount: number;
  crossingCount: number;
  violationCount: number;
  violationDetails: string[];
  undeclaredCount: number;
  undeclaredEdges: string[];
  staleCount: number;
  staleEdges: string[];
  cycleCount: number;
  dirViolationCount: number;
  maxPercent: number;
  uncoveredExts: string[];
  unresolvedCount: number;
  unresolvedDetails: string[];
}

export interface HealthReport {
  report: string;
  gateOk: boolean;
}

/**
 * Render the four-check health report + the strict-gate verdict. Pure: takes the
 * pre-computed values, returns the formatted report and whether the gate holds
 * (exit 1 only on integrity + undeclared leakage — size/structure are warnings).
 * The one read command that previously inlined its markup + gate decision; now
 * joins the format* pattern (formatCellList / formatSizeReport / …) and is unit-testable.
 */
export function formatHealthReport(v: HealthValues, verbose = false): HealthReport {
  const valOk = v.violationCount === 0;
  const xOk = v.undeclaredCount === 0;
  const structOk = v.cycleCount === 0 && v.dirViolationCount === 0;
  const sizeOk = v.maxPercent <= 1;
  const gateOk = valOk && xOk; // strict gate: integrity + undeclared leakage only

  const structParts: string[] = [];
  if (v.cycleCount > 0) structParts.push(`${v.cycleCount} cycle(s)`);
  if (v.dirViolationCount > 0) structParts.push(`${v.dirViolationCount} direction`);
  const structLabel = structParts.length > 0 ? structParts.join(', ') : 'acyclic, direction OK';
  const pct = Math.round(v.maxPercent * 100);

  const lines: string[] = [];
  lines.push(`  ${valOk ? '✓' : '✗'} validate  ${valOk ? `     (${v.cellCount} cells, ${v.fileCount} files)` : `     (${v.violationCount} violations)`}`);
  lines.push(`  ${xOk ? '✓' : '✗'} crossings ${xOk ? `    (${v.crossingCount} edges${v.staleCount > 0 ? `, ${v.staleCount} stale` : ''})` : `    (${v.crossingCount} edges, ${v.undeclaredCount} undeclared)`}`);
  if (!xOk && verbose) {
    // --verbose: name the failing edges inline — saves the `cells crossings` round-trip on the common failure.
    for (const d of v.undeclaredEdges) lines.push(`    ${d}`);
    lines.push('');
  }
  lines.push(`  ${structOk ? '✓' : '⚠'} structure ${structOk ? '   ' : '  '} (${structLabel})`);
  lines.push(`  ${sizeOk ? '✓' : '⚠'} size      ${sizeOk ? `    (max ${pct}% of ceiling)` : `    (max ${pct}% — over ceiling)`}`);
  if (v.uncoveredExts.length > 0) lines.push(`  — coverage    (${v.uncoveredExts.length} blind ext(s): ${v.uncoveredExts.join(', ')})`);
  if (v.unresolvedCount > 0) lines.push(`  — imports     (${v.unresolvedCount} unresolved local import(s) — no matching file; check specifiers or module-root)`);

  // Verdict FIRST — the failing path must not bury it under info sections.
  const warnings: string[] = [];
  if (!structOk) warnings.push('structure');
  if (!sizeOk) warnings.push('size');
  lines.push('');
  if (gateOk) {
    lines.push(warnings.length > 0 ? `→ Gate passed with ${warnings.length} warning(s). Run ${warnings.map((w) => `\`cells ${w}\``).join(' / ')} for details.` : '→ All checks passed.');
  } else {
    const drill: string[] = [];
    if (!valOk) drill.push('validate');
    if (!xOk && !verbose) drill.push('crossings'); // already named inline under --verbose
    const drillHint = drill.length > 0 ? ` Run \`cells ${drill.join('` / `cells ')}\` for details.` : '';
    const aside = warnings.length > 0 ? ` (${warnings.length} warning(s) aside)` : '';
    lines.push(`→ Gate failed.${aside}${drillHint}`);
  }

  // Detail/info sections BELOW the verdict — optional reading on the failing path.
  for (const d of v.violationDetails) lines.push(`  validate: ${d}`);
  if (v.staleCount > 0) {
    lines.push(`(info) ${v.staleCount} stale require(s) — declared but no import found (maybe a data dependency or future plan):`);
    for (const s of v.staleEdges) lines.push(`  ${s}`);
  }
  if (v.unresolvedCount > 0) {
    lines.push(`(info) ${v.unresolvedCount} unresolved local import(s) — likely a broken specifier or module-root mismatch:`);
    for (const u of v.unresolvedDetails) lines.push(`  ${u}`);
  }
  return { report: lines.join('\n') + '\n', gateOk };
}
