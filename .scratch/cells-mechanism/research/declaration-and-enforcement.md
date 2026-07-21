# How systems declare + enforce interface-like component contracts

*Research for [ticket 03](../issues/03-research-declaration-and-enforcement.md). Feeds
[declaration](../issues/01-declaration.md) and [enforcement](../issues/02-enforcement.md).*

## TL;DR

**The ingredients all exist — Cells assembles them around the completeness model.** No
single system pairs *interface-like declaration* with *tiered enforcement* (structural /
effects / semantic) AND bounds the unit by *model-needs*. Each does one slice:

- **Declaration** — WIT (Wasm IDL) writes the contract; JPMS (Java modules) bounds a unit
  with code + manifest; Packwerk bounds with folder + `package.yml`.
- **Enforcement** — structural: JPMS (JVM runtime), Packwerk / dependency-cruiser /
  ArchUnit (static analysis); effects: Koka (type system, compile-time).
- **The Cells shape** — interface-like declaration + tiered trust + complete/bounded-for-
  model — is an **unclaimed combination**, not a reinvention.

## 1. Declaration candidates (feeds ticket 01)

| System | How a contract is written | How a unit is bounded | Enforced? |
|---|---|---|---|
| **WIT / wac (Wasm)** | IDL: interfaces (`func`s) + **worlds** (import/export bundles) | a component = compiled unit matching a world | yes — static IDL compilation; runtime validates |
| **JPMS (Java modules)** | `module-info.java`: `requires` + `exports` (+ `uses`/`provides`) | a module = packages in a JAR/dir + manifest | yes — **JVM strong encapsulation** (unexported pkgs inaccessible) |
| **Packwerk (Ruby)** | `package.yml` per package (deps, privacy) | a package = a **folder** | yes — static dep + privacy checks |
| **OpenAPI / protobuf** | IDL spec file | n/a (API only, not code unit) | partial — codegen + validators |

**Transferable to Cells:**
- **WIT** is the cleanest *contract form* — an IDL declaring imports/exports (matches
  Cells' "provides + requires") without committing to behavior. Good model for the
  contract artifact itself.
- **JPMS** is the closest *unit-that-bounds-code + enforced encapsulation* — module =
  code + manifest, JVM-enforced. Strong analog for "what makes a region one cell" AND for
  structural enforcement at runtime.
- **Packwerk** is the closest *layer-over-existing-files* stance — folder + manifest,
  static enforcement, no language change. Fits the explore-existing-code use case.

## 2. Enforcement candidates (feeds ticket 02)

| Tier | System | How it checks |
|---|---|---|
| **Structural** (deps/wiring/encapsulation) | JPMS | JVM runtime |
| | Packwerk / dependency-cruiser / ArchUnit | **static analysis** (deps, privacy, layers, cycles) |
| | WIT | static IDL compilation |
| **Effects** (reads/writes/calls) | Koka | **type system**, compile-time — infers `:exn` / `:div` / `:total`; proves "no unhandled exception" from the type |
| **Semantic** (pre/post/invariants) | (DbC: Eiffel/JML — from completeness research) | runtime asserts / static provers (partial) |

**Transferable to Cells:**
- **Structural tier is solved and cheap** — multiple off-the-shelf static analyzers
  (Packwerk / dependency-cruiser / ArchUnit) enforce dep + privacy + layer rules on
  arbitrary existing code. This is Cells' trust *floor*, available today, no language
  change. Strong support for the **Declare + verification** stance working on real code.
- **Effects tier has a proven model (Koka) but is language-bound** — Koka's type system
  infers + checks effects, but only for Koka. For arbitrary code, effects enforcement
  needs static inference tooling (harder, partial). This is the medium-cost tier.
- **Semantic tier is the hard one** — DbC runtime asserts + provers; always partial.

## 3. The "what's new" gap

Every system above declares OR enforces **one tier**, for **one language/ecosystem**,
bounded by **technology** (types, capabilities, the JVM). **None**:
- pairs interface-like declaration with **tiered** enforcement, AND
- bounds the unit by **model-needs / completeness / context-fit**.

Cells' mechanism novelty = **assembling** WIT-style declaration + tiered enforcement
(structural cheap, effects medium, semantic hard) **around the completeness model**
(complete + bounded + purpose-absolute, for model + human). Ingredients exist; the
combination + the organizing axis don't.

## Implications for the tickets

- **[01 Declaration]:** WIT gives the contract *form*; JPMS gives the *unit-that-bounds-
  code + enforced encapsulation* analog; Packwerk gives the *layer-over-files* stance.
  The fork to resolve: contract-as-IDL-file vs code-annotations vs manifest; and
  layer-over-files vs first-class unit.
- **[02 Enforcement]:** the structural tier is **off-the-shelf and cheap** — argue for it
  as the required floor. Effects tier: borrow Koka's *model*, accept that tooling for
  arbitrary code is the medium-cost research area. Semantic tier: best-effort. A
  **Require strict-mode** ≈ "Koka-style: code must be effect-typed" — powerful but
  language-bound; an opt-in ceiling, not a floor.

## Sources

- WIT / Wasm Component Model — https://component-model.bytecodealliance.org/design/wit.html
- wac (component composition) — https://github.com/bytecodealliance/wac/
- Java modules (JPMS) — https://dev.java/learn/modules/intro/
- Packwerk (Shopify) — https://shopify.engineering/enforcing-modularity-rails-apps-packwerk
- dependency-cruiser — https://github.com/sverweij/dependency-cruiser
- ArchUnit — https://www.archunit.org/userguide/html/000_Index.html
- Koka (book) — https://koka-lang.github.io/koka/doc/book.html
- Koka effect types — https://arxiv.org/pdf/1406.2061
