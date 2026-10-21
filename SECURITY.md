# Security Policy

## Reporting a vulnerability

Report a security issue in private through the GitHub
[Private Security Advisory](https://github.com/henrythdu/cells/security/advisories/new)
page. Do **not** open a public issue for a security problem.

You will receive an acknowledgment within 3 business days. After the triage, a fix
arrives in the next patch release. If you cannot file an advisory (for example, the
repository is read-only for you), send an email to the maintainer:

- **henrythdu** — `henry.du@users.noreply.github.com`

## Trust model

`cells` is designed to run in CI on **untrusted repositories**. The following
points are trust boundaries. A repository must not be able to make `cells` read,
write, or report anything outside its own tree.

- **Path containment.** The tool rejects an owned path that is absolute, that
  escapes with `..` (`isUnsafePath` in `src/validate.ts`), or that resolves
  outside the repository root through a symlink (`readFiles` in `src/io.ts`).
- **Never zero without a warning.** A file that exists but cannot be read throws
  an error. It never produces a graph with empty content without a warning
  (`src/io.ts`).
- **Name validation.** `cells remove`, `cells rename`, and `cells assign` reject
  a cell name or a path that would touch anything outside `.cells/`
  (`src/mutate.ts`).

A bug in one of these boundaries is a security bug. See
`docs/adr/0001-bridge-crossings.md` for the architecture below these boundaries.

## Supported versions

Only the latest published version receives a security fix. The project provides no backports.

## Supply chain

- The runtime dependencies are few and pinned. `pnpm audit` runs in CI and must
  stay clean.
- An npm publish has a provenance attestation (`--provenance`).
- The CI actions are pinned to full commit SHAs.

## Reporting scope

This policy does not cover a CVE in the tree-sitter grammar binaries of the tool,
which come from upstream, or the behavior of a third-party repository under
analysis.
