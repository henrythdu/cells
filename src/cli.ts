#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serializeCell, type Cell } from './declaration.js';
import { serializeOwnership, owningCell } from './ownership.js';
import { assemblePayload } from './payload.js';
import { validatePartition } from './validate.js';
import { deriveCrossings, checkLeakage } from './crossings.js';
import { formatCellList, formatCellShow, formatSizeReport, formatCellGraph, formatCellGraphAscii, type CellSize } from './view.js';
import { assignFiles } from './assign.js';
import {
  CELLS_DIR,
  loadDeclarations,
  loadOwnership,
  listCodeFiles,
  loadConfig,
  collectImportEdges,
  computePayloadSize,
  neighborsOf,
  readFiles,
  requireCells,
} from './io.js';
import { detectCycles, checkDirection, formatStructureReport } from './structure.js';
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

/** `cells crossings` — derive real cross-cell imports and check for leakage. */
async function cmdCrossings(): Promise<void> {
  const ownership = loadOwnership();
  const declarations = loadDeclarations();
  const edges = await collectImportEdges();
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

/** `cells list` — partition overview: each cell's files/size/requires + orphans. */
function cmdList(): void {
  const declarations = loadDeclarations();
  const ownership = loadOwnership();
  const sizes: Record<string, CellSize> = {};
  for (const name of Object.keys(declarations)) {
    const cell = declarations[name];
    sizes[name] = computePayloadSize(cell, ownership[name] ?? [], neighborsOf(cell, declarations));
  }
  const owned = new Set(Object.values(ownership).flat());
  const orphanFiles = listCodeFiles().filter((f) => !owned.has(f));
  process.stdout.write(formatCellList(declarations, ownership, sizes, orphanFiles));
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
  const crossings = deriveCrossings(await collectImportEdges(), ownership);
  const out = crossings.filter((c) => c.fromCell === name);
  const inc = crossings.filter((c) => c.toCell === name);
  process.stdout.write(
    formatCellShow(cell, ownedFiles, out, inc, computePayloadSize(cell, ownedFiles, neighborsOf(cell, declarations))),
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
  const crossings = deriveCrossings(await collectImportEdges(), ownership);
  const cycles = detectCycles(crossings);
  const violations = checkDirection(crossings, declarations, config.layers);
  process.stdout.write(formatStructureReport(cycles, violations, config.layers.length > 0));
}

/** `cells graph [--mermaid]` — render the cell graph (ASCII tree default; --mermaid for source). */
async function cmdGraph(mermaid: boolean): Promise<void> {
  const ownership = loadOwnership();
  const crossings = deriveCrossings(await collectImportEdges(), ownership);
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

const NEEDS_CELLS = new Set(['assign', 'validate', 'crossings', 'list', 'size', 'structure', 'graph', 'owns', 'show', 'payload']);

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (NEEDS_CELLS.has(cmd)) requireCells();
  switch (cmd) {
    case 'payload':
      if (!args[0]) {
        console.error('usage: cells payload <name>');
        process.exit(1);
      }
      cmdPayload(args[0]);
      break;
    case 'validate':
      cmdValidate();
      break;
    case 'crossings':
      await cmdCrossings();
      break;
    case 'list':
      cmdList();
      break;
    case 'size':
      cmdSize();
      break;
    case 'structure':
      await cmdStructure();
      break;
    case 'graph':
      await cmdGraph(args.includes('--mermaid'));
      break;
    case 'owns':
      if (!args[0]) {
        console.error('usage: cells owns <file>');
        process.exit(1);
      }
      cmdOwns(args[0]);
      break;
    case 'show':
      if (!args[0]) {
        console.error('usage: cells show <name>');
        process.exit(1);
      }
      await cmdShow(args[0]);
      break;
    case 'init':
      cmdInit();
      break;
    case 'assign':
      if (args.length < 2) {
        console.error('usage: cells assign <cell> <file...>');
        process.exit(1);
      }
      cmdAssign(args[0], args.slice(1));
      break;
    default:
      console.error('usage: cells {help | init | assign <cell> <file...> | owns <file> | payload <name> | validate | crossings | list | size | structure | graph [--mermaid] | show <name>}');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
