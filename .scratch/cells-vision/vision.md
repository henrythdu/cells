# Cells — Vision & Scope

> Cells gives code a first-class work unit: everything needed to do one job — complete,
> bounded to fit a single context, with **enforceable, trusted seams**. It's the unit that doesn't exist
> today; everyone selects a slice, nobody defines it. For a model or a human.

## 1. The problem

When a model — or a human — works on code, there is **no defined unit of "what you need
to work on one problem."** One of two failures follows:

- **Starve.** Work from a partial slice of context. The model gets confused, invents
  couplings that don't exist, misses dependencies — and produces code that rots future
  maintenance.
- **Drown.** Feed the whole codebase. The context window blows, and reasoning collapses
  under the weight of a tangled graph — even when, in principle, it all fits.

The field has a name for the drowning end: the **Navigation Paradox** — as context
windows grow to millions of tokens, the failure shifts from "can't fit the repo" to
"can't find the relevant code within the window." Bigger windows do not solve it.

The shared root: **there is no first-class, complete, context-bounded unit of work.**
Every tool today works around its absence by *selecting* a slice from code that humans
organized for human cognition (files, modules, functions). None *defines* the unit.

## 2. What a cell is

> A **cell** is everything a model needs to know to work on a problem, and it fits in the
> model's context window.

Three properties, by definition:

- **Complete** — nothing the work needs is missing. The cell is self-sufficient for its
  problem.
- **Bounded** — it fits a single context window. By construction, not luck.
- **Enforceable + trusted** — its connections to other cells are explicit, visible,
  **enforced** boundaries — interface-like contracts that are *checked*, not merely
  declared (the analog of an interface). Not implicit threads buried in code.
  *(Sharpened in [`../cells-completeness/completeness.md`](../cells-completeness/completeness.md): "explicitly-seamed" → "enforceable + trusted" — a cell is valuable only when its contract is trusted.)*

Complete + bounded + enforceable-and-trusted. A cell is the unit you can pick up whole,
understand alone, and work on without needing the rest.

## 3. Who it's for

> *Revised in the mechanism alignment review: the original "co-equal by convergence" stance
> was corrected to **model-primary**. Retained framing below; the current truth is the
> model-primary paragraph.*

**Cells is model-primary; humans architect it and see/use it.** The design *target* is the
model (context-fit, payload retrieval, membrane navigation are model-cognitive). Humans
aren't excluded — they hold a distinct, elevated role:

- **Human = architect + overseer.** Decides each cell's role/responsibility, does the
  partitioning, sees the connections and how cells fit. ("Good design is the developer's
  job." Humans *own* the architecture — the model never auto-cuts cells in ways humans find
  awkward.)
- **Model = worker.** Operates *within* cells — retrieves the payload, navigates via
  membranes, fixes bugs, writes code.

**The unit is shaped for the model; humans design the shape and watch the result.** (The
outcome may still help both — a well-shaped cell is good for a human too — but the *design
intent* is model-primary, not co-equal.) This is why Cells exists for **LLMs coding
alongside humans**: the human architects, the model labors.

## 4. What's new

Cells **defines** the work unit. Everything else today **selects**.

- Aider's repo map, Code RAG, LSP-based resolution, code knowledge graphs — all assume
  code is organized by humans and try to feed the model the right *slice*. The unit is
  always a slice the tool picks, never a first-class unit the code is organized into.
- The field's own answer to the Navigation Paradox is still *better selection* — never
  *define the unit so selection becomes unnecessary*.

Cells inverts the relationship. Instead of human-organized code plus model-selects-
context, the unit is defined *by what's needed to do the job*. You don't find the right
context for a problem; the problem *is* a cell, complete and bounded.

For contrast (not commitment): bounded-unit structures humans already use — DDD bounded
contexts, Ruby `packs`/Packwerk, the actor model, pure-FP effect systems — are
domain-bounded, folder-based, and built for human modularization. Cells borrows their
deepest insight — Packwerk's "make seams explicit and visible, don't just prevent
coupling" — but re-bounds the unit from *domain* to *model-needs*, and rejects the folder
anchoring they all assume.

## 5. Why it matters

A defined, complete, bounded, enforceable-and-trusted work unit converts the two hardest
problems in LLM-and-human coding into tractable ones:

- **Context is always sufficient, by construction.** Work one cell at a time; it fits,
  and it's whole.
- **Reasoning becomes compositional.** Global reasoning over a tangled graph is where
  both models and humans fail. Reasoning about one complete cell, then about the seams
  between cells, is where both succeed.
- **Maintenance rot is prevented structurally, not hoped for.** You can't reach into
  another cell's internals — only connect at the seam. Clean boundaries are enforced by
  the unit, not by discipline. (This is the *emergent* build-safety benefit — a
  consequence of the design, not the primary goal.)
- **Work parallelizes.** Each cell is an independent unit of work for a model or a human;
  seams define the interface between concurrent efforts.
- **Verification is local.** A complete cell with enforceable seams is testable in isolation.

## 6. Scope — what this vision is and isn't

**In scope (this vision):** what Cells *is* — the problem, the essence of a cell, who
it's for, what's new, and why it matters. Enough to orient a future effort.

**Out of scope (deferred to a future build effort)** — returned to only as a fresh
effort, not a resumption:

- How cells are **declared** (named references over content? contracts? files? —
  undecided).
- How boundaries are **enforced** (tooling, a language unit, honor system).
- The **division** act — when and how a cell over budget splits.
- The **format / language** Cells targets.
- **I/O-contract specifics** — black-box input/output was an *illustration* of "explicit
  seams," not a commitment. Real code's state and side effects (the "a black box isn't
  pure" problem) are a mechanism concern, deferred.
- **Git interop** — "cells alongside git" is an aspiration, not a designed feature.

## 7. Open questions for the future effort

- **Completeness (the crux).** "Everything a model needs" is the heart of the definition,
  but what completeness *minimally requires* is not yet pinned down — it drifts into
  mechanism the moment you try. The strongest hint from this effort: completeness looks
  like *a cell's internals plus the seams (contracts) of the cells it connects to*.
  Resolving this is job one for the build effort.
- All of the deferred mechanism in §6.

## 8. Origin notes (color, not commitment)

This vision was found by wayfinding. Several vivid framings came up along the way —
**code-as-circuit** (black-box I/O boxes wired edge to edge), **git for space** (track
code through space the way git tracks it through time), and **cells declared like
branches** (cheap named references over content). They are useful intuition and may guide
the build, but none is a committed design. The vision leads with the essence; these are
color.

---

*Decisions recorded in [`map.md`](map.md); prior-art findings in [`research/prior-art.md`](research/prior-art.md).*
