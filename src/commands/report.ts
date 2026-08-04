/** Report command handlers: size, structure, impact, health. The renderers live in view /
 *  structure; these shells gather I/O and delegate. The read/query commands (crossings,
 *  list, show, graph, owns, payload) live in read.ts; the shared pipeline is loadCrossings. */
import { listCodeFiles, readFiles, type CellsContext } from '../io.js';
import { computePayloadSize, neighborsOf, estimateTokens } from '../payload.js';
import { checkLeakage, computeMetrics } from '../crossings.js';
import { formatSizeReport, formatHealthReport, type PeelCandidate } from '../view.js';
import { detectCycles, checkDirection, checkSDP, formatSdpReport, formatStructureReport, formatLayerOverview, formatLayerSuggestions, computeImpact, formatImpactReport } from '../structure.js';
import { checkGrammars } from '../importers.js';
import type { UnresolvedImport } from '../imports.js';
import { validatePartition, staleProvidesOf, type StaleProvide } from '../validate.js';
import { loadCrossings, warnIfNoCodeFiles, requireCell } from './read.js';

/** `cells size` — context-fit warning: payloads vs the configured ceiling. Non-blocking (exit 0). */
export async function cmdSize(ctx: CellsContext): Promise<void> {
  const { config, declarations, ownership } = ctx;
  // warn=false: the blind-ext warning's own text says "Partition/size/validate are unaffected" —
  // noise on `cells size`. (list/health keep their coverage: list's coupling columns ARE crossings-derived.)
  const { edges } = await loadCrossings(ownership, false);
  const fileFanIn = new Map<string, number>();
  for (const e of edges) fileFanIn.set(e.toFile, (fileFanIn.get(e.toFile) ?? 0) + 1);
  const entries = Object.keys(declarations).map((name) => {
    const cell = declarations[name];
    const owned = ownership[name] ?? [];
    const contents = readFiles(owned); // one read, shared by the size computation and peel candidates
    const size = computePayloadSize(cell, owned, contents, neighborsOf(cell, declarations));
    // Peel candidates: for over-ceiling cells, rank owned files by size↓ + fan-in↑
    // (a big file few others import is the cheapest chunk to carve out).
    let peel: PeelCandidate[] | undefined;
    if (size.tokens > config.maxPayloadTokens) {
      peel = owned.map((f) => ({ file: f, tokens: estimateTokens((contents[f] ?? '').length), fanIn: fileFanIn.get(f) ?? 0 })).sort((a, b) => b.tokens - a.tokens || a.fanIn - b.fanIn);
    }
    return { name, size, peel };
  });
  process.stdout.write(formatSizeReport(entries, config.maxPayloadTokens));
}

/** `cells structure` — governance: ADP (cycles) + Direction (layering). Warnings only (exit 0). */
export async function cmdStructure(ctx: CellsContext): Promise<void> {
  const { declarations, ownership, config } = ctx;
  const { crossings } = await loadCrossings(ownership);
  const cycles = detectCycles(crossings);
  const violations = checkDirection(crossings, declarations);
  const anyLayered = Object.values(declarations).some((d) => d.layer !== undefined);
  const report = formatStructureReport(cycles, violations, anyLayered, config.layers, crossings);
  const overview = formatLayerOverview(declarations, config.layers);
  process.stdout.write(overview ? `${overview}\n${report}` : report);

  const suggestions = formatLayerSuggestions(declarations);
  if (suggestions !== null) process.stdout.write(`\n${suggestions}`);

  const metrics = computeMetrics(crossings, Object.keys(declarations));
  const sdp = formatSdpReport(checkSDP(crossings, metrics));
  if (sdp !== null) process.stdout.write(`\n${sdp}`);
}

/** `cells impact <name>` — blast radius: who transitively depends on this cell? */
export async function cmdImpact(ctx: CellsContext, name: string): Promise<void> {
  const { declarations, ownership } = ctx;
  requireCell(declarations, name); // guard: no cell named → die with the standard error
  const { crossings } = await loadCrossings(ownership);
  process.stdout.write(formatImpactReport(computeImpact(crossings, name)));
}

