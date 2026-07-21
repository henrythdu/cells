---
Title: Cells — completeness (wayfinder map)
Labels: wayfinder:map
Effort: cells-completeness
Tracker: local-markdown (.scratch/cells-completeness/)
Predecessor: ../cells-vision/vision.md
---

# Cells — Completeness

## Destination

A **Cells completeness decision**: pin down what *"everything a model needs to work on one
problem"* minimally requires — including how **state / effects / environment** fit (the
"a black box isn't pure" problem). Once resolved, the mechanism fog (declaration /
division / seams / format / git-interop) graduates into a *fresh* mechanism-design effort.

This effort is **completeness only.** It does not design how cells are built.

## Notes

- **Source of truth:** [`../cells-vision/vision.md`](../cells-vision/vision.md) — canonical
  definition, positioning, constraints, prior art. Read it before working any ticket.
- **Canonical definition (locked):** a cell = everything a model needs to work on one
  problem, fitting its context window. Complete + bounded + explicitly-seamed.
- **Why completeness is the keystone:** everything else (mechanism) hangs off what
  "everything needed" turns out to *mean*. You can't design declaration, division, or
  seams until you know what a cell must contain.
- **Strongest hint from the vision:** completeness ≈ *a cell's internals + the seams
  (contracts) of the cells it connects to.*
- **The hard part (flagged in vision):** real code has state, side effects, shared
  environment (DB, FS, network, globals, async). "Inputs → outputs" is false for most real
  code. **Effects must be part of completeness** — otherwise the cell looks complete but
  isn't.
- **Standing constraints (carry from vision):** don't anchor on human-programming
  conventions; Cells is for *LLMs coding alongside humans*; must not collapse to
  "better modules."
- **Skills every session consults:** `/grilling`, `/domain-modeling`. Update
  `CONTEXT.md` (repo root) when domain terms lock.
- **Tracker:** local-markdown, `.scratch/cells-completeness/`.

## Decisions so far

<!-- one line per closed ticket: gist + link. Empty until tickets resolve. -->

- [How systems model "what's needed" + effects](issues/04-research-needed-and-effects.md) — borrow, don't invent: Wasm Component Model (imports/exports = seams) is closest; DbC adds contracts; effect systems + capabilities handle "does to the world." Gap: none bound the unit by model-needs + one-problem. Findings: [`research/needed-and-effects.md`](research/needed-and-effects.md).
- [What is the unit of work a cell is complete-for?](issues/01-what-is-a-problem.md) — purpose-absolute ("one problem" = the cell's responsibility, fixed; tasks decompose across complete cells); responsibility = the DECLARED CONTRACT (provides + requires); locality = know neighbors only via their contracts. Unblocks 02 + 03.
- [What must a cell contain to be complete?](issues/02-what-must-a-cell-contain.md) — mandatory set = declared contract + internals + contracts of ALL required neighbors (surfaces only, never internals). Tests/examples/domain-context OPTIONAL. Locality confirmed. Footprint grows with neighbor count ⇒ division must reduce coupling, not just slice internals.
- [How do state/effects/env fit into completeness?](issues/03-effects-state-env.md) — stance = **Declare + verification** (code not forced pure; declaration checked). Enforcement upgraded to **load-bearing companion**, not deferred bonus. Trust graduated: structural (cheap) / effects (medium) / semantic (hard). **Refines the core problem: contracts must be enforceable + trusted, not just explicit.** Frontier now empty — completeness destination reached.

## Not yet specified

- **What's a "seam/contract" concretely** — the bridge between completeness and mechanism.
  Sharpens as completeness lands; likely graduates into the mechanism effort.
- **How to VERIFY completeness** — belongs to *enforcement* (deferred mechanism). Parked.
- **Completeness ↔ boundedness tension:** if "everything needed" exceeds the window,
  *complete* and *bounded* conflict. Resolved by *division* (deferred mechanism). Useful
  framing to carry: completeness is implicitly *"everything needed that fits"*; overflow
  means the *problem* must subdivide, not that the cell is incomplete.

## Out of scope

*This effort is completeness only. The rest of mechanism returns as a fresh effort once
completeness is settled.*

- How cells are **declared** (refs / contracts / files).
- How boundaries are **enforced** (tooling / language unit / honor system) — incl.
  verifying completeness.
- The **division** act (when/how a cell over budget splits).
- **Format / language** Cells targets.
- **I/O-contract / seam specifics.**
- **Git interop.**
