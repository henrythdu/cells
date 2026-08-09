/** Read/analysis command handlers for the CLI (the payload-shaped half): crossings, list,
 *  show, owns, payload, graph + the shared read pipeline (loadCrossings, warnIfNoCodeFiles).
 *  cli.ts keeps the dispatcher + mutation commands; the size/structure/impact/health report
 *  commands live in report.ts. Pure-ish: gathers I/O, delegates rendering to view. */
import { listCodeFiles, readFiles, type CellsContext } from '../io.js';
import { computePayloadSize, neighborsOf, estimateTokens, assemblePayload, type CellSize } from '../payload.js';
import { deriveCrossings, checkLeakage, computeMetrics, type Crossing, type CrossingsDelta } from '../crossings.js';
import { formatCellList, formatCellShow, type CellSmell } from '../view.js';
import { formatCellGraph, formatCellGraphAscii } from '../graph.js';
import { coChangePairs, crossingsDelta } from '../diff.js';
import { staleProvidesOf } from '../validate.js';
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
/** Get a cell declaration or die with the standard error — cmdShow/cmdPayload/cmdImpact
 *  all repeat this guard; one home keeps the message consistent. Same-cell helper (read.ts
 *  exports it for report.ts); not a neighbor surface. */
export function requireCell(declarations: Record<string, Cell>, name: string): Cell {
  const cell = declarations[name];
  if (!cell) {
    console.error(`error: no cell named "${name}"`);
    process.exit(1);
  }
  return cell;
}

export async function loadCrossings(ownership: Ownership, warn = true): Promise<{ edges: ImportEdge[]; crossings: Crossing[]; uncoveredExts: string[]; unresolved: UnresolvedImport[] }> {
  const { edges, uncoveredExts, unresolved, failures, ignoreBlindExts } = await collectImportEdges();
  assertNoImporterFailures(failures);
  if (warn) warnIfBlind(uncoveredExts, ignoreBlindExts);
  // Unresolved imports only matter for the partition: an unowned file's broken specifier
  // affects nothing until the file is owned. Filtering here keeps health/crossings info
  // sections actionable (stress test: 280 noise entries from unowned files).
  const ownedUnresolved = unresolved.filter((u) => owningCell(ownership, u.fromFile) !== undefined);
  return { edges, crossings: deriveCrossings(edges, ownership), uncoveredExts, unresolved: ownedUnresolved };
}

/** Importer failure → blind graph → any crossing verdict is unreliable. Fail loudly (see loadCrossings). */
function assertNoImporterFailures(failures: { importer: string; error: string }[]): void {
  if (failures.length === 0) return;
  const detail = failures.map((f) => `importer "${f.importer}" failed: ${f.error}`).join('; ');
  throw new Error(`${detail} — crossings data incomplete (${failures.map((f) => f.importer).join(', ')} edges missing); gate verdict unreliable.`);
}

/** `cells imports [--json]` — the raw file→file import graph: every resolved edge (same-cell
 *  included, unowned files included) + every unresolved specifier. Machine surface for the
 *  crossing-validation harness (scripts/validate-crossings); the gate never reads it. */
