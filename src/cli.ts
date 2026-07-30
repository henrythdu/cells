#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Installed version, read lazily from package.json (works in dev + when npm-installed). */
function readVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
import { serializeCell, STUB_PURPOSE, type Cell } from './declaration.js';
import { serializeOwnership, owningCell } from './ownership.js';
import { assemblePayload, type CellSize } from './payload.js';
import { validatePartition } from './validate.js';
import { deriveCrossings, checkLeakage, computeMetrics, type CrossingsDelta } from './crossings.js';
import { formatCellList, formatCellShow, formatSizeReport, formatHealthReport, type PeelCandidate } from './view.js';
import { formatCellGraph, formatCellGraphAscii } from './graph.js';
import { unassignFiles, planAssignment, validCellName } from './assign.js';
import { CELLS_DIR, loadDeclarations, loadOwnership, loadConfig, listCodeFiles, loadContext, computePayloadSize, neighborsOf, readFiles, requireCells, detectProject, type CellsContext } from './io.js';
import { crossingsDelta } from './diff.js';
import { collectImportEdges } from './importers.js';
import { buildConfig, type CellsConfig } from './config.js';
import { detectCycles, checkDirection, checkSDP, formatSdpReport, formatStructureReport, formatLayerOverview, formatLayerSuggestions, computeImpact, formatImpactReport } from './structure.js';
import { HELP } from './help.js';

/** Warn (stderr) when census files exist that no importer handles — the
 * crossings-derived output may be BLIND. Goes to stderr so machine output (stdout) stays clean. */
function warnIfBlind(uncoveredExts: string[]): void {
  if (uncoveredExts.length > 0) {
    console.error(`⚠ no importer for ${uncoveredExts.join(', ')} — crossings/impact/structure/graph are BLIND (unverified). Partition/size/validate are unaffected.`);
  }
}

/** Safety net: when a command finds zero code files, point at config.toml — the usual cause
 *  is a language/config mismatch (e.g. TS defaults on a Python repo). Surfaces the onboarding
 *  failure that `cells init`'s detection is meant to prevent. */
function warnIfNoCodeFiles(config: CellsConfig, codeFiles: string[]): void {
  if (codeFiles.length === 0) {
    console.error(`\n⚠ 0 code files match code-exts=[${config.codeExts.join(', ')}] under code-dirs=[${config.codeDirs.join(', ')}] — edit .cells/config.toml.`);
  }
}

/** `cells crossings [--diff]` — real cross-cell imports + leakage; `--diff` shows what your
 *  uncommitted edits added/removed (working tree vs HEAD). */
