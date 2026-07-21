---
Title: How do systems declare + enforce interface-like component contracts?
Labels: wayfinder:map, wayfinder:research
Type: research
Status: resolved
Blocked by:
Parent: cells-mechanism/map.md
---

## Question

How do existing systems **declare** and **enforce** interface-like component contracts,
and what transfers to Cells' declaration ([01](01-declaration.md)) and enforcement
([02](02-enforcement.md))?

### Areas to cover

1. **Interface/contract declaration languages** — Wasm WIT + component tooling (wac,
   wasm-tools); OpenAPI / protobuf / gRPC; Cap'n Proto; ML module signatures; Haskell
   typeclasses; Rust traits; Go interfaces. How is the contract *written*, and is it
   *enforced* or just *documented*?
2. **Architecture / dependency enforcement** — Packwerk (Ruby), ArchUnit (Java),
   dependency-cruiser / madge / Knip, eslint-plugin-boundaries. What do they enforce
   (deps, privacy, layering) and how (static, at CI, runtime)?
3. **Effect / capability systems tooling** — Koka's effect checker; Wasm component
   capabilities; seL4/capDL; effect trackers for TS/Python. How are effects/capabilities
   declared AND checked against arbitrary code?
4. **"Cell-like" code units** — Ruby `packs`, Scala, Java modules (JPMS), .NET assemblies,
   Erlang/OTP apps, OSGi. How do they declare + bound a unit, and what's enforced?

### Output

Findings at `.scratch/cells-mechanism/research/declaration-and-enforcement.md` ranking:
what **declares** a contract most like Cells (feeds 01), what **enforces** the tiers most
cleanly (feeds 02), and the transferable patterns. Note any system that already pairs
*interface-like declaration* with *tiered enforcement* (the Cells shape).

## Comments

## Answer

Findings at [`research/declaration-and-enforcement.md`](../research/declaration-and-enforcement.md).

**One-line gist:** ingredients all exist — Cells ASSEMBLES them around the completeness
model. **Declaration:** WIT (IDL contract form), JPMS (unit = code + manifest, JVM-enforced
encapsulation), Packwerk (folder + manifest, layer-over-files). **Enforcement:**
structural tier is OFF-THE-SHELF + CHEAP (Packwerk / dependency-cruiser / ArchUnit — static
analysis on arbitrary code, no language change); effects tier proven in Koka (type system)
but language-bound; semantic tier hard/partial. **Gap:** no system pairs interface-like
declaration + tiered enforcement + model-needs bounding — Cells' shape is an unclaimed
combination.

Feeds [01 (declaration)](01-declaration.md) and [02 (enforcement)](02-enforcement.md).

## Comments
