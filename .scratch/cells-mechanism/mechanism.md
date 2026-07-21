# Cells — Mechanism

> A cell is a **logical object** that owns a non-overlapping region of code and carries a
> **membrane**. Cells' core mechanism is **visibility**: it reveals the structure — what's
> in each cell, how cells connect, where errors belong — so membranes and good separation
> *emerge* from developers seeing them. **The one enforced rule is size** (a cell must fit
> a context window; too big → it divides). Everything else is the developer's job. Cells
> coexists with normal software development; it does not replace the language, the compiler,
> or architectural judgment.

This document assembles the mechanism effort's two keystones —
[declaration](issues/01-declaration.md) and [enforcement](issues/02-enforcement.md) — plus
the [research](research/declaration-and-enforcement.md) behind them, into one coherent
mechanism. It sits downstream of [`../cells-vision/vision.md`](../cells-vision/vision.md)
(what Cells is) and [`../cells-completeness/completeness.md`](../cells-completeness/completeness.md)
(what *complete* means).

## 0. The core (simple)

Distilled to its essence, Cells is five things:

1. **A cell solves ONE problem and fits a context window.** The unit — small enough for a
   model to hold whole.
2. **Cells partition the codebase.** Every bit of code lives in exactly one cell
   (non-overlapping, like biological cells).
3. **Cells touch only through membranes.** A cell provides / requires; internals stay
   private. The membrane is the only seam.
4. **Cells makes the structure visible** — contents, connections, and where errors belong
   (attribution). You *see* the architecture instead of digging.
5. **One enforced rule: size.** Too big → it divides. Clean interfaces, good partitioning,
   separation of concerns — all the developer's job, naturally nudged by visibility.

**Why it works:** a model (or human) picks up one cell whole — it fits the context, it's
self-contained for its problem, it reaches other cells only through visible membranes. So
you work one cell at a time without drowning. That's the Navigation Paradox, solved.

**The unifying mental model (bio-cell metaphor):** cells are like biological cells. The
**membrane** is the enforceable contract (selectively permeable — what crosses is
controlled, = capabilities/effects). **Specialization** is purpose-absolute. Cells are
**non-overlapping** (they partition space), **communicate via membrane receptors**
(requires/provides seams), and **compose into the program** (the organism). Enforcement =
the gate that keeps the membrane real.

## 1. Declaration — what a cell *is*, and how code binds to it

A cell is a **logical object, not a filesystem citizen.** It owns a region of code and
carries a contract. Five decisions define it:

**Authored, model-scaffolded on existing code.** A cell's declaration is *authored* — it
carries responsibility, which is not inferable from code. On existing code, a **model
scaffolds** it: reads the code, drafts the contract + ownership, human refines. Code is
**not refactored**; the migration cost is paid by the model, not the human. On new code,
the human authors it. (Explore-existing stays viable — the primary use case survives.)

**Provenance / spatial ownership, not names.** Code binds to a cell by **who made it under
the cell** (provenance), tracked as **spatial ownership**. Cells track code through
*space* the way git tracks it through *time* — orthogonal axes. **Git is the analogy, not
the substrate.** Not a name-manifest (those drift on rename/move/delete); not git-literal.
**The contract is the gate.**

**Partition — non-overlapping.** Cells partition space: each code element is owned by
exactly one cell. Shared / cross-cutting code becomes **its own cell that others
*require***. (No overlap = no selection/duplication — the move Cells defined itself
against.)

**Logical object, structure-agnostic.** A cell is not a file. Physical structure (folders,
trees) is the author's choice and **irrelevant** to cells. **Addressing = search +
ownership** — "what owns this?", "which cell handles this?" — not paths. The model
navigates via ownership + contracts, never a file tree. De-anchored entirely from
"file vs annotations vs manifest."

**Declaration vs payload.** The *authored declaration* is small (contract/membrane +
ownership claim). The *retrieval payload* — what "explore cell A" returns — is the **whole
completeness footprint**: declaration + owned internals + required neighbors' contracts.
The cell hands over completeness; the model never hand-assembles it.

