# BrowserIR real agent A/B runbook

## Frozen runtime choices

- Model: `qwen/qwen3.8-27b`
- OpenRouter provider route: `alibaba`
- Provider fallback: disabled
- Provider/HTTP retries inside one physical attempt: zero
- Evaluation `max_retry`: 2 by default (three fresh attempts maximum)
- Retry stop rule: stop each mode after its first exact-oracle success
- Cost stop: USD 0.10 per process by default
- Score: exact hidden fixture-database oracle after one model-selected click
- Isolation: fresh fixture process, in-memory database, Playwright MCP process,
  Chromium context, page, and model response for every arm

The v2 development corpus contains eight independently implemented sites, four
hidden worlds per site, and two matched product modes. A full run contains 32
task pairs. With `max_retry=2`, it makes at least 64 and at most 192 physical
model calls; early stopping determines the actual count. It is descriptive
development evidence, not a sealed confirmatory claim.

Every retry gets a fresh fixture process, in-memory database, Playwright MCP
process, Chromium context, page, snapshot, and Qwen response. `off` and `auto`
share the same seed at the same task/attempt index. The hidden oracle tells only
the benchmark supervisor whether to schedule another fresh attempt; neither the
oracle result nor a previous answer is shown to the model. This is therefore an
evaluation retry policy, not a claim that a deployed agent can observe a hidden
database oracle.

Attempt-one seeds stay identical when `max_retry` changes. Later attempts use a
fixed disjoint seed stride, so raising the retry cap does not silently change
the `pass@1` sample.

## One-time Keychain setup

Store the OpenRouter key under the exact account and service expected by the
wrapper. The command prompts for the value and does not put it in the repository.

```sh
security add-generic-password -U -a BrowserIR -s OPENROUTER_API_KEY -w
```

Verify only that the item exists; do not paste its value into logs or chat.

```sh
security find-generic-password -a BrowserIR -s OPENROUTER_API_KEY >/dev/null
```

## Full real-browser run

From the repository root:

```sh
pnpm benchmark:browserir-real-ab
```

The wrapper reads the key from macOS Keychain, passes it only to the benchmark
process, unsets its shell copy on exit, and creates a unique JSON receipt plus
an arm-by-arm NDJSON journal under `packages/benchmark/output/benchmarks/`.
The journal is appended after every completed arm, so an interrupted run retains
its diagnostic prefix. That directory is intentionally gitignored.

## Bounded or resumed run

Pair indices follow catalog order, then world order. To run a contiguous range:

```sh
BROWSERIR_REAL_AB_PAIR_START=16 \
BROWSERIR_REAL_AB_PAIR_LIMIT=16 \
pnpm benchmark:browserir-real-ab
```

Both values are decimal integers. The runner rejects a range outside the frozen
catalog. A subset receipt must remain separate from a full-run receipt unless a
declared analysis combines them.

The retry and spend ceilings are explicit environment settings:

```sh
BROWSERIR_REAL_AB_MAX_RETRIES=2 \
BROWSERIR_REAL_AB_COST_STOP_USD=0.10 \
pnpm benchmark:browserir-real-ab
```

`BROWSERIR_REAL_AB_MAX_RETRIES` accepts 0 through 5. The cost stop accepts a
positive USD value up to 10. The runner checks the stop before starting each
request, so the final request can overshoot the threshold by that one request's
charge. Do not raise the cost stop without a new spend authorization.

## Required preflight before paid calls

Run the deterministic unit gates:

```sh
pnpm --filter @think-dom/fixture-app typecheck
pnpm --filter @browserir/benchmark typecheck
pnpm --filter @browserir/playwright-mcp typecheck
pnpm --filter @browserir/playwright-mcp exec vitest run \
  tests/reference-policies.test.ts \
  tests/schedule-projection-diagnostic.test.ts
pnpm --filter @think-dom/fixture-app exec vitest run \
  tests/adaptive-accuracy-holdout.test.ts
pnpm --filter @browserir/benchmark exec vitest run \
  tests/adaptive-product-ab-broker.test.ts \
  tests/browserir-holdout-zero-model-preflight.test.ts
```

Then run the real-browser, zero-model qualification. It launches Playwright but
makes no provider calls and performs no holdout action:

```sh
BROWSERIR_RUN_HOLDOUT_ZERO_MODEL_PREFLIGHT=1 \
pnpm --filter @browserir/benchmark exec vitest run \
  tests/browserir-holdout-zero-model-preflight.e2e.test.ts
```

