/** The read and analysis command handlers for the CLI, which form the payload-shaped half:
 *  `crossings`, `list`, `show`, `owns`, `payload`, `surface`, and `graph`. `cli.ts` keeps the
 *  dispatcher and the mutation commands. The report commands for size, structure, impact,
 *  and health live in `gate.ts`. The shared read pipeline (`loadCrossings`, the guards,
 *  `cmdImports`) lives in `pipeline.ts`. The handlers are mostly pure: they gather I/O and
 *  delegate the rendering to `view`. */

import { type Crossing, type CrossingsDelta, checkLeakage, checkOffMembrane, computeMetrics } from '../crossings.js';
import type { Cell } from '../declaration.js';
import { crossingsDelta, recentCommitFiles } from '../diff.js';
import { formatCellGraph, formatCellGraphAscii } from '../graph.js';
import { type CellsContext, listCodeFiles, readFiles } from '../io.js';
import { type Ownership, owningCell } from '../ownership.js';
import { assemblePayload, type CellSize, computePayloadSize, estimateTokens, neighborsOf } from '../payload.js';
import { loadCrossings, requireCell, warnIfNoCodeFiles } from '../pipeline.js';
import { classifyChangeCoupling } from '../structure.js';
import { providesDrift } from '../validate.js';
import { type CellSmell, formatCellList, formatCellShow } from '../view.js';

/** `cells crossings [--diff] [--verbose] [--json]`, which shows the real cross-cell imports
 *  and the leakage.
 *
 *  By default the command prints a summary per pair of cells, which answers the overview
 *  question "which cells are coupled?". `--verbose` shows every edge from file to file.
 *  `--diff` shows what your uncommitted edits added and removed (the working tree against
 *  HEAD). `--json` writes raw JSON, so stdout stays machine-clean and the human notes go to
 *  stderr. */
export async function cmdCrossings(ctx: CellsContext, opts: { diff?: boolean; verbose?: boolean; json?: boolean; warnings?: boolean } = {}): Promise<void> {
  const { ownership, declarations } = ctx;
  const { crossings, edges, unresolved } = await loadCrossings(ownership);

  if (opts.diff) {
    const delta = await crossingsDelta(crossings, ownership);
    if (delta !== null) {
      // Flag the leakage that these edits introduce. On a delta subset only UNDECLARED is
      // meaningful: "did I add a crossing that the from-cell does not require?". Stale
      // (declared but unused) is a property of the full tree, and an added subset cannot
      // answer it.
      const leakage = checkLeakage(delta.added, declarations).filter((l) => l.kind === 'undeclared');
      const undeclaredKeys = new Set(leakage.map((l) => `${l.fromCell}|${l.toCell}`));
      if (opts.json) {
        writeJson({ added: delta.added, removed: delta.removed, undeclared: leakage });
      } else {
        showCrossingsDelta(delta, undeclaredKeys, declarations);
      }
      if (leakage.length > 0) {
        console.error(`\nUndeclared crossings (${leakage.length}) — the [UNDECLARED] edges above need a requires entry (or remove the import):`);
        for (const l of leakage) console.error(`  ${l.detail}`);
        process.exitCode = 1; // Set `exitCode` and do not call `exit()`, so stdout can drain. Piped output must not lose the tail.
        return;
      }
      return;
    }
    console.error('⚠ --diff unavailable (need a git repo with at least one commit, and `tar` on PATH) — showing current crossings instead.');
  }

  if (!opts.warnings) {
    // Under `--warnings`, skip the listing entirely and show only the leakage and the
    // unresolved imports. These are the "just the warnings" output for an agent. On a big
    // repository the pair list drowns the actionable tail.
    if (crossings.length === 0) {
      if (opts.json) {
        writeJson([]);
      } else {
        console.log('No cross-cell imports.');
      }
    } else if (opts.json) {
      writeJson(crossings);
    } else {
      // By default, an aggregate summary. With `--verbose`, every edge from file to file
      // under its cell pair.
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
      if (opts.verbose) {
        const off = checkOffMembrane(edges, ownership, declarations);
        if (off.length > 0) {
          console.log(`\nOff-membrane imports (${off.length} pair(s) — named symbols consumed but not in the target's provides):`);
          for (const o of off) {
            console.log(`  ${o.fromCell} → ${o.toCell}: ${o.missing.join(', ')}${o.emptyProvides ? ' (provides is empty)' : ''}`);
          }
        }
      }
    }
  }

  const leakage = checkLeakage(crossings, declarations);
  const stale = leakage.filter((l) => l.kind === 'stale');
  const undeclared = leakage.filter((l) => l.kind === 'undeclared');
  if (opts.json && opts.warnings) {
    // `--warnings --json`: the actionable tail as data. Under `--json`, stdout must always
    // be valid JSON. The listing is skipped by design, so emit the leakage and the
    // unresolved imports here.
    writeJson({ leakage, unresolved });
    if (undeclared.length > 0) process.exitCode = 1; // The exit code matches the text path.
    return;
  }
  if (stale.length > 0) {
    // A stale require is declared but never imported. This is information, so the exit code
    // is 0, the same as `health`. Only an undeclared crossing fails the gate.
    console.error(`(info) ${stale.length} stale require(s) — declared but no import found (maybe a data dependency or future plan):`);
    for (const l of stale) console.error(`  ${l.detail}`);
  }
  if (undeclared.length > 0) {
    console.error(`\nUndeclared crossings (${undeclared.length}) — add a requires entry (or remove the import):`);
    for (const l of undeclared) console.error(`  ${l.detail}`);
    process.exitCode = 1; // Set `exitCode` and do not call `exit()`, so the unresolved report below can print and stdout can drain before exit.
  }

  if (unresolved.length > 0) {
    console.error(`\nUnresolved imports that look local (${unresolved.length}):`);
    for (const u of unresolved) {
      console.error(
        `  ${u.fromFile} imports "${u.import}" — no matching owned file. A broken specifier, a module-root mismatch, an external package sharing a local dir name, or a code dir excluded by the census skip-list (build/dist/…) (module-root in config.toml).`,
      );
    }
  }
}

