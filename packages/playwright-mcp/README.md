# `@browserir/playwright-mcp`

Private `0.1.0` milestone for a bounded adaptive layer over the official raw
MCP `Client` tool methods.

Current source status: implemented private alpha. The schedule factory returns
`schedule-coordinate-policy/3`; the package is not published to npm and is not
the default BrowserIR MCP surface.

## Ownership and exclusivity

The caller owns connection and shutdown of the supplied client. This package
never connects or closes it. While an adaptive wrapper is active, the caller
must route every `listTools` and `callTool` operation for that raw client
through the wrapper. Direct calls on the raw client cannot be observed or
serialized by middleware. A second wrapper for the same client is rejected
until the first wrapper's draining `dispose()` completes.

## Version 0.1 boundary

- Only an exact default `browser_snapshot` call can trigger adaptation.
- At most one hidden `client.callTool({ name: 'browser_snapshot', arguments:
  { boxes: true } })` is issued and it is never retried by this package.
- A hidden-call count describes a logical MCP SDK call. The SDK or transport
  may perform a different number of lower-level wire attempts.
- Unsupported, unsafe, changed-state, and failed enrichment paths return the
  exact raw visible result object.
- Hidden calls receive only an own-data `signal` plus the remaining `timeout`
  and `maxTotalTimeout` budgets. No callbacks, transport controls, resumptions,
  or caller-supplied tool definitions are inherited.
- Telemetry is off by default; opt-in events contain only bounded operation,
  outcome, mode, and logical hidden-call count fields.
- Policy handles are opaque and first-party. The main entry point exports no
  concrete policy. The explicit `@browserir/playwright-mcp/reference-policies`
  subpath offers separate grid-coordinate, schedule-coordinate, and cross-tree
  label reference policies; there is no default combined policy pack. Policy
  evaluation/projection is synchronous and cannot re-enter the wrapper.
- A reference-policy handle exposes only frozen family, version, and bounded
  support metadata. It emits a complete relation set or nothing, uses only
  uniquely actionable refs from the current boxed recapture, and never emits
  raw geometry.
- Schedule policy `/3` tolerates only a one-pixel serialized final-resource
  overhang at the schedule root edge. Two pixels remain unresolved, and the
  overlap, center, completeness, unique-ref, and unique-coordinate guards are
  unchanged.
- The package remains `private: true` until release and evidence gates pass.

## Explicit reference-policy opt-in

```ts
import { createAdaptivePlaywrightTools } from '@browserir/playwright-mcp';
import { createScheduleCoordinateReferencePolicy } from
  '@browserir/playwright-mcp/reference-policies';

const tools = createAdaptivePlaywrightTools(client, {
  mode: 'auto',
  policySet: createScheduleCoordinateReferencePolicy(),
});
```

Choose exactly one policy for the page family the integration supports. The
grid factory optionally accepts strict `maxRows` and `maxColumns` bounds; their
product cannot exceed 256 projected facts.

## Current evidence boundary

The current-source real-browser, zero-model preflight covered 64 arms and
projected 15/15 independently demonstrated recoverable relations, with one safe
fallback and zero demonstrated projection misses. A separate development A/B
with `qwen/qwen3.8-27b` and up to three fresh attempts produced `auto` 31/32
versus `off` 24/32.

That comparison is favorable development evidence, not a sealed or general
superiority claim. Its corpus was reused after an earlier projector round, and
the retained receipt does not serialize the product policy version or
product-source hash. See the
[full result](../../docs/BROWSERIR_REAL_AGENT_RESULTS.md),
[reproduction runbook](../../docs/BROWSERIR_REAL_AGENT_AB_RUNBOOK.md), and
[closed-alpha integration guide](../../docs/PLAYWRIGHT_MCP_ADAPTIVE_ALPHA.md).
