# Contributing to Cells

This guide exists to save both sides time.

## Philosophy

Cells has a **specific vision**: structure should be *authored and visible*, not retrieved. Cells' north star is helping the LLM model the codebase — not building features for humans. Everything follows from that.

If you find an idea that doesn't sit well with that north star, it won't fit here. That's not a rejection of you — it's the project being honest about what it is.

Pull requests that bloat the core or drift from the north star will be closed.

## The One Rule

**You must understand your code.** If you cannot explain what your changes do and how they interact with the rest of the system, your PR will be closed.

Using an LLM to write code is fine. Submitting generated code without understanding it is not.

## Contribution Gate

All issues and PRs from new contributors are auto-closed by default.

Maintainers review auto-closed issues and reopen ones that align with the project's vision. If an issue stays closed, that's the maintainer's honest answer — it doesn't fit.

Issues that do not meet the quality bar below will not be reopened or receive a reply.

## Quality Bar For Issues

- Use one of the GitHub issue templates.
- Keep it concise. If it does not fit on one screen, it's too long.
- State the bug or request clearly.
- Explain why it matters and how it relates to Cells' north star.

## Before Submitting a PR

Do not open a PR unless a maintainer has explicitly invited one. Unsolicited PRs will be auto-closed.

Before submitting:

```bash
pnpm run prepare
pnpm run typecheck
pnpm run test
```

All three must pass.

## Blocking

If you ignore this guide twice, or if you spam the tracker with LLM-generated issues, your GitHub account will be permanently blocked.

## FAQ

### Why are new issues and PRs auto-closed?

Cells receives more input than the maintainers can responsibly review. Many reports do not align with the project's vision. Auto-closing creates a buffer so the maintainer reviews the tracker on their own schedule and reopens the handful that fit.

### Why do some issues get no reply?

Low-signal issues, unclear reports, duplicates, and issues that don't follow this guide may be closed without discussion. This keeps time available for actionable reports and ideas that genuinely fit the north star.

### Are outside contributions welcome?

Ideas and bug reports from outside are welcome — if they fit the vision. The auto-close gate isn't hostility; it's how a small project stays focused. If your idea is short, concrete, and aligned with Cells' north star, it will be reopened.
