# `@browserir/mcp` — legacy full-graph server

> **Status:** source-only legacy/experimental package. This nine-tool stdio
> server is a separate historical interface, not the current BrowserIR thin
> layer and not a fallback from it. For the current product path, use
> [`@browserir/playwright-mcp`](../playwright-mcp/README.md) with a
> caller-owned official Playwright MCP client.

Retained local stdio MCP server and embeddable APIs for the full-graph runtime,
using the official MCP TypeScript SDK and its Playwright backend.

This private package has not been published. Its contracts may change while the
legacy runtime remains in source.

## Planned package install

The following command applies only if publication of the full-graph packages
resumes; it does not work from the public registry today.

```sh
pnpm add @browserir/mcp "playwright@1.62.0"
pnpm exec playwright install chromium
```

The package is ESM-only and requires Node.js 22.13 or newer.
Playwright is listed explicitly so its browser-installation CLI is available
under strict package-manager layouts such as pnpm's.

## Legacy MCP configuration

```json
{
  "mcpServers": {
    "browserir": {
      "command": "pnpm",
      "args": [
        "--dir",
        "/absolute/path/to/your/project",
        "exec",
        "browserir-mcp"
      ]
    }
  }
}
```

Use the project that contains the local `@browserir/mcp` installation. Desktop
MCP clients commonly start outside that project, so a bare `browserir-mcp`
command is not reliably on their `PATH`. An absolute path to the project's
`node_modules/.bin/browserir-mcp` is an equivalent configuration.

The stock executable serves one local stdio connection and starts no HTTP
listener. Its default catalog contains exactly the nine typed BrowserIR tools;
arbitrary page-code evaluation is absent. Typed BrowserIR actions are the
intended legacy path.

Chromium is headless by default. To watch the same fixed-viewport browser while
developing or diagnosing an agent, pass `--headful` in the MCP configuration:

```json
{
  "mcpServers": {
    "browserir": {
      "command": "pnpm",
      "args": [
        "--dir",
        "/absolute/path/to/your/project",
        "exec",
        "browserir-mcp",
        "--headful"
      ]
    }
  }
}
```

Run `browserir-mcp --help` for the complete local CLI surface. Headful mode
does not reuse the user's normal browser profile or make page content trusted.

## Flat action and wait calls

`browser_act` uses one flat JSON object. Copy an entity ref from the compact
view without its display brackets: `[e15@r7]` becomes `e15@r7`.

```json
{
  "browser_id": "browser-1",
  "page_id": "page-1",
  "expected_revision": 7,
  "kind": "fill",
  "target_ref": "e15@r7",
  "value": "Ada"
}
```

Targeted actions use `target_ref`. `fill`, `type`, `select`, and `upload` add
`value`, `text`, `values`, and `artifact_ids` respectively. `press` requires
`keys` and may be targeted or page-scoped. `scroll` accepts optional
`target_ref`, `delta_x`, and `delta_y`. `drag` instead uses `source_ref` and
`destination_ref`, with optional `destination_page_id` for a cross-page
destination. Fields that do not belong to the selected `kind` are rejected.

`browser_wait` is flat as well:

```json
{
  "browser_id": "browser-1",
  "page_id": "page-1",
  "expected_revision": 7,
  "kind": "entity_state",
  "target_ref": "e15@r7",
  "state": "enabled",
  "timeout_ms": 5000
}
```

The other wait kinds are `revision_change`, `text` with `value`, and
`settled`. Nested `action` or `condition` objects, stringified JSON, bracketed
refs, stale revisions, and unrelated kind-specific fields fail validation
before browser dispatch.

## Experimental unsafe evaluation

`browser_evaluate_unsafe` is completely disabled and absent from tool discovery
by default. The stock CLI exposes this experimental tenth tool only with an
explicit startup flag:

```json
{
  "mcpServers": {
    "browserir-unsafe": {
      "command": "pnpm",
      "args": [
        "--dir",
        "/absolute/path/to/your/project",
        "exec",
        "browserir-mcp",
        "--enable-unsafe-evaluate"
      ]
    }
  }
}
```

This permits arbitrary JavaScript in the selected Chromium page's main/default
world. It can exfiltrate page or session data, make authenticated requests,
mutate browser storage and service workers, navigate, and open popups. Use it
only for a trusted client in a deliberately isolated browser/network boundary.
The DevTools path can bypass the page's script Content Security Policy for the
supplied expression; CSP does not contain this tool.

Each call requires an explicit `page_id` and current `expected_revision`.
Expression limits are 16,384 characters and 32 KiB UTF-8. Timeout is 2 seconds
by default with a 5-second hard cap. Bounded JSON output defaults to 8 KiB, has
a 64 KiB hard cap, and can be reduced further by `max_tokens`. Timeout,
cancellation, or an unacknowledged evaluation-command failure triggers CDP
execution termination. BrowserIR never retries. If termination and verified
target closure both fail, BrowserIR irreversibly invalidates the logical browser
and makes a bounded best-effort physical shutdown attempt. A usable browser gets
a full post-dispatch observation, revision advance, and invalidation of all
earlier entity references. Containment failure skips observation and invalidates
the browser immediately; failed post-evaluation verification does the same.

The CLI writes intent and completion audit metadata to stderr. The records
contain the source's SHA-256 digest and byte length, never source text or result
values. Returned values receive heuristic secret and URL redaction, which is
not general data-loss prevention.

For an embedded server, enabling MCP registration is intentionally not enough:
the host must also pass `unsafeEvaluate` to `createBrowserIrRuntimeService` with
a required redacted `audit` callback. Intent-audit failure blocks dispatch;
completion-audit failure after dispatch invalidates the browser. The MCP
server's `enableUnsafeEvaluate` flag is a separate required opt-in.

## Legacy security boundary

The executable's intended boundary is one local stdio connection. Do not expose the
embeddable handler as remote HTTP or share it between tenants without adding
authentication, authorization, tenant isolation, browser isolation, request
limits, audit, and network policy. HTTP/HTTPS URL validation is not an SSRF
defense: Chromium can reach networks available to the host. Page content is
untrusted and screenshots can contain credentials or customer data.

The stock service limits a connection to four concurrent browsers, rejects
oversized captures before base64 serialization, leaves arbitrary page-code
evaluation disabled by default, and closes owned browsers when the connection
ends. Those controls do not make browsing an untrusted site safe or authorize
consequential actions.
Embedders can lower the browser bound with the runtime service's
`maxBrowsersPerConnection` option.