export async function cmdImports(opts: { json?: boolean } = {}): Promise<void> {
  const { edges, unresolved, uncoveredExts, failures } = await collectImportEdges();
  assertNoImporterFailures(failures);
  if (!opts.json) {
    console.log(`${edges.length} import edge(s), ${unresolved.length} unresolved specifier(s)`);
    return;
  }
  process.stdout.write(JSON.stringify({ edges, unresolved, uncoveredExts }, null, 2) + '\n');
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
    console.error(`\nUnresolved imports that look local (${unresolved.length}):`);
    for (const u of unresolved) {
      console.error(`  ${u.fromFile} imports "${u.import}" — no matching owned file. A broken specifier, a module-root mismatch, or an external package sharing a local dir name (module-root in config.toml).`);
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

/** `cells list [--verbose]` — partition overview: each cell's files/size/requires/fan-in-out + orphans.
 *  --verbose adds a per-cell health line (size%, stale provides, unresolved, dead files, tests) —
 *  the one-screen orientation scan. All signals reuse data the overview already loads. */
export async function cmdList(ctx: CellsContext, verbose = false): Promise<void> {
  const { declarations, ownership, config } = ctx;
  const sizes: Record<string, CellSize> = {};
  const smells: Record<string, CellSmell> = {};
  for (const name of Object.keys(declarations)) {
    const cell = declarations[name];
    const owned = ownership[name] ?? [];
    const contents = readFiles(owned); // one read — reused for size, stale provides, dead files
    sizes[name] = computePayloadSize(cell, owned, contents, neighborsOf(cell, declarations), readFiles(cell.tests ?? []));
    if (verbose) smells[name] = { pct: sizes[name].tokens / (cell.ceiling ?? config.maxPayloadTokens), staleProvides: 0, unresolved: 0 };
  }
  const { crossings, unresolved } = await loadCrossings(ownership);
  const metrics = computeMetrics(crossings, Object.keys(declarations));
  const owned = new Set(Object.values(ownership).flat());
  const codeFiles = listCodeFiles();
  warnIfNoCodeFiles(config, codeFiles);
  const orphanFiles = codeFiles.filter((f) => !owned.has(f));
  if (verbose) {
    const unresolvedByCell = new Map<string, number>();
    for (const u of unresolved) {
      const owner = owningCell(ownership, u.fromFile);
      if (owner) unresolvedByCell.set(owner, (unresolvedByCell.get(owner) ?? 0) + 1);
    }
    for (const name of Object.keys(declarations)) {
      const cell = declarations[name];
      const s = smells[name];
      s.unresolved = unresolvedByCell.get(name) ?? 0;
      // No provides = nothing to check (staleProvidesOf scans the whole cell's contents) —
      // skip the re-read for the common provides-less cell.
      s.staleProvides = cell.provides.length === 0 ? 0 : staleProvidesOf(cell, ownership[name] ?? [], readFiles(ownership[name] ?? [])).length;
    }
  }
  process.stdout.write(formatCellList(declarations, sizes, metrics, orphanFiles, verbose ? smells : undefined));
}

/** `cells show <name> [--verbose]` — one cell's detail with its in/out crossings.
 *  High-fan-in/out crossings (>8 edges) collapse to a per-cell aggregate;
 *  `--verbose` shows every per-file edge. */
export async function cmdShow(ctx: CellsContext, name: string, verbose = false): Promise<void> {
  const { declarations, ownership } = ctx;
  const cell = requireCell(declarations, name);
  const ownedFiles = ownership[name] ?? [];
  const contents = readFiles(ownedFiles);
  const perFile = ownedFiles.map((f) => ({ file: f, tokens: estimateTokens((contents[f] ?? '').length) }));
  const { edges, crossings, unresolved } = await loadCrossings(ownership);
  const out = crossings.filter((c) => c.fromCell === name);
  const inc = crossings.filter((c) => c.toCell === name);
  const metrics = computeMetrics(crossings, Object.keys(declarations));
  // Dead at the cell boundary: owned files no file OUTSIDE the cell imports (static view —
  // internal edges don't count; entry points may still load them, see impact's caveat).
  const ownedSet = new Set(ownedFiles);
  const externallyImported = new Set<string>();
  for (const e of edges) if (!ownedSet.has(e.fromFile)) externallyImported.add(e.toFile);
  const deadFiles = ownedFiles.filter((f) => !externallyImported.has(f));
  // Unresolved imports FROM this cell's files (loadCrossings already filtered to owned files).
  const cellUnresolved = unresolved.filter((u) => ownedSet.has(u.fromFile)).map((u) => u.import);
  // Logical coupling: files that co-change with this cell's files in git history.
  const coChange = coChangePairs(ownedFiles).map((c) => ({ ...c, cell: owningCell(ownership, c.file) }));
  // Membrane drift: provides entries no owned file references (rides the contents read above).
  const staleProvides = staleProvidesOf(cell, ownedFiles, contents);
  process.stdout.write(
    formatCellShow(
      {
        cell,
        owned: perFile,
        out,
        inc,
        size: computePayloadSize(cell, ownedFiles, contents, neighborsOf(cell, declarations), readFiles(cell.tests ?? [])),
        metrics: metrics[name],
        dead: deadFiles,
        coChange,
        staleProvides,
        unresolved: cellUnresolved,
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

/** Export-ish declaration lines, per language — the raw material for a cell's `signatures`
 *  membrane field. A rough line regex, not a parser: the LLM curates the output (adapting
 *  to type annotations) before pasting it into the .cell.toml. Pure. */
export function extractSurface(content: string): { line: number; text: string }[] {
  // TS/JS export decls; Rust pub items; Python top-level def/class; Go top-level decls; Java types.
  // Matched against the RAW line — the ^ anchors mean column-0 (top-level) only, so indented
  // methods/statements (Python defs inside a class, indented consts) are correctly skipped.
  const RE =
    /^(?:export\s+(?:async\s+)?function|export\s+(?:const|class|interface|type|enum)\s|pub\s+(?:fn|struct|enum|trait|type|const|mod|use)\s|(?:async\s+)?def\s|class\s|func\s|type\s|const\s|var\s|public\s+(?:class|interface|enum|record)\s)/;
  const out: { line: number; text: string }[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (RE.test(lines[i])) out.push({ line: i + 1, text: lines[i].trim() });
  }
  return out;
}

/** `cells surface <name>` — print the cell's export-ish declaration lines (file:line), the
 *  starting point for populating the membrane `signatures` field. Groups by owned file. */
export function cmdSurface(ctx: CellsContext, name: string): void {
  const { declarations, ownership } = ctx;
  const cell = requireCell(declarations, name);
  const ownedFiles = ownership[name] ?? [];
  const contents = readFiles(ownedFiles);
  let any = false;
  for (const f of ownedFiles) {
    const hits = extractSurface(contents[f] ?? '');
    if (hits.length === 0) continue;
    any = true;
    process.stdout.write(`## ${f}\n`);
    for (const h of hits) process.stdout.write(`  ${h.line}: ${h.text}\n`);
  }
  if (!any) process.stdout.write(`No export-like declarations found in ${cell.name}'s ${ownedFiles.length} owned file(s).\n`);
  process.stdout.write(`\nPopulate the membrane: add these to \`signatures\` in .cells/${cell.name}.cell.toml (adapt with types).\n`);
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
  const cell = requireCell(declarations, name);

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

  const dependents = Object.values(declarations).filter((d) => d.requires.includes(name));
  const payload = assemblePayload(cell, ownedFiles, fileContents, neighbors, dependents.length, testFiles, testContents, dependents);
  process.stdout.write(payload);

  const chars = payload.length;
  console.error(`\n[size: ${chars} chars, ~${estimateTokens(chars)} tokens]`);
}
