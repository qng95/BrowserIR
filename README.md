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
  <img alt="Status: 0.1 private source alpha" src="https://img.shields.io/badge/status-0.1_private_source_alpha-7957FF?style=for-the-badge">
  <img alt="Playwright and MCP" src="https://img.shields.io/badge/backend-Playwright_%2B_MCP-38BDF8?style=for-the-badge&logo=playwright&logoColor=white">
  <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-22C55E?style=for-the-badge"></a>
</p>

<p align="center">
  <a href="#measured-impact"><strong>Measured impact</strong></a>
  &nbsp;·&nbsp;
  <a href="#why-the-thin-layer-works"><strong>How it works</strong></a>
  &nbsp;·&nbsp;
  <a href="#source-alpha"><strong>Source alpha</strong></a>
  &nbsp;·&nbsp;
  <a href="#current-boundaries"><strong>Boundaries</strong></a>
</p>

## Measured impact

Same model. Same 32 matched tasks. Same three-fresh-attempt cap. Every attempt
used a fresh fixture, database, browser, MCP process, and model response, then
passed or failed against an exact hidden oracle. The host fixed the matching
policy family; `auto` decided only whether that policy should enrich the
snapshot.

| Real-agent metric | Playwright enrichment off | BrowserIR auto (host-selected policy) |
| --- | ---: | ---: |
| Final task success | 24/32 (75.0%) | **31/32 (96.9%)** |
| `pass@1` | 23/32 (71.9%) | **31/32 (96.9%)** |
| Physical model calls | 49 | **34 — 30.6% fewer** |
| Cost per successful task | $0.002273 | **$0.001012 — 55.5% lower** |
| Faster among the 24 tasks both solved | 7/24 | **17/24** |
| Mean paired `auto - off` active time | — | **−1.089 s** |

Here `pass@1` means exact-oracle success on the first fresh attempt. Task time
is end-to-end active execution—from fresh fixture and browser setup through
action dispatch and oracle verification—not model-call latency. The linked
analysis records the exact inclusion and exclusion rules.

These are descriptive results from a reused, unsealed development corpus—not a
claim of general superiority or unseen-site generalization. Inspect the
[receipt-backed result](docs/BROWSERIR_REAL_AGENT_RESULTS.md),
[pass@k and task-time analysis](packages/benchmark/output/benchmarks/browserir-openrouter-real-ab-20260826T142617Z-analysis.md),
or [reproduce the run](docs/BROWSERIR_REAL_AGENT_AB_RUNBOOK.md).

## Why the thin layer works

Playwright already owns the public tools, current refs, browser lifecycle,
actionability, and dispatch. BrowserIR does not replace any of them. It handles
one narrow observation gap: a semantic snapshot can contain the right labels
and controls without exposing the relationship between them.

### See the smallest useful difference

Task: **“Open the case aligned with the Routine queue, then stop.”** This is an
exact snapshot-tree excerpt from the checked-in, integration-tested
[`cross-tree/case-routing-columns` `lossy-b` fixture](packages/benchmark/src/agent-benchmark/adaptive-qualification-fixtures.ts):

<table>
  <thead>
    <tr>
      <th scope="col" width="50%" align="left">Playwright — enrichment off</th>
      <th scope="col" width="50%" align="left">BrowserIR — auto</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td valign="top"><pre><code>- region "Case routing" [ref=e31]
  - group "Relationship labels" [ref=e32]
    - heading "Urgent queue" [ref=e33]
    - heading "Routine queue" [ref=e34]
  - group "Relationship controls" [ref=e35]
    - button "Open case" [ref=e41]
    - button "Open case" [ref=e42]</code></pre></td>
      <td valign="top"><pre><code>- region "Case routing" [ref=f2e31]
  - group "Relationship labels" [ref=f2e32]
    - heading "Urgent queue" [ref=f2e33]
    - heading "Routine queue" [ref=f2e34]
  - group "Relationship controls" [ref=f2e35]
    - button "Open case" [ref=f2e41]
    - button "Open case" [ref=f2e42]

### Adaptive context
- cross-tree-label [ref=f2e41] label="Routine queue"
- cross-tree-label [ref=f2e42] label="Urgent queue"</code></pre></td>
    </tr>
  </tbody>
</table>

