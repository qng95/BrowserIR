# Browser IR real-agent A/B comparison — 2026-08-26

## Run identity and integrity

- Model: `qwen/qwen3.8-27b`
- OpenRouter route: `alibaba`, provider fallback disabled
- Evaluation retry cap: `max_retry=2` (three fresh attempts maximum)
- Full corpus: 32 paired tasks, 84 physical calls
- Receipt/result coverage: 84/84; journal records are exactly equal to `receipt.results`
- Usage and cost coverage: 100%
- Receipt SHA-256: `ae837839663650d6234c63dfcfd489a8856d5f6d6a247601b3688fa316aead26`
- Journal SHA-256: `2b356d50b23ad5ee9bb6492ca65e522c1eca2725c4559bb2482854c7e186327b`

The comparison baseline is the 2026-08-25 receipt
`browserir-openrouter-real-ab-20260825T214952Z.json`, produced before the
one-pixel Harbor containment fix.

## Headline comparison

| Metric | Previous round | Current round | Change |
|---|---:|---:|---:|
| Playwright-off final success | 24/32 (75.00%) | 24/32 (75.00%) | 0 pp |
| Browser IR final success | 30/32 (93.75%) | 31/32 (96.875%) | +3.125 pp |
| Browser IR lift over off | +18.75 pp | +21.875 pp | +3.125 pp |
| Opaque Browser IR success | 14/16 (87.50%) | 15/16 (93.75%) | +6.25 pp |
| Semantic Browser IR success | 16/16 (100%) | 16/16 (100%) | 0 pp |
| Auto-only / off-only / neither | 6 / 0 / 2 | 7 / 0 / 1 | +1 / 0 / -1 |
| Exact paired sensitivity | 0.03125 | 0.015625 | descriptive only |
| Positive / negative / tied case clusters | 6 / 0 / 2 | 7 / 0 / 1 | +1 positive cluster |

The only final task/mode outcome that changed was Browser IR on
`schedule/harbor-maintenance-rail` / `opaque-p1`: it changed from failure after
three fallback attempts to success on the first projected attempt. No final
task outcome regressed.

## pass@k and retry behavior

| Browser IR metric | Previous round | Current round |
|---|---:|---:|
| pass@1 | 30/32 (93.75%) | 30/32 (93.75%) |
| pass@2 | 30/32 (93.75%) | 30/32 (93.75%) |
| pass@3 | 30/32 (93.75%) | 31/32 (96.875%) |
| Failed after retry cap | 2 | 1 |
| Successes by attempt 1 / 2 / 3 | 30 / 0 / 0 | 30 / 0 / 1 |
| Physical Browser IR calls | 36 | 36 |

The Harbor opaque-p1 fix added one first-attempt success, but provider/model
fluctuation moved Harbor semantic-p1 from an old first-attempt success to a
current third-attempt success. This offset explains why aggregate pass@1 and
the total Browser IR call count did not change, while pass@3 improved.

The current run contains two malformed target selections on the retried Harbor
semantic-p1 task and two MCP click failures in Playwright-off attempts. There
were no recorded provider-network failures. Retry recovered the semantic task
on attempt 3.

## Projection behavior

| Zero-oracle relation audit | Previous round | Current round |
|---|---:|---:|
| Projected opaque tasks | 13 | 15 |
| Safe fallbacks | 3 | 1 |
| Demonstrated projection misses | 2 | 0 |
| Unresolved without recoverability proof | 1 | 1 |
| Recall on 15 demonstrated recoverable relations | 13/15 | 15/15 |

Both Harbor opaque worlds now route through `projected`. The Catalog
localization opaque-p1 world remains the one safe unresolved fallback.

## Harbor-local effect

For the two Harbor opaque Browser IR tasks only:

| Metric | Previous round | Current round | Change |
|---|---:|---:|---:|
| Physical calls | 4 | 2 | -50.0% |
| Tasks solved | 1/2 | 2/2 | +1 task |
| Tokens | 8,416 | 3,936 | -53.23% |
| Cost | $0.00705330 | $0.00215305 | -69.47% |

This is the most direct evidence for the projector fix: opaque-p0 remained
correct, while opaque-p1 changed from three unresolved failures to one
projected success.

## Economics

| Metric | Previous round | Current round | Change |
|---|---:|---:|---:|
| Total run cost | $0.09573635 | $0.09136310 | -4.57% |
| Total tokens | 147,637 | 146,312 | -0.90% |
| Total cost per succeeded arm-task | $0.00177290 | $0.00166115 | -6.30% |
| Browser IR cost | $0.03789045 | $0.03526395 | -6.93% |
| Browser IR cost per success | $0.00126301 | $0.00113755 | -9.93% |
| Browser IR tokens per success | 2,088.63 | 2,000.61 | -4.21% |
| Browser IR mean latency per task | 3,346.88 ms | 2,826.84 ms | -15.54% |

Round-to-round output length and provider latency fluctuate, so the global cost
and latency deltas are descriptive. The Harbor-local reduction is more directly
connected to the route change because it removes two failed fresh attempts.

## Claim boundary

This is stronger descriptive evidence, not a confirmatory result. It reuses a
development corpus after inspecting earlier outcomes, and the provider remains
stochastic even with the same requested seeds. The exact p-values therefore do
not create advertising authority.

The current receipt schema records routes and the relation audit but does not
serialize the product policy version or a product-source hash. The run was made
from the policy `/3` workspace after its 64-arm zero-model preflight, and the
observed Harbor routes match `/3`; nevertheless a claim-grade rerun should first
add those provenance fields to the receipt rather than relying on surrounding
workspace context.
