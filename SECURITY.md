# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub's
[Private Security Advisory](https://github.com/henrythdu/cells/security/advisories/new)
— do **not** open a public issue for them.

You can expect an acknowledgment within 3 business days, and a fix in the next
patch release once triaged. If the advisory cannot be filed (e.g. the
repository is read-only for you), email the maintainer directly:

- **henrythdu** — `henry.du@users.noreply.github.com`

## Trust model

`cells` is designed to run on **untrusted repositories** in CI. The following
are treated as trust boundaries — a repo must not be able to make `cells` read,
write, or report anything outside its own tree:

- **Path containment** — owned paths are rejected if absolute, `..`-escaping
  (`src/validate.ts` `isUnsafePath`), or resolving outside the repo root via
  symlink (`src/io.ts` `readFiles`).
- **Never-silent-zero** — a file that exists but cannot be read throws instead
  of silently producing an empty-content graph (`src/io.ts`).
- **Name validation** — `cells remove` / `cells rename` / `cells assign` reject
  cell names and paths that would touch anything outside `.cells/`
  (`src/mutate.ts`).

A bug in any of these boundaries is a security bug. See
`docs/adr/0001-bridge-crossings.md` for the architecture the boundaries sit on.

## Supported versions

Only the latest published version receives security fixes. Backports are not
provided.

## Supply chain

- Runtime dependencies are minimal and pinned; `pnpm audit` runs in CI and must
  stay clean.
- npm publishes are provenance-attested (`--provenance`).
- CI actions are pinned to full commit SHAs.

## Reporting scope

Not covered: CVEs in the tool's tree-sitter grammar binaries (bundled from
upstream), or behavior of third-party repos being analyzed.
