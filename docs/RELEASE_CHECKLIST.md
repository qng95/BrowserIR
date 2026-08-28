# Legacy full-graph BrowserIR 0.1 release checklist

Status: archived and blocked. The three-package full-graph runtime has not been
published, and this is not the release path for the
`browserir` thin layer. Its current path is the separate
[BrowserIR npm release guide](BROWSERIR_NPM_RELEASE.md).

This checklist remains because release-verification code and tests consume its
three-package artifact contract. It must not be read as current product
availability or as authorization to publish the thin layer.

This checklist distinguishes source readiness from an actual public release. A
green build is not permission to publish, and creating documentation does not
resolve package ownership or publication decisions.

Checklist items below remain unchecked until they are repeated or confirmed
against a selected clean legacy release commit. The machine-readable gate
matrix, source-binding rules, and dossier format are defined in the
[legacy release-evidence guide](RELEASE_EVIDENCE.md).

## Release identity blockers

Apache-2.0 licensing and canonical GitHub metadata are resolved. The remaining
publication decisions require maintainer authority:

- [x] **Choose Apache-2.0 and add identical root and public-package `LICENSE` files.**
- [x] **Add the `Apache-2.0` SPDX identifier to every workspace package manifest.**
- [ ] **Confirm ownership and publishing rights for the npm scope and names `@browserir/core`, `@browserir/playwright`, and `@browserir/mcp`.** Namespace availability is not ownership.
- [x] **Choose `github.com/qng95/BrowserIR` and add consistent repository, homepage, and issue metadata to all public package manifests.**
- [ ] Set `publishConfig.access` to `public` in all three scoped public package manifests.
- [ ] Remove `private: true` from the three public package manifests only after npm ownership is confirmed.
- [ ] Decide whether `0.1.0` should be published under npm tag `alpha` or whether manifests should use an explicit prerelease version such as `0.1.0-alpha.1`. Do not change version semantics after artifacts are published.
- [ ] **Perform the actual npm publication.** This is intentionally unresolved and requires an explicit maintainer decision after every prior gate passes.

The fixture and benchmark packages remain private development packages.
`browserir` is excluded from this legacy checklist; the current
development benchmark does not replace its separate npm release gates.

## Public scope confirmation

- [ ] Confirm the public 0.1 deployment scope is the local stdio MCP executable only.
- [ ] Confirm there is no remote HTTP, hosted, multi-tenant, or authentication security claim.
- [ ] Confirm Chromium is the only supported browser backend.
- [ ] Confirm arbitrary page-code execution is absent from the default
  nine-tool catalog and appears only after the explicit
  `--enable-unsafe-evaluate` startup flag.
- [ ] Confirm the README labels 0.1 as alpha, labels the thin-layer A/B as
  unsealed development evidence, and makes no general competitor-superiority
  claim.
- [ ] Review the supported and unsupported feature lists against the release commit.
- [x] Remove unsupported URL and hidden-text wait variants from the public schema so advertised inputs match runtime behavior.

## Clean, reproducible source

- [ ] Select the exact release commit and record its hash.
- [ ] Confirm the release worktree contains no credentials, cookies, auth profiles, customer data, local screenshots, benchmark outputs, or generated archives.
- [ ] Confirm local `output/`, `.claude/`, build output, and dependency directories are ignored.
- [ ] If a development benchmark is published from an otherwise ignored output
  directory, review and stage only the named receipt/journal/analysis files,
  verify their SHA-256 values, scan them for credentials and sensitive page
  payloads, and keep them outside the release-evidence dossier.
- [ ] Install from the lockfile in a clean checkout:

```sh
npm install --global corepack@0.34.7
corepack enable
corepack install --global pnpm@10.30.3
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

The Corepack pin is the newest reviewed line compatible with Node.js 22.13 at
the time of this checklist. The Corepack bundled with that minimum Node release
predates npm's signing-key rotation; never disable signature verification to
work around it.

- [ ] Record Node.js, pnpm, Playwright, and Chromium versions used for qualification.
- [ ] Record the exact GitHub Actions runner image version used by the pinned `ubuntu-24.04` jobs.
- [ ] Re-review the pinned Corepack bootstrap version for Node.js 22.13 compatibility and current npm signing keys.
- [ ] Run the retained production dependency audit with
  `pnpm release:evidence production-audit`; require classification `passed`,
  zero vulnerabilities, and zero muted advisories.
- [ ] Perform a separate dependency-license review using the maintainer's
  approved tooling and record accepted exceptions. The vulnerability evidence
  gate does not make a dependency-license decision.

## Build and test gates

Run from the workspace root:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm verify:packages
pnpm verify:packed-consumer
```

- [ ] `pnpm build` succeeds from a clean checkout.
- [ ] `pnpm typecheck` succeeds for every workspace package.
- [ ] `pnpm test` succeeds without retries or skipped release-critical tests.
- [ ] Browser-backed tests run with the release Chromium version.
- [ ] `pnpm verify:packages` confirms every public package matches the selected workspace version, Node `>=22.13.0`, ESM declarations, the stdio executable, and `dist`-only package allowlists.
- [ ] `pnpm verify:packed-consumer` succeeds from clean temporary installs on exact Node.js 22.13.0 and the qualified Node.js 24 release.
- [ ] Public tarballs contain package-local READMEs, contain no source maps, and match the verifier's exact file allowlists.
- [ ] Review any timing-sensitive test variance rather than rerunning until green.

Run the public-release verifier:

```sh
pnpm verify:legacy-release
```

- [ ] `pnpm verify:legacy-release` succeeds. It is expected to fail while the intentional package privacy blockers remain.
- [ ] Keep `pnpm verify:legacy-release` out of automatic CI until those intentional legal and ownership blockers are resolved; run it explicitly for a legacy release candidate.

## MCP contract gates

- [ ] Connect with the official MCP client over stdio using protocol version `2026-07-28`.
- [ ] Confirm tool discovery contains exactly the intended stock tools: create, navigate, observe, inspect, act, wait, pages, capture, and close.
- [ ] Confirm `browser_evaluate_unsafe` is absent from stock tool discovery.
- [ ] In a separate opt-in test process, confirm
  `--enable-unsafe-evaluate` adds only `browser_evaluate_unsafe`; do not use
  that process for the stock qualification or benchmark runs.
- [ ] Confirm an embedded server cannot register unsafe evaluation unless the
  runtime service has `unsafeEvaluate` with a required redacted audit callback
  and the MCP server has its separate enable flag.
- [ ] Confirm unsafe evaluation requires a selected `page_id` and current
  revision; enforces the 16,384-character/32-KiB source, 2-second default and
  5-second maximum timeout, and 8-KiB default/64-KiB maximum JSON-output bounds;
  and reduces output further when required by `max_tokens`.
- [ ] Confirm timeout, cancellation, and unacknowledged evaluation-command
  failures enter bounded containment: terminate execution, verify target closure,
  then irreversibly invalidate the logical browser if neither is confirmed.
  Confirm results use the bounded JSON serializer and evaluation is never retried.
- [ ] Confirm every dispatched evaluation whose browser remains usable forces a
  full observation, advances the revision, and invalidates all prior refs even
  when the graph appears unchanged. Confirm containment failure skips observation
  and immediately invalidates the browser; post-observation failure also
  invalidates it.
- [ ] Confirm intent-audit failure blocks dispatch, completion-audit failure
  after dispatch invalidates the browser, and audit records include only a
  SHA-256 source digest and source byte length rather than source or result.
- [ ] Confirm returned-value secret/URL redaction is treated and tested as a
  heuristic minimization layer, not a DLP claim.
