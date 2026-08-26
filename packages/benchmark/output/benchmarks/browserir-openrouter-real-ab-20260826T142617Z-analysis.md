# BrowserIR real A/B: pass@k and active task latency

Status: development evidence; not sealed or confirmatory

Run date: 2026-08-26

## Measurement boundary

This round uses `qwen/qwen3.8-27b` through the OpenRouter `alibaba` route with
provider fallback disabled. It evaluates the same 32 matched tasks in
Playwright enrichment `off` and BrowserIR `auto`, with `max_retry=2` and
stop-on-first-exact-oracle-success.

`pass@k` is the observed fraction of tasks solved within the first `k` fresh
attempts. It is not the combinatorial code-generation estimator sometimes
given the same name.

The primary timing metric is scheduler-independent **active task
time-to-success**. Each attempt starts before its fresh fixture/browser/MCP arm
opens and runs through authentication, navigation, snapshot construction,
BrowserIR processing when enabled, model response, click dispatch, and terminal
oracle verification. When an attempt fails and another retry follows, its
post-terminal cleanup/reset is also counted. Cleanup after the terminal attempt,
journal/logging time, and time spent running the opposite A/B arm are excluded.
`modelCallLatencyMs` remains in raw records as a provider diagnostic and is not
used as task latency.

## Accuracy and retry policy

| k | Off solved | Auto solved | Auto - off | Auto only | Off only | Both | Neither |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 23/32 (71.875%) | **31/32 (96.875%)** | **+25.000 pp** | 8 | 0 | 23 | 1 |
| 2 | 24/32 (75.000%) | **31/32 (96.875%)** | **+21.875 pp** | 7 | 0 | 24 | 1 |
| 3 | 24/32 (75.000%) | **31/32 (96.875%)** | **+21.875 pp** | 7 | 0 | 24 | 1 |

| Retry metric | Off | Auto |
| --- | ---: | ---: |
| Success exactly on attempts 1 / 2 / 3 | 23 / 1 / 0 | **31 / 0 / 0** |
| Tasks requiring at least one retry | 9 | **1** |
| Failed after the retry cap | 8 | **1** |
| Physical model calls | 49 | **34** |

The final paired outcome is 7 auto-only, 0 off-only, 24 both, and 1 neither.
The exact two-sided McNemar sensitivity and the case-cluster sign sensitivity
are both `p=0.015625`; these remain descriptive because the development corpus
was inspected before this round.

## Active task time-to-success

The per-arm rows are conditioned on success and therefore show their sample
sizes. Because the two arms solve different task sets, the common-success
paired comparison is the cleaner latency contrast.

| Successful-task TTS | Off (n=24) | Auto (n=31) |
| --- | ---: | ---: |
| Mean | 5,982.71 ms | **4,928.71 ms** |
| Median | 5,118 ms | **4,930 ms** |
| p90, nearest rank | 9,375 ms | **5,160 ms** |
| p95, nearest rank | 9,385 ms | **5,298 ms** |
| Min / max | 4,523 / 10,252 ms | **4,542 / 5,706 ms** |

Among the 24 tasks solved by both arms, `auto` was faster on 17 and `off` was
faster on 7, with no exact ties. The paired `auto - off` difference was
**-1,088.71 ms on average** and **-151.5 ms at the median**. The larger mean
gain is driven by opaque tasks where the BrowserIR projection shortens both
model work and total task execution; semantic passthrough pairs are mostly
close and expose ordinary provider/runtime fluctuation.

## Retry-cap observations

Failed tasks are not mixed into successful-task TTS. They are retained as
right-censored time-to-success observations at the retry cap.

| Retry-exhausted active time-to-terminal | Off (n=8) | Auto (n=1) |
| --- | ---: | ---: |
| Mean | 20,781 ms | **16,164 ms** |
| Median | 19,372.5 ms | **16,164 ms** |
| p95, nearest rank | 27,319 ms | **16,164 ms** |

As a policy-level secondary view over all 32 scheduled arm-tasks, including
successes and retry-cap terminals, mean active time-to-terminal was 9,682.28 ms
for `off` and 5,279.81 ms for `auto`, a descriptive 45.47% reduction. This is
not substituted for success-conditioned TTS.

## Usage and cost

Usage and cost coverage are 100% for all 83 physical model calls.

| Metric | Off | Auto | Whole run |
| --- | ---: | ---: | ---: |
| Physical calls | 49 | **34** | 83 |
| Tokens | 85,839 | **58,264** | 144,103 |
| Provider cost | $0.05456337 | **$0.03137911** | $0.08594248 |
| Cost per succeeded task | $0.00227347 | **$0.00101223** | $0.00156259 per succeeded arm-task |
| Tokens per succeeded task | 3,576.63 | **1,879.48** | — |

Within this run, `auto` used 30.61% fewer physical calls, 55.48% less provider
cost per success, and 47.45% fewer tokens per success than `off`. These are
challenge-corpus observations under this retry policy, not general savings
claims.

## Product and integrity checks

- Opaque accuracy: `off` 8/16, `auto` 15/16.
- Semantic-sufficient accuracy: both arms 16/16.
- Product routes: 15 projections, 16 passthroughs, and 1 safe fallback task.
- Projection audit: 15 demonstrated projections, 1 unresolved relation without
  recoverability proof, and 0 demonstrated projection misses.
- Model outcomes: 81 decisions, 1 dispatch failure, 1 malformed target, and 0
  provider failures.
- The NDJSON journal contains exactly 83 records and matches `receipt.results`.
- Receipt SHA-256:
  `a74d9b53c2343aeef761729f17ca653276baf5aac7c7fe555c0c9709c13eab57`.
- Journal SHA-256:
  `c179764f67ae1ee992614c6d1928805a493b87f8cab9413f19cfb7dfc67c7cc2`.

## Claim boundary

This run demonstrates that the thin BrowserIR layer can improve success,
retry burden, active task time-to-success, and observed cost on this fixed
structural-ambiguity development corpus. It does not establish unseen-site
generalization or general superiority over Playwright. A claim-grade follow-up
still needs a prospectively sealed untouched corpus and serialized product,
policy, model, schedule, and pricing provenance before the first scored call.
