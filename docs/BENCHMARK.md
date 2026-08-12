# BrowserIR benchmark methodology

## Status

BrowserIR's central claim is about representation quality: give an AI model enough reliable information to choose and execute the next action, while keeping the representation compact. That claim requires two separate measurements:

1. Did the agent complete the task in the real application?
2. Did the representation expose the right entities, capabilities, and relationships at an acceptable payload cost?

The repository contains the measuring components, not a published comparative result. It currently includes:

- a deterministic ERP/DMS fixture with 14 database-backed task oracles;
- representation, identity, omission, payload, and task-outcome metrics;
- sample statistics and seeded bootstrap quantile intervals;
- deterministic JSON, NDJSON, Markdown, and JUnit report renderers;
- environment-matched latency and payload regression gates;
- an executable BrowserIR observation runner covering seven representative fixture screens;
- an executable, checked-in representation ground-truth corpus covering choice technologies, semantic labels, table/grid structure, identity, and omission accounting; and
- an optional LangChain/BrowserIR agent runner with deterministic database/audit
  judging and per-attempt Wilson score reporting.

There is no built-in competitor adapter and no published BrowserIR, sealed
real-model, or competitor baseline. The optional agent runner can execute a
LangChain `createAgent` loop. Local Ollama development diagnostics exist. Drop
01 v1 also began, but the operator stopped it after nine complete blocks plus a
completed tenth control arm while treatment was in flight; that prefix has no
score or interval. No sealed or public real-model or competitor result has been
published. The
checked-in fake-model vertical slice validates the harness rather than model
generalization. The official-client 14-task runner uses a deterministic
reference planner to qualify representation and action reachability; it also
does not measure model generalization. The checked-in representation corpus
qualifies the declared supported cases only; it is not evidence about every
modern or legacy UI pattern. Do not interpret passing unit tests or a short
local characterization run as a comparative release result.

## Fixture and task oracles

The fixture is a server-rendered dealership management system backed by SQLite. By default it creates an in-memory database with seed `20260728`, 5,000 customers, and 12,000 vehicles. The default application credentials are the disposable fixture account `test` / `test`.

The 14 task IDs are:

1. `create-customer`
2. `raise-credit-limit`
3. `validation-recovery`
4. `mark-order-delivered`
5. `highest-revenue-poland`
6. `reserve-cheapest-in-stock`
7. `order-through-wizard`
8. `find-vin-deep-in-inventory`
9. `bulk-cancel-drafts`
10. `reschedule-appointment`
11. `restock-low-part`
12. `settle-invoice`
13. `triage-ticket`
14. `query-three-conditions`

Together they exercise authentication, forms, server validation and recovery, pagination, filtering and sorting, virtualized content, delayed autocomplete, portal content, a multi-step wizard, bulk selection, hidden-until-selected controls, drag-and-drop and keyboard alternatives, a spatial schedule, a category tree, derived values, double-click inline editing, and dynamically added condition rows.

An oracle reads database state rather than page text. Mutation tasks also inspect the audit log, so an agent cannot pass because the requested value happened to exist in the seed. Outcomes are `passed`, `failed`, or `not_applicable`; not-applicable tasks are excluded from the pass-rate denominator rather than counted as passes.

The following fixture control endpoints exist for explicit local-development
use, but are disabled by default:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/tasks` | Return task IDs, prompts, and skill tags. |
| `GET /api/tasks/{id}/verify` | Grade one task against the current database. |
| `GET /api/tasks/verify` | Grade every task against the current database. |
| `POST /api/reset` | Restore deterministic seed state and clear sessions and jobs. |

Start the fixture locally with:

```sh
pnpm --filter @think-dom/fixture-app start
```

The default origin is `http://127.0.0.1:8990` unless `PORT` is set.
Pass `--enable-control-api` (or set `FIXTURE_CONTROL_API=1`) only when a local
external harness genuinely needs those endpoints. Never expose them on the
agent-visible origin of a scored run. The built-in agent target leaves them
disabled and invokes the oracle through its private database reference.

## Isolation protocol

Every measured task attempt must be isolated. The preferred protocol is a new fixture process, in-memory database, BrowserIR browser session, and agent conversation for each attempt. At minimum, an external harness must perform all of the following:

