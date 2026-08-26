<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/browserir-wordmark-dark.svg">
    <img src="assets/brand/browserir-wordmark.svg" width="620" alt="BrowserIR — the semantic browser layer">
  </picture>
</h1>

<p align="center"><strong>Give Playwright the relationships agents are missing.</strong></p>

<p align="center">
  BrowserIR is a thin, adaptive semantic layer for official Playwright MCP.<br>
  It adds only relationships it can prove—and otherwise returns Playwright's original snapshot unchanged.
</p>

<p align="center">
  <strong>31/32 tasks solved · 31/32 pass@1 · 34 model calls</strong><br>
  <sub>vs 24/32 · 23/32 · 49 calls with enrichment off in a 32-task Qwen3.8-27B development benchmark</sub>
</p>

<p align="center">
  <a href="https://github.com/qng95/BrowserIR/actions/workflows/ci.yml"><img alt="BrowserIR CI" src="https://github.com/qng95/BrowserIR/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <img alt="Status: 0.1 source alpha" src="https://img.shields.io/badge/status-0.1_source_alpha-7957FF?style=for-the-badge">
  <img alt="Playwright and MCP" src="https://img.shields.io/badge/backend-Playwright_%2B_MCP-38BDF8?style=for-the-badge&logo=playwright&logoColor=white">
  <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-22C55E?style=for-the-badge"></a>
</p>

<p align="center">
  <a href="#measured-impact"><strong>Measured impact</strong></a>
  &nbsp;·&nbsp;
  <a href="#why-the-thin-layer-works"><strong>How it works</strong></a>
  &nbsp;·&nbsp;
  <a href="#evidence-not-promises"><strong>Evidence</strong></a>
  &nbsp;·&nbsp;
  <a href="#try-the-source-alpha"><strong>Try it</strong></a>
</p>

## Measured impact

Same model. Same 32 matched tasks. Same three-fresh-attempt cap. Every attempt
used a fresh fixture, database, browser, MCP process, and model response, then
passed or failed against an exact hidden oracle.

| Real-agent metric | Playwright enrichment off | BrowserIR auto |
| --- | ---: | ---: |
| Final task success | 24/32 (75.0%) | **31/32 (96.9%)** |
| `pass@1` | 23/32 (71.9%) | **31/32 (96.9%)** |
| Physical model calls | 49 | **34 — 30.6% fewer** |
| Cost per successful task | $0.002273 | **$0.001012 — 55.5% lower** |
| Successful-task active time, mean | 5.983 s (`n=24`) | **4.929 s (`n=31`)** |
| Successful-task active time, median | 5.118 s (`n=24`) | **4.930 s (`n=31`)** |

Here `pass@1` means exact-oracle success on the first fresh attempt.
Task time is end-to-end active execution, not model-call latency. It includes
fresh browser and fixture setup, navigation, snapshot construction, BrowserIR
processing when enabled, the model request, action dispatch, oracle
verification, and retry reset where required. It excludes time spent running
the opposite A/B arm and cleanup after the terminal outcome.

Because the two modes solved different task sets, the cleaner speed comparison
is the 24 tasks both completed: BrowserIR was faster on **17**, enrichment-off
was faster on **7**, and BrowserIR's observed mean paired advantage was **1.089
seconds** per successful task.

These are descriptive results from a reused, unsealed development corpus—not a
claim of general superiority or unseen-site generalization. Inspect the
[receipt-backed result](docs/BROWSERIR_REAL_AGENT_RESULTS.md),
[pass@k and task-time analysis](packages/benchmark/output/benchmarks/browserir-openrouter-real-ab-20260826T142617Z-analysis.md),
or [reproduce the run](docs/BROWSERIR_REAL_AGENT_AB_RUNBOOK.md).

## Why the thin layer works

The DOM describes the document. The accessibility tree exposes accessible
semantics. Neither alone is a stable, complete action contract. An agent still
needs to know **what matters, how it relates, what it can do now, whether its
target is still current, and whether its action had an observable effect**.

