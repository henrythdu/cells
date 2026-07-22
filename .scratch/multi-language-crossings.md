# Multi-Language Crossing Support — Design

## Context

Cells' core (partition, payload, size, validate, list, owns) is already language-agnostic — the configurable census (`code-dirs` / `code-exts`) unblocked Python with zero code change (verified in the PID_Inference dogfood). Exactly **one** subsystem is language-coupled: **crossing extraction** (`collectImportEdges` → dependency-cruiser, TS/JS-only). This design covers making crossings — and the metrics that derive from them — work across languages.

## Principle: source-based, never execute

Cells reads **source** and never runs the code (consistent with census/payload — all text). This serves Cells' primary use case: **onboarding to a repo you're reading, that may not be installed or importable.** Importers must therefore be source-based.

*Rejected:* `pydeps` / `jdeps` / `goda` — accurate, but execution-based (need the repo importable + that language's toolchain), which breaks the onboarding-to-source use case. (Dogfood finding: `pydeps` reads bytecode by importing the package, so a freshly-cloned repo with uninstalled deps — e.g. PID_Inference's `torch`/`cv2` — breaks it.)

## Importer architecture: uniform interface, selection by extension

One importer interface: *"given the files of my language, return edges."* Selection is automatic by file extension — no config, no hardcoded branch.