1. Start or reset the fixture to the declared seed.
2. Confirm every oracle reports failure on the fresh default database. A fresh-state pass is an invalid fixture.
3. Create a new browser context with the declared profile.
4. Give the agent only the selected task prompt, permitted MCP tools, and declared policy.
5. Do not expose oracle implementation, database access, expected record IDs, or audit data to the agent.
6. Run the task within predeclared time, action, and model-token limits.
7. Stop agent activity before calling the oracle.
8. Record the complete oracle outcome and reason, including failures and not-applicable results.
9. Close the browser and fixture even when setup, the agent, or verification fails.

Do not execute the 14 tasks sequentially against one mutated database. One task can alter the target set or audit expectations of another.

The `runScenario` library primitive supports per-iteration `setup` and `teardown`, excludes warmups from measured samples, and runs teardown after failures. The caller is responsible for using those hooks to create and destroy the database, browser, and agent state; the library does not do that automatically.

## Task-completion measurement

For each attempt, record:

- task ID and skill tags;
- `passed`, `failed`, or `not_applicable`;
- the oracle reason;
- total elapsed time;
- model and tool-call counts;
- input, output, and cached model tokens when available;
- BrowserIR action outcomes, including blocked and dispatched-but-unverified actions;
- retries, timeouts, crashes, and policy denials; and
- route variants when the task records them, such as drag versus keyboard.

`aggregateTaskOutcomes` reports total, applicable, passed, failed, not-applicable, and applicable pass rate. If every task is not applicable, pass rate is `null`, not 100 percent.

Publish every attempt, not only successful runs. Stochastic agent results should use multiple independent run IDs per task; do not place repeated attempts under one task ID in a single `createEvaluationReport`, because duplicate task IDs are rejected.

## Representation ground truth

A representation case needs a technology-neutral ground-truth key for each decision-relevant fact. Stable benchmark keys describe logical controls or records and are independent of BrowserIR's runtime entity allocation.

For every case, declare:

- expected entities;
- expected `(entity, capability)` pairs;
- expected `(from, relation, to)` triples;
- cases where the correct result is to abstain;
- logical identities that should survive a rerender or source-node replacement;
- known omissions caused by clipping, virtualization, access boundaries, or budgets; and
- the exact model-facing payload being measured.

Ground truth must not encode one implementation's DOM shape. Equivalent native HTML, explicit ARIA, roleless custom elements, open Shadow DOM, server-rendered replacement, and portal layouts should share semantic keys when they present the same interaction.

## Representation metrics

`measureRepresentation` scores sets rather than DOM positions:

| Metric family | Definition |
| --- | --- |
| Entity precision | Correct observed entities divided by all observed entities. |
| Entity recall | Correct observed entities divided by all expected entities. |
| Capability precision/recall/F1 | Set quality over `(entity, capability)` pairs. |
| Relation precision/recall/F1 | Set quality over `(from, kind, to)` triples. |
| Correct-abstention precision | Required abstentions divided by all claimed abstentions. |
| Correct-abstention recall/rate | Required abstentions correctly made divided by all required abstentions. |

False positive relationships and capabilities are especially costly because they invite the model to take a wrong action. Publish raw true-positive, false-positive, and false-negative counts alongside ratios.

`measureIdentityStability` compares a baseline and later observation by logical key. It reports stable, changed, missing, and added identities. A stable entity ID is only correct when the underlying business entity is still the same; preserving an ID for a recycled virtual row is an identity error, not success.

`measureOmissionAccounting` compares known and reported omission counts by category. It reports accounted, unreported, and over-reported omissions plus precision, recall, F1, and an exact flag. Inaccessible or off-DOM content must be reported as omitted or unknown rather than represented as an empty interface.

## Payload measurement

`measurePayload` reports:

- Unicode code-point count;
- UTF-8 byte count; and
- an approximate token count of `ceil(unicode-code-points / 4)`.

The approximation is for planning only. Any comparison that names a particular model must also record that model's exact tokenizer version and exact token count over the complete MCP content delivered to the model, including compact text, structured content, omissions, and transport wrappers.

Never compare one system's compact model payload with another system's internal graph or debug dump.

## Latency statistics

Each timed scenario records measured samples after declared warmups. The built-in
`observe-warm/` scenarios navigate and settle once per isolated target before
the runner starts, then execute warmup and measured `observe` calls against that
same settled document. Navigation, settling, and sign-in are outside every
sample; no page reload occurs between warm or measured observations.
`summarizeSamples` reports:

