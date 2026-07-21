---
Title: How do systems model "what's needed to work a unit" + effects?
Labels: wayfinder:map, wayfinder:research
Type: research
Status: resolved
Blocked by:
Parent: cells-completeness/map.md
---

## Question

How do existing systems **model what you need to know to use or work on a component**, and
**how do they represent that component's effects on the world**? Evaluate each through the
Cells completeness lens: does it give a notion of "complete context for one unit of work"?

### Areas to cover

1. **Spec / contract systems** — Design-by-Contract (Eiffel), JML, OpenJML, TLA+, Spec#,
   Racket contracts, type-state. What do they say a caller/implementer must know?
2. **Effect systems** — Koka, Eff, OCaml 5 effects, Haskell effect libraries (polysemy,
   fused-effects), Rust's `async`/`unsafe`/traits as effect-like boundaries. How do they
   make "what a component does to the world" explicit and bounded?
3. **Capability / security systems** — object-capability model, seL4, Wasm component
   model / Interface Types, Cloudflare Workers' permissions. How do they bound what a unit
   may touch?
4. **Module/interface systems with explicit deps** — ML functors, Haskell typeclasses,
   Go interfaces, Rust traits, Wasm components. What's the "surface" a consumer needs?
5. **LLM-coding "context assembly"** — what do agents like Aider/Cursor/Cody *choose* to
   include as "enough context"? (Builds on the vision's prior-art research.)

### Output

A findings doc at `.scratch/cells-completeness/research/needed-and-effects.md` ranking:
what gives the cleanest notion of **completeness for one unit** (incl. effects), what's
transferable, and what gap remains for Cells. Feeds
[What must a cell contain](02-what-must-a-cell-contain.md) and
[Effects/state/env](03-effects-state-env.md).

## Comments

## Answer

Findings at [`research/needed-and-effects.md`](../research/needed-and-effects.md).

**One-line gist:** four traditions already model "what you must know to use/work a
component" AND its effects — Cells needn't invent completeness from scratch, it
**borrows and re-bounds by model-needs**. **WebAssembly Component Model (WIT/Worlds)** is
the closest: a component declares **imports** (requirements) + **exports** (provisions) —
imports/exports ARE the seams, confirming the vision's hint. **Design-by-Contract** adds
pre/post/invariants. **Effect systems** make "does to the world" explicit. **Capability /
seL4** bound environmental access. **Gap for Cells:** none organize the unit by *model-needs
+ one-problem + context-fit* — same ingredients, different axis.

Feeds [02 (contents)](02-what-must-a-cell-contain.md) and [03 (effects)](03-effects-state-env.md).

## Comments