/** Write an object as pretty JSON on stdout. Under `--json`, stdout stays machine-clean and
 *  the human notes go to stderr, so a machine consumer always gets valid JSON. */
function writeJson(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

/** Render a crossings delta: the added and removed edges, then a summary. */
function showCrossingsDelta(delta: CrossingsDelta, undeclared: Set<string>, declarations: Record<string, Cell>): void {
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
    // A removed edge to a cell that `requires` still lists means that the change
    // invalidated a declared contract. This is the mirror of [UNDECLARED] on the added
    // side.
    const flag = declarations[c.fromCell]?.requires.includes(c.toCell) ? ' [REQUIRES NOW STALE]' : '';
    console.log(`  −${flag} ${c.fromCell} → ${c.toCell}   (${c.fromFile} → ${c.toFile})`);
  }
  console.log(`${delta.added.length} added, ${delta.removed.length} removed.`);
}

/** `cells list [--verbose]`, which gives the partition overview: the files, size, requires,
 *  and fan-in and fan-out of each cell, plus the orphans. `--verbose` adds a health line per
 *  cell (size percentage, stale provides, unresolved imports, dead files, tests), which is
 *  the one-screen orientation scan. All signals reuse data that the overview already
 *  loads. */
export async function cmdList(ctx: CellsContext, verbose = false): Promise<void> {
  const { declarations, ownership, config } = ctx;
  const sizes: Record<string, CellSize> = {};
  const smells: Record<string, CellSmell> = {};
  const allContents: Record<string, string>[] = [];
  const { crossings, unresolved, edges } = await loadCrossings(ownership);
  const unresolvedByCell = new Map<string, number>();
  if (verbose) {
    for (const u of unresolved) {
      const owner = owningCell(ownership, u.fromFile);
      if (owner) unresolvedByCell.set(owner, (unresolvedByCell.get(owner) ?? 0) + 1);
    }
  }
  for (const name of Object.keys(declarations)) {
    const cell = declarations[name];
    const owned = ownership[name] ?? [];
    const contents = readFiles(owned); // One read, reused for the size, the stale provides, and the dead files.
    sizes[name] = computePayloadSize(cell, owned, contents, neighborsOf(cell, declarations), readFiles(cell.tests ?? []));
    if (verbose) allContents.push(contents);
  }
  if (verbose) {
    // Drift needs the whole repository in hand. The owned contents accumulate above, and
    // the orphans are read one time. Each name gets one verdict, because `unread` includes
    // `stale` in both smell counts below.
    const merged = Object.assign({}, ...allContents);
    const ownedAll = new Set(Object.keys(merged));
    const orphans = listCodeFiles().filter((f) => !ownedAll.has(f));
    const drift = providesDrift(declarations, ownership, edges, { ...merged, ...readFiles(orphans) });
    const staleByCell = new Map<string, number>();
    const unreadByCell = new Map<string, number>();
    for (const s of drift.stale) staleByCell.set(s.cell, (staleByCell.get(s.cell) ?? 0) + 1);
    for (const u of drift.unread) unreadByCell.set(u.cell, (unreadByCell.get(u.cell) ?? 0) + 1);
    for (const name of Object.keys(declarations)) {
      const cell = declarations[name];
      smells[name] = {
        pct: sizes[name].tokens / (cell.ceiling ?? config.maxPayloadTokens),
        staleProvides: staleByCell.get(name) ?? 0,
        unreadProvides: unreadByCell.get(name) ?? 0,
        unresolved: unresolvedByCell.get(name) ?? 0,
      };
    }
  }
  const metrics = computeMetrics(crossings, Object.keys(declarations));
  const owned = new Set(Object.values(ownership).flat());
  const codeFiles = listCodeFiles();
  warnIfNoCodeFiles(config, codeFiles);
  const orphanFiles = codeFiles.filter((f) => !owned.has(f));
  // Orphan magnets are the unowned files that other files import. These edges survive to
  // the imports level, and `deriveCrossings` drops them, because an orphan has no cell. This
  // is the adoption queue, in priority order.
  const magnetCounts = new Map<string, number>();
  for (const e of edges) {
    if (!owned.has(e.toFile)) magnetCounts.set(e.toFile, (magnetCounts.get(e.toFile) ?? 0) + 1);
  }
  process.stdout.write(formatCellList(declarations, sizes, metrics, orphanFiles, verbose ? smells : undefined, magnetCounts));
}

