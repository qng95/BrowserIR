# BrowserIR thin-layer real-agent result

Status: published development evidence; not sealed or confirmatory

Run date: 2026-08-26

Last reviewed: 2026-08-26

## Result in one sentence

On this 32-task structural-ambiguity development corpus, with
`qwen/qwen3.8-27b` and at most two fresh-state retries, BrowserIR's adaptive
Playwright mode solved **31/32 (96.875%)** tasks while the same wrapped
Playwright surface with enrichment off solved **24/32 (75.00%)**: a descriptive
lift of **+21.875 percentage points**.

This is a favorable development result, not a general claim that BrowserIR is
better than Playwright. The corpus was reused after the preceding `/2` round was
inspected, and the retained receipt does not serialize the product policy
version or product-source hash.

## Frozen runtime for this round

| Setting | Value |
| --- | --- |
| Model | `qwen/qwen3.8-27b` |
| Provider route | OpenRouter `alibaba` only; fallback disabled |
| Product modes | `off` and `auto` on the same adaptive wrapper |
| Evaluation retries | `max_retry=2`; three fresh attempts maximum |
| Retry rule | Stop a mode after its first exact-oracle success |
| Provider retries inside an attempt | 0 |
| Corpus | 8 independently implemented sites × 4 hidden worlds = 32 paired tasks |
| Oracle | Exact hidden fixture-database result after one model-selected click |
| Isolation | Fresh fixture, database, MCP process, Chromium context, page, and model response per attempt |
| Cost stop | USD 0.10 |
| Receipt | `browserir-openrouter-real-ab-20260826T142617Z`; schema `browserir-openrouter-real-ab-smoke/3` |

The two modes share the same task and attempt seed. The model never sees a
previous attempt, the hidden world, the expected target, or the oracle result.

## Accuracy and paired outcomes

| Metric | Playwright enrichment off | BrowserIR auto |
| --- | ---: | ---: |
| Final task success | 24/32 (75.00%) | **31/32 (96.875%)** |
| Opaque worlds | 8/16 (50.00%) | **15/16 (93.75%)** |
| Semantic-sufficient worlds | 16/16 (100%) | 16/16 (100%) |
| `pass@1` | 23/32 (71.875%) | **31/32 (96.875%)** |
| `pass@2` | 24/32 (75.00%) | **31/32 (96.875%)** |
| `pass@3` | 24/32 (75.00%) | **31/32 (96.875%)** |

| Cumulative paired outcome | `off` solved | `auto` solved | `auto - off` | `auto` only / `off` only / both / neither |
| --- | ---: | ---: | ---: | ---: |
| `pass@1` | 23/32 | 31/32 | +25.00 pp | 8 / 0 / 23 / 1 |
| `pass@2` | 24/32 | 31/32 | +21.875 pp | 7 / 0 / 24 / 1 |
| `pass@3` | 24/32 | 31/32 | +21.875 pp | 7 / 0 / 24 / 1 |

The paired table was 7 `auto`-only successes, 0 `off`-only successes, 24 both
successful, and 1 neither successful. Exact two-sided McNemar sensitivity was
`p=0.015625`. Treating the four worlds from one case as a cluster produced the
same 7 positive, 0 negative, and 1 tied case pattern and the same exact sign
sensitivity. These values describe this completed development run; they do not
repair the post-inspection design or create confirmatory advertising authority.

## What the thin layer did

`auto` made the default semantic observation first. On the 16
semantic-sufficient tasks it returned the original Playwright result. On opaque
tasks it made one hidden read-only boxed snapshot and either emitted a complete,
box-free relation set with current Playwright refs or safely returned the
original observation.

| Opaque-task route audit | Count |
| --- | ---: |
| Complete product projections | 15 |
| Safe fallbacks | 1 |
| Demonstrated projection misses | 0 |
| Unresolved without a recoverability proof | 1 |

The independent zero-model witness demonstrated 15 geometrically recoverable
relations and the product projected all 15. The remaining Catalog localization
layout did not form a complete 2-by-2 geometric bijection, so the thin layer
correctly declined to invent a relation. This fallback behavior is part of the
design; it is a defect only when an independent witness can prove the omitted
relation.

Before the paid run, the complete 64-arm real-browser, zero-model preflight
passed with 15 projections, 1 safe fallback, 0 demonstrated projection misses,
no model calls, and no task mutation. The schedule policy in the executed
workspace was `schedule-coordinate-policy/3`: it admits only a one-pixel
serialized resource-box overhang at the schedule root edge while retaining the
overlap, center, completeness, unique-ref, and unique-coordinate guards.

## Retries and failure accounting

`auto` used 34 physical model calls: 31 tasks succeeded on attempt 1, none on
attempts 2 or 3, and one failed after the cap. `off` used 49 calls: 23 tasks
succeeded on attempt 1, one on attempt 2, none on attempt 3, and eight failed
after all three attempts.

