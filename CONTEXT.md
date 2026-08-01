# Context — cells domain glossary

Load-bearing terms. The vocabulary architecture work (improve-codebase-architecture,
codebase-design) and AI navigation use to name seams. Keep definitions terse; a term earns
its entry by being needed to reason about the code.

## Core model

- **cell** — a named partition of the codebase: a `.cell.toml` declaration (purpose,
  provides, requires, optional layer/signatures/tests) + files assigned to it in the
  ownership store. The unit of review and the unit the payload packs.
- **ownership** — the file→cell map, persisted in `.cells/ownership.toml`. A file belongs
  to at most one cell; unowned files are orphans (not violations).
- **ownership store** — the module (`io.ts`) that reads and writes the ownership map. Its
  invariant: *owned ⟺ not ignored*. Read filters ignored files out; write drops them —
  both ends enforce the same rule, so the file on disk and what cells reads never disagree.
- **declaration** — the authored `.cell.toml` (as opposed to ownership, which is tracked
  state). Renaming a cell rewrites the declaration + ownership + every requires reference.
- **ignore** — `.cells/ignore`: gitignore-style patterns. Ignored files are cell-free:
  excluded from the census, filtered out of ownership on read AND write.

## Analysis

- **crossing** — a file→file import edge between two cells (from-cell → to-cell). The
  derived view: importers produce edges; crossings derive cell pairs from them.
- **undeclared** — a crossing whose from-cell doesn't declare the to-cell in `requires`.
  Gate failure (exit 1). **stale** — a `requires` entry with no matching import: info only.
- **importer** — a per-language plugin implementing the importer contract. Selection is
  automatic by file extension. The contract is two hooks:
  - **analyze** — one AST walk per file: what imports exist (returns declared submodules,
    pub-use re-exports, and use paths; language-specific `uses` shape).
  - **resolveEdges** — semantics: where the uses land (file→file edges + unresolved).
  - **resolve context (ResolveCtx)** — the run-wide facts both hooks resolve against:
    module→file map, file set, crate names, re-export chains, crate-name map, baseDir.
    One object, not a positional param list. The factory parses each file once, runs
    analyze once, enriches the map, then resolves from the stashed facts.
- **unresolved import** — an import that looks local but matched no owned file (broken
  specifier or module-root mismatch). Surfaced as info; compiled extension modules
  (pyo3/cython `.so`) are silenced when present on disk.
- **unit** — the plan's grouping boundary: a Rust crate (`Cargo.toml`), an npm package
  (package.json), or a Python package (`__init__.py`). Precedence at one dir:
  cargo > pyinit > pkg. Files in no unit stay **unowned** — never a catch-all cell.

## Product

- **plan** — suggested cell declarations from units on disk. SUGGESTION ONLY: nothing is
  enforced; `plan --apply` creates stubs + adopts files.
- **payload** — the context packed for one cell: its declaration, owned file contents, and
  neighbor declarations. Measured in token estimate (~3 chars/token) against the
  max-payload-tokens ceiling — a warning, never a gate.
- **gate** — `cells health`'s strict verdict: integrity (validate) + undeclared crossings +
  packaged grammars load. Size/structure are warnings; a failing importer or grammar is a
  gate failure.
- **practices** — information cells surfaces to guide editing, never enforcement:
  deletion-safety wording on leaf impact, dead-at-boundary files and co-change partners
  in `show`, delta classification (`[UNDECLARED]` / `[REQUIRES NOW STALE]`) in `--diff`.
