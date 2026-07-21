#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cruise, type ICruiseResult } from 'dependency-cruiser';
import { parseCell, serializeCell, type Cell } from './declaration.js';
import { parseOwnership, serializeOwnership, type Ownership } from './ownership.js';
import { assemblePayload } from './payload.js';
import { validatePartition } from './validate.js';
import { deriveCrossings, checkLeakage, type ImportEdge } from './crossings.js';
import { formatCellList, formatCellShow, formatSizeReport, type CellSize } from './view.js';
import { assignFiles } from './assign.js';
import { parseConfig, DEFAULT_MAX_PAYLOAD_TOKENS, type CellsConfig } from './config.js';

const CELLS_DIR = '.cells';

/** Load every `.cell.toml` declaration in `.cells/`, keyed by cell name. */
function loadDeclarations(): Record<string, Cell> {
  const decls: Record<string, Cell> = {};
  for (const file of readdirSync(CELLS_DIR)) {
    if (!file.endsWith('.cell.toml')) continue;
    const cell = parseCell(readFileSync(join(CELLS_DIR, file), 'utf8'));
    decls[cell.name] = cell;
  }
  return decls;
}

/** Load the ownership map from `.cells/ownership.toml`. */
function loadOwnership(): Ownership {
  return parseOwnership(readFileSync(join(CELLS_DIR, 'ownership.toml'), 'utf8'));
}

/** Recursively list `.ts` files under a directory (relative paths). */
function listTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return []; // a repo may lack src/ or test/ yet
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...listTsFiles(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** All code files on disk (src/ + test/). */
function listCodeFiles(): string[] {
  return [...listTsFiles('src'), ...listTsFiles('test')];
}

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

/** Collect raw import edges (file→file) from src/ + test/ via dependency-cruiser. */
async function collectImportEdges(): Promise<ImportEdge[]> {
  const { output } = await cruise(['src/', 'test/'], {
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
  });
  const result = output as ICruiseResult;
  const norm = (p: string): string => p.replace(/^\.\//, '');
  const edges: ImportEdge[] = [];
  for (const mod of result.modules ?? []) {
    for (const dep of mod.dependencies ?? []) {
      if (dep.couldNotResolve || dep.coreModule) continue; // external / node built-in
      if (!dep.resolved) continue;
      edges.push({
        fromFile: norm(mod.source),
        toFile: norm(dep.resolved),
        import: dep.module,
      });
    }
  }
  return edges;
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

/** Assemble a cell's payload and measure it — the context-fit metric (what the model consumes). */
function computePayloadSize(cell: Cell, ownedFiles: string[], neighbors: Cell[]): CellSize {
  const fileContents: Record<string, string> = {};
  for (const f of ownedFiles) {
    try {
      fileContents[f] = readFileSync(f, 'utf8');
    } catch {
      // missing file — validate flags it as dangling; size just skips
    }
  }
  const chars = assemblePayload(cell, ownedFiles, fileContents, neighbors).length;
  return { files: ownedFiles.length, chars, tokens: Math.ceil(chars / 4) };
}

/** Resolve a cell's neighbor declarations (for payload assembly). */
function neighborsOf(cell: Cell, declarations: Record<string, Cell>): Cell[] {
  return cell.requires.map((r) => declarations[r]).filter((c): c is Cell => Boolean(c));
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
  const orphanCount = listCodeFiles().filter((f) => !owned.has(f)).length;
  process.stdout.write(formatCellList(declarations, ownership, sizes, orphanCount));
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
  process.stdout.write(formatCellShow(cell, ownedFiles, out, inc, computePayloadSize(cell, ownedFiles, neighborsOf(cell, declarations))));
}

/** Load `.cells/config.toml` (optional — missing file → defaults). */
function loadConfig(): CellsConfig {
  const path = join(CELLS_DIR, 'config.toml');
  if (!existsSync(path)) return { maxPayloadTokens: DEFAULT_MAX_PAYLOAD_TOKENS };
  return parseConfig(readFileSync(path, 'utf8'));
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
  const fileContents: Record<string, string> = {};
  for (const f of ownedFiles) {
    fileContents[f] = readFileSync(f, 'utf8');
  }

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

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
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
      console.error('usage: cells {init | assign <cell> <file...> | payload <name> | validate | crossings | list | size | show <name>}');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
