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
execution is absent by default. The latest hosted source qualification is v16
freeze commit `5b7db58`, reproduced by GitHub Actions run `31600711043`; it
passed the deterministic 14/14 task gate. The latest dossier with a recorded
identity and digest remains v15 on commit `89c82ff`, run `31590339246`. These are
system qualifications, not LLM or competitor scores, and neither qualifies the
later result-publication commit. The separate v13 scorecard records its own
302-call/one-stale-refusal telemetry.

A separate score-excluded compatibility gate first established that the selected
control could complete the test workflow. One precommitted OpenRouter
Qwen3.8-Max configuration completed all 5/5 scheduled attempts of the
already-seen `create-customer` workflow through the safe browser-tool subset of
official Playwright MCP `0.0.78`. This gate contained no BrowserIR arm and remains
a compatibility check, not a comparative result.

Evidence Drop 01 adaptive v2 then compared the complete BrowserIR interface with
the official Playwright MCP accessibility-snapshot control across 30 matched
validation-recovery blocks with Qwen3.8-Max. BrowserIR passed 30/30 and the
control passed 27/30. The observed paired lift was +10.00 percentage points, with
a 95% paired interval from −39.59 to +59.59 percentage points. The result is
**inconclusive** because the interval includes zero. This is an adaptive
complete-interface comparison, not a raw-DOM comparison or independent
confirmation, and it does not establish superiority.

## Current source-bound engineering evidence

The latest hosted source qualification was reproduced on v16 freeze commit
`5b7db58` by GitHub Actions run `31600711043`. The latest dossier with a
recorded identity and digest remains v15 on commit `89c82ff`, run
`31590339246`; the later result-publication commit still requires hosted CI.

- Two product surfaces: a reusable TypeScript core and a local MCP server.
- Browser execution: Playwright over Chromium in the `0.1` alpha.
- Default MCP surface: nine typed tools; arbitrary page-code execution absent.
- Controlled fixture: 5,000 customers, 12,000 vehicles, and 14 workflows.
- Latest hosted v16 freeze qualification: 14/14 tasks; all required CI jobs
  passed. Latest recorded dossier: v15.
- Previous v13 run-specific telemetry: 302 MCP calls and one stale action
  refused before dispatch, then recovered by the reference planner.
- Checked-in 11-case representation corpus: 1.00 precision, recall, and F1 over
  31 entities, 44 capabilities, and 28 relationships within that corpus.
- Score-excluded control compatibility: 5/5 scheduled attempts passed for one
  selected model/configuration on one already-seen workflow through official
  Playwright MCP `0.0.78`; no BrowserIR arm and no comparative claim.
- Evidence Drop 01 adaptive v2: BrowserIR 30/30; official Playwright MCP
  accessibility-snapshot control 27/30; observed lift +10.00 percentage points;
  95% paired interval −39.59 to +59.59 percentage points; **inconclusive**.
- Matched outcomes: three BrowserIR wins, zero control wins, 27 both pass, zero
  both fail, and zero invalid across 30 Qwen3.8-Max validation-recovery blocks.
- Comparison boundary: complete interfaces, not raw DOM; adaptive follow-up,
  not independent confirmation.
- Status: public Apache-2.0 source alpha; packages are not yet published to npm.

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

Apache-2.0 `0.1` source alpha. 14/14 in a clean, source-bound deterministic CI run.
Not an LLM or competitor score.

Evidence Drop 01 adaptive v2: BrowserIR 30/30; official Playwright MCP
accessibility-snapshot control 27/30. Observed lift +10.00 pp; 95% paired
interval −39.59 to +59.59 pp. **Inconclusive.**

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

The clean, source-bound v16 freeze CI run passed all 14 controlled,
database-judged fixture tasks through real Chromium. The latest dossier with a
recorded identity and digest remains v15. The previous v13 scorecard separately
records 302 MCP calls and one stale action refused by BrowserIR before dispatch,
then recovered by the deterministic reference planner. Those are system-
qualification results, and the result-publication commit still requires hosted
CI.

Evidence Drop 01 adaptive v2 separately ran a matched real-model comparison on
30 validation-recovery blocks with Qwen3.8-Max. BrowserIR passed 30/30; the
official Playwright MCP accessibility-snapshot control passed 27/30. The
observed +10.00 percentage-point lift had a 95% paired interval from −39.59 to
+59.59 percentage points, so the result is **inconclusive**. It compares complete
interfaces, not BrowserIR with raw DOM, and is an adaptive follow-up rather than
independent confirmation.

## FAQ

### Is BrowserIR a replacement for Playwright?

No. BrowserIR uses Playwright as its browser backend. It adds the representation,
identity, capability, revision-safety, and verification layers an AI model needs.

### Is 14/14 an LLM benchmark result?

No. It is a deterministic reference-planner qualification of BrowserIR and its
MCP surface. Real-model results require separate, reproducible trials.

### Is the 5/5 control result a BrowserIR benchmark win?

No. It is a deliberately score-excluded compatibility check proving that one
selected model/configuration can complete one already-seen workflow through
official Playwright MCP. BrowserIR did not participate. The raw 5/5 is not a
pass-rate estimate, uplift measurement, generalization result, or evidence of
superiority.

### Did Evidence Drop 01 show that BrowserIR is better?

No. BrowserIR passed 30/30 and the official Playwright MCP
accessibility-snapshot control passed 27/30, but the 95% paired interval around
the observed +10.00 percentage-point lift ran from −39.59 to +59.59 percentage
points. Because that interval includes zero, the result is inconclusive. It was
also an adaptive v2 complete-interface comparison—not a raw-DOM comparison or
independent confirmation.

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

No. Evidence Drop 01 is one adaptive matched comparison against the official
Playwright MCP accessibility-snapshot control, and its result is inconclusive.
It does not establish market superiority or performance against raw DOM.

## Media assets

- Logo: [`browserir-mark.svg`](browserir-mark.svg)
- Monochrome logo: [`browserir-mark-mono.svg`](browserir-mark-mono.svg)
- Wordmark, light background: [`browserir-wordmark.svg`](browserir-wordmark.svg)
- Wordmark, dark background: [`browserir-wordmark-dark.svg`](browserir-wordmark-dark.svg)
- Hero: [`browserir-hero.png`](browserir-hero.png)
- Repository/social preview: [`browserir-social-card.png`](browserir-social-card.png)
- Benchmark scorecard: [`browserir-benchmark.svg`](browserir-benchmark.svg)
- Evidence Drop 01 adaptive v2 result: [`browserir-evidence-drop-01-v2.svg`](browserir-evidence-drop-01-v2.svg)
- Scoring method: [`browserir-scoring-method.svg`](browserir-scoring-method.svg)
- Representation visual: [`browserir-representation.svg`](browserir-representation.svg)
- Architecture visual: [`browserir-architecture.svg`](browserir-architecture.svg)
