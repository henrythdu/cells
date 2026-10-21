/**
 * The gate family: size, structure, impact, and health. The renderers live in `view` and
 * `structure`. These functions collect the input and delegate.
 *
 * The read and query commands (crossings, list, show, graph, owns, payload, surface) live
 * in `commands/read.ts`. The shared pipeline (`loadCrossings` and the guards) lives in
 * `pipeline.ts`.
 *
 * The gate combines the four check cells into one verdict. The CI surface and the external
 * stress runs consume this verdict.
 */

import { existsSync } from 'node:fs';
import { checkLeakage, checkOffMembrane, computeMetrics } from './crossings.js';
import { recentCommitFiles } from './diff.js';
import { checkGrammars } from './importers.js';
import type { UnresolvedImport } from './imports.js';
import { type CellsContext, listCodeFiles, readFiles } from './io.js';
import { computePayloadSize, estimateTokens, neighborsOf } from './payload.js';
import { loadCrossings, requireCell, warnIfNoCodeFiles } from './pipeline.js';
import {
  checkDirection,
  checkSDP,
  classifyChangeCoupling,
  computeImpact,
  detectCycles,
  formatChangeCouplingReport,
  formatImpactReport,
  formatLayerOverview,
  formatLayerSuggestions,
  formatSdpReport,
  formatStructureReport,
  formatStructureSummary,
} from './structure.js';
import { providesDrift, type StaleProvide, validatePartition } from './validate.js';
import { formatHealthReport, formatSizeReport, type HealthValues, type PeelCandidate } from './view.js';

/**
 * `cells size` reports the context fit: the payload of each cell against the configured
 * ceiling. This check does not block (exit 0).
 */
export async function cmdSize(ctx: CellsContext): Promise<void> {
  const { config, declarations, ownership } = ctx;
  // Pass warn=false. The text of the blind-extension warning itself says that
  // "Partition/size/validate are unaffected", so the warning would be noise here. `list`
  // and `health` keep their coverage, because the coupling columns of `list` come from
  // crossings.
  const { edges } = await loadCrossings(ownership, false);
  const fileFanIn = new Map<string, number>();
  for (const e of edges) fileFanIn.set(e.toFile, (fileFanIn.get(e.toFile) ?? 0) + 1);
  const entries = Object.keys(declarations).map((name) => {
    const cell = declarations[name];
    const owned = ownership[name] ?? [];
    const contents = readFiles(owned); // One read, shared by the size computation and the peel candidates.
    const size = computePayloadSize(cell, owned, contents, neighborsOf(cell, declarations), readFiles(cell.tests ?? []));
    const ceiling = cell.ceiling; // The per-cell override from the cell.toml. When undefined, the global value applies.
    // Peel candidates for a cell over the ceiling: rank the owned files by size, from high
    // to low, then by fan-in, from low to high. A large file that few other files import is
    // the cheapest part to move to another cell.
    let peel: PeelCandidate[] | undefined;
    if (size.tokens > (ceiling ?? config.maxPayloadTokens)) {
      peel = owned.map((f) => ({ file: f, tokens: estimateTokens((contents[f] ?? '').length), fanIn: fileFanIn.get(f) ?? 0 })).sort((a, b) => b.tokens - a.tokens || a.fanIn - b.fanIn);
    }
    return { name, size, peel, ceiling };
  });
  process.stdout.write(formatSizeReport(entries, config.maxPayloadTokens));
}

/**
 * `cells structure` reports the governance checks: ADP (cycles) and Direction (layering).
 * These are warnings only (exit 0).
 *
 * With `--summary`, the command shows the triage view: one line for each cycle, plus
 * counts. This view is for repositories with many cycles.
 */
