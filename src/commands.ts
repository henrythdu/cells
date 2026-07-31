/** Read/analysis command handlers for the CLI (the payload-shaped half). cli.ts keeps
 *  the dispatcher + mutation commands; this module implements the commands that read
 *  the store and render reports. Pure-ish: gathers I/O, delegates rendering to view. */
import { listCodeFiles, computePayloadSize, neighborsOf, readFiles, estimateTokens, type CellsContext } from './io.js';
import { deriveCrossings, checkLeakage, computeMetrics, type Crossing, type CrossingsDelta } from './crossings.js';
import { formatCellList, formatCellShow, formatSizeReport, formatHealthReport, type PeelCandidate } from './view.js';
import { formatCellGraph, formatCellGraphAscii } from './graph.js';
import { crossingsDelta } from './diff.js';
import { collectImportEdges } from './importers.js';
import type { ImportEdge, UnresolvedImport } from './imports.js';
import { assemblePayload, type CellSize } from './payload.js';
import { owningCell, type Ownership } from './ownership.js';
import { detectCycles, checkDirection, checkSDP, formatSdpReport, formatStructureReport, formatLayerOverview, formatLayerSuggestions, computeImpact, formatImpactReport } from './structure.js';
import { validatePartition } from './validate.js';
import type { CellsConfig } from './config.js';
import type { Cell } from './declaration.js';

/** Warn (stderr) when census files exist that no importer handles — the
 * crossings-derived output may be BLIND. Goes to stderr so machine output (stdout) stays clean. */
function warnIfBlind(uncoveredExts: string[], ignoreBlindExts: string[]): void {
  const noisy = uncoveredExts.filter((e) => !ignoreBlindExts.includes(e));
  if (noisy.length > 0) {
    console.error(`⚠ no importer for ${noisy.join(', ')} — crossings/impact/structure/graph are BLIND (unverified). Partition/size/validate are unaffected. Silence per-ext via ignore-blind-exts in config.toml.`);
  }
}

/** Safety net: when a command finds zero code files, point at config.toml — the usual cause
 *  is a language/config mismatch (e.g. TS defaults on a Python repo). Surfaces the onboarding
 *  failure that `cells init`'s detection is meant to prevent. */
export function warnIfNoCodeFiles(config: CellsConfig, codeFiles: string[]): void {
  if (codeFiles.length === 0) {
    console.error(`\n⚠ 0 code files match code-exts=[${config.codeExts.join(', ')}] under code-dirs=[${config.codeDirs.join(', ')}] — edit .cells/config.toml.`);
  }
}

/** The shared read-command pipeline: collect import edges, warn on blind exts, derive cell
 *  crossings. Every analysis command routes through this (one drift surface). `warn` lets
 *  health skip the stderr blind-warning — its report already covers it. */
export async function loadCrossings(ownership: Ownership, warn = true): Promise<{ edges: ImportEdge[]; crossings: Crossing[]; uncoveredExts: string[]; unresolved: UnresolvedImport[] }> {
  const { edges, uncoveredExts, unresolved, failures, ignoreBlindExts } = await collectImportEdges();
  if (failures.length > 0) {
    // Importer failed → its language's edges are missing → the graph is blind → any
    // crossing verdict (incl. the gate) is unreliable. Fail loudly: a false green is
    // worse than a false red. Mandatory confrontation, same as a gate failure.
    const detail = failures.map((f) => `importer "${f.importer}" failed: ${f.error}`).join('; ');
    throw new Error(`${detail} — crossings data incomplete (${failures.map((f) => f.importer).join(', ')} edges missing); gate verdict unreliable.`);
  }
  if (warn) warnIfBlind(uncoveredExts, ignoreBlindExts);
  return { edges, crossings: deriveCrossings(edges, ownership), uncoveredExts, unresolved };
}

