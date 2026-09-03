# Security policy

## Supported status

BrowserIR's current product path is the `browserir-mcp` `0.1` release line. Until
the first npm release is registry-confirmed, security fixes are made on the
latest source only; there is no released support window or response-time SLA.

The older `@browserir/core`, `@browserir/playwright`, and `@browserir/mcp`
full-graph runtime remains in the repository as legacy/experimental code. It is
not the supported boundary described below.

## Current boundary

The thin layer is an in-process wrapper around an already-connected official
MCP `Client`. It wraps only `listTools` and `callTool`:

- the caller owns the MCP transport, server, browser, authentication, network
  policy, tool authorization, and shutdown;
- BrowserIR does not start or close a client, server, browser, or page;
- `listTools` is forwarded from the caller's client; BrowserIR does not certify
  or restrict that catalog; and
- the wrapper is not a sandbox, authorization layer, tenant boundary, SSRF
  defense, or data-loss-prevention system.

Use one wrapper per raw client and route all `listTools` and `callTool`
operations through it until `dispose()` finishes. Direct calls on the raw
client bypass the wrapper's serialization and cannot be detected by BrowserIR.

## Hidden observation boundary

Only an exact default `browser_snapshot` request is eligible for adaptation.
For an eligible call, a first-party, host-selected policy may request at most
one additional logical read:

```json
{ "name": "browser_snapshot", "arguments": { "boxes": true } }
```

The package performs no hidden action, navigation, page-code evaluation,
screenshot, or internal retry. The hidden call receives only the remaining
timeout budget and caller abort signal supported by the wrapper; unrelated
callbacks and transport controls are not copied.

A projection is returned only when the visible and hidden snapshots represent
the same state and the policy proves a complete relationship set using current
Playwright refs. Raw box metadata is stripped from the returned snapshot. An
oversized or malformed snapshot, hidden-read failure, cancellation, deadline,
state mismatch, ambiguous evidence, or incomplete projection returns the exact
original visible result object.

This fail-closed behavior prevents BrowserIR from inventing a partial relation.
It does not make the underlying page, Playwright server, or caller trustworthy.

## Page data and telemetry

Visible and hidden snapshots are untrusted page-derived data. They can contain
personal data, credentials, business records, or prompt-injection text. The
wrapper processes snapshots in the host process and does not persist them, but
the caller's MCP client, server, model adapter, logs, or telemetry may do so.
Protect that surrounding system accordingly.

Telemetry is disabled unless the host supplies a callback. Each event contains
exactly `schemaVersion`, `mode`, `operation`, `outcome`, and `hiddenCalls`. It
contains no page text, URLs, refs, labels, prompts, arguments, boxes, durations,
or raw MCP payloads. The callback itself is caller code and remains inside the
caller's trust boundary.

## Page trust and agent authorization

Treat all page content as untrusted, including text that looks like an
instruction to the agent. A projected relationship says only that the bounded
structural evidence supported that relation; it does not certify that page
content is truthful, that a requested action is authorized, or that a target is
safe.

The host agent must keep system policy, user intent, and page content in
separate trust domains. Require confirmation for sensitive or irreversible
actions and never grant privileges merely because a page asks for them.

## Caller responsibilities

The caller and its official Playwright MCP deployment remain responsible for:

- navigation allowlists, redirect checks, DNS rebinding defenses, and browser
  network isolation;
- authentication profiles, cookies, credentials, uploads, downloads, and
  screenshot retention;
- authorization and confirmation for browser actions;
- model transcripts, MCP logs, observability, retention, and redaction;
- browser, process, container, and tenant isolation; and
- rate, concurrency, memory, and availability limits around the wrapper.

BrowserIR does not redact arbitrary secrets from Playwright snapshots and does
not inspect or restrict non-snapshot tool calls. Review the official MCP server
and client configuration as part of the same threat model.

## Benchmark fixtures

Repository fixtures are disposable test infrastructure, not example production
applications. They may use synthetic credentials, loopback services, reset
endpoints, and hidden grading oracles. Do not expose them to untrusted networks
or place production data in them. The real-agent benchmark instructions are in
[the runbook](docs/BROWSERIR_REAL_AGENT_AB_RUNBOOK.md).

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository
host's private vulnerability-reporting feature when available, or the same
private channel from which you obtained the source.

Include the affected commit or package version, impact, realistic attack
scenario, minimal reproduction, and whether the issue is in the thin
middleware or the caller-owned MCP deployment. Do not include real credentials,
customer data, cookies, or sensitive screenshots in the initial report.
