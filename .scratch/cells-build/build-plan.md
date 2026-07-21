# Cells — Prototype Build Plan

## 0. What this is

A plan to build the **first Cells prototype** and **dogfood it on this very repo**
(the Cells codebase itself). Cells organizes code into context-bounded units
(*cells*) so an LLM can work alongside a human — navigating one cell at a time
without drowning in the whole codebase.

This is a **build plan**, not a decision log. Design rationale lives in the
concept docs and Engram memory (IDs at the end). This doc consolidates the
prototype's scope, pieces, order, and acceptance.

**Background docs:** `../cells-vision/vision.md`, `../cells-completeness/completeness.md`, `../cells-mechanism/mechanism.md`.

---

## Status (as of this session)

**Built (TDD, 31 tests green, tsc clean):** declaration, ownership, payload, validate, crossings, view, assign, **config** + serialization + CLI (`init` · `assign` · `payload <name>` · `validate` · `crossings` · `list` · `size` · `show <name>`).

**Partition (self-checking ✓):** 10 cells — declaration, ownership, payload, validate, crossings, view, assign, config, **io**, cli — 18 code files, all owned. `validate` → OK; `crossings` → 0 leakage.

**All three loops complete:** READ (declare→own→retrieve→validate→derive+leakage→navigate), WRITE (init→assign→serialize), GOVERN (`size` — context-fit warning).

**The one rule = SIZE, as a warning (grilled + research-grounded):** purpose=context-fit (coherence is dev/model's job, not Cells'); metric=payload tokens; ceiling=`max-payload-tokens` default **16000** in `.cells/config.toml` (÷4-of-window dropped — research shows degradation is ABSOLUTE ~32k+, not proportional); estimate=chars/4 (model-agnostic); `size` is non-blocking (exit 0); divide = re-partition via existing `assign` (no divide command). At 16k our cells are all within (tiny); the warning fires on real large cells.

**Divide dogfooded:** split cli — loaders extracted to new `io` cell (cli 3078→2484, io 1342). cli still biggest (commands+dispatch hub) but focused; further split = diminishing returns.

