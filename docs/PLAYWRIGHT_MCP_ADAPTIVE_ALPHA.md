# Playwright MCP adaptive closed alpha

Status: private, host-integrator closed alpha

Evidence boundary: historical packed `/2` qualification plus current `/3`
zero-model and real-agent development evidence

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
definition. Qualification `-006` exercised snapshot calls without options; it
did not live-attest signal forwarding.

## Explicit policy scope

Choose one family because the integration already knows which page structure
it supports. Unsupported, ambiguous, incomplete, changed, or unprovable input
fails open to the exact visible result.

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

## Historical exact `-006` compatibility record

The retained `browserir-packed-product-qualification-m2-20260824-006` result
qualifies one exact local Darwin mechanism run of the earlier schedule policy
`/2`, not current `/3` source and not a general support range:

| Component | Exact retained value |
| --- | --- |
| `@browserir/playwright-mcp` | Private `0.1.0` packed tarball |
| Node.js | `v22.19.0` |
| npm | `10.9.3` |
| pnpm | `10.30.3` |
| TypeScript used for build | `5.9.3` |
| `@modelcontextprotocol/client` | `2.0.0` |
| `@playwright/mcp` | `0.0.78` |
| `playwright` / `playwright-core` | `1.62.0-alpha-1783623505000` |
| Browser | Chromium `151.0.7922.34` |
| OS confinement | Darwin sandbox, loopback-only for the qualification process tree |

The package manifest declares Node.js `>=22.13.0`, but historical `-006` alone does not
qualify Node 24, Linux, Windows, another Playwright MCP snapshot format, or a
future server/client version. Parser drift safely passes through the visible
result; that fail-open behavior is not evidence of feature compatibility.
Darwin network confinement describes the qualification harness only. The
package does not sandbox the caller, browser, MCP server, or network.

The VM harness used `--experimental-vm-modules` to load verified packed bytes;
normal ESM consumers do not inherit that as a product runtime requirement.

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

Historical qualification `-006` retained 16 score-excluded `/2` cells: 8 schedule and 8
cross-tree cells, with 8 semantic passthroughs and 8 geometry escalations. It
recorded `score: null`, `modelCalls: 0`, `publicationEligible: false`,
`advertisingAuthority: false`, `upliftQualified: false`,
`autoRouterQualified: false`, and `gridLiveQualified: false`.

It is mechanism evidence for those exact packed bytes and frozen fixtures. It
does not authorize a public npm release or claims that BrowserIR is better,
more successful, faster, cheaper, more token-efficient, broadly compatible, or
proven with an LLM. Do not turn the 16 deterministic host-oracle outcomes into
a model-performance percentage or relabel them as `/3`.

Current `/3` source separately passed a 64-arm real-browser zero-model
preflight: 15/15 independently demonstrated recoverable relations were
projected, one Catalog layout safely fell back, and there were zero demonstrated
projection misses. A paid development run then used only
`qwen/qwen3.8-27b`, OpenRouter `alibaba`, and `max_retry=2`. `auto` solved 31/32
tasks and `off` solved 24/32; the paired table was 7 `auto`-only, 0 `off`-only,
24 both, and 1 neither. Pass@1 was 31/32 versus 23/32; pass@2 and pass@3 were
31/32 versus 24/32. The 83 calls used 144,103 tokens and cost $0.08594248;
`auto` cost $0.03137911, or $0.00101222935 per success.

The receipt's active task time starts before fresh-arm setup and ends at the
exact-oracle terminal while excluding opposite-arm scheduling. Per-arm
success-conditioned medians were 4,930 ms for `auto` (`n=31`) and 5,118 ms for
`off` (`n=24`), so they are not directly comparable without survivor bias. On
the primary 24-task common-success set, `auto` was faster on 17 tasks and `off`
on 7; mean `auto - off` time was −1,088.71 ms.

Those numbers are published as descriptive development evidence. The corpus
was reused after the prior `/2` round was inspected, and the receipt does not
serialize policy `/3` or a product-source hash. They do not authorize general
uplift, speed, cost, compatibility, npm, or advertising claims. See the
[complete result and checksums](BROWSERIR_REAL_AGENT_RESULTS.md).

## Safe closed-alpha announcement

The following factual copy is intentionally limited to a private alpha or
waitlist and still requires the normal product, security, and legal review:

> BrowserIR Adaptive is a private closed alpha for teams that already own an
> official Playwright MCP client integration. A host-controlled toggle can add
> box-free structural relations to exact default snapshots for selected
> schedule or cross-tree layouts, or return the original Playwright result when
> the relation cannot be proven. Policy selection is explicit; there is no
> automatic page-family router.

Do not replace “private closed alpha” with an npm-install or general-availability
claim until a separate public-release candidate passes its release gates. Do
not add unqualified comparative, uplift, speed, cost, coverage, grid-live, or
autonomous-routing language. The development comparison may be quoted only
with its 32-task scope, model, retry cap, and nonconfirmatory provenance caveat
from the retained result page.