async function cmdCrossings(ctx: CellsContext, diff = false): Promise<void> {
  const { ownership, declarations } = ctx;
  const { edges, uncoveredExts } = await collectImportEdges();
  warnIfBlind(uncoveredExts);
  const crossings = deriveCrossings(edges, ownership);

  if (diff) {
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
        process.exit(1);
      }
      return;
    }
    console.error('⚠ --diff unavailable (need a git repo with at least one commit) — showing current crossings instead.');
  }

  if (crossings.length === 0) {
    console.log('No cross-cell imports.');
  } else {
    console.log(`Cross-cell imports (${crossings.length}):`);
    for (const c of crossings) {
      console.log(`  ${c.fromCell} → ${c.toCell}   (${c.fromFile} → ${c.toFile})`);
    }
  }

  const leakage = checkLeakage(crossings, declarations);
  if (leakage.length > 0) {
    console.error(`\nLeakage (${leakage.length}):`);
    for (const l of leakage) {
      console.error(`  [${l.kind}] ${l.detail}`);
    }
    process.exit(1);
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
async function cmdList(ctx: CellsContext): Promise<void> {
  const { declarations, ownership, config } = ctx;
  const sizes: Record<string, CellSize> = {};
  for (const name of Object.keys(declarations)) {
    const cell = declarations[name];
    sizes[name] = computePayloadSize(cell, ownership[name] ?? [], neighborsOf(cell, declarations));
  }
  const { edges } = await collectImportEdges();
  const crossings = deriveCrossings(edges, ownership);
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
async function cmdShow(ctx: CellsContext, name: string, verbose = false): Promise<void> {
  const { declarations, ownership } = ctx;
  const cell = declarations[name];
  if (!cell) {
    console.error(`error: no cell named "${name}"`);
    process.exit(1);
  }
  const ownedFiles = ownership[name] ?? [];
  const { edges, uncoveredExts } = await collectImportEdges();
  warnIfBlind(uncoveredExts);
  const crossings = deriveCrossings(edges, ownership);
  const out = crossings.filter((c) => c.fromCell === name);
  const inc = crossings.filter((c) => c.toCell === name);
  const metrics = computeMetrics(crossings, Object.keys(declarations));
  process.stdout.write(formatCellShow(cell, ownedFiles, out, inc, computePayloadSize(cell, ownedFiles, neighborsOf(cell, declarations)), metrics[name], verbose));
}

/** `cells size` — context-fit warning: payloads vs the configured ceiling. Non-blocking (exit 0). */
async function cmdSize(ctx: CellsContext): Promise<void> {
  const { config, declarations, ownership } = ctx;
  const { edges } = await collectImportEdges();
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
      peel = owned.map((f) => ({ file: f, tokens: Math.ceil((contents[f] ?? '').length / 3), fanIn: fileFanIn.get(f) ?? 0 })).sort((a, b) => b.tokens - a.tokens || a.fanIn - b.fanIn);
    }
    return { name, size, peel };
  });
  process.stdout.write(formatSizeReport(entries, config.maxPayloadTokens));
}

