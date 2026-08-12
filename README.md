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

| Matched agent comparison | Published result |
| --- | ---: |
| BrowserIR vs raw-DOM serialization | **Not measured yet** |
| BrowserIR vs official Playwright MCP accessibility snapshot | **Inconclusive** — 30/30 vs 27/30; +10.00 pp (95% paired CI −39.59 to +59.59 pp) |

Across 30 matched `validation-recovery` blocks, BrowserIR passed 30/30 and the
control passed 27/30. The observed +10.00-point lift is inconclusive because
the predeclared interval crosses zero. This adaptive v2 result compares the
complete interfaces; it is not a raw-DOM measurement, pure representation
ablation, independent confirmation, generalization, or a superiority claim.

[Inspect the complete result](docs/evidence-drops/drop-01/drop-01-qwen38max-validation-recovery-adaptive-v2-run-01/summary.md) ·
[Read the analysis](docs/evidence-drops/drop-01/adaptive-v2-analysis.md) ·
[See the frozen protocol](docs/evidence-drops/drop-01/sealed-adaptive-v2.protocol.json)

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
