/**
 * `cells help` — the tool's self-documentation. This is how a model (or human)
 * dropped into ANY repo with a `.cells/` dir onboards: run `cells help` and the
 * tool teaches itself. The README lives in the Cells repo; THIS text is what
 * reaches foreign repos (it ships with the installed `cells` command).
 *
 * The COMMANDS block is rendered by renderHelp() from the dispatch table in
 * cli.ts — the table's `usage` strings are the only source of truth for command
 * names + flags (they drifted 3× in one session when help was hand-maintained).
 */
const HELP_TEMPLATE = `cells — code organized into context-bounded cells, for LLMs coding alongside humans.
Work one cell at a time instead of drowning in the whole codebase.

THE MODEL
  cell        a context-bounded unit of code: one problem, fits a context window.
              has a membrane (its contract) + owned files (its body).
  partition   every code file assigned to exactly one cell (non-overlapping).
  membrane    a cell's declaration: name, purpose, provides, requires (+ optional layer).
              provides = authored docs of what this cell offers (shown in show/payload to neighbors;
              describe the surface in your words — not symbol-checked). requires = cells this one
              imports (checked against crossings — undeclared leaks gate-fail). purpose = one-line intent.
  crossing    a real dependency from one cell into another (derived from imports).
  payload     what you consume to work a cell: its membrane + owned files + its
              neighbors' membranes. Measured in tokens (~chars/3).
  fan-in/out  cells depending on this one / cells it depends on. instability
              I = fan-out/(fan-in+fan-out): 0 stable, 1 unstable. In list + show.

  ownership is TRACKED (ownership.toml); declarations are AUTHORED (*.cell.toml);
  crossings are DERIVED from real imports. Principle: visibility over enforcement.

WORKING IN A CELLS PROJECT (for agents)
  1. orient       cells list            see the cells, their sizes, any unowned files
  2. zoom in      cells show <name>     a cell's membrane + in/out crossings + size
  3. retrieve     cells payload <name>  the full context (membrane + code + neighbors)
  4. assess       cells impact <name>   blast radius: who transitively depends on this? weigh before editing
                                    (leaf = no import dependents — static view; hidden callers like
                                    reflection, registries, entry points are invisible — change ≠ delete)
  5. work         edit the cell's files; stay within its membrane
  6. place code   new file? read list, pick a cell (your judgment), then
                  cells assign <cell> <file>. Unowned files aren't violations.
  7. check        cells health (the gate — every check at once) · or drill in: crossings · crossings --diff · size · structure
                  If checks fail: read the hints (each error says what to edit), fix the membrane
                  (.cell.toml requires/provides/tests, reassign files, or remove dead imports),
                  then re-run cells health until green.
  8. navigate     cells graph (deps at a glance) · cells owns <file>

  Brownfield adoption? Run cells plan — it scans code-dirs, groups files into crates / npm packages / Python __init__ packages
  (or directories for the rest), and prints proposed .cell.toml declarations + an ownership map.
  Review, curate, then cells plan --apply creates the cells and adopts the files for you
  (existing cells and curated ownership are never overwritten).

  A cell past the ceiling? Split its files across new cells with assign
  (no separate divide command — assign IS the repartition tool).

COMMANDS
__COMMANDS__
  help                     this text (also --help, -h)
  --version                print the installed version (also -v)

RULES
  leakage    undeclared = GATE (exit 1)   import a cell you don't require
            stale = info (exit 0)            require one never imported (data dep? future plan?)
  membrane   stale provide = info (exit 0)   provide no owned file references (drift — fix code or membrane)
  integrity  GATE (exit 1)   file in two cells; owned file missing; undeclared ref
  size       warning         payload over the ceiling — max-payload-tokens (config.toml,
                             default 16000) or the cell's own ceiling = N override
  structure  warning         a cycle (ADP), an edge to a higher layer (Direction),
                             or a stable cell depending on a less-stable one (SDP)
  orphans    visibility      unowned files aren't violations; list shows them,
                             .cells/ignore hides the intentional ones

GLOSSARY (structure terms, plain English)
  ADP — Acyclic Dependencies:        no cycles between cells
  Direction:                         edges point inward toward the core (lower layers)
  SDP — Stable Dependencies:         each cell depends on things at least as stable as itself
  instability I = fan-out/(fan-in+fan-out):  0 = rock-solid core (depended on,
                                       depends on nothing); 1 = leaf (depends on
                                       everything, nothing depends on it)
  strict gate:                       exit 1 only on integrity + undeclared leakage +
                                     a broken packaged grammar WASM.

FILES (.cells/)
  <name>.cell.toml   declaration: name, purpose, provides[], requires[], layer?
  ownership.toml     the file → cell map (tracked)
  config.toml        max-payload-tokens, [layers] legend (optional; 0 = core),
                     code-dirs[], code-exts[] (per language; init auto-detects),
                     ignore-blind-exts[] (silence per-ext blind warning)
                     module-root? (strip a path prefix for import resolution; Python src-layout: "src")
  ignore             gitignore-style patterns for intentionally cell-free files
                     (a trailing / matches the whole dir tree, like gitignore's dir/)

LANGUAGES: partition/payload/size/owns (and health's integrity check) are language-agnostic — set code-dirs + code-exts
in config.toml. crossings/structure analyze real imports via tree-sitter (bundled WASM grammars):
TypeScript/JS/TSX (tsconfig paths aliases + workspace package.json resolution), Python, Rust, Go, C/C++, and
Java. Other languages need an importer (one per language, picked by extension). Resolution derives
module->file maps from owned files; the TS importer also probes package.json/tsconfig.json on disk —
runs on source you're just reading, nothing to build or install.

Drop into any repo with a .cells/ dir and follow the loop above.
`;

/** Usage column width in the rendered COMMANDS block (2 indent + 28 usage). */
const USAGE_COL = 30;

/** Greedy word-wrap `text` to 100 cols with continuation lines indented to `indent`. */
function wrap(text: string, indent: number): string {
  const cap = 100 - indent; // every rendered line starts at col `indent` (first line carries the usage pad)
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (cur && candidate.length > cap) {
      lines.push(cur);
      cur = ' '.repeat(indent) + w;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
}

/**
 * The full `cells help` text. Commands are taken from the dispatch table (a
 * structural `{ usage, desc }[]` — help imports nothing, cli.ts feeds it the
 * rows), so a new/changed command can't drift from the help output.
 */
export function renderHelp(commands: ReadonlyArray<{ usage: string; desc: string }>): string {
  const block = commands
    .map((c) => {
      const usage = c.usage.replace(/^cells /, '');
      const pad = '  ' + usage.padEnd(USAGE_COL - 2);
      const first = pad.length > USAGE_COL ? '  ' + usage + '\n' + ' '.repeat(USAGE_COL) : pad;
      return first + wrap(c.desc, USAGE_COL);
    })
    .join('\n');
  return HELP_TEMPLATE.replace('__COMMANDS__', block);
}
