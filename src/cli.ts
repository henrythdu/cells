#!/usr/bin/env node
/**
 * The CLI entry. The file dispatches the commands and connects the io layer and the logic
 * cells to argv.
 *
 * The read and analysis handlers live in `commands/read.ts` and in `gate.ts` at the root of
 * `src/`. The bodies of the mutation commands live in `mutate.ts`.
 *
 * This file stays a thin dispatcher: argv goes to a COMMANDS row and then to a handler. It
 * also holds the argument-count checks, the `--dry-run` handling, the `--help` handling, and
 * the EPIPE handling.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmdCrossings, cmdGraph, cmdList, cmdOwns, cmdPayload, cmdShow, cmdSurface } from './commands/read.js';
import { cmdHealth, cmdImpact, cmdSize, cmdStructure } from './gate.js';
import { renderHelp } from './help.js';
import { type CellsContext, loadContext, requireCells } from './io.js';
import { cmdAssign, cmdConfig, cmdInit, cmdNew, cmdPlan, cmdPruneStale, cmdRemove, cmdRename, cmdUnassign } from './mutate.js';
import { cmdImports } from './pipeline.js';

/** The installed version, read lazily from package.json. The read works in development and when npm installs the package. */
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

// One line for each command. `usage` is the single source of truth: the error line
// ("usage: cells ..."), the dispatch help ("cells <cmd> --help"), and the COMMANDS block
// of `cells help` all come from it (see `renderHelp`).
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

/**
 * A refusal on stderr only. The function prints the message and exits with code 1 at once,
 * and writes nothing to stdout. The exit-code convention is at the bottom of this file. The
 * function never returns.
 */
function usageError(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function main(): Promise<void> {
  // A command such as `cells X | head` closes the pipe early. Ignore EPIPE, and keep the
  // natural exit code of the command: do not exit with 0 here. Re-raise every other error
  // (ENOSPC, EIO), so a real stdout failure stays visible and this listener does not mark it
  // as handled.
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
    usageError(
      `usage: cells {help | --version | ${Object.values(COMMANDS)
        .map((c) => c.usage.replace(/^cells /, ''))
        .join(' | ')}}`,
    );
  }
  // `--` ends the flag zone. Every token before it is a flag, and every token after it is a
  // literal positional value.
  const sepIdx = args.indexOf('--');
  const flagZone = sepIdx === -1 ? args : args.slice(0, sepIdx);
  const rest = sepIdx === -1 ? [] : args.slice(sepIdx + 1);
  // `cells <cmd> --help` must show the help and must not run the command. Without this
  // check, a command with minArgs 0, such as plan or size, would run and ignore `--help`
  // without a warning.
  //
  // The check applies to the flag zone only. A `--help` after a `--` is a literal positional
  // value (a file with a name that looks like a flag), and not a help request.
  if (flagZone.includes('--help') || flagZone.includes('-h')) {
    process.stdout.write(`usage: ${command.usage}\n`);
    return;
  }
  // The check for an unknown flag. The usage string is the single source of truth: every
  // flag that a command accepts appears in its usage, so there is no second list that can
  // drift.
  //
  // Without this check, an unknown flag goes into the positional arguments without a
  // warning, and `assign` would treat `--verbose` as a file name.
  //
  // Single-dash tokens are checked too. Before this check, `-x` went past it, which gave a
  // misleading "no cell named -x" error, or no error for a command with minArgs 0.
  //
  // `--` ends the flag zone. Every token after it is a literal positional value (a file with
  // a name that looks like a flag).
  const knownFlags: string[] = command.usage.match(/--[\w-]+/g) ?? [];
  const unknownFlag = flagZone.find((a) => a.startsWith('-') && a.length > 1 && !knownFlags.includes(a));
  if (unknownFlag !== undefined) {
    usageError(`unknown flag "${unknownFlag}" for cells ${cmd}\nusage: ${command.usage}`);
  }
  if (command.needsCells) requireCells();
  // `--dry-run` is a pure boolean flag and never takes a value. The count check removes it,
  // so `assign cell --dry-run` counts 1 positional (the cell) and not 2 raw arguments.
  //
  // Only the commands whose usage declares `--dry-run` (init, assign, unassign, and plan)
  // accept it. The unknown-flag check rejects it for every other command. The flag zone
  // applies: after `--`, the token is a literal positional value, which is the same contract
  // as for `--help` above.
  const dryRun = flagZone.includes('--dry-run');
  // The arguments that the run closure of a command receives: every argument in the flag
  // zone except `--dry-run`, plus the literal positionals after `--`.
  //
  // The other flags (`--verbose`, `--diff`, `--force`, and others) stay in `runArgs`. Each
  // handler parses them again with `a.includes('--flag')`. A truly positional array would
  // need a second parameter, and the COMMANDS rows avoid that.
  const runArgs = [...flagZone.filter((a) => a !== '--dry-run'), ...rest];
  const realArgs = [...flagZone.filter((a) => !a.startsWith('-')), ...rest].length;
  if (realArgs < command.minArgs) {
    usageError(`usage: ${command.usage}`);
  }
  // Load the three stores once for each cells command. The read commands use the bundle
  // from their dispatch closures (`ctx!`, which is present because needsCells is true).
  //
  // The mutation commands ignore the bundle and load fresh data, because they write after
  // they read and a shared bundle would be stale. A command with needsCells false (init,
  // plan) has no store, so ctx is undefined and those closures never touch it.
  const ctx = command.needsCells ? loadContext() : undefined;
  await command.run(runArgs, dryRun, ctx);
}

// The exit convention has two deliberate patterns.
//
// A report path that writes to stdout sets `process.exitCode = 1`, so the stream drains
// before the process ends and piped output does not lose its tail.
//
// A refusal on stderr only, with nothing on stdout, can call `process.exit(1)` directly.
//
// A thrown error arrives here. The seam contract is that celledit, plan, and assign throw
// their refusal messages unchanged. The handler prints the message with the `cells: ` prefix
// and exits with code 1.
main().catch((err) => {
  console.error(`cells: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
