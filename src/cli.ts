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
import { formatCellList, formatCellShow, formatSizeReport } from './view.js';
import { formatCellGraph, formatCellGraphAscii } from './graph.js';
import { unassignFiles, planAssignment, validCellName } from './assign.js';
import { CELLS_DIR, loadDeclarations, loadOwnership, listCodeFiles, loadConfig, computePayloadSize, neighborsOf, readFiles, requireCells } from './io.js';
import { crossingsDelta } from './diff.js';
import { collectImportEdges } from './importers.js';
import { DEFAULT_CONFIG } from './config.js';
import { detectCycles, checkDirection, formatStructureReport, formatLayerOverview, inferLayers, formatLayerSuggestions, computeImpact, formatImpactReport } from './structure.js';
import { HELP } from './help.js';

/** Warn (stderr) when census files exist that no importer handles — the
 * crossings-derived output may be BLIND. Goes to stderr so machine output (stdout) stays clean. */
function warnIfBlind(uncoveredExts: string[]): void {
  if (uncoveredExts.length > 0) {
    console.error(`⚠ no importer for ${uncoveredExts.join(', ')} — crossings/impact/structure/graph are BLIND (unverified). Partition/size/validate are unaffected.`);
  }
}

/** `cells crossings [--diff]` — real cross-cell imports + leakage; `--diff` shows what your
 *  uncommitted edits added/removed (working tree vs HEAD). */
async function cmdCrossings(diff = false): Promise<void> {
  const ownership = loadOwnership();
  const declarations = loadDeclarations();
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
async function cmdList(): Promise<void> {
  const declarations = loadDeclarations();
  const ownership = loadOwnership();
  const sizes: Record<string, CellSize> = {};
  for (const name of Object.keys(declarations)) {
    const cell = declarations[name];
    sizes[name] = computePayloadSize(cell, ownership[name] ?? [], neighborsOf(cell, declarations));
  }
  const { edges, uncoveredExts } = await collectImportEdges();
  warnIfBlind(uncoveredExts);
  const crossings = deriveCrossings(edges, ownership);
  const metrics = computeMetrics(crossings, Object.keys(declarations));
  const owned = new Set(Object.values(ownership).flat());
  const orphanFiles = listCodeFiles().filter((f) => !owned.has(f));
  process.stdout.write(formatCellList(declarations, ownership, sizes, metrics, orphanFiles));
}

/** `cells show <name>` — one cell's detail with its in/out crossings. */
async function cmdShow(name: string): Promise<void> {
  const declarations = loadDeclarations();
  const ownership = loadOwnership();
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
  process.stdout.write(formatCellShow(cell, ownedFiles, out, inc, computePayloadSize(cell, ownedFiles, neighborsOf(cell, declarations)), metrics[name]));
}

/** `cells size` — context-fit warning: payloads vs the configured ceiling. Non-blocking (exit 0). */
function cmdSize(): void {
  const config = loadConfig();
  const declarations = loadDeclarations();
  const ownership = loadOwnership();
  const entries = Object.keys(declarations).map((name) => {
    const cell = declarations[name];
    return { name, size: computePayloadSize(cell, ownership[name] ?? [], neighborsOf(cell, declarations)) };
  });
  process.stdout.write(formatSizeReport(entries, config.maxPayloadTokens));
}

/** `cells structure` — governance: ADP (cycles) + Direction (layering). Warnings only (exit 0). */
async function cmdStructure(): Promise<void> {
  const declarations = loadDeclarations();
  const ownership = loadOwnership();
  const config = loadConfig();
  const { edges, uncoveredExts } = await collectImportEdges();
  warnIfBlind(uncoveredExts);
  const crossings = deriveCrossings(edges, ownership);
  const cycles = detectCycles(crossings);
  const violations = checkDirection(crossings, declarations);
  const anyLayered = Object.values(declarations).some((d) => d.layer !== undefined);
  const report = formatStructureReport(cycles, violations, anyLayered, config.layers);
  const overview = formatLayerOverview(declarations, config.layers);
  process.stdout.write(overview ? `${overview}\n${report}` : report);

  const inferred = inferLayers(declarations);
  if (inferred !== null) {
    const suggestions = formatLayerSuggestions(declarations, inferred);
    if (suggestions !== null) process.stdout.write(`\n${suggestions}`);
  }
}

/** `cells impact <name>` — blast radius: who transitively depends on this cell? */
async function cmdImpact(name: string): Promise<void> {
  const declarations = loadDeclarations();
  if (!declarations[name]) {
    console.error(`error: no cell named "${name}"`);
    process.exit(1);
  }
  const { edges, uncoveredExts } = await collectImportEdges();
  warnIfBlind(uncoveredExts);
  const crossings = deriveCrossings(edges, loadOwnership());
  process.stdout.write(formatImpactReport(computeImpact(crossings, name)));
}

/** `cells graph [--mermaid]` — render the cell graph (ASCII tree default; --mermaid for source). */
async function cmdGraph(mermaid: boolean): Promise<void> {
  const ownership = loadOwnership();
  const { edges, uncoveredExts } = await collectImportEdges();
  warnIfBlind(uncoveredExts);
  const crossings = deriveCrossings(edges, ownership);
  process.stdout.write(mermaid ? formatCellGraph(crossings) : formatCellGraphAscii(crossings));
}

/** `cells owns <file>` — which cell owns this file? (terse: name + purpose; orphan if unowned) */
function cmdOwns(file: string): void {
  const ownership = loadOwnership();
  const declarations = loadDeclarations();
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
    writeFileSync(cfgPath, DEFAULT_CONFIG);
    created.push('config.toml');
  }
  if (created.length === 0) {
    console.log(`${CELLS_DIR}/ already initialized — nothing to do.`);
    return;
  }
  console.log(`Initialized ${CELLS_DIR}/: created ${created.join(' + ')}.`);
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
  // planAssignment validates the name (throws → main().catch surfaces it), decides the stub, computes ownership.
  const { stub, ownership } = planAssignment(loadOwnership(), cell, files, existsSync(declPath));
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
function cmdPayload(name: string): void {
  const decls = loadDeclarations();
  const ownership = loadOwnership();
  const cell = decls[name];
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
    const neighbor = decls[n];
    if (neighbor) neighbors.push(neighbor);
    else console.error(`warning: neighbor "${n}" of cell "${name}" has no declaration`);
  }

  const dependedByCount = Object.values(decls).filter((d) => d.requires.includes(name)).length;
  const payload = assemblePayload(cell, ownedFiles, fileContents, neighbors, dependedByCount, testFiles, testContents);
  process.stdout.write(payload);

  const chars = payload.length;
  console.error(`\n[size: ${chars} chars, ~${Math.ceil(chars / 3)} tokens]`);
}

