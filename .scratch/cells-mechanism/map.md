---
Title: Cells — mechanism (wayfinder map)
Labels: wayfinder:map
Effort: cells-mechanism
Tracker: local-markdown (.scratch/cells-mechanism/)
Predecessors: ../cells-vision/vision.md, ../cells-completeness/completeness.md
---

# Cells — Mechanism

## Destination

A **Cells mechanism design spec for the core:**
- **(a) Declaration** — how cells are physically declared: the form of the enforceable,
  interface-like contract, and how a cell bounds code (what makes a region "one cell").
- **(b) Enforcement** — the verification design: the trust tiers, what's checked, how,
  strictness, and a possible Require-style strict mode.

**Division, format/language, and git-interop stay fog** and graduate after declaration
lands. This effort is declaration + enforcement only.

## Notes

- **Source of truth — read before any ticket:**
  [`../cells-vision/vision.md`](../cells-vision/vision.md) (what Cells is) and
  [`../cells-completeness/completeness.md`](../cells-completeness/completeness.md) (what
  *complete* means).
- **Cell recap (from completeness):** an enforceable, interface-like contract (provides +
  requires + effects) + internals + neighbors' contracts; complete + bounded;
  purpose-absolute. Locality = know neighbors by contract only.
- **Enforcement is LOAD-BEARING, not optional** (completeness §3): a cell is valuable only
  when its contract is trusted. Trust tiers: **structural** (cheap) / **effects** (medium)
  / **semantic** (hard). Stance = Declare + verification (not purity); a possible
  **Require-style strict mode** sits at the top of the dial.
- **Declaration is the KEYSTONE:** everything — enforcement *tooling*, division, format,
  git-interop — depends on how a cell is physically declared. Resolve it first.
- **Carried insight (completeness↔boundedness):** completeness footprint grows with
  neighbor count ⇒ future *division* must cut **coupling**, not just slice internals.
- **Standing constraints (carry from vision):** don't anchor on human-programming
  conventions; Cells is for *LLMs coding alongside humans*; must not collapse to "better
  modules."
- **Skills every session consults:** `/grilling`, `/domain-modeling`, `/prototype`
  (mechanism benefits from concrete artifacts to react to). Update `CONTEXT.md` (repo
  root) when domain terms lock.
- **Tracker:** local-markdown, `.scratch/cells-mechanism/`.

## Decisions so far

<!-- one line per closed ticket: gist + link. Empty until tickets resolve. -->

- [How systems declare + enforce interface-like contracts](issues/03-research-declaration-and-enforcement.md) — ingredients exist; Cells assembles them. Declaration models: WIT (IDL), JPMS (code+manifest, JVM-enforced), Packwerk (folder+manifest). Enforcement: structural tier off-the-shelf + cheap (static analyzers on arbitrary code); effects tier proven in Koka but language-bound; semantic hard. Gap: no system pairs interface-like declaration + tiered enforcement + model-needs bounding. Findings: [`research/declaration-and-enforcement.md`](research/declaration-and-enforcement.md).
- [How is a cell declared?](issues/01-declaration.md) — a cell is a **logical object** (not a filesystem citizen): owns a **non-overlapping (partitioned)** region of code by **provenance / spatial ownership**, carries an enforceable **contract (membrane)**, and is retrievable as its full **completeness payload**. Structure-agnostic (folders/tree = author's choice). Addressing = **search + ownership**, not paths. Declaration is **authored, model-scaffolded on existing code** (no refactor; migration cost paid by the model). Git = **analogy** (tracks time; cells track space — orthogonal); git-interop deferred fog. **Cells = objects + a searchable index** (requirement locked; impl deferred). Bio-cell metaphor adopted. Locality scalpel: internals strictly local; contracts shared / jointly-reasonable (cheap). Form to be refined slowly (what's *in* the membrane).
- [How is a cell's contract enforced?](issues/02-enforcement.md) — **REVISED (alignment review): core mechanism is VISIBILITY, not a gate.** Cells *reveals* cross-cell crossings + attributes errors; does NOT enforce a way of coding; membranes/SoC *emerge* from developers seeing structure. **The ONE enforced rule = SIZE/boundedness** (context-fit; too big → **divide**). Everything else (leakage, interface quality, partitioning, internals) is visibility/discipline — messy cells are valid. The hard **leakage-gate is OPT-IN strict-mode** (= Require-mode ceiling) for guarantees. Grades still descriptive + local (direct neighbors only, no contagion). **Division promoted fog → CORE** (consequence of size-enforcement). Capstone: Cells = **visible membranes** + attribution + completeness-for-navigation; **complete ≠ clean-internals**. (Gate-centric grailing history retained in the ticket.)

## Not yet specified

- **Division** — when/how a cell over budget splits; must cut coupling, not just slice
  internals. Blocked by declaration (can't define splitting without knowing what a cell
  *is* physically).
- **Format / language** — what Cells targets. Blocked by declaration + enforcement.
- **Git interop** — "cells alongside git" / the "git for space" framing. Blocked by
  declaration.

## Out of scope

- **Building Cells** (actual implementation) — this is a design spec; plan-don't-do.
- **Division / format / git-interop** until they graduate from the fog above.