- count;
- minimum and maximum;
- p50 and p95 using Hyndman-Fan type-7 quantiles; and
- median absolute deviation.

The executable performance summary also stores deterministic 95 percent
percentile-bootstrap intervals for p50 and p95. Each interval uses 2,000
resamples with checked-in seeds, and the JSON records the confidence level,
iteration count, and seed so the result can be reproduced exactly.

For release characterization, use at least 5 warmups and 30 measured samples per deterministic representation scenario. Keep task-agent success trials separate from low-level latency samples because model and network variance dominate browser representation time.

`bootstrapQuantileInterval` is also available to custom harnesses. Its defaults
are 95 percent confidence, 2,000 bootstrap iterations, and seed `0x42524952`.

## Environment and reproducibility metadata

`environmentFingerprint` is a SHA-256 hash of canonical environment JSON. The required structure records:

- operating-system platform, release, and architecture;
- Node.js and pnpm versions;
- Playwright and Chromium versions;
- headless mode;
- viewport and device scale factor.

The full environment artifact also preserves source revision and dirty-worktree
state. Those provenance fields are deliberately excluded from the comparison
fingerprint: a candidate necessarily has a different revision from its
baseline, while the operating system, runtime, browser, profile, hardware, and
workload conditions must still match.

Add the following metadata to every published run:

- UTC start time and unique run ID;
- git commit and whether the worktree was dirty;
- BrowserIR package versions and benchmark schema version;
- CPU model, logical core count, memory, and container or VM limits;
- fixture seed, customer and vehicle counts, and configured artificial latency;
- browser locale, timezone, color scheme, reduced-motion setting, and cache state;
- task ID or representation scenario ID;
- warmup and measured-sample counts;
- timeout, action, payload, and token budgets;
- agent implementation, model provider, exact model version, sampling settings, and system prompt hash;
- MCP protocol version and a hash of the advertised tool schemas;
- exact tokenizer and measured input/output tokens when available;
- network policy and whether external requests were cached or mocked; and
- all retries, excluded samples, failures, and exclusion reasons.

Environment fingerprints must match exactly before performance runs are compared. If metadata that can materially affect latency or payload changes, create a new baseline rather than overriding the fingerprint.

## Gates

### Implemented regression gates

`compareBenchmarkRuns` first requires matching benchmark schema versions and exact environment fingerprints. A missing baseline scenario fails the candidate. The default per-scenario thresholds are:

| Measure | Candidate fails when |
| --- | --- |
| p50 latency | Increase is greater than 20 ms and greater than 15 percent. |
| p95 latency | Increase is greater than 50 ms and greater than 25 percent. |
| payload bytes | Increase is greater than 5 percent. |

The latency test intentionally requires both the absolute and relative limit, avoiding noise-driven failure on tiny baselines. Payload growth uses the relative limit alone.

### Representation release gates

`evaluateRepresentationReleaseGate` enforces the following policy over an aggregate supported-scope ground-truth run. It also rejects missing identity or omission evidence and empty entity, capability, relation, or abstention fact classes, preventing a perfect zero-denominator score from qualifying a release.

| Measure | Gate |
| --- | ---: |
| Entity precision | at least 99 percent |
| Entity recall | at least 95 percent |
| Capability precision | 100 percent |
| Capability recall | at least 95 percent |
| Relation precision | 100 percent |
| Relation recall | at least 95 percent |
| Correct-abstention precision | 100 percent |
| Correct-abstention recall | 100 percent |
| Identity stability for declared stable keys | 100 percent |
| Omission accounting | exact, with zero unreported omissions |

Cases outside the declared 0.1 supported scope remain in the report as failures, abstentions, or unsupported cases; they must not be silently deleted to satisfy a gate. A future change to these thresholds requires a benchmark schema or policy revision and cannot rewrite historical results.

Task completion is reported separately. Do not average task pass rate with representation F1 or trade a representation false positive against a completed task.

## Executable observation benchmark

