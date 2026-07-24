#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Installed version, read lazily from package.json (works in dev + when npm-installed). */
function readVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
import { serializeCell, type Cell } from './declaration.js';
import { serializeOwnership, owningCell, type Ownership } from './ownership.js';
import { assemblePayload, type CellSize } from './payload.js';
import { validatePartition } from './validate.js';
import { deriveCrossings, checkLeakage, computeMetrics, diffCrossings, type CrossingsDelta } from './crossings.js';
import { formatCellList, formatCellShow, formatSizeReport } from './view.js';
import { formatCellGraph, formatCellGraphAscii } from './graph.js';
import { assignFiles, unassignFiles } from './assign.js';
import {
  CELLS_DIR,
  loadDeclarations,
  loadOwnership,
  listCodeFiles,
  loadConfig,
  computePayloadSize,
  neighborsOf,
  readFiles,
  requireCells,
  isGitRepo,
  withHeadTree,
} from './io.js';
import { collectImportEdges } from './importers.js';
import { detectCycles, checkDirection, formatStructureReport, formatLayerOverview, computeImpact, formatImpactReport } from './structure.js';
import { HELP } from './help.js';

/** `cells validate` — check partition integrity. */
function cmdValidate(): void {
  const declarations = loadDeclarations();
  const ownership = loadOwnership();
  const codeFiles = listCodeFiles();
  const violations = validatePartition(ownership, declarations, codeFiles);
  if (violations.length === 0) {
    console.log(`OK — valid partition. ${Object.keys(declarations).length} cells, ${codeFiles.length} code files.`);
    return;
  }
  for (const v of violations) {
    console.log(`${v.kind}: ${v.detail}`);
  }
  process.exit(1);
}

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
  if (diff) {
    if (!isGitRepo()) {
      console.error('⚠ --diff needs a git repo — showing current crossings instead.');
    } else {
      const delta = await computeCrossingsDelta(ownership);
      if (delta === null) console.error('⚠ no HEAD to diff against — showing current crossings instead.');
      else {
        showCrossingsDelta(delta);
        return;
      }
    }
  }
  const declarations = loadDeclarations();
  const { edges, uncoveredExts } = await collectImportEdges();
  warnIfBlind(uncoveredExts);
  const crossings = deriveCrossings(edges, ownership);
  const leakage = checkLeakage(crossings, declarations);

  if (crossings.length === 0) {
    console.log('No cross-cell imports.');
  } else {
    console.log(`Cross-cell imports (${crossings.length}):`);
    for (const c of crossings) {
      console.log(`  ${c.fromCell} → ${c.toCell}   (${c.fromFile} → ${c.toFile})`);
    }
  }

  if (leakage.length > 0) {
    console.error(`\nLeakage (${leakage.length}):`);
    for (const l of leakage) {
      console.error(`  [${l.kind}] ${l.detail}`);
    }
    process.exit(1);
  }
}

/** Derive the crossings delta (working tree vs HEAD); null if HEAD can't be read (no commits). */
async function computeCrossingsDelta(ownership: Ownership): Promise<CrossingsDelta | null> {
  const { edges: workEdges, uncoveredExts } = await collectImportEdges();
  warnIfBlind(uncoveredExts);
  const working = deriveCrossings(workEdges, ownership);
  return withHeadTree(async (headDir) => {
    const { edges: headEdges } = await collectImportEdges(headDir);
    return diffCrossings(working, deriveCrossings(headEdges, ownership));
  });
}

