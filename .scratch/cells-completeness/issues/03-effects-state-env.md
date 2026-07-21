---
Title: How do state / effects / environment fit into completeness?
Labels: wayfinder:map, wayfinder:grilling
Type: grilling
Status: resolved
Blocked by: 01
Parent: cells-completeness/map.md
---

## Question

Real code is not pure: it reads/writes a DB, the filesystem, the network, holds state,
runs async, shares globals. "Inputs → outputs" is **false** for most real code. **How are
a cell's effects on its world part of its completeness** — so a cell that looks complete
actually *is* complete?

This is the make-or-break for whether "a complete, self-sufficient cell" is achievable on
real code at all.

### Context

- The vision flagged this as the hard part: a black box isn't pure.
- Completeness that ignores effects is illusory — the model would be "complete" yet blind
  to how the cell changes its environment, and to what its environment must provide.
- Transferable prior art (from the vision's research): pure-FP **effect systems** (effects
  as explicit, trackable I/O), **actor model** (state encapsulated; communicate by
  message), **capability/security** systems (explicit permissions to touch the world),
  **Design-by-Contract** (preconditions/postconditions incl. state).

### Decisions to land

1. **Are effects part of "what's needed"?** (Working hypothesis: yes — a cell's *effects*
   and its *environmental requirements* are first-class parts of completeness.)
2. **How are they represented** — at the completeness/concept level (not the mechanism)?
   e.g., "a cell declares what it reads, writes, and requires from its environment."
3. **The purity boundary** — does Cells *require* cells to be effect-bounded (forcing
   discipline, like actors/pure FP), or *describe* effects of arbitrary code (like a
   spec)? This choice has big mechanism consequences — keep it at the concept level here.

### How to resolve

`/grilling` + `/domain-modeling`; lean on [prior art on effects/contracts](../research/)
if fired. Resist drifting into enforcement mechanism (deferred).

## Comments

## Answer

Effects stance decided (grilling + deliberation). **Effects are part of completeness
— and the contract must be ENFORCEABLE and TRUSTED, not merely declared.**

Decisions:
1. **Effects ARE part of completeness.** A cell hiding its effects looks complete but
   isn't. Effects/capabilities are a mandatory part of the contract.
2. **Represented as an enforceable, interface-like contract** — imports/exports/types/
   effects/capabilities as a machine-checkable surface (Wasm WIT / typed interface /
   OpenAPI — not prose).
3. **Stance = DECLARE + VERIFICATION, not Require-purity.** Code is NOT forced pure
   (keeps the explore-existing-code use case viable). The declaration is CHECKED for
   accuracy — static effect-inference / capability analysis verifies it against the code.
   Trust comes from verification, not from forcing purity.

**Key correction (load-bearing):** enforcement is NOT a deferred bonus — it is a
**required companion** to Declare. An interface you can't trust is worthless (types/
interfaces are valuable *because* compilers enforce them). **A cell is valuable only when
its contract is trusted.**

**Trust is graduated — and the interface gives a cheap, strong floor:**
- Structural (types/wiring) — cheap, compiler-grade.
- Effects (reads/writes/calls/capabilities) — medium, static inference.
- Semantic (pre/post/invariants/behavior) — hard, tests/proofs/runtime.

**Existence proof:** Wasm Component Model = WIT interface + capabilities enforced by
runtime — interface-like + trusted, shipping today.

### Refined core-problem statement (this step's defining output)

> Cells makes a codebase's units, boundaries, and effects **explicit, defined, and
> bounded** — as **enforceable, interface-like contracts that must be trusted** — so both
> human and LLM work one unit at a time without reading the rest. Visibility is the core;
> trust (via enforcement) is what makes it *valuable*.

(The vision's "explicitly-seamed" is hereby sharpened to **"enforceable + trusted."**)

### Effect on the map / effort

- Frontier now EMPTY — 01, 02, 03, 04 all resolved. **Completeness destination reached.**
- Scoping wall softened: enforcement is acknowledged **load-bearing**. *What* is enforced,
  *how strict*, *what tooling* — incl. a possible **Require-style strict mode** at the top
  of the trust dial — remain the **mechanism effort's** territory.
- Fog "how to verify completeness" → sharpened into the **verification tiers**
  (structural/effects/semantic) for the mechanism effort to ticket.

## Comments
