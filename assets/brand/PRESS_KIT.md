# BrowserIR press kit

> **Draft for the private source alpha.** Verify package visibility and the
> canonical result before publishing this copy.

## Headline

**BrowserIR gives Playwright agents the relationships their snapshots are
missing.**

## Deck

BrowserIR is a thin adaptive semantic layer for official Playwright MCP. It
adds only complete relationships it can prove, preserves Playwright's tools and
current refs, and returns the original snapshot whenever evidence is sufficient
or unresolved.

## Repository description

Thin, fail-closed relationship enrichment for official Playwright MCP.

## Short announcement

Playwright already gives browser agents capable tools and actionable refs. The
hard cases are often narrower: a snapshot contains the right labels and
controls but omits the relation between them.

BrowserIR wraps a caller-owned official MCP client. On an eligible default
snapshot, one host-selected, task-independent policy may request one read-only
boxed recapture. If it can prove a complete mapping over unchanged state,
BrowserIR returns a box-free snapshot with the missing relationships attached
to current Playwright refs. Otherwise it returns Playwright's original result
unchanged. It never performs a hidden action, evaluation, navigation, screenshot,
or retry.

In the retained 32-task Qwen3.8-27B development benchmark, `auto` solved 31/32
tasks versus 24/32 with enrichment `off` under a three-fresh-attempt cap. It
used 34 physical model calls versus 49 and cost $0.001012 per successful task
versus $0.002273. The result is favorable development evidence on reused
schedule-coordinate and cross-tree-label fixture cases—not a sealed study,
unseen-site validation, or general-superiority claim.

## Facts

- Current package: private, unpublished `@browserir/playwright-mcp` source alpha.
- Integration: in-process wrapper around a caller-owned official MCP `Client`.
- Eligible observation: exact default `browser_snapshot` only.
- Hidden work: at most one logical `{ boxes: true }` snapshot call; no retry.
- Output: exact original result or a complete box-free projection using current
  Playwright refs.
- First-party families: bounded grid coordinates, schedule coordinates, and
  cross-tree labels; the host selects exactly one.
- Current agent evidence: schedule and cross-tree fixture cases only.
- Canonical result: [metrics, economics, checksums, and claim
  boundary](../../docs/BROWSERIR_REAL_AGENT_RESULTS.md).
- Reproduction: [real-agent A/B
  runbook](../../docs/BROWSERIR_REAL_AGENT_AB_RUNBOOK.md).

## Approved result wording

> In a 32-task Qwen3.8-27B development benchmark with up to three fresh
> attempts per mode, BrowserIR `auto` solved 31/32 tasks versus 24/32 with
> enrichment `off`. The matched outcomes were seven `auto`-only successes,
> zero `off`-only successes, 24 both successes, and one both failure. This is
> favorable evidence on reused schedule-coordinate and cross-tree-label fixture
> cases, not a sealed, unseen-site, or general-superiority result.

Do not shorten this to “97% success,” “30% fewer calls,” or “55% cheaper” without
also naming the comparison, corpus size, model, retry cap, and development
boundary.

## FAQ

### Is BrowserIR a replacement for Playwright?

No. Playwright keeps the server, browser lifecycle, tools, refs, and action
dispatch. BrowserIR is a narrow observation wrapper.

### Does `auto` choose a policy from the task prompt?

No. The host chooses one fixed first-party policy family. `auto` decides only
whether that policy can safely enrich an eligible snapshot.

### Is it production-ready or published to npm?

No. The current package is a private source alpha.

### Does the 31/32 result prove general superiority?

No. The corpus was reused after an earlier projector round, covered two bounded
relationship families in one fixture application, and the retained receipt
does not bind the product source hash or policy version. A prospectively sealed
untouched corpus is still required for a confirmatory claim.

### What happened to the full-graph BrowserIR runtime?

Its source and checksummed evidence remain in the repository as a separate
legacy/experimental interface. Its two sealed Evidence Drops were inconclusive
and are not evidence for the current thin layer.

## Current media assets

- [`browserir-mark.svg`](browserir-mark.svg)
- [`browserir-mark-mono.svg`](browserir-mark-mono.svg)
- [`browserir-wordmark.svg`](browserir-wordmark.svg)
- [`browserir-wordmark-dark.svg`](browserir-wordmark-dark.svg)
- [`browserir-hero.png`](browserir-hero.png)

The remaining benchmark, architecture, representation, scoring, social-card,
and Evidence Drop visuals are archived full-graph campaign assets.
