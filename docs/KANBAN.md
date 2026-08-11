# BrowserIR Kanban

Last updated: 2026-08-11

This is the working implementation board. Cards move from **Backlog** to
**Ready**, then **In Progress**, and finally **Done**. A card is not Done merely
because code exists; its tests and acceptance gate must also pass.

Current release status: the Apache-2.0 source alpha is public, while npm package
publication and a tagged `0.1.0` release remain open. The intended public
packages are `@browserir/core`, `@browserir/playwright`, and `@browserir/mcp`;
`@think-dom/fixture-app` and `@browserir/benchmark` remain private development
packages. Core runtime, Playwright driver, local stdio MCP delivery, fixture
oracles, benchmark/report infrastructure, and the release-evidence pipeline are
implemented. The current pre-commit workspace verification declares 588 cases:
569 executed passes and 19 intentional opt-in cases skipped. All five package
type checks pass. Earlier 487/468/19 and 439/420/19 runs remain retained
dirty/unbound history under stale exact-count policies. Publication gates and
durable promotion of the qualified dossier remain open; see the
[release-readiness assessment](RELEASE_READINESS.md) and
[release-evidence guide](RELEASE_EVIDENCE.md).

In the 2026-08-11 local evidence run, the post-hardening deterministic reference
planner completed all 14 isolated database-backed tasks through the stock
nine-tool MCP surface and official MCP client: 14 passed, 0 failed, across 299
MCP calls with no tool errors. All 14 workers observed the same tool-catalog
hash. That run
qualifies BrowserIR representation/action reachability for the declared fixture
workload; it is not an LLM-generalization test or competitor comparison. The
workspace had no Git HEAD, so the report correctly records unavailable source
provenance and a dirty tree. GitHub Actions later reproduced the complete result
on clean, source-bound commit `e21fb1b` and assembled the qualified dossier.

