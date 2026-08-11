# BrowserIR troubleshooting

This guide covers the supported local stdio alpha. BrowserIR does not currently
support a hosted or multi-tenant deployment.

## The MCP server does not start

Build the workspace first, then start the compiled executable with an absolute
path:

```sh
pnpm install --frozen-lockfile
pnpm build
node /absolute/path/to/BrowserIR/packages/mcp-server/dist/cli.js
```

Use Node.js 22.13 or newer. Keep stdout reserved for MCP messages; diagnostics
belong on stderr. Run the executable with `--help` or `--version` outside an MCP
connection to verify that the expected build is being used.

## Chromium is missing

Install the browser version owned by the pinned Playwright dependency:

```sh
pnpm exec playwright install chromium
```

If a clean consumer installation uses strict dependency layouts, install the
documented exact Playwright version in that consumer project before running the
browser installation command.

## No browser window appears

Headless mode is the default. Add `--headful` to the MCP executable arguments to
watch the same isolated fixed-viewport session. BrowserIR never attaches to the
user's normal Chrome profile.

## An action reports a stale revision or target

The page changed after the reference was produced. Call `browser_observe`, use
the returned current revision and entity references, then decide whether the
action is still appropriate. Do not retry a mutating action automatically when
the earlier result says it may already have dispatched.

## A visible control is missing

First inspect the compact view's omissions. Exact counts mean BrowserIR knew how
many candidates were dropped; an `at least` count means a bounded raw scan ended
before the unseen cardinality was knowable. Then check whether the control is:

- covered, outside the viewport, hidden, inert, or disabled;
- inside a closed shadow root, inaccessible cross-origin document, canvas, or
  WebGL surface;
- an unannotated custom control with no portable semantic or interaction
  evidence; or
- off-DOM data in a virtualized collection.

Use a targeted `browser_inspect` request when the entity exists but the compact
view omitted detail. A screenshot can help diagnose visual state, but screenshot
content remains untrusted and potentially sensitive.

## Capture is rejected

`stale_revision` means the request began from an old view.
`capture_invalidated` means represented state changed while pixels were being
captured. `capture_verification_failed` means BrowserIR could not prove the
post-capture state. Observe and retry only if another capture is still needed.
`capture_invalid` means an embedding driver returned inconsistent identity,
bytes, or geometry and should be treated as a driver defect.
`capture_too_large` means the image exceeded 8,294,400 physical pixels or 16 MiB
of encoded PNG data; use the fixed profile or an entity crop within those
bounds.

## The browser exits when the MCP client disconnects

That is expected. The stdio connection owns its browser sessions and closes
them on EOF, SIGINT, SIGTERM, or explicit close. If shutdown reports a cleanup
failure, preserve stderr and the exact Node/Playwright/Chromium versions for a
bug report rather than leaving the process running indefinitely.

## A local browser test cannot bind a server or launch Chromium

Some sandboxes prohibit loopback listeners, shared memory, or browser process
creation. Run the test in a development/CI environment that permits a
loopback-only fixture and sandboxed Chromium. Do not weaken the fixture to bind
all network interfaces.

## Package or release verification fails

`pnpm verify:packages` checks built file allowlists and package contracts.
`pnpm verify:packed-consumer` installs and drives real tarballs in a clean
consumer. `pnpm verify:release` additionally requires the maintainer-selected
license, public package settings, and consistent
release identity. Those legal and ownership failures are intentional until the
maintainer resolves them; do not bypass the verifier.