/** `cells health` — all four checks at once (validate + crossings + structure + size).
 *  One command instead of four for the LLM's check step. Exit 1 if any check fails. */
async function cmdHealth(): Promise<void> {
  const config = loadConfig();
  const declarations = loadDeclarations();
  const ownership = loadOwnership();
  const codeFiles = listCodeFiles();

  const { edges, uncoveredExts } = await collectImportEdges();
  const crossings = deriveCrossings(edges, ownership);

  const violations = validatePartition(ownership, declarations, codeFiles);
  const undeclared = checkLeakage(crossings, declarations);
  const cycles = detectCycles(crossings);
  const dirViolations = checkDirection(crossings, declarations);

  const cellNames = Object.keys(declarations);
  let maxPercent = 0;
  for (const name of cellNames) {
    const cell = declarations[name];
    const size = computePayloadSize(cell, ownership[name] ?? [], neighborsOf(cell, declarations));
    const pct = size.tokens / config.maxPayloadTokens;
    if (pct > maxPercent) maxPercent = pct;
  }

  const valOk = violations.length === 0;
  const xOk = undeclared.length === 0;
  const structOk = cycles.length === 0 && dirViolations.length === 0;
  const sizeOk = maxPercent <= 1;
  const allOk = valOk && xOk && structOk && sizeOk;

  const structParts: string[] = [];
  if (cycles.length > 0) structParts.push(`${cycles.length} cycle(s)`);
  if (dirViolations.length > 0) structParts.push(`${dirViolations.length} direction`);
  const structLabel = structParts.length > 0 ? structParts.join(', ') : 'acyclic, direction OK';

  process.stdout.write(
    `  ${valOk ? '✓' : '✗'} validate  ${valOk ? `     (${cellNames.length} cells, ${codeFiles.length} files)` : `     (${violations.length} violations)`}\n` +
      `  ${xOk ? '✓' : '✗'} crossings ${xOk ? `    (${crossings.length} edges)` : `    (${crossings.length} edges, ${undeclared.length} undeclared)`}\n` +
      `  ${structOk ? '✓' : '✗'} structure ${structOk ? '   ' : '  '} (${structLabel})\n` +
      `  ${sizeOk ? '✓' : '✗'} size      ${sizeOk ? `    (max ${Math.round(maxPercent * 100)}% of ceiling)` : `    (max ${Math.round(maxPercent * 100)}% — over ceiling)`}\n`,
  );
  if (uncoveredExts.length > 0) {
    process.stdout.write(`  — coverage    (${uncoveredExts.length} blind ext(s): ${uncoveredExts.join(', ')})\n`);
  }

  process.stdout.write('\n');
  if (!valOk) {
    for (const v of violations) process.stdout.write(`  validate: ${v.kind} — ${v.detail}\n`);
  }
  if (allOk) {
    process.stdout.write('→ All checks passed.\n');
  } else {
    const drill: string[] = [];
    if (!xOk) drill.push('crossings');
    if (!structOk) drill.push('structure');
    const drillHint = drill.length > 0 ? ` Run \`cells ${drill.join('` / `cells ')}\` for details.` : '';
    process.stdout.write(`→ Some checks failed.${drillHint}\n`);
    process.exit(1);
  }
}

