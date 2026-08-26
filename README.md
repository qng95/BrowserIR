<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/browserir-wordmark-dark.svg">
    <img src="assets/brand/browserir-wordmark.svg" width="620" alt="BrowserIR — the semantic browser layer">
  </picture>
</h1>

<p align="center"><strong>Keep Playwright. Stop making agents guess.</strong></p>

<p align="center">
  Playwright can expose every relevant label and button while still losing the
  relationship between them.<br>
  BrowserIR adds that missing edge to current Playwright refs—only when it can
  prove the complete mapping.
</p>

<p align="center">
  <strong>31/32 pass@1 vs 23/32 · 7 tasks rescued, 0 lost at the retry cap</strong><br>
  <strong>30.6% fewer model calls · 55.5% lower provider cost per success</strong><br>
  <sub>Receipt-backed Qwen3.8-27B development benchmark · 8 checked-in fixtures × 4 structural worlds</sub>
</p>

<p align="center">
  <a href="https://github.com/qng95/BrowserIR/actions/workflows/ci.yml"><img alt="BrowserIR CI" src="https://github.com/qng95/BrowserIR/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <img alt="Status: 0.1 private source alpha" src="https://img.shields.io/badge/status-0.1_private_source_alpha-7957FF?style=for-the-badge">
  <img alt="Playwright and MCP" src="https://img.shields.io/badge/backend-Playwright_%2B_MCP-38BDF8?style=for-the-badge&logo=playwright&logoColor=white">
  <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-22C55E?style=for-the-badge"></a>
</p>

<p align="center">
  <a href="#see-the-missing-edge"><strong>See it</strong></a>
  &nbsp;·&nbsp;
  <a href="#receipt-backed-results"><strong>Results</strong></a>
  &nbsp;·&nbsp;
  <a href="#what-are-the-32-tasks"><strong>Benchmark</strong></a>
  &nbsp;·&nbsp;
  <a href="#try-the-source-alpha"><strong>Try it</strong></a>
</p>

## See the missing edge

Playwright still owns the browser, public tools, actionable refs, lifecycle,
and click dispatch. BrowserIR is the thin observation layer between a semantic
snapshot and the model decision.

### Four identical buttons. One exact target.

**Task:** “Choose the open slot for **Bay 4 on Tuesday 09:30**, then stop.”

This is what the page visibly communicates:

|  | Monday 09:30 | Tuesday 09:30 |
| --- | :---: | :---: |
| **Bay 2** | <kbd>Choose open slot</kbd> | <kbd>Choose open slot</kbd> |
| **Bay 4** | <kbd>Choose open slot</kbd> | **<kbd>Choose open slot</kbd> ← target** |

A human sees the bottom-right target immediately. But the actions live in a
sibling overlay layer. Playwright's semantic snapshot keeps both row labels,
both column labels, and all four clickable refs—but not the edge that binds a
button to a cell:

| Playwright — enrichment off | BrowserIR — auto |
| --- | --- |
| Rows: `Bay 2`, `Bay 4`<br>Columns: `Monday`, `Tuesday`<br>Actions: `e21`, `e22`, `e23`, `e24`<br>Every action is named `Choose open slot`.<br><br>**Missing: button → row × column** | Same semantic snapshot under fresh refs, plus a complete mapping.<br><br>`f2e21 → Bay 4 × Tuesday 09:30`<br><br>**Exact target: click `f2e21`** |

The checked-in [`workshop-week-table` `lossy-b`
fixture](packages/benchmark/src/agent-benchmark/adaptive-qualification-fixtures.ts)
deliberately reverses DOM target order relative to visual cell order. “Click
the fourth button” is therefore the wrong shortcut. BrowserIR maps every cell
or maps none; it never gives the model a convenient partial answer.