The built-in runner starts an isolated deterministic fixture and browser session
for each configured screen, signs in through BrowserIR actions, navigates to the
target once, and waits for it to settle once. It then runs the declared warmups
and records raw, untrimmed durations for repeated `observe` calls without
reloading. Scenario IDs begin with `observe-warm/` so these steady-state results
cannot be confused with navigation, cold-load, or lifecycle measurements. The
default targets are customers, virtualized vehicles, draft orders, the workshop
schedule, parts, the query builder, and the staged dashboard. The fixed browser
profile is 1440 x 900 CSS pixels, scale 1, light color scheme, reduced motion,
`en-US`, and UTC.

Run the release-characterization profile from the workspace root:

```sh
pnpm benchmark
```

Prevent host sleep or suspension for the entire run. On macOS, an unattended
local characterization can be run as `caffeinate -i pnpm benchmark`; CI runners
need the equivalent uninterrupted execution guarantee. Suspension time is
correctly retained as wall latency in the raw samples, so an interrupted run
can still complete but is not suitable as a baseline or comparison. Before
using any result, inspect the command elapsed time and scenario maxima as well
as p50/p95, and repeat the run if they show an environmental interruption.

The defaults are 5 warmups and 100 untrimmed measured samples per target. A shorter smoke run can be used while developing:

```sh
pnpm benchmark -- --warmups 1 --samples 3 --output output/benchmarks/quick
```

Use `--run-id <candidate>` to put a stable, filesystem-safe candidate ID in
the JSON and Markdown reports. The command generates a timestamped ID when the
option is omitted.

Use `--target <scenario-id>` repeatedly to select targets (for example,
`--target observe-warm/vehicles-12000-virtualized`),
`--max-characters <count>` to change the representation budget, and `--headful`
only for diagnosis. Relative output paths are resolved from the workspace root.
The runner creates the output directory and writes files with create-only
semantics, so it refuses to overwrite an existing artifact.

This runner characterizes BrowserIR observation cost and payload size. It does
not constitute task-completion evidence, representation ground truth, a
selected release baseline, a regression comparison against a prior run, or a
competitor comparison. CI requires this characterization so the raw samples
and environment travel with each candidate; dossier assembly checks report
presence and integrity, not a performance-superiority threshold.

## Executable representation ground truth

The release corpus drives the public BrowserIR runtime with real Chromium. Its logical keys are independent of runtime entity IDs, and equivalent native HTML, ARIA, roleless custom controls, and open Shadow DOM choice controls reuse the same semantic contract. It also covers exact and cross-tree labels, ambiguous-label abstention, native tables and ARIA grids with nested actions, stable node replacement versus recycled-record identity, and exact table scan-cap omissions.

Run it from the workspace root:

```sh
pnpm benchmark:representation
```

For an explicitly named immutable candidate directory:

```sh
pnpm benchmark:representation -- --run-id rc-1 --output output/benchmarks/representation-rc-1
```

The command exits non-zero if any corpus case or the aggregate representation release gate fails. It writes create-only `representation-report.json`, `representation-report.ndjson`, `representation-report.md`, `representation-report.junit.xml`, and `model-payload.ndjson`. If a write fails, files created by that attempt are removed and any pre-existing collision is preserved.

## Reports

`createEvaluationReport` produces benchmark schema version `1.1.0`, sorts tasks by ID, rejects duplicate IDs, and accepts caller-supplied metadata. Version 1.1 adds warmup counts and seeded p50/p95 confidence intervals to performance summaries. Available renderers are:

- `renderEvaluationJson`
- `renderEvaluationNdjson`
- `renderEvaluationMarkdown`
- `renderEvaluationJUnit`

The observation CLI writes `environment.json`, `summary.json`, `samples.ndjson`, and `summary.md`. The representation CLI writes deterministic evaluation JSON, NDJSON, Markdown, and JUnit plus the exact ordered model payloads; its JSON metadata contains the full environment record and fingerprint. Local `output/` is ignored by git. Preserve immutable report artifacts, raw samples, ground truth, prompts, tool schemas, and the exact harness commit for any published result.

The observation environment records its methodology, exact target IDs, warmup
and sample counts, representation budget, fixture seed and data sizes, and artificial latency. The
representation environment records its corpus version and exact scenario IDs.
Both preserve BrowserIR package versions as source provenance.

For release CI, the task, representation, and observation CLIs run inside the
create-only evidence recorder. Their native reports are copied into
checksummed fragments alongside command logs and source/runtime metadata. The
release dossier accepts only the complete nine-fragment matrix from one clean,
source-bound CI run. See [Release evidence](RELEASE_EVIDENCE.md). Raw benchmark
reports remain the measurement record; the dossier adds provenance and
integrity checks without changing their benchmark meaning.