| View | Useful signal | Missing by itself |
| --- | --- | --- |
| Raw DOM | Markup, attributes, and document structure | Large and implementation-shaped; rerenders replace nodes and virtualized grids recycle them. |
| Accessibility tree | Roles, names, and states where accessible semantics exist | Coverage follows the page's accessibility quality; no revision-bound identity, omission accounting, or effect receipt. |
| **BrowserIR** | Fuses DOM, accessibility, geometry, lifecycle, and bounded behavior evidence | Produces one compact, technology-neutral interaction view for the model. |

This matters when a label and input live in different trees, a portal renders an
option outside its control, a custom `div` owns the real click handler, or a
WebForms postback replaces the whole document. Playwright remains the browser
driver; BrowserIR provides the model-facing meaning and safety boundary.

BrowserIR does not replace Playwright. It starts with Playwright's normal
semantic snapshot:

- When that snapshot already contains enough meaning, BrowserIR changes
  nothing.
- When relationships are split across trees or visible only through layout,
  BrowserIR makes one bounded, read-only observation and adds complete,
  provable relations using current Playwright references.
- When evidence is incomplete, BrowserIR returns the original snapshot instead
  of inventing a relationship.

That distinction showed up directly in the real-agent run:

| Task class | Playwright enrichment off | BrowserIR auto |
| --- | ---: | ---: |
| Semantic-sufficient | 16/16 | 16/16 |
| Structurally opaque | 8/16 | **15/16** |

The run produced 15 proven projections, one safe fallback, and zero
demonstrated projection misses. The layer helped where relationships were
missing while preserving Playwright's behavior where its semantics were already
sufficient. The full BrowserIR graph runtime remains available as a separate
legacy/experimental mode.

## Evidence, not promises

<table>
  <tr>
    <td width="33%" align="center"><strong>14 / 14</strong><br><sub>database-judged workflows</sub></td>
    <td width="33%" align="center"><strong>1.00</strong><br><sub>precision · recall · F1 on 11 cases</sub></td>
    <td width="33%" align="center"><strong>3 / 3 · 18 / 18</strong><br><sub>identities · known omissions</sub></td>
  </tr>
</table>

- **System qualification:** a deterministic reference planner completed all 14
  ERP/DMS workflows through BrowserIR, real Chromium, and the official MCP
  client. This proves the declared representation and action path—not LLM
  generalization.
- **Representation qualification:** across the checked-in 11-case corpus,
  BrowserIR matched 31/31 entities, 44/44 capabilities, 28/28 relationships,
  and 1/1 required abstention, with no false facts or misses.

| Matched agent comparison | Recorded result and boundary |
| --- | ---: |
| Thin adaptive Playwright: `auto` vs `off` | **Unsealed development evidence** — 31/32 vs 24/32; +21.875 pp |
| BrowserIR vs raw-DOM serialization | **Not measured yet** |
| Drop 02: BrowserIR vs official Playwright MCP accessibility snapshot | **Inconclusive** — 21/30 vs 20/30; +3.33 pp (95% paired CI −46.26 to +52.92 pp) |
| Drop 01: BrowserIR vs official Playwright MCP accessibility snapshot | **Inconclusive** — 30/30 vs 27/30; +10.00 pp (95% paired CI −39.59 to +59.59 pp) |

