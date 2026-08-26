# Playwright MCP adaptive closed alpha

Status: private, host-integrator closed alpha

Evidence boundary: current `/3` zero-model and real-agent development evidence

Last reviewed: 2026-08-26

## What this alpha is

`@browserir/playwright-mcp` is Node.js middleware around the official raw MCP
`Client` methods `listTools` and `callTool`. The host chooses exactly one
first-party reference policy and owns a boolean that selects:

- `off`: forward visible calls without adaptive acquisition;
- `auto`: let that one policy decide whether an exact default
  `browser_snapshot` needs one additional boxed snapshot.

`auto` does not choose a policy family. There is no auto-router, combined
policy pack, model-selected arm, fallback to the full BrowserIR graph, or
hidden action cascade. Policy selection is deployment configuration and must
not come from a model prompt or page content.

This package is private and is not available as a public npm product. It is a
library integration boundary, not a drop-in Playwright MCP server, MCP client
configuration extension, browser runtime, or hosted service.

## Closed-alpha integration

The caller creates and connects the official MCP `Client` before entering this
function. The example deliberately fixes the schedule policy in code. For a
cross-tree deployment, replace the schedule factory import and call with
`createCrossTreeLabelReferencePolicy`; do not select between them by inspecting
each page at runtime.

```ts
import type { Client } from '@modelcontextprotocol/client';
import {
  createAdaptivePlaywrightTools,
  type AdaptivePlaywrightTools,
} from '@browserir/playwright-mcp';
import {
  createScheduleCoordinateReferencePolicy,
} from '@browserir/playwright-mcp/reference-policies';

interface AlphaHostConfig {
  /** Host-owned startup flag. Only literal true enables enrichment. */
  readonly adaptivePlaywrightEnabled: boolean;
}

interface ToolConsumer<Result> {
  (tools: Pick<AdaptivePlaywrightTools, 'listTools' | 'callTool'>): Promise<Result>;
}

const alphaCounters = new Map<string, number>();

export async function withAdaptivePlaywright<Result>(
  client: Client,
  config: AlphaHostConfig,
  runHost: ToolConsumer<Result>,
): Promise<Result> {
  // Choose ONE family for this deployment, even while the flag is off.
  const policySet = createScheduleCoordinateReferencePolicy();
  const tools = createAdaptivePlaywrightTools(client, {
    mode: config.adaptivePlaywrightEnabled === true ? 'auto' : 'off',
    policySet,
    telemetry: {
      // Keep this synchronous. Aggregate only these bounded fields.
      onEvent(event) {
        const key = [
          event.mode,
          event.operation,
          event.outcome,
          String(event.hiddenCalls),
        ].join(':');
        alphaCounters.set(key, (alphaCounters.get(key) ?? 0) + 1);
      },
    },
  });

  try {
    // From this point, the host exposes and calls only these wrapped methods.
    // Never call client.listTools/client.callTool directly while tools is active.
    return await runHost({
      listTools: tools.listTools,
      callTool: tools.callTool,
    });
  } finally {
    try {
      // Stops admission and drains every accepted visible+hidden transaction.
      await tools.dispose();
    } finally {
      // dispose() never closes the caller-owned client or transport.
      await client.close();
    }
  }
}
```

The in-memory `alphaCounters` map is illustrative. A host may replace it with
an already approved metrics sink. Do not attach snapshot text, refs, labels,
URLs, arguments, prompts, boxes, or MCP payloads. If no telemetry is required,
omit the `telemetry` property completely.

A fail-closed environment mapping can be as small as:

```ts
const config = {
  adaptivePlaywrightEnabled:
    process.env['BROWSERIR_ADAPTIVE_PLAYWRIGHT_ALPHA'] === '1',
} satisfies AlphaHostConfig;
```

Any unset or unrecognized value remains off. The package does not read
environment variables or configuration files itself.

## Lifecycle and exclusivity

One raw client may have only one active adaptive wrapper in the loaded package
instance. While it is active:

1. Route every `listTools` and `callTool` through the wrapper.
2. Do not create a second wrapper for the same client.
3. Do not call the raw methods concurrently behind the wrapper; such calls
   cannot be detected or serialized by middleware.
4. Treat a visible call and its optional hidden acquisition as one serialized
   transaction.

The selected mode and policy are immutable for a wrapper. To change the
boolean or policy family, stop new host work, await `dispose()`, then either:

- create a new wrapper around the still-open client; or
- close the caller-owned client and create/connect a fresh client during the
  process restart.

Never overlap the old and new wrappers. `off` disables adaptive acquisition but
keeps the same serialization and client-lease boundary. It is therefore a
stable rollout control, not a claim of zero middleware overhead and not the
same runtime as bypassing the wrapper entirely.

## Feature and call-count boundary

| Host path | Model-visible call | Logical raw `client.callTool` calls | Adaptive output |
| --- | ---: | ---: | --- |
| `off` | 1 | 1 | Exact visible result |
| `auto`, non-snapshot or unsupported/sufficient family state | 1 | 1 | Exact visible result |
| `auto`, eligible acquisition and proven projection | 1 | 2 | Current box-free Playwright snapshot plus complete compact relations |
| `auto`, hidden failure/state mismatch/unresolved projection | 1 | 2 | Exact visible result |

The second logical call, when present, is exactly one hidden
`browser_snapshot({ boxes: true })`; this package does not retry it. SDK or
transport behavior may produce a different number of lower-level wire
attempts. “One model-visible call” holds only when the host exposes and budgets
the wrapper as the model-facing boundary.

Only an exact default `browser_snapshot` is eligible. Calls with targeted,
depth, filename, explicit `boxes`, or other snapshot arguments pass through
without hidden acquisition. The middleware does not hide screenshots, DOM
evaluation, navigation, clicks, fills, actions, files, retries, or multi-stage
cascades.

Visible request/options and raw results are forwarded with their normal MCP
semantics. A hidden call may receive only an already supplied safe `signal`
and the remaining `timeout`/`maxTotalTimeout` budget. It never inherits
progress callbacks, resumptions, transport controls, or a caller-provided tool
definition.

## Explicit policy scope

Choose one family because the integration already knows which page structure
it supports. Unsupported, ambiguous, incomplete, changed, or unprovable input
fails closed by returning the exact visible result.

| Factory | Closed-alpha scope | Current policy | Current evidence |
| --- | --- | --- | --- |
| `createScheduleCoordinateReferencePolicy()` | Bounded resource-by-time schedules matching the strict table/grid header and control shape | `schedule-coordinate-policy/3` | Current-source 64-arm zero-model preflight plus 2026-08-26 development A/B |
| `createCrossTreeLabelReferencePolicy()` | Exactly two unique labels and two controls in the strict region/form subtree shape | `cross-tree-label-policy/1` | Current-source 64-arm zero-model preflight plus 2026-08-26 development A/B |
| `createGridCoordinateReferencePolicy()` | Bounded row-by-column grids | `grid-coordinate-policy/1` | Experimental; no current retained live result qualifies it |

Schedule policy `/3` admits only a one-pixel serialized final-resource overhang
at the schedule root edge. A two-pixel overhang remains unresolved; overlap,
center, completeness, unique-ref, and unique-coordinate guards stay strict.

Do not enable or advertise the grid policy as live-qualified until a separate
retained live gate covers its exact release bytes. The schedule and cross-tree
results do not establish support for other schedule libraries, arbitrary grids,
virtualized/recycled rows, every website, or every ambiguous interface.

## Telemetry boundary

Telemetry is off by default. Each wrapped `callTool` may emit one frozen,
bounded event containing only:

- schema version;
- mode (`auto` or `off`);
- operation class (`snapshot` or `other`);
- bounded outcome;
- logical hidden-call count (`0` or `1`).

Telemetry does not contain page content or identify a task. It is suitable for
aggregate rollout counters, not billing reconciliation, wire-attempt counting,
performance claims, user analytics, or proof that a model succeeded.

## Evidence and claims boundary

Current `/3` source separately passed a 64-arm real-browser zero-model
preflight: 15/15 independently demonstrated recoverable relations were
projected, one Catalog layout safely fell back, and there were zero demonstrated
projection misses. The canonical real-model development run produced `auto`
31/32 versus `off` 24/32 and measured retries, physical calls, usage, cost, and
active task time. See the [complete result and
checksums](BROWSERIR_REAL_AGENT_RESULTS.md) instead of copying its tables here.

That result is descriptive evidence from a reused fixture corpus. It does not
authorize general uplift, compatibility, npm availability, automatic routing,
or unseen-site claims.
