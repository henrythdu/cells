---
Title: How is a cell's contract enforced / verified?
Labels: wayfinder:map, wayfinder:grilling
Type: grilling
Status: resolved
Blocked by:
Parent: cells-mechanism/map.md
---

## Question

How is a cell's contract **enforced / verified**? Design the trust tiers, what's checked,
how, the strictness dial, and whether there's a **Require-style strict mode**.

Concept-level here; *tooling* detail waits on [declaration](01-declaration.md).

### Context

- **Enforcement is load-bearing** (completeness §3): a cell is valuable only when its
  contract is *trusted*. An unenforced interface is worthless.
- **Trust tiers** (from completeness): **structural** (types/wiring — cheap) /
  **effects** (reads/writes/calls/capabilities — medium) / **semantic**
  (pre/post/invariants/behavior — hard).
- Stance = **Declare + verification** (not purity). A possible **Require strict-mode**
  (effect-bounded by construction) sits at the top of the dial.

### Decisions to land

1. **Tier coverage** — which tiers are a required *floor* vs optional? (Working hypothesis:
   structural = floor; effects strongly desired; semantic best-effort.)
2. **How each tier is checked** — compiler/types (structural)? static analysis / inference
   (effects)? tests / proofs / runtime (semantic)?
3. **Strictness dial + Require-mode** — is there an opt-in strict mode where cells must be
   effect-bounded by construction? When is its adoption cost worth it?
4. **On violation** — error / warning / "it's not a cell"? What restores trust?

### How to resolve

`/grilling` + `/domain-modeling`; lean on [research](../research/). Coordinate with
[declaration](01-declaration.md) — the tiers are concept-stable, but *how* they're checked
depends on the declaration form.

## Comments

## Answer

> **⚠ REVISED — alignment review (same session): the core mechanism is VISIBILITY, not a gate.**
> The grilling record below landed a gate-centric model; a follow-up review **re-prioritized**
> it. **Current truth** (where it conflicts with the text below, this wins):
>
> - **Default mechanism = VISIBILITY.** Cells *reveals* cross-cell crossings (contents,
>   inbound/outbound connections) and *attributes* errors to owning cells. It does **not**
>   reject or enforce a way of coding. Membranes and separation-of-concerns **emerge** from
>   developers *seeing* the structure.
> - **The ONE enforced rule = SIZE / boundedness (context-fit).** A too-big cell **must
>   divide** → **division is now CORE** (no longer fog). Size is measurable (token-count of
>   the payload vs a configurable context budget); responsibility-fit is guided by visibility,
>   not enforced. This is the only place "messy but valid" doesn't apply.
> - **Everything else is visibility/discipline** — leakage, interface quality, partitioning,
>   internal design. A leaky cell is **valid, with visible leakage** — not rejected.
> - **The hard leakage-gate is OPT-IN strict-mode** (= the Require-mode ceiling), for cells
>   wanting a guarantee. Enforcement moves from constitutive floor → opt-in ceiling.
> - **Capstone:** Cells = **visible membranes + attribution + completeness-for-navigation.**
> - **Collapse-test locked:** a cell crossing ≠ a module dependency (responsibility-bounded,
>   payload-carrying, navigable as a unit — not a wire in a report).
>
> *Supersedes in particular: "the structural tier GATES cellhood" and "the only hard check."
> The grade/tier detail below is retained as history; grades remain descriptive + local.*

**Enforcement = one new hard check (a structural gate that polices the cell membrane) + attribution of normal errors to cells + descriptive graded trust tiers above. Cells coexists with normal software development; it does not replace it.**

Resolved by grilling this session.

**1. Gate vs grade — hybrid.** The **structural tier GATES** cellhood (constitutive — fail it and the thing isn't a cell). The **effects and semantic tiers GRADE** — a trust ladder above the floor, not mandatory for validity.

**2. The structural floor = membrane discipline.** The gate polices the **membrane, not the internals** — inside a cell anything goes (junk, leftover, bad code); the gate is blind to it. It fires only when code **crosses the membrane** (uses / references / modifies something in another cell) and checks the crossing is **contract-mediated**. Static projection: (a) **provides** (crosses out) real; (b) **requires** (crosses in) resolves to a real neighbor contract; (c) **locality / no-leakage** — every cross-boundary touch goes through a contract, nothing slips the membrane. (Ownership + partition is the *substrate* the membrane sits on, not a membrane check itself.)

**3. Grade semantics — descriptive + consumer-side policy.** Grades are trust *signals*; nothing intrinsically forces behavior. Consumers decide whether to require them. (The load-bearing enforcement is the structural gate; grades above the floor are enrichment.)

**4. Require-mode — opt-in construction-guaranteed ceiling.** The dial's top: code authored in an **effect-bounded mode** (Cells-native / Koka-like) cannot have undeclared effects — trust is *guaranteed by construction*, not verified after the fact. Opt-in; reachable only for effect-bounded-authored code (the "human-authors-new, Cells-native" path from ticket 01). Scaffold-on-existing stays at verify-and-grade. **Mechanism (what the authoring mode is) deferred to fog.**

**5. Grade enforcement — LOCAL, not contagious.** Grades are **computed** (objective — highest tier a cell passes verification for), not self-asserted (no lying). A consumer specifies a required grade for a **direct neighbor only** (`requires B:effects`); the structural gate checks that direct neighbor holds it. **No transitive contagion** — A is never invalidated by C (B's neighbor); locality (completeness) preserved. *Local refinement:* B's effects membrane includes the **declared** effects of neighbors B calls (read from contracts, not internals) — so trust is **compositional**: A trusts B, B trusts C, each link locally verified.

**6. Grounding — Cells attributes errors; it doesn't replace the error system.** Normal dev still works (compile / run / test); errors surface as usual. Cells **maps any error to its owning cell** (via the code→cell index, ticket 01) so you investigate *that* cell.
- *How each tier is checked:* structural gate = Cells-specific static analysis (the only hard check Cells adds); effects = static inference (Koka-model, partial on arbitrary code); semantic = largely the **host language's own tests, now cell-attributed** (richer proofs / DbC optional).
- *On violation:* structural-gate fail → not a cell; normal code breaks → usual error, attributed to owning cell; grade not earned → descriptive (cell valid at lower grade), or if a direct neighbor required it → that neighbor's local gate fails.

**Capstone (the intuitive model):** **Cells = enforced membranes + attribution + completeness-for-navigation. Internals stay the developer's job.** Cells is a **separation-of-concerns-enforcement tool** — it makes SoC decisions real and durable (membranes don't erode); it does not choose the concerns or guarantee clean internals. Consequently **"complete" ≠ clean-internals**: a messy cell with a valid membrane that owns its problem's code is a perfectly good, complete cell.

**Deferred:** the effect-bounded authoring mode (Require-mode mechanism); richer semantic verification (proofs / DbC) above the test-based semantic grade; the physical verification tooling (depends on declaration / storage impl, still fog).

*Fed by [research](../research/declaration-and-enforcement.md) + coordinated with [declaration](01-declaration.md).*
