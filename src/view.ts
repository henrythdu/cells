import type { CellMetrics, Crossing } from './crossings.js';
import { type Cell, STUB_PURPOSE } from './declaration.js';
import type { CellSize } from './payload.js';

/**
 * The per-cell health signals for `list --verbose`. Every field is already computed
 * elsewhere. This structure puts the fields together for the one-line orientation scan. It
 * adds no new analysis.
 *
 * There is no dead-file count. A test file is dead at the boundary by definition, because
 * nothing outside the cell imports it. The count would read about 1 for every cell, which
 * is noise. `show` lists dead FILES with their names, and there a model can tell a test
 * file from a leaf file.
 */
export interface CellSmell {
  pct: number; // The payload tokens divided by the ceiling (0 to 1).
  staleProvides: number;
  unreadProvides: number;
  unresolved: number;
}

/** The plural suffix for `file${pl(n)}`. Pure. */
function pl(n: number): string {
  return n === 1 ? '' : 's';
}

/**
 * A one-line health summary for a cell. The function renders it below the `list` row of the
 * cell when the summary is not empty. The size always shows, and the other values show only
 * when they are present. Pure.
 */
function formatCellSmell(s: CellSmell): string {
  const parts: string[] = [];
  parts.push(`${Math.round(s.pct * 100)}% size`);
  if (s.staleProvides > 0) parts.push(`${s.staleProvides} stale provide${pl(s.staleProvides)}`);
  if (s.unreadProvides > 0) parts.push(`${s.unreadProvides} unread provide${pl(s.unreadProvides)}`);
  if (s.unresolved > 0) parts.push(`${s.unresolved} unresolved import${pl(s.unresolved)}`);
  return parts.join(' · ');
}

/** Above this number of files, `list` truncates the list of unowned files. The header still shows the count. */
const ORPHAN_LIST_CAP = 20;

/**
 * Above this number of edges, `show` collapses the per-file lines into one count for each
 * cell, for example `placement×18, infra×8`. `--verbose` gives the raw detail. Without this
 * limit, a cell with a high fan-in prints many lines of noise.
 */
const AGG_THRESHOLD = 8;

/**
 * Format the partition overview: one row for each cell (file count, estimated tokens, and
 * `requires`), plus a header with the totals and the orphan count. Pure.
 */
