# Contributing to BrowserIR

BrowserIR's current product is a thin deterministic relationship layer over
official Playwright MCP. Contributions should preserve Playwright's public
tools, refs, actions, and lifecycle while improving only relationships that can
be proved from bounded observation evidence.

## Before contributing

BrowserIR is licensed under the [Apache License 2.0](LICENSE). Unless you state
otherwise, a contribution intentionally submitted for inclusion is provided
under the same license as described by Section 5. Submit only work you have the
authority to contribute.

Report security issues through [SECURITY.md](SECURITY.md), not a public issue.

## Development setup

Requirements:

- Node.js 22.13 or newer;
- pnpm 10.30.3 through a current Corepack, or a compatible pnpm 10 install; and
- Chromium installed by Playwright for browser-backed integration tests and
  benchmarks.

```sh
npm install --global corepack@0.34.7
corepack enable
corepack install --global pnpm@10.30.3
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build
pnpm typecheck
pnpm test
```

The Corepack upgrade is required on the minimum Node.js 22.13 runtime because
its bundled Corepack predates npm's signing-key rotation. Do not bypass package
manager signature verification.

## Workspace map

| Directory | Status and responsibility |
| --- | --- |
| `packages/playwright-mcp` | **Current product:** the `browserir` adaptive middleware and first-party reference policies. |
| `packages/benchmark` | Current and historical measurement runners, exact oracles, reports, and evidence tooling. |
| `packages/fixture-app` | Deterministic test fixtures and database-backed task oracles. |
| `packages/browser-ir` | Legacy/experimental full-graph core retained in source. |
| `packages/playwright-driver` | Legacy/experimental full-graph Chromium driver retained in source. |
| `packages/mcp-server` | Legacy/experimental full-graph stdio MCP server retained in source. |

The vendored Browser-Use, Stagehand, Treegress, Playwright, and Playwright MCP
trees are reference material only. They are excluded from the workspace and
should not be modified as part of a BrowserIR change.

## Thin-layer invariants

A change to `browserir` must preserve these properties:

- only an exact default `browser_snapshot` request is eligible;
- sufficient, unsupported, failed, cancelled, changed-state, and unresolved
  paths return the exact original visible result object;
- one eligible call may perform at most one hidden boxed snapshot and never a
  hidden action, retry, evaluation, navigation, or screenshot;
- the host selects one fixed, task-independent first-party policy family;
  policies do not read the agent prompt, expected answer, or grading oracle;
- successful projection uses only refs from the fresh hidden recapture, strips
  all boxes, and emits a complete relationship set or nothing;
- policy evaluation is synchronous, bounded, and cannot re-enter the wrapper;
- telemetry is opt-in, content-free, and limited to its five-field schema;
- one raw client has at most one active wrapper; `dispose()` drains accepted
  work and never closes the caller-owned client; and
- non-eligible tool calls and `listTools` preserve the caller's official MCP
  surface rather than substituting a BrowserIR tool catalog.

Do not add fixture text, URLs, class names, application-specific selectors, or
model-specific prompt tricks to a production policy.

## Test-driven workflow

For every behavior change:

1. Add the smallest fixture that demonstrates the missing relation or unsafe
   projection.
2. Add a focused test and observe it fail for the intended reason.
3. Implement the smallest general, task-independent rule that makes it pass.
4. Add matched negatives for ambiguity, incompleteness, stale or duplicate
   refs, state drift, malformed input, and hidden-call failure as applicable.
5. Assert exact pass-through identity, logical hidden-call count, current refs,
   complete-or-none output, and absence of raw geometry.
6. Run the focused suite, package typecheck/build, and any affected benchmark
   preflight.
7. Update public docs when behavior, limits, evidence, or security boundaries
   change.

Do not weaken, skip, or delete a legitimate assertion merely to make a change
green.

Useful current-path commands:

```sh
pnpm --filter browserir typecheck
pnpm --filter browserir build
pnpm --filter browserir test
pnpm --filter browserir exec vitest run tests/reference-policies.test.ts
```

Run the full workspace checks when shared fixtures, benchmark contracts, or
legacy packages are affected:

```sh
pnpm typecheck
pnpm build
pnpm test
```

## Choosing a fixture

Prefer small cases that isolate one semantic question. The current policy test
matrix should include:

- a semantic-sufficient snapshot that must pass through unchanged;
- positive schedule-coordinate, cross-tree-label, or grid-coordinate evidence;
- overlapping, ambiguous, incomplete, out-of-bound, and duplicate structures;
- stale, missing, or duplicate actionable refs;
- visible/hidden state mismatch and parser drift;
- oversized snapshots, cancellation, deadlines, and hidden-call failure; and
- a real-browser task graded by an exact external oracle when agent behavior is
  part of the claim.

Tests should grade the returned Playwright result or real application side
effect, not implementation details. Mutating tasks must verify seeded database
state and the audit log so already-true state cannot create a false pass.

## Package boundary

The current runtime dependency direction is intentionally narrow:

```text
host agent -> browserir -> caller-owned official MCP Client
```

The fixture and benchmark packages measure that path but are not runtime
dependencies. The older full-graph dependency direction is documented only in
[the legacy architecture](docs/ARCHITECTURE.md).

## Legacy full-graph maintenance

Changes specifically targeting the retained full-graph packages may use their
package suites and release-evidence tooling:

```sh
pnpm --filter @browserir/core test
pnpm --filter @browserir/playwright test
pnpm --filter @browserir/mcp test
pnpm verify:packages
pnpm verify:packed-consumer
```

That unpublished three-package release path is archived, not the release path
for the thin layer. Its test-coupled records remain in the [legacy release
checklist](docs/RELEASE_CHECKLIST.md) and [release-evidence
documentation](docs/RELEASE_EVIDENCE.md).

## Pull request checklist

Before requesting review, confirm:

- [ ] The issue and intended public behavior are described.
- [ ] A focused test failed before the implementation change.
- [ ] Positive, ambiguity, and failure behavior are covered.
- [ ] No site-, fixture-, prompt-, oracle-, or model-specific heuristic was introduced.
- [ ] Pass-through identity and hidden-call accounting remain exact.
- [ ] Successful projections use current refs, contain no boxes, and are complete.
- [ ] The affected package tests and typecheck pass.
- [ ] `pnpm build` passes when public output changed.
- [ ] Docs, changelog, evidence boundaries, and benchmark expectations are updated where applicable.
- [ ] New dependencies are necessary and reviewed for license and security impact.
- [ ] No credentials, cookies, customer data, captures, local outputs, or auth profiles are included.

Keep changes focused. Separate policy behavior, measurement methodology, legacy
maintenance, and unrelated cleanup when they can be reviewed independently.