- [ ] Complete create, navigate, observe, typed action, inspect, capture, and close through the packaged `dist/cli.js`, not a source-only test adapter.
- [ ] Confirm EOF, SIGINT, SIGTERM, and explicit close dispose all browser sessions.
- [ ] Confirm stdout contains MCP frames only and diagnostics use stderr.
- [ ] Confirm legacy protocol requests are rejected.
- [ ] Confirm stale revision and stale entity references fail without acting on a replacement node.
- [ ] Confirm action receipts distinguish blocked, verified, and dispatched-but-unverified outcomes.
- [ ] Confirm the complete tool result, including structured content and omissions, respects the documented budget behavior.
- [ ] Confirm one connection cannot exceed four owned or in-flight browsers and
  closing a browser releases the reservation.

## Browser and representation gates

- [ ] Verify the default 1440 x 900, scale-1, light, reduced-motion profile remains fixed for a session.
- [ ] Verify viewport and entity captures include the expected revision and geometry metadata.
- [ ] Verify browser profiles and captures above 8,294,400 physical pixels are
  rejected, and encoded images above 16 MiB never reach MCP base64 serialization.
- [ ] Verify the maintained driver closes popups beyond 32 tracked pages and
  reports analysis omissions beyond 64 documents per observation.
- [ ] Run native, ARIA, roleless custom, open Shadow DOM, frame, popup, portal, delayed option, WebForms postback, occlusion, validation, transient state, and semantic-label regressions.
- [ ] Confirm ambiguous inference abstains and hidden or decorative decoys are not promoted.
- [ ] Confirm repeated observation is deterministic and stable logical entities preserve IDs across supported rerenders.
- [ ] Confirm document replacement advances revision even when URL and visible state are unchanged.
- [ ] Confirm no selector, XPath, Playwright locator, source node ID, or opaque driver target leaks through the public view or MCP result.
- [ ] Review every bounded scan and collection cap; verify truncation or omission is explicit where implemented and listed as a limitation where it is not.

## Benchmark gates

- [ ] Run the built-in observation profile with `pnpm benchmark`; archive `environment.json`, `summary.json`, `samples.ndjson`, and `summary.md` without overwriting prior runs.
- [ ] Follow the isolation protocol in [BENCHMARK.md](BENCHMARK.md): one fresh database, browser session, and agent context per task attempt.
- [ ] Confirm all 14 task oracles fail on the untouched default seed.
- [ ] Confirm oracle results read database and audit state rather than trusting the page or agent report.
- [ ] Run `pnpm test:qualification -- --run-id <candidate>` and archive its create-only JSON and Markdown reports; require all 14 official-MCP-client task outcomes to pass.
- [ ] Run `pnpm benchmark:representation -- --run-id <candidate>` and archive its JSON, NDJSON, Markdown, JUnit, and exact-payload artifacts.
- [ ] Apply `evaluateRepresentationReleaseGate` without deleting unsupported or failing cases; archive every raw fact and gate failure.
- [ ] Run latency scenarios with declared warmups and samples; archive raw samples, p50, p95, median absolute deviation, and seeded confidence intervals.
- [ ] Compare performance only when schema versions and environment fingerprints match.
- [ ] Archive task outcomes, failures, not-applicable results, prompts, tool schemas, budgets, model version, tokenizer, environment metadata, and the harness commit.
- [ ] If no full baseline is complete, state that fact in release notes. Do not substitute unit-test counts for benchmark results.
- [ ] Do not publish a competitor comparison until the same prompts, model, browser profile, budgets, oracle, retries, and disclosure rules have been applied to every system.
- [ ] Confirm qualification and benchmark metadata record unsafe evaluation as
  disabled and the measured tool catalog remains the default nine tools.

## Documentation and security review

- [ ] Review `README.md` examples against the packaged CLI and current strict schemas.
- [ ] Review `SECURITY.md` against the actual transport and runtime boundary.
- [ ] Confirm sensitive-field and sensitive-URL redaction tests pass while the
  documentation still treats screenshots and unrecognized page content as sensitive.
