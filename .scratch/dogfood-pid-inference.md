# Dogfood: Cells on PID_Inference (Python)

**Date:** session after `adf4064`.
**Target:** `/home/hdu/Projects/PID_Inference` — Python, P&ID (Piping & Instrumentation Diagram) inference.
**Scope:** `src/` only (8508 lines, 50 `.py` files across `vlm/`, `graph1-3/`, `stages/`, `domain/` + root modules). Root entry points (`cli.py`, `pipeline.py`, `gui.py`) excluded — see Gaps.

## Setup

- `.cells/config.toml`: `code-dirs = ["src"]`, `code-exts = [".py"]`, `max-payload-tokens = 16000`.
- First-pass partition by natural sub-package → 7 cells. `cells size` flagged **stages (31560 tok)** and **graph3 (16537 tok)** over ceiling.
- Divided: peeled coherent sub-groups → **11 cells, all within ceiling**, 0 orphans, validate clean.

```
stages          12637   core          10761   stages-review   9322
graph3           8760   vlm            7857   graph3-propagate 7812
domain           7334   graph2         7181   stages-capture   5079
stages-emit      4623   graph1          659
```

## ✅ What worked (core value holds on Python)

- **Partition** — 50 files → 11 non-overlapping cells, 0 orphans.
- **Size flagging** — caught the two over-budget cells exactly; divide workflow (re-`assign`) brought all under ceiling.
- **`cells payload domain`** — the headline test: 29946 chars (~7486 tok) = authored membrane (purpose/provides/requires) + all 6 domain files. One bounded, self-describing context a model can work. **This is the value, and it works on Python.**
- **`validate` / `list` / `owns`** — all clean.
- **Configurable census** (`code-dirs`/`code-exts`) — unblocked Python with zero code change.

## 🐛 Bug found & fixed (`adf4064`)

`show`/`crossings`/`graph`/`structure` **crashed** on this repo. Root cause: `collectImportEdges` hardcoded `cruise(['src/', 'test/'])` — the repo has `tests/` not `test/` → dep-cruiser threw ENOENT. Affected ANY repo lacking `test/` (TS included), and any non-TS repo regardless.
**Fix:** use configured `codeDirs`; wrap cruise in try/catch → return `[]` on failure (crossings are additive governance, never core value, so empty-on-unsupported-language is correct). Re-tested: all 4 commands now degrade gracefully; Cells repo TS crossings still detect edges (no regression).

## Gaps (findings, not fixed)

1. **Crossings are fundamentally TS/JS-only** (dep-cruiser). On Python, `crossings`/`show`-crossings/`structure`-ADP see 0 edges → **seam governance unavailable** for non-TS. Core value (partition/payload/size) unaffected, but the governance layer needs a **pluggable per-language edges source** (e.g. a ripgrep-based Python-import parser). Deferred.
2. **No walk-pruning.** `listFiles` recurses fully; `.cells/ignore` is a *post*-filter. `code-dirs=["."]` would recurse `.venv/` (thousands of files) → perf hit. Didn't bite here (`["src"]`), but latent for "scan from root" layouts. Consider dir-excludes during the walk.
3. **Root-level entry files** (`cli.py`/`pipeline.py`/`gui.py`) can't join a partition without a `"."` walk. Awkward for the common Python layout `src/ + root entry points`. Mitigation: allow glob/file entries in `code-dirs`, or a `code-files` list.

## Verdict

**Cells' core value (bounded, coherent, workable cells via partition + payload + size) holds on Python.** The language was unblocked purely by the configurable census. The crossings-derived governance layer remains TS-only — expected and deferred; a per-language importer is the path to full coverage. One real crash bug fixed along the way.
