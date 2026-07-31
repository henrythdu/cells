#!/usr/bin/env node
/** CLI entry + mutation commands. Read/analysis handlers live in commands.ts (this file
 *  stays a thin dispatcher: argv → COMMANDS row → handler; state-writes live here). */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeCell, STUB_PURPOSE, type Cell } from './declaration.js';
import { serializeOwnership } from './ownership.js';
import { checkLeakage } from './crossings.js';
import { unassignFiles, planAssignment, planGroups, validCellName } from './assign.js';
import { CELLS_DIR, loadDeclarations, loadOwnership, loadConfig, listCodeFiles, loadContext, requireCells, detectProject, computePayloadSize, neighborsOf, type CellsContext } from './io.js';
import { buildConfig } from './config.js';
import { cmdCrossings, cmdList, cmdShow, cmdSize, cmdStructure, cmdImpact, cmdGraph, cmdOwns, cmdPayload, cmdHealth, loadCrossings, warnIfNoCodeFiles } from './commands.js';
import { HELP } from './help.js';

/** Installed version, read lazily from package.json (works in dev + when npm-installed). */
function readVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
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

/** `cells new <name> [--purpose ...] [--provides a,b] [--requires a,b] [--layer N]` — scaffold a
 *  .cell.toml declaration. Declare-first flow: `cells new` writes the contract, then `cells assign`
 *  moves files in (assign also stubs on demand — new is for declaring the contract up front). */
function cmdNew(args: string[]): void {
  // Name must be the first token — flag VALUES are not positions: `cells new --layer 2 db`
  // must not silently create a cell named "2".
  if (args[0] === undefined || args[0].startsWith('--')) {
    console.error('usage: cells new <name> [--purpose "..."] [--provides a,b] [--requires a,b] [--layer N]');
    process.exit(1);
  }
  const name = args[0];
  if (!validCellName(name)) {
    console.error(`cells: invalid cell name "${name}" — use only letters, numbers, dashes, underscores.`);
    process.exit(1);
  }

  const flags: Record<string, string | undefined> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const val = args[i + 1];
    flags[a] = val !== undefined && !val.startsWith('--') ? val : undefined;
  }
  const declPath = join(CELLS_DIR, `${name}.cell.toml`);
  if (existsSync(declPath)) {
    console.error(`cells: cell "${name}" already exists (${declPath}) — use assign or rename instead.`);
    process.exit(1);
  }
  const split = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const cell: Cell = {
    name,
    purpose: flags['--purpose'] ?? STUB_PURPOSE,
    provides: split(flags['--provides']),
    requires: split(flags['--requires']),
  };
  const layer = flags['--layer'];
  if (layer !== undefined) {
    // strict decimal — Number() alone would accept '', '0x10', '1e3'
    if (!/^\d+$/.test(layer)) {
      console.error(`cells: --layer must be a non-negative integer, got "${layer}".`);
      process.exit(1);
    }
    cell.layer = Number(layer);
  }
  writeFileSync(declPath, serializeCell(cell));
  console.log(`Created cell "${name}" (${declPath}).`);
  console.log(`Next: \`cells assign ${name} <file...>\` then \`cells health\`.`);
  if (cell.purpose === STUB_PURPOSE) console.log(`Note: purpose is a stub — edit ${declPath} to describe the cell.`);
}

/** `cells prune-stale [--apply]` — remove requires that are declared but never imported (stale).
 *  Dry-run by default: prints what would change, touches nothing. --apply rewrites the .cell.toml files.
 *  Stale stays info-level in health ("maybe a data dependency or future plan") — this command is the
 *  explicit opt-in cleanup; the agent decides, the tool applies. */
async function cmdPruneStale(apply: boolean): Promise<void> {
  const ownership = loadOwnership();
  const { crossings } = await loadCrossings(ownership, false);
  const declarations = loadDeclarations();
  const stale = checkLeakage(crossings, declarations).filter((l) => l.kind === 'stale');
  if (stale.length === 0) {
    console.log('No stale requires — every declared requirement is imported.');
    return;
  }
  const byCell = new Map<string, string[]>();
  for (const s of stale) {
    const list = byCell.get(s.fromCell) ?? [];
    list.push(s.toCell);
    byCell.set(s.fromCell, list);
  }
  const lines = [`${stale.length} stale require(s) — declared but no import found:`];
  for (const [cell, reqs] of byCell) lines.push(`  ${cell} → ${reqs.join(', ')}`);
  if (!apply) {
    lines.push('Dry run — nothing changed. Re-run with --apply to remove them.');
    console.log(lines.join('\n'));
    return;
  }
  for (const [cellName, reqs] of byCell) {
    const decl = declarations[cellName];
    decl.requires = decl.requires.filter((r) => !reqs.includes(r));
    writeFileSync(join(CELLS_DIR, `${cellName}.cell.toml`), serializeCell(decl));
  }
  lines.push(`Removed from ${byCell.size} cell declaration(s). Run \`cells health\` to confirm.`);
  console.log(lines.join('\n'));
}

