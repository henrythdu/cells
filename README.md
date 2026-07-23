# Cells

Code organized into **context-bounded cells** — so an LLM (or human) can work **one cell at a time** instead of drowning in the whole codebase.

> **The bet:** mainstream agent tooling computes context by *retrieval* (repo-maps, embeddings, inferred maps). Cells is a contrarian bet on **declared partitions** — the structure is *authored and visible*, not guessed. Coherent membranes + complete ownership beat lossy retrieval.

Cells is **for the model**: its job is to give an LLM a clean, bounded, self-describing unit of context to work in. Humans collaborate; the model is the primary consumer.

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

## Quickstart

```bash
cells init                          # create .cells/ with an empty ownership map
cells assign parser src/parser.ts   # assign a file to a cell (records ownership; stubs the declaration)
$EDITOR .cells/parser.cell.toml     # author the membrane: purpose / provides / requires
cells validate                      # check partition integrity
cells list                          # see the whole partition
```

`assign` records ownership **and** creates a declaration stub if the cell is new. Ownership is *non-overlapping* — a file belongs to exactly one cell (the file itself isn't relocated on disk; only its owning cell changes).

---

## Commands

| command | what it does |
| --- | --- |
| `cells init` | bootstrap `.cells/` (idempotent) |
| `cells assign <cell> <file...>` | assign file(s) to a cell (records ownership; stubs declaration if new) |
| `cells unassign <file...>` | remove file(s) from their cell (→ orphan) |
| `cells owns <file>` | which cell owns this file? (reverse lookup; orphan-aware) |
| `cells list` | partition overview: each cell's files / size / fan-in·fan-out / requires + orphans |
| `cells show <name>` | one cell's membrane + its in/out crossings + fan-in/fan-out/instability + size |
| `cells impact <name>` | blast radius: cells that transitively depend on this one (change-safety) |
| `cells payload <name>` | print a cell's full payload (membrane + code + neighbors) — the context to work it |
| `cells validate` | partition integrity (duplicates, dangling refs, undeclared cells, unknown requires) |
| `cells crossings` | derived cross-cell imports + **leakage** check |
| `cells size` | context-fit: each cell's payload vs the ceiling (warning) |
| `cells structure` | layer tiers + ADP (no cycles) + Direction (no edges to a higher layer) — warnings |
| `cells graph [--mermaid]` | the cell dependency graph (ASCII tree default; `--mermaid` for Mermaid source) |

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
provides = ["parseCell", "Cell"]    # declared surface
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
max-payload-tokens = 16000                                 # context-fit ceiling (default 16000)
# [layers]                              # optional legend (rank → label); 0 = core, higher = peripheral
# 0 = "domain"
# 1 = "application"
# 2 = "infrastructure"
code-dirs = ["src", "test"]                                # dirs scanned for code (default)
code-exts = [".ts"]                                        # extensions counted (default; set per language)
```

### `ignore` — intentionally cell-free files

gitignore-style globs. Matched files aren't counted as code and never surface as orphans (examples, scratch, scripts):

```text
examples/**
*.tmp
```

### Language support

**Partition, payload, size, validate, and owns** are language-agnostic — set `code-dirs` and `code-exts` in `config.toml` to point Cells at your code (e.g. `["lib", "cmd"]` + `[".go"]`).

**Crossings and structure** (leakage, ADP, direction, metrics) analyze *real imports*:

- **TypeScript/JavaScript** via `dependency-cruiser` (source-based; handles path aliases, `.js`→`.ts`).
- **Python** via `tree-sitter` (WASM; bundled grammar, no native build).
- **Rust** via `tree-sitter` (WASM; handles `use`/`super`/`self`, groups, re-exports).
- Other languages need an importer — one per language, selected automatically by file extension.

Resolution doesn't chase the filesystem or require the repo to build/install: it derives a module→file map from ownership, so it runs on source you're just reading. (Dogfooded on a 50-file Python repo — 56 crossings; and a 61-file Rust repo — 62 crossings, `structure` surfaced a real UI/app cycle.)

---

## The rules

| rule | severity | what it catches |
| --- | --- | --- |
| **Leakage** | **gate** (exit 1) | a cell imports another it doesn't `require` (undeclared), or `requires` one it never imports (stale) |
| **Integrity** | **gate** (exit 1) | a file in two cells; an owned file missing from disk; a requires or ownership key pointing at an undeclared cell |
| **Size** | warning (exit 0) | a cell's payload exceeds `max-payload-tokens` (default 16000) — consider dividing |
| **Structure** | warning (exit 0) | a cycle (ADP), or an edge to a higher layer (Direction) |
| **Orphans** | visibility (not a violation) | unowned files — shown by `list`; `.cells/ignore` declares the intentional ones |

**Payload = tokens**, estimated at chars/4 (model-agnostic). It includes the cell's membrane + owned files + its neighbors' membranes.

---

## Working with a Cells project (for agents)

Drop into a repo with a `.cells/` dir and follow this loop:

1. **Orient** — `cells list`: see the cells, their sizes, and any unowned files.
2. **Zoom in** — `cells show <name>`: a cell's membrane + what it depends on / what depends on it.
3. **Retrieve** — `cells payload <name>`: the full context (membrane + code + neighbors) to work that cell.
4. **Assess** — `cells impact <name>`: blast radius — who transitively depends on this cell? Weigh the risk *before* editing (a core cell can break many; a leaf is safe to change).
5. **Work** — edit the cell's files. Stay within its membrane.
6. **Place new code** — a new file needs a home. Read `list`, decide which cell (it's *your* judgment, not Cells'), then `cells assign <cell> <file>`. (Unowned files aren't violations — `list` shows them as a reminder; `.cells/ignore` hides the intentional ones.)
7. **Check** — `cells validate` (integrity) · `cells crossings` (leakage) · `cells size` (context-fit) · `cells structure` (cycles / direction).
8. **Navigate** — `cells graph` for the structure at a glance; `cells owns <file>` for a reverse lookup.

**Divide when a cell grows past the ceiling:** split its files across new cells with `assign`. There's no separate "divide" command — `assign` *is* the repartition tool.

---

## Install

**For users** — one command, from GitHub:

```bash
npm install -g github:henrythdu/cells
```

npm fetches the repo, builds `dist/` via the `prepare` script, and links the `cells` command. Requires Node (ESM).

**From source** (development):

```bash
git clone https://github.com/henrythdu/cells.git
cd cells
pnpm install      # installs deps + builds dist/ via prepare
npm link          # live symlink into dist/ for local edits
```

Runtime dependencies (`dependency-cruiser`, `smol-toml`, `minimatch`, `web-tree-sitter`; Python + Rust grammar WASMs bundled in `grammars/`) are installed automatically.

---

*Cells dogfoods itself: this codebase is partitioned into 14 cells. Run `cells list` to see.*
