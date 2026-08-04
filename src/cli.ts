#!/usr/bin/env node
/** CLI entry: dispatch commands; wire the io layer + logic cells to argv.
 *  Read/analysis handlers live in commands/ (read.ts + report.ts); mutation command
 *  bodies live in mutate.ts. This file stays a thin dispatcher: argv → COMMANDS row →
 *  handler, plus the arg-count/--dry-run/--help gates and EPIPE handling. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContext, requireCells, type CellsContext } from './io.js';
import { cmdCrossings, cmdList, cmdShow, cmdGraph, cmdOwns, cmdPayload, cmdSurface } from './commands/read.js';
import { cmdSize, cmdStructure, cmdImpact, cmdHealth } from './commands/report.js';
import { cmdInit, cmdRename, cmdRemove, cmdAssign, cmdUnassign, cmdNew, cmdPruneStale, cmdPlan } from './mutate.js';
import { HELP } from './help.js';

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
  readonly minArgs: number;
  readonly needsCells: boolean;
  readonly run: (args: string[], dryRun: boolean, ctx?: CellsContext) => void | Promise<void>;
}

const USAGE =
  'usage: cells {help | init | rename <old> <new> | remove <cell> [--force] | new <name> [--purpose ...] [--provides a,b] [--requires a,b] [--layer N] | prune-stale [--apply] | assign [--dry-run] <cell> <file...> | unassign [--dry-run] <file...> | owns <file> | payload <name> | health [--verbose] [--summary] | crossings [--diff] [--verbose] [--json] | plan [--apply] [--dry-run] | list [--verbose] | size | structure [--summary] | graph [--mermaid] | show <name> | surface <name> | impact <name>}';

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
  list: { usage: 'cells list [--verbose]', minArgs: 0, needsCells: true, run: (a, _d, ctx) => cmdList(ctx!, a.includes('--verbose')) },
  size: { usage: 'cells size', minArgs: 0, needsCells: true, run: (_a, _d, ctx) => cmdSize(ctx!) },
  structure: { usage: 'cells structure [--summary]', minArgs: 0, needsCells: true, run: (a, _d, ctx) => cmdStructure(ctx!, a.includes('--summary')) },
  graph: { usage: 'cells graph [--mermaid]', minArgs: 0, needsCells: true, run: (a, _d, ctx) => cmdGraph(ctx!, a.includes('--mermaid')) },
  owns: { usage: 'cells owns <file>', minArgs: 1, needsCells: true, run: (a, _d, ctx) => cmdOwns(ctx!, a[0]) },
  show: { usage: 'cells show <name> [--verbose]', minArgs: 1, needsCells: true, run: (a, _d, ctx) => cmdShow(ctx!, a.filter((x) => !x.startsWith('--'))[0]!, a.includes('--verbose')) },
  surface: { usage: 'cells surface <name>', minArgs: 1, needsCells: true, run: (a, _d, ctx) => cmdSurface(ctx!, a[0]) },
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
  health: { usage: 'cells health [--verbose] [--summary]', minArgs: 0, needsCells: true, run: (a, _d, ctx) => cmdHealth(ctx!, a.includes('--verbose'), a.includes('--summary')) },
  new: {
    usage: 'cells new <name> [--purpose "..."] [--provides a,b] [--requires a,b] [--layer N]',
    minArgs: 1,
    needsCells: true,
    run: (a) => cmdNew(a),
  },
  'prune-stale': { usage: 'cells prune-stale [--apply]', minArgs: 0, needsCells: true, run: (a) => cmdPruneStale(a.includes('--apply')) },
  plan: { usage: 'cells plan [--apply] [--dry-run]', minArgs: 0, needsCells: false, run: (a, dryRun) => cmdPlan(a.includes('--apply'), dryRun) },
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