/** Render a crossings delta: +/− edges, then a summary. */
function showCrossingsDelta(delta: CrossingsDelta): void {
  if (delta.added.length === 0 && delta.removed.length === 0) {
    console.log('No crossing changes since HEAD.');
    return;
  }
  console.log('Crossings delta (working tree vs HEAD):');
  for (const c of delta.added) console.log(`  + ${c.fromCell} → ${c.toCell}   (${c.fromFile} → ${c.toFile})`);
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
  process.stdout.write(
    formatCellShow(cell, ownedFiles, out, inc, computePayloadSize(cell, ownedFiles, neighborsOf(cell, declarations)), metrics[name]),
  );
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

/** `cells init` — bootstrap a `.cells/` store (idempotent). */
function cmdInit(): void {
  mkdirSync(CELLS_DIR, { recursive: true });
  const ownPath = join(CELLS_DIR, 'ownership.toml');
  if (existsSync(ownPath)) {
    console.log(`${CELLS_DIR}/ already exists — nothing to do.`);
    return;
  }
  writeFileSync(ownPath, serializeOwnership({}));
  console.log(`Initialized ${CELLS_DIR}/ with an empty ownership.toml.`);
  console.log('Next: `cells assign <cell> <file...>` to start partitioning.');
}

/** `cells assign <cell> <file...>` — move files into a cell; stub its declaration if new. */
function cmdAssign(cell: string, files: string[]): void {
  const ownership = loadOwnership();
  const next = assignFiles(ownership, cell, files);
  writeFileSync(join(CELLS_DIR, 'ownership.toml'), serializeOwnership(next));
  const declPath = join(CELLS_DIR, `${cell}.cell.toml`);
  if (!existsSync(declPath)) {
    const stub: Cell = { name: cell, purpose: '(TODO: describe this cell)', provides: [], requires: [] };
    writeFileSync(declPath, serializeCell(stub));
    console.log(`Assigned ${files.length} file(s) to "${cell}" — created stub declaration.`);
    console.log(`Edit ${declPath} (purpose/provides/requires), then run \`cells validate\` / \`cells crossings\`.`);
  } else {
    console.log(`Assigned ${files.length} file(s) to "${cell}".`);
  }
}

/** `cells unassign <file...>` — remove files from their cell (→ orphan). */
function cmdUnassign(files: string[]): void {
  const ownership = loadOwnership();
  const ownedBefore = new Set(Object.values(ownership).flat());
  const removed = files.filter((f) => ownedBefore.has(f));
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

  const neighbors: Cell[] = [];
  for (const n of cell.requires) {
    const neighbor = decls[n];
    if (neighbor) neighbors.push(neighbor);
    else console.error(`warning: neighbor "${n}" of cell "${name}" has no declaration`);
  }

  const payload = assemblePayload(cell, ownedFiles, fileContents, neighbors);
  process.stdout.write(payload);

  const chars = payload.length;
  console.error(`\n[size: ${chars} chars, ~${Math.ceil(chars / 4)} tokens]`);
}

interface Command {
  readonly usage: string;
  readonly minArgs: number;
  readonly needsCells: boolean;
  readonly run: (args: string[]) => void | Promise<void>;
}

const USAGE = 'usage: cells {help | init | assign <cell> <file...> | unassign <file...> | owns <file> | payload <name> | validate | crossings [--diff] | list | size | structure | graph [--mermaid] | show <name> | impact <name>}';

/** Declarative command dispatch — add a command by adding one row, not a case. */
const COMMANDS: Record<string, Command> = {
  payload:   { usage: 'cells payload <name>',          minArgs: 1, needsCells: true,  run: (a) => cmdPayload(a[0]) },
  validate:  { usage: 'cells validate',                minArgs: 0, needsCells: true,  run: () => cmdValidate() },
  crossings: { usage: 'cells crossings [--diff]',      minArgs: 0, needsCells: true,  run: (a) => cmdCrossings(a.includes('--diff')) },
  list:      { usage: 'cells list',                    minArgs: 0, needsCells: true,  run: () => cmdList() },
  size:      { usage: 'cells size',                    minArgs: 0, needsCells: true,  run: () => cmdSize() },
  structure: { usage: 'cells structure',               minArgs: 0, needsCells: true,  run: () => cmdStructure() },
  graph:     { usage: 'cells graph [--mermaid]',       minArgs: 0, needsCells: true,  run: (a) => cmdGraph(a.includes('--mermaid')) },
  owns:      { usage: 'cells owns <file>',             minArgs: 1, needsCells: true,  run: (a) => cmdOwns(a[0]) },
  show:      { usage: 'cells show <name>',             minArgs: 1, needsCells: true,  run: (a) => cmdShow(a[0]) },
  impact:    { usage: 'cells impact <name>',         minArgs: 1, needsCells: true,  run: (a) => cmdImpact(a[0]) },
  init:      { usage: 'cells init',                    minArgs: 0, needsCells: false, run: () => cmdInit() },
  assign:    { usage: 'cells assign <cell> <file...>', minArgs: 2, needsCells: true,  run: (a) => cmdAssign(a[0], a.slice(1)) },
  unassign:  { usage: 'cells unassign <file...>',     minArgs: 1, needsCells: true,  run: (a) => cmdUnassign(a) },
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
  if (args.length < command.minArgs) {
    console.error(`usage: ${command.usage}`);
    process.exit(1);
  }
  await command.run(args);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