/** `cells plan` — scan code-dirs and propose a partition: group files into cells
 *  (crate/package-aware via planGroups — a monorepo's crates/packages collapse to one
 *  cell each instead of every subdir exploding; invalid-name dirs fold to a valid
 *  ancestor), print suggested .cell.toml declarations + ownership.toml to stdout.
 *  The LLM reviews and curates — no files are written. */
function cmdPlan(): void {
  const config = loadConfig();
  const codeFiles = listCodeFiles();
  warnIfNoCodeFiles(config, codeFiles);
  const groups = planGroups(codeFiles);
  const keys = [...groups.keys()].sort();
  // name = key path escaped to a valid cell name: '-' → '--', separator → '-'
  // (injective: 'src/api' and 'src-api' can't collide; planGroups pre-folds invalid chars)
  const names = new Map(keys.map((k) => [k, k.replaceAll('-', '--').replaceAll('/', '-')]));

  console.log('# Proposed cell declarations (.cells/*.cell.toml files)');
  console.log('# Review and curate, then create them.');
  console.log('');
  for (const key of keys) {
    console.log(`## ${names.get(key)}`);
    console.log(`name = "${names.get(key)}"`);
    console.log(`purpose = "${STUB_PURPOSE}"`);
    console.log('provides = []');
    console.log('requires = []');
    console.log('');
  }

  console.log('# Proposed ownership (.cells/ownership.toml)');
  console.log('# Review and curate, then write to .cells/ownership.toml.');
  console.log('');
  for (const key of keys) {
    console.log(`[${names.get(key)}]`);
    console.log(`files = [${groups.get(key)!.map((f) => `"${f}"`).join(', ')}]`);
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
  'usage: cells {help | init | rename <old> <new> | remove <cell> [--force] | new <name> [--purpose ...] [--provides a,b] [--requires a,b] [--layer N] | prune-stale [--apply] | assign [--dry-run] <cell> <file...> | unassign [--dry-run] <file...> | owns <file> | payload <name> | health [--verbose] | crossings [--diff] [--verbose] [--json] | plan | list | size | structure | graph [--mermaid] | show <name> | impact <name>}';

/** Declarative command dispatch — add a command by adding one row, not a case. */
const COMMANDS: Record<string, Command> = {
  payload: { usage: 'cells payload <name>', minArgs: 1, needsCells: true, run: (a, _d, ctx) => cmdPayload(ctx!, a[0]) },
  validate: {
    usage: 'cells validate',
    minArgs: 0,
    needsCells: true,
    run: async (_a, _d, ctx) => {
      console.error('Note: `cells validate` is now `cells health` (the full gate). Running it.'); // stderr — stdout stays machine-clean
      await cmdHealth(ctx!);
    },
  },
  crossings: { usage: 'cells crossings [--diff] [--verbose] [--json]', minArgs: 0, needsCells: true, run: (a, _d, ctx) => cmdCrossings(ctx!, { diff: a.includes('--diff'), verbose: a.includes('--verbose'), json: a.includes('--json') }) },
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
  health: { usage: 'cells health [--verbose]', minArgs: 0, needsCells: true, run: (a, _d, ctx) => cmdHealth(ctx!, a.includes('--verbose')) },
  new: {
    usage: 'cells new <name> [--purpose "..."] [--provides a,b] [--requires a,b] [--layer N]',
    minArgs: 1,
    needsCells: true,
    run: (a) => cmdNew(a),
  },
  'prune-stale': { usage: 'cells prune-stale [--apply]', minArgs: 0, needsCells: true, run: (a) => cmdPruneStale(a.includes('--apply')) },
  plan: { usage: 'cells plan', minArgs: 0, needsCells: false, run: () => cmdPlan() },
};

async function main(): Promise<void> {
  // `cells X | head` closes the pipe early. Ignore EPIPE (the command's natural exit code still
  // stands — no false-green from exiting 0 here); re-raise everything else (ENOSPC/EIO) so real
  // stdout failures stay loud instead of being marked handled by this listener.
  process.stdout.on('error', (e) => {
    if ((e as NodeJS.ErrnoException).code === 'EPIPE') return;
    throw e;
  });
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
  // `cells <cmd> --help` must answer help, not run the command (minArgs:0 commands
  // like plan/size would otherwise execute with --help silently ignored).
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`usage: ${command.usage}\n`);
    return;
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
