# BrowserIR agent benchmark

## Purpose and status

The agent benchmark measures end-to-end task completion: can a model, given a
task prompt and only the safe BrowserIR MCP surface, change an application into
the required business state and return any required result? It complements the
representation benchmark; it does not replace it. A task can fail because of
the model, the agent loop, BrowserIR's representation, an action, or the target
application, while the representation corpus isolates what BrowserIR exposed.

The repository currently provides:

- a reusable agent-benchmark runner and report schema;
- a LangChain `createAgent` adapter over BrowserIR MCP tools;
- an isolated, seeded dealership fixture target with 14 database-backed
  oracles;
- a trusted structured-result tool, browser-navigation policy, and hard time,
  tool-call, and model-turn budgets;
- 95% Wilson score intervals over valid binary attempts; and
- a deterministic fake-model vertical slice that drives real Chromium through
  the MCP client and passes a sealed database/audit oracle.

Local Ollama real-model development diagnostics have run, including one
one-block BrowserIR treatment-path win on the already-seen, score-excluded
`create-customer` task; official Playwright MCP failed that block without
submitting. That is not an official-control capability pass. A dedicated
score-excluded control qualification is implemented, but its five-attempt run
has not started and no provider key or paid model spend has been used for it.
No sealed real-model result, public competitor comparison, or generalization
result has been run or published. The deterministic fake-model test validates
benchmark wiring and grading, not model capability or generalization. The
current CLI is suitable for local development and characterization; it is not
yet a hardened public scoring service. See the
[development feedback ledger](EVIDENCE_DROPS.md#development-feedback-ledger).

## What is a scored target?

A canonical score must run against an application BrowserIR controls: an owned,
versioned, resettable fixture deployment or a pinned local/container build of
that fixture. Its application build, seed, task contract, oracle version,
browser profile, and dependencies must be immutable for the run. The default
fixture seed is `20260728`, with 5,000 customers and 12,000 vehicles. The
published fixture account is `test` / `test`.

An "open-access website" is useful only when open access means every evaluated
agent receives the same public application plane without privileged state or
oracle access. A mutable third-party website is not a deterministic scored
target: content, experiments, authentication, rate limits, consent screens,
anti-bot systems, and business rules can change without a benchmark version
change. Such sites may be run as clearly labelled **live probes**, but their
results must not enter the official pass rate, gate a release, or be compared
with a pinned fixture score.

For every scored task, the target version is a SHA-256 digest over the suite
version, MCP protocol version, normalized fixture and browser profiles,
headless/headful mode, disabled-control-API policy, audit-guard policy, and
oracle versions. Each task also carries a digest of its prompt, skill tags, and
oracle version. A mismatch invalidates the attempt before the agent runs.

## Trust boundary

The benchmark has four separate roles:

| Role | May see | Must not see |
| --- | --- | --- |
| Agent | Task prompt, target origin, advertised BrowserIR tools and their results | Database, audit oracle, expected IDs, reset/verify APIs |
| BrowserIR broker | Browser actions and model-facing MCP responses | Judge implementation and expected answer |
| Target application | Normal application requests | Model conversation and score calculation |
| Judge | Sealed database state, audit log, structured submission, task oracle | Agent self-assessment as evidence of success |

The agent receives exactly the nine safe BrowserIR MCP tools:
`browser_create`, `browser_navigate`, `browser_observe`, `browser_inspect`,
`browser_act`, `browser_wait`, `browser_pages`, `browser_capture`, and
`browser_close`. The benchmark rejects an unexpected catalog. Unsafe page-code
evaluation is not enabled. Direct navigation is restricted to the attempt's
origin, `/`, and `/app/` paths.

The fixture's `/api/tasks`, `/api/tasks/{id}/verify`,
`/api/tasks/verify`, and `/api/reset` control endpoints are disabled by default.
They exist only as an explicit local-development option; they must never share
the agent-visible origin in a scored or hosted run. The in-process target calls
the task oracle directly through a private database reference.

## Attempt lifecycle

Every `(task, trial index)` is one fresh attempt. The runner executes
attempts sequentially and performs this lifecycle:

1. Create a fresh in-memory database and HTTP fixture instance from the pinned
   seed and profile.
2. Create a fresh BrowserIR runtime, Playwright backend, and MCP handler/client.
3. Check the target and task versions.
4. Run the private oracle before prompt dispatch. The baseline must fail; an
   already-passing or indeterminate baseline makes the attempt invalid.
5. Create a fresh agent conversation and give it only the task prompt, origin,
   safe tool broker, and declared budgets.
6. Let the agent retry within the same attempt and the same budgets. Never
   restart an attempt merely because it failed.
7. Close the agent, MCP/browser broker, and public fixture listener. This
   revokes agent access and crosses the in-flight server-close barrier.
8. Run the final deterministic oracle against the now-sealed database and
   audit log, including the trusted structured submission where required.
9. Record the complete attempt, including failures and invalid attempts, then
   dispose the target.

The canonical database fingerprint hashes the schema and every row of every
application table in deterministic order. It binds the baseline and final
state to the report, but the fingerprint alone is not the judge.

## Deterministic success criteria

The model's final prose and any adapter-provided `submittedResult` field are
untrusted. They never make an attempt pass. A pass requires all of the
following:

1. The baseline was valid and failed the task oracle.
2. The agent ran to completion within the declared execution budgets.
3. No navigation-policy violation occurred.
4. The agent called `benchmark_submit_result` exactly once with a payload that
   matches the task's public JSON Schema.
5. The sealed database-and-audit oracle passed every required criterion.
6. The entire post-baseline audit delta exactly matched that task's declared
   action-count contract; missing, unrelated, and repeated same-action mutations
   all fail.
7. For a task that asks the agent to report a business identifier, the submitted
   answer exactly matches the value derived privately by the deterministic
   judge.

`benchmark_submit_result` is injected by the trusted harness rather than the
BrowserIR MCP server. Mutation-only tasks submit `{}` to confirm completion.
Tasks that request a customer number or VIN submit `{"answer":"..."}`. Schema
validation is public; the expected value and validator implementation remain
private. Missing, duplicate, malformed, or incorrect submissions fail even if
the model says it succeeded.

Judging reads database state and the audit log, not page text, screenshots,
OCR, an LLM-as-judge score, or the agent's success claim. Audit evidence is
required for mutations so seed state cannot accidentally count as an action.
Each oracle returns an ordered list of required criteria, its version, state
fingerprint, reason, and diagnostic evidence.

Outcomes are classified as follows:

- `passed`: every required rule above passed;
- `failed`: an agent timeout or error, exceeded tool/model budget, policy
  violation, missing/invalid/incorrect submission, or failed business oracle;
- `invalid`: infrastructure or benchmark integrity could not support a score,
  such as target setup/version failure, a passing or invalid baseline, judge
  failure, or incomplete sealing/cleanup.

Invalid attempts are always published separately and excluded from the binary
pass-rate denominator. They must never be converted into passes, silently
discarded, or rerun until a favorable sample appears. Pre-agent infrastructure
failures may be replaced only under a predeclared invalid-attempt policy, with
both the original invalid record and replacement disclosed.

## Agent implementation

The library adapter accepts any LangChain `BaseChatModel`. It converts the
JSON Schemas advertised by the MCP server into LangChain tools and creates the
loop with [`createAgent`](https://docs.langchain.com/oss/javascript/langchain/agents),
which is built on LangGraph. BrowserIR is not coupled to LangChain or LangGraph;
only the private benchmark package uses them. Provider initialization remains
outside the adapter.

The checked-in command currently supplies LangChain's OpenAI chat-model adapter.
It requires an explicit model ID and the provider credentials expected by that
adapter. There is deliberately no default model. The agent system-prompt hash,
framework version, model ID, model configuration, and image profile are stored
in attempt metadata.

The adapter is generic: it contains no fixture task IDs, selectors, expected
records, control URLs, database queries, or oracle logic. Ordinary BrowserIR
characterization may use the BrowserIR-specific prompt. Paired comparison uses
one exported neutral prompt for both arms; it names neither BrowserIR nor
Playwright and instructs the model to use fresh page evidence and exact target
references.

## Browser and image profile

The benchmark broker pins every `browser_create` call to 1440 x 900 CSS pixels,
device scale factor 1, `en-US`, UTC, light color scheme, reduced motion, and
headless Chromium. Caller-supplied profile values are ignored, and the fixed
profile plus headless/headful mode are bound into the target version. Headful
mode is for diagnosis and is therefore a different target version and
comparison cohort.

The adapter is **text-only by default**. BrowserIR observation text and
structured content reach the model, while a screenshot result is represented
by a deterministic notice and its binary bytes are omitted. Pass
`--multimodal` only for a predeclared multimodal profile; then screenshot bytes
returned by `browser_capture` are forwarded to the model. Text-only and
multimodal runs are different systems and must not be pooled. Record the model's
vision capability, screenshot calls, response bytes, viewport, and image
handling in every comparison.

## Budgets and retries

The current runner enforces these per-attempt hard limits from prompt dispatch:

| CLI option | Default | Meaning |
| --- | ---: | --- |
| `--max-duration-ms` | 120,000 | Wall-clock deadline for the agent run |
| `--max-tool-calls` | 100 | All tool attempts, including structured submission |
| `--max-model-turns` | 30 | LangChain model-call limit and post-run check |

The model may recover from validation errors, stale revisions, or transient UI
states only inside those limits. Retries consume the same attempt budget.
Tool errors, per-tool counts, response bytes, screenshot count, dispatched
browser actions, model turns, total attempt time, agent-loop-only time,
model-facing tool traces, and provider usage metadata are recorded when
available. Binary image bodies are represented in traces by MIME type and byte
length rather than duplicated as base64.

There is not yet a hard token or monetary-cost budget in the runner. A
publication must disclose that limitation and report provider token usage where
available; a fair cross-system score additionally requires identical token and
cost policies. Do not describe model-turn count as token control.

Budget values are part of the benchmark protocol. Changing one creates a new
schedule and comparison cohort rather than retroactively changing an old score.

## Statistics and trial schedule

The official outcome is binary per valid attempt. Partial criteria and oracle
evidence are diagnostic only; they are not blended into a subjective score.
The reporter publishes pass count, valid-attempt count, pass rate, and a
two-sided 95% Wilson score interval overall and for each task. Invalid attempts
are excluded from the Wilson denominator but remain in the artifacts.

One trial is a smoke test, not an agent-quality estimate. Precommit the task
set, order, trial count, model configuration, budgets, and stopping rule before
running. A practical development schedule is five fresh attempts per task.
Public characterization should normally use at least 30 attempts per task
unless a power analysis justifies another number. Fresh state and distinct
precommitted model seeds prevent accidental replay, but they do not by
themselves prove independent sampling from a broader population.

The current report publishes both a micro-average across all valid attempts and
an equal-weight macro-average across task pass rates, so tasks with more valid
attempts cannot silently dominate. Per-task Wilson intervals are also emitted.
For paired comparisons, run every system on
the same precommitted task/trial schedule, seed/profile, model version and
sampling settings, browser, budgets, network policy, and judge. Do not stop a
system early, tune prompts on the scored set, or publish only favorable slices.

The implemented paired runner executes each `(task, trial)` as a matched block,
alternates arm order deterministically from a declared seed, creates fresh
state and conversation for each arm, rejects unequal agent/model/prompt
metadata, retains both attempts, and excludes a block from paired lift only
when either attempt is invalid. Primary arm rates use only complete paired-
valid blocks; all-attempt operational counts are separate. It reports a
boundary-valid 95% paired Hoeffding interval over treatment-minus-control block
outcomes. The conservative bound cannot report zero uncertainty merely because
all observed pairs match.

Development and sealed schedules are separate. Adapter, prompt, and BrowserIR
changes use declared development tasks. A sealed comparison starts only from a
committed frozen protocol and is never tuned or stopped after observing its
score. See [the evidence-drop protocol](EVIDENCE_DROPS.md).

## Score-excluded official-control qualification

Before freezing a paired uplift protocol, BrowserIR has a narrow compatibility
question to answer: can the selected real-model configuration complete at
least one deterministically judged workflow through the pinned official
Playwright MCP control? The dedicated qualification answers only that question.
It is deliberately outside the Drop 01 score and has these fixed boundaries:

- it runs only official Playwright MCP, with no BrowserIR treatment arm;
- it uses `create-customer`, an already-seen development task, while the
  reserved `validation-recovery` task remains untouched;
- it runs all five precommitted attempts, with no early stop, favorable rerun,
  or invalid-attempt replacement;
- `demonstrated` requires five completed attempts, zero invalid attempts, and
  at least one exact database/audit/submission pass; and
- publication is limited to raw `x/5` outcome counts. The result is not a
  score, uplift estimate, pass-rate estimate, or evidence of generalization.

The minimal gate has no resume mode. An interrupted schedule cannot qualify,
and a later invocation is a separate run rather than a silent continuation or
replacement. This is intentionally stricter than the resumable paired
development runner.

The protocol-bound implementation is present, but the real-model schedule has
not been executed. No provider credential or model spend has been used for this
qualification yet.

## Running locally

The real-model CLI is optional and incurs the selected provider's normal usage
cost. Configure the provider credential outside the repository, then run from
the workspace root with an exact model version:

```sh
pnpm benchmark:agent -- --model MODEL_ID --run-id local-agent-1
```

For a small, explicit development run:

```sh
pnpm benchmark:agent -- \
  --model MODEL_ID \
  --task create-customer \
  --trials 1 \
  --max-duration-ms 120000 \
  --max-tool-calls 100 \
  --max-model-turns 30 \
  --run-id local-create-customer
```

Use `--output <directory>` for a create-only artifact directory, `--headful`
for visible diagnosis, and `--multimodal` for the separate screenshot-capable
profile. The command writes `report.json`, `attempts.ndjson`, `summary.md`, and
`SHA256SUMS`; it refuses to overwrite existing artifacts. Inspect the report
outcomes: the current command writes failed attempts as valid measurement data
and does not use task failure alone as a process error.

The deterministic harness vertical slice can be run without a paid model:

```sh
pnpm --filter @browserir/benchmark exec vitest run \
  tests/agent-benchmark-langchain.e2e.test.ts
```

It uses LangChain's scripted fake model to perform one known customer-creation
trace through real Chromium and the real MCP transport. Passing proves the
agent adapter, schema conversion, tool loop, target sealing, structured
submission, and database/audit judge connect correctly. Because its decisions
are scripted, it is not an LLM benchmark result.

The score-excluded official-control qualification accepts only a committed
protocol plus a create-only output directory. Run it from a clean worktree and
keep its evidence outside the repository so source identity remains stable:

```sh
pnpm benchmark:control-capability -- \
  --protocol docs/evidence-drops/drop-01/control-capability-v1.protocol.json \
  --output /absolute/external/path/drop-01-control-capability
```

Configure the protocol's provider credential in the environment rather than in
source. The command checks the committed protocol, clean start/end source,
model metadata, target, oracle, and official-control catalog; it then retains
all five outcomes and checksummed artifacts. It does not accept task, model,
schedule, budget, stopping-rule, or decision-rule overrides.

The matched comparison is driven only by a protocol manifest; scored settings
cannot be overridden on the command line:

```sh
pnpm benchmark:uplift -- \
  --protocol docs/evidence-drops/drop-01/development-v7.protocol.json \
  --output output/benchmarks/drop-01-development-local
```

An interrupted create-only development run resumes from its retained journal
and exact preflight artifacts:

```sh
pnpm benchmark:uplift -- \
  --protocol docs/evidence-drops/drop-01/development-v7.protocol.json \
  --resume output/benchmarks/drop-01-development-local
```

Completed arms are not rerun. An interrupted in-flight arm is recorded and its
matched block remains invalid for uplift even if the unfinished arm is retried.

The command validates task, oracle, target, endpoint-reported model digest, context window,
interface versions, and model-facing tool catalogs before the first agent call.
A sealed manifest additionally requires a precommitted model-seed base and a
non-zero stochastic temperature. Both arms in a matched task/trial block
receive the same derived seed, and a regression test checks the actual
OpenAI-compatible invocation parameters rather than metadata alone.

Sealed runs use the outer launcher rather than the development command:

```sh
pnpm benchmark:uplift:sealed -- \
  --protocol docs/evidence-drops/drop-01/sealed.protocol.json \
  --output /absolute/external/path/drop-01
```

The launcher checks out the manifest's freeze tag into a fresh detached
temporary clone, installs the frozen lockfile, builds before the benchmark CLI
can import BrowserIR, and keeps the evidence directory outside that checkout.
Child processes receive an isolated home/config/cache and a small allowlisted
environment; ambient Node loader/preload variables and API secrets are not
inherited. Sealed Ollama endpoints must be literal HTTP loopback URLs and
redirects are rejected. The retained digest is explicitly an endpoint report,
not an independent proof of model weights.
The inner runner then requires a clean tagged source tree, exact start/end Git
identity, and byte-identical start/end manifests for the built core,
Playwright-driver, and MCP packages. Resume repeats those checks before another
scored attempt; drift fails closed.

## Required publication artifacts

A result intended for comparison must preserve:

- every attempt, including invalids and failures;
- exact task and target version digests, prompt text, oracle versions, and
  fixture profile;
- source commit, dirty state, dependency lock, Node, Playwright, Chromium,
  operating system, hardware/container limits, locale, timezone, viewport,
  headless mode, and network policy;
- full advertised tool schemas and their catalog digest;
- system-prompt hash, agent/framework versions, exact model/provider version,
  sampling configuration, image profile, and provider usage records;
- budgets, schedule, retries, errors, policy denials, and invalid-attempt policy;
- the baseline and final criterion results and state fingerprints; and
- immutable JSON/NDJSON/Markdown artifacts and checksums.

Paired drops additionally preserve the protocol manifest and status, block ID,
arm role and execution order, schedule and bootstrap seeds, both complete tool
catalogs, all matched outcomes, paired interval policy, failure diagnoses, and
the exact development-versus-sealed boundary. Their create-only artifact set
also retains `environment-start.json`, `environment-end.json`,
`build-provenance-start.json`, `build-provenance-end.json`,
`execution-start.json`, `journal.ndjson`, `execution.json`, and an atomic final
`COMPLETE.json` marker. Source start/end identity is embedded in the execution
artifacts; package provenance lists the exact `package.json` and `dist/` bytes
that ran.
The completion marker binds finalization to the checksum manifest and journal
tail, requires the protocol, catalogs, environment, execution endpoints, and
sealed build-provenance endpoints, and is written last. It does not prove
artifact authenticity or scientific validity by itself.

Public paired artifacts deliberately omit full page text, entered values,
structured browser payloads, model final text, and private oracle evidence
bodies. They retain outcomes, timings, counts, criteria, fingerprints, byte
counts, and content hashes. Raw traces may be inspected locally during
development but must not enter Git or a release asset.

The current single-arm report contains the attempt outcomes, criteria,
fingerprints, budgets, tool metrics and traces, agent metadata, per-task
summaries, Wilson intervals, and checksums. The paired report adds matched
blocks, paired-valid and operational arm summaries, order, protocol-bound
paired lift, create-only JSON/NDJSON/Markdown, catalogs, manifest, and
checksums. Clean-source environment qualification remains required before a
local report becomes public evidence.

## Current limitations before hosted scoring

The local target is fresh per attempt but remains **in-process and sequential**:
the fixture listener, private SQLite handle, BrowserIR runtime, MCP handler, and
runner share one Node.js process. Closing agent access is tested, but the host
does not yet provide an operating-system security boundary or a hard kill for an
uncooperative provider SDK.

Before public or multi-tenant scoring, each attempt needs its own disposable
worker process or container, resource limits, a hard wall-clock kill, and a
network boundary with two planes:

- a public application plane reachable by the browser; and
- a private control/judge plane reachable only by the harness after agent
  access is revoked.

The worker should create and verify a fresh baseline, run one attempt, terminate
all browser/model/tool activity, seal or snapshot state, judge through the
private plane, emit artifacts, and destroy itself. Hosted infrastructure must
also pin the target artifact, isolate credentials and storage per attempt,
prevent access to metadata services and unrelated networks, and distinguish
pre-agent infrastructure invalidation from an agent-caused failure.

Until those controls, token/cost policy, and a precommitted repeated real-model
run exist, the agent benchmark is local characterization rather than a release
gate or superiority claim. Paired local runs now capture and compare stable
start/end runtime environments and enforce a fixed browser profile, but they do
not provide operating-system process isolation.
