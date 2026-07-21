---
Title: What is the unit of work a cell is complete-for?
Labels: wayfinder:map, wayfinder:grilling
Type: grilling
Status: resolved
Blocked by:
Parent: cells-completeness/map.md
---

## Question

Completeness is **relative to a unit of work** — a cell is complete *for something*. What
is that something? Pin the granularity of "a problem" so the rest of completeness has a
fixed referent.

### Context

- Canonical definition: a cell is everything a model needs to work on **one problem**.
- "One problem" is currently loose. Candidates: a feature, a bug fix, a refactor, an
  inquiry, a change request, a behavior. The granularity chosen shapes what "needed" means.
- Tension to resolve: is "a problem" **task-relative** (a cell is re-completed per task) or
  **purpose-absolute** (a cell has a stable purpose it's complete-for)? The vision leans
  purpose-absolute ("work on one problem"), but real work is task-shaped.

### Decisions to land

1. **The unit** — what size/kind of work is one cell complete-for?
2. **Relative vs absolute** — does a cell's completeness vary by task, or is it fixed to
   the cell's purpose?
3. **Implication for contents** — given (1)+(2), what does "needed" now minimally span?
   (Feeds [What must a cell contain](02-what-must-a-cell-contain.md).)

### How to resolve

`/grilling` + `/domain-modeling`. Land a definition of "a problem" crisp enough that the
contents question (02) and the effects question (03) can proceed.

## Comments

## Answer

Three decisions landed (grilling):

1. **Relative vs absolute = PURPOSE-ABSOLUTE.** A cell is complete-for its own FIXED
   responsibility — everything needed to understand and modify what the cell owns. Tasks
   (bug fixes, features) **decompose across complete cells**; you traverse cells to do a
   task. Completeness is stable; it doesn't churn per task. Matches the vision's locality
   ("a cell's function is the only thing that matters"; "you don't need to know other
   cells").

   ⇒ *"One problem"* in the canonical definition = **the cell's responsibility**, not the
   task.

2. **What defines a responsibility = the DECLARED CONTRACT.** A cell's responsibility is
   its declared contract: what it **provides** (exports) + **requires** (imports), per the
   [research](../research/needed-and-effects.md) (Wasm Component Model: imports/exports ARE
   the seams). Complete-for-responsibility = holding everything to fulfill that contract.
   This makes "one problem" *measurable* and keeps locality precise: you know other cells
   only via their contracts, never their internals.

   ⇒ Behavior/concept (what the cell *does* / *models*) are the INTERNALS that fulfill the
   contract — [ticket 02](02-what-must-a-cell-contain.md)'s territory. The contract is the
   stable surface completeness is judged against.

3. **Implication for contents (feeds 02).** "Needed" = everything to fulfill the declared
   contract: the cell's internals + the **contracts (seams) of the cells it requires**
   (its imports/neighbors) + (per [03](03-effects-state-env.md)) its declared effects and
   required capabilities. Locality is now precise: to work a cell, you need its internals
   + its neighbors' contracts — not their internals.

**Effect on the map:**
- Fog "what's a seam/contract concretely" — partially cleared: at the CONCEPT level,
  contract = provides + requires (settled). The MECHANISM (how declared/enforced) remains
  deferred. The fog sharpens but its mechanism half stays parked.
- Tickets [02](02-what-must-a-cell-contain.md) and [03](03-effects-state-env.md) are now
  UNBLOCKED and on the frontier.
- Precise responsibility-CARVING (what makes a coherent responsibility; how to split when
  one exceeds the window) stays the deferred DIVISION mechanism — out of scope here.

## Comments