/** `cells crossings [--diff] [--verbose] [--json]` — real cross-cell imports + leakage.
 *  Default: cell-pair summary (the overview question: "which cells are coupled?");
 *  `--verbose` shows every file→file edge; `--diff` shows what your uncommitted edits
 *  added/removed (working tree vs HEAD); `--json` emits raw JSON (stdout stays machine-clean;
 *  human notes go to stderr). */
export async function cmdCrossings(ctx: CellsContext, opts: { diff?: boolean; verbose?: boolean; json?: boolean } = {}): Promise<void> {
  const { ownership, declarations } = ctx;
  const { crossings, unresolved } = await loadCrossings(ownership);

  if (opts.diff) {
    const delta = await crossingsDelta(crossings, ownership);
    if (delta !== null) {
      // Flag leakage introduced by these edits. Only UNDECLARED is meaningful on a
      // delta subset ("did I add a crossing the from-cell doesn't require?"); stale
      // (declared-but-unused) is a full-tree property an added-subset can't answer.
      const leakage = checkLeakage(delta.added, declarations).filter((l) => l.kind === 'undeclared');
      const undeclaredKeys = new Set(leakage.map((l) => `${l.fromCell}|${l.toCell}`));
      showCrossingsDelta(delta, undeclaredKeys);
      if (leakage.length > 0) {
        console.error(`\nUndeclared crossings (${leakage.length}) — the [UNDECLARED] edges above need a requires entry (or remove the import):`);
        for (const l of leakage) console.error(`  ${l.detail}`);
        process.exitCode = 1; // exitCode, not exit(): let stdout drain — piped output must not lose the tail
        return;
      }
      return;
    }
    console.error('⚠ --diff unavailable (need a git repo with at least one commit) — showing current crossings instead.');
  }

  if (crossings.length === 0) {
    if (opts.json) {
      process.stdout.write('[]\n'); // machine consumers always get valid JSON
    } else {
      console.log('No cross-cell imports.');
    }
  } else if (opts.json) {
    process.stdout.write(JSON.stringify(crossings, null, 2) + '\n');
  } else {
    // default: aggregate summary; --verbose: every file→file edge under its cell pair
    const byPair = new Map<string, { from: string; to: string; files: [string, string][] }>();
    for (const c of crossings) {
      const k = `${c.fromCell}|${c.toCell}`;
      const p = byPair.get(k) ?? { from: c.fromCell, to: c.toCell, files: [] };
      p.files.push([c.fromFile, c.toFile]);
      byPair.set(k, p);
    }
    const pairs = [...byPair.values()].sort((a, b) => b.files.length - a.files.length || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    console.log(`Cross-cell imports (${pairs.length} cell pairs, ${crossings.length} edges):`);
    for (const p of pairs) {
      console.log(`  ${p.from} → ${p.to}   (${p.files.length} edge${p.files.length === 1 ? '' : 's'})`);
      if (opts.verbose) for (const [f, t] of p.files) console.log(`      ${f} → ${t}`);
    }
  }

  const leakage = checkLeakage(crossings, declarations);
  const stale = leakage.filter((l) => l.kind === 'stale');
  const undeclared = leakage.filter((l) => l.kind === 'undeclared');
  if (stale.length > 0) {
    // stale = declared-but-never-imported — info (exit 0), same as health. Gate fails on undeclared only.
    console.error(`(info) ${stale.length} stale require(s) — declared but no import found (maybe a data dependency or future plan):`);
    for (const l of stale) console.error(`  ${l.detail}`);
  }
  if (undeclared.length > 0) {
    console.error(`\nUndeclared crossings (${undeclared.length}) — add a requires entry (or remove the import):`);
    for (const l of undeclared) console.error(`  ${l.detail}`);
    process.exitCode = 1; // exitCode, not exit(): keep the unresolved report below, then drain stdout before exit
  }

  if (unresolved.length > 0) {
    console.error(`\nUnresolved local imports (${unresolved.length}):`);
    for (const u of unresolved) {
      console.error(`  ${u.fromFile} imports "${u.import}" — no matching owned file. Check the specifier or set module-root in config.toml.`);
    }
  }
}

/** Render a crossings delta: +/− edges, then a summary. */
function showCrossingsDelta(delta: CrossingsDelta, undeclared: Set<string> = new Set()): void {
  if (delta.added.length === 0 && delta.removed.length === 0) {
    console.log('No crossing changes since HEAD.');
    return;
  }
  console.log('Crossings delta (working tree vs HEAD):');
  for (const c of delta.added) {
    const flag = undeclared.has(`${c.fromCell}|${c.toCell}`) ? ' [UNDECLARED]' : '';
    console.log(`  +${flag} ${c.fromCell} → ${c.toCell}   (${c.fromFile} → ${c.toFile})`);
  }
  for (const c of delta.removed) console.log(`  − ${c.fromCell} → ${c.toCell}   (${c.fromFile} → ${c.toFile})`);
  console.log(`${delta.added.length} added, ${delta.removed.length} removed.`);
}

/** `cells list` — partition overview: each cell's files/size/requires/fan-in-out + orphans. */
export async function cmdList(ctx: CellsContext): Promise<void> {
  const { declarations, ownership, config } = ctx;
  const sizes: Record<string, CellSize> = {};
  for (const name of Object.keys(declarations)) {
    const cell = declarations[name];
    sizes[name] = computePayloadSize(cell, ownership[name] ?? [], neighborsOf(cell, declarations));
  }
  const { crossings } = await loadCrossings(ownership);
  const metrics = computeMetrics(crossings, Object.keys(declarations));
  const owned = new Set(Object.values(ownership).flat());
  const codeFiles = listCodeFiles();
  warnIfNoCodeFiles(config, codeFiles);
  const orphanFiles = codeFiles.filter((f) => !owned.has(f));
  process.stdout.write(formatCellList(declarations, ownership, sizes, metrics, orphanFiles));
}

/** `cells show <name> [--verbose]` — one cell's detail with its in/out crossings.
 *  High-fan-in/out crossings (>8 edges) collapse to a per-cell aggregate;
 *  `--verbose` shows every per-file edge. */
export async function cmdShow(ctx: CellsContext, name: string, verbose = false): Promise<void> {
  const { declarations, ownership } = ctx;
  const cell = declarations[name];
  if (!cell) {
    console.error(`error: no cell named "${name}"`);
    process.exit(1);
  }
  const ownedFiles = ownership[name] ?? [];
  const contents = readFiles(ownedFiles);
  const perFile = ownedFiles.map((f) => ({ file: f, tokens: estimateTokens((contents[f] ?? '').length) }));
  const { crossings } = await loadCrossings(ownership);
  const out = crossings.filter((c) => c.fromCell === name);
  const inc = crossings.filter((c) => c.toCell === name);
  const metrics = computeMetrics(crossings, Object.keys(declarations));
  process.stdout.write(formatCellShow(cell, perFile, out, inc, computePayloadSize(cell, ownedFiles, neighborsOf(cell, declarations)), metrics[name], verbose));
}

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
    const size = computePayloadSize(cell, owned, neighborsOf(cell, declarations));
    // Peel candidates: for over-ceiling cells, rank owned files by size↓ + fan-in↑
    // (a big file few others import is the cheapest chunk to carve out).
    let peel: PeelCandidate[] | undefined;
    if (size.tokens > config.maxPayloadTokens) {
      const contents = readFiles(owned);
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
  if (!declarations[name]) {
    console.error(`error: no cell named "${name}"`);
    process.exit(1);
  }
  const { crossings } = await loadCrossings(ownership);
  process.stdout.write(formatImpactReport(computeImpact(crossings, name)));
}

/** `cells graph [--mermaid]` — render the cell graph (ASCII tree default; --mermaid for source). */
export async function cmdGraph(ctx: CellsContext, mermaid: boolean): Promise<void> {
  const { ownership } = ctx;
  const { crossings } = await loadCrossings(ownership);
  process.stdout.write(mermaid ? formatCellGraph(crossings) : formatCellGraphAscii(crossings));
}

/** `cells owns <file>` — which cell owns this file? (terse: name + purpose; orphan if unowned) */
export function cmdOwns(ctx: CellsContext, file: string): void {
  const { ownership, declarations } = ctx;
  const cell = owningCell(ownership, file);
  if (!cell) {
    console.log(`${file} is not owned by any cell (orphan).`);
    return;
  }
  const purpose = declarations[cell]?.purpose ?? '(no declaration)';
  console.log(`${file} → ${cell} — ${purpose}`);
}

/** `cells payload <name>` — assemble and print a cell's payload to stdout. */
export function cmdPayload(ctx: CellsContext, name: string): void {
  const { declarations, ownership } = ctx;
  const cell = declarations[name];
  if (!cell) {
    console.error(`error: no cell named "${name}"`);
    process.exit(1);
  }

  const ownedFiles = ownership[name] ?? [];
  const fileContents = readFiles(ownedFiles);

  const testFiles = cell.tests ?? [];
  const testContents = testFiles.length > 0 ? readFiles(testFiles) : {};

  const neighbors: Cell[] = [];
  for (const n of cell.requires) {
    const neighbor = declarations[n];
    if (neighbor) neighbors.push(neighbor);
    else console.error(`warning: neighbor "${n}" of cell "${name}" has no declaration`);
  }

  const dependedByCount = Object.values(declarations).filter((d) => d.requires.includes(name)).length;
  const payload = assemblePayload(cell, ownedFiles, fileContents, neighbors, dependedByCount, testFiles, testContents);
  process.stdout.write(payload);

  const chars = payload.length;
  console.error(`\n[size: ${chars} chars, ~${estimateTokens(chars)} tokens]`);
}

/** `cells health` — all four checks at once (validate + crossings + structure + size).
 *  One command instead of four for the LLM's check step. Exit 1 if any check fails.
 *  --verbose names failing undeclared edges inline (saves the crossings round-trip). */
export async function cmdHealth(ctx: CellsContext, verbose = false): Promise<void> {
  const { config, declarations, ownership } = ctx;
  const codeFiles = listCodeFiles();
  warnIfNoCodeFiles(config, codeFiles);

  const { crossings, uncoveredExts, unresolved } = await loadCrossings(ownership, false);
  const visibleUncoveredExts = uncoveredExts.filter((e) => !config.ignoreBlindExts.includes(e));

  const violations = validatePartition(ownership, declarations, codeFiles);
  const leakage = checkLeakage(crossings, declarations);
  const stale = leakage.filter((l) => l.kind === 'stale');
  const cycles = detectCycles(crossings);
  const dirViolations = checkDirection(crossings, declarations);

  const cellNames = Object.keys(declarations);
  let maxPercent = 0;
  for (const name of cellNames) {
    const cell = declarations[name];
    const pct = computePayloadSize(cell, ownership[name] ?? [], neighborsOf(cell, declarations)).tokens / config.maxPayloadTokens;
    if (pct > maxPercent) maxPercent = pct;
  }

  // Pure render + gate verdict live in view.formatHealthReport; this shell only gathers (I/O).
  const undeclared = leakage.filter((l) => l.kind === 'undeclared');
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
      cycleCount: cycles.length,
      dirViolationCount: dirViolations.length,
      maxPercent,
      uncoveredExts: visibleUncoveredExts,
      unresolvedCount: unresolved.length,
      unresolvedDetails: unresolved.map((u) => `${u.fromFile} imports "${u.import}"`),
    },
    verbose,
  );

  process.stdout.write(report);
  if (!gateOk) process.exitCode = 1; // exitCode, not exit(): the report (esp. on failure) must flush before the process ends
}