export async function cmdStructure(ctx: CellsContext, summary = false): Promise<void> {
  const { declarations, ownership, config } = ctx;
  const { crossings } = await loadCrossings(ownership);
  const cycles = detectCycles(crossings);
  const violations = checkDirection(crossings, declarations);
  const anyLayered = Object.values(declarations).some((d) => d.layer !== undefined);

  const metrics = computeMetrics(crossings, Object.keys(declarations));
  const sdp = checkSDP(crossings, metrics);
  // ADR 0002: change-coupled cells. This is advisory only (exit 0). The signal comes from
  // history and favors past changes, which is the opposite of the deterministic facts that
  // the gate uses.
  const coupling = classifyChangeCoupling(recentCommitFiles(Object.values(ownership).flat()), ownership, crossings);

  if (summary) {
    process.stdout.write(
      formatStructureSummary(cycles, violations, anyLayered, crossings, sdp.length, {
        unexplained: coupling.pairs.filter((p) => !p.explained).length,
        total: coupling.pairs.length,
      }),
    );
    return;
  }

  const report = formatStructureReport(cycles, violations, anyLayered, config.layers, crossings);
  const overview = formatLayerOverview(declarations, config.layers);
  process.stdout.write(overview ? `${overview}\n${report}` : report);

  const suggestions = formatLayerSuggestions(declarations);
  if (suggestions !== null) process.stdout.write(`\n${suggestions}`);

  const sdpReport = formatSdpReport(sdp);
  if (sdpReport !== null) process.stdout.write(`\n${sdpReport}`);

  const couplingReport = formatChangeCouplingReport(coupling);
  if (couplingReport !== null) process.stdout.write(`\n${couplingReport}`);
}

/** `cells impact <name>` reports the blast radius: which cells depend on this cell, directly or transitively? */
export async function cmdImpact(ctx: CellsContext, name: string): Promise<void> {
  const { declarations, ownership } = ctx;
  requireCell(declarations, name); // Guard: stop with the standard error when no cell has this name.
  const { crossings } = await loadCrossings(ownership);
  process.stdout.write(formatImpactReport(computeImpact(crossings, name)));
}

/**
 * The strict-gate rule: the conditions that fail `cells health` (exit 1). The gate fails on
 * an integrity violation, an undeclared leakage, or a broken grammar bundle. Size and
 * structure are warnings and never fail the gate. The renderer draws their warning lines.
 *
 * Pure. The exit-code rule lives here. The view re-derives the per-check booleans that it
 * needs to draw its success and failure lines.
 */
export function healthVerdict(v: HealthValues): boolean {
  const valOk = v.violationCount === 0;
  const xOk = v.undeclaredCount === 0;
  const grammarsOk = v.grammarResults.length > 0 && v.grammarResults.every((g) => g.ok);
  return valOk && xOk && grammarsOk;
}

/**
 * `health --summary` groups the unresolved entries by file and collapses each group to
 * one line. The file is the triage unit: the 161 OpenCL headers from one file in
 * llama.cpp become one line. The function sorts the groups from high to low and shows
 * one representative specifier for each group.
 *
 * The function uses the source file as the key and applies no language heuristics. Every
 * unresolved entry carries the source file.
 */
export function groupUnresolved(unresolved: UnresolvedImport[]): string[] {
  const byFile = new Map<string, { count: number; example: string }>();
  for (const u of unresolved) {
    const g = byFile.get(u.fromFile);
    if (g) g.count++;
    else byFile.set(u.fromFile, { count: 1, example: u.import });
  }
  return [...byFile.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])).map(([f, g]) => `${f}: ${g.count} unresolved (e.g. "${g.example}")`);
}

/**
 * `cells health` runs all four checks at once: validate, crossings, structure, and size. It
 * is one command instead of four for the check step of a model.
 *
 * The command exits with code 1 when a check fails. With `--verbose`, it names the failing
 * undeclared edges inline, which saves a second run of `crossings`.
 */
