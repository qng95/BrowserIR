# Adaptive Playwright improvement measurement

Status: development study completed; confirmatory design remains prospective
Last updated: 2026-08-26

## Current implementation status

The product layer now lives in the private `@browserir/playwright-mcp` package.
The repository also contains a live official-Playwright-MCP adapter, an
eight-case fixture corpus, fresh-state retry executor, exact database oracle,
append-only physical-call journal, projection audit, `pass@k`, and complete
token/cost accounting.

The real-browser, zero-model gate covers 64 arms across schedule-coordinate and
cross-tree-label families. It projected 15/15 independently demonstrated
recoverable relations, retained one safe fallback, recorded zero projection
misses, made no model calls, and performed no task mutation.

One real-model two-mode development study then ran with `qwen/qwen3.8-27b`,
OpenRouter `alibaba`, provider fallback disabled, and `max_retry=2`. On 32 paired tasks,
`auto` solved 31/32 and `off` solved 24/32: +21.875 percentage points, with 7
`auto`-only, 0 `off`-only, 24 both, and 1 neither. At `pass@1`, `auto` reached
31/32 and `off` 23/32; at `pass@2` and `pass@3`, they reached 31/32 and 24/32.
The run made 83 physical model calls, used 144,103 tokens, and cost $0.08594248
with 100% accounting coverage. See
[the retained result](BROWSERIR_REAL_AGENT_RESULTS.md).

That `/3` receipt also records scheduler-independent active task time. Timing
starts before fresh-arm setup and includes authentication, navigation, snapshot,
BrowserIR, model, click, and oracle; cleanup/reset is included after a failed
attempt when another retry follows. Terminal cleanup, journal/log writing, and
the opposite A/B arm are excluded. Success-conditioned median/p95 time to
success was 4,930/5,298 ms for `auto` (`n=31`) and 5,118/9,385 ms for `off`
(`n=24`). Those arm distributions have different survivor sets. The primary
comparative timing is the 24-task common-success set: `auto` was faster on 17,
`off` on 7, with mean `auto - off` time −1,088.71 ms and median −151.5 ms.
Retry-exhausted terminal time is reported separately (`off` `n=8`, mean
20,781 ms; `auto` `n=1`, 16,164 ms).

This closes the earlier “mock-only runner” gap, but it does not complete the
confirmatory design below. The development corpus was reused after the `/2`
round was inspected, and the receipt does not serialize the product policy
version or product-source hash. A durable journal exists, but an untouched
prospective corpus, frozen power analysis, source-bound runtime contract, and
the full P/A/F study remain future work.

## Product decision

Promote adaptive Playwright only when the adaptive layer improves exact end-to-end
task success over plain Playwright, retains the useful ceiling of deterministic
enrichment, and passes safety and efficiency guardrails.

The original matrix smoke is mechanism evidence only. The newer 32-task result
is scored development evidence, but it also must not be pooled into the future
prospectively sealed result.

## Advertising substantiation gate

The product may ship before a comparative benchmark, but the advertising claim
must stay inside the evidence already available.

Before a sealed score-bearing P/A study, approved marketing copy is limited to
factual feature claims such as:

> A lightweight adaptive layer for Playwright MCP that adds compact structural
> context when the default snapshot is ambiguous, while preserving Playwright
> tools, refs, and actions.

The development result may be reported verbatim with its 32-task scope, retry
cap, exact model, post-inspection status, and provenance limitation. It does not
authorize the following unqualified claims:

- better than Playwright MCP;
- improves success by a stated percentage;
- faster or cheaper in general;
- works on every website or every ambiguous interface.

After a clean sealed study, a benchmark-scoped comparison is allowed only when
all hard guardrails pass and the lower bound of the frozen paired 95% interval
for `Delta(A,P)` is above zero. Any wording must name the tested corpus, model,
retry policy, sample size, interval, and limitations. A representative shadow
sample is still required before translating challenge-corpus lift into a
product-wide claim.

## Prospective benchmark arms

The primary experiment uses three fresh-state arms with the same model, task,
Playwright action catalog, browser profile, budgets, and deterministic judge.

- `P-PLAIN`: exact official Playwright MCP pass-through without host enrichment.
- `A-ADAPTIVE`: package mode `auto` with one frozen, host-selected policy.
- `F-FORCE-COMPACT`: the same projector and box-free output contract as A, with
  acquisition forced for every snapshot the frozen policy marks applicable.

F isolates the policy's `sufficient` versus `requires feature` routing from the
value of the structural representation. It does not detect false negatives in
the earlier applicability decision; deterministic qualification tests those
separately. F is a benchmark-only intervention, not a public package mode, and
is not raw boxed Playwright. A separate `R-RAW-BOX` diagnostic is
allowed only when the question is whether compaction itself helps; it is not a
substitute for F because it changes both routing and model-facing representation.

