# Cells — Completeness

> A cell is **complete** when it is everything a model needs to work on one problem — and
> its units, boundaries, and effects are **explicit, defined, bounded, and enforceable**.
> Visibility is the core; trust (via enforcement) is what makes it valuable.

This document pins down what *complete* means for a cell. It assembles three decisions
([01](issues/01-what-is-a-problem.md), [02](issues/02-what-must-a-cell-contain.md),
[03](issues/03-effects-state-env.md)) and refines the core problem stated in
[`../cells-vision/vision.md`](../cells-vision/vision.md).

## 1. Complete-for what? — the cell's responsibility

Completeness is **purpose-absolute**, not task-relative.

- A cell is complete-for **its own fixed responsibility** — everything needed to
  understand and modify what the cell owns.
- **Tasks decompose across complete cells.** A bug fix or feature is done by traversing
  the relevant complete cells, not by re-completing a cell per task. Completeness is
  stable; it doesn't churn with the work.
- So "one problem" in the canonical definition = **the cell's responsibility**, not the
  task a developer happens to bring.

**A cell's responsibility is its declared contract** — what it *provides* (exports) plus
what it *requires* (imports). (Imports/exports *are* the seams — confirmed by the
[prior art](research/needed-and-effects.md): the WebAssembly Component Model.) This makes
"one problem" *measurable*: completeness is judged against the contract, the stable
surface.

## 2. What must a cell contain? — the contents of complete

A cell is complete when it holds:

1. **Its declared contract** — provides + requires + effects/capabilities (see §3). A
   first-class, explicit, machine-checkable artifact.
2. **Its internals** — the implementation that fulfills what the contract provides.
3. **The contracts of *all* its required neighbors** — every cell it depends on, by their
   *surfaces* (contracts) only, plural. **Never their internals.**

**Locality is hard and measurable:** to work a cell you need its contract + its internals
+ its N neighbors' contracts, and *none* of their internals. That is what "work one cell
at a time without reading the rest" cashes out to.

**Minimality:** completeness = *nothing missing to fulfill the contract*, not *everything
possible*. **Tests, examples, and domain-context are optional clarifiers** — useful, and
sometimes needed to make a contract legible, but not structurally required. Where they
specify behavior the contract doesn't capture, they *strengthen the contract* (fold in);
otherwise they're aids.

**Footprint grows with neighbor count** (contract + internals + Σ neighbor contracts), so
a many-neighbor cell can be complete-but-unbounded (exceed the context window). The future
*division* mechanism will therefore have to split by **reducing coupling** (fewer/smaller
neighbor contracts) or scope — not merely by slicing internals.

## 3. Effects — Declare + verification, not purity

Real code is not pure: it reads/writes a DB, the filesystem, the network, holds state,
runs async, shares globals. "Inputs → outputs" is false for most code, so **effects must
be part of completeness** — a cell hiding its effects looks complete but isn't.

The stance is **Declare + verification**, distinct from both honor-system Declare and
Require-purity:

| | What it is | Forces code pure? | Trusted? |
|---|---|---|---|
| Declare (honor-system) | declared contract, never checked | no | **no** — too weak |
| **Declare + verification** | declared interface; a tool checks it against the code's actual effects | **no** | **yes** — declaration is accurate |
| Require (purity) | code must be effect-bounded by construction (actor/pure-FP) | **yes** | yes — by construction |

- The contract declares effects/capabilities as part of an **enforceable, interface-like**
  surface (Wasm WIT / typed interface / OpenAPI — not prose).
- **Code is not forced pure** — so the explore-existing-codebase use case stays viable.
- The declaration is **checked for accuracy** (static effect-inference / capability
  analysis verifies it against what the code actually does). Trust comes from verification,
  not from forcing purity.

**Enforcement is a load-bearing companion, not a deferred bonus.** An interface you can't
trust is worthless — types and interfaces are valuable *because* compilers enforce them.
**A cell is valuable only when its contract is trusted.** (Existence proof: the Wasm
Component Model is a WIT interface *plus* capabilities enforced by the runtime —
interface-like and trusted, shipping today.)

**Trust is graduated — and the interface gives a cheap, strong floor:**

| Tier | What's trusted | Cost |
|---|---|---|
| Structural — types, wiring (imports/exports connect) | the shape | cheap, compiler-grade |
| Effects — reads/writes/calls/capabilities | what it does to the world | medium — static inference |
| Semantic — pre/post/invariants/behavior | correctness | hard — tests/proofs/runtime |

## 4. The refined core problem

This effort redefined the core problem Cells solves:

> Cells makes a codebase's units, boundaries, and effects **explicit, defined, and
> bounded** — as **enforceable, interface-like contracts that must be trusted** — so both
> human and LLM work one unit at a time without reading the rest.

- **Visibility** is the core: neither human nor LLM has to read everything to know a cell's
  surface, dependencies, or effects. Even unverified, this is a strict improvement on today
  (where boundaries erode and effects are invisible).
- **Trust** (via enforcement) is what makes visibility *valuable* — an untrusted contract
  is worthless. So enforcement is essential, graduated across the three tiers.

This sharpens the vision's *"explicitly-seamed"* into **"enforceable + trusted."**

## 5. Anatomy of a complete cell (summary)

A complete cell holds:
- **contract** — provides + requires + declared effects/capabilities (enforceable, interface-like)
- **internals** — implementation fulfilling the provides
- **neighbors' contracts** — surfaces of all cells it requires (never their internals)

…sized so the whole fits one context window (bounded), accurate because verified (trusted),
judged against its fixed responsibility (purpose-absolute).

## 6. Scope

**In (this effort):** what *complete* means — the responsibility, the contents, the
effects stance, and the refined core problem.

**Out (the mechanism effort, now scoped with enforcement load-bearing):**
- How cells are **declared** (the physical form of the interface-like contract).
- **Enforcement / verification** — *what* is checked, *how strict*, *what tooling*, across
  the three trust tiers — including a possible **Require-style strict mode** at the top of
  the dial.
- The **division** act — when/how a cell over budget splits (must cut coupling, not just
  slice internals).
- **Format / language** Cells targets.
- **Git interop.**

## 7. Open threads for the mechanism effort

- **Verification tiers** (§3) are the first thing to design: structural first (cheap floor),
  then effects, then semantic.
- **Completeness↔boundedness tension** (§2): when the complete set exceeds the window, the
  responsibility is too big → division cuts coupling.
- **The "what is a seam/contract concretely" fog** is now half-cleared: *concept* settled
  (provides + requires, enforceable); *mechanism* (how declared/enforced) is the next
  effort.

---

*Decisions: [`map.md`](map.md) · tickets [`01`](issues/01-what-is-a-problem.md) /
[`02`](issues/02-what-must-a-cell-contain.md) / [`03`](issues/03-effects-state-env.md) /
[`04`](issues/04-research-needed-and-effects.md) · research:
[`needed-and-effects.md`](research/needed-and-effects.md). Predecessor:
[`../cells-vision/vision.md`](../cells-vision/vision.md).*