**Locality, precisely:** internals are **strictly local** (you never need two cells'
internals); contracts are **shared** and may be jointly reasoned (a contract-level bug
touches two membranes — but contracts are cheap). "One cell at a time" holds for internals.

**Load-bearing consequence — cells need an index.** Search/ownership addressing
presupposes a **queryable Cells layer**: a code→cell ownership map + a cell→contracts
graph. **Cells = objects + a searchable index.** The storage/index *implementation* is
deferred; the *requirement* is locked.

## 2. Enforcement — visibility is the default; size is the one hard rule

> *Revised in the alignment review: the original gate-centric model was re-prioritized to
> visibility. Grailing history in [ticket 02](issues/02-enforcement.md); this section states
> the current truth.*

**Cells' core mechanism is VISIBILITY, not a gate.** Track every cross-cell crossing and
*reveal* it — what's in a cell, how it connects (inbound + outbound), where errors belong
(attribution). Cells does **not** reject or enforce a way of coding. Good
separation-of-concerns and clean membranes **emerge** from developers *seeing* the
structure. (Cells doesn't compete with the host compiler/types — those still reject type
errors; Cells just attributes them to the owning cell.)

**The ONE enforced rule: SIZE / boundedness (context-fit).** Size is the defining physical
constraint — a cell that doesn't fit a context window can't be worked as a unit, so it
fails the definition outright. The one place "messy but valid" doesn't apply. A too-big
cell **must divide** (→ §4: division is now core, the direct consequence of
size-enforcement). Size is *measurable* (token-count of the completeness payload vs a
*configurable* context budget). Responsibility-fit ("is the cell focused on one problem")
is *not* measurable — guided by visibility, not enforced.

**Two structural invariants, precisely — and partitioning is *design*, not correctness.**
(1) **Partition (non-overlapping)** — no code in two cells — enforced *by construction*:
ownership is a function code→cell (single-valued), so you literally can't assign code to
two cells. (2) **Size** — enforced by the divide-rule above. These two are the only things
that can be "wrong." *Where* you draw the membranes, responsibility cohesion, coupling,
leakage — all **design quality**, not correctness: code has no intrinsic cell structure, so
there's no hidden truth to be wrong about. This makes **scaffolding robust by definition**
— the model proposes a valid partition (non-overlapping + size-fitting); a human refines it
by *redrawing membranes*. **Leakage is a signal, not an error**: under visibility you see A
reaching B's internals, and you redraw (move the code, or expose it on B's membrane) or
refactor. The membrane is artificial; you can move it.

**Everything else is visibility/discipline.** Leakage, interface quality, partitioning,
internal design — all can be messy and still be valid, workable cells. Visibility reveals
them; the developer cleans them up. **A leaky cell is valid, with visible leakage** — not
rejected.