/** `cells structure` — governance: ADP (cycles) + Direction (layering). Warnings only (exit 0). */
async function cmdStructure(ctx: CellsContext): Promise<void> {
  const { declarations, ownership, config } = ctx;
  const { edges, uncoveredExts } = await collectImportEdges();
  warnIfBlind(uncoveredExts);
  const crossings = deriveCrossings(edges, ownership);
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
async function cmdImpact(ctx: CellsContext, name: string): Promise<void> {
  const { declarations, ownership } = ctx;
  if (!declarations[name]) {
    console.error(`error: no cell named "${name}"`);
    process.exit(1);
  }
  const { edges, uncoveredExts } = await collectImportEdges();
  warnIfBlind(uncoveredExts);
  const crossings = deriveCrossings(edges, ownership);
  process.stdout.write(formatImpactReport(computeImpact(crossings, name)));
}

/** `cells graph [--mermaid]` — render the cell graph (ASCII tree default; --mermaid for source). */
async function cmdGraph(ctx: CellsContext, mermaid: boolean): Promise<void> {
  const { ownership } = ctx;
  const { edges, uncoveredExts } = await collectImportEdges();
  warnIfBlind(uncoveredExts);
  const crossings = deriveCrossings(edges, ownership);
  process.stdout.write(mermaid ? formatCellGraph(crossings) : formatCellGraphAscii(crossings));
}

/** `cells owns <file>` — which cell owns this file? (terse: name + purpose; orphan if unowned) */
function cmdOwns(ctx: CellsContext, file: string): void {
  const { ownership, declarations } = ctx;
  const cell = owningCell(ownership, file);
  if (!cell) {
    console.log(`${file} is not owned by any cell (orphan).`);
    return;
  }
  const purpose = declarations[cell]?.purpose ?? '(no declaration)';
  console.log(`${file} → ${cell} — ${purpose}`);
}

/** `cells init` — bootstrap a `.cells/` store (idempotent + self-healing). */
function cmdInit(dryRun = false): void {
  const { codeExts, codeDirs } = detectProject();
  if (dryRun) {
    const ownPath = join(CELLS_DIR, 'ownership.toml');
    const cfgPath = join(CELLS_DIR, 'config.toml');
    const needed: string[] = [];
    if (!existsSync(ownPath)) needed.push('ownership.toml');
    if (!existsSync(cfgPath)) needed.push('config.toml');
    if (needed.length === 0) {
      console.log(`${CELLS_DIR}/ already initialized — nothing to do.`);
    } else {
      console.log(`Would create ${CELLS_DIR}/ with ${needed.join(' + ')}.`);
      console.log(`Would detect: code-exts = [${codeExts.join(', ')}], code-dirs = [${codeDirs.join(', ')}].`);
    }
    return;
  }
  mkdirSync(CELLS_DIR, { recursive: true });
  const ownPath = join(CELLS_DIR, 'ownership.toml');
  const cfgPath = join(CELLS_DIR, 'config.toml');
  const created: string[] = [];
  if (!existsSync(ownPath)) {
    writeFileSync(ownPath, serializeOwnership({}));
    created.push('ownership.toml');
  }
  if (!existsSync(cfgPath)) {
    writeFileSync(cfgPath, buildConfig(codeExts, codeDirs));
    created.push('config.toml');
  }
  if (created.length === 0) {
    console.log(`${CELLS_DIR}/ already initialized — nothing to do.`);
    return;
  }
  console.log(`Initialized ${CELLS_DIR}/: created ${created.join(' + ')}.`);
  console.log(`Detected: code-exts = [${codeExts.join(', ')}], code-dirs = [${codeDirs.join(', ')}].`);
  console.log('Next: `cells assign <cell> <file...>` to start partitioning.');
}

/** `cells rename <old> <new>` — rename a cell across the store: .cell.toml file,
 *  ownership.toml key, and every other cell's requires reference. */
function cmdRename(oldName: string, newName: string): void {
  if (!validCellName(newName)) {
    console.error(`cells: invalid cell name "${newName}" — use only letters, numbers, dashes, underscores.`);
    process.exit(1);
  }

  if (!existsSync(join(CELLS_DIR, `${oldName}.cell.toml`))) {
    console.error(`cells: no cell named "${oldName}"`);
    process.exit(1);
  }

  if (existsSync(join(CELLS_DIR, `${newName}.cell.toml`))) {
    console.error(`cells: "${newName}" already exists — can't overwrite`);
    process.exit(1);
  }

  const decls = loadDeclarations();
  const oldDecl = decls[oldName];

  renameSync(join(CELLS_DIR, `${oldName}.cell.toml`), join(CELLS_DIR, `${newName}.cell.toml`));

  if (oldDecl) {
    oldDecl.name = newName;
    writeFileSync(join(CELLS_DIR, `${newName}.cell.toml`), serializeCell(oldDecl));
  }

  const ownership = loadOwnership();
  const ownedCount = ownership[oldName]?.length ?? 0;
  if (ownership[oldName]) {
    ownership[newName] = ownership[oldName];
    delete ownership[oldName];
    writeFileSync(join(CELLS_DIR, 'ownership.toml'), serializeOwnership(ownership));
  }

  let requiresUpdated = 0;
  for (const [name, decl] of Object.entries(decls)) {
    if (name === oldName) continue;
    if (decl.requires.includes(oldName)) {
      decl.requires = decl.requires.map((r) => (r === oldName ? newName : r));
      writeFileSync(join(CELLS_DIR, `${name}.cell.toml`), serializeCell(decl));
      requiresUpdated++;
    }
  }

  console.log(`Renamed "${oldName}" → "${newName}".`);
  if (ownedCount > 0) console.log(`  Ownership: ${ownedCount} file(s).`);
  if (requiresUpdated > 0) console.log(`  Requires: updated ${requiresUpdated} cell(s).`);
}

/** `cells remove <cell> [--force]` — delete a cell from the store. Refuses if the cell
 *  owns files or is required by others (state must be resolved first); --force orphans
 *  the files (→ unowned) and strips requires references from other cells. */
function cmdRemove(name: string, force: boolean): void {
  const declPath = join(CELLS_DIR, `${name}.cell.toml`);
  if (!existsSync(declPath)) {
    console.error(`cells: no cell named "${name}"`);
    process.exit(1);
  }

  const ownership = loadOwnership();
  const ownedFiles = ownership[name] ?? [];
  const decls = loadDeclarations();
  const dependents = Object.values(decls)
    .filter((d) => d.name !== name && d.requires.includes(name))
    .map((d) => d.name);

  if (!force && (ownedFiles.length > 0 || dependents.length > 0)) {
    if (ownedFiles.length > 0) console.error(`cells: "${name}" owns ${ownedFiles.length} file(s) — reassign them (cells assign), or use --force to orphan them (→ unowned)`);
    if (dependents.length > 0) console.error(`cells: "${name}" is required by ${dependents.join(', ')} — update their requires, or use --force to strip the references`);
    process.exit(1);
  }

  rmSync(declPath);

  if (ownedFiles.length > 0 || ownership[name] !== undefined) {
    delete ownership[name];
    writeFileSync(join(CELLS_DIR, 'ownership.toml'), serializeOwnership(ownership));
  }

  for (const dep of dependents) {
    const decl = decls[dep];
    decl.requires = decl.requires.filter((r) => r !== name);
    writeFileSync(join(CELLS_DIR, `${dep}.cell.toml`), serializeCell(decl));
  }

  console.log(`Removed cell "${name}".`);
  if (ownedFiles.length > 0) console.log(`  ${ownedFiles.length} file(s) orphaned → unowned.`);
  if (dependents.length > 0) console.log(`  Stripped requires from: ${dependents.join(', ')}.`);
}

/** `cells assign <cell> <file...>` — move files into a cell; stub its declaration if new. */
function cmdAssign(cell: string, files: string[], dryRun = false): void {
  const declPath = join(CELLS_DIR, `${cell}.cell.toml`);
  const declarations = loadDeclarations();
  // planAssignment validates the name (throws → main().catch surfaces it), decides the stub, computes ownership.
  const { stub, ownership } = planAssignment(loadOwnership(), cell, files, existsSync(declPath));
  // Size pre-flight: warn if the destination would exceed its ceiling after the move.
  const cellDecl = declarations[cell] ?? stub;
  if (cellDecl) {
    const pct = computePayloadSize(cellDecl, ownership[cell] ?? [], neighborsOf(cellDecl, declarations)).tokens / loadConfig().maxPayloadTokens;
    if (pct > 1) console.log(`⚠ ${cell} would be ${Math.round(pct * 100)}% of the ceiling after this move — consider peeling a file out first (\`cells size ${cell}\`).`);
  }
  if (dryRun) {
    console.log(stub ? `Would create stub ${cell}.cell.toml + assign ${files.length} file(s) to "${cell}".` : `Would assign ${files.length} file(s) to "${cell}".`);
    return;
  }
  if (stub) writeFileSync(declPath, serializeCell(stub)); // stub before ownership — a write failure leaves no dirty state
  writeFileSync(join(CELLS_DIR, 'ownership.toml'), serializeOwnership(ownership));
  console.log(stub ? `Assigned ${files.length} file(s) to "${cell}" — created stub declaration.\nEdit ${declPath} (purpose/provides/requires), then run \`cells health\`.` : `Assigned ${files.length} file(s) to "${cell}".`);
}

/** `cells unassign <file...>` — remove files from their cell (→ orphan). */
function cmdUnassign(files: string[], dryRun = false): void {
  const ownership = loadOwnership();
  const ownedBefore = new Set(Object.values(ownership).flat());
  const removed = files.filter((f) => ownedBefore.has(f));
  if (dryRun) {
    if (removed.length === 0) {
      console.log('Would do nothing — none of those files are owned.');
    } else {
      console.log(`Would unassign ${removed.length} file(s).`);
    }
    return;
  }
  writeFileSync(join(CELLS_DIR, 'ownership.toml'), serializeOwnership(unassignFiles(ownership, files)));
  if (removed.length === 0) {
    console.log('No changes — none of those files were owned.');
    return;
  }
  console.log(`Unassigned ${removed.length} file(s) — now orphan.`);
}

/** `cells payload <name>` — assemble and print a cell's payload to stdout. */
function cmdPayload(ctx: CellsContext, name: string): void {
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
  console.error(`\n[size: ${chars} chars, ~${Math.ceil(chars / 3)} tokens]`);
}

/** `cells health` — all four checks at once (validate + crossings + structure + size).
 *  One command instead of four for the LLM's check step. Exit 1 if any check fails. */
async function cmdHealth(ctx: CellsContext): Promise<void> {
  const { config, declarations, ownership } = ctx;
  const codeFiles = listCodeFiles();
  warnIfNoCodeFiles(config, codeFiles);

  const { edges, uncoveredExts } = await collectImportEdges();
  const crossings = deriveCrossings(edges, ownership);

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
  const { report, gateOk } = formatHealthReport({
    cellCount: cellNames.length,
    fileCount: codeFiles.length,
    crossingCount: crossings.length,
    violationCount: violations.length,
    violationDetails: violations.map((v) => `${v.kind} — ${v.detail}`),
    undeclaredCount: leakage.filter((l) => l.kind === 'undeclared').length,
    staleCount: stale.length,
    staleEdges: stale.map((s) => `${s.fromCell} → ${s.toCell}`),
    cycleCount: cycles.length,
    dirViolationCount: dirViolations.length,
    maxPercent,
    uncoveredExts,
  });

  process.stdout.write(report);
  if (!gateOk) process.exit(1);
}



/** `cells plan` — scan code-dirs and propose a partition: group files by parent
 *  directory, print suggested .cell.toml declarations + ownership.toml to stdout.
 *  The LLM reviews and curates — no files are written. */
function cmdPlan(): void {
  const config = loadConfig();
  const codeFiles = listCodeFiles();
  warnIfNoCodeFiles(config, codeFiles);
  const groups: Record<string, string[]> = {};
  for (const f of codeFiles) {
    const dir = basename(dirname(f)) || 'root';
    if (!(dir in groups)) groups[dir] = [];
    groups[dir].push(f);
  }

  console.log('# Proposed cell declarations (.cells/*.cell.toml files)');
  console.log('# Review and curate, then create them.');
  console.log('');
  for (const [name] of Object.entries(groups).sort()) {
    console.log(`## ${name}`);
    console.log(`name = "${name}"`);
    console.log(`purpose = "${STUB_PURPOSE}"`);
    console.log('provides = []');
    console.log('requires = []');
    console.log('');
  }

  console.log('# Proposed ownership (.cells/ownership.toml)');
  console.log('# Review and curate, then write to .cells/ownership.toml.');
  console.log('');
  for (const [name, files] of Object.entries(groups).sort()) {
    console.log(`[${name}]`);
    console.log(`files = [${files.map((f) => `"${f}"`).join(', ')}]`);
    console.log('');
  }
}

interface Command {
  readonly usage: string;
  readonly minArgs: number;
  readonly needsCells: boolean;
  readonly run: (args: string[], dryRun: boolean, ctx?: CellsContext) => void | Promise<void>;
}

const USAGE =
  'usage: cells {help | init | rename <old> <new> | remove <cell> [--force] | assign [--dry-run] <cell> <file...> | unassign [--dry-run] <file...> | owns <file> | payload <name> | health | crossings [--diff] | plan | list | size | structure | graph [--mermaid] | show <name> | impact <name>}';

/** Declarative command dispatch — add a command by adding one row, not a case. */
const COMMANDS: Record<string, Command> = {
  payload: { usage: 'cells payload <name>', minArgs: 1, needsCells: true, run: (a, _d, ctx) => cmdPayload(ctx!, a[0]) },
  validate: {
    usage: 'cells validate',
    minArgs: 0,
    needsCells: true,
    run: async (_a, _d, ctx) => {
      console.log('Note: `cells validate` is now `cells health` (the full gate). Running it.');
      await cmdHealth(ctx!);
    },
  },
  crossings: { usage: 'cells crossings [--diff]', minArgs: 0, needsCells: true, run: (a, _d, ctx) => cmdCrossings(ctx!, a.includes('--diff')) },
  list: { usage: 'cells list', minArgs: 0, needsCells: true, run: (_a, _d, ctx) => cmdList(ctx!) },
  size: { usage: 'cells size', minArgs: 0, needsCells: true, run: (_a, _d, ctx) => cmdSize(ctx!) },
  structure: { usage: 'cells structure', minArgs: 0, needsCells: true, run: (_a, _d, ctx) => cmdStructure(ctx!) },
  graph: { usage: 'cells graph [--mermaid]', minArgs: 0, needsCells: true, run: (a, _d, ctx) => cmdGraph(ctx!, a.includes('--mermaid')) },
  owns: { usage: 'cells owns <file>', minArgs: 1, needsCells: true, run: (a, _d, ctx) => cmdOwns(ctx!, a[0]) },
  show: { usage: 'cells show <name> [--verbose]', minArgs: 1, needsCells: true, run: (a, _d, ctx) => cmdShow(ctx!, a.filter((x) => !x.startsWith('--'))[0]!, a.includes('--verbose')) },
  impact: { usage: 'cells impact <name>', minArgs: 1, needsCells: true, run: (a, _d, ctx) => cmdImpact(ctx!, a[0]) },
  init: {
    usage: 'cells init [--dry-run]',
    minArgs: 0,
    needsCells: false,
    run: (_a, dryRun) => cmdInit(dryRun),
  },
  rename: { usage: 'cells rename <old> <new>', minArgs: 2, needsCells: true, run: (a) => cmdRename(a[0], a[1]) },
  remove: { usage: 'cells remove <cell> [--force]', minArgs: 1, needsCells: true, run: (a) => cmdRemove(a[0], a.includes('--force')) },
  assign: {
    usage: 'cells assign [--dry-run] <cell> <file...>',
    minArgs: 2,
    needsCells: true,
    run: (a, dryRun) => cmdAssign(a[0], a.slice(1), dryRun),
  },
  unassign: {
    usage: 'cells unassign [--dry-run] <file...>',
    minArgs: 1,
    needsCells: true,
    run: (a, dryRun) => cmdUnassign(a, dryRun),
  },
  health: { usage: 'cells health', minArgs: 0, needsCells: true, run: (_a, _d, ctx) => cmdHealth(ctx!) },
  plan: { usage: 'cells plan', minArgs: 0, needsCells: false, run: () => cmdPlan() },
};

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(`cells ${readVersion()}\n`);
    return;
  }

  const command = COMMANDS[cmd];
  if (!command) {
    console.error(USAGE);
    process.exit(1);
  }
  if (command.needsCells) requireCells();
  // --dry-run is a pure boolean flag (never takes a value) — strip it before the arg-count
  // gate so `assign cell --dry-run` counts 1 positional (cell), not 2 raw args. The gate
  // counts only non-flag args, but commands still receive the full array (they read their
  // own flags like --diff/--force/--mermaid/--verbose from it via .includes()).
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((a) => a !== '--dry-run');
  const realArgs = positional.filter((a) => !a.startsWith('--')).length;
  if (realArgs < command.minArgs) {
    console.error(`usage: ${command.usage}`);
    process.exit(1);
  }
  // Load the three stores once per cells-command; read commands consume the bundle via
  // their dispatch closures (ctx! — guaranteed present for needsCells:true). Mutation
  // commands ignore it and re-load fresh — they write after reading, so a shared bundle
  // would go stale. For needsCells:false commands (init/plan) there is no store; ctx is
  // undefined and those closures never touch it.
  const ctx = command.needsCells ? loadContext() : undefined;
  await command.run(positional, dryRun, ctx);
}

main().catch((err) => {
  console.error(`cells: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