export function formatCellList(
  declarations: Record<string, Cell>,
  sizes: Record<string, CellSize>,
  metrics: Record<string, CellMetrics>,
  orphanFiles: string[],
  smells?: Record<string, CellSmell>,
  magnetCounts?: Map<string, number>,
): string {
  const names = Object.keys(declarations).sort();
  const totalFiles = names.reduce((n, name) => n + (sizes[name]?.files ?? 0), 0);
  const stubSuffix = ' (stub)';
  // The width must fit the rendered label, because a stub cell adds a 7-character suffix. Otherwise the columns do not align.
  const width = Math.max(...names.map((n) => (declarations[n]?.purpose === STUB_PURPOSE ? n.length + stubSuffix.length : n.length)), 4);
  const orphans = `orphan${pl(orphanFiles.length)}`;

  const lines: string[] = [`${names.length} cells · ${totalFiles} files · ${orphanFiles.length} ${orphans}`];
  for (const name of names) {
    const s = sizes[name];
    const fileStr = s ? `${s.files} file${pl(s.files)}` : '? files';
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
    const sorted = [...orphanFiles].sort(); // Copy the list. The array of the caller stays unchanged.
    const shown = sorted.slice(0, ORPHAN_LIST_CAP);
    for (const f of shown) {
      // An orphan with an inbound import is the file that the partition needs. It is the
      // import magnet: a vendor file in a monorepo that every file imports, and that is
      // otherwise invisible.
      const n = magnetCounts?.get(f) ?? 0;
      lines.push(n > 0 ? `  ${f} — imported by ${n} file${pl(n)}` : `  ${f}`);
    }
    const rest = orphanFiles.length - shown.length;
    if (rest > 0) {
      // The hidden part of the list is the adoption queue. Group it by top directory, so
      // that "… and 658 more" says WHERE the files are. Before this grouping, a frontend
      // directory with 672 files hid the signal.
      const byDir = new Map<string, number>();
      for (const f of sorted.slice(shown.length)) {
        const d = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '(root)';
        byDir.set(d, (byDir.get(d) ?? 0) + 1);
      }
      const top = [...byDir.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 8)
        .map(([d, n]) => `${d}: ${n}`)
        .join(', ');
      lines.push(`  … and ${rest} more (${top})`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Collapse the crossings to a count string for each cell, with the most coupled cell first. Pure. */
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

/**
 * The pre-computed facts that `cells show` renders: the cell, its owned files with their
 * sizes, the crossings in and out, the payload size, the metrics, and the practice signals
 * (dead at the boundary, co-change coupling). `cmdShow` builds the object, and
 * `formatCellShow` renders it. This bundle keeps the interface of the view at one argument,
 * however many signals the report gains.
 */
export interface CellShowContext {
  cell: Cell;
  owned: { file: string; tokens: number }[];
  out: Crossing[];
  inc: Crossing[];
  size: CellSize;
  metrics: CellMetrics;
  dead: string[];
  /** The change partners above the threshold, classified against the crossings (ADR 0002). */
  coChange: { cell: string; count: number; window: number; jaccard: number; explained: boolean }[];
  staleProvides: { cell: string; provide: string }[];
  unreadProvides: { cell: string; provide: string }[];
  /** The import specifiers from the files of this cell that resolved to no owned file. */
  unresolved: string[];
}

/**
 * Render one crossings direction for `show`. Above the threshold the function shows a count
 * for each cell, and below it the function shows one line for each file. `byFrom` selects
 * the grouped side, and `arrow` selects the glyph. Pure.
 */
function crossingLines(label: string, crossings: Crossing[], byFrom: boolean, arrow: string, verbose: boolean): string[] {
  const lines = [`${label} (${crossings.length}):`];
  if (crossings.length > AGG_THRESHOLD && !verbose) {
    lines.push(`  ${arrow} ${aggregateByCell(crossings, byFrom)}`);
    lines.push('  (--verbose for per-file detail)');
  } else {
    for (const c of crossings) {
      const other = byFrom ? c.fromCell : c.toCell;
      lines.push(`  ${arrow} ${other}   (${c.fromFile} → ${c.toFile})`);
    }
  }
  return lines;
}

export function formatCellShow(ctx: CellShowContext, verbose = false): string {
  const { cell, owned, out, inc, size, metrics, dead, coChange, staleProvides, unreadProvides, unresolved } = ctx;
  const lines: string[] = [`cell: ${cell.name}`];
  lines.push(`purpose: ${cell.purpose}`);
  if (cell.purpose === STUB_PURPOSE) lines.push(`⚠ stub — edit .cells/${cell.name}.cell.toml to fill in purpose, provides, requires`);
  if (cell.provides.length > 0) lines.push(`provides: ${cell.provides.join(', ')}`);
  if (staleProvides.length > 0) {
    lines.push('⚠ provides not found in owned code (membrane drift — export removed or entry stale):');
    for (const s of staleProvides) lines.push(`  ${s.provide}`);
  }
  if (unreadProvides.length > 0) {
    lines.push('⚠ provides with no found reader in owned files or other cells (absence of a found reader is not proof of death):');
    for (const s of unreadProvides) lines.push(`  ${s.provide}`);
  }
  if (cell.signatures && cell.signatures.length > 0) {
    for (const sig of cell.signatures) lines.push(`  • ${sig}`);
  }
  lines.push(`requires: ${cell.requires.length > 0 ? cell.requires.join(', ') : '—'}`);
  if (cell.dataRequires && cell.dataRequires.length > 0) lines.push(`data-requires: ${cell.dataRequires.join(', ')} (declared, not import-checked)`);
  if (cell.layer !== undefined) lines.push(`layer: ${cell.layer}`);
  lines.push(`deps: fan-in ${metrics.fanIn} · fan-out ${metrics.fanOut} · instability ${metrics.instability.toFixed(2)}`);
  lines.push('');
  lines.push(`owned (${size.files} file${pl(size.files)}, ~${size.tokens} tok):`);
  for (const f of owned) lines.push(`  ${f.file}  (~${f.tokens} tok)`);
  if (dead.length > 0) {
    lines.push('');
    lines.push(`no other cell imports (static view — check for entry points before deleting):`);
    for (const f of dead) lines.push(`  ${f}`);
  }
  if (cell.tests && cell.tests.length > 0) {
    lines.push('');
    lines.push(`tests (${cell.tests.length} file${pl(cell.tests.length)}):`);
    for (const f of cell.tests) lines.push(`  ${f}`);
  }
  if (unresolved.length > 0) {
    lines.push('');
    lines.push(
      `unresolved imports that look local (${unresolved.length}) — no matching owned file; a broken specifier, a module-root mismatch, an external package sharing a local dir name, or a code dir excluded by the census skip-list (build/dist/…):`,
    );
    for (const u of unresolved) lines.push(`  ${u}`);
  }
  lines.push('');
  lines.push(...crossingLines('imports', out, false, '→', verbose));
  lines.push('');
  lines.push(...crossingLines('imported by', inc, true, '←', verbose));
  if (coChange.length > 0) {
    lines.push('');
    lines.push(`change-coupled cells in git history (${coChange[0].window} analyzed commits — logical coupling imports can't see):`);
    for (const c of coChange) {
      const mark = c.explained ? '  ' : '  ⚠ ';
      const why = c.explained ? 'explained, has import edge' : 'unexplained, no import edge';
      lines.push(`${mark}${c.cell} — ${why} (${c.count}/${c.window}, ${Math.round(c.jaccard * 100)}%)`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The context-fit report. The function ranks the cells by payload, the biggest first, and
 * shows a budget bar against the ceiling for each cell. An over-ceiling cell gets a ⚠ mark.
 * Pure. The exit code is 0, because this is a warning.
 */
export interface PeelCandidate {
  file: string;
  tokens: number;
  fanIn: number;
}

export function formatSizeReport(entries: { name: string; size: CellSize; peel?: PeelCandidate[]; ceiling?: number }[], globalCeiling: number): string {
  const ranked = [...entries].sort((a, b) => b.size.tokens - a.size.tokens);
  const overCount = ranked.filter((e) => e.size.tokens > (e.ceiling ?? globalCeiling)).length;
  const cap = 20; // A large repository has 500 or more of 1100 cells over the ceiling. Then 500 bar rows hide the signal. The count and the top rows carry it.
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
      lines.push(`    peel candidates: ${top.map((p) => `${p.file} (${p.tokens} tok, ${p.fanIn} importer${pl(p.fanIn)})`).join(', ')}`);
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

/**
 * The pre-computed values for the health report. `cmdHealth` gathers them with file input,
 * and `formatHealthReport` renders them (pure). The type has no domain types, so the view
 * stays decoupled from validate, crossings, and structure.
 */
export interface HealthValues {
  cellCount: number;
  fileCount: number;
  /** The census files that no cell owns. This is the partition coverage signal: it informs and never gates. */
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
  unreadProvidesCount: number;
  unreadProvidesDetails: string[];
  /** The number of identifier-shaped `provides` entries that the check evaluated. This is the denominator that the unread count uses. */
  unreadProvidesEvaluated: number;
  offMembraneCount: number;
  offMembraneDetails: string[];
  cycleCount: number;
  dirViolationCount: number;
  maxPercent: number;
  uncoveredExts: string[];
  unresolvedCount: number;
  unresolvedDetails: string[];
  /** Present when `health --summary` grouped the details by file. The header then shows "across M files". */
  unresolvedFiles?: number;
  grammarResults: { lang: string; ok: boolean; error?: string }[];
  /** The wall-clock time of the health run in seconds. The gate line renders it. */
  elapsedSec?: number;
}

/**
 * Render the health report (validate, crossings, structure, size, and grammars) for a
 * verdict that is already decided.
 *
 * Pure. The function takes the pre-computed values and the gate verdict, which
 * `gate.healthVerdict` computes: the strict-gate rule lives with the gate, and the renderer
 * renders it. The function follows the `format*` pattern (`formatCellList`,
 * `formatSizeReport`, and others) and is unit-testable.
 */
export function formatHealthReport(v: HealthValues, verbose = false, gateOk: boolean): string {
  const valOk = v.violationCount === 0;
  const xOk = v.undeclaredCount === 0;
  const structOk = v.cycleCount === 0 && v.dirViolationCount === 0;
  const sizeOk = v.maxPercent <= 1;
  const grammarsOk = v.grammarResults.length > 0 && v.grammarResults.every((g) => g.ok);

  const structParts: string[] = [];
  if (v.cycleCount > 0) structParts.push(`${v.cycleCount} cycle(s)`);
  if (v.dirViolationCount > 0) structParts.push(`${v.dirViolationCount} direction`);
  const structLabel = structParts.length > 0 ? structParts.join(', ') : 'acyclic, direction OK';
  const pct = Math.round(v.maxPercent * 100);

  const lines: string[] = [];
  lines.push(`  ${valOk ? '✓' : '✗'} validate  ${valOk ? `     (${v.cellCount} cells, ${v.fileCount} files${v.orphanCount > 0 ? `, ${v.orphanCount} orphan${pl(v.orphanCount)}` : ''})` : `     (${v.violationCount} violations)`}`);
  lines.push(`  ${xOk ? '✓' : '✗'} crossings ${xOk ? `    (${v.crossingCount} edges${v.staleCount > 0 ? `, ${v.staleCount} stale` : ''})` : `    (${v.crossingCount} edges, ${v.undeclaredCount} undeclared)`}`);
  if (!xOk && verbose) {
    // --verbose: name the failing edges here. This avoids a second run of `cells crossings`
    // on the usual failure.
    for (const d of v.undeclaredEdges) lines.push(`    ${d}`);
    lines.push('');
  }
  lines.push(`  ${structOk ? '✓' : '⚠'} structure ${structOk ? '   ' : '  '} (${structLabel})`);
  lines.push(`  ${sizeOk ? '✓' : '⚠'} size      ${sizeOk ? `    (max ${pct}% of ceiling)` : `    (max ${pct}% — over ceiling)`}`);
  const failedGrammars = v.grammarResults.filter((g) => !g.ok);
  lines.push(
    `  ${grammarsOk ? '✓' : '✗'} grammars  (${v.grammarResults.length - failedGrammars.length}/${v.grammarResults.length} loaded${failedGrammars.length > 0 ? ` — ${failedGrammars.map((g) => `${g.lang}: ${g.error ?? 'load failed'}`).join('; ')}` : ''})`,
  );
  if (v.uncoveredExts.length > 0) lines.push(`  — coverage    (${v.uncoveredExts.length} blind ext(s): ${v.uncoveredExts.join(', ')})`);
  if (v.unresolvedCount > 0)
    lines.push(
      `  — imports     (${v.unresolvedCount} unresolved import(s) that look local${v.unresolvedFiles !== undefined ? ` across ${v.unresolvedFiles} file(s)` : ''} — no matching file; a broken specifier, module-root mismatch, external package sharing a local dir name, or a census skip-listed dir (build/dist/…))`,
    );

  if (v.offMembraneCount > 0) {
    lines.push(`  — membrane  (${v.offMembraneCount} cell pair(s) importing symbols the target's provides doesn't list — run \`cells crossings --verbose\` for the named symbols)`);
    if (verbose) for (const d of v.offMembraneDetails) lines.push(`    ${d}`);
  }

  // The verdict comes FIRST. On the failing path, the information sections must not bury it.
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
  // A machine-parseable timing line with a stable `health: X.Xs` tail for grep and sed
  // consumers. The prose `(X.Xs)` above is for a human, and this line is the automation
  // contract.
  if (v.elapsedSec !== undefined) lines.push(`health: ${v.elapsedSec.toFixed(1)}s`);

  // The detail and information sections come BELOW the verdict. They are optional reading on the failing path.
  for (const d of v.violationDetails) lines.push(`  validate: ${d}`);
  if (v.staleCount > 0) {
    lines.push(`(info) ${v.staleCount} stale require(s) — declared but no import found (maybe a data dependency or future plan):`);
    for (const s of v.staleEdges) lines.push(`  ${s}`);
  }
  if (v.staleProvidesCount > 0) {
    lines.push(`(info) ${v.staleProvidesCount} stale provide(s) — declared but no owned file references them (membrane drift — fix the code or the entry):`);
    for (const s of v.staleProvidesDetails) lines.push(`  ${s}`);
  }
  if (v.unreadProvidesCount > 0) {
    lines.push(
      `(info) ${v.unreadProvidesCount} unread provide(s) of ${v.unreadProvidesEvaluated} evaluated — no reader found in owned files or other cells (absence of a found reader is not proof of death — e.g. \`import pkg.sub; pkg.attr\` reads are invisible to the census):`,
    );
    for (const s of v.unreadProvidesDetails) lines.push(`  ${s}`);
  }
  if (v.unresolvedCount > 0) {
    lines.push(
      `(info) ${v.unresolvedCount} unresolved import(s) that look local${v.unresolvedFiles !== undefined ? ` across ${v.unresolvedFiles} file(s)` : ''} — a broken specifier, a module-root mismatch, an external package sharing a local dir name, or a code dir excluded by the census skip-list (build/dist/…):`,
    );
    for (const u of v.unresolvedDetails) lines.push(`  ${u}`);
  }
  return `${lines.join('\n')}\n`;
}
