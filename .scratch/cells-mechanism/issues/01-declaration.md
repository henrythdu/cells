---
Title: How is a cell physically declared?
Labels: wayfinder:map, wayfinder:grilling
Type: grilling
Status: resolved
Blocked by:
Parent: cells-mechanism/map.md
---

## Question

How is a cell **physically declared** — (1) the form of its enforceable, interface-like
contract, and (2) how a cell bounds code (what makes a region of code "one cell")?

This is the **keystone:** enforcement *tooling*, division, format, and git-interop all
depend on the answer.

### Context

- A cell = an **enforceable, interface-like contract** (provides + requires + effects) +
  internals + neighbors' contracts; complete + bounded; purpose-absolute
  ([completeness](../cells-completeness/completeness.md)).
- Earlier *illustrative* framings (NOT commitments): branch-like refs over content;
  convention-over-files; first-class code unit; computed AI-facing index. Now constrained:
  the contract must be **enforceable + interface-like**.
- The deferred fork from the vision is now forced: does Cells **layer over files**
  (convention/lens on existing code) or **replace them** (first-class unit)?

### Decisions to land

1. **Contract's physical form** — how is the interface-like contract expressed? A spec
   file (WIT / OpenAPI)? code annotations / types? inferred-from-code + a manifest? a new
   declaration language?
2. **How a cell bounds code** — what makes a set of code "one cell"? A directory? a marked
   region? an explicit membership list? a graph selection?
3. **Relationship to existing code** — layer-over-files (explore-existing viable) vs
   first-class unit (opt-in authoring)? (Decides whether the explore use case survives.)

### How to resolve

`/grilling` + `/domain-modeling`; lean on [research](../research/) and seriously consider
`/prototype` — a concrete example declaration to react to. Concept-level; don't drift into
enforcement *tooling* (that's [02](02-enforcement.md)).

## Comments

## Answer

**A cell is a logical object — not a filesystem citizen — that owns a non-overlapping region of code and carries an enforceable contract (its membrane). It is retrievable, on demand, as its full completeness payload. Physical code structure is the author's choice and irrelevant to cells.**

Resolved by grilling this session. Four sub-decisions + refinements:

**1. Nature & source — first-class authored artifact, model-scaffolded.** A cell's declaration is *authored* (it carries responsibility, which is not inferable from code). On existing code, a **model scaffolds** it — reads the code, drafts contract + ownership, human refines — so code is **not refactored**; the migration cost is paid by the model, not the human. On new code, the human authors it. → "Relationship to existing code" = **layer via scaffolded authored declarations**; explore-existing stays viable.

**2. Binding — provenance / spatial ownership, not names.** Code binds to a cell by **who made it under the cell** (provenance), tracked as **spatial ownership** — cells track code through *space* the way git tracks it through *time* (orthogonal axes). NOT a name-manifest (drifts on rename/move/delete); NOT git-literal (git is the analogy, not the substrate). **The contract is the gate.** Git-interop stays deferred fog.

**3. Partition — non-overlapping.** Cells **partition** space: each code element owned by exactly one cell. Shared / cross-cutting code becomes **its own cell that others *require***. (No overlap = no selection/duplication — the move Cells defined itself against.)

**4. Form — logical cell-object, structure-agnostic.** A cell is a **logical object**, not a file. Physical structure (folders, trees) is the author's choice and **irrelevant** to cells. **Addressing = search + ownership** ("what owns this?", "which cell handles this?"), not paths — the model navigates via ownership + contracts, never a file tree. De-anchored entirely from "file vs annotations vs manifest."

**Two refinements:**
- **Declaration vs payload.** The *authored declaration* is small (contract/membrane + ownership claim). The *retrieval payload* — what "explore cell A" returns — is the **whole completeness footprint** (declaration + owned internals + required neighbors' contracts). The cell hands over completeness; the model never hand-assembles it.
- **Locality, precisely.** Internals are **strictly local** (never two cells' internals). Contracts are **shared** — a contract-level bug (membrane mismatch between A and B) may require reasoning about two membranes, but contracts are cheap. "One cell at a time" holds for internals; contracts may be jointly reasoned.

**Guiding intuition (metaphor):** cells like **biological cells** — membrane = enforceable contract (selectively permeable = capabilities/effects); specialization = purpose-absolute; non-overlapping = partition; communicate via membrane receptors = requires/provides seams; compose into the **program** (the organism). Productively foreshadows: **division = mitosis** (a too-big cell divides — the fog division mechanism, now well-named).

**Load-bearing consequence — cells need an index.** Search/ownership addressing presupposes a **queryable Cells layer**: a code→cell ownership map + a cell→contracts graph. **Cells = objects + a searchable index.** The storage/index *implementation* stays deferred (mechanism); the *requirement* is locked.

**Deferred (out of this ticket — "form slowly"):** physical storage/index implementation (store / graph / files-as-projection); git-interop (coexistence with real repos); what's *in* the membrane beyond provides/requires/effects; ownership-mechanism specifics (how provenance is tracked).

*Fed by [research](../research/declaration-and-enforcement.md) (WIT / JPMS / Packwerk / Koka) — but the de-anchored logical-object form goes beyond all of them.*