/** Classify the change coupling over the recent git history (ADR 0002). This shared step
 *  runs behind the co-change list of `show` and the coupling hint of `payload`. */
function changeCoupling(ownership: Ownership, crossings: Crossing[]) {
  return classifyChangeCoupling(recentCommitFiles(Object.values(ownership).flat()), ownership, crossings);
}

/** `cells show <name> [--verbose]`, which prints the detail of one cell with its incoming
 *  and outgoing crossings. A crossing with high fan-in or fan-out (more than 8 edges)
 *  collapses to an aggregate per cell. `--verbose` shows every edge per file. */
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
  // A file is dead at the cell boundary when no file outside the cell imports it. This is a
  // static view, so internal edges do not count. An entry point can still load the file,
  // and the caveat in `impact` explains this.
  const ownedSet = new Set(ownedFiles);
  const externallyImported = new Set<string>();
  for (const e of edges) if (!ownedSet.has(e.fromFile)) externallyImported.add(e.toFile);
  const deadFiles = ownedFiles.filter((f) => !externallyImported.has(f));
  // The unresolved imports FROM the files of this cell. `loadCrossings` already filtered to
  // the owned files.
  const cellUnresolved = unresolved.filter((u) => ownedSet.has(u.fromFile)).map((u) => u.import);
  // Change coupling (ADR 0002): the cell pairs that change together with this cell in the
  // git history, classified against the crossings graph. A pair is explained when it has an
  // import edge.
  const coupling = changeCoupling(ownership, crossings);
  const coChange = coupling.pairs
    .filter((p) => p.a === name || p.b === name)
    .slice(0, 5)
    .map((p) => ({
      cell: p.a === name ? p.b : p.a,
      count: p.count,
      window: coupling.window,
      jaccard: p.jaccard,
      explained: p.explained,
    }));
  // The membrane drift for this cell. The whole-repository contents are in hand (the owned
  // files of every cell and the orphans), so the unread refinement scans the same
  // population as `health`. Each name gets one verdict on both surfaces.
  const repoContents: Record<string, string> = { ...contents };
  for (const files of Object.values(ownership)) Object.assign(repoContents, readFiles(files.filter((f) => !(f in repoContents))));
  const drift = providesDrift(declarations, ownership, edges, repoContents);
  const staleProvides = drift.stale.filter((s) => s.cell === name);
  const unreadProvides = drift.unread.filter((u) => u.cell === name);
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
        unreadProvides,
        unresolved: cellUnresolved,
      },
      verbose,
    ),
  );
}

/** `cells graph [--mermaid]`, which renders the cell graph. The default is an ASCII tree,
 *  and `--mermaid` writes the Mermaid source. */
export async function cmdGraph(ctx: CellsContext, mermaid: boolean): Promise<void> {
  const { ownership } = ctx;
  const { crossings } = await loadCrossings(ownership);
  const allCells = Object.keys(ownership);
  process.stdout.write(mermaid ? formatCellGraph(crossings, allCells) : formatCellGraphAscii(crossings, allCells));
}

