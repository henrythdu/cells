#!/usr/bin/env node
/** CLI entry: dispatch commands; wire the io layer + logic cells to argv.
 *  Read/analysis handlers live in commands/ (read.ts + gate.ts); mutation command
 *  bodies live in mutate.ts. This file stays a thin dispatcher: argv → COMMANDS row →
 *  handler, plus the arg-count/--dry-run/--help gates and EPIPE handling. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmdCrossings, cmdGraph, cmdList, cmdOwns, cmdPayload, cmdShow, cmdSurface } from './commands/read.js';
import { cmdHealth, cmdImpact, cmdSize, cmdStructure } from './gate.js';
import { renderHelp } from './help.js';
import { type CellsContext, loadContext, requireCells } from './io.js';
import { cmdAssign, cmdConfig, cmdInit, cmdNew, cmdPlan, cmdPruneStale, cmdRemove, cmdRename, cmdUnassign } from './mutate.js';
import { cmdImports } from './pipeline.js';

/** Installed version, read lazily from package.json (works in dev + when npm-installed). */
function readVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

interface Command {
  readonly usage: string;
  readonly desc: string;
  readonly minArgs: number;
  readonly needsCells: boolean;
  readonly run: (args: string[], dryRun: boolean, ctx?: CellsContext) => void | Promise<void>;
}

