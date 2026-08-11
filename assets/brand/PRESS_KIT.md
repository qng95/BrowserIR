# BrowserIR press kit

> **Launch draft:** publish this copy only after package visibility,
> clean-commit, and release-evidence gates are complete.

## Launch headline

**BrowserIR gives AI agents a semantic map of the browser—not another DOM dump.**

## Launch deck

A TypeScript core and MCP server that turn difficult enterprise interfaces into
compact entities, relationships, available actions, revisions, and observed
effects with verification status, with Playwright handling the browser
underneath.

## Repository description

The semantic browser layer for AI agents: compact context, typed actions, and
revision-checked execution over modern and legacy enterprise UIs.

## Short announcement

Browser automation gives an agent hands. BrowserIR gives it a map.

Today we are introducing the BrowserIR `0.1` alpha: a representation and runtime
for agents working across ERP, CRM, DMS, and other interfaces where the DOM is
large, transient, or constantly regenerated. BrowserIR compiles tested native,
standards-hinted custom, open-shadow, frame, table, and legacy patterns into
semantic entities, relationships, state, available actions, and revision-bound
references, then exposes them through a TypeScript core and MCP.

Playwright remains underneath for reliable browser mechanics. Arbitrary page-code
execution is absent by default. The retained deterministic local qualification
passes 14/14 database-judged fixture tasks through real Chromium and the official
MCP client using 290 tool calls with zero tool errors. This dirty/unbound local
run is engineering evidence, not qualified release evidence or an immutable
public baseline, and not an LLM or competitor score.

## Current local engineering evidence

These figures come from a dirty/unbound local source run. They may be used only
with that provenance and are not qualified release evidence or an immutable
public baseline.

- Two product surfaces: a reusable TypeScript core and a local MCP server.
- Browser execution: Playwright over Chromium in the `0.1` alpha.
- Default MCP surface: nine typed tools; arbitrary page-code execution absent.
- Controlled fixture: 5,000 customers, 12,000 vehicles, and 14 workflows.
- Retained deterministic qualification: 14/14 tasks, 290 MCP calls, 0 tool errors.
- Checked-in 11-case representation corpus: 1.00 precision, recall, and F1 over
  31 entities, 44 capabilities, and 28 relationships within that corpus.
- Status: unreleased source alpha; packages are not yet published to npm.

## Quote

> “A browser agent should not have to reverse-engineer meaning from raw markup on
> every turn. BrowserIR gives the model the simplest useful view—but not a simpler
> one.”

## Social copy

### Short

Playwright gives AI agents hands. BrowserIR gives them a map.

BrowserIR turns difficult enterprise UIs into compact semantic entities,
relationships, available actions, and revision-bound references—then exposes the
result through TypeScript and MCP.

`0.1` source alpha. 14/14 in the retained 2026-08-11 dirty/unbound deterministic local run.
Not an LLM, competitor, or qualified release score.

### Long

AI browser agents do not need more DOM. They need the right representation.

BrowserIR is a semantic browser layer for operational software: ERP, CRM, and
DMS. Tested slices include standards-hinted custom controls, open-shadow web
components, virtualized grids, delayed content, same-origin nested frames, and
legacy pages that regenerate themselves after a click.

It compiles a live interface into a compact model view with meaning, state,
relationships, available actions, revisions, and explicit omissions. Playwright
handles browser mechanics underneath; a typed MCP server exposes BrowserIR to
agents above it.

The retained 2026-08-11 dirty/unbound deterministic local run passes all 14 controlled,
database-judged fixture tasks through real Chromium in 290 MCP calls with zero
tool errors. That number is deliberately scoped: it is not qualified release
evidence and not a real-model or competitor result.

## FAQ

### Is BrowserIR a replacement for Playwright?

No. BrowserIR uses Playwright as its browser backend. It adds the representation,
identity, capability, revision-safety, and verification layers an AI model needs.

### Is 14/14 an LLM benchmark result?

No. It is a deterministic reference-planner qualification of BrowserIR and its
MCP surface. Real-model results require separate, reproducible trials.

### Why should anyone trust the 14/14 score?

Each task runs in a separate worker with a fresh seeded database, browser,
BrowserIR runtime, stock MCP surface, and official MCP client. The seed is
regression-tested to start at 0/14 passing tasks. Browser and MCP access are
closed before a hidden database-and-audit oracle grades the exact result; page
text and self-reported success do not count. The oracle suite contains negative
tests for already-true values, partial work, wrong targets, missing audit events,
incorrect action order, and relevant collateral mutations. There is no partial
credit, and the qualification command exits non-zero unless all 14 pass.

### Is it production-ready?

No. This is an unreleased `0.1` source alpha. The benchmark and public claim
boundaries exist precisely so progress can be measured without overstating it.

### Does it claim to beat other browser-agent systems?

No. Fair paired competitor runs have not been published. BrowserIR's current
evidence establishes its own controlled behavior, not market superiority.

## Media assets

- Logo: [`browserir-mark.svg`](browserir-mark.svg)
- Monochrome logo: [`browserir-mark-mono.svg`](browserir-mark-mono.svg)
- Wordmark, light background: [`browserir-wordmark.svg`](browserir-wordmark.svg)
- Wordmark, dark background: [`browserir-wordmark-dark.svg`](browserir-wordmark-dark.svg)
- Hero: [`browserir-hero.png`](browserir-hero.png)
- Repository/social preview: [`browserir-social-card.png`](browserir-social-card.png)
- Benchmark scorecard: [`browserir-benchmark.svg`](browserir-benchmark.svg)
- Scoring method: [`browserir-scoring-method.svg`](browserir-scoring-method.svg)
- Representation visual: [`browserir-representation.svg`](browserir-representation.svg)
- Architecture visual: [`browserir-architecture.svg`](browserir-architecture.svg)
