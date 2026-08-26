# BrowserIR press kit

> **Draft for the private source alpha.** Verify package visibility and the
> canonical result before publishing this copy.

## Headline

**Keep Playwright. Stop making browser agents guess.**

## Deck

BrowserIR is a thin adaptive semantic layer for official Playwright MCP. It
turns missing label-to-control and row-by-column relationships into exact,
current Playwright refs. It adds only complete mappings it can prove and
returns the original snapshot whenever evidence is sufficient or unresolved.

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

In the retained Qwen3.8-27B development benchmark, BrowserIR reached **31/32
`pass@1` versus 23/32** with enrichment off. At the three-fresh-attempt cap it
solved 31/32 versus 24/32—seven matched task wins, zero matched losses. It used
34 physical model calls versus 49 and cost $0.001012 per successful task versus
$0.002273. The population was 8 checked-in fixture prompts × 4 deterministic
worlds, not 32 websites. The result is favorable development evidence on a
reused local corpus, not a sealed unseen-site study.

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
- Benchmark population: 8 deterministic fixture prompts × 4 worlds = 32
  matched task identities; every identity is evaluated in both modes.
- Reliability: `pass@1` 31/32 vs 23/32; `pass@2` and `pass@3` 31/32 vs 24/32.
- Canonical result: [metrics, economics, checksums, and claim
  boundary](../../docs/BROWSERIR_REAL_AGENT_RESULTS.md).
- Reproduction: [real-agent A/B
  runbook](../../docs/BROWSERIR_REAL_AGENT_AB_RUNBOOK.md).

## Approved result wording

> In a 32-task Qwen3.8-27B development benchmark with up to three fresh
> attempts per mode, BrowserIR `auto` reached 31/32 `pass@1` versus 23/32
> with enrichment `off`, then finished 31/32 versus 24/32 at `pass@3`. The
> matched final outcomes were seven `auto`-only successes, zero `off`-only
> successes, 24 both successes, and one both failure. The population was 8
> checked-in fixture prompts × 4 deterministic worlds. This is favorable
> evidence on a reused local development corpus, not a sealed unseen-site or
> general-superiority result.

Shorter copy may lead with “31/32 pass@1,” “30.6% fewer calls,” or “55.5% lower
provider cost per success” when it also names the enrichment-off comparison,
Qwen3.8-27B, the 8×4 development corpus, the three-attempt stop-on-success
policy, and links the canonical result.

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
