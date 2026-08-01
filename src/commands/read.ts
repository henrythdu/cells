/** Read/analysis command handlers for the CLI (the payload-shaped half): crossings, list,
 *  show, owns, payload, graph + the shared read pipeline (loadCrossings, warnIfNoCodeFiles).
 *  cli.ts keeps the dispatcher + mutation commands; the size/structure/impact/health report
 *  commands live in report.ts. Pure-ish: gathers I/O, delegates rendering to view. */
import { listCodeFiles, readFiles, type CellsContext } from '../io.js';
import { computePayloadSize, neighborsOf, estimateTokens, assemblePayload, type CellSize } from '../payload.js';
import { deriveCrossings, checkLeakage, computeMetrics, type Crossing, type CrossingsDelta } from '../crossings.js';
import { formatCellList, formatCellShow } from '../view.js';
import { formatCellGraph, formatCellGraphAscii } from '../graph.js';
import { coChangePairs, crossingsDelta } from '../diff.js';
import { collectImportEdges } from '../importers.js';
import type { ImportEdge, UnresolvedImport } from '../imports.js';
import { owningCell, type Ownership } from '../ownership.js';
import type { CellsConfig } from '../config.js';
import type { Cell } from '../declaration.js';

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
  // Unresolved imports only matter for the partition: an unowned file's broken specifier
  // affects nothing until the file is owned. Filtering here keeps health/crossings info
  // sections actionable (stress test: 280 noise entries from unowned files).
  const ownedUnresolved = unresolved.filter((u) => owningCell(ownership, u.fromFile) !== undefined);
  return { edges, crossings: deriveCrossings(edges, ownership), uncoveredExts, unresolved: ownedUnresolved };
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
      showCrossingsDelta(delta, undeclaredKeys, declarations);
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
function showCrossingsDelta(delta: CrossingsDelta, undeclared: Set<string> = new Set(), declarations: Record<string, Cell> = {}): void {
  if (delta.added.length === 0 && delta.removed.length === 0) {
    console.log('No crossing changes since HEAD.');
    return;
  }
  console.log('Crossings delta (working tree vs HEAD):');
  for (const c of delta.added) {
    const flag = undeclared.has(`${c.fromCell}|${c.toCell}`) ? ' [UNDECLARED]' : '';
    console.log(`  +${flag} ${c.fromCell} → ${c.toCell}   (${c.fromFile} → ${c.toFile})`);
  }
  for (const c of delta.removed) {
    // Removed edge to a cell still declared in requires = the change invalidated a
    // declared contract (mirror of [UNDECLARED] on the added side).
    const flag = declarations[c.fromCell]?.requires.includes(c.toCell) ? ' [REQUIRES NOW STALE]' : '';
    console.log(`  −${flag} ${c.fromCell} → ${c.toCell}   (${c.fromFile} → ${c.toFile})`);
  }
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
  process.stdout.write(formatCellList(declarations, sizes, metrics, orphanFiles));
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
  const { edges, crossings } = await loadCrossings(ownership);
  const out = crossings.filter((c) => c.fromCell === name);
  const inc = crossings.filter((c) => c.toCell === name);
  const metrics = computeMetrics(crossings, Object.keys(declarations));
  // Dead at the cell boundary: owned files no file OUTSIDE the cell imports (static view —
  // internal edges don't count; entry points may still load them, see impact's caveat).
  const ownedSet = new Set(ownedFiles);
  const externallyImported = new Set<string>();
  for (const e of edges) if (!ownedSet.has(e.fromFile)) externallyImported.add(e.toFile);
  const deadFiles = ownedFiles.filter((f) => !externallyImported.has(f));
  // Logical coupling: files that co-change with this cell's files in git history.
  const coChange = coChangePairs(ownedFiles).map((c) => ({ ...c, cell: owningCell(ownership, c.file) }));
  process.stdout.write(
    formatCellShow(
      {
        cell,
        owned: perFile,
        out,
        inc,
        size: computePayloadSize(cell, ownedFiles, neighborsOf(cell, declarations)),
        metrics: metrics[name],
        dead: deadFiles,
        coChange,
      },
      verbose,
    ),
  );
}

/** `cells graph [--mermaid]` — render the cell graph (ASCII tree default; --mermaid for source). */
export async function cmdGraph(ctx: CellsContext, mermaid: boolean): Promise<void> {
  const { ownership } = ctx;
  const { crossings } = await loadCrossings(ownership);
  const allCells = Object.keys(ownership);
  process.stdout.write(mermaid ? formatCellGraph(crossings, allCells) : formatCellGraphAscii(crossings, allCells));
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