export async function cmdHealth(ctx: CellsContext, verbose = false, summary = false): Promise<void> {
  const started = performance.now();
  const { config, declarations, ownership } = ctx;
  const codeFiles = listCodeFiles();
  warnIfNoCodeFiles(config, codeFiles);
  const orphanCount = codeFiles.length - new Set(Object.values(ownership).flat()).size; // The census count minus the owned count: the partition coverage number.

  const { crossings, edges, uncoveredExts, unresolved } = await loadCrossings(ownership, false);
  const visibleUncoveredExts = uncoveredExts.filter((e) => !config.ignoreBlindExts.includes(e));

  const violations = validatePartition(ownership, declarations, codeFiles, existsSync);
  const grammarResults = await checkGrammars();
  const leakage = checkLeakage(crossings, declarations);
  const offMembrane = checkOffMembrane(edges, ownership, declarations);
  const stale = leakage.filter((l) => l.kind === 'stale');
  const cycles = detectCycles(crossings);
  const dirViolations = checkDirection(crossings, declarations);

  const cellNames = Object.keys(declarations);
  let maxPercent = 0;
  const staleProvides: StaleProvide[] = [];
  const allContents: Record<string, string> = {};
  for (const name of cellNames) {
    const cell = declarations[name];
    const owned = ownership[name] ?? [];
    const contents = readFiles(owned); // One read, shared by the size check and the provides-drift check.
    Object.assign(allContents, contents);
    const pct = computePayloadSize(cell, owned, contents, neighborsOf(cell, declarations), readFiles(cell.tests ?? [])).tokens / (cell.ceiling ?? config.maxPayloadTokens);
    if (pct > maxPercent) maxPercent = pct;
  }
  // An orphan is not owned, but it can still suppress the unread flag, because a reader
  // can be a string literal in any file. This extra read usually returns little content.
  const ownedSet = new Set(Object.keys(allContents));
  Object.assign(allContents, readFiles(codeFiles.filter((f) => !ownedSet.has(f))));
  // One name, one verdict. Unread contains stale, and the drift helper splits the two cases.
  const drift = providesDrift(declarations, ownership, edges, allContents);
  staleProvides.push(...drift.stale);

  // The strict-gate rule lives here, in the gate module, and not in the renderer. Exit 1
  // on an integrity violation, an undeclared leakage, or a broken grammar bundle. Size and
  // structure are warnings: the renderer draws their check lines and the warning list.
  const undeclared = leakage.filter((l) => l.kind === 'undeclared');
  const unresolvedFiles = summary ? groupUnresolved(unresolved) : undefined;
  const values: HealthValues = {
    cellCount: cellNames.length,
    fileCount: codeFiles.length,
    orphanCount,
    crossingCount: crossings.length,
    violationCount: violations.length,
    violationDetails: violations.map((v) => `${v.kind} — ${v.detail}`),
    undeclaredCount: undeclared.length,
    undeclaredEdges: undeclared.map((u) => u.detail),
    staleCount: stale.length,
    staleEdges: stale.map((s) => `${s.fromCell} → ${s.toCell}`),
    staleProvidesCount: staleProvides.length,
    staleProvidesDetails: staleProvides.map((s) => `${s.cell} provides "${s.provide}"`),
    unreadProvidesCount: drift.unread.length,
    unreadProvidesDetails: drift.unread.map((u) => `${u.cell} provides "${u.provide}"`),
    unreadProvidesEvaluated: drift.evaluated,
    offMembraneCount: offMembrane.length,
    offMembraneDetails: offMembrane.map((o) =>
      o.emptyProvides
        ? `${o.fromCell} → ${o.toCell}: consumes ${o.missing.join(', ')} but ${o.toCell}.provides is empty`
        : `${o.fromCell} → ${o.toCell}: ${o.missing.length}/${o.importedCount} symbol(s) not in provides: ${o.missing.join(', ')}`,
    ),
    cycleCount: cycles.length,
    dirViolationCount: dirViolations.length,
    maxPercent,
    uncoveredExts: visibleUncoveredExts,
    unresolvedCount: unresolved.length,
    unresolvedDetails: unresolvedFiles ?? unresolved.map((u) => `${u.fromFile} imports "${u.import}"`),
    unresolvedFiles: unresolvedFiles?.length,
    grammarResults,
    elapsedSec: (performance.now() - started) / 1000,
  };
  const gateOk = healthVerdict(values);
  process.stdout.write(formatHealthReport(values, verbose, gateOk));
  if (!gateOk) process.exitCode = 1; // Use exitCode and not exit(). The report, especially on failure, must flush before the process ends.
}
