# Adaptive Playwright architecture

Status: implemented private source alpha with development evidence
Last updated: 2026-08-26

## Decision

BrowserIR should be a small, deterministic observation policy around the
official Playwright MCP interface. It should not require every agent to consume
an always-on canonical graph or a second browser action protocol.

The default product contract is:

```text
official Playwright MCP result
  -> detect whether the current semantic snapshot is sufficient
  -> optionally enable one read-only Playwright feature
  -> prove a complete compact structural projection
  -> return the normal Playwright result and Playwright refs
```

Playwright continues to own the public tools, refs, actions, browser lifecycle,
actionability, waiting, and dispatch. BrowserIR owns only the host-side decision
about when more observation is needed and how proven evidence is compacted.

This is not the claim that BrowserIR is unnecessary. It changes BrowserIR from
an alternative browser runtime into the control plane that decides when the
standard Playwright observation needs help.

## Why this direction

The original score-excluded matrix recovery smoke observed, for one authored
family and one seed:

- official Playwright snapshots with boxes: 4/4 one-shot oracle success;
- default AX plus conditional compact geometry: 4/4;
- production-default BrowserIR observation: 2/4;
- the adaptive path used boxes for both lossy worlds and skipped them for both
  semantically complete rescue worlds.

The production-default BrowserIR lossy snapshots were truncated and
byte-identical across worlds that required opposite actions. The experiment is
not a general benchmark or non-inferiority result, but it is enough to reject an
always-heavy default as the only architecture worth pursuing.

That direction is now implemented in the private
`@browserir/playwright-mcp` package and exercised through official Playwright
MCP with two first-party policy families. A 64-arm real-browser, zero-model
preflight projected all 15 independently demonstrated recoverable relations,
retained one safe fallback, and recorded zero projection misses. A later
32-task development A/B with `qwen/qwen3.8-27b` produced `auto` 31/32 and `off`
24/32 under a three-fresh-attempt cap. The result is favorable but
nonconfirmatory; see [the full result](BROWSERIR_REAL_AGENT_RESULTS.md).

## Public boundary

The adaptive mode's model-visible catalog is the official safe Playwright MCP
catalog. The current private integration boundary is
`@browserir/playwright-mcp`; the existing `@browserir/mcp` graph surface remains
unchanged. BrowserIR adds no parallel `browser_observe`,
`browser_inspect`, `browser_act`, or incompatible entity-reference namespace to
adaptive mode.

The model must see:

- the same Playwright tool names and input schemas;
- the same current Playwright refs used by later Playwright actions;
- the original result byte-for-byte when semantic evidence is sufficient;
- a box-free authoritative snapshot plus small structural facts after an
  adaptive acquisition;
- a bounded observation-gap section when enrichment was required but could not
  be proven.

Detector routes, reason codes, experiment arms, fixture identities, raw boxes,
selectors, task queries, and oracle data are host-only.

## Runtime layers

```text
agent tool-call budget
  -> submission policy
  -> AdaptivePlaywrightSnapshotBroker
       -> SnapshotResult parser
       -> deterministic policy detector
       -> optional feature acquisition
       -> complete-or-unresolved projector
  -> navigation and profile safety
  -> raw Playwright MCP broker
  -> official @playwright/mcp
```

The adaptive broker is below the model-visible budget wrapper. One model tool
call therefore remains one budgeted call even when the host makes one hidden
read-only acquisition. Physical backend calls are reported separately.

The product implementation now lives in
[`packages/playwright-mcp`](../packages/playwright-mcp/):

- [`src/index.ts`](../packages/playwright-mcp/src/index.ts) owns the exclusive,
  serialized raw-client wrapper, pass-through behavior, lifecycle, and bounded
  telemetry;
- [`src/reference-policies.ts`](../packages/playwright-mcp/src/reference-policies.ts)
  owns the first-party grid, schedule, and cross-tree policy handles;
- [`src/internal/snapshot.ts`](../packages/playwright-mcp/src/internal/snapshot.ts)
  parses and rewrites the known inline Playwright snapshot format.

The benchmark adapter, fresh-state retry executor, fixture corpus, independent
recoverability witness, and paid runner remain under
[`packages/benchmark`](../packages/benchmark/). They measure the product bytes;
they are not the product implementation. Adaptive mode is still private and is
not the public npm or default MCP path. Promotion requires the remaining gates
below.

## V1 feature policy

V1 admits one hidden feature:

```json
{"boxes":true}
```

It is always invoked as an exact full-page `browser_snapshot` call. A detector
cannot supply arbitrary arguments. Targeted snapshots, depth limits, files,
screenshots, DOM evaluation, actions, retries, and multi-stage cascades are not
hidden features.

Host configuration is deliberately small and immutable for a wrapper:

```ts
{
  mode: 'auto' | 'off',
  policySet: createScheduleCoordinateReferencePolicy(),
  telemetry: { onEvent: publicSafeDiagnosticSink },
}
```

The host chooses exactly one first-party policy family because its integration
already knows the supported page structure. There is no combined auto-router.
`auto` permits the selected policy to acquire geometry; `off` is the stable
rollout and benchmark control. The model never chooses its arm or sees the
detector outcome.

## Interception rule

