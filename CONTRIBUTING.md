# Contributing to BrowserIR

BrowserIR is an alpha project built around one rule: behavior starts with a failing test. Contributions should improve the model-facing representation or runtime without teaching it the quirks of one production site.

## Before contributing

BrowserIR is licensed under the [Apache License 2.0](LICENSE). Unless you
explicitly state otherwise, a contribution intentionally submitted for
inclusion in BrowserIR is provided under the same license, as described by
Section 5. Only submit work that you have the authority to contribute.

For security issues, follow [SECURITY.md](SECURITY.md) rather than opening a public issue.

## Development setup

Requirements:

- Node.js 22.13 or newer
- pnpm 10.30.3 through a current Corepack, or a compatible pnpm 10 installation
- Chromium installed by Playwright

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

The Corepack upgrade is required on the minimum Node.js 22.13 runtime: its
bundled Corepack predates npm's signing-key rotation. Version 0.34.7 has the
updated keys and remains compatible with Node.js 22.13. Do not bypass package
manager signature verification.

The main workspace packages are:

| Directory | Responsibility |
| --- | --- |
| `packages/browser-ir` | Browser-independent contracts, reconciliation, revisions, deltas, and view compilation. |
| `packages/playwright-driver` | Chromium observation, opaque target binding, typed browser actions, and screenshots. |
| `packages/mcp-server` | Local stdio MCP schemas and the thin application adapter. |
| `packages/fixture-app` | Deterministic ERP/DMS acceptance fixture and database-backed task oracles. |
| `packages/benchmark` | Representation metrics, statistics, reports, and regression gates. |

The vendored Browser-Use, Stagehand, Treegress, Playwright, and Playwright MCP trees are reference material only. They are excluded from this workspace and should not be modified as part of a BrowserIR change.

## Test-driven workflow

For every behavior change:

1. Add the smallest technology-neutral fixture that demonstrates the behavior.
2. Add a focused test against the public representation, MCP contract, or typed runtime boundary.
3. Run it and confirm it fails for the intended reason.
4. Implement the smallest general rule that makes it pass.
5. Add adversarial cases for false positives, ambiguity, stale state, and failure cleanup.
6. Run the focused test, the affected package suite, and workspace type checking.
7. Update public documentation when a schema, behavior, limit, or security boundary changes.

Do not weaken, skip, or delete a legitimate assertion to make a change green. Do not add fixture text, URLs, class names, or application-specific selectors to production inference rules.

Useful commands:

```sh
# All workspace tests and checks
pnpm test
pnpm typecheck
pnpm build

# One package
pnpm --filter @browserir/core test
pnpm --filter @browserir/playwright test
pnpm --filter @browserir/mcp test
pnpm --filter @think-dom/fixture-app test
pnpm --filter @browserir/benchmark test

# Package and public-release verification
pnpm verify:packages
pnpm verify:packed-consumer
pnpm verify:release

# One create-only release-evidence fragment
pnpm release:evidence workspace-verification \
  --output output/release-evidence/workspace-local-1 \
  --run-id workspace-local-1
```

`pnpm verify:packed-consumer` creates real tarballs, installs them in a clean
temporary project, type-checks all three public imports, and drives the installed
stdio executable with the official MCP client. It may download the Chromium build
selected by the packed Playwright dependency. `pnpm verify:release` is expected
to fail until the explicit publication blockers in
[docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) are resolved.

The release-evidence recorder retains structured JSON, JUnit where applicable,
gate reports, command logs, source hashes, and `SHA256SUMS`. Use a new output
directory for every attempt; the recorder will not overwrite prior evidence.
A locally passing fragment may still be marked dirty or source-unbound and is
therefore not a release qualification. The seven-gate CI matrix, nine required
runtime fragments, dossier assembler, and retention rules are documented in
[docs/RELEASE_EVIDENCE.md](docs/RELEASE_EVIDENCE.md).

## Representation principles

A contribution should preserve these invariants:

- The representation is simple, but not simpler than the next correct decision requires.
- The core remains browser-independent and model-independent.
- Playwright selectors, element handles, and source IDs never enter canonical IR or MCP schemas.
- Every actionable model reference is bound to a page revision.
- A stale or ambiguous target fails safely rather than being guessed.
- Direct observations and inferred meaning carry distinguishable evidence and confidence.
- Inference favors precision and explicit abstention over broad but unstable coverage.
- Off-DOM, inaccessible, or not-yet-loaded content is not presented as observed.
- View budgets cover the complete model payload and report omissions explicitly.
- Repeated identical observation is deterministic.
- A dispatched action is not called successful until its requested effect is observed.

## Choosing a fixture

Prefer small, independent fixtures that vary technology while preserving the same semantics. Good test matrices include:

- native HTML, explicit ARIA, roleless custom elements, and open Shadow DOM;
- separate label and control trees, repeated labels in named scopes, and ambiguous decoys;
- same-URL sibling frames and cross-document replacement;
- server-rendered forms, WebForms-style postbacks, AJAX replacement, and client-side rerenders;
- delayed, portal-mounted, virtualized, transient, occluded, and initially absent controls.

Tests should grade the BrowserIR output or a real application side effect, not implementation details. When a task mutates the fixture application, verify database state and the audit log so seeded state cannot create a false pass.

## Package boundaries

Keep dependencies flowing toward the core port:

```text
MCP server -> BrowserIR core <- Playwright driver
```

Changes to MCP input must be represented by a strict schema and matching TypeScript type. Changes to public packages must keep ESM output and declarations in `dist`, because release packages allowlist that directory only.

Do not add arbitrary page evaluation as a shortcut for missing representation. If a genuinely necessary escape hatch is proposed, it must remain explicit, opt-in, bounded, disabled by default, and covered by a security review.

## Pull request checklist

Before requesting review, confirm:

- [ ] The issue and intended public behavior are described.
- [ ] A focused test was observed failing before implementation.
- [ ] Adversarial and failure behavior is covered.
- [ ] No site-specific production heuristic was introduced.
- [ ] `pnpm typecheck` passes.
- [ ] The affected package tests pass.
- [ ] `pnpm build` passes when public output changed.
- [ ] Public schemas, docs, changelog, and benchmark expectations are updated where applicable.
- [ ] New dependencies are necessary, pinned appropriately, and reviewed for license and security impact.
- [ ] No credentials, cookies, customer data, captures, local outputs, or auth profiles are included.

Keep changes focused. Separate representation behavior, protocol changes, benchmark methodology, and unrelated cleanup when they can be reviewed independently.
