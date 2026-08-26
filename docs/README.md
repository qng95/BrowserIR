# BrowserIR documentation

The current product direction is the private `@browserir/playwright-mcp` thin
layer around an official Playwright MCP client. Start with these documents:

| Need | Canonical document |
| --- | --- |
| Product architecture and exact middleware behavior | [Adaptive Playwright architecture](ADAPTIVE_PLAYWRIGHT_ARCHITECTURE.md) |
| Host integration and lifecycle | [Playwright MCP adaptive closed alpha](PLAYWRIGHT_MCP_ADAPTIVE_ALPHA.md) |
| Common integration failures | [Thin-layer troubleshooting](TROUBLESHOOTING.md) |
| Measurement design and future claim gate | [Adaptive Playwright measurement](ADAPTIVE_PLAYWRIGHT_MEASUREMENT.md) |
| Reproduce the real-model development run | [Real-agent A/B runbook](BROWSERIR_REAL_AGENT_AB_RUNBOOK.md) |
| Canonical metrics, checksums, and claim boundary | [Real-agent result](BROWSERIR_REAL_AGENT_RESULTS.md) |

Repository-wide guides:

- [Security boundary](../SECURITY.md)
- [Contributing](../CONTRIBUTING.md)
- [Changelog](../CHANGELOG.md)
- [Current package guide](../packages/playwright-mcp/README.md)
- [Brand assets and scoped copy](../assets/brand/README.md)

## Research and legacy material

The following files remain because their code paths or provenance records still
exist. They are not setup guides or evidence for the thin layer:

- [Benchmark method compendium](BENCHMARK.md) separates the current thin A/B
  from legacy full-graph and explicitly labelled research mechanisms.
- [Legacy full-graph architecture](ARCHITECTURE.md) documents the retained
  `@browserir/core`, `@browserir/playwright`, and `@browserir/mcp` runtime.
- [Legacy full-graph agent benchmark](AGENT_BENCHMARK.md) documents its
  nine-tool harness and historical complete-interface comparisons.
- [Evidence Drop archive](EVIDENCE_DROPS.md) indexes Drops 01 and 02. Both were
  inconclusive and used a different product interface.
- [Legacy release checklist](RELEASE_CHECKLIST.md) and [release-evidence
  pipeline](RELEASE_EVIDENCE.md) remain coupled to scripts and tests for the
  unpublished three-package full-graph candidate.
- The package-local guides for [`@browserir/core`](../packages/browser-ir/README.md),
  [`@browserir/playwright`](../packages/playwright-driver/README.md), and
  [`@browserir/mcp`](../packages/mcp-server/README.md) document those retained
  source-only legacy packages.

## Immutable evidence

Files under `docs/evidence-drops/` are checksummed historical artifacts. Do not
rewrite their wording, scores, or status to match a newer product direction.
Add a new result document and protocol instead.

The deleted historical working board, dated release-readiness snapshot, and
superseded `20260826T103510Z` development artifact trio remain recoverable from
Git history; they are no longer documentation or result sources of truth.
