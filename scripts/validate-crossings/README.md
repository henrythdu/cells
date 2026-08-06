# validate-crossings

Independent audit of cells' import resolution. For each language, an oracle
that is NOT cells' tree-sitter code resolves every import in the repo; the
harness compares the oracle's file→file edges against the product's own
(`cells imports --json`).

## Why

cells' own tests compare new importer vs old importer — both are our code.
The oracle is a different implementation (a real toolchain), so agreement
means the resolution is genuinely correct, not just self-consistent.

## Oracles (per-language toolchains)

| lang | oracle | implementation |
| --- | --- | --- |
| ts | `tsc --traceResolution` | the TypeScript compiler itself |
| rust | `rust-analyzer scip` | semantic resolution, SCIP references |
| go | `scip-go` | semantic resolution, SCIP references |

SCIP → edges: symbol→file map from role-1 (definition) occurrences; every
non-definition occurrence in file F whose symbol is defined in the same
module → edge F→thatFile. File-level sets de-dupe statement-vs-reference
granularity.

## Report classes

- **under-flag** — the oracle resolved an import cells missed. The dangerous
  class (silent drop). Exit code 1 when non-empty.
- **over-flag** — cells resolved something the oracle didn't. Inspect.
- **false unresolved** (ts only — SCIP carries no specifier strings) — the
  compiler resolved a specifier cells flagged unresolved.

The report informs — it never gates cells itself.

## Usage

```bash
node index.mjs <repo-dir> <ts|rust|go> [--top N]
```

Tools resolve via env (`SCIP`, `RUST_ANALYZER`, `SCIP_GO`, `TSC`, `CELLS`),
PATH, then `$HOME/go/bin`. Requires the repo to be a cells project
(`.cells/` present — run `cells init` if not) and a built `dist/cli.js` in
the cells repo.

## Scope

Wave 1: TS/JS (turborepo, express), Rust (ripgrep), Go (terraform).
Wave 2: Java (scip-java + maven), C++ (scip-clang + cmake compile_commands),
Python (scip-python). The C++ and Python oracles carry extra setup
(compile flags / environment) — deferred until the wave-1 loop is proven.

Not shipped: `scripts/` is excluded from the npm package (`files` in
package.json). Users never install the validation tooling.
