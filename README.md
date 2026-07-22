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
| `cells owns <file>` | which cell owns this file? (reverse lookup; orphan-aware) |
| `cells list` | partition overview: each cell's files / size / requires + any unowned files |
| `cells show <name>` | one cell's membrane + its in/out crossings + size |
| `cells payload <name>` | print a cell's full payload (membrane + code + neighbors) — the context to work it |
| `cells validate` | partition integrity (duplicates, dangling refs, undeclared cells, unknown requires) |
| `cells crossings` | derived cross-cell imports + **leakage** check |
| `cells size` | context-fit: each cell's payload vs the ceiling (warning) |
| `cells structure` | ADP (no cycles) + Direction (no high→low layer edges) — warnings |
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
layer = "domain"                    # optional — for direction policy
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
layers = ["infrastructure", "application", "domain"]       # optional; index 0 = lowest
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

**Crossings and structure** (leakage, ADP, direction) currently analyze TypeScript/JavaScript imports via dependency-cruiser. On other languages they report no crossings until a language-specific importer is added (on the roadmap).

---

## The rules

| rule | severity | what it catches |
| --- | --- | --- |
| **Leakage** | **gate** (exit 1) | a cell imports another it doesn't `require` (undeclared), or `requires` one it never imports (stale) |
| **Integrity** | **gate** (exit 1) | a file in two cells; an owned file missing from disk; a requires or ownership key pointing at an undeclared cell |
| **Size** | warning (exit 0) | a cell's payload exceeds `max-payload-tokens` (default 16000) — consider dividing |
| **Structure** | warning (exit 0) | a cycle (ADP), or a high→low layer edge (Direction) |
| **Orphans** | visibility (not a violation) | unowned files — shown by `list`; `.cells/ignore` declares the intentional ones |

**Payload = tokens**, estimated at chars/4 (model-agnostic). It includes the cell's membrane + owned files + its neighbors' membranes.

---

## Working with a Cells project (for agents)

Drop into a repo with a `.cells/` dir and follow this loop:

1. **Orient** — `cells list`: see the cells, their sizes, and any unowned files.
2. **Zoom in** — `cells show <name>`: a cell's membrane + what it depends on / what depends on it.
3. **Retrieve** — `cells payload <name>`: the full context (membrane + code + neighbors) to work that cell.
4. **Work** — edit the cell's files. Stay within its membrane.
5. **Place new code** — a new file needs a home. Read `list`, decide which cell (it's *your* judgment, not Cells'), then `cells assign <cell> <file>`. (Unowned files aren't violations — `list` shows them as a reminder; `.cells/ignore` hides the intentional ones.)
6. **Check** — `cells validate` (integrity) · `cells crossings` (leakage) · `cells size` (context-fit) · `cells structure` (cycles / direction).
7. **Navigate** — `cells graph` for the structure at a glance; `cells owns <file>` for a reverse lookup.

**Divide when a cell grows past the ceiling:** split its files across new cells with `assign`. There's no separate "divide" command — `assign` *is* the repartition tool.

---

## Install

From source (this repo):

```bash
pnpm install
pnpm build        # tsc → dist/
npm link          # makes `cells` available globally (live symlink into dist/)
```

Requires Node (ESM). Runtime dependencies: `smol-toml`, `dependency-cruiser`, `minimatch`.

---

*Cells dogfoods itself: this codebase is partitioned into 12 cells. Run `cells list` to see.*