/** The export-like declaration lines per language. These lines are the raw material for the
 *  `signatures` membrane field of a cell. The function uses a rough line regex, not a
 *  parser. The LLM curates the output, including the type annotations, before it pastes
 *  the lines into the `.cell.toml` file. The function is pure. */
export function extractSurface(content: string, path = ''): { line: number; text: string }[] {
  // A JS or TS file exports an item with an `export` line only, so a bare `const` or `class` at
  // column 0 is module-private there. The bare forms apply to the languages that declare at
  // column 0, and only those: a file with an unknown extension (a script, a template) is
  // skipped rather than guessed. The empty path is the caller that passes no file, and keeps
  // the permissive behavior for a direct call. The `^` anchors mean column 0 only, so indented
  // methods and statements (Python defs inside a class, indented consts) are properly skipped.
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '' : path.slice(dot).toLowerCase();
  // No path, no guess: a direct call keeps the permissive behavior. A real path with an
  // unknown or missing extension is skipped, because its language is unknown. The list mirrors
  // the extensions of the non-JS importers (python with its Cython forms, go, rust, java, cpp).
  const bareLang = path === '' || /^\.(?:py|pyx|pxd|go|rs|java|c|h|cc|cpp|cxx|hpp|hh|hxx)$/.test(ext);
  const exported = /^(?:export\s|pub\s+(?:fn|struct|enum|trait|type|const|mod|use|static)\s|(?:public|protected)\s+(?:[\w$]+\s+)*(?:class|interface|enum|record|@interface)\s)/;
  const bare = /^(?:(?:async\s+)?def\s|class\s|func\s|type\s|const\s|var\s)/;
  const out: { line: number; text: string }[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (exported.test(line) || (bareLang && bare.test(line))) out.push({ line: i + 1, text: line.trim() });
  }
  return out;
}

/** `cells surface <name>`, which prints the export-like declaration lines of the cell as
 *  `file:line`. These lines are the starting point for the `signatures` field of the
 *  membrane. The output groups by owned file. */
export function cmdSurface(ctx: CellsContext, name: string): void {
  const { declarations, ownership } = ctx;
  const cell = requireCell(declarations, name);
  const ownedFiles = ownership[name] ?? [];
  const contents = readFiles(ownedFiles);
  let any = false;
  for (const f of ownedFiles) {
    const hits = extractSurface(contents[f] ?? '', f);
    if (hits.length === 0) continue;
    any = true;
    process.stdout.write(`## ${f}\n`);
    for (const h of hits) process.stdout.write(`  ${h.line}: ${h.text}\n`);
  }
  if (!any) process.stdout.write(`No export-like declarations found in ${cell.name}'s ${ownedFiles.length} owned file(s).\n`);
  process.stdout.write(`\nPopulate the membrane: add these to \`signatures\` in .cells/${cell.name}.cell.toml (adapt with types).\n`);
}

/** `cells owns <file>`, which answers which cell owns this file. The output is terse: the
 *  name and the purpose. An unowned file is an orphan. */
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

/** `cells payload <name>`, which assembles the payload of a cell and prints it to stdout. */
export async function cmdPayload(ctx: CellsContext, name: string): Promise<void> {
  const { declarations, ownership } = ctx;
  const cell = requireCell(declarations, name);

  const ownedFiles = ownership[name] ?? [];
  const fileContents = readFiles(ownedFiles);

  const testFiles = cell.tests ?? [];
  const testContents = readFiles(testFiles);

  const neighbors: Cell[] = [];
  for (const n of cell.requires) {
    const neighbor = declarations[n];
    if (neighbor) neighbors.push(neighbor);
    else console.error(`warning: neighbor "${n}" of cell "${name}" has no declaration`);
  }

  const dependents = Object.values(declarations).filter((d) => d.requires.includes(name));
  // ADR 0002: the change-coupling hint in the payload. The hint lists the unexplained
  // partners only, so the model knows that its context is incomplete. The hint costs zero
  // tokens when the cell is clean.
  const { crossings } = await loadCrossings(ownership);
  const coupling = changeCoupling(ownership, crossings);
  const coupled = coupling.pairs
    .filter((p) => !p.explained && (p.a === name || p.b === name))
    .slice(0, 3)
    .map((p) => ({ cell: p.a === name ? p.b : p.a, count: p.count, window: coupling.window, files: p.sampleFiles }));
  const payload = assemblePayload({ cell, ownedFiles, fileContents, neighbors, dependedByCount: dependents.length, testFiles, testContents, dependents, coupled });
  process.stdout.write(payload);

  const chars = payload.length;
  console.error(`\n[size: ${chars} chars, ~${estimateTokens(chars)} tokens]`);
}