The thin adaptive result is the current product signal; its scope and caveats
are stated in [Measured impact](#measured-impact). Earlier sealed Drops tested a
broader full-BrowserIR interface against Playwright's accessibility snapshot.
Their intervals crossed zero, so both retain their predeclared
**inconclusive** verdicts. Drop 02's nine-pair tail was also provider
contaminated; its frozen score remains unchanged.

[Inspect Drop 02](docs/evidence-drops/drop-02/drop-02-qwen38max-query-three-conditions-v1-run-02/summary.md) ·
[Read the analysis](docs/evidence-drops/drop-02/analysis.md) ·
[See the frozen protocol](docs/evidence-drops/drop-02/sealed.protocol.json) ·
[Earlier Drop 01 result](docs/evidence-drops/drop-01/drop-01-qwen38max-validation-recovery-adaptive-v2-run-01/summary.md)

## How the scores are earned

<p align="center">
  <img src="assets/brand/browserir-scoring-method.svg" width="100%" alt="Fresh worker, known-failing baseline, browser interaction, closed access, then hidden database and audit grading">
</p>

Every task point follows the same fail-closed protocol:

1. Start a fresh seeded SQLite application, browser, MCP runtime, and planner.
2. Use a canonical seed separately regression-tested to make all 14 task
   oracles **fail** before any action.
3. Let the planner act only through the public model view and opaque references.
4. Close browser and MCP access before grading.
5. Award one binary point only if the hidden database-and-audit oracle passes.

There is no partial credit. Task-specific oracles reject cheats such as a
missing audit, a relevant collateral mutation, or a skipped validation
sequence. Scored agent runs retain every failure and invalid attempt.

Representation scoring is separate: technology-neutral expected sets are
compared with observed entities, capabilities, and relationships. Precision
penalizes invented facts; recall penalizes missing facts. Identity continuity
and bounded-scan omissions are scored independently.

```sh
pnpm test:qualification -- --run-id local-qualification
pnpm benchmark:representation -- --run-id local-representation
```

[Read the benchmark methodology](docs/BENCHMARK.md) ·
[Inspect the oracle tests](packages/fixture-app/tests/task-oracles.test.ts) ·
[Inspect the qualification harness](packages/mcp-server/tests/task-qualification-harness.ts)

## What the model sees

<p align="center">
  <img src="assets/brand/browserir-representation.svg" width="100%" alt="A live form compiled into BrowserIR entities, relationships, actions, state, and a revision">
</p>

```text
# Abridged exact native-choice fixture capture
[e1@r1] input role="combobox" name="Customer Status" value="prospect"
  state=enabled=true,expanded=false,focused=false,visible=true
  actions=contextClick,focus,hover,select
[e3@r1] option role="option" name="Active" value="active"
[e3@r1] option-of [e1@r1]
```

`e1` is a session-local semantic identity; `@r1` binds it to revision 1.
BrowserIR may retain `e1` when the same entity survives a rerender, but actions
require a fresh revision-bound reference; a recycled row receives a new
identity. Action receipts report effect status and include a graph delta when
available.

## Try the source alpha

BrowserIR is not on npm yet. From a checkout, use Node.js 22.13+, pnpm 10.30.3,
and Chromium:

```sh
npm install --global corepack@0.34.7
corepack enable
corepack install --global pnpm@10.30.3
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build
node packages/mcp-server/dist/cli.js
```

Point an MCP client at the built stdio server:

```json
{
  "mcpServers": {
    "browserir": {
      "command": "node",
      "args": ["/absolute/path/to/BrowserIR/packages/mcp-server/dist/cli.js"]
    }
  }
}
```

The default nine-tool surface has no arbitrary page-code execution. An unsafe
escape hatch exists only behind explicit opt-in.

## Alpha boundaries

The tested scope includes native and ARIA controls, evidence-backed custom
controls, open Shadow DOM, same-origin frames, portals, virtualized grids, and
full-document replacement. Closed Shadow DOM, canvas/WebGL-only interfaces,
and inaccessible cross-origin content are not comprehensively represented.
When evidence is insufficient, BrowserIR should abstain or report an omission.

[Architecture](docs/ARCHITECTURE.md) ·
[Agent benchmark](docs/AGENT_BENCHMARK.md) ·
[Security](SECURITY.md) ·
[Troubleshooting](docs/TROUBLESHOOTING.md) ·
[Contributing](CONTRIBUTING.md) ·
[Changelog](CHANGELOG.md)

## License

BrowserIR is licensed under the [Apache License 2.0](LICENSE).