Validate the current benchmark primitives with:

```sh
pnpm --filter @browserir/benchmark test
pnpm --filter @browserir/benchmark typecheck
```

## Executable agent benchmark

The optional agent runner gives a LangChain `createAgent` loop only the safe
BrowserIR MCP catalog and one task prompt. Each attempt gets a fresh seeded
fixture, browser runtime, MCP context, and conversation. The runner verifies a
failing baseline, enforces time/tool/model-turn budgets, revokes agent access,
and then grades the sealed database, audit log, and trusted
`benchmark_submit_result`. Invalid attempts are reported separately; 95% Wilson
intervals exclude invalid attempts from their denominators.

Run a selected real model only after configuring its provider credential:

```sh
pnpm benchmark:agent -- \
  --model MODEL_ID \
  --task create-customer \
  --trials 1 \
  --run-id local-agent-1
```

Text-only tool results are the default. `--multimodal` forwards screenshot
bytes as a separate, predeclared profile; `--headful` is diagnostic and is also
a different environment. The current target runs attempts sequentially in the
benchmark process, so it needs per-attempt worker/container isolation before it
can be used as a hosted scoring service. Local Ollama development diagnostics
exist, but no sealed or public real-model or competitor baseline has been
published.

See [Agent benchmark](AGENT_BENCHMARK.md) for the trust boundary, deterministic
judge contract, trial schedule, interpretation, report artifacts, and current
limitations.

## Official MCP task qualification

Run all 14 dealership tasks from the workspace root through the stock MCP tool
surface and the official MCP client:

```sh
pnpm test:qualification -- --run-id rc-1
```

Use `--output output/qualification/rc-1` to select an explicit artifact
directory. Relative output paths resolve from the workspace root. Each task gets
a fresh worker process, default-size fixture database, browser, BrowserIR
runtime, MCP server, and MCP client context. The deterministic reference planner consumes only
BrowserIR observations and opaque entity references: it does not use selectors,
page evaluation, or database reads. The database-backed oracle runs only after
the task's browser and MCP context have closed.

The command writes create-only `qualification-report.json` and
`qualification-report.md`, including all task outcomes, oracle reasons,
diagnostics, durations, and isolation metadata. If either artifact already
exists, the command preserves it and removes only files created by the failed
write attempt. It exits non-zero unless all 14 outcomes are `passed`. This
qualification is intentionally outside the bounded default `pnpm test` run.

## Fair comparisons

A cross-system comparison is valid only when every system receives:

- the same task prompt and starting database;
- the same model and sampling configuration;
- the same browser engine, viewport, locale, timezone, and network policy;
- equivalent action, time, and token budgets;
- the same success oracle, with no page-derived self-reporting;
- equivalent opportunity to retry; and
- full disclosure of system-specific tools and preprocessing.

Tool surfaces do not need to be identical, but their differences and resulting token cost must be reported. Failed setup, tool crashes, blocked actions, and unsupported tasks remain results. Do not tune prompts on the test set, run one system until it succeeds, or publish only favorable slices.

BrowserIR comparisons use matched blocks with a fresh target and conversation
for each arm. The intervention must be named precisely—currently the complete
official Playwright MCP interface versus the complete BrowserIR MCP interface—
and the same neutral agent prompt and configuration must be verified from
recorded hashes. Arm order is counterbalanced from a committed seed.

Development tasks may be used to repair adapters and general BrowserIR defects.
The sealed task slice may not be used as an iterative tuning set. A negative
sealed result remains published; a post-fix rerun of that task is labelled an
adaptive follow-up, and independent confirmation moves to a previously
unmeasured slice. The full lifecycle and claim rules are in
[the evidence-drop protocol](EVIDENCE_DROPS.md).

For Drop 01, the aborted v1 prefix exposed a general model-facing schema defect:
the model stringified the nested BrowserIR action object, and LangChain rejected
it before broker dispatch. The flat action/wait contract was checked with two
score-excluded canaries on the already-seen development workflow. Adaptive v2
therefore reuses v1's exact 30 seeds and arm order but restarts every arm from
fresh state. It is not independent confirmation, and no v1 arm or partial
statistic is carried into the v2 result.