/** `cells health` — all four checks at once (validate + crossings + structure + size).
 *  One command instead of four for the LLM's check step. Exit 1 if any check fails.
 *  --verbose names failing undeclared edges inline (saves the crossings round-trip). */
/** `health --summary`: collapse per-entry unresolved lines into per-FILE groups (the triage
 *  unit — llama.cpp's 161 OpenCL headers from ONE file become one line), sorted desc, with a
 *  representative specifier. Source-based, no language heuristics: the from-file is the honest
 *  key every unresolved entry carries. */
export function groupUnresolved(unresolved: UnresolvedImport[]): string[] {
  const byFile = new Map<string, { count: number; example: string }>();
  for (const u of unresolved) {
    const g = byFile.get(u.fromFile);
    if (g) g.count++;
    else byFile.set(u.fromFile, { count: 1, example: u.import });
  }
  return [...byFile.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])).map(([f, g]) => `${f}: ${g.count} unresolved (e.g. "${g.example}")`);
}

export async function cmdHealth(ctx: CellsContext, verbose = false, summary = false): Promise<void> {
  const started = performance.now();
  const { config, declarations, ownership } = ctx;
  const codeFiles = listCodeFiles();
  warnIfNoCodeFiles(config, codeFiles);

  const { crossings, uncoveredExts, unresolved } = await loadCrossings(ownership, false);
  const visibleUncoveredExts = uncoveredExts.filter((e) => !config.ignoreBlindExts.includes(e));

  const violations = validatePartition(ownership, declarations, codeFiles);
  const grammarResults = await checkGrammars();
  const leakage = checkLeakage(crossings, declarations);
  const stale = leakage.filter((l) => l.kind === 'stale');
  const cycles = detectCycles(crossings);
  const dirViolations = checkDirection(crossings, declarations);

  const cellNames = Object.keys(declarations);
  let maxPercent = 0;
  const staleProvides: StaleProvide[] = [];
  for (const name of cellNames) {
    const cell = declarations[name];
    const owned = ownership[name] ?? [];
    const contents = readFiles(owned); // one read, shared by the size check and the provides-drift check
    const pct = computePayloadSize(cell, owned, contents, neighborsOf(cell, declarations)).tokens / config.maxPayloadTokens;
    if (pct > maxPercent) maxPercent = pct;
    staleProvides.push(...staleProvidesOf(cell, owned, contents));
  }

  // Pure render + gate verdict live in view.formatHealthReport; this shell only gathers (I/O).
  const undeclared = leakage.filter((l) => l.kind === 'undeclared');
  const unresolvedFiles = summary ? groupUnresolved(unresolved) : undefined;
  const { report, gateOk } = formatHealthReport(
    {
      cellCount: cellNames.length,
      fileCount: codeFiles.length,
      crossingCount: crossings.length,
      violationCount: violations.length,
      violationDetails: violations.map((v) => `${v.kind} — ${v.detail}`),
      undeclaredCount: undeclared.length,
      undeclaredEdges: undeclared.map((u) => u.detail),
      staleCount: stale.length,
      staleEdges: stale.map((s) => `${s.fromCell} → ${s.toCell}`),
      staleProvidesCount: staleProvides.length,
      staleProvidesDetails: staleProvides.map((s) => `${s.cell} provides "${s.provide}"`),
      cycleCount: cycles.length,
      dirViolationCount: dirViolations.length,
      maxPercent,
      uncoveredExts: visibleUncoveredExts,
      unresolvedCount: unresolved.length,
      unresolvedDetails: unresolvedFiles ?? unresolved.map((u) => `${u.fromFile} imports "${u.import}"`),
      unresolvedFiles: unresolvedFiles?.length,
      grammarResults,
      elapsedSec: (performance.now() - started) / 1000,
    },
    verbose,
  );

  process.stdout.write(report);
  if (!gateOk) process.exitCode = 1; // exitCode, not exit(): the report (esp. on failure) must flush before the process ends
}
