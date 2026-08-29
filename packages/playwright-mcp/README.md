# `browserir`

**Keep Playwright. Add the relationships enterprise UIs leave implicit.**

BrowserIR is a thin, in-process layer over an official Playwright MCP client.
It preserves the same tools, actions, refs, and lifecycle. When a snapshot
flattens a provable relationship—such as button → row × column or action →
queue—BrowserIR can append that complete mapping. When it cannot prove the
mapping, it returns Playwright's original result unchanged.

Once the package is present on npm:

```sh
npm install browserir
```

Version `0.1.0` is the prepared release candidate; npm publication and ownership
confirmation are still pending. It requires ESM, Node.js `>=22.13.0`, and
`@modelcontextprotocol/client@2.0.0`.

## Quick start

```ts
import { createAdaptivePlaywrightTools } from 'browserir';
import { createScheduleCoordinateReferencePolicy } from
  'browserir/reference-policies';

// `client` is your already-connected official MCP Client.
const tools = createAdaptivePlaywrightTools(client, {
  mode: 'auto',
  policySet: createScheduleCoordinateReferencePolicy(),
});

const catalog = await tools.listTools();
const snapshot = await tools.callTool({
  name: 'browser_snapshot',
  arguments: {},
});

// Route every call for this client through `tools` while the wrapper is active.
await tools.dispose();
```

Choose exactly one first-party policy for the page family your integration
supports:

- `createGridCoordinateReferencePolicy()`
- `createScheduleCoordinateReferencePolicy()`
- `createCrossTreeLabelReferencePolicy()`

`auto` controls whether the selected policy may enrich a snapshot. It does not
inspect prompts or route among policy families.

## What it changes

Only an exact default `browser_snapshot` call is eligible. The result has one
of three outcomes:

- **Already sufficient:** return the original Playwright result by identity.
- **Provable gap:** make one read-only boxed recapture, remove every box, and
  append one complete relation set using current Playwright refs.
- **Incomplete or changed evidence:** return the original result instead of
  guessing.

BrowserIR performs no hidden click, navigation, screenshot, page-code
evaluation, or internal retry. Telemetry is disabled unless the host opts in;
its fixed event schema contains no page text, URL, ref, prompt, argument, box,
or raw MCP payload.

## Ownership and lifecycle

The caller owns connection and shutdown of the supplied client. BrowserIR
never connects or closes it. While a wrapper is active, route every `listTools`
and `callTool` operation for that raw client through the wrapper. Direct calls
cannot be observed or serialized by middleware. A second wrapper for the same
client is rejected until the first wrapper's draining `dispose()` completes.

Hidden observation receives only an own-data abort signal plus the remaining
`timeout` and `maxTotalTimeout` budgets. It never inherits callbacks, transport
controls, resumptions, or caller-supplied tool definitions.

BrowserIR is not a sandbox, authorization layer, tenant boundary, SSRF defense,
or data-loss-prevention system. The host still owns browser isolation, network
policy, credentials, action authorization, logging, retention, and confirmation
for sensitive operations. Read the full [security
boundary](https://github.com/qng95/BrowserIR/blob/main/SECURITY.md).

## Evidence boundary

In the checked-in 32-task development A/B, the same Qwen3.8-27B agent reached
`31/32` pass@1 with BrowserIR `auto` versus `23/32` with enrichment `off`. On
the 16 tasks where Playwright already exposed the relationship through ARIA,
both modes passed `16/16`. This is favorable development evidence on synthetic
enterprise-style fixtures—not a general-web superiority claim.

A separate current-source, zero-model Inventory preflight exercises the grid,
schedule, and cross-tree mechanisms through official Playwright MCP. It is not
a retained exact-release-byte qualification, and it does not measure grid
accuracy with an LLM. The scored 32-task result covers only schedule and
cross-tree policies.

- [Method, metrics, receipts, and limitations](https://github.com/qng95/BrowserIR/blob/main/docs/BROWSERIR_REAL_AGENT_RESULTS.md)
- [Exact reproduction runbook](https://github.com/qng95/BrowserIR/blob/main/docs/BROWSERIR_REAL_AGENT_AB_RUNBOOK.md)
- [Architecture and fail-closed behavior](https://github.com/qng95/BrowserIR/blob/main/docs/ADAPTIVE_PLAYWRIGHT_ARCHITECTURE.md)

## License

Apache-2.0