- [ ] Confirm the stock Playwright context rejects automatic downloads.
- [ ] Configure the repository host's private vulnerability-reporting feature before directing the public to it.
- [x] Review `CONTRIBUTING.md` after license selection and state that submitted contributions use Apache-2.0 unless explicitly stated otherwise.
- [ ] Update `CHANGELOG.md` with the final version, release date, and any changes made during qualification.
- [ ] Confirm every relative documentation link resolves in the chosen repository layout.
- [ ] Exercise the source-install and common-failure paths in
  [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
- [ ] Confirm no document promises remote HTTP safety, managed downloads,
  persisted auth profiles, safe or default-enabled arbitrary evaluation,
  Firefox, WebKit, or complete modern-UI coverage.

## Package artifact inspection

The verifier creates and inspects real tarballs without running package lifecycle
scripts:

```sh
pnpm verify:packages
```

For an optional human-readable dry run of each public package:

```sh
cd packages/browser-ir && pnpm pack --dry-run --json
cd ../playwright-driver && pnpm pack --dry-run --json
cd ../mcp-server && pnpm pack --dry-run --json
```

Return to the workspace root before running the automated checks:

```sh
cd ../..
```

- [ ] Each package contains only intended `dist` files, its package README, its selected package-local `LICENSE`, and npm-generated metadata.
- [ ] `@browserir/core` has no Playwright or MCP runtime dependency.
- [ ] `@browserir/playwright` declares `@browserir/core` and Playwright correctly.
- [ ] `@browserir/mcp` declares core, Playwright, MCP server SDK, and Zod correctly.
- [ ] `@browserir/mcp` includes executable `dist/cli.js` with the `browserir-mcp` bin mapping.
- [ ] Packed dependency versions resolve to the intended published versions rather than unusable workspace references.
- [ ] Import each tarball from a temporary consumer project on supported Node 22 and Node 24 runtimes.
- [ ] Start the packed MCP executable from that consumer project and complete a stdio smoke test.

The automated clean-consumer form of the last two checks is:

```sh
pnpm verify:packed-consumer
```

## Continuous integration evidence

- [ ] All seven logical evidence gates produce the nine required fragments from
  one workflow run: workspace verification and packed consumer on exact Node.js
  22.13.0 and 24.19.0, plus capability, task, representation, performance, and
  production audit on Node.js 24.19.0.
- [ ] CI builds the publishable packages before workspace verification; the
  fragment retains per-package Vitest JSON and JUnit plus typecheck,
  package-verifier, and test logs. Both Node variants pass with no failures or
  errors and only the 19 declared opt-in skips.
- [ ] The capability qualification job passes all five browser workflows
  within its 20-minute bound and retains valid JSON and JUnit with no skips.
- [ ] The 14-task qualification job passes within its 45-minute bound and
  retains create-only JSON, Markdown, and command logs.
- [ ] The representation release-gate job passes within its 30-minute bound and
  retains JSON, NDJSON, Markdown, JUnit, exact-payload, and command-log evidence.
- [ ] The performance characterization completes within its 30-minute bound and
  retains environment JSON, raw NDJSON samples, summary JSON/Markdown, and logs.
  Treat this as candidate characterization, not a baseline, regression result,
  or competitor gate.
- [ ] The packed-consumer stdio smoke passes within its 30-minute bound on both
  qualified Node.js versions and records all phases plus names, sizes, and
  SHA-256 values for exactly three transient tarballs.
- [ ] The production audit classifies as `passed` within its 10-minute bound;
  `vulnerabilities_found`, muted advisories, and `audit_unavailable` all fail.
- [ ] Every fragment is create-only, contains `evidence.json` and
  `SHA256SUMS`, uses schema `1.1.0`, records stable deeply equal before/after
  source snapshots, and records a clean bound commit/tree, matching
  `GITHUB_SHA`, lockfile/source hashes, runtime, runner image, run ID, and run
  attempt. Run reviewed gate commands from an immutable checkout; endpoint
  equality cannot detect a mutate-then-restore interval.
- [ ] The dossier assembler rejects missing, duplicate, unknown, failed,
  dirty/unbound, cross-source, cross-run, malformed, forbidden, or
  checksum-mismatched fragments and qualifies the exact nine-fragment set. It
  independently recomputes source binding and retains the exact reviewed
  workspace test-count policy ID and declared/executed/skipped totals.
- [ ] Download the assembled dossier, verify its top-level `SHA256SUMS`, and
  record the GitHub artifact ID, service digest, workflow run/attempt, commit,
  and expiration date.
- [ ] Promote the unchanged qualified dossier before the 90-day CI retention
  expires to maintainer-approved durable release storage; record the durable
  URL and permanence policy and verify checksums again after promotion.
- [ ] Treat SHA-256 as an integrity mechanism, not an author signature or proof
  of release authorization; apply the selected tag/signing/provenance policy
  separately.
- [ ] Third-party GitHub Actions remain pinned to reviewed immutable commit SHAs; update the version comments and SHAs together.
- [ ] CI jobs remain pinned to `ubuntu-24.04`; record the runner image version in the release evidence.
- [ ] Record the exact Node.js 24 patch version from the release workflow in the candidate evidence whenever it changes.

## Publication sequence

Do not run these steps until npm ownership and publication authority are confirmed.

Create one persistent candidate artifact set at a new, non-existing directory.
This command requires a qualified release-evidence dossier, verifies that the
dossier matches the current clean `HEAD`, tree, and lockfile, and refuses to
retain artifacts until `pnpm verify:legacy-release` is green. It then installs and
drives those exact tarballs before retaining them with the dossier:

```sh
node scripts/smoke-packed-consumer.mjs \
  --release-evidence /absolute/path/to/qualified-release-dossier \
  --artifact-directory /absolute/private/path/browserir-release-candidate
cd /absolute/private/path/browserir-release-candidate
shasum -a 256 -c SHA256SUMS
```

Do not rebuild or repack after this point. Publish the exact hashed `.tgz` files
from that directory, in dependency order, using the chosen prerelease tag.
The candidate's top-level `SHA256SUMS` covers all three tarballs and the copied
`release-evidence/` dossier. These hashes establish content integrity relative
to the retained checksum; they are not signatures and do not replace release
authorization.

- [ ] Confirm the candidate contains exactly the qualified dossier bound to its
  clean source and the three tested tarballs; verify the complete top-level
  checksum file before publishing.
- [ ] Record the candidate tarball names, byte sizes, SHA-256 hashes, source commit, and release-evidence dossier together.
- [ ] Publish the hashed `@browserir/core` tarball first with public access and the chosen alpha tag.
- [ ] Install the published core into a clean smoke-test project and verify ESM import plus declarations.
- [ ] Publish the hashed `@browserir/playwright` tarball and verify Chromium session creation against the published core.
- [ ] Publish the hashed `@browserir/mcp` tarball and verify `browserir-mcp` through an official MCP client.
- [ ] Confirm package provenance, registry integrity hashes, versions, access level, and dist-tags match the retained candidate evidence.
- [ ] Create the signed or annotated source tag only after package contents and the release commit match.
- [ ] Publish release notes that link the durably retained, checksummed evidence
  and benchmark artifacts and clearly list alpha limitations.
- [ ] **Mark the actual publish blocker resolved only after all three registry artifacts and the source release are publicly verifiable.**

## Post-release

- [ ] Install all three packages from the public registry in clean supported Node 22 and Node 24 environments.
- [ ] Install Chromium using the documented command and repeat the MCP smoke workflow.
- [ ] Verify README links and package metadata on the registry and repository host.
- [ ] Monitor private vulnerability reports, installation failures, protocol incompatibilities, and browser-version regressions.
- [ ] Prepare a rollback or deprecation notice if any package is incomplete, mislicensed, or points to an unpublished workspace dependency.
- [ ] Record the next supported version and maintenance policy in `SECURITY.md`.