**The hard leakage-gate is OPT-IN strict-mode** (the Require-mode ceiling, below), for
cells/programs wanting a *guarantee* of no leakage. Enforcement doesn't vanish — it moves
from constitutive floor to opt-in ceiling. Default = *descriptive* trust (you see the
membrane's real shape, leaks and all); strict-mode = *guaranteed* trust.

**Leakage, defined:** a cell reaching into another cell's *internals* instead of going
through its *membrane* (provided contract). It's what visibility reveals and strict-mode
forbids — because it breaks locality (to work the reaching cell you'd need the neighbor's
internals, not just its contract).

**Grades are descriptive + consumer-side policy.** Grades are trust *signals*; nothing
intrinsically forces behavior. Consumers decide whether to require them — via the
requires-clause.

**Grades are local, not contagious.** Grades are **computed** (objective — highest tier a
cell passes verification for), not self-asserted (no lying). A consumer specifies a
required grade for a **direct neighbor only** (`requires B:effects`); the gate checks that
direct neighbor holds it. **No transitive contagion** — A is never invalidated by C (B's
neighbor). Locality (completeness) holds. *Refinement:* B's effects membrane includes the
**declared** effects of neighbors B calls (read from contracts, not internals) — so trust
is **compositional**: each link locally verified, no cell burdened with the whole graph.

**Require-mode — an opt-in construction-guaranteed ceiling.** The dial's top: code
authored in an **effect-bounded mode** (Cells-native / Koka-like) cannot have undeclared
effects — trust is *guaranteed by construction*, not verified after the fact. Opt-in;
reachable only for effect-bounded-authored code. Scaffold-on-existing stays at
verify-and-grade. (The authoring-mode *mechanism* is deferred — see Scope.)

**Cells attributes errors; it doesn't replace the error system.** Normal dev still works —
compile, run, test; errors surface as usual. Cells **maps any error to its owning cell**
(via the code→cell index) so you investigate *that* cell.
- *How each tier is checked:* structural gate = Cells-specific static analysis (the only
  hard check Cells adds); effects = static inference (Koka-model, partial on arbitrary
  code); semantic = largely the **host language's own tests, now cell-attributed** (richer
  proofs / DbC optional).
- *On violation:* structural-gate fail → not a cell; normal code breaks → usual error,
  attributed to owning cell; grade not earned → descriptive (cell valid at lower grade), or
  if a direct neighbor required it → that neighbor's local gate fails.

## 3. The capstone

**Cells = visible membranes + attribution + completeness-for-navigation.**

It is a **visibility + separation-of-concerns aid**: it reveals structure and points you at
the right cell, so good architecture *emerges* from developers seeing it. It does **not**
enforce a way of coding, and it does **not** guarantee clean internals — the one thing it
enforces is **size**. Therefore **"complete" ≠ clean-internals**: a messy cell with a valid
membrane that owns its problem's code is a perfectly good, complete cell. The model
navigates it; if it throws, attribution points you there; you clean it up. Internals stay
the developer's job.

## 4. Scope

**In (this effort):** the mechanism's *core* — what a cell *is* (declaration) and how its
membrane is *kept real* (enforcement). Concept-level, de-anchored from any physical
format.

**Out — fog, graduating into a future effort:**
- **Physical storage / index implementation** — store vs graph vs files-as-projection.
  (Requirement locked; impl deferred.)
- **Division** — *promoted from fog to CORE* by the alignment review: it's the direct
  consequence of the size rule (too big → divide). When/how a cell splits; must cut
  coupling, not slice internals (Bio: *mitosis*). Design deferred — but it's now a core
  mechanism, not optional.
- **Format / language** — what Cells targets; the concrete serialization of a cell and its
  membrane.
- **Git interop** — coexistence with real git repos (git is analogy; interop is a separate
  mapping concern).
- **Effect-bounded authoring mode** — the Require-mode *mechanism* (a Cells-native
  language? a restricted subset? Koka interop?).

## 5. Open threads for the next effort

- The **index/store** is now a hard requirement (declaration §1) with no implementation —
  the most load-bearing fog item.
- **Division** (mitosis) is now CORE (consequence of the size rule) — the first mechanism
  to design when we pick this back up.
- The **membrane's contents** beyond provides/requires/effects were deliberately left to
  "form slowly" — refine when a format exists to sharpen them.
- A **prototype** (a concrete cell declaration + a stub index/visibility layer + the size
  check, over a small real codebase) would pressure-test the core — the natural next move
  once a format is chosen.

---

*Decisions: [`map.md`](map.md) · tickets [`01`](issues/01-declaration.md) /
[`02`](issues/02-enforcement.md) / [`03`](issues/03-research-declaration-and-enforcement.md)
· research: [`declaration-and-enforcement.md`](research/declaration-and-enforcement.md).
Predecessors: [`../cells-vision/vision.md`](../cells-vision/vision.md),
[`../cells-completeness/completeness.md`](../cells-completeness/completeness.md).*
