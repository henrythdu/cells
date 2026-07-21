# Prior art toward context-bounded work units for LLMs

*Research for [ticket 02](../issues/02-prior-art.md). Evaluated through the model-needs
lens (does it define a complete, context-bounded unit a model works one-at-a-time?), not
the human-code-organization lens.*

## TL;DR — what's genuinely new about Cells

Every existing approach **selects** context *from* human-organized code. **Cells
define** the unit *by* what the model needs. That inversion is the novelty:

- LLM tools (Aider repo-map, Code RAG, LSP, code knowledge graphs) all assume code is
  organized by humans (files/functions/classes) and try to feed the model the right
  *slice*. None makes "what the model needs to work one problem" a first-class unit.
- The field's own finding — the **Navigation Paradox** — says bigger windows don't fix
  it; the answer is "the right minimal working set." Everyone *computes/selects* that
  set. Cells makes it **structural**.
- Bounded-unit structures (DDD bounded contexts, Ruby `packs`/Packwerk) are
  **domain-bounded, folder-based, for humans**. Cells is **model-needs-bounded,
  not folder-anchored**. Transferable insight: *explicit, visible seams*.
- The **"git for space"** framing appears **novel**: spatial-structure tools exist, but
  as *visualization*, not as a unit-definition + tracking system with a
  commit-equivalent act (divide).

## 1. LLM-coding tools that build a navigable view for a model

| Approach | Unit handed to model | Complete or retrieved/lossy? |
|---|---|---|
| **Aider repo-map** | Ranked graph of file/symbol signatures; selects files to fit a token budget (~1k default) | **Retrieved/selective** — a map + chosen files, not a complete work unit |
| **Code RAG** | Embeds code chunks, retrieves top-K by query similarity | **Retrieved/lossy** — and chunking *by function* beats by-lines (structure matters) |
| **LSP-based** | On-demand symbol resolution (`workspace/symbol`, `references`) | **Precise but on-demand** — no defined unit, just lookups |
| **Code knowledge graphs** (code-nexus, Mozaiks, SMP) | Typed nodes + verified edges (calls/imports/refs) | **Computed view** over existing code; ~80% token cut on arch queries |

**Verdict:** all four are **retrieval/selection** over human-organized code. The unit is
always a *slice the tool picks*, never a *first-class complete unit the code is organized
into*. This is the gap Cells fills.

## 2. The Navigation Paradox (validates the problem)

- **CodeCompass / Prometheus (2025 preprints):** as windows grow to millions of tokens,
  the failure shifts from "can't fit the repo" to **"can't find relevant code within the
  window."** Bigger windows do not solve it.
- **"Paste the whole repo" fails:** models silently drop early files; quality degrades on
  long prompts; cost rises without gains.
- **Field consensus:** the fix is *the right minimal working set, on demand* — not a
  bigger window.

**Implication for Cells:** the problem Cells targets is real and field-recognized. But
the field's answer is still *better selection*. Cells' answer — *define the unit so
selection is unnecessary* — is strictly stronger and as yet unattempted as a
first-class structure.

## 3. Bounded-unit structures to LEARN from (not copy)

| Structure | Bounded by | For | Transferable insight |
|---|---|---|---|
| **DDD Bounded Context** | domain | humans | explicit boundaries + relationships between units |
| **Ruby `packs` + Packwerk** | domain; a folder + `package.yml` | humans | **explicit, *visible* dependencies** — Packwerk doesn't prevent deps, it *exposes* them |
| **Actor model** | message boundary (mailbox) | concurrency | pure I/O black box; state encapsulated; communicate only by message |
| **Pure FP / effect systems** | effect boundary | correctness | side effects become explicit, trackable I/O — directly addresses "black box isn't pure" |
| **Microservices / modules** | deployment / API boundary | humans/ops | independent, parallelizable units; contracts at seams |

**Verdict:** the deep insight that transfers is **Packwerk's**: the value isn't *preventing*
coupling, it's *making seams explicit and visible*. Cells inherits that — but re-bounds the
unit from *domain* (human) to *model-needs* (complete + context-fitting), and explicitly
rejects the *folder* anchoring all of these assume.

## 4. "Git for space" — appears novel

- **Spatial-structure tools exist** (codecohesion, repo-timeline, holy-graph → 3D scenes;
  Volscape → version-controlled markdown diagrams; Tecture → agent-generated arch maps)
  but as **visualization/evolution playback**, not as a unit-definition + tracking system.
- **None** frames code-structure tracking as the spatial analog of git's temporal
  tracking, with a structural act equivalent to `commit` (Cells' candidate: `divide`).
- **Closest git analogs for "a cell":** not `branch` (lineage) but a *named reference /
  view over content* (tag/tree-like) — a lens over a content store, cheap and
  non-destructive. This stays a *candidate mechanism* (out of scope here) but the
  *framing* is unclaimed.

## Ranking

**Closest to Cells:** MASAI (modular agent architecture — divides work among
sub-agents with well-defined objectives; closest at the *agent* level, not code-structure
level) and Packwerk (explicit visible seams; closest at the *structure* level, but
human/domain/folder-bounded).

**Most transferable:** Packwerk's "make seams explicit, don't just prevent coupling";
pure-FP effect systems (effects as explicit I/O); chunking-by-function (structure
preserved).

**The "what's new" gap:** *defining* the work unit by model-needs (complete +
context-bounded), as a first-class structure — not *selecting* a slice from
human-organized code. Everything today selects; nothing defines.

## Sources

- Aider repo map — https://aider.chat/docs/repomap.html
- Repo Map vs Code RAG vs LSP — https://wiki.charleschen.ai/ai/processed/wiki/llm-core/cli/comparisons/repo-map-vs-rag-vs-lsp
- CodeCompass (Navigation Paradox) — https://arxiv.org/html/2602.20048
- Prometheus (codebase navigation) — https://arxiv.org/html/2507.19942
- Chunking by function vs lines — https://dev.to/pavelespitia/rag-for-code-why-chunking-by-function-beats-chunking-by-lines-njc
- Code Knowledge Graph for LLMs — https://zzet.org/gortex/code-knowledge-graph-for-llms/
- MASAI (modular SE agents) — https://doi.org/10.48550/arxiv.2406.11638
- DDD Bounded Context — http://martinfowler.com/bliki/BoundedContext.html
- Ruby `packs` — http://github.com/rubyatscale/packs
- Packwerk case study — http://www.globalapptesting.com/engineering/implementing-packwerk-to-delimit-bounded-contexts
