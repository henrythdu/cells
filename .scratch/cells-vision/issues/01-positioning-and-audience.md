---
Title: Positioning & audience for the Cells vision
Labels: wayfinder:map, wayfinder:grilling
Type: grilling
Status: resolved
Blocked by:
Parent: cells-vision/map.md
---

## Question

What is the **one-line positioning** of Cells, and **who is it primarily for** — such
that the vision doc has a clear voice and a defensible "what's genuinely new"?

### Context to resolve against

- **Canonical definition (locked):** a cell = everything a model needs to work on one
  problem, fitting its context window.
- **Standing constraint:** do NOT anchor on human-programming conventions; Cells is
  native to *model cognition + human-model collaboration*. The vision must not collapse
  to "better modules."
- **Candidate lenses surfaced while charting** (all illustrative, none committed):
  - "the missing context unit" (problem-first)
  - "code-as-circuit" — black-box I/O boxes wired edge to edge
  - "git for space" — track code through space the way git tracks it through time
  - "cells declared like branches" — cheap named references over content

### Decisions to land

1. **Lead lens** — which framing leads the vision's one-line pitch, and which (if any)
   sit as supporting metaphors?
2. **Audience voice** — is Cells defined by what a *model* needs (model-defined; humans
   benefit by working in the same units), co-equal model+human, or human-defined?
   Working hypothesis: **model-defined.**
3. **"What's genuinely new"** — the novelty claim, refined against the prior-art
   findings in [Prior art toward context-bounded work units](02-prior-art.md). (This
   point depends on ticket 02; points 1–2 can proceed without it.)

### How to resolve

`/grilling` + `/domain-modeling`. One question at a time; land a one-line positioning
and an audience verdict; check it does not collapse to "better modules."

## Comments

## Answer

Three decisions landed (grilling):

1. **Lead lens = Definition-first.** Lead with what a cell IS — the essence (complete + bounded + explicitly-seamed work unit). The gap (no such unit; everyone selects) supports it. Metaphors (code-as-circuit, git-for-space) demoted to **color**, not lead — they're illustrations, not commitments; leading with them re-introduces deferred mechanism.

   Accepted one-line positioning:
   > Cells gives code a first-class work unit: everything needed to do one job — complete, bounded to fit a single context, with explicit seams. The unit that doesn't exist today; everyone selects a slice, nobody defines it. For a model or a human.

2. **Audience voice = co-equal, BY CONVERGENCE.** A cell serves both model and human because **one well-shaped unit** (complete + bounded + explicitly-seamed) is what's good for each — good structure is universal. Not a balance of two axes; one shape seen from two angles. The crisp model-bound (context window) is the operational bound; the human-bound is satisfied by the same shape.

3. **"What's genuinely new"** (folded from [prior-art research](02-prior-art.md)): Cells **defines** the work unit by model-needs as a first-class structure. Every existing approach (Aider repo-map, Code RAG, LSP, code knowledge graphs) **selects** a slice from human-organized code; none defines a complete, context-bounded unit. The field's Navigation Paradox confirms bigger windows don't fix it — but everyone's answer is still *better selection*, never *define the unit*.

**Guard check — must not collapse to "better modules":** PASS. Modules/packages are domain-bounded human conventions that already exist; Cells is a first-class unit defined by completeness+boundedness+seams that *does not exist today* and that *everyone currently lacks*. Different axis (model-needs + convergence), not a refinement of modules.