/** `cells plan` — scan code-dirs and propose a partition: group files by parent
 *  directory, print suggested .cell.toml declarations + ownership.toml to stdout.
 *  The LLM reviews and curates — no files are written. */
function cmdPlan(): void {
  const codeFiles = listCodeFiles();
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
  readonly run: (args: string[], dryRun: boolean) => void | Promise<void>;
}

const USAGE =
  'usage: cells {help | init | rename <old> <new> | remove <cell> [--force] | assign [--dry-run] <cell> <file...> | unassign [--dry-run] <file...> | owns <file> | payload <name> | health | crossings [--diff] | plan | list | size | structure | graph [--mermaid] | show <name> | impact <name>}';

/** Declarative command dispatch — add a command by adding one row, not a case. */
const COMMANDS: Record<string, Command> = {
  payload: { usage: 'cells payload <name>', minArgs: 1, needsCells: true, run: (a) => cmdPayload(a[0]) },
  validate: {
    usage: 'cells validate',
    minArgs: 0,
    needsCells: true,
    run: async () => {
      console.log('Note: `cells validate` is now `cells health` (the full gate). Running it.');
      await cmdHealth();
    },
  },
  crossings: { usage: 'cells crossings [--diff]', minArgs: 0, needsCells: true, run: (a) => cmdCrossings(a.includes('--diff')) },
  list: { usage: 'cells list', minArgs: 0, needsCells: true, run: () => cmdList() },
  size: { usage: 'cells size', minArgs: 0, needsCells: true, run: () => cmdSize() },
  structure: { usage: 'cells structure', minArgs: 0, needsCells: true, run: () => cmdStructure() },
  graph: { usage: 'cells graph [--mermaid]', minArgs: 0, needsCells: true, run: (a) => cmdGraph(a.includes('--mermaid')) },
  owns: { usage: 'cells owns <file>', minArgs: 1, needsCells: true, run: (a) => cmdOwns(a[0]) },
  show: { usage: 'cells show <name>', minArgs: 1, needsCells: true, run: (a) => cmdShow(a[0]) },
  impact: { usage: 'cells impact <name>', minArgs: 1, needsCells: true, run: (a) => cmdImpact(a[0]) },
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
  health: { usage: 'cells health', minArgs: 0, needsCells: true, run: () => cmdHealth() },
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
  // gate so `assign cell --dry-run` counts 1 positional (cell), not 2 raw args.
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((a) => a !== '--dry-run');
  if (positional.length < command.minArgs) {
    console.error(`usage: ${command.usage}`);
    process.exit(1);
  }
  await command.run(positional, dryRun);
}

main().catch((err) => {
  console.error(`cells: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
