---
Title: Cells — vision & scope (wayfinder map)
Labels: wayfinder:map
Effort: cells-vision
Tracker: local-markdown (.scratch/cells-vision/)
---

# Cells — Vision & Scope

## Destination

A **Cells vision + scope doc**: what Cells is (its essence), the problem it solves
(LLMs coding alongside humans), who/what it is for, and what is in vs out of scope.
**Mechanism-agnostic** — no build, no format/language, no enforcement design, no
division algorithm. Concrete enough to hand to a future effort that designs and
builds Cells.

## Notes

- **Problem domain.** LLMs coding alongside humans. Cells solves the *missing unit*:
  there is today no defined "what a model needs to see to work on one problem," so we
  either starve the model (partial context → confusion, hallucinated couplings) or
  drown it (whole codebase → blown window, reasoning collapses).
- **Canonical definition (locked, user-stated).** A cell is *everything a model needs
  to know to work on a problem, and it fits in the model's context window.* Complete +
  bounded, by definition. Complete = nothing missing it needs; bounded = fits the
  window.
- **Standing constraint (from user — load every session).** Do NOT anchor on
  human-programming conventions (files / modules / functions / OOP / folders — those
  serve *human* cognition). Cells is native to a different axis: *model cognition +
  human-model collaboration*. Learn from what we know, but do not copy its organizing
  principle. **The vision must not collapse to "better modules."**
- **Explore-primary, build-safety emergent.** Primary value = a model navigates and
  works one cell at a time (explore / locality). Build-safety (no maintenance rot, no
  breaking changes) is an *emergent property* of complete+bounded cells with explicit
  seams — not the primary goal. (Decided in charting; refinable.)
- **Illustrations vs commitments.** Black-box I/O, "code-as-circuit," "git for space,"
  "cells declared like branches" were all *illustrations* of the essence used while
  charting. None is a committed mechanism. Mechanism is out of scope for this effort.
- **Skills every session should consult:** `/grilling`, `/domain-modeling`. Create
  `CONTEXT.md` (repo root) once domain terms lock.

## Decisions so far

- [Prior art toward context-bounded work units for LLMs](issues/02-prior-art.md) — every approach *selects* context from human-organized code; none *defines* a complete, context-bounded unit by model-needs. "What's new" = defining the unit, not selecting a slice. Findings: [`research/prior-art.md`](research/prior-art.md).

## Not yet specified

- **"Completeness" — the crux (ripening).** "Everything a model needs" is the heart
  of the definition. Positioning sharpened it slightly: completeness looks like *a cell's
  internals + the seams (contracts) of the cells it connects to* — but pinning that down
  drifts into deferred mechanism (what's a seam/contract?). Still fog; left for the future
  build effort. The vision doc can state it as an open question.

## Out of scope

*All build / mechanism — deferred to a fresh effort once the vision is settled. Returns
only if the destination is redrawn, then as a new effort, not a resumption.*

- How cells are **declared** (branch-like refs? contracts? files? — all undecided).
- How cell boundaries are **enforced** (tooling, language unit, honor system).
- The **division** algorithm / act (when and how a cell splits).
- **Format / language** Cells takes (agnostic, specific, or a new one).
- **I/O-contract specifics** — black-box input/output was an *illustrative example*,
  not a commitment. Real code's state/effects (the "black box isn't pure" problem) is a
  mechanism concern, deferred.
- **Git interop** — "cells work alongside git" is a desire, not a designed feature;
  deferred.
