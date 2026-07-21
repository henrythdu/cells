---
Title: Prior art toward context-bounded work units for LLMs
Labels: wayfinder:map, wayfinder:research
Type: research
Status: resolved
Blocked by:
Parent: cells-vision/map.md
---

## Question

What already exists toward the idea of *"a cell = everything a model needs to work on
one problem, bounded to its context window,"* and **what is genuinely new** about Cells?

Evaluate every finding through the **model-needs lens** (does it define a complete,
context-bounded unit a model can work one-at-a-time?), NOT the human-code-organization
lens (we can *learn* from the latter but must not copy its organizing principle).

### Areas to cover

1. **LLM-coding tools that build a navigable view of a codebase for a model.** Aider's
   repo map, Cursor / Cody codebase indexing, Sourcegraph / cscope-style code graphs,
   Devin, "context engineering," code-graph RAG. For each: what unit of context does it
   hand the model, and is that unit *complete* or *retrieved-and-lossy*?
2. **Human-programming structures to LEARN from (not copy).** Modules, packages,
   "packs" (Ruby/JS), bounded contexts (DDD), the actor model, pure FP / effect
   systems, microservices, interfaces/APIs, information hiding. For each: what insight
   about *bounded, complete, navigable units* transfers to the model-needs axis?
3. **Token/context-budgeted code units.** Any prior art specifically on organizing code
   so each unit fits a model context window, or "code as a circuit of black boxes."
4. **"Git for space."** Has anyone framed code-structure tracking as the *spatial*
   analog of git's *temporal* tracking? (git = content store + cheap refs over time;
   cells = ? over space.)

### Output

A findings doc at `.scratch/cells-vision/research/prior-art.md` ranking: what is
**closest** to Cells, what is **transferable**, and the precise **"what's new"** gap.
This feeds point 3 of [Positioning & audience](01-positioning-and-audience.md).

## Answer

Findings captured at [`research/prior-art.md`](../research/prior-art.md).

**One-line gist:** every existing approach *selects* context from human-organized code
(Aider repo-map, Code RAG, LSP, code knowledge graphs); **none defines** a complete,
context-bounded unit by model-needs. The field's own **Navigation Paradox** confirms
bigger windows don't fix it — but everyone's answer is still *better selection*, never
*define the unit*. Bounded-unit structures (DDD, Ruby packs/Packwerk) are
 domain-bounded + folder-based + for humans; transferable insight = Packwerk's "make
seams explicit and visible, don't just prevent coupling." The "git for space" framing
appears **novel** (spatial tools exist but as visualization, not unit-definition +
tracking). **What's new:** Cells *defines* the work unit by model-needs as a first-class
structure — everything today selects, nothing defines.

This feeds point 3 of [Positioning & audience](01-positioning-and-audience.md).

## Comments
