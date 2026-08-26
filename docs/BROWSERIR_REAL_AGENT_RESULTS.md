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

The two modes share the same task and attempt seed. The model never sees a
previous attempt, the hidden world, the expected target, or the oracle result.

## Accuracy and paired outcomes

| Metric | Playwright enrichment off | BrowserIR auto |
| --- | ---: | ---: |
| Final task success | 24/32 (75.00%) | **31/32 (96.875%)** |
| Opaque worlds | 8/16 (50.00%) | **15/16 (93.75%)** |
| Semantic-sufficient worlds | 16/16 (100%) | 16/16 (100%) |
| `pass@1` | 24/32 (75.00%) | 30/32 (93.75%) |
| `pass@2` | 24/32 (75.00%) | 30/32 (93.75%) |
| `pass@3` | 24/32 (75.00%) | **31/32 (96.875%)** |

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

`auto` used 36 physical model calls: 30 tasks succeeded on attempt 1, none on
attempt 2, one on attempt 3, and one failed after the cap. `off` used 48 calls:
24 tasks succeeded on attempt 1 and eight failed after all three attempts.

Across both modes the retained journal contains 80 decisions, 2 dispatch
failures, and 2 malformed target selections. There were no recorded provider
network failures. The two malformed selections occurred on a semantic
passthrough task; a fresh third attempt recovered it. This is why `pass@k` is
reported instead of treating one stochastic answer as the product score.

## Tokens and provider cost

Usage and cost coverage are 100% for all 84 physical calls.

| Metric | Playwright enrichment off | BrowserIR auto | Whole run |
| --- | ---: | ---: | ---: |
| Physical model calls | 48 | **36** | 84 |
| Tokens | 84,293 | **62,019** | 146,312 |
| Provider cost | $0.05609915 | **$0.03526395** | $0.09136310 |
| Cost per succeeded task | $0.00233746 | **$0.00113755** | $0.00166115 per succeeded arm-task |
| Tokens per succeeded task | 3,512.21 | **2,000.61** | — |

Within this round, `auto` used 25% fewer physical calls, 51.33% less provider
cost per success, and 43.04% fewer tokens per success than `off`. Those are
observed challenge-corpus economics under the early-stop retry policy, not a
promise of savings on arbitrary sites. Provider latency and generated length
are stochastic, so latency and round-to-round cost changes remain descriptive.

## Retained artifacts and integrity

- [JSON receipt](../packages/benchmark/output/benchmarks/browserir-openrouter-real-ab-20260826T103510Z.json)
- [Append-only NDJSON journal](../packages/benchmark/output/benchmarks/browserir-openrouter-real-ab-20260826T103510Z.ndjson)
- [Round-to-round analysis](../packages/benchmark/output/benchmarks/browserir-openrouter-real-ab-20260826T103510Z-analysis.md)

| Artifact | SHA-256 |
| --- | --- |
| Receipt | `ae837839663650d6234c63dfcfd489a8856d5f6d6a247601b3688fa316aead26` |
| Journal | `2b356d50b23ad5ee9bb6492ca65e522c1eca2725c4559bb2482854c7e186327b` |
| Analysis | `4c3ba625891a6c564a6f81e9d97f837ea07549d350f2b969b8f21db3fd82ae14` |

The journal has exactly 84 records and is byte-for-byte equivalent to
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