// One line per command. `usage` is the single source of truth: the error line
// ("usage: cells …"), the dispatch help ("cells <cmd> --help"), and the
// COMMANDS block in `cells help` are all derived from it (see renderHelp).
const COMMANDS: Record<string, Command> = {
  payload: { usage: 'cells payload <name>', desc: "print a cell's full payload (the context to work it)", minArgs: 1, needsCells: true, run: (a, _d, ctx) => cmdPayload(ctx!, a[0]) },
  crossings: {
    usage: 'cells crossings [--diff] [--verbose] [--json] [--warnings]',
    desc: 'cross-cell imports + leakage; cell-pair summary by default; --verbose = every file edge; --diff = +/- from your edits; --warnings = leakage + unresolved only (no listing); --json = machine-readable edges',
    minArgs: 0,
    needsCells: true,
    run: (a, _d, ctx) => cmdCrossings(ctx!, { diff: a.includes('--diff'), verbose: a.includes('--verbose'), json: a.includes('--json'), warnings: a.includes('--warnings') }),
  },
  imports: {
    usage: 'cells imports [--json]',
    desc: 'raw file→file import graph (resolved edges + unresolved specifiers) — the machine surface for tooling',
    minArgs: 0,
    needsCells: true,
    run: (a) => cmdImports({ json: a.includes('--json') }),
  },
  list: {
    usage: 'cells list [--verbose]',
    desc: 'partition overview: cells, sizes, fan-in/out, requires, orphans; --verbose adds a per-cell health line (size%, stale provides, unresolved, dead files)',
    minArgs: 0,
    needsCells: true,
    run: (a, _d, ctx) => cmdList(ctx!, a.includes('--verbose')),
  },
  size: {
    usage: 'cells size',
    desc: 'context-fit vs the ceiling (warning); over-ceiling → peel candidates; cells can declare their own ceiling (ceiling = N in the cell.toml)',
    minArgs: 0,
    needsCells: true,
    run: (_a, _d, ctx) => cmdSize(ctx!),
  },
  structure: {
    usage: 'cells structure [--summary]',
    desc: 'layers + ADP + Direction + SDP (all warnings); cycle → cheapest edge to cut; --summary = triage view (one line per cycle + counts — for high-cycle repos like kafka/elasticsearch)',
    minArgs: 0,
    needsCells: true,
    run: (a, _d, ctx) => cmdStructure(ctx!, a.includes('--summary')),
  },
  config: { usage: 'cells config [set max-payload-tokens <N>]', desc: 'read the effective config; set the global ceiling (edit in place, comments preserved — the per-repo knob)', minArgs: 0, needsCells: false, run: (a) => cmdConfig(a) },
  graph: { usage: 'cells graph [--mermaid]', desc: 'the dependency graph (ASCII tree; --mermaid for Mermaid)', minArgs: 0, needsCells: true, run: (a, _d, ctx) => cmdGraph(ctx!, a.includes('--mermaid')) },
  owns: { usage: 'cells owns <file>', desc: 'which cell owns this file? (reverse lookup)', minArgs: 1, needsCells: true, run: (a, _d, ctx) => cmdOwns(ctx!, a[0]) },
  show: {
    usage: 'cells show <name> [--verbose]',
    desc: 'one cell: membrane + in/out crossings + fan-in/out/instability + size, dead-at-boundary files, change-coupled partners, stale provides, unresolved imports',
    minArgs: 1,
    needsCells: true,
    run: (a, _d, ctx) => cmdShow(ctx!, a.filter((x) => !x.startsWith('--'))[0]!, a.includes('--verbose')),
  },
  surface: {
    usage: 'cells surface <name>',
    desc: "print the cell's export-like declaration lines (file:line) — the starting point for populating the membrane signatures field",
    minArgs: 1,
    needsCells: true,
    run: (a, _d, ctx) => cmdSurface(ctx!, a[0]),
  },
  impact: { usage: 'cells impact <name>', desc: 'blast radius: cells that transitively depend on this one', minArgs: 1, needsCells: true, run: (a, _d, ctx) => cmdImpact(ctx!, a[0]) },
  init: {
    usage: 'cells init [--dry-run]',
    desc: 'bootstrap .cells/ (idempotent; --dry-run previews)',
    minArgs: 0,
    needsCells: false,
    run: (_a, dryRun) => cmdInit(dryRun),
  },
  rename: { usage: 'cells rename <old> <new>', desc: 'rename a cell — updates .cell.toml, ownership, and all requires', minArgs: 2, needsCells: true, run: (a) => cmdRename(a[0], a[1]) },
  remove: { usage: 'cells remove <cell> [--force]', desc: 'delete a cell; --force orphans owned files and strips requires refs', minArgs: 1, needsCells: true, run: (a) => cmdRemove(a[0], a.includes('--force')) },
  assign: {
    usage: 'cells assign [--dry-run] <cell> <file...>',
    desc: 'assign files to a cell (moves from current cell if already owned; stubs if new; --dry-run previews)',
    minArgs: 2,
    needsCells: true,
    run: (a, dryRun) => cmdAssign(a[0], a.slice(1), dryRun),
  },
  unassign: {
    usage: 'cells unassign [--dry-run] <file...>',
    desc: 'remove files from their cell (→ orphan; --dry-run previews)',
    minArgs: 1,
    needsCells: true,
    run: (a, dryRun) => cmdUnassign(a, dryRun),
  },
  health: {
    usage: 'cells health [--verbose] [--summary]',
    desc: 'THE GATE: exit 1 on integrity + undeclared leakage + a broken packaged grammar; size/structure are warnings (--verbose names failing edges inline; --summary collapses unresolved entries into per-FILE groups, sorted desc — the triage unit for high-unresolved repos). Output ends with a machine-parseable health: X.Xs timing line.',
    minArgs: 0,
    needsCells: true,
    run: (a, _d, ctx) => cmdHealth(ctx!, a.includes('--verbose'), a.includes('--summary')),
  },
  new: {
    usage: 'cells new <name> [--purpose "..."] [--provides a,b] [--requires a,b] [--layer N]',
    desc: 'scaffold a cell declaration (.cell.toml) — declare first, then assign files to it',
    minArgs: 1,
    needsCells: true,
    run: (a) => cmdNew(a),
  },
  'prune-stale': {
    usage: 'cells prune-stale [--apply]',
    desc: 'remove requires declared but never imported (stale); dry-run by default, --apply rewrites',
    minArgs: 0,
    needsCells: true,
    run: (a) => cmdPruneStale(a.includes('--apply')),
  },
  plan: {
    usage: 'cells plan [--apply] [--dry-run]',
    desc: 'scan code-dirs and propose a partition: crates / npm packages / Python __init__ packages become one cell each, other files group by directory (review + curate; --apply creates the cells + ownership mechanically, --dry-run previews)',
    minArgs: 0,
    needsCells: false,
    run: (a, dryRun) => cmdPlan(a.includes('--apply'), dryRun),
  },
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
    process.stdout.write(renderHelp(Object.values(COMMANDS)));
    return;
  }
  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(`cells ${readVersion()}\n`);
    return;
  }

  const command = COMMANDS[cmd];
  if (!command) {
    console.error(
      `usage: cells {help | --version | ${Object.values(COMMANDS)
        .map((c) => c.usage.replace(/^cells /, ''))
        .join(' | ')}}`,
    );
    process.exit(1);
  }
  // `cells <cmd> --help` must answer help, not run the command (minArgs:0 commands
  // like plan/size would otherwise execute with --help silently ignored).
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`usage: ${command.usage}\n`);
    return;
  }
  // Unknown-flag gate: the usage string is the single source of truth — every
  // flag a command accepts appears in its usage (no second list to drift).
  // Without this, an unknown flag silently flows into positional args
  // (assign would treat `--verbose` as a filename).
  const knownFlags: string[] = command.usage.match(/--[\w-]+/g) ?? [];
  const unknownFlag = args.find((a) => a.startsWith('--') && a !== '--dry-run' && !knownFlags.includes(a));
  if (unknownFlag !== undefined) {
    console.error(`unknown flag "${unknownFlag}" for cells ${cmd}`);
    console.error(`usage: ${command.usage}`);
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