With enrichment off, Playwright exposes both labels and two valid but
indistinguishable `Open case` targets. Their sibling subtrees contain no
structural edge that tells the agent which button belongs to which queue.
BrowserIR adds exactly that missing relation, so `Routine queue` resolves to
`f2e41` without introducing a new action API.

The same failure mode appeared in the matching real-model
`case-routing-columns / opaque-p1` task: BrowserIR passed on attempt 1, while
enrichment-off failed all 3 allowed attempts ([raw task
receipt](packages/benchmark/output/benchmarks/browserir-openrouter-real-ab-20260826T142617Z.ndjson#L65-L68)).
The receipt retains results and hashes rather than model-input snapshots, so
the displayed pair comes from the tested fixture—not a reconstructed paid-run
input.

The runtime has only three outcomes:

- **Sufficient:** return Playwright's original result unchanged.
- **Provable gap:** make one read-only recapture, strip its box metadata, and
  add a complete relation set using only current Playwright refs. The `f2` refs
  above represent that fresh ref epoch.
- **Incomplete or changed evidence:** return Playwright's original result
  instead of guessing.

The [product-path integration test](packages/playwright-mcp/tests/reference-policies.test.ts)
checks current refs, box stripping, and complete-or-none projection.

That distinction showed up directly in the real-agent run:

| Task class | Playwright enrichment off | BrowserIR auto |
| --- | ---: | ---: |
| Semantic-sufficient | 16/16 | 16/16 |
| Structurally opaque | 8/16 | **15/16** |

The run produced 15 proven projections, one safe fallback, and zero
demonstrated projection misses. The layer helped where relationships were
missing while preserving Playwright's behavior where its semantics were already
sufficient.

## Source alpha

`@browserir/playwright-mcp` is currently a private source-alpha library—not a
published npm package or a drop-in MCP server. It wraps an already-connected
official MCP `Client`; Playwright continues to own the server, browser, tools,
refs, and actions.

From a checkout with Node.js 22.13+ and pnpm 10.30.3, build and verify the
thin-layer package:

```sh
npm install --global corepack@0.34.7
corepack enable
corepack install --global pnpm@10.30.3
pnpm install --frozen-lockfile
pnpm --filter @browserir/playwright-mcp build
pnpm --filter @browserir/playwright-mcp test
```

Then opt into one fixed policy family in host code:

```ts
import { createAdaptivePlaywrightTools } from '@browserir/playwright-mcp';
import { createCrossTreeLabelReferencePolicy } from
  '@browserir/playwright-mcp/reference-policies';

const tools = createAdaptivePlaywrightTools(client, {
  mode: 'auto',
  policySet: createCrossTreeLabelReferencePolicy(),
});
```

`client` is the caller-owned, connected official MCP client. While the wrapper
is active, route all `listTools` and `callTool` operations through `tools`, then
await `tools.dispose()`. See the [package guide](packages/playwright-mcp/README.md)
and [closed-alpha integration guide](docs/PLAYWRIGHT_MCP_ADAPTIVE_ALPHA.md) for
the complete lifecycle contract.

## Current boundaries

- First-party handles exist for bounded grid coordinates, schedule coordinates,
  and cross-tree labels. The current real-agent evidence covers the schedule
  and cross-tree families—not arbitrary visual understanding.
- The host chooses exactly one policy family. `auto` does not inspect a prompt
  or page to select among policies.
- An eligible default `browser_snapshot` may add at most one hidden, read-only
  boxed snapshot. The layer performs no hidden actions, page-code evaluation,
  screenshots, or internal retries.
- Unsupported input, parser drift, hidden failure, changed state, or incomplete
  proof returns Playwright's original result unchanged.
- The current 32-task result is favorable development evidence from a reused,
  unsealed corpus; public package and generalization claims remain gated.

The older full-graph `@browserir/mcp` runtime remains in this repository as a
separate legacy/experimental interface. Its archived Drops were inconclusive
and are not evidence for the thin layer measured above. See the
[thin-layer architecture](docs/ADAPTIVE_PLAYWRIGHT_ARCHITECTURE.md),
[measurement design](docs/ADAPTIVE_PLAYWRIGHT_MEASUREMENT.md), or
[archived evidence](docs/EVIDENCE_DROPS.md).

[Documentation](docs/README.md) · [Security](SECURITY.md) ·
[Troubleshooting](docs/TROUBLESHOOTING.md) ·
[Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## License

BrowserIR is licensed under the [Apache License 2.0](LICENSE).
