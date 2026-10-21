# Cells

> New issues and PRs from new contributors are auto-closed by default.
> Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

[![npm version](https://img.shields.io/npm/v/@henrythdu/cells?style=flat-square)](https://www.npmjs.com/package/@henrythdu/cells)

There are many ways to keep the architecture of a codebase consistent. Cells is one of them. The architecture is **authored and visible**, so every agent, every session, and every model shares the same declared structure instead of deriving a new one.

- Every file has a named home: **a cell**.
- Every cell has a written contract: **a membrane** (`name`, `purpose`, `provides`, `requires`).
- Every cross-cell dependency is a **derived crossing**, computed from real imports and never written by hand.

The dependency checks come from Clean Architecture: dependencies point toward the core, and there are no cycles. Cells applies them as visible warnings and not as academic ceremony.

---

## Install

```bash
npm install -g @henrythdu/cells
```

The tool requires Node and ESM. The git version and the npm version always match, because the project tags every npm publish in git.

**From source:**

```bash
git clone https://github.com/henrythdu/cells.git
cd cells
pnpm install      # installs deps + builds dist/ via prepare
npm link          # live symlink into dist/ for local edits
```

The runtime dependencies install automatically: `smol-toml`, `minimatch`, and `web-tree-sitter`. The grammar WASM files are bundled in `grammars/`.

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

`assign` records ownership and creates a declaration stub when the cell is new. Ownership does not overlap: a file belongs to exactly one cell. The command does not move the file on disk. It changes only the owning cell.

---

## Handing work to an agent

Point the agent at a repository and tell it to run `cells help`. The tool documents itself, and that is the whole handoff. The agent follows this loop: `list` (orient), `show` (zoom), `payload` (retrieve), `impact` (assess), then edit inside the membrane, and `health` (check). You review the changes to the partition and the membranes. The agent works the cells.

---

## The mental model

| term | meaning |
| --- | --- |
| **Cell** | a context-bounded unit of code that solves ONE problem and fits a context window. Has a *membrane* (contract) + *owned files* (body). |
| **Partition** | the complete, non-overlapping assignment of every code file to exactly one cell. (A file is the atomic unit.) |
| **Membrane** | a cell's declaration — `name`, `purpose`, `provides`, `requires`. What you read first to understand a cell. |
| **Crossing** | a real dependency from one cell's code into another's (derived from imports). The seams between cells. |
| **Payload** | what a model consumes to work a cell — its membrane + owned files + its neighbors' membranes. Measured in tokens (~chars/3). |
| **Metrics** | per-cell **fan-in** / **fan-out** (distinct cells it's depended-on-by / depends-on) and **instability** I = fan-out ÷ (fan-in + fan-out): 0 = stable, 1 = unstable. Shown in `list` and `show`; derived from crossings, free. |

**Three storage truths:**

- **Ownership is *tracked***. The file is `ownership.toml`, and `assign` manages it.
- **Declarations are *authored***. The files are `*.cell.toml`, and you write the membrane.
- **Crossings are *derived***. The tool computes them from real imports, and nobody writes them by hand.

**One principle:** *visibility over enforcement.* Cells shows the structure and its problems and rarely blocks. The exceptions are integrity, undeclared leakage, and broken grammars. See Rules.

---

## Commands

<details>
<summary>Full command reference (also in <code>cells help</code>)</summary>

| command | what it does |
| --- | --- |
| `cells init [--dry-run]` | Create the `.cells/` directory. The command detects your language from `code-exts` and `code-dirs`. It is idempotent, and `--dry-run` shows the plan first. |
| `cells plan [--apply] [--dry-run]` | Propose a cell partition. A crate, an npm package, or a Python **init** package becomes one cell, and other files group by directory. The command prints the declarations and the ownership map for review and writes nothing. `--apply` creates the cells and adopts the files without user input. It never overwrites an existing cell and never takes curated ownership. `--dry-run` shows the plan first. |
| `cells assign <cell> <file...>` | Assign files to a cell. The command records ownership and creates a declaration stub when the cell is new. |
| `cells new <name> [--purpose "..."] [--provides a,b] [--requires a,b] [--layer N]` | Create a cell declaration (`.cell.toml`). Declare the contract first, and then use `assign` to put files in the cell. |
| `cells prune-stale [--apply]` | Remove `requires` entries that a cell declares but never imports (stale entries). The command is a dry run by default, and `--apply` rewrites the declaration files. |
| `cells unassign <file...>` | Remove files from their cell, so the files become orphans. |
| `cells rename <old> <new>` | Rename a cell in the store: the file, the ownership keys, and the `requires` references. |
| `cells remove <cell> [--force]` | Delete the declaration of a cell. The owned files become orphans, unless `--force` also removes them. |
| `cells owns <file>` | Show which cell owns a file (reverse lookup, including orphans). |
| `cells list [--verbose]` | Show the partition: the files, size, fan-in and fan-out, and `requires` of each cell, plus the orphans. `--verbose` adds a health line for each cell: size percentage, stale `provides`, and unresolved imports. |
| `cells show <name> [--verbose]` | Show one cell: its membrane, its in and out crossings (aggregated above 8 edges, with `--verbose` for the raw list), fan-in, fan-out, instability, size, files that no other cell imports, change-coupled partners, stale `provides`, and unresolved imports. |
| `cells surface <name>` | Print the export-like declaration lines of the cell (file:line). This is the starting point for the `signatures` field of the membrane. |
| `cells impact <name>` | Show the blast radius: the cells that depend on this cell, directly or transitively (change safety). |
| `cells payload <name>` | Print the full payload of a cell: the membrane, the code, the neighbors, and the cells that depend on you. This is the context for work on the cell. |
| `cells health [--verbose] [--summary]` | **The gate.** Run all checks at once: integrity (duplicates, dangling references, undeclared cells), crossings (**undeclared** leakage fails the gate and **stale** is information), a broken packaged grammar WASM, structure (cycles and direction), and size. The command exits with code 1 only for integrity, undeclared leakage, or a grammar failure (the strict gate). Size and structure are warnings (⚠) with exit 0. `--verbose` names the failing undeclared edges inline and saves a run of `crossings`. `--summary` groups the unresolved entries by file, which is the triage unit for a repository with many unresolved imports. The output ends with a machine-parseable `health: X.Xs` timing line. |
| `cells crossings [--diff] [--verbose] [--json] [--warnings]` | Show the derived cross-cell imports and the **leakage** check. `--diff` shows the crossings that your uncommitted edits added or removed. `--warnings` shows leakage and unresolved imports only, with no pair listing (the actionable tail on a large repository). `--verbose` names the off-membrane symbols inline. `--json` is the machine surface. |
| `cells imports [--json]` | Show the raw file-to-file import graph (resolved edges and unresolved specifiers). This is the machine surface for other tools. |
| `cells size` | Show the context fit: the payload of each cell against the ceiling (a warning). A cell over the ceiling lists **peel candidates**, which are the largest files that few other files import. A cell can declare its own ceiling with `ceiling = N` in its `.cell.toml`: the same check with its own number. |
| `cells config [set max-payload-tokens <N>]` | Show the effective configuration, with the defaults where the file has no value. `set` changes the global ceiling in place and keeps the comments and the other keys. |
| `cells structure [--summary]` | Show the layer tiers and the checks for ADP (no cycles), Direction (dependencies point toward the core), and SDP (dependencies run toward stability). All are information or warnings. For a cycle, the command suggests the cheapest edge to cut. `--summary` is the triage view: one line for each cycle (size and cheapest edges) and the counts. |
| `cells graph [--mermaid]` | Show the dependency graph of the cells. The default is an ASCII tree, and `--mermaid` gives Mermaid source. |
| `cells help` | Show this text (also `--help` and `-h`). The tool documents itself, and you run this command first in any repository. |

</details>

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
provides = ["parseCell", "Cell"]    # authored docs of the cell's surface (shown in show/payload; reference-checked when symbol-shaped — stale/unread info; prose tolerated)
requires = ["token", "diagnostic"]  # neighbor CELL names
# optional — couplings static analysis can't see (data files, runtime loading, shared
# schema). Integrity-checked and included in payloads; never import-audited:
data-requires = ["translations"]
layer = 0                         # optional — 0 = core; higher = more peripheral (direction)
```

### `ownership.toml` — the file→cell map

```toml
[parser]
files = [
  "src/parser.ts",
]

[cli]
files = [
  "src/cli.ts",
  "test/cli.test.ts",
]
```

Serialized deterministically (sorted cells, sorted files, one per line) so parallel
branches that touch different cells merge cleanly.

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

**Partition, payload, size, and owns** do not depend on the language. Set `code-dirs` and `code-exts` in `config.toml` to point Cells at your code, for example `["lib", "cmd"]` and `[".go"]`.

**Crossings and structure** (leakage, ADP, direction, and metrics) analyze *real imports*:

- **TypeScript, JavaScript, and TSX** through `tree-sitter` (WASM). The importer resolves tsconfig `paths` aliases, workspace `package.json` files, and `.js` to `.ts` remaps.
- **Python** through `tree-sitter` (WASM). The grammar is bundled, so no native build is necessary.
- **Rust** through `tree-sitter` (WASM). The importer handles `use`, `super`, `self`, groups, and re-exports.
- **Go** through `tree-sitter` (WASM). The importer resolves packages to directories and handles nested `go.mod` sub-modules.
- **C and C++** through `tree-sitter` (WASM). The importer resolves `#include` to a file. A quoted include is local. An angle include is external unless a cell owns the file. The importer probes the directory of the importing file and the `-I` roots of the repository that the census provides.
- **Java** through `tree-sitter` (WASM). The importer resolves a fully qualified class import through the package declaration, so the file layout does not matter. A wildcard gives one representative edge for each package.
- Another language needs an importer: one importer for each language, selected automatically by the file extension.

**What importers cannot see (static-analysis blind spots, named for each language):**

- Python: `importlib`, `__import__`, and module names that a string builds.
- Rust: paths that a procedural macro expands.
- Go: coupling through `reflect`, and the relation between a generator and its generated code.
- Java: static imports only, and nothing outside the source files of the repository.
- C and C++: `#include` only, and no path that a macro computes.
- TypeScript: specifiers that a string builds (plugin loaders) do not resolve.

The derived graph is honest about what it derived. When a coupling that the importer cannot see is important, declare it in the membrane. The authored declaration is the only source of truth for an invisible channel.

**Named-symbol visibility** (what the membrane check can audit):

- TypeScript, JavaScript, and TSX: named imports (`import { a, b } from '…'`, with aliases removed to the exported name) and namespace-attribute uses (`import * as ns` and `ns.portion` give `portion`, the first tail segment). Default-import attributes are excluded, for sub-export granularity.
- Python: the names in `from M import a, b`.
- Rust: the tail items of a `use` path (`use a::b::Item` gives `Item`).

A module-level dependency and a C, C++, Go, or Java edge carry no symbol, so they are exempt by construction. This list names them instead of hiding them.

To add a language, write an importer specification in `src/languages/`. A tree-sitter language uses a specification for the shared factory in `src/languages/tree-sitter.ts`. Another language needs a custom `extract`. Then add one line to `DEFAULT_IMPORTERS` in `src/importers.ts`.

The cells of this repository show the pattern. Run `cells new` for the language cell first, and then `cells health` enforces the declaration.

Resolution does not read the whole file system, and the repository does not need to build or install. The tool derives a module-to-file map from ownership, so it works on source code that you only read.

---

## The rules

| rule | severity | what it catches |
| --- | --- | --- |
| **Leakage (undeclared)** | **gate** (exit 1) | A cell imports another cell and does not `require` it. This is a hidden dependency. |
| **Leakage (stale)** | info (exit 0) | A cell `requires` a cell that it never imports. Remove the entry, or move it to `data-requires` when the coupling is real but invisible to static analysis. The report shows the entry and the gate does not fail. |
| **Integrity** | **gate** (exit 1) | A file belongs to two cells. An owned file is missing from disk. A `requires` key or an ownership key points to a cell with no declaration. |
| **Size** | warning (exit 0) | The payload of a cell is over its ceiling: `max-payload-tokens` (default 16000, set with `cells config set` or in `config.toml`), or the own `ceiling = N` of the cell. Consider a division. |
| **Structure** | warning (exit 0) | A cycle (ADP), an edge to a higher layer (Direction), or a stable cell that depends on a less stable cell (SDP). |
| **Membrane** | warning (exit 0) | A cell imports **named symbols** that the `provides` list of the target does not contain. An empty `provides` list on a consumed cell means the membrane is incomplete. `cells crossings --verbose` names the symbols; converge the list. |
| **Orphans** | visibility (not a violation) | Files that no cell owns. `list` shows them, and `.cells/ignore` declares the intentional ones. |

Payload tokens are estimated at chars/3. This is a rough but consistent proxy across models, and it is not exact for any model. The ceiling is a budget and not a limit: nothing breaks when a cell exceeds it. A cell at 1.5 times the ceiling is often the right call for a coherent unit. The gate does not care, and your judgment is what matters. The low default is also a module-size discipline: it is small enough that any current model can hold the payload. A per-cell `ceiling = N` allows a legitimately large cell without raising the bar for every cell.

---

*Cells uses itself: this codebase is divided into 32 cells. Run `cells list` to see them.*
