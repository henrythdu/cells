---
Title: What must a cell contain to be complete?
Labels: wayfinder:map, wayfinder:grilling
Type: grilling
Status: resolved
Blocked by: 01
Parent: cells-completeness/map.md
---

## Question

Given a unit of work (from [What is a problem](01-what-is-a-problem.md)), **what must a
cell contain** to be *complete* — i.e., to leave nothing the work needs missing? Enumerate
the dimensions of "needed," and decide which are mandatory vs optional.

### Candidate dimensions (to test, not assume)

- the cell's **implementation** (the code itself)
- its **types / signatures** (the shape of its surface)
- the **seams/contracts of the cells it connects to** (the strongest hint from the vision)
- **tests** (what correct behavior is)
- **examples / usage**
- **invariants / preconditions / postconditions**
- **error / failure behavior**
- **domain context** (why this cell exists; what real-world thing it models)

### Decisions to land

1. **Mandatory set** — which dimensions are required for completeness, which are nice-to-have?
2. **The neighbor-seams question** — confirm/refine the vision's hint: does completeness
   require the *contracts* of connected cells (their surfaces) but NOT their internals?
   (This is the locality property: work one cell, know the others only by their seams.)
3. **Minimality** — completeness is "nothing missing," not "everything possible." Where's
   the line? (Carries the completeness↔boundedness tension from the map's fog.)

### How to resolve

`/grilling` + `/domain-modeling`; lean on [prior art on what's-needed](../research/) if
fired. Consider `/prototype` (a concrete example cell) to make "complete" tangible.

## Comments

## Answer

Mandatory set decided (grilling). **A cell is complete when it contains:**

1. Its **declared contract** — provides (exports) + requires (imports) + effects/capabilities
   (per [03](03-effects-state-env.md)). A first-class, explicit artifact (per
   [01](01-what-is-a-problem.md) + the Wasm/DbC research), which is what makes completeness
   *measurable*.
2. Its **internals** — the implementation that fulfills what the contract provides.
3. The **contracts of ALL its required neighbors** — every cell it depends on, by their
   *surfaces* (contracts), plural (multi-neighbor confirmed). **Never their internals.**

**Locality (decision 2) — confirmed and sharpened:** to work a cell you need its contract
+ its internals + its N neighbors' contracts, and NONE of their internals. Completeness is
local by construction.

**Minimality (decision 3):** completeness = *nothing missing to fulfill the contract*,
NOT *everything possible*. The three items above are the line. **Tests, examples, and
domain-context are OPTIONAL clarifiers** — useful, sometimes needed to make a contract
understandable, but not structurally required. Where they specify behavior the contract
doesn't capture, they *strengthen the contract* (fold in); otherwise they're aids.

**Effect on the map:**
- **Completeness↔boundedness tension sharpens:** completeness footprint = contract +
  internals + Σ(neighbor contracts). It **grows with neighbor count** — so a cell with many
  neighbors may be complete-but-unbounded (exceeds the window). The deferred DIVISION
  mechanism will therefore have to split by *reducing coupling* (fewer/smaller neighbor
  contracts) or scope, not just by slicing internals. Recorded against the fog.
- Locality is now a hard, measurable property: neighbors known by contract only.
- [03 (effects/state/env)](03-effects-state-env.md) stays the last frontier ticket; it
  fills in the "effects/capabilities" part of the contract referenced in (1).

## Comments