Across both modes the retained journal contains 81 decisions, 1 dispatch
failure, and 1 malformed response. There were 0 provider failures. This is why
`pass@k` is reported instead of treating one stochastic answer as the product
score.

## Active task time

Task time in this receipt is scheduler-independent active time. Each physical
attempt starts before opening its fresh arm and includes fixture/browser setup,
authentication, navigation, the initial snapshot, BrowserIR processing, the
model request, click dispatch, and exact-oracle evaluation. When another retry
follows, the failed attempt also includes its post-terminal cleanup and reset.
The terminal attempt's cleanup, journal/log writing, and time spent running the
opposite A/B arm are excluded.

| Success-conditioned time to success | Playwright enrichment off | BrowserIR auto |
| --- | ---: | ---: |
| Successful tasks observed | 24 | 31 |
| Mean | 5,982.71 ms | **4,928.71 ms** |
| Median | 5,118 ms | **4,930 ms** |
| p90 (nearest rank) | 9,375 ms | **5,160 ms** |
| p95 (nearest rank) | 9,385 ms | **5,298 ms** |
| Minimum | 4,523 ms | 4,542 ms |
| Maximum | 10,252 ms | **5,706 ms** |

The per-arm rows are conditioned on success and have different survivor sets,
so they must be published with `n` and must not be read as the primary paired
speed comparison. On the **24 tasks both arms solved**, `auto` was faster on 17,
`off` was faster on 7, and none tied; `auto - off` averaged **−1,088.71 ms**
with a median of **−151.5 ms**. That common-success paired set is the primary
comparative timing view for this run.

Retry-exhausted terminal time is reported separately rather than mixed into the
success-conditioned distribution. The eight exhausted `off` tasks averaged
20,781 ms (median 19,372.5 ms; p95 27,319 ms). The one exhausted `auto` task
terminated after 16,164 ms.

## Tokens and provider cost

Usage and cost coverage are 100% for all 83 physical calls.

| Metric | Playwright enrichment off | BrowserIR auto | Whole run |
| --- | ---: | ---: | ---: |
| Physical model calls | 49 | **34** | 83 |
| Tokens | 85,839 | **58,264** | 144,103 |
| Provider cost | $0.05456337 | **$0.03137911** | $0.08594248 |
| Cost per succeeded task | $0.00227347375 | **$0.00101222935** | $0.00156259055 per succeeded arm-task |
| Tokens per succeeded task | 3,576.625 | **1,879.48387** | — |

Within this round, `auto` used 30.61% fewer physical calls, 55.48% less provider
cost per success, and 47.45% fewer tokens per success than `off`. Those are
observed challenge-corpus economics under the early-stop retry policy, not a
promise of savings on arbitrary sites. Provider latency and generated length
are stochastic, so latency and round-to-round cost changes remain descriptive.

## Retained artifacts and integrity

- [JSON receipt](../packages/benchmark/output/benchmarks/browserir-openrouter-real-ab-20260826T142617Z.json)
- [Append-only NDJSON journal](../packages/benchmark/output/benchmarks/browserir-openrouter-real-ab-20260826T142617Z.ndjson)
- [Publication analysis](../packages/benchmark/output/benchmarks/browserir-openrouter-real-ab-20260826T142617Z-analysis.md)

| Artifact | SHA-256 |
| --- | --- |
| Receipt | `a74d9b53c2343aeef761729f17ca653276baf5aac7c7fe555c0c9709c13eab57` |
| Journal | `c179764f67ae1ee992614c6d1928805a493b87f8cab9413f19cfb7dfc67c7cc2` |
| Analysis | `e5ced1f11bef00d78560945373e814b2f07a86e24577a61ebcbe56ab0b5f7b10` |

The journal has exactly 83 records and is record-for-record equivalent to
`receipt.results`; every retained result has token and cost accounting. The
artifacts contain response hashes, not provider response bodies or credentials.

## Claim boundary and next evidence step

This run supports the following narrow statement:

> In a 32-task development benchmark of schedule-coordinate and cross-tree-label
> ambiguities, BrowserIR Adaptive with Qwen3.8-27B solved 31 tasks versus 24 with
> enrichment off, under a three-fresh-attempt cap.

It does not establish product-wide prevalence, unseen-site generalization,
public npm readiness, or general superiority over Playwright MCP. A claim-grade
follow-up must use a prospectively sealed untouched corpus and serialize the
exact product policy version, product-source hash, model/runtime bindings,
schedule, and price policy in the retained receipt before the first scored call.

See the [runbook](BROWSERIR_REAL_AGENT_AB_RUNBOOK.md) for the exact local command
and the [measurement design](ADAPTIVE_PLAYWRIGHT_MEASUREMENT.md) for the stricter
confirmatory gate.