The target contract applies to every successful Playwright result containing
one full inline `### Snapshot` section, including a snapshot embedded in a
navigate, click, fill, or wait result. This prevents two different observation
contracts depending on which Playwright tool happened to produce the snapshot.

Results without an inline snapshot, file-backed or selective snapshots, and
explicit `browser_snapshot` feature arguments pass through unchanged. Parser
drift also passes through the original result and emits only a host diagnostic;
the broker must not guess how to rewrite an unknown Playwright format.

## Projection rules

Every structural policy is task-independent. Its detector receives only the
current model-visible snapshot and fixed host policy. It cannot receive the
task prompt, requested row or label, correct target, fixture variant, or oracle.

A projector must satisfy all of the following:

1. Use refs from the newest acquired snapshot, never stale refs from the
   preceding semantic snapshot.
2. Remove raw box coordinates before returning model content.
3. Emit a complete, symmetric relation set or no facts at all.
4. Prove that every emitted ref appears exactly once in the authoritative
   snapshot.
5. Use deterministic normalized ordering and bounded output.
6. Preserve upstream structured content and non-observation receipt text when
   the page remains the same.
7. Never select, rank, or recommend an action.

The narrow policies emit facts such as:

```text
### Structural facts
- grid-cell [ref=e17] row="Paris" column="March"
```

Every policy proves a complete mapping and refuses partial, overlapping, or
ambiguous geometry. `schedule-coordinate-policy/3` additionally tolerates only
a one-pixel serialized resource-box overhang at the schedule root edge; a
two-pixel overhang still fails. Center, overlap, completeness, unique-ref, and
unique-coordinate guards remain unchanged. Grid, schedule, and cross-tree
labels are separate explicit policies, not a universal BrowserIR worldview.

## Failure semantics

An adaptive read must not turn a previously dispatched mutation into a tool
error that encourages the model to repeat it.

- An upstream Playwright throw or error propagates unchanged.
- No applicable policy or semantically sufficient evidence returns the exact
  original result.
- A detector, hidden acquisition, or projection failure preserves a successful
  upstream result and appends a generic observation gap when it is safe to
  rewrite the known snapshot format.
- A successful hidden acquisition becomes authoritative. If complete facts
  cannot be proven, raw boxes are stripped and the latest snapshot is returned
  with an observation gap.
- No adaptive path retries or silently falls back to the full BrowserIR graph.

Playwright remains responsible for rejecting a stale ref at action time.
Identity-sensitive recovery such as recycled virtual rows requires a later
stateful policy with stronger revision evidence; it must not be improvised by
the stateless geometry plugin.

## Accounting and diagnostics

Normal `AgentToolMetrics` retain model-visible meaning. Hidden acquisition is
reported through separate adaptive metrics:

- model-visible calls versus physical backend calls;
- hidden calls and hidden errors;
- eligible, pass-through, projected, and unresolved snapshots;
- bounded counts by policy and reason code;
- model-visible and backend response bytes;
- public-safe per-call duration, route, outcome, and fact count.

Diagnostics contain no URLs, refs, labels, facts, raw page text, prompts,
selectors, or answers. A failing diagnostic sink cannot alter browser behavior.

## The full graph runtime

The existing canonical graph runtime remains available as a separately selected
legacy/experimental mode while its unique benefits are measured. It is not an
automatic fallback from adaptive Playwright because it changes tool names, ref
semantics, revision behavior, action dispatch, and output shape.

A future fallback may join adaptive mode only if it returns the same Playwright
refs and the same compact structure contract. Mixing `eN@rN` entities with
Playwright refs in one conversation is forbidden.

## Promotion gates

Before making adaptive Playwright the default public BrowserIR mode:

1. Keep the 64-arm zero-model gate green with zero hidden actions, exact call
   accounting, 15/15 recoverable projections, and no demonstrated misses.
2. Retain matched semantic-sufficient negatives and byte-exact pass-through.
3. Add and qualify a stateful recycled-row policy before claiming that family;
   it remains a fail-closed non-goal today.
4. Verify every supported snapshot-bearing Playwright tool and current-ref
   action dispatch after projection.
5. Freeze maximum extra calls, bytes, latency, unresolved behavior, and product
   source/policy provenance in the result receipt.
6. Run a prospectively sealed, untouched, multi-family comparison before a
   confirmatory correctness, prevalence, or economic claim.

The present implementation has real mechanism and agent evidence, but it is
still a private source alpha. The 31/32 versus 24/32 development result does not
by itself authorize a public default, general performance claim, or npm release.

The score-bearing product decision and KPI contract are defined separately in
[Adaptive Playwright improvement measurement](ADAPTIVE_PLAYWRIGHT_MEASUREMENT.md).

## Explicit non-goals for V1

- a universal canonical interaction graph in every response;
- LLM- or query-conditioned routing;
- automatic full-graph fallback;
- screenshot, vision, OCR, raw DOM, CDP, or arbitrary evaluation fallback;
- fuzzy identity recovery;
- multi-stage feature cascades;
- a public third-party projector registry;
- replacing Playwright actionability, auto-waiting, or action tools.

These can be added only when a concrete failure family demonstrates that the
small deterministic layer cannot solve the problem safely.
