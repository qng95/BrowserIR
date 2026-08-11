# Changelog

All notable changes to BrowserIR will be documented here. The project intends to follow Semantic Versioning after its public contracts stabilize.

Last updated: 2026-08-11

## Unreleased

### Preparing 0.1.0 alpha

BrowserIR 0.1.0 is not yet published. It is an alpha-quality first release and does not imply API stability or competitor superiority.

### Added

- Browser-independent interaction graph with semantic entities, capabilities, relationships, evidence, confidence, revisions, and deltas.
- Deterministic compact and structured views with character budgets, explicit omissions, focused inspection, and optional evidence.
- Revision-bound entity references and stale-target rejection.
- Typed browser actions for click, double-click, context-click, focus, hover, fill, type, select, check, uncheck, press, scroll, drag, and host-resolved upload.
- Action receipts that distinguish blocked, verified, and dispatched-but-unverified outcomes.
- Playwright and Chromium driver with fixed session viewport profiles, frame and popup tracking, open Shadow DOM traversal, native and ARIA controls, custom click evidence, choice normalization, validation state, and transient status content.
- Exact and conservative inferred label relationships with deterministic ambiguity abstention.
- Bounded native/ARIA table and grid normalization with table, row, and cell
  entities; header roles, declared counts and indices; containment, `row-of`,
  and `cell-of` relations; virtualized-record identity; and explicit scan-cap
  omissions.
- Evidence-backed double-click and drag capabilities from native, ARIA,
  inline, framework, and safely tracked listener signals, including
  conservative delegated double-click for focusable structural cells.
- Centralized ARIA activation semantics for button/link/checkable/tab/tree/menu
  roles, visible custom options, and transient menu items, with name-from-content
  and hidden, occluded, inert, disabled, and native-option negatives.
- Viewport and entity PNG capture with viewport, scale, scroll, and clip metadata, plus post-capture observation that discards pixels when represented state changes or stability cannot be verified.
- Model-visible exact and lower-bound omission telemetry for bounded standard
  controls/scopes/options, roleless interactions, semantic labels, and
  structural table scans.
- Per-connection browser, per-session page, per-observation frame-analysis, and
  capture pixel/byte limits with negative regressions.
- Local stdio MCP server targeting protocol version `2026-07-28` with create, navigate, observe, inspect, act, wait, pages, capture, and close tools.
- Experimental Chromium-only `browser_evaluate_unsafe` escape hatch that is
  absent from the default nine-tool catalog and requires explicit CLI/server
  opt-in plus a host-provided audit sink. It enforces source, timeout, result,
  serialization, cancellation, post-observation, revision-invalidation, and
  fail-closed audit bounds.
- Whole-pipeline unsafe-evaluation deadlines cover protocol-session acquisition,
  execution, promise settlement, and bounded serialization. Timeout,
  cancellation, or an unacknowledged protocol failure triggers bounded
  termination, verified target closure, or irreversible logical-session
  invalidation; evaluation is never retried.
- Stock CLI help/version output and an explicit `--headful` mode for watching the same isolated, fixed-viewport Chromium session during development.
- Deterministic ERP/DMS fixture backed by in-memory SQLite, 14 task oracles, and audit-log verification.
- Benchmark library for task outcomes, representation precision/recall/F1, correct abstention, identity stability, omission accounting, payload measurement, deterministic reports, latency statistics, bootstrap intervals, and environment-matched regression gates.
- Benchmark schema 1.1 reproducibility fields: stable run IDs, exact workload and fixture metadata, warmup counts, and seeded 95 percent p50/p95 confidence intervals; source provenance is retained without making cross-revision environment comparison impossible.
- Apache-2.0 licensing, public alpha documentation, security boundary,
  contribution workflow, benchmark methodology, and release checklist.
- Manifest-driven paired agent comparisons between pinned official Playwright
  MCP and BrowserIR under the same neutral LangChain agent, model, task,
  browser profile, budgets, fresh fixture, and deterministic database/audit
  oracle. The runner counterbalances arm order, verifies baseline equivalence
  and model-facing catalogs, uses a conservative paired interval, separates
  paired-valid from operational counts, and emits create-only checksummed
  evidence.
- Publication-safe paired artifacts replace browser inputs, page payloads,
  model final text, and private oracle bodies with byte counts and SHA-256
  digests while preserving local in-memory diagnostics for the benchmark
  feedback loop.
- Exact public-package allowlists, package-local READMEs, clean source-map-free builds, workspace dependency rewrite checks, and a fresh-consumer tarball smoke test that drives the installed stdio executable with the official MCP client.
- Bounded CI gates for the minimum Node.js release, the qualified Node.js 24 release, capability coverage, all 14 database-backed tasks, representation quality, and archived qualification evidence; third-party Actions are pinned to immutable commits.
- Create-only release-evidence fragments for seven logical gates, including
  JSON/JUnit test reports, benchmark and qualification artifacts, packed-package
  hashes, normalized production-audit classifications, runtime metadata, source
  binding, stable before/after endpoint verification, and per-file SHA-256
  checksums. Schema `1.1.0` fragments supersede and invalidate pre-verification
  schema `1.0.0` evidence.
- A fail-closed dossier assembler that requires all nine Node/gate variants from
  one clean GitHub Actions commit and run attempt, verifies artifact allowlists
  and checksums, recomputes source binding, retains the exact reviewed workspace
  test-count policy ID, rejects source drift and stale count policies, and
  retains checksummed assembly-failure evidence when possible.
- Ninety-day CI retention for individual fragments and the assembled dossier,
  with documented durable-promotion, integrity-versus-authenticity, and
  dirty/unbound local-evidence policies.

### Security

- Stock MCP deployment is local stdio only and owns browser cleanup for its connection.
- Arbitrary page evaluation is absent from default tool discovery and disabled
  by default. Enabling the experimental escape hatch is an explicit security
  boundary change and still requires mandatory redacted intent/completion
  auditing.
- Navigation schema accepts only HTTP and HTTPS URLs; hosts remain responsible for egress and SSRF policy.
- Playwright source targets remain private to the driver and are not written into page DOM properties or exposed through MCP.
- Sensitive native/custom field values and credential-bearing URL components
  are minimized before model-facing output; screenshots remain explicitly
  sensitive.
- Automatic downloads are rejected by the maintained browser context, the
  benchmark fixture binds only to loopback, and failed browser cleanup remains
  retryable and reports aggregate failure.
- Playwright's process-signal hooks default off in the maintained backend so
  the BrowserIR stdio owner can close real browser sessions before SIGINT 130
  or SIGTERM 143; EOF remains a normal code-0 disconnect.
- Fixture startup rejects listen failures promptly instead of leaking an
  unhandled server error and timing out its caller.

### Known limitations

- Chromium is the only supported browser backend.
- Packages remain unpublished pending npm scope ownership, an alpha version/tag
  decision, public-package privacy changes, and the publication step itself.
- No published BrowserIR or competitor benchmark baseline exists yet.
- Closed Shadow DOM, canvas-only interfaces, fully unannotated choices,
  higher-level table semantics such as general sort/filter/pagination ownership,
  persisted auth profiles, managed downloads, continuation views, historical
  views, and a stock remote HTTP deployment are not supported public 0.1
  features.
- Screenshot capture is guarded by a post-capture representation check, but is not pixel/observation atomic and cannot detect a purely visual race outside the BrowserIR graph.
- Child-frame replacement currently invalidates references page-wide.
- Public API compatibility may change during the 0.1 alpha series.