> **What happened on the matching Qwen3.8-27B task:** With BrowserIR, the agent
> selected the exact target and passed on attempt 1. With enrichment off, it
> selected the wrong target on attempts 1, 2, and 3, then failed at the cap.
> [Inspect the raw task receipts](packages/benchmark/output/benchmarks/browserir-openrouter-real-ab-20260826T142617Z.ndjson#L45-L48).

<details>
<summary><strong>Show the exact fixture snapshot and complete BrowserIR mapping</strong></summary>

Playwright with enrichment off:

```text
- table "Workshop weekly schedule" [ref=e1]
  - row [ref=e2]
    - columnheader "Monday 09:30" [ref=e3]
    - columnheader "Tuesday 09:30" [ref=e4]
  - row [ref=e5]
    - rowheader "Bay 2" [ref=e6]
  - row [ref=e7]
    - rowheader "Bay 4" [ref=e8]
- group "Available schedule actions" [ref=e9]
  - button "Choose open slot" [ref=e21]
  - button "Choose open slot" [ref=e22]
  - button "Choose open slot" [ref=e23]
  - button "Choose open slot" [ref=e24]
```

BrowserIR returns the same snapshot under a fresh Playwright ref epoch and
appends the complete relation set:

```text
### Adaptive context
- schedule-slot [ref=f2e21] resource="Bay 4" slot="Tuesday 09:30"
- schedule-slot [ref=f2e22] resource="Bay 4" slot="Monday 09:30"
- schedule-slot [ref=f2e23] resource="Bay 2" slot="Tuesday 09:30"
- schedule-slot [ref=f2e24] resource="Bay 2" slot="Monday 09:30"
```

</details>

Across the 32 BrowserIR task identities, the task-level route audit recorded
**16 sufficient passthroughs**, **15 complete projections**, **1 safe
fallback**, and **0 demonstrated projection misses**. It added information
where the relation was recoverable and stayed out of the way everywhere else.

## Receipt-backed results

This is not a single demo: it covers 32 paired task identities, with up to
three fresh attempts per task in each mode, and the retained journal records
all 83 physical calls.

| Reliability under fresh attempts | Playwright enrichment off | BrowserIR auto | Observed lift |
| --- | ---: | ---: | ---: |
| `pass@1` — first attempt | 23/32 (71.9%) | **31/32 (96.9%)** | **+25.0 pp** |
| `pass@2` — within one retry | 24/32 (75.0%) | **31/32 (96.9%)** | **+21.9 pp** |
| `pass@3` — within two retries / final | 24/32 (75.0%) | **31/32 (96.9%)** | **+21.9 pp** |
| Failed after the cap | 8 | **1** | **7 fewer failures** |
| Tasks that entered retry | 9 | **1** | **8 fewer** |

Here `pass@k` is the observed fraction of the 32 tasks solved within the first
`k` sequential fresh attempts. `pass@1` means immediate success; `pass@2`
allows one retry; `pass@3` allows two. This is cumulative retry reliability,
not the combinatorial code-generation estimator sometimes called `pass@k`.

The retry story is unusually concrete: enrichment off spent **17 extra model
calls** to recover one additional task. BrowserIR spent **2 extra calls** on
its single unresolved task; every one of its 31 successes had already happened
on attempt 1.

### More capable when the snapshot is ambiguous. Invisible when it is enough.

| Task stratum | Playwright enrichment off | BrowserIR auto |
| --- | ---: | ---: |
| Relationship missing from the semantic snapshot | 8/16 (50.0%) | **15/16 (93.8%)** |
| Relationship already explicit in the semantic snapshot | 16/16 (100%) | **16/16 (100%)** |

On the final paired outcome, BrowserIR had **7 task wins**, enrichment off had
**0**, both solved 24, and neither solved 1. BrowserIR improved the hard stratum
without lowering the already-sufficient stratum.

### Fewer retries also meant less model and provider spend

| Operational metric | Playwright enrichment off | BrowserIR auto | Observed change |
| --- | ---: | ---: | ---: |
| Physical model calls | 49 | **34** | **30.6% fewer** |
| Model tokens per successful task | 3,576.63 | **1,879.48** | **47.5% fewer** |
| Provider cost per successful task | $0.002273 | **$0.001012** | **55.5% lower** |
| Mean active time-to-success on the 24 tasks both solved | 5.983 s | **4.894 s** | **1.089 s faster** |
| Faster task in that matched 24-task set | 7/24 | **17/24** | — |

Active task time runs from fresh fixture/browser setup through click dispatch
and exact-oracle verification; it is not model-call latency. Cost and token
coverage are 100% across all 83 physical calls.

These are descriptive results from a reused, unsealed development corpus—not
an unseen-websites generalization study. The retained receipt does not
serialize the exact product-policy version or product-source hash. Inspect the
[canonical result and checksums](docs/BROWSERIR_REAL_AGENT_RESULTS.md), [pass@k and task-time
analysis](packages/benchmark/output/benchmarks/browserir-openrouter-real-ab-20260826T142617Z-analysis.md),
or [reproduce the run](docs/BROWSERIR_REAL_AGENT_AB_RUNBOOK.md).

## What are the 32 tasks?

The benchmark contains **8 exact user tasks × 4 deterministic hidden worlds =
32 matched case-world tasks**. It is not 32 unrelated prompts or 32 websites.
Every task asks the model to make one consequential click among visually
related controls. Half of the worlds deliberately omit the relationship from
the normal semantic snapshot; the matched half preserve it through ARIA.

| Family | Exact user task | Candidates sharing one visible action label |
| --- | --- | ---: |
| Schedule coordinate | “Choose the open imaging slot for CT Suite on Thursday 10:40, then stop.” | 6 × `Choose opening` |
| Schedule coordinate | “Reserve maintenance for West service rail at 11:30, then stop.” | 6 × `Reserve window` |
| Schedule coordinate | “Choose the open slot for Bay 4 on Tuesday 09:30, then stop.” | 4 × `Choose open slot` |
| Schedule coordinate | “Assign the South crew to the 14:00 shift, then stop.” | 4 × `Assign shift` |
| Cross-tree label | “Open the batch aligned with German catalog queue, then stop.” | 2 × `Open batch` |
| Cross-tree label | “Inspect the load aligned with Cold-chain intake, then stop.” | 2 × `Inspect load` |
| Cross-tree label | “Open the case aligned with the Routine queue, then stop.” | 2 × `Open case` |
| Cross-tree label | “Review the request aligned with Finance review, then stop.” | 2 × `Review request` |

Each fixture becomes four worlds:

| World | What the normal Playwright snapshot contains | Target assignment |
| --- | --- | --- |
| `opaque-p0` | Labels and controls, but no relation between them | Base assignment |
| `opaque-p1` | The same task and semantic content, still without the relation | Fixed permuted assignment |
| `semantic-p0` | Explicit ARIA relation; Playwright is already sufficient | Base assignment |
| `semantic-p1` | Explicit ARIA relation; Playwright is already sufficient | The same fixed permutation as opaque `p1` |

`p0` and `p1` are fixed checked-in permutations, not random data. The prompt
stays the same while the opaque target behind the requested visual cell or lane
changes, so a hard-coded “first button” or DOM-order heuristic cannot solve
both worlds.

That mechanism is visible in the final score:

| World | Playwright enrichment off | BrowserIR auto |
| --- | ---: | ---: |
| `opaque-p0` | 8/8 | 8/8 |
| `opaque-p1` | 0/8 | **7/8** |
| `semantic-p0` | 8/8 | 8/8 |
| `semantic-p1` | 8/8 | 8/8 |

The remaining `opaque-p1` failure is Catalog localization: its layout did not
support a complete geometric mapping, so BrowserIR returned the original
Playwright snapshot instead of inventing an edge.

### What data did it run on?

The corpus is deterministic, synthetic browser data checked into this
repository—not scraped websites, customer sessions, or production traffic.
Every case has a fixed task prompt, page implementation, candidate target IDs,
relationship request, and `p0`/`p1` mapping. The frozen catalog version and
SHA-256 are retained in the result receipt.

Each attempt starts an in-memory SQLite database with a zeroed audit state.
After the model chooses one Playwright ref, the fixture server records the
opaque target ID. The hidden oracle awards a pass only when there is exactly
one task mutation, it hits the expected target for that world, and there are no
collateral mutations. There is no LLM judge and no credit for self-reported
success.

The exact [catalog and world generator](packages/fixture-app/src/adaptive-accuracy-holdout.ts)
and its [oracle tests](packages/fixture-app/tests/adaptive-accuracy-holdout.test.ts)
are part of the repository.

## How the matched A/B comparison works

Every one of the 32 case-world tasks ran in two matched modes:

- **Playwright enrichment off:** the same adaptive wrapper returns the official
  Playwright MCP snapshot without enrichment.
- **BrowserIR auto:** in its own fresh runtime, the wrapper reads the official
  Playwright MCP snapshot, then either returns it unchanged or appends one
  complete relation set built from a bounded, read-only recapture.

Everything else was held fixed:

| Fixed setting | Value |
| --- | --- |
| Model | `qwen/qwen3.8-27b` |
| Provider | OpenRouter `alibaba` only; fallback disabled |
| Model request | Temperature 0, reasoning `low`, maximum 512 output tokens |
| Agent decision | Same task text and one `browser_click` tool; request one click decision, then stop |
| Pairing | Same model seed for `off` and `auto` at the same task/attempt |
| Order control | Arm order alternated by task and retry attempt |
| Product policy | Host-fixed schedule or cross-tree family; the model did not select it |
| Provider retries | 0 inside a physical attempt |
| Evaluation retries | At most 2; stop each mode after its first exact-oracle pass |
| Score | Exact hidden database/audit oracle, never model self-report |

One physical attempt follows this path:

```text
fresh fixture + DB → official Playwright MCP + Chromium → login + navigate
→ snapshot → same Qwen seed → at most one dispatched click → hidden exact oracle
```

Every retry opens a new fixture process, in-memory database, Playwright MCP
process, isolated Chromium context and page, snapshot, and model response. The
model never sees a previous answer, world ID, expected target, hidden geometry,
or oracle result. The evaluator alone uses the oracle to decide whether another
fresh attempt is scheduled.

This is a representation-focused, one-decision browser-agent benchmark: the
harness performs setup and navigation, then the real model must return one
click decision using a current Playwright ref. The harness dispatches at most
one click; malformed or undispatchable responses fail the attempt. Early
stopping produced **83 physical model calls** across the two arms.

## Thin by design

BrowserIR has only three observation outcomes:

- **Already sufficient:** return Playwright's original result unchanged.
- **Provable gap:** make one read-only boxed recapture, strip every box, and add
  a complete relation set using only current Playwright refs.
- **Incomplete or changed evidence:** return the original result instead of
  guessing.

The layer performs no hidden click, navigation, screenshot, page-code
evaluation, or retry. The [product-path integration
tests](packages/playwright-mcp/tests/reference-policies.test.ts) enforce current
refs, box stripping, and complete-or-none projection.

## Try the source alpha

`@browserir/playwright-mcp` is currently a private source-alpha library, not a
published npm package or drop-in MCP server. It wraps an already-connected
official MCP `Client`; the caller continues to own the server and browser.

From a checkout with Node.js 22.13+ and pnpm 10.30.3:

```sh
npm install --global corepack@0.34.7
corepack install --global pnpm@10.30.3
pnpm install --frozen-lockfile
pnpm --filter @browserir/playwright-mcp build
pnpm --filter @browserir/playwright-mcp test
```

Then wrap the official client with one host-selected policy family:

```ts
import { createAdaptivePlaywrightTools } from '@browserir/playwright-mcp';
import { createScheduleCoordinateReferencePolicy } from
  '@browserir/playwright-mcp/reference-policies';

const tools = createAdaptivePlaywrightTools(client, {
  mode: 'auto',
  policySet: createScheduleCoordinateReferencePolicy(),
});
```

Route `listTools` and `callTool` through `tools` while the wrapper is active,
then await `tools.dispose()`. The action surface remains Playwright's. See the
[package guide](packages/playwright-mcp/README.md) and [integration
guide](docs/PLAYWRIGHT_MCP_ADAPTIVE_ALPHA.md) for the complete lifecycle
contract and prerequisites.

## Current scope

- First-party handles cover bounded grid coordinates, schedule coordinates,
  and cross-tree labels. The real-agent result covers schedule and cross-tree
  fixtures only.
- The host selects exactly one policy family. `auto` is not a prompt-driven
  router across arbitrary page types.
- An eligible default snapshot may trigger at most one hidden, read-only boxed
  snapshot. Unsupported or incomplete cases fall through unchanged.
- The 32-task result is favorable development evidence on local challenge
  fixtures. A sealed untouched corpus is still required before claiming
  unseen-site or general-web superiority.

[Documentation](docs/README.md) · [Canonical result](docs/BROWSERIR_REAL_AGENT_RESULTS.md) ·
[Security](SECURITY.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) ·
[Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## License

BrowserIR is licensed under the [Apache License 2.0](LICENSE).
