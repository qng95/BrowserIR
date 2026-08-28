# BrowserIR press kit

> **Draft for the `browserir` `0.1.0` launch.** Verify registry visibility and
> the canonical result before publishing this copy.

## Headline

**Keep Playwright. Add the relationships enterprise UIs leave implicit.**

## Deck

BrowserIR targets relationship-heavy enterprise interface patterns such as
planning grids, routing queues, and approval lanes. It adds complete mappings
to current Playwright refs when it can prove them, and otherwise returns
Playwright unchanged.

## Repository description

Thin, fail-closed relationship enrichment for official Playwright MCP.

## Short announcement

ERP schedules, CRM routing boards, and approval lanes can be obvious to humans
while flattening into disconnected labels and controls. BrowserIR wraps a
caller-owned official Playwright MCP client and restores only complete
relationships it can prove. It never performs a hidden action, navigation,
screenshot, evaluation, or internal product retry. Benchmark retries were
evaluator-controlled fresh attempts.

At final `pass@3` in the retained Qwen3.8-27B development benchmark, BrowserIR
solved **15/16 vs 8/16** tasks when the relationship was missing and matched
Playwright at **16/16 vs 16/16** when ARIA was sufficient. Overall it reached
**31/32 `pass@1` vs 23/32**, produced seven final wins and zero losses, and used
34 model calls vs 49. The population was 8 checked-in fixture prompts × 4
deterministic worlds, not 32 websites. This is development evidence on a
reused local corpus, not a sealed unseen-site study.

## Facts

- Current package: `browserir@0.1.0`, prepared as the default npm release;
  verify registry availability before announcing installation.
- Integration: in-process wrapper around a caller-owned official MCP `Client`.
- Eligible observation: exact default `browser_snapshot` only.
- Hidden work: at most one logical `{ boxes: true }` snapshot call; no internal
  product retry.
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

Version `0.1.0` is the initial public npm release. It is not registry-available
until the protected release completes; verify npm before announcing it. An
early `0.1` release is not a production-readiness claim.

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
- [`browserir-inventory-erp-workshop.png`](browserir-inventory-erp-workshop.png) — synthetic render
  of the checked-in `workshop-week-table / opaque-p1` fixture; not a paid-run
  capture or treatment visualization.
- [`browserir-hero.png`](browserir-hero.png)

The remaining benchmark, architecture, representation, scoring, social-card,
and Evidence Drop visuals are archived full-graph campaign assets.