The same operator-frozen local run series passed the independent representation
gate: 31/31 entities, 44/44 capabilities, 28/28 relations, 1/1 abstention, 3/3
stable identities, and exact accounting of all 18 known scan omissions. A
seven-screen warm steady-state characterization recorded 100 samples after five
warmups per screen with raw samples and seeded 95% p50/p95 confidence
intervals. Those retained local fragments remain dirty-tree history, while
[GitHub Actions run `31518078584`](https://github.com/qng95/BrowserIR/actions/runs/31518078584)
is the source-bound public qualification. Neither is a competitor comparison.

## Historical MCP vertical-slice audit (2026-07-29)

An official MCP client pinned to protocol version 2026-07-28
completed the fixture's `create-customer` task in an automated browser test. It
signed in, created Steinweg Logistik GmbH using only BrowserIR references,
passed the database verifier plus a separate audit-log assertion, and closed the
browser cleanly. Unsafe evaluation remained absent from tool discovery.

A second acceptance path deliberately submitted an over-limit credit value and
malformed VAT ID. The compiled view exposed the alert, both field-specific
reasons, and invalid state; the MCP client corrected both fields and then passed
the same database and audit gates.

The previously manual run exposed a roughly 75,000-token customer-list action
result. The automated workflow now measures a largest complete model payload of
5,106 characters (roughly 1,300 tokens) and enforces a 16,000-character
regression ceiling.

Resolved audit findings:

- [x] **BIR-004/BIR-030 slice:** source-addressed containment and named
  navigation/main/toolbar scopes distinguish duplicate controls.
- [x] **MCP honesty:** unimplemented mode, intent, focus, and historical-revision
  options are no longer advertised or accepted.
- [x] **BIR-034 slice:** navigation, observation, action, wait, and inspection
  share a view budget; MCP emits one canonical text view, one small envelope,
  and one budgeted ID-only delta with explicit change omissions.
- [x] **BIR-006 slice:** create-customer is an automated MCP, database, and audit
  acceptance workflow.
- [x] **Identity hardening:** duplicate survivors retain their canonical IDs,
  focused inspection includes one-hop semantic context, and document-title
  changes do not churn unlabeled-main descendants.
- [x] **Receipt hardening:** conflicting revisions normalize to observed state,
  and raw driver error messages do not cross the MCP boundary.
- [x] **BIR-006/BIR-050 slice:** server validation is prioritized in the compact
  view, field descriptions remain model-visible, and correction plus retry is
  proven through the official MCP client.
- [x] **BIR-056 slice:** same-URL sibling frames have separate private lineage
  namespaces, model-visible document labels and containment, stable canonical
  refs, and verified action routing.
- [x] **BIR-090 slice:** per-frame scope and control work uses bounded ordered
  concurrency. A warm 200-control observation improved from a 1,112.6 ms
  pre-change median to 553.5 ms while preserving targets and actionability.
  This is a recorded characterization; the hard p50/p95 regression gate remains
  BIR-091 work.
- [x] **Representation hardening:** finite-budget views locally truncate
  oversized entity fields, nested string values, capability reasons, and
  requested evidence with explicit content omissions before evicting useful
  controls.
- [x] **Action-target hardening:** custom interaction evidence is carried with
  same-snapshot element handles, target identity lives in a private per-frame
  registry instead of page-visible properties, and listener instrumentation is
  failure-isolated from the site's native event behavior.
- [x] **Observation coherence:** native controls and semantic scopes also bind
  from exact snapshots; framework metadata access does not invoke page getters;
  clickable scopes cannot duplicate a source identity; and a frame-generation
  guard retries an observation once when navigation invalidates it.
- [x] **Perceptibility hardening:** controls covered by a collapsed selector are
  excluded by bounded hit testing, and occluded text no longer leaks through
  the page summary. Revealed controls become available without selector-based
  bypasses.
- [x] **Composite-field semantics:** multi-input phone widgets expose a concise
  phone field plus country-code control instead of an unnamed required input
  and a country-list-polluted label. Focused native constraint failures expose
  invalid state and the browser validation message.
- [x] **Wait-contract honesty:** the MCP-advertised `settled` condition now
  requires two consecutive delta-free observations with no busy entity; graph
  changes and busy state reset the count.
- [x] **BIR-009 representation conformance:** an independent oracle grades the
  public compiled view rather than driver internals. Native selects, explicit
  ARIA comboboxes, standards-hinted custom `div` choices, and open Shadow DOM
  controls with portal options now converge on the same semantic entities,
  exact capabilities, option relations, compact text references, and bounded
  representation density across materially different DOM layouts.
- [x] **Choice and document-lifecycle honesty:** exact and disabled custom
  options, delayed editable autocomplete, partial dispatch, rejected WebForms
  postbacks, generated-ID churn, identical same-URL document replacement,
  fragment navigation, and child-frame postback all have browser regressions.
  A document replacement alone is no longer accepted as proof that a requested
  value or checked state took effect.
- [x] **Deterministic semantic relationships:** explicit label associations are
  preserved, while otherwise separated label/control candidates use bounded
  same-frame scope, geometry, ordering, type, and text evidence. The current
  acceptance threshold is `0.86` with a `0.12` ambiguity margin; ties,
  cross-frame candidates, hidden labels, and weak matches abstain.
- [x] **Structural table/grid slice:** native tables and explicit ARIA
  table/grid/treegrid markup normalize to table, row, and cell entities with
  header roles, declared counts, indices, geometry, containment, `row-of`, and
  `cell-of`. Stable record keys distinguish value rerenders from virtualized
  node recycling, and scan caps produce explicit omissions.
- [x] **Evidence-backed capabilities:** direct and safely tracked delegated
  double-click, native/ARIA/listener drag sources, and represented drop targets
  now preserve canonical actions without promoting unrelated cells. A shared
  ARIA activation policy covers button/link/checkable/tab/tree/menu roles;
  visible custom options and transient menu items are clickable and named,
  while native-option, hidden, occluded, inert, and disabled negatives remain
  conservative.
- [x] **Partial-initialization cleanup:** failed browser launch, context setup,
  init-script installation, initial page creation, and page registration paths
  close every resource already created, preserve the originating error, and
  permit a clean retry. Broader cancellation propagation remains BIR-072 work.

Remaining work from the audit:

- [ ] **BIR-031/BIR-033:** implement focused and historical views before
  restoring those public options.
- [ ] **BIR-034:** add continuation handles and exact transport-wrapper
  accounting at the minimum requested budget.
- [ ] **BIR-034:** bound pathological collection cardinality from future core
  producers (thousands of short value, capability, or evidence entries).

The audit also confirmed that transient state participates in revision safety:
an auto-dismissed success toast advanced the revision, the first screenshot was
rejected as stale, and capture succeeded only after a fresh observation.

## Historical consented live-site audit (2026-07-30)

A headed official MCP client observed an authenticated dealership selector in
a user-authorized DMS test deployment. BrowserIR could open and filter the
selector, but a visible result row had no native element, ARIA role, or
actionable entity reference. ArrowDown and Enter produced no verified effect,
while Tab left the document. BrowserIR refused to invent success or bypass the
representation with a selector. The deployment URL and account-specific labels
are intentionally omitted from public source history.

That failure became a red browser test before implementation. The Playwright
sensor now performs a bounded secondary interaction-evidence scan and promotes
role-less custom controls only when supported by React/Vue handler metadata, an
active direct or inline click listener, or a pointer boundary corroborated by a
delegated click ancestor. It names the control from accessible or visible text,
retains a role-less `control` rather than inventing `button`, and records the
click inference reason plus confidence. Ordinary framework-owned text,
cursor-only decoration, decorative native-control wrappers without independent
handler evidence, inherited-pointer children, and aggregate delegation
containers remain excluded. A custom card or row with strong independent click
evidence remains visible even when it contains a native menu button. A
framework rerender that replaces the source node while preserving its record
key retains the canonical entity ID and remains action-verifiable.

Adversarial regressions now prove that DOM mutation during discovery cannot
move evidence onto a different node, a page cannot forge duplicate opaque
target IDs, and a non-extensible element cannot cause BrowserIR bookkeeping to
prevent the site's real listener from registering.

The continued headed audit then completed the real customer-creation flow using
only revision-bound BrowserIR references. It opened the dealership selector,
selected `Test Creation`, navigated to Customers, filled the required fields,
recovered from a native phone-field validation failure, and created synthetic
customer `BrowserIR Verification`. Success was verified by navigation to the
persisted record `/customers/150899` and by re-reading the saved name, email,
and phone values. Every browser mutation was followed by a fixed-profile
revision-bound screenshot.

That run found two additional representation defects before completion.
Collapsed selector contents were still represented while physically covered;
the sensor now excludes covered controls and text until the selector opens. A
composite phone widget also assigned its full mounted country list to the
country control while leaving the actual required phone input unnamed; the
sensor now models concise subfield names, native invalid state, and the focused
browser validation message. Both fixes began with failing browser regressions.

Current limitations:

- [ ] A generic delegated handler with no semantic role, framework metadata,
  pointer affordance, or independently focusable structural target cannot be
  mapped safely to a leaf without speculative interaction. The implemented
  delegated-double-click rule is deliberately limited to focusable table/grid
  cells under a tracked ancestor listener.
- [x] The 25,000-element scan and 200 inferred-target per-frame safety caps emit
  model-visible telemetry: exact counts for known retained-candidate overflow
  and `at least` lower bounds when the raw scan boundary hides cardinality.
- [x] Standard controls, semantic scopes, and choice options use bounded
  same-snapshot collection rather than unbounded Playwright handle arrays;
  incomplete option searches fail explicitly instead of assuming uniqueness.
- [ ] Composite-field inference is intentionally narrow to phone widgets.
  Generic field-group entities and explicit subcontrol relations remain future
  sensor-fusion work.
- [ ] A listener-driven custom dropdown with no native semantics,
  `aria-haspopup`, or other portable choice evidence is still represented only
  as a generic inferred control; BrowserIR does not yet invent combobox and
  option semantics.
- [ ] Choice options have `option-of` relations, but popup/listbox containers
  and `popup-for` relations are not yet first-class in this slice.
- [ ] Child-document replacement conservatively invalidates page-wide
  references. Per-frame scoped invalidation remains BIR-013/BIR-056 work.
- [ ] Choice-owner discovery still needs a shared one-pass owner index and
  performance characterization. Its inputs are now bounded and omission-aware,
  but the independent sensor passes remain optimization work.
- [ ] Structural tables expose observed hierarchy, headers, counts, indices,
  and identity, but general sort/filter/pagination ownership and inferred
  higher-level schema remain future compiler work.
- [ ] Navigation requested well after the immediate action watcher cannot be
  causally attributed with certainty and must remain unverified.

## Working policy

- Keep at most three implementation cards in progress.
- Start every behavior with a failing test.
- Confirm that the test fails for the intended reason.
- Implement the smallest passing change, then refactor.
- Add a regression test before fixing a defect.
- Run focused tests during development and affected package tests before Done.
- Run workspace type checking and the milestone acceptance workflow before Done.
- Do not weaken, skip, or delete a legitimate test to make a change pass.
- Record deferred edge cases as new cards rather than hiding them in implementation notes.

Definition of Done for every implementation card:

- public behavior and failure behavior have tests;
- tests were observed red before implementation and are green afterward;
- types and schemas are explicit;
- errors are actionable and do not silently discard partial state;
- package tests and type checking pass;
- documentation is updated when a public contract changes.

## In Progress

### BIR-099 — Evidence Drop 01: paired Playwright MCP comparison

- [x] Pin official `@playwright/mcp` `0.0.78` and expose a declared safe
  accessibility/action catalog without evaluation, arbitrary code, network
  body inspection, or unrestricted file paths.
- [x] Inject either browser interface beneath the same fresh fixture and sealed
  database/audit judge.
- [x] Add one neutral LangChain prompt and remove interface-specific labels
  from the shared adapter boundary.
- [x] Add a matched runner with deterministic counterbalanced order, fairness
  checks, invalid-block handling, paired lift, tool traces, and agent-only time.
- [x] Add create-only comparison JSON, attempt NDJSON, Markdown, and checksums.
- [x] Bind runnable comparisons to strict development/sealed manifests, exact
  task/oracle/model/catalog digests, and a no-scientific-overrides CLI.
- [x] Add publication-safe trace projection, matched baseline fingerprint
  checks, paired-valid denominators, and a boundary-safe interval.
- [x] Add a create-only hash-chained development journal, `--resume`, exact
  preflight replay, start/end environment stability checks, idempotent
  finalization, and atomic `COMPLETE.json`.
- [x] Add delta-first receipts with conservative retained-reference proofs;
  recycled, omitted, structurally changed, or unproven identities fail stale.
- [x] Add bounded continuation-oriented `actionable_context` with fresh
  post-revision refs for visible remaining controls.
- [x] Run real-model development diagnostics only on the excluded
  `create-customer` task; retain and classify v4–v7, including the negative
  results and first one-block treatment win, without touching the sealed task.
- [x] Prove both interfaces can complete `create-customer` with deterministic
  scripted models through real Chromium and the same oracle.
- [x] Run a fresh complete workspace/typecheck gate and update the exact-count
  release policy after the latest product and benchmark changes.
- [x] Remove the explicit sealed-execution hard stop after adding pure
  fail-closed sealed source-binding tests.
- [x] Configure the canonical GitHub remote plus repository, homepage, and issue
  metadata.
- [ ] Create and review a clean Git `HEAD`, then create a freeze tag resolving
  to the selected release commit.
- [ ] Freeze the exact real-model manifest before any scored
  `validation-recovery` call.
- [ ] Run 30 complete sealed blocks without early stopping or favorable rerun.
- [ ] Classify discordant failures from retained evidence; add test-first,
  technology-neutral BrowserIR fixes only when a general defect is proven.
- [ ] Publish the unchanged sealed result, visual scorecard, README scope,
  reproduction command, announcement, commit, tag, and GitHub release.

Gate: no uplift headline unless the 95% paired interval is entirely above zero
and at most 5% of scheduled blocks are invalid. A regression or inconclusive
result is published under its predeclared wording.

Maintainer-owned release identity decisions and clean-commit qualification are
the active release work. License, npm scope ownership, version/tag semantics,
and publication authority remain external
blockers. No public-package privacy or publication guard may be removed until
those decisions are recorded. After the final metadata, `private`, and
`publishConfig` changes, `pnpm verify:release` must pass before candidate
artifacts are retained or published.

The BIR-097 evidence machinery is implemented, but its release acceptance step
must run in the future canonical repository: all seven gates, nine runtime
fragments, and the fail-closed dossier assembler must qualify one clean GitHub
Actions commit. The resulting 90-day CI artifact must then be promoted
unchanged to approved durable storage before publication.

### BIR-080–083 — Opt-in unsafe page evaluation

The implementation now matches the intended escape-hatch contract:

- [x] Keep `browser_evaluate_unsafe` completely absent from the default
  nine-tool catalog; the stock CLI requires `--enable-unsafe-evaluate`, while an
  embedded host requires both `unsafeEvaluate` with a redacted audit callback
  and the MCP enable flag.
- [x] Require an explicit page and current revision, execute only in Chromium's
  main/default page world, and enforce 16,384-character/32-KiB source,
  2-second-default/5-second-maximum timeout, and
  8-KiB-default/64-KiB-maximum JSON-output bounds. The model-result budget can
  lower the effective output limit.
- [x] Use bounded JSON serialization and bounded fail-closed containment for
  timeout, cancellation, and unacknowledged evaluation-command failures:
  terminate, verify target closure, then irreversibly invalidate the logical
  browser if neither is confirmed. Never retry evaluation.
- [x] Fully observe every dispatched call whose browser remains usable, force the
  revision forward and stale every prior ref. Skip observation and immediately
  invalidate after containment failure; also invalidate when verification or a
  post-dispatch completion audit fails.
- [x] Audit intent and completion without source or result values; retain only
  the SHA-256 source digest and byte length plus bounded operational metadata.
  Apply heuristic secret/URL redaction to returned JSON without describing it
  as DLP.

Local acceptance evidence is complete; clean-source CI qualification remains
part of the release dossier work:

- [x] Record focused core, Playwright, runtime-service, MCP discovery, stdio,
  cancellation, and audit-failure test results, including 12 real-Chromium
  driver cases and the compiled opt-in stdio path.
- [x] Run workspace type checking and the complete test suite after the final
  unsafe-evaluation changes: 420 passed, 19 intentional opt-in skips, 0
  failures, and 0 errors.
- [x] Re-run stock capability, task, representation, and performance gates with
  unsafe evaluation disabled and confirm the catalog remains the same nine
  tools. All local gates passed and their checksum manifests verify.

## Ready

### BIR-057 next slice — Unannotated choices and popup lifecycle

Test-first checklist:

- [ ] Add adversarial fixtures for listener-driven choice controls with no
  native element, role, `aria-haspopup`, or framework-specific naming.
- [ ] Distinguish a genuine choice from an ordinary clickable card without
  inventing semantics from styling alone.
- [ ] Represent listbox/menu popup containers and explicit `popup-for`
  ownership, including initially absent and portal-mounted popups.
- [ ] Preserve exact option ownership across nested open shadow roots and
  multiple simultaneously mounted lists.
- [ ] Add ambiguity and false-positive fixtures before expanding inference.

Gate: an unannotated custom choice is promoted only from portable,
corroborating interaction evidence, while visually similar non-choice controls
remain ordinary controls or are left unknown.

### BIR-013/BIR-056 next slice — Scoped document epochs

Test-first checklist:

- [ ] Track a document epoch per frame rather than only a conservative
  page-wide document-tree generation.
- [ ] Invalidate references belonging to a replaced child document without
  invalidating unaffected sibling or top-document references.
- [ ] Cover delayed script-triggered navigation that begins after the current
  immediate post-action watcher.
- [ ] Preserve same-document history and fragment identity.

Gate: every physical document replacement advances the correct scope and no
unaffected document loses valid references.

## Done

### BIR-098 — Deterministic LangChain agent benchmark

- [x] Run a provider-independent LangChain `createAgent` loop over the exact
  BrowserIR MCP schemas, with text-only and separately declared multimodal
  profiles.
- [x] Provision fresh seeded fixture, browser, MCP client, and conversation
  state for every task/trial attempt; reject a passing fresh baseline.
- [x] Seal browser and application access before judging hidden database and
  audit state; ignore page text and agent self-reports as proof.
- [x] Require one trusted structured result and exact private answer matching
  for report-style tasks.
- [x] Enforce time, tool-call, model-turn, navigation, safe-tool-catalog, and
  fixed-browser-profile policies.
- [x] Reject missing, unrelated, and repeated same-action mutations by comparing
  the complete post-baseline audit action multiset with each task contract.
- [x] Emit create-only JSON, NDJSON, Markdown, and SHA-256 artifacts with
  per-task and pooled 95% Wilson intervals, micro pass rate, macro task pass
  rate, invalid rate, tool metrics, versions, and fingerprints.
- [x] Pass the deterministic fake-model real-Chromium/MCP vertical slice and the
  current 150/150 benchmark package gate. Local Ollama development diagnostics
  exist, but no sealed or public real-model score has been run.

This completes the local benchmark mechanism, not a hosted scoring service.
Canonical public scoring still requires a disposable process/container and
private judge plane per attempt; mutable third-party sites remain non-scored
live probes.

### BIR-097 — Source-bound release evidence

- [x] Record seven logical gates as create-only fragments with machine-readable
  manifests, command logs, runtime/source metadata, and per-file SHA-256 values.
- [x] Retain Vitest JSON and JUnit for workspace and capability tests, native
  qualification/benchmark reports, packed-consumer phases and transient archive
  hashes, and classified production-audit evidence.
- [x] Require nine exact gate/runtime variants across Node.js 22.13.0 and
  24.19.0 and reject failed, dirty/unbound, cross-source, cross-run, duplicate,
  missing, malformed, forbidden, or checksum-mismatched fragments.
- [x] Assemble a checksummed dossier only from one clean GitHub Actions commit;
  retain checksummed assembly-failure evidence when possible.
- [x] Archive fragments and dossiers for 90 days in CI and document unchanged
  promotion to durable storage, including the distinction between SHA-256
  integrity and artifact authenticity.
- [x] Require a validated dossier matching clean `HEAD`, tree, and lockfile
  before persistent candidate tarballs can be retained with that dossier.
- [x] Run the expanded machine-readable local workspace gate: 439 total cases,
  420 executed and passed, 19 intentional opt-in skips, 0 failures, and 0
  errors; retain and verify all 28 files including JSON, JUnit, logs,
  `evidence.json`, and `SHA256SUMS`.

This completes the evidence mechanism, not release qualification. The first
qualified dossier still requires the selected clean commit, and it does not
resolve npm ownership, version/tag, or publish authorization blockers.

### BIR-096 — Local alpha source qualification

- [x] Run the then-current combined five-package workspace suite: 324 tests
  passed and 19 explicitly opt-in tests remained skipped. This is the historical
  BIR-096 count; BIR-097 supersedes it with the expanded 439-case
  machine-readable local run.
- [x] Pass workspace type checking, exact public-package verification, the
  packed-consumer smoke, and a production dependency vulnerability audit.
- [x] Pass all five capability workflows and all 14 isolated database/audit-log
  task oracles through the official MCP client and stock nine-tool surface.
- [x] Pass the representation release gate with perfect checked-corpus entity,
  capability, relation, abstention, identity, and omission accounting.
- [x] Record raw local performance samples, warmups, dispersion, and seeded
  confidence intervals for seven fixture screens.
- [x] Confirm the release verifier refuses publication while required release
  identity and package-publication metadata are absent.
- [x] Document exact evidence, its local dirty-tree provenance, unsupported
  claims, and the maintainer-controlled blockers in
  [RELEASE_READINESS.md](RELEASE_READINESS.md).

This qualifies a local alpha source candidate only. It is not a clean release
commit, a public artifact, an LLM generalization result, or a competitor
comparison.

### BIR-007 — M1 revision-bound screenshots

Test-first checklist:

- [x] Add failing fixed-profile and metadata tests.
- [x] Add failing viewport and entity capture tests.
- [x] Implement capture with revision, viewport, scale, scroll, and clip metadata.
- [x] Re-observe after capture and discard pixels if represented state changed or stability cannot be verified.
- [x] Keep the viewport immutable for the session; no viewport-mutation API is
  exposed in the alpha.
- [x] Reject captures above the physical-pixel and encoded-byte limits before
  they cross the core or MCP boundary.

Gate passed for the documented alpha contract: the MCP client receives a
revision-bound capture only after represented state remains stable. Observation
and pixels are not one atomic browser operation, so a purely visual change
outside the BrowserIR graph can still race with capture; that limitation is
documented rather than presented as solved.

### BIR-003 — M1 create and close browser through MCP

Test-first checklist:

- [x] Add MCP tool contract tests for `browser_create` and `browser_close`.
- [x] Cover unknown and duplicate close with stable model-safe errors.
- [x] Implement opaque browser handles and deterministic cleanup.
- [x] Dispose every connection-owned browser on stdio close or EOF.

Gate passed: an MCP client can create and close an isolated browser, invalid or
duplicate handles fail without leaking internal identifiers, and the stock
stdio lifecycle owns cleanup. Idle and absolute expiry remain BIR-070 work.

### BIR-006 — M1 create-customer acceptance workflow

Test-first checklist:

- [x] Automate the end-to-end workflow using only MCP tools and BrowserIR refs.
- [x] Assert server-side validation is represented and recoverable.
- [x] Preserve the required top-level action under the compact view budget.
- [x] Verify the database row and audit-log entry.

Gate passed: both the direct and rejection/recovery paths use only MCP tools and
BrowserIR refs, remain within the compact result budget, and pass the fixture
database plus audit-log verification without CSS, XPath, direct DOM queries, or
arbitrary evaluation.

### BIR-004 — M1 navigate, observe, and retain semantic context

Test-first checklist:

- [x] Add browser-backed navigation and observation tests.
- [x] Add failing canonical source-addressed relationship assertions.
- [x] Add failing compact-view and complete-representation budget tests.
- [x] Implement named semantic scopes, containment, and deterministic priority.

Gate passed: MCP returns a compact login view containing actionable username,
password, and submit entities; duplicate actions receive distinct scoped
identities; selectors and driver source IDs do not enter the canonical view.

### BIR-002 — M0 core contracts and package scaffolding

Build the smallest testable package boundaries for the BrowserIR core,
Playwright driver, and MCP server.

Test-first checklist:

- [x] Add failing dependency-boundary and public-contract tests.
- [x] Add failing fake-driver lifecycle test.
- [x] Define the minimal browser, page, revision, observation, entity, and action types.
- [x] Implement only enough scaffolding to pass.
- [x] Confirm no Playwright or MCP types leak into the core contracts.
- [x] Run workspace type checking and package tests.

Gate passed: all three packages type-check, the core completes deterministic
lifecycle tests through a fake driver, and the complete workspace suite passes.

### BIR-005 — M1 typed fill, click, and verified delta

Test-first checklist:

- [x] Add failing action-resolution tests for valid, stale, and unknown references.
- [x] Add a failing login workflow and effect-verification test.
- [x] Implement fill and click through Playwright.
- [x] Observe and return the post-action delta.
- [x] Distinguish dispatch from verified success.

Gate passed: the real fixture login succeeds through MCP using BrowserIR references
only, with correct revisions and a verified post-action effect.

### BIR-008 — Sensitive input redaction

- [x] Add a failing end-to-end assertion proving password values entered the IR.
- [x] Remove sensitive values at the driver boundary.
- [x] Preserve effect verification with a boolean `hasValue` state.

Gate passed: fixture authentication succeeds while the compiled BrowserIR view
never contains the password value.

### BIR-009 — Technology-neutral representation conformance

Test-first checklist:

- [x] Define an independent business contract and grade only the public
  `CompiledView`.
- [x] Fail on missing or ambiguous entities, semantic drift, capability drift,
  missing relations, text/structured mismatch, unexpected actions, and budget
  overflow.
- [x] Require complete normalized semantic parity across native, ARIA,
  standards-hinted role-less, and open Shadow DOM/portal implementations.
- [x] Vary generated IDs, wrapper hierarchy, hidden legacy noise, and option
  order without changing the business contract.
- [x] Execute the same exact selection through every implementation.
- [x] Cover delayed autocomplete options, disabled and disappearing options,
  multi-select verification, rejected postback, same-URL full replacement,
  fragment navigation, and child-frame replacement.
- [x] Run the affected package suites and strict workspace type checking for
  this completed slice.

Gate passed: equivalent customer-status controls compile to the same
decision-relevant semantic slice and accept the same typed action without CSS,
XPath, unsafe evaluation, or fixture-specific production rules. Replacement
and rejection paths preserve the distinction between dispatch and verified
effect.

### BIR-057 slice — Evidence-backed unnamed click targets

Test-first checklist:

- [x] Reproduce a role-less dealership row that is visible but absent from the IR.
- [x] Observe the test fail because React, direct-listener, and delegated-pointer
  rows have no actionable entity.
- [x] Add a bounded browser-side interaction-evidence scan.
- [x] Preserve truthful role-less semantics and attach click reason/confidence.
- [x] Reject ordinary React text, uncorroborated cursor styling, aggregate
  delegation containers, inherited-pointer children, and decorative
  native-control wrappers without independent handler evidence.
- [x] Keep independently clickable cards/rows when they contain a native action.
- [x] Bind evidence to same-snapshot handles and keep target identity private
  from page scripts.
- [x] Prove listener instrumentation cannot block native listener registration.
- [x] Verify the click effect and canonical identity across a source-node replacement.
- [x] Run the full workspace suite and strict workspace type checking.

Gate passed for this slice: a custom dealership row receives a stable canonical
reference and verified click without CSS, XPath, model-visible selectors, or
unsafe evaluation. The broader BIR-057 card remains open for custom dropdown
semantics, hover menus, tooltips, explicit cap omissions, and the irreducible
delegation case above.

## Backlog

The entries below are umbrella milestones. Several have implemented slices
listed under Done or the audit history above; unchecked acceptance gates denote
the remaining general-purpose coverage and must not be read as saying that no
part of the milestone exists.

### M2 — Sensors and canonical graph

- **BIR-010:** Normalize DOM and backend-node observations.
- **BIR-011:** Normalize accessibility roles, names, descriptions, and state.
- **BIR-012:** Add geometry, visibility, obstruction, scrolling, and hit testing.
- **BIR-013:** Add page, popup, frame, navigation, loading, and request lifecycle.
- **BIR-014:** Add versioned mutation and intersection page probes.
- **BIR-015:** Fuse evidence deterministically with confidence and provenance.
- **BIR-016:** Represent nested, inaccessible, and opaque document regions explicitly.

Acceptance gate:

- [ ] Repeated unchanged observations preserve IDs and return an empty delta.
- [ ] Nested documents and inaccessible regions do not disappear.
- [ ] Every inferred meaning and capability retains evidence and confidence.

### M3 — Identity and delta engine

- **BIR-020:** Separate source anchors, semantic IDs, and revisions.
- **BIR-021:** Reconcile framework rerenders without losing semantic identity.
- **BIR-022:** Detect record changes when virtualized nodes are recycled.
- **BIR-023:** Produce deterministic graph deltas.
- **BIR-024:** Resolve stale targets with confidence and ambiguity thresholds.

Acceptance gate:

- [ ] Rerenders preserve identity when meaning remains stable.
- [ ] Virtualized row recycling creates a new record identity.
- [ ] Stale targets recover only when exactly one candidate is sufficiently strong.
- [ ] Ambiguous targets fail safely.

### M4 — View compiler

- **BIR-030:** Compile deterministic overview views.
- **BIR-031:** Compile intent-focused interaction views.
- **BIR-032:** Expand selected entities, regions, relations, and evidence.
- **BIR-033:** Compile material deltas from a prior revision.
- **BIR-034:** Enforce token budgets with explicit omissions and continuation.
- **BIR-035:** Summarize tables, grids, filters, sorting, pagination, and observed rows.
- **BIR-036:** Prioritize validation, dialogs, menus, toasts, loading, and new pages.

Acceptance gate:

- [ ] Required current controls are present or explicitly inspectable.
- [ ] Output never silently exceeds its budget.
- [ ] Unobserved virtualized data is never presented as observed.
- [ ] Identical inputs produce byte-identical views.

### M5 — Action runtime

- **BIR-040:** Capability and actionability checks.
- **BIR-041:** Click, double-click, and context-click actions.
- **BIR-042:** Fill, type, select, check, focus, hover, and key actions.
- **BIR-043:** Scroll, drag, and upload actions.
- **BIR-044:** Bounded causal settling without generic sleeps.
- **BIR-045:** Effect verification and action receipts.
- **BIR-046:** Safe retry policy for read-only versus potentially mutating operations.

Acceptance gate:

- [ ] Typed actions drive every existing fixture workflow.
- [ ] Dispatch and verified success remain distinct.
- [ ] Uncertain mutations are never automatically retried.
- [ ] All 14 database and audit-log task verifiers pass.

### M6 — Difficult UI coverage

- **BIR-050:** Validation recovery, pagination, sorting, filtering, and debounce.
- **BIR-051:** Virtualized grids and stable business-record identity.
- **BIR-052:** Portals, multi-step wizards, bulk bars, and transient context menus.
- **BIR-053:** Double-click editing, drag alternatives, jobs, and staged dashboards.
- **BIR-054:** Popups, print views, and dynamic query rows.
- **BIR-055:** Open and closed Shadow DOM plus slotted content.
- **BIR-056:** Nested same-origin and cross-origin frames.
- **BIR-057:** Unnamed clickables, custom dropdowns, hover menus, and tooltips.
- **BIR-058:** Canvas, SVG, WebGL, contenteditable, uploads, dialogs, and occlusion.

Acceptance gate:

- [ ] Every difficult case has a representation assertion.
- [ ] Every difficult case has an action and verified-effect assertion.
- [ ] Opaque or inaccessible content is declared rather than silently omitted.

### M7 — Visual evidence

- **BIR-060:** Stable 1440 x 900, DPR 1 browser profile.
- **BIR-061:** Revision-bound viewport and entity screenshots.
- **BIR-062:** Reference annotations using geometry from the capture revision.
- **BIR-063:** Visual and payload regression coverage.

Acceptance gate:

- [ ] Screenshot pixels, entity bounds, and metadata share one revision.
- [ ] Stable-profile regressions are deterministic in the pinned environment.

### M8 — Future remote transport and production hardening

- **BIR-070:** Opaque handle ownership, idle TTL, and absolute TTL.
- **BIR-071:** Extend the implemented browser, page, frame-analysis, and capture
  bounds with aggregate memory and artifact quotas.
- **BIR-072:** Cancellation propagation and deterministic cleanup.
- **BIR-073:** Navigation, network, secret-redaction, and artifact policies.
- **BIR-074:** Consequential-action confirmation bound to target and revision.
- **BIR-075:** Complete observation, action, effect, and confirmation audit records.
- **BIR-076:** Streamable HTTP integration under a separately defined remote
  security boundary; local stdio is the only 0.1 alpha transport.
- **BIR-077:** Select, pin, and pass an applicable official MCP conformance suite
  when one becomes a declared release input.

Acceptance gate:

- [ ] Security controls have positive and negative integration tests.
- [ ] Confirmed actions are revalidated before dispatch.
- [ ] Any future remote transport and selected conformance suite pass before
  BrowserIR makes a remote-deployment claim.

### Cross-cutting release work

- **BIR-090:** Record observation, delta, compile, resolve, action, and total-step latency.
- **BIR-091:** Add p50/p95 performance and payload regression budgets.
- **BIR-092:** Add architecture-decision records for changed public assumptions.
- **BIR-093:** Version schemas and define compatibility policy.
- **BIR-094:** Maintain the implemented source-install, MCP client, security,
  release, and troubleshooting guides as the alpha contract changes.
- **BIR-095:** Add a floating dependency-range compatibility lane before widening the alpha's exact qualified runtime dependency pins.

Release gate:

- [ ] All 14 reference workflows pass using compiled views and entity references.
- [ ] No required workflow uses selectors, XPath, or arbitrary evaluation.
- [ ] Stale and ambiguous references fail safely.
- [ ] Virtualized identity is correct.
- [ ] Mutations require observed evidence before being reported as successful.
- [ ] Views obey budgets and declare omissions.
- [ ] Screenshots match revisions.
- [ ] Unsafe evaluation is absent by default.
- [ ] The stock stdio transport passes official-client protocol, tool-catalog,
  EOF, signal-cleanup, and stale-reference tests.
- [ ] p50/p95 latency and payload metrics are recorded and regression-tested.

## Foundation

### BIR-001 — Record architecture, implementation plan, and TDD board

- [x] Document the BrowserIR product boundary and Playwright backend decision.
- [x] Document the sensor-to-IR-to-view-to-action pipeline.
- [x] Document the initial MCP tool surface and unsafe-evaluation policy.
- [x] Record milestone acceptance gates.
- [x] Establish red-green-refactor and Definition of Done policies.

Artifacts: `docs/ARCHITECTURE.md` and `docs/KANBAN.md`.

### Existing foundation — fixture application

- [x] A realistic SQLite-backed dealer management fixture exists.
- [x] Fourteen workflows begin failing on a fresh database.
- [x] Completion is verified through database state and audit history.
- [x] Browser-driven tests cover the existing complex interaction patterns.

The fixture is BrowserIR's acceptance and regression environment. It is not the
BrowserIR product itself.