- **`.ts` / `.js` → dependency-cruiser** (already integrated; source-based via `tsPreCompilationDeps`; handles the `.js`→`.ts` rewrite, tsconfig aliases, and `index.*` resolution that Cells' own NodeNext code relies on). This is **not an exception** — it's TS's importer, selected by extension.
- **Other languages → pre-made tree-sitter** (official grammars; pure-Node via `node-tree-sitter`; no shell-out, no per-language toolchain). The only per-language work is a small **import query** ("match import-statement nodes, capture the module path") — borrowable from `tree-sitter-language-pack`, not authored from zero.

dep-cruiser stays for TS specifically because (a) it's already there, (b) TS resolution is the messiest, (c) it's source-based. Both paths are source-based → consistent on the principle; selection by extension behind one interface.

## Resolution reframe: cell-level, not file-level

**The job is *"does this code reach into another cell?"* — not *"which exact file."*** So don't resolve imports down to files. Instead:

1. **Derive each cell's module-namespace from its owned files** — file-path → module-path (Python: `src/domain/symbol.py` → `src.domain.symbol`; `__init__.py` → the package itself).
2. Build one map: **module-path → cell**.
3. For each extracted import, take its module-path, look up the cell. **Different cell → crossing. Same cell → internal (skip). No match → external (drop).**

This lands directly on a cell, never on a file. It kills the *"what's the package root?"* question for flat layouts (full file-path = full module-path, 1:1 — as in PID_Inference). The one case needing a tweak is **src-layout** (`src/mypkg/foo.py` imported as `mypkg.foo`, where the code-dir is a *container* not a package component) — strip the code-dir prefix; secondary.

Intra-cell imports (`graph.py` → `symbol.py`, both in `domain`) map to the same cell → correctly skipped. External (`import numpy`) matches no cell → dropped. Namespace collisions (two cells claim the same module-path) → a `validate` warning, not a silent guess.

## Metrics: fan-in / fan-out / instability — free, descriptive

Once crossings produce cell→cell edges, the metrics are trivial graph-degree counts:

- **fan-in** (Ca) — # cells depending on this one.
- **fan-out** (Ce) — # cells this one depends on.
- **instability** I = Ce / (Ca + Ce). 0 = stable (depended-on, depends on nothing); 1 = unstable.

These are **cell metadata, peers of `size`** — shown wherever size is (a column in `cells list`, stats in `cells show`, optionally the payload membrane). **No new `cells metrics` command.** Direction flow is visible through instability (stable ← unstable) alongside the in/out crossings `show` already lists — no separate SDP check or governance gate. Matches *"not governance, just more info to the cell."*

## Out of scope

- File-level resolution (stack-graphs / SCIP) — overkill; the reframe makes it unnecessary.
- Execution-based tools (`pydeps`) — rejected (need an importable repo).
- A separate metrics command or a gating SDP check — metrics stay descriptive.
- Dynamic imports (`importlib.import_module`) — missed by static extraction; acceptable while metrics are descriptive.

## Build order (if we proceed)

1. Importer interface + extension-router; refactor `collectImportEdges` to dispatch (TS → dep-cruiser, preserved).
2. tree-sitter Python importer: grammar + import query + module-namespace derivation + namespace-match resolution.
3. Roll file/module-edges up to cell-edges (existing crossings logic).
4. Metrics: fan-in/out/I computation + display in `list` / `show`.
5. `validate` warning for namespace collisions; src-layout prefix-strip.

---

## Review — risks & open questions

**Strengths**

- Clean layering: extraction (tree-sitter / dep-cruiser) → resolution (namespace-match) → metrics (counting). Each layer simple; metrics are nearly free.
- Source-based principle preserves the onboarding-to-uninstalled-repo use case.
- No new command, no governance gate — matches the stated intent.

**Risks (real)**

1. **Per-language namespace-derivation varies in difficulty (not a fundamental mismatch).** tree-sitter extracts imports in *every* language it has a grammar for (Python/TS/JS/Go/Rust/C/…), so **extraction is universal**. The namespace-match architecture is universal too — only the rule "owned-file → module/package-path" differs per language:
   - **Python**: `src/domain/symbol.py` → `src.domain.symbol` (path = module).
   - **Rust**: `use crate::domain::symbol` → `src/domain/symbol.rs` (`::`→`/`, `crate`→src root; non-standard `mod`/`#[path]` layouts need `mod`-tree parsing).
   - **Go**: `import ".../internal/domain"` → the cell owning `internal/domain/*.go` (directory = package).
   - **C**: `#include "foo.h"` → resolve relative to the file / include paths.
   All derivable; each rule lives in that language's importer — the expected per-language cost. **Not** "Python-only": one architecture, N derivation rules of varying size.
   The one genuine wrinkle (**Go**): imports are *package-level* (a directory), coarser than Cells' file-atomic ownership. Fine in practice — a Go cell usually *is* a package's files, so crossings land package→package = cell→cell; splitting a package across cells trips the namespace-collision `validate` warning.

2. **tree-sitter is a native-addon dependency.** `node-tree-sitter` + grammars are `.node` native addons → build/prebuilt-binary friction across platforms and Node versions. Increases Cells' native-dep surface (alongside dep-cruiser). Prebuilts usually exist, but CI/portability must be verified. This is the main *practical* risk.

3. **src-layout detection.** Stripping the code-dir prefix when the code-dir is a container (not a package component) needs a detection heuristic or config. Getting it wrong → wrong module-paths → missed/spurious crossings. Longest-match + collision-warning mitigates, but it's a real edge.

4. **Two resolution models coexist.** TS resolves-to-file (dep-cruiser) then rolls to cell; Python matches module-namespace directly. Output is uniform (cell-edges), but internally two code paths. Acceptable (pragmatic), but a maintenance seam. Could unify by giving TS a namespace importer too — at the cost of losing dep-cruiser's alias handling. Current call: keep dep-cruiser for TS.

5. **Metrics accuracy = extraction accuracy.** If extraction misses imports, fan-in/out undercount. Descriptive use tolerates this; the moment we *gate* on a metric (SDP warning), the bar rises and the extractor may need upgrading (native `ast` / better queries). Documented assumption.

**Open questions to resolve before/while building**

- Which languages first? **Python** (dogfooded, clean fit). TS already done (dep-cruiser). Go/Rust/C fit the **same architecture** — each just needs its own namespace-derivation rule; add when needed.
- Is "direction visible via instability" satisfying, or do users eventually want an explicit flagged SDP violation? (Current grill answer: visible is enough.)
- Relationship to the existing `structure` command (ADP + manual-`layers` Direction): ADP (cycles) stays valid; manual-layers coexists with descriptive instability — possible future simplification (drop manual-layers if instability suffices). Out of scope now.

**Bottom line**
The design is sound, simple, and **general**: tree-sitter gives universal extraction; the namespace-match resolution composes with file→cell ownership to yield cell crossings for any statically-importable language (the core pipeline: *file imports (tree-sitter) + file→cell (ownership) → cell relationships*). Per-language cost = writing that language's namespace-derivation rule (Python trivial, Rust/Go moderate). Build Python first; add languages as needed — each new language is an importer, not an architecture change.
