<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/browserir-wordmark-dark.svg">
    <img src="assets/brand/browserir-wordmark.svg" width="620" alt="BrowserIR — the semantic browser layer">
  </picture>
</h1>

<p align="center"><strong>DOM and accessibility are sensors. BrowserIR is the agent contract.</strong></p>

<p align="center">
  BrowserIR compiles a live interface into semantic entities, relationships,<br>
  current actions, revision-bound targets, explicit omissions, receipts, and deltas.
</p>

<p align="center">
  <a href="https://github.com/qng95/BrowserIR/actions/workflows/ci.yml"><img alt="BrowserIR CI" src="https://github.com/qng95/BrowserIR/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <img alt="Status: 0.1 source alpha" src="https://img.shields.io/badge/status-0.1_source_alpha-7957FF?style=for-the-badge">
  <img alt="Playwright and MCP" src="https://img.shields.io/badge/backend-Playwright_%2B_MCP-38BDF8?style=for-the-badge&logo=playwright&logoColor=white">
  <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-22C55E?style=for-the-badge"></a>
</p>

<p align="center">
  <a href="#why-browserir"><strong>Why BrowserIR</strong></a>
  &nbsp;·&nbsp;
  <a href="#evidence-not-promises"><strong>Evidence</strong></a>
  &nbsp;·&nbsp;
  <a href="#how-the-scores-are-earned"><strong>Scoring</strong></a>
  &nbsp;·&nbsp;
  <a href="#try-the-source-alpha"><strong>Try it</strong></a>
</p>

## Why BrowserIR?

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

The current default product direction is a **thin adaptive layer around
official Playwright MCP**. It keeps Playwright's snapshot and action contract,
projects only complete structural relationships that its selected fixed policy
can prove, and passes
the original snapshot through when it cannot. The full BrowserIR graph runtime
remains available as a separate legacy/experimental mode.

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

The latest thin-layer development run used one model only,
`qwen/qwen3.8-27b`, on 32 matched tasks evaluated in both modes (16 semantic
and 16 opaque)
with `max_retry=2`. With the reference-policy schedule `/3`, adaptive `auto`
passed **31/32 (96.875%)** and passthrough `off` passed **24/32 (75%)**:
7 auto-only wins, 0 off-only wins, 24 both-pass pairs, and 1 both-fail pair.
The exact paired McNemar test and a case-cluster sign-test sensitivity check
both give **p=0.015625**. Opaque tasks improved from 8/16 to 15/16; semantic
tasks were 16/16 in both arms. Pass@1 was 30/32 versus 24/32, while pass@3 was
31/32 versus 24/32.

Among the 16 opaque relation cases, BrowserIR projected 15 proven relations,
safely passed Playwright through once, and recorded zero projection misses.
Across 84 model calls the run used 146,312 tokens and cost **$0.09136310**
total. The adaptive arm cost **$0.03526395**, or **$0.00113755 per successful
task**.

Those numbers are descriptive development evidence, not a confirmatory or
general-superiority claim. The corpus was reused after the preceding round had
been inspected, the artifacts are not a sealed Evidence Drop, and the receipt
does not serialize the executed policy version or product-source hash. See the
[full result and claim boundary](docs/BROWSERIR_REAL_AGENT_RESULTS.md) and the
[reproduction runbook](docs/BROWSERIR_REAL_AGENT_AB_RUNBOOK.md).

Drop 02 used Qwen3.8-Max on 30 fresh matched `query-three-conditions` blocks:
1 BrowserIR win, 0 control wins, 20 both pass, 9 both fail, and 0 invalid. The
interval crosses zero, so the predeclared verdict is **inconclusive**. This is a
complete-interface test on one known fixture workflow—not raw-DOM evidence,
generalization, or a superiority claim.

The nine-pair tail is provider-contaminated, so the absolute arm rates are not
clean interface-capability estimates. The frozen score remains unchanged.

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
