/**
 * `cells help` — the tool's self-documentation. This is how a model (or human)
 * dropped into ANY repo with a `.cells/` dir onboards: run `cells help` and the
 * tool teaches itself. The README lives in the Cells repo; THIS text is what
 * reaches foreign repos (it ships with the installed `cells` command).
 */
export const HELP = `cells — code organized into context-bounded cells, for LLMs coding alongside humans.
Work one cell at a time instead of drowning in the whole codebase.

THE MODEL
  cell        a context-bounded unit of code: one problem, fits a context window.
              has a membrane (its contract) + owned files (its body).
  partition   every code file assigned to exactly one cell (non-overlapping).
  membrane    a cell's declaration: name, purpose, provides, requires (+ optional layer).
              provides = what this cell offers (a contract; shown in show/payload to neighbors,
              not symbol-checked). requires = cells this one imports (validated against
              crossings — the leakage gate). purpose = one-line intent.
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
  5. work         edit the cell's files; stay within its membrane
  6. place code   new file? read list, pick a cell (your judgment), then
                  cells assign <cell> <file>. Unowned files aren't violations.
  7. check        cells health (the gate — all four at once) · or drill in: crossings · crossings --diff · size · structure
                  If checks fail: read the hints (each error says what to edit), fix the membrane
                  (.cell.toml requires/provides/tests, reassign files, or remove dead imports),
                  then re-run cells health until green.
  8. navigate     cells graph (deps at a glance) · cells owns <file>

  Brownfield adoption? Run cells plan — it scans code-dirs, groups files by directory,
  and prints a proposed .cell.toml declarations + ownership map. Review, curate, create.

  A cell past the ceiling? Split its files across new cells with assign
  (no separate divide command — assign IS the repartition tool).

COMMANDS
  init [--dry-run]         bootstrap .cells/ (idempotent; --dry-run previews)
  rename <old> <new>       rename a cell — updates .cell.toml, ownership, and all requires
  remove <cell> [--force]  delete a cell; --force orphans owned files and strips requires refs
  plan                     scan code-dirs and propose a partition (review + curate)
  assign <cell> <file...>  assign files to a cell (moves from current cell if already owned; stubs if new; --dry-run previews)
  unassign <file...>       remove files from their cell (→ orphan; --dry-run previews)
  owns <file>              which cell owns this file? (reverse lookup)
  list                     partition overview: cells, sizes, fan-in/out, requires, orphans
  show <name>              one cell: membrane + in/out crossings + fan-in/out/instability + size
  impact <name>           blast radius: cells that transitively depend on this one
  payload <name>           print a cell's full payload (the context to work it)
  health                   THE GATE: all checks at once (integrity + crossings + structure + size)
  crossings [--diff]       cross-cell imports + leakage; --diff = +/- from your edits
  size                     context-fit: each payload vs the ceiling (warning)
  structure                layer tiers + ADP (no cycles) + Direction (no edges to a higher layer) (warnings)
  graph [--mermaid]        the dependency graph (ASCII tree; --mermaid for Mermaid)
  help                     this text (also --help, -h)
  --version                print the installed version (also -v)

RULES
  leakage    GATE (exit 1)   import a cell you don't require, or require one unused
  integrity  GATE (exit 1)   file in two cells; owned file missing; undeclared ref
  size       warning         payload over max-payload-tokens (default 16000)
  structure  warning         a cycle, or an edge to a higher layer
  orphans    visibility      unowned files aren't violations; list shows them,
                             .cells/ignore hides the intentional ones

FILES (.cells/)
  <name>.cell.toml   declaration: name, purpose, provides[], requires[], layer?
  ownership.toml     the file → cell map (tracked)
  config.toml        max-payload-tokens, [layers] legend (optional; 0 = core),
                     code-dirs[], code-exts[] (per language; default src/test, .ts)
  ignore             gitignore-style patterns for intentionally cell-free files

LANGUAGES: partition/payload/size/owns (and health's integrity check) are language-agnostic — set code-dirs + code-exts
in config.toml. crossings/structure analyze real imports: TS/JS via dependency-cruiser; Python and
Rust via tree-sitter. Other languages need an importer (one per language, picked by extension). Resolution
uses ownership (a module->file map from owned files), not the filesystem — runs on source you're
just reading, nothing to build or install.

Drop into any repo with a .cells/ dir and follow the loop above.
`;