Do not start a paid run if the preflight reports a mutation, an external page
request, raw geometry exposure, reused runtime identity, or an unexpected route.

An MCP click error is a scored failed physical attempt. Under the evaluation
retry policy, its next retry (if available) starts from wholly fresh state. A
process-level interruption makes the run incomplete; retain its journal as
diagnostic evidence and do not merge that prefix into a later complete run.

## Interpretation

Report cumulative `pass@1` through `pass@(max_retry+1)`, attempts to first
success, retries used, failures after the retry cap, `off` and `auto` successes,
paired lift, opaque and semantic strata, `auto-only`, `off-only`, exact
two-sided McNemar sensitivity, provider failures, malformed decisions, latency,
tokens, and provider cost. Here `pass@k` means the observed fraction of tasks
solved by the first `k` fresh attempts under the stop-on-success policy; it is
not the combinatorial code-generation estimator sometimes given the same name.

Final cost, cost per succeeded arm-task, final token count, and tokens per
succeeded arm-task are published only at 100% receipt/usage coverage. When a
provider response lacks accounting, the receipt retains observed partial totals
but sets final totals and per-success economics to `null`.

A positive point estimate is not proof when the paired interval or exact
sensitivity still includes the null. Never merge runs made with different
models, provider routes, retry caps, or cost-stop-truncated schedules into one
accuracy estimate.

## Projection fallback taxonomy

`projection-unresolved` is always a safe thin-layer fallback to the original
Playwright snapshot. It is not automatically a Browser IR accuracy failure.
The zero-model preflight separately runs an evaluation-only geometric bijection
witness, constructs the complete relation without reading the requested target,
and only then checks that relation against the fixture oracle:

- `safeFallbacks`: every unresolved product projection;
- `projectionMisses`: safe fallbacks for which the independent witness still
  constructs a complete oracle-correct relation;
- `unresolvedWithoutRecoverabilityProof`: fallbacks where no complete relation
  was demonstrated from the captured representation.

The paid Qwen receipt from 2026-08-25 is bound to
`schedule-coordinate-policy/2`: its 16 opaque-auto cells contain 13 product
projections and 3 safe fallbacks, including two demonstrated Harbor RTL
projection misses. Do not relabel that historical receipt after a projector
change.

`schedule-coordinate-policy/3` admits only a one-pixel serialized resource-box
overhang at the schedule root edge, while retaining the overlap, center,
completeness, unique-ref, and unique-coordinate guards. Its full 64-arm
zero-model preflight contains 15 product projections, 1 safe fallback, 0
demonstrated projection misses, and 15/15 projection recall on independently
demonstrated recoverable relations. The remaining Catalog localization
`opaque-p1` layout places both controls below the two labels, so the witness
cannot form a 2-by-2 bijection; that cell remains a fixture/layout limitation.
These are zero-model qualification facts, not a replacement paid accuracy
score. It was followed by a fresh `/3` paid result and must not be merged with
the historical `/2` receipt.

## Retained `/3` development result

The full 2026-08-26 run used `qwen/qwen3.8-27b`, OpenRouter `alibaba`, provider
fallback disabled, and `max_retry=2`. It completed 32 paired tasks with 84
physical model calls:

- `auto`: 31/32 (96.875%); `off`: 24/32 (75.00%); lift +21.875 points;
- 7 `auto`-only, 0 `off`-only, 24 both successful, and 1 neither;
- exact paired McNemar and case-cluster sign sensitivities: `p=0.015625`;
- `auto pass@1`: 30/32; `auto pass@3`: 31/32;
- 15 opaque projections, 1 safe fallback, 0 demonstrated projection misses;
- 146,312 tokens and $0.09136310 total cost at 100% usage/cost coverage;
- `auto`: 36 calls, 62,019 tokens, $0.03526395 total, and $0.00113755 per
  succeeded task.

These are descriptive development numbers. The corpus was reused after the
preceding `/2` round was inspected, and the current receipt schema does not
serialize the product policy version or product-source hash. The run was made
from the `/3` workspace after the 64-arm zero-model preflight and its route
behavior matches `/3`, but a claim-grade follow-up must bind those exact bytes
inside the receipt before its first scored call.

See [the complete result, artifact checksums, and claim boundary](BROWSERIR_REAL_AGENT_RESULTS.md).

The JSON receipt computes both pair-level exact McNemar sensitivity and a more
conservative exact sign sensitivity over site/case clusters. Treat worlds from
one site as related observations; do not claim significance from the pair-level
number alone.