## Experimental unit

One matched triplet is:

```text
(case instance, model seed, browser/runtime revision) × {P, A, F}
```

Each cell receives a fresh browser, application/database state, conversation,
and provider response. Responses are never reused across arms, even when request
bytes happen to match. The exact external DB/audit/submission oracle is blind to
arm identity.

All six arm orders are counterbalanced within every family using a frozen,
domain-separated schedule. A failure proven to occur before arm exposure
invalidates the whole matched triplet. Post-randomization transport, parser,
route, receipt, dispatch, and oracle failures remain arm outcomes in the
intention-to-treat analysis; they must not be removed as missing data. Every
failure remains in the artifact and is never silently rerun. Report operational
failure by arm, with predeclared worst/best-case bounds for unknown outcomes.

For collision cases, the inference unit is larger than one page. All hidden worlds
belonging to the same case and seed form one cluster. In particular, the two lossy
worlds share the same model seed and require opposite actions. They are reported
as one `lossyTwinPairSolved` endpoint, so stochastic answers to indistinguishable
inputs cannot be mistaken for representation-level discrimination. Confidence
intervals and resampling operate on clusters while preserving frozen family/site
weights; the four worlds are never counted as independent observations.

## Primary KPI

The primary outcome is paired exact-oracle task-success lift:

```text
Delta(A,P) = mean(success_A - success_P)
```

`success` is one only when the final sealed judge passes every required
postcondition. Model self-report, decision yield, clicks, dispatches, and partial
mutations are not success.

A directional improvement claim requires the lower bound of the predeclared
paired 95% interval for `Delta(A,P)` to be above zero. The frozen corpus must be
balanced by family and case so one authored family cannot dominate the estimand.

The business-important minimum effect is not known yet. A five-percentage-point
MDE may be used for planning only and must be labeled provisional until product
value and latency/error budgets exist.

## Secondary outcomes and drivers

- `Delta(A,P)` within cases preclassified as `needs-enrichment`.
- `Delta(A,P)` within matched `semantic-sufficient` negatives.
- `Delta(A,F)` to diagnose sufficiency-routing misses on policy-applicable cases;
- deterministic applicability false-negative and false-escalation counts;
- complete projection, unresolved, and state-mismatch rates;
- hidden acquisitions per eligible snapshot and acquisitions saved versus F;
- model-visible calls, backend calls, bytes, model turns, and action retries;
- exact provider tokens and receipts, a no-cache price counterfactual, provider
  latency, local acquisition latency, and end-to-end time to success.

Cost is reported only with at least 95% complete normalized usage coverage. Local
acquisition cost and provider model cost remain separate; fixed arm order must not
be interpreted as a causal latency or prompt-cache result.

## Guardrails

The following are hard gates, not average targets:

- zero hidden mutating actions;
- at most one hidden read per model-visible call;
- zero raw geometry metadata from a hidden acquisition in A model output;
- byte-exact pass-through and zero hidden calls on proven sufficient snapshots;
- zero stale-ref or wrong-revision dispatches attributable to enrichment;
- zero prompt, oracle, fixture, expected-answer, or detector-route leakage;
- complete-or-none structural facts with current Playwright refs;
- every supported positive passes deterministic acquisition and projection
  qualification before a score-bearing run.

An explicit model request for official Playwright `{boxes:true}` is not a hidden
adaptive acquisition. It is counted separately and cannot be credited as an
adaptive projection. The frozen product contract must either preserve that
official override consistently in P/A/F or forbid it consistently in all arms.

The following launch targets are provisional until product SLOs are available:

- A versus F success non-inferiority margin: 2 percentage points;
- hidden acquisitions saved versus F: at least 50%;
- p95 end-to-end latency regression versus P: at most 10% and 250 ms;
- wrong-target mutation increase: at most 0.5 percentage points;
- unresolved or false-escalation rate: below 1%.

Provisional targets guide investigation; they do not authorize a headline claim.

## Corpus and prevalence

The challenge corpus estimates conditional effects, not real-world prevalence.
It needs a development slice and an untouched sealed slice containing:

- matrix/grid coordinates;
- schedule coordinates;
- cross-tree labels;
- matched semantic-sufficient negatives for each supported family;
- at least two independently authored fixture implementations per supported
  family.

Virtualized or recycled-row identity is a v1 fail-closed boundary, not a supported
positive. It requires temporal identity and revision evidence and must become a
separate stateful policy before entering a default-promotion score.

Production value also requires a representative shadow sample that estimates
how often each route occurs without exposing tasks or page contents. Report the
expected product effect as a function of observed enrichment prevalence `pi`:

```text
Delta_product(pi) = pi * Delta_needs_enrichment
                  + (1 - pi) * Delta_semantic_sufficient
```

Do not use the authored challenge mix as `pi`.

## Execution stages

The evaluation progresses through four gates. Evidence from an earlier gate is
never silently promoted into a later claim.

1. **Deterministic qualification, no model.** Prove detector routing, exact
   projection, current-ref commitment, byte-exact negative pass-through, hidden
   call bounds, and privacy on every frozen capture.
2. **Scored development study.** Exercise fresh browser state, model requests,
   retries, dispatch, the external oracle, receipts, telemetry, and economics.
   The 2026-08-26 two-mode study completed this stage. Its correctness can guide
   engineering, but its inspected corpus cannot become the sealed corpus.
3. **Sealed multi-family paired study.** Run the frozen matched schedule and make
   the `A-P` task-success comparison. This estimates improvement on the challenge
   corpus only.
4. **Representative shadow measurement.** Estimate routing prevalence and
   operational cost on product traffic without using page contents or expected
   answers. Combine it with conditional effects; do not score customer tasks with
   the authored challenge weights.

The first three stages answer whether the layer can and does improve outcomes on
supported mechanisms. The fourth is required before estimating product-wide
value or turning the layer on by default.

## Measurement evidence contract

Every retained trial must join the external outcome to both model-visible and
physical acquisition telemetry. Schedule declarations alone are insufficient;
the observed execution must attest to the same values. At minimum the artifact
records:

- strategy, case, family, world, seed, browser/runtime revision, and fresh-state
  identifier;
- exact judge, task, target, action-catalog, runtime, model, and configuration
  hashes; the observed seed, within-triplet position, fixed origin, fresh-state
  identifier, and baseline-state commitment;
- for every physical model turn: the model-visible observation hash, full request
  hash, request-with-observation-replaced-by-a-fixed-sentinel hash, response
  content hash, and hashed physical response identity;
- model-visible tool calls and bytes;
- backend calls, hidden read calls/errors, backend bytes, and hidden latency;
- detector decision and reason, acquisition cause (`none`, `detector`, or
  `forced`), projection result, unresolved state, and state mismatch;
- exact provider usage/receipt fields and end-to-end duration;
- mutation count, collateral-audit count, structured submission count, and final
  oracle result.

All physical response identities must be unique across the run. A lossy twin can
receive representation-level discrimination credit only when its decision-bearing
observations differ while its observation-redacted request envelopes are exactly
equal. Different full requests by themselves are not representation evidence.

Detector outcome and experimental forcing are separate fields. Otherwise an
`F-FORCE-COMPACT` acquisition could be incorrectly counted as a detector true
positive. Likewise, model-visible calls and hidden backend calls are separate;
the adaptive arm must not look cheaper merely because the hidden call was omitted
from ordinary tool metrics.

The first executable comparison is `P-PLAIN` versus `A-ADAPTIVE`. A second matched
comparison, `A-ADAPTIVE` versus `F-FORCE-COMPACT`, diagnoses routing coverage. A
single three-arm report is permitted only after a runner can balance all six arm
orders and retain the same physical telemetry contract for all three arms.

## Sample size

Repeated seeds improve precision for the frozen case but do not create new site
or family coverage. Determine the scored schedule only after an unscored pilot
estimates paired discordance and family clustering, then verify power by a frozen
simulation.

The current conservative paired Hoeffding interval is too wide for a small run:

```text
half_width(n) = sqrt(2 * ln(40) / n)
```

Thirty triplets therefore cannot support a product decision. A five-point MDE
can require thousands of triplets under that bound. The statistical method and
sample size must be frozen together; changing to a tighter justified paired
method after observing outcomes is forbidden.

## Interpretation

| Result | Product conclusion |
|---|---|
| A beats P, is non-inferior to F, and all guardrails pass | Evidence that adaptive routing improves outcomes while retaining enrichment value |
| A beats P but trails F beyond the margin | Enrichment works, but detector or policy coverage is not ready for default use |
| F beats P while A does not | Detector false negatives or routing coverage are the limiting factor |
| A, F, and P are equivalent while A adds cost | No observed product value for the layer |
| Interval crosses zero | Inconclusive; no uplift claim |
| A loses to P or any safety gate fails | Reject or roll back the adaptive default |

## Authorization boundary

No further paid run and no sealed or confirmatory run is authorized by this
document alone. Before confirmatory inference, freeze and checksum the corpus,
protocol, schedule, model/provider contract, implementation bundle, exact
product policy/source provenance, runtime, judge, price policy, output journal,
and total spend cap. Publish the frozen decision rule regardless of the observed
sign.