**Deferred:** direction-policy check (#34 — optional layer + allowed-pairs; designed not built).

**Next:** commit · Phase 6 (branch/merge — git-for-space) · direction-policy (#34).

---

## 1. Goal & scope

**Goal:** dogfood Cells on its own codebase. Build the smallest Cells that lets
us partition *this* repo and retrieve a cell's payload to work on. No
hypothetical demo — real use, on real (our) code.

**Scope honesty.** The dogfood proves the **mechanism** — that a cell's payload
is *sufficient* to work the cell (the navigation paradox, on a small scale). It
does **not** prove the **motivation** (large-codebase navigation, the actual
problem Cells exists to solve). Scale/division testing is a later, bigger
effort. Don't over-claim.

**Strategic note.** The entire LLM-agent ecosystem computes context by
**retrieval** (Aider repo-maps, Cursor/Continue embeddings, git-semantic
inferred maps). Cells is a deliberate **contrarian bet** on **declared
partitions**. Coherent reason: visibility + completeness + authored membranes
beat lossy retrieval. Be conscious we're diverging from the mainstream.

---

## 2. The 5-concept core (recap)

1. A cell solves ONE problem + fits a context window.
2. Cells partition the codebase (non-overlapping).
3. Cells touch only via membranes (provide/require; internals private).
4. Cells makes structure VISIBLE (contents, connections, attribution).
5. ONE enforced rule = SIZE (too big → divide); everything else nudged by visibility.

---

## 3. Substrate & stack

- **Self-host:** build `cells-core`, then dogfood Cells on `cells-core` itself.
- **Language:** TypeScript / Node.

---

## 4. First slice — three pieces (crossing-free)

The first slice closes the loop **without** any dependency/crossing analysis:
declare → own → retrieve → (model works) → verify. Crossing-capture is a later
phase (§7).

**Build order:** declaration + parser → ownership map + validation → payload assembler.

**First working thing:** the assembler producing a payload over `cells-core`'s
own source.

### 4.1 Declaration (TOML)

File: `.cells/<name>.cell.toml`. Pure TOML (ecosystem idiom — Wasm/component
tools use TOML; parse via `@iarna/toml`).

```toml
name = "parser"
purpose = "Turn a .cell declaration file into a checked Cell AST."
provides = ["parseCell", "validateOwnership"]
requires = ["ownership"]   # neighbor CELL names (not symbols)
```

- `name` — identity.
- `purpose` — one-line "one problem."
- `provides` — the cell's declared surface; authored, validated later (by crossing-capture).
- `requires` — neighbor **cell names**; what the assembler uses to pull neighbor declarations.
- **No owned-files listing** — ownership lives in the map (§4.2), so declarations can't drift.
- **Effects / state deferred.**

### 4.2 Ownership map (file-atomic, path-keyed sidecar)

File: `.cells/ownership.toml` (cell → files; TOML, reusing `smol-toml` — one format, one dep).

- **File-atomic:** the file is the atomic unit of ownership. `{file → cell}`. A file can't be split across cells; non-overlap enforced at *file* granularity. (A file mixing two cells' concerns = refactor signal, parallel to divide-the-cell.)
- **Path-keyed for the first slice** — simple, readable, edit-stable. Conceptually content-addressed identity (a hash follows content through rename/move — the git-mirror); **hash-keyed storage deferred** until rename/move provenance is actually exercised.
- **Validated** via `cells validate`: (a) single-valued — no file in two cells; (b) no dangling — deleted files still listed; (c) orphans flagged, not fatal — unowned code = gradual cell-ification in progress.

**Assign workflow:** human + model collaboratively — model scans, proposes;
human confirms. For the dogfood, hand-assign (we know `cells-core`).
`cells assign <file> <cell>` (or hand-edit the sidecar).

### 4.3 Payload assembler

CLI: `cells payload <name>` → **single markdown document** to stdout.

Contents (per completeness — the model gets its cell whole + neighbor *surfaces*,
never neighbor internals):

- the cell's **declaration** (name, purpose, provides, requires);
- the cell's **owned code** — *full source* of each owned file (not summaries);
- required **neighbor declarations** — their *membranes only*.

```markdown
# Cell: parser

## Declaration
purpose: Turn a .cell file into a checked Cell AST.
provides: [parseCell, validateOwnership]
requires: [ownership]

## Your code
### src/parser.ts
<source>

## Neighbor contracts
### Cell: ownership
<ownership's declaration>
```

**Size:** assemble + **measure** (char/token count), print it. No enforcement in
the first slice.

---

## 5. Write-back (the loop's "work" step)

The payload is a read-only context artifact. The model works *from* it, then
**outputs edited full-file contents** (keyed by the file paths the payload
already lists) → a trivial apply script writes them back. Defer diff/patch and
the read/write access-model.

---

## 6. The cell-ification lifecycle

1. **(pre-Cells)** a model scans the codebase.
2. **Human + model assign** code into cells (model proposes, human confirms).
3. **Cells derives** cross-membrane connections (crossings, §7).
4. **Division / context-fit → later** (scale problem, deferred).

Unowned code is a natural intermediate state (flagged, not fatal).

---

## 7. Crossing-capture (LATER phase, after the loop works)

**Tool:** `dependency-cruiser` — purpose-built JS/TS dependency analysis +
boundary-rule validation (= Packwerk-for-JS). Borrow, don't build.

- Express cell boundaries as dependency-cruiser **rules** ("files in cell A may
  not import files in cell B unless B ∈ A's `requires`"). dependency-cruiser
  **detects crossings** (file/module-level) and **reports boundary violations**
  (= leakage).
- **Granularity: file/module-level** — consistent with file-atomic ownership.
- **Crossing shape:** `{from-cell, to-cell, from-file, to-file, import}`.
- `ts-morph` **deferred** to fine symbol-level leakage (does A reference a
  symbol in B that's not in B's `provides`?) — only if ever needed.

Crossings derive **after** ownership exists (they need the map).

---

## 8. Acceptance

A **fresh model works a `cells-core` cell from its payload alone** (no repo
access), makes a **single-cell-scoped** change correctly, and needs nothing
outside the payload. Payload fits a size budget. If it needs more → the payload
is incomplete → iterate on completeness.

Unit-test the 3 pieces with fixtures; dogfood-accept on `cells-core`.

---

## 9. `.cells/` store & CLI

- `.cells/` is **committed** (versioned, shared — the partition is part of the
  repo, per product-form).
- **Layout:** `.cells/<name>.cell.toml` (declarations) + `.cells/ownership.toml` (map).
- **CLI:** `cells payload <name>` · `cells validate` · `cells assign <file> <cell>`.

---

## 10. Deferred (graduate as the build surfaces them)

- Hash-keyed ownership storage (path-keyed first).
- **Symbol-level ownership** — dropped; file-atomic. This is a Cells-**architectural**
  granularity decision (how fine-grained a cell is), independent of any VCS.
  (Aura is a *temporal* VCS — tracking code/agent work over time — orthogonal to
  Cells' *spatial* architecture; not a Cells graduation path.)
- Scaffolding (collaborative scan + assign for unfamiliar codebases).
- Size-**enforcement** (measure first).
- Locate / search; visibility CLI; division mechanics; attribution UI.
- Polyglot (LSP-server-driving); `ts-morph` symbol-level leakage.

---

## 11. Principles

- **Borrow, don't build** — dependency-cruiser, TOML, the git content-addressing technique.
- **Don't box in** — every choice is revisit-able; test the architecture first, graduate.
- **Simplicity first** — file-atomic, path-keyed, measure-not-enforce, crossing-free first slice.

---

## Engram memory

133 (session summary) · 134 (content-addressed ownership) · 135 (file-atomic) ·
136 (dependency-cruiser) · 137 (lifecycle + don't-box-in) · 138 (prior-art
landscape) · 139 (TOML + Aura-orthogonal).
