# Cells

> New issues and PRs from new contributors are auto-closed by default.
> Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

[![npm version](https://img.shields.io/npm/v/@henrythdu/cells?style=flat-square)](https://www.npmjs.com/package/@henrythdu/cells)

Code organized into **context-bounded cells** — so an LLM (or human) can work **one cell at a time** instead of drowning in the whole codebase.

---

## The problem

A real codebase is bigger than any single context — human or model. Anyone working in it has to work in *units*: grab a slice of code, make a change, move on. The question is **what slice, and who decides**.

Left to drift, an agent (LLM or human) makes the same mistakes:

- **It forgets the partition between sessions** — the boundaries it respected yesterday are invisible today.
- **It duplicates a helper that already lives one cell over** — because it never saw that cell.
- **It drops a new file in the wrong layer** — nothing tells it the codebase has layers.
- **It erodes the structure it was asked to preserve** — change by change, the seams blur.

For an LLM this is acute: the context window is bounded, the repo is not, and the model has no memory of the architecture between sessions. Mainstream agent tooling answers with *retrieval*: repo-maps, embeddings, inferred dependency graphs. The tool guesses at structure and feeds the model a snapshot. Guesses are **lossy** — and worse, they're **invisible**: the model can't tell what's real architecture and what's a guess, and the guess changes run to run.

For a human the cost is slower but real: architecture that lives only in heads (or not at all), reviewed case-by-case, re-derived by every newcomer.

## The bet

Cells bets the other way: **declared partitions**. The structure is *authored and visible*, not guessed.

- Every file has a named home — **a cell**.
- Every cell has a written contract — **a membrane** (`name`, `purpose`, `provides`, `requires`).
- Every cross-cell dependency is a **declared crossing** — derived from real imports, never hand-written.

Coherent membranes + complete ownership beat lossy retrieval. Cells is **for the model**: its job is to give an LLM a clean, bounded, self-describing unit of context to work in. Humans collaborate — they author the membranes and curate the partition; the model is the primary consumer. The model works *inside* a membrane instead of guessing at an invisible whole, so it stays **structure-aware**, not just text-aware.

---

## Install

**For users:**

```bash
npm install -g @henrythdu/cells
```

npm fetches the package, builds `dist/` via the `prepare` script, and links the `cells` command. Requires Node (ESM). Git and npm versions always match — every npm publish is tagged in git.

**From source** (development):

```bash
git clone https://github.com/henrythdu/cells.git
cd cells
pnpm install      # installs deps + builds dist/ via prepare
npm link          # live symlink into dist/ for local edits
```

Runtime dependencies (`smol-toml`, `minimatch`, `web-tree-sitter`; grammar WASMs bundled in `grammars/`) are installed automatically.

---

## Quickstart

```bash
cells init                          # create .cells/ — detects your language (code-exts/code-dirs)
cells plan                          # propose a partition: crates / npm packages / Python packages become one cell each (review, then curate)
cells plan --apply                  # or create the proposed cells + ownership mechanically (dry-run: add --dry-run)
cells assign parser src/parser.ts   # assign a file to a cell (records ownership; stubs the declaration)
$EDITOR .cells/parser.cell.toml     # author the membrane: purpose / provides / requires
cells health                        # the gate: every check at once (integrity + crossings + grammars + structure + size)
cells list                          # see the whole partition
```

`assign` records ownership **and** creates a declaration stub if the cell is new. Ownership is *non-overlapping* — a file belongs to exactly one cell (the file itself isn't relocated on disk; only its owning cell changes).

---

## The mental model

| term | meaning |
| --- | --- |
| **Cell** | a context-bounded unit of code that solves ONE problem and fits a context window. Has a *membrane* (contract) + *owned files* (body). |
| **Partition** | the complete, non-overlapping assignment of every code file to exactly one cell. (A file is the atomic unit.) |
| **Membrane** | a cell's declaration — `name`, `purpose`, `provides`, `requires`. What you read first to understand a cell. |
| **Crossing** | a real dependency from one cell's code into another's (derived from imports). The seams between cells. |
| **Payload** | what a model consumes to work a cell — its membrane + owned files + its neighbors' membranes. Measured in tokens. |
| **Metrics** | per-cell **fan-in** / **fan-out** (distinct cells it's depended-on-by / depends-on) and **instability** I = fan-out ÷ (fan-in + fan-out): 0 = stable, 1 = unstable. Shown in `list` and `show`; derived from crossings, free. |

**Three storage truths:**

- **Ownership is *tracked*** — `ownership.toml`, machine-managed by `assign`.
- **Declarations are *authored*** — `*.cell.toml`, you write the membrane.
- **Crossings are *derived*** — computed from real imports, never hand-written.

**One principle:** *visibility over enforcement.* Cells shows you the structure and its problems; it rarely blocks. (The exception is leakage — see Rules.)

---

## Commands

| command | what it does |
| --- | --- |
| `cells init [--dry-run]` | bootstrap `.cells/` — detects your language (code-exts/code-dirs) (idempotent; `--dry-run` previews) |
| `cells plan [--apply] [--dry-run]` | propose a cell partition: crates / npm packages / Python **init** packages become one cell each, other files group by directory (prints declarations + ownership to review — writes nothing). `--apply` creates the cells + adopts the files mechanically (never overwrites existing cells or steals curated ownership); `--dry-run` previews |
| `cells assign <cell> <file...>` | assign file(s) to a cell (records ownership; stubs declaration if new) |
| `cells new <name> [--purpose "..."] [--provides a,b] [--requires a,b] [--layer N]` | scaffold a cell declaration (`.cell.toml`) — declare the contract first, then `assign` files into it |
| `cells prune-stale [--apply]` | remove requires that are declared but never imported (stale); dry-run by default, `--apply` rewrites the declaration files |
| `cells unassign <file...>` | remove file(s) from their cell (→ orphan) |
| `cells rename <old> <new>` | rename a cell across the store (file, ownership keys, requires refs) |
| `cells remove <cell> [--force]` | delete a cell's declaration (ownership freed → orphans unless `--force` also clears them) |
| `cells owns <file>` | which cell owns this file? (reverse lookup; orphan-aware) |
| `cells list [--verbose]` | partition overview: each cell's files / size / fan-in·fan-out / requires + orphans; `--verbose` adds a per-cell health line (size%, stale provides, unresolved) |
| `cells show <name> [--verbose]` | one cell's membrane + in/out crossings (aggregated past 8 edges; `--verbose` for raw) + fan-in/fan-out/instability + size + dead-at-boundary files + change-coupled partners + stale provides + unresolved imports |
| `cells surface <name>` | print the cell's export-like declaration lines (file:line) — the starting point for populating the membrane `signatures` field |
| `cells impact <name>` | blast radius: cells that transitively depend on this one (change-safety) |
| `cells payload <name>` | print a cell's full payload (membrane + code + neighbors + the cells that depend on you) — the context to work it |
| `cells health [--verbose] [--summary]` | **the gate** — all checks at once: integrity (duplicates, dangling refs, undeclared cells) + crossings (**undeclared** leakage gate-fails; **stale** is informational) + a broken packaged grammar WASM + structure (cycles / direction) + size. Exits 1 only on integrity + undeclared leakage + grammars (strict gate); size/structure are exit-0 warnings (⚠). `--verbose` names failing undeclared edges inline (saves the `crossings` round-trip); `--summary` collapses unresolved entries into per-file groups (the triage unit for high-unresolved repos). Output ends with a machine-parseable `health: X.Xs` timing line. |
| `cells crossings [--diff] [--warnings]` | derived cross-cell imports + **leakage** check; `--diff` shows crossings your uncommitted edits added/removed; `--warnings` = leakage + unresolved only (no pair listing — the actionable tail on a big repo) |
| `cells imports [--json]` | raw file→file import graph (resolved edges + unresolved specifiers) — the machine surface for tooling |
| `cells size` | context-fit: each cell's payload vs the ceiling (warning); over-ceiling cells list **peel candidates** — biggest files few others import. A cell can declare its own ceiling (`ceiling = N` in its `.cell.toml`) — same check, its own number |
| `cells config [set max-payload-tokens <N>]` | read the effective config (defaults where the file omits); `set` edits the global ceiling in place — comments and other keys preserved |
| `cells structure [--summary]` | **Clean Architecture, made visible**: layer tiers + ADP (no cycles) + Direction (deps point toward core) + SDP (deps run toward stability) — the dependency rule, checked. All info/warnings; cycles suggest the cheapest edge to cut. `--summary` is the triage view: one line per cycle (size + cheapest edges) + counts — for high-cycle repos (kafka 19, elasticsearch 126) where the full chains dominate |
| `cells graph [--mermaid]` | the cell dependency graph (ASCII tree default; `--mermaid` for Mermaid source) |
| `cells help` | this text (also `--help`, `-h`) — the tool's self-documentation; run it first in any repo |

---

## The `.cells/` directory

```text
.cells/
  <name>.cell.toml     # declarations (authored) — one per cell
  ownership.toml       # file → cell map (tracked)
  config.toml          # settings (optional)
  ignore               # gitignore-style patterns (optional)
```

### `.cell.toml` — a cell's membrane

```toml
name = "parser"
purpose = "Turn a .cell declaration file into a checked Cell AST."
provides = ["parseCell", "Cell"]    # authored docs of the cell's surface (shown in show/payload; not symbol-checked)
requires = ["token", "diagnostic"]  # neighbor CELL names
layer = 0                         # optional — 0 = core; higher = more peripheral (direction)
```

### `ownership.toml` — the file→cell map

```toml
[parser]
files = ["src/parser.ts"]

[cli]
files = ["src/cli.ts", "test/cli.test.ts"]
```

### `config.toml` — settings

```toml
max-payload-tokens = 16000                                 # context-fit ceiling — the per-repo knob for cell size (default 16000); edit in place or `cells config set max-payload-tokens <N>`
# One cell can declare its own ceiling — add `ceiling = N` to its .cell.toml for a
# legitimately-big unit (a huge crate) without raising the bar for every cell.
# It's still a budget: over it, size/health flag it just like any over-ceiling cell.
# [layers]                              # optional legend (rank → label); 0 = core, higher = peripheral
# 0 = "domain"
# 1 = "application"
# 2 = "infrastructure"
code-dirs = ["src", "test"]                                # dirs scanned for code (`cells init` auto-detects)
code-exts = [".ts"]                                        # extensions counted (`cells init` auto-detects; set per language)
# skip-dirs = []                                            # dir names the census never walks (node_modules, dist, build,
#                                                          # target, .git, .cells, vendor, .venv, ...). Setting this REPLACES
#                                                          # the defaults — the unhide path for a real internal/build package.
```

### `ignore` — intentionally cell-free files

gitignore-style globs (a trailing `/` marks a directory → its whole tree, like gitignore's `dir/`).
Matched files aren't counted as code and never surface as orphans (examples, scratch, scripts):

```text
examples/**
*.tmp
vendor/
```

---

## Language support

**Partition, payload, size, and owns** are language-agnostic — set `code-dirs` and `code-exts` in `config.toml` to point Cells at your code (e.g. `["lib", "cmd"]` + `[".go"]`).

**Crossings and structure** (leakage, ADP, direction, metrics) analyze *real imports*:

- **TypeScript/JavaScript/TSX** via `tree-sitter` (WASM; tsconfig `paths` aliases, workspace `package.json` resolution, `.js`→`.ts` remaps).
- **Python** via `tree-sitter` (WASM; bundled grammar, no native build).
- **Rust** via `tree-sitter` (WASM; handles `use`/`super`/`self`, groups, re-exports).
- **Go** via `tree-sitter` (WASM; package→directory resolution, nested `go.mod` sub-modules).
- **C/C++** via `tree-sitter` (WASM; `#include` → file resolution: quoted = local, angle = external unless owned; probes importer-dir + repo `-I` roots derived from the census).
- **Java** via `tree-sitter` (WASM; fully-qualified class imports → package-decl resolution, layout-agnostic; wildcards → one representative edge per package).
- Other languages need an importer — one per language, selected automatically by file extension.

Adding a language: write an importer spec in `src/languages/` (tree-sitter langs: a spec for the
shared factory in `src/languages/tree-sitter.ts`; otherwise a custom `extract`) + one line in
`DEFAULT_IMPORTERS` in `src/importers.ts`. The repo's own cells show the pattern — `cells new`
the language cell declare-first, then `cells health` enforces the declaration.

Resolution doesn't chase the filesystem or require the repo to build/install: it derives a module→file map from ownership, so it runs on source you're just reading. (Dogfooded on a 50-file Python repo — 56 crossings; and a 61-file Rust repo — 62 crossings, `structure` surfaced a real UI/app cycle.)

---

## The rules

| rule | severity | what it catches |
| --- | --- | --- |
| **Leakage (undeclared)** | **gate** (exit 1) | a cell imports another it doesn't `require` — a hidden dependency |
| **Leakage (stale)** | info (exit 0) | a cell `requires` one it never imports — maybe a data dependency or future plan (shown, doesn't fail the gate) |
| **Integrity** | **gate** (exit 1) | a file in two cells; an owned file missing from disk; a requires or ownership key pointing at an undeclared cell |
| **Size** | warning (exit 0) | a cell's payload exceeds its ceiling — `max-payload-tokens` (default 16000 — configurable via `cells config set` or `config.toml`), or the cell's own `ceiling = N` — consider dividing |
| **Structure** | warning (exit 0) | a cycle (ADP), an edge to a higher layer (Direction), or a stable cell depending on a less-stable one (SDP) |
| **Orphans** | visibility (not a violation) | unowned files — shown by `list`; `.cells/ignore` declares the intentional ones |

**Payload = tokens**, estimated at chars/3 (model-agnostic). It includes the cell's membrane + owned files + its neighbors' membranes.

**The estimate is crude — and that's fine.** Every LLM tokenizes differently (and the same LLM at different settings); chars/3 is a rough, consistent proxy. The ceiling is **not a hard limit** — nothing breaks when a cell exceeds it. Its purpose is to make the model (or human) *conscious* of cell size before pulling a payload: the warning is "this cell is getting big — do you really want to read it whole?", not "this cell is invalid." A cell at 1.5× the ceiling is often the right call for a coherent unit; the gate doesn't care, it's your judgment that matters.

---

## Working with a Cells project (for agents)

> **Cold start? Run `cells help`.** The command list and descriptions are self-describing — it's the real front door for this tool. Point an agent at a repo and ask it to run `cells help`; that alone is enough to orient and pick up the loop below, whether the repo has a `.cells/` dir yet or not.

Drop into a repo with a `.cells/` dir and follow this loop:

1. **Orient** — `cells list`: see the cells, their sizes, and any unowned files.
2. **Zoom in** — `cells show <name>`: a cell's membrane + what it depends on / what depends on it.
3. **Retrieve** — `cells payload <name>`: the full context (membrane + code + neighbors) to work that cell.
4. **Assess** — `cells impact <name>`: blast radius — who transitively depends on this cell? Weigh the risk *before* editing (a core cell can break many; a leaf is safe to change).
5. **Work** — edit the cell's files. Stay within its membrane.
6. **Place new code** — a new file needs a home. Read `list`, decide which cell (it's *your* judgment, not Cells'), then `cells assign <cell> <file>`. (Unowned files aren't violations — `list` shows them as a reminder; `.cells/ignore` hides the intentional ones.)
7. **Check** — `cells health` (the gate — every check at once). Drill in if it fails: `cells crossings` (leakage), `cells size` (context-fit), `cells structure` (cycles / direction).
8. **Navigate** — `cells graph` for the structure at a glance; `cells owns <file>` for a reverse lookup.

**Divide when a cell grows past the ceiling:** split its files across new cells with `assign`. There's no separate "divide" command — `assign` *is* the repartition tool. **Merge is the reverse and deliberately manual too** (`assign` the files over, `remove` the empty cell) — there's no `merge` command: the two steps are the moment to reconsider, and the size warning that follows is the honest cost. If a big cell is big *on purpose* (a huge crate), declare `ceiling = N` in its `.cell.toml` instead of raising the global bar for every cell.

---

*Cells dogfoods itself: this codebase is partitioned into 31 cells. Run `cells list` to see.*
