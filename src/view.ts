import { STUB_PURPOSE, type Cell } from './declaration.js';
import type { CellMetrics, Crossing } from './crossings.js';
import type { CellSize } from './payload.js';

/** Per-cell health signals for `list --verbose` — every field already computed elsewhere;
 *  this bundles them into the one-line orientation scan (all data, no new analysis).
 *  No dead-file count: test files are dead at the boundary by definition (nothing outside
 *  the cell imports them), so the count would read ~1 for every cell — noise. `show` lists
 *  dead FILES with names, where the LLM can tell a test from a leaf. */
export interface CellSmell {
  pct: number; // payload tokens / ceiling (0-1)
  staleProvides: number;
  unresolved: number;
}

/** One-line health smell for a cell — rendered under its `list` row when non-empty.
 *  Size always shows (verbose = full detail); the rest only when present. Pure. */
export function formatCellSmell(s: CellSmell): string {
  const parts: string[] = [];
  parts.push(`${Math.round(s.pct * 100)}% size`);
  if (s.staleProvides > 0) parts.push(`${s.staleProvides} stale provide${s.staleProvides === 1 ? '' : 's'}`);
  if (s.unresolved > 0) parts.push(`${s.unresolved} unresolved import${s.unresolved === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/**
 * Format the partition overview: one row per cell (file count, ~tokens,
 * requires) + a header with totals and orphan count. Pure.
 */
export function formatCellList(declarations: Record<string, Cell>, sizes: Record<string, CellSize>, metrics: Record<string, CellMetrics>, orphanFiles: string[], smells?: Record<string, CellSmell>): string {
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
    const smell = smells?.[name];
    if (smell) lines.push(`      ⚠ ${formatCellSmell(smell)}`);
  }
  if (orphanFiles.length > 0) {
    lines.push('');
    lines.push('unowned (assign or add to .cells/ignore):');
    const shown = orphanFiles.sort().slice(0, ORPHAN_LIST_CAP);
    for (const f of shown) lines.push(`  ${f}`);
    const rest = orphanFiles.length - shown.length;
    if (rest > 0) lines.push(`  … and ${rest} more`);
  }
  return `${lines.join('\n')}\n`;
}

/** Above this many files, `list` truncates the unowned dump (the count stays in the header). */
const ORPHAN_LIST_CAP = 20;

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

/** Pre-computed facts `cells show` renders — the cell, its owned files with sizes, crossings
 *  in/out, payload size, metrics, and the practice signals (dead-at-boundary, co-change
 *  coupling). Built by cmdShow; formatCellShow renders it. Bundle keeps the view's interface
 *  one argument regardless of how many signals the report grows. */
export interface CellShowContext {
  cell: Cell;
  owned: { file: string; tokens: number }[];
  out: Crossing[];
  inc: Crossing[];
  size: CellSize;
  metrics: CellMetrics;
  dead: string[];
  coChange: { file: string; cell: string | undefined; count: number }[];
  staleProvides: { cell: string; provide: string }[];
  /** Import specifiers from this cell's files that resolved to no owned file. */
  unresolved: string[];
}

export function formatCellShow(ctx: CellShowContext, verbose = false): string {
  const { cell, owned: ownedFiles, out: outCrossings, inc: inCrossings, size, metrics, dead: deadFiles, coChange, staleProvides, unresolved } = ctx;
  const lines: string[] = [`cell: ${cell.name}`];
  lines.push(`purpose: ${cell.purpose}`);
  if (cell.purpose === STUB_PURPOSE) lines.push(`⚠ stub — edit .cells/${cell.name}.cell.toml to fill in purpose, provides, requires`);
  if (cell.provides.length > 0) lines.push(`provides: ${cell.provides.join(', ')}`);
  if (staleProvides.length > 0) {
    lines.push('⚠ provides not found in owned code (membrane drift — export removed or entry stale):');
    for (const s of staleProvides) lines.push(`  ${s.provide}`);
  }
  if (cell.signatures && cell.signatures.length > 0) {
    for (const sig of cell.signatures) lines.push(`  • ${sig}`);
  }
  lines.push(`requires: ${cell.requires.length > 0 ? cell.requires.join(', ') : '—'}`);
  if (cell.layer !== undefined) lines.push(`layer: ${cell.layer}`);
  lines.push(`deps: fan-in ${metrics.fanIn} · fan-out ${metrics.fanOut} · instability ${metrics.instability.toFixed(2)}`);
  lines.push('');
  lines.push(`owned (${size.files} file${size.files === 1 ? '' : 's'}, ~${size.tokens} tok):`);
  for (const f of ownedFiles) lines.push(`  ${f.file}  (~${f.tokens} tok)`);
  if (deadFiles.length > 0) {
    lines.push('');
    lines.push(`no other cell imports (static view — check for entry points before deleting):`);
    for (const f of deadFiles) lines.push(`  ${f}`);
  }
  if (cell.tests && cell.tests.length > 0) {
    lines.push('');
    lines.push(`tests (${cell.tests.length} file${cell.tests.length === 1 ? '' : 's'}):`);
    for (const f of cell.tests) lines.push(`  ${f}`);
  }
  if (unresolved.length > 0) {
    lines.push('');
    lines.push(`unresolved local imports (${unresolved.length}) — no matching owned file (check the specifier or module-root):`);
    for (const u of unresolved) lines.push(`  ${u}`);
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
  if (coChange.length > 0) {
    lines.push('');
    lines.push(`co-changes in git history (same-commit pairs — logical coupling imports can't see):`);
    for (const c of coChange) lines.push(`  ${c.file}  (${c.cell ? `cell ${c.cell} · ` : ''}${c.count}×)`);
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

export function formatSizeReport(entries: { name: string; size: CellSize; peel?: PeelCandidate[]; ceiling?: number }[], globalCeiling: number): string {
  const ranked = [...entries].sort((a, b) => b.size.tokens - a.size.tokens);
  const eff = (e: { ceiling?: number }): number => e.ceiling ?? globalCeiling;
  const overCount = ranked.filter((e) => e.size.tokens > eff(e)).length;
  const cap = 20; // transformers: 502/1103 over ceiling — 500 bar rows drown the signal; the count + top rows carry it
  const shown = ranked.slice(0, cap);
  const width = Math.max(...shown.map((e) => e.name.length), 4);
  const perCell = ranked.some((e) => e.ceiling !== undefined);
  const lines: string[] = [`context-fit — ceiling: ${globalCeiling} tok (max-payload-tokens)${perCell ? '; some cells override' : ''}`];
  for (const { name, size, peel, ceiling } of shown) {
    const c = ceiling ?? globalCeiling;
    const over = size.tokens > c;
    const segs = Math.min(10, Math.round((size.tokens / c) * 10));
    const bar = '█'.repeat(segs).padEnd(10, '░');
    const mark = over ? ' ⚠ over ceiling' : '';
    const own = ceiling !== undefined ? ` (ceiling ${ceiling})` : '';
    lines.push(`  ${name.padEnd(width)}  [${bar}]  ${size.tokens} tok${own}${mark}`);
    if (over && peel && peel.length > 0) {
      const top = peel.slice(0, 2);
      lines.push(`    peel candidates: ${top.map((p) => `${p.file} (${p.tokens} tok, ${p.fanIn} importer${p.fanIn === 1 ? '' : 's'})`).join(', ')}`);
    }
  }
  if (ranked.length > cap) {
    const hidden = ranked.length - cap;
    const still = overCount > cap ? ` (${overCount - cap} still over ceiling)` : '';
    lines.push(`  …and ${hidden} more${still}`);
  }
  lines.push(overCount > 0 ? `${overCount} cell(s) over ceiling — consider dividing (cells assign <new-cell> <file...>).` : 'all cells within ceiling.');
  return `${lines.join('\n')}\n`;
}

/** Pre-computed values for the health report — `cmdHealth` gathers these (with I/O),
 *  `formatHealthReport` renders them (pure). Kept free of domain types so view stays
 *  decoupled from validate/crossings/structure. */
export interface HealthValues {
  cellCount: number;
  fileCount: number;
  /** Census files with no owning cell — the partition-coverage signal (informs, never gates). */
  orphanCount: number;
  crossingCount: number;
  violationCount: number;
  violationDetails: string[];
  undeclaredCount: number;
  undeclaredEdges: string[];
  staleCount: number;
  staleEdges: string[];
  staleProvidesCount: number;
  staleProvidesDetails: string[];
  cycleCount: number;
  dirViolationCount: number;
  maxPercent: number;
  uncoveredExts: string[];
  unresolvedCount: number;
  unresolvedDetails: string[];
  /** Present when `health --summary` grouped the details by file — the header shows "across M files". */
  unresolvedFiles?: number;
  grammarResults: { lang: string; ok: boolean; error?: string }[];
  /** Wall-clock of the health run in seconds — rendered on the gate line. */
  elapsedSec?: number;
}

export interface HealthReport {
  report: string;
  gateOk: boolean;
}

/**
 * Render the health report (validate / crossings / structure / size / grammars)
 * + the strict-gate verdict. Pure: takes the pre-computed values, returns the
 * formatted report and whether the gate holds (exit 1 on integrity, undeclared
 * leakage, or a broken grammar bundle — size/structure are warnings; a failing
 * grammar is named inline on the line itself). Joins the format* pattern
 * (formatCellList / formatSizeReport / …) and is unit-testable.
 */
export function formatHealthReport(v: HealthValues, verbose = false): HealthReport {
  const valOk = v.violationCount === 0;
  const xOk = v.undeclaredCount === 0;
  const structOk = v.cycleCount === 0 && v.dirViolationCount === 0;
  const sizeOk = v.maxPercent <= 1;
  const grammarsOk = v.grammarResults.length > 0 && v.grammarResults.every((g) => g.ok);
  const gateOk = valOk && xOk && grammarsOk; // strict gate: integrity + undeclared leakage + packaged grammars

  const structParts: string[] = [];
  if (v.cycleCount > 0) structParts.push(`${v.cycleCount} cycle(s)`);
  if (v.dirViolationCount > 0) structParts.push(`${v.dirViolationCount} direction`);
  const structLabel = structParts.length > 0 ? structParts.join(', ') : 'acyclic, direction OK';
  const pct = Math.round(v.maxPercent * 100);

  const lines: string[] = [];
  lines.push(`  ${valOk ? '✓' : '✗'} validate  ${valOk ? `     (${v.cellCount} cells, ${v.fileCount} files${v.orphanCount > 0 ? `, ${v.orphanCount} orphan${v.orphanCount === 1 ? '' : 's'}` : ''})` : `     (${v.violationCount} violations)`}`);
  lines.push(`  ${xOk ? '✓' : '✗'} crossings ${xOk ? `    (${v.crossingCount} edges${v.staleCount > 0 ? `, ${v.staleCount} stale` : ''})` : `    (${v.crossingCount} edges, ${v.undeclaredCount} undeclared)`}`);
  if (!xOk && verbose) {
    // --verbose: name the failing edges inline — saves the `cells crossings` round-trip on the common failure.
    for (const d of v.undeclaredEdges) lines.push(`    ${d}`);
    lines.push('');
  }
  lines.push(`  ${structOk ? '✓' : '⚠'} structure ${structOk ? '   ' : '  '} (${structLabel})`);
  lines.push(`  ${sizeOk ? '✓' : '⚠'} size      ${sizeOk ? `    (max ${pct}% of ceiling)` : `    (max ${pct}% — over ceiling)`}`);
  const grammars = v.grammarResults.filter((g) => !g.ok);
  lines.push(
    `  ${grammarsOk ? '✓' : '✗'} grammars  (${v.grammarResults.length - grammars.length}/${v.grammarResults.length} loaded${grammars.length > 0 ? ` — ${grammars.map((g) => `${g.lang}: ${g.error ?? 'load failed'}`).join('; ')}` : ''})`,
  );
  if (v.uncoveredExts.length > 0) lines.push(`  — coverage    (${v.uncoveredExts.length} blind ext(s): ${v.uncoveredExts.join(', ')})`);
  if (v.unresolvedCount > 0)
    lines.push(`  — imports     (${v.unresolvedCount} unresolved local import(s)${v.unresolvedFiles !== undefined ? ` across ${v.unresolvedFiles} file(s)` : ''} — no matching file; check specifiers or module-root)`);

  // Verdict FIRST — the failing path must not bury it under info sections.
  const warnings: string[] = [];
  if (!structOk) warnings.push('structure');
  if (!sizeOk) warnings.push('size');
  lines.push('');
  const timing = v.elapsedSec !== undefined ? `  (${v.elapsedSec.toFixed(1)}s)` : '';
  if (gateOk) {
    lines.push(warnings.length > 0 ? `→ Gate passed with ${warnings.length} warning(s). Run ${warnings.map((w) => `\`cells ${w}\``).join(' / ')} for details.${timing}` : `→ All checks passed.${timing}`);
  } else {
    const drill: string[] = [];
    if (!valOk) drill.push('validate');
    if (!xOk && !verbose) drill.push('crossings'); // already named inline under --verbose
    const drillHint = drill.length > 0 ? ` Run \`cells ${drill.join('` / `cells ')}\` for details.` : '';
    const aside = warnings.length > 0 ? ` (${warnings.length} warning(s) aside)` : '';
    lines.push(`→ Gate failed.${aside}${drillHint}${timing}`);
  }
  // Machine-parseable timing line (stress-agent ask): stable `health: X.Xs` tail for grep/sed
  // consumers — the prose `(X.Xs)` above is human-facing; this is the automation contract.
  if (v.elapsedSec !== undefined) lines.push(`health: ${v.elapsedSec.toFixed(1)}s`);

  // Detail/info sections BELOW the verdict — optional reading on the failing path.
  for (const d of v.violationDetails) lines.push(`  validate: ${d}`);
  if (v.staleCount > 0) {
    lines.push(`(info) ${v.staleCount} stale require(s) — declared but no import found (maybe a data dependency or future plan):`);
    for (const s of v.staleEdges) lines.push(`  ${s}`);
  }
  if (v.staleProvidesCount > 0) {
    lines.push(`(info) ${v.staleProvidesCount} stale provide(s) — declared but no owned file references them (membrane drift — fix the code or the entry):`);
    for (const s of v.staleProvidesDetails) lines.push(`  ${s}`);
  }
  if (v.unresolvedCount > 0) {
    lines.push(`(info) ${v.unresolvedCount} unresolved local import(s)${v.unresolvedFiles !== undefined ? ` across ${v.unresolvedFiles} file(s)` : ''} — likely a broken specifier or module-root mismatch:`);
    for (const u of v.unresolvedDetails) lines.push(`  ${u}`);
  }
  return { report: lines.join('\n') + '\n', gateOk };
}
