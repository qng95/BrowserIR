# BrowserIR thin-layer troubleshooting

This guide covers the `browserir@0.1.0` release candidate pending npm
naming/ownership and protected publication.
The package is host-side middleware around an already-connected official MCP
`Client`; it is not a drop-in MCP server, browser launcher, or hosted service.

## The package does not build or import

Use Node.js 22.13+ and the repository's pinned pnpm version, then build only the
thin-layer package:

```sh
npm install --global corepack@0.34.7
corepack enable
corepack install --global pnpm@10.30.3
pnpm install --frozen-lockfile
pnpm --filter browserir build
pnpm --filter browserir test
```

Import the wrapper from `browserir` and a concrete first-party policy from
`browserir/reference-policies`. Do not start
`packages/mcp-server/dist/cli.js`; that executable belongs to the separate
legacy full-graph runtime.

## A second wrapper is rejected

One raw client object may have only one active adaptive wrapper. Route every
`listTools` and `callTool` operation through that wrapper, stop admitting host
work, and await `tools.dispose()` before creating another wrapper for the same
client.

The caller owns the client and transport. `dispose()` drains accepted wrapper
work but does not close either one.

## `auto` never performs a hidden read

Only an exact default `browser_snapshot` request is eligible. Confirm that:

- mode is `auto`;
- the host supplied exactly one policy appropriate for that integration;
- the request has no explicit `boxes`, filename, depth, target, or other
  snapshot arguments;
- the visible result is successful and contains exactly one supported inline
  snapshot with a page URL; and
- the supplied timeout budget and abort signal still permit a second raw call.

Other tools and explicit snapshot variants intentionally pass through. `auto`
does not choose among policy families by reading the task prompt or page.

## `auto` returns the original Playwright result

That is the fail-closed behavior, not necessarily an error. The original
visible result is returned unchanged when semantics are already sufficient, a
policy is not applicable, the deadline is exhausted, the hidden call fails,
page state changes between reads, or the projector cannot prove a complete
mapping.

Enable bounded telemetry only while diagnosing. Its complete `outcome` set is
`disabled`, `not-applicable`, `passthrough`, `cancelled-before-hidden`,
`deadline-exhausted`, `hidden-failed`, `state-mismatch`,
`projection-unresolved`, `projected`, and `visible-failed`. Events contain no
page text, URLs, refs, labels, prompts, arguments, durations, or raw payloads.

## Refs changed after projection

That is expected. A successful projection uses refs from the fresh hidden
recapture, never refs from the earlier visible snapshot. The returned snapshot
contains those current refs, strips all box metadata, and appends a complete
`### Adaptive context` section. Dispatch later Playwright actions only with
refs from that returned result.

## A projection is missing or looks partial

The first-party policies are complete-or-none. Ambiguous geometry, duplicate
labels, missing boxes, unsupported structure, conflicting roots, or an
incomplete bijection must produce the original visible result rather than
partial facts. Reduce a suspected miss to a fixture and run:

```sh
pnpm --filter browserir test
```

The current real-agent evidence covers strict schedule-coordinate and
cross-tree-label families. A current-source, zero-model Inventory preflight
exercises the grid-coordinate mechanism through official Playwright MCP, but it
is not retained exact-release-byte or LLM accuracy qualification. None of these
policies is a general visual reasoner.

## The real-agent benchmark cannot read the OpenRouter key

The benchmark wrapper expects macOS Keychain account `BrowserIR` and service
`OPENROUTER_API_KEY`. Follow the exact setup and existence-only verification in
the [real-agent runbook](BROWSERIR_REAL_AGENT_AB_RUNBOOK.md); never paste the
secret into logs, documentation, or chat.

## The browser or MCP transport fails

Those resources belong to the caller's official Playwright MCP integration,
not this middleware. Diagnose connection, Chromium, profile, and transport
failures there. BrowserIR propagates a visible upstream throw and never retries
it internally.

For lifecycle and option-forwarding details, see the
[Playwright MCP integration guide](PLAYWRIGHT_MCP_INTEGRATION.md) and
[package guide](../packages/playwright-mcp/README.md).
