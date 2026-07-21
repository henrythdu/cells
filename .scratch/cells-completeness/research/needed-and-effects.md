# How systems model "what's needed to work a unit" + effects

*Research for [ticket 04](../issues/04-research-needed-and-effects.md). Evaluated through
the Cells completeness lens: does it give a notion of "complete context for one unit of
work," and how does it represent effects on the world?*

## TL;DR

Four mature traditions already model "what you must know to use/work a component" **and**
its effects — Cells doesn't need to invent completeness from scratch; it needs to
**borrow and re-bound by model-needs**:

- **WebAssembly Component Model (WIT / Worlds)** is the closest concrete model: a component
  declares **imports** (what it requires) and **exports** (what it provides); a **World**
  bundles required + provided functionality. This is almost exactly the vision's hint
  (*internals + seams of connected cells*), made concrete — **imports/exports ARE the
  seams**, and effects ride on the type system.
- **Design by-Contract** adds the *contract* layer: preconditions (caller must ensure),
  postconditions (supplier guarantees), invariants.
- **Effect systems (Koka)** make "what a function does to the world" explicit in the type.
- **Object-capability / seL4 (capDL)** bound what a component may touch by **capabilities**.

**The gap for Cells:** none of these are organized around (a) the **model's** needs /
context-window bound, or (b) the **one-problem** work unit. They define component
interfaces/contracts *in general*; Cells bounds and organizes them by *model-needs +
one-problem*. Same ingredients, different organizing axis.

## 1. Design by Contract (Eiffel, JML)

- **What a caller must know:** the **precondition** (what the caller must guarantee before
  the call) and the routine's **contract**.
- **What the supplier guarantees:** the **postcondition**.
- **Always-true facts:** the **class invariant**.
- **Completeness lens:** DbC defines the *minimal mutual obligation* at a seam — the
  smallest set of facts caller and supplier must share. Transferable: a cell's seam =
  precondition + postcondition + invariant, not "all the code."

## 2. Effect systems (Koka, row-polymorphic effects)

- Effects are **explicit in the type**; a consumer reads what a function **does to the
  world** (state, exceptions, async, I/O) from its signature.
- Effects are **handler-oriented** — localized, trackable, composable.
- **Completeness lens:** answers ticket 03 cleanly — **effects are part of completeness.**
  A cell that hides its effects looks complete but isn't; declaring them makes "what it
  does to the world" a first-class part of what the model must know.

## 3. WebAssembly Component Model (WIT / Worlds) ← closest

- A component is **self-describing**: it declares **imports** (what it requires) and
  **exports** (what it provides) via WIT, with a richer type system than core Wasm.
- A **World** is a broader contract: the full set of required + provided functionality for
  a configuration.
- **Completeness lens:** this is the vision's hint made concrete. **Imports = the seams
  (contracts) of connected cells the cell depends on; exports = the cell's own seam.** A
  cell is complete when its imports are satisfied and its exports are declared — i.e.,
  *internals + the seams of cells it connects to*. Effects and capabilities ride on the
  component type system.

## 4. Object-capability / seL4 (capDL)

- All authority flows through **capabilities**; a component touches only what it holds a
  capability for.
- **capDL** describes the kernel objects an app needs + the capability distribution — i.e.,
  the explicit *environmental requirements*.
- **Completeness lens:** a cell's **environmental requirements** (DB, FS, network, state)
  are bounded and made explicit as **capabilities**. Answers the "black box isn't pure"
  problem from the authority side: the cell declares what it may touch; completeness
  includes that declaration.

## Ranking

**Closest to Cells completeness:** WebAssembly Component Model (imports/exports/Worlds) —
concrete, modern, already pairs interfaces with effects + capabilities. DbC adds the
contract semantics on top.

**Most transferable to effects (ticket 03):** effect systems (make "does to the world"
explicit) + capability model (bound environmental access). Together: a cell declares its
**effects** and the **capabilities** it requires.

**The "what's new" gap:** all four define component interfaces/contracts in general, bound
by *technology* (types, capabilities, authority). **None** bounds/organizes the unit by
*what a model needs for one problem within a context window*. Cells keeps these
ingredients but re-bounds the unit by **model-needs + one-problem + context-fit** — the
same axis shift that makes Cells novel at the vision level.

## Implications for the tickets

- **Ticket 02 (what must a cell contain):** strong prior art says the mandatory set is
  *internals + declared imports (neighbor seams) + contract (pre/post/invariant) + declared
  effects + required capabilities*. Test this against the one-problem unit from ticket 01.
- **Ticket 03 (effects/state/env):** answered in principle — effects + capabilities are
  first-class parts of completeness. The open question becomes *how much discipline Cells
  requires* (force effect-bounded cells vs describe effects of arbitrary code), which
  straddles completeness and the deferred enforcement mechanism.
- **Ticket 01 (what's a problem):** unaffected by this research — it's a Cells-specific
  decision about the work unit, not borrowed from these traditions.

## Sources

- Design by Contract with JML — https://www.cs.ucf.edu/~leavens/JML/jmldbc.pdf
- Koka: row-polymorphic effect types — https://arxiv.org/pdf/1406.2061
- WIT / Wasm Component Model — https://component-model.bytecodealliance.org/design/wit.html
- seL4 reference manual — https://www.sel4.systems/Info/Docs/seL4-manual-latest.pdf
- capDL — https://docs.sel4.systems/projects/capdl/
