# BrowserIR brand and press kit

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="browserir-wordmark-dark.svg">
    <img src="browserir-wordmark.svg" width="620" alt="BrowserIR — the semantic browser layer">
  </picture>
</p>

<p align="center">
  <img src="browserir-social-card.png" width="100%" alt="BrowserIR launch preview card">
</p>

This folder contains the visual and messaging assets for BrowserIR's `0.1`
alpha launch. The identity is built around one idea: irregular browser controls
pass through a compile gate and emerge as a compact, structured representation.

## Assets

| Asset | Use |
| --- | --- |
| [`browserir-mark.svg`](browserir-mark.svg) | Primary standalone Compile Gate mark. |
| [`browserir-mark-mono.svg`](browserir-mark-mono.svg) | One-color mark for print, engraving, and constrained surfaces. |
| [`browserir-wordmark.svg`](browserir-wordmark.svg) | Horizontal wordmark for light backgrounds. |
| [`browserir-wordmark-dark.svg`](browserir-wordmark-dark.svg) | Horizontal wordmark for dark backgrounds. |
| [`browserir-hero.png`](browserir-hero.png) | Cinematic text-free README and launch hero. |
| [`browserir-benchmark.svg`](browserir-benchmark.svg) | Exact local qualification scorecard. |
| [`browserir-evidence-drop-01-v2.svg`](browserir-evidence-drop-01-v2.svg) | Evidence Drop 01 adaptive v2 matched-comparison result card. |
| [`browserir-evidence-drop-01-v2.png`](browserir-evidence-drop-01-v2.png) | Raster export of the Evidence Drop 01 adaptive v2 result card. |
| [`browserir-evidence-drop-02.svg`](browserir-evidence-drop-02.svg) | Evidence Drop 02 matched-comparison result card. |
| [`browserir-evidence-drop-02.png`](browserir-evidence-drop-02.png) | Raster export of the Evidence Drop 02 result card. |
| [`browserir-scoring-method.svg`](browserir-scoring-method.svg) | Plain-English visual showing how a task earns a pass. |
| [`browserir-representation.svg`](browserir-representation.svg) | Product visual showing a live UI compiled into model-ready IR. |
| [`browserir-architecture.svg`](browserir-architecture.svg) | High-level product architecture visual. |
| [`browserir-social-card.png`](browserir-social-card.png) | 1280 × 640 social and repository preview card. |
| [`PRESS_KIT.md`](PRESS_KIT.md) | Launch headlines, descriptions, facts, FAQ, and social copy. |

PNG exports of every vector visual are provided for contexts that do not support
SVG. Use `browserir-social-card.png` as the repository Open Graph image when the
project is published.

## What the mark means

The left side is the rendered browser UI: useful, but irregular. The central
gate is BrowserIR compiling and reconciling that interface. The bracketed rows
on the right are the compact structured representation an agent receives. The
symbol is deliberately a transformation, not an abstract AI graph.

## Palette

| Name | Hex | Role |
| --- | --- | --- |
| Midnight | `#070A18` | Primary dark background. |
| Ink | `#0B1025` | Cards and browser surfaces. |
| Electric blue | `#4F7CFF` | Primary interaction color. |
| Signal cyan | `#38BDF8` | Evidence and input accents. |
| Semantic violet | `#9B5CFF` | Relationships and IR accents. |
| Cloud | `#F8FAFC` | High-contrast copy. |

## Approved launch copy

### One line

BrowserIR is the semantic browser layer for AI agents that must get real work
done.

### Short description

BrowserIR uses Playwright for browser mechanics and turns live enterprise UIs
into compact semantic entities, relationships, available actions, revisions,
and observed effects with verification status. Use it as a TypeScript core or a
local MCP server.

### Boilerplate

BrowserIR is an interaction representation and runtime for AI browser agents.
It is designed for complex operational software such as ERP, CRM, and DMS. Its
tested slices include standards-hinted custom controls, open Shadow DOM,
same-origin frames, virtualized grids, delayed content, and legacy full-page
postbacks. BrowserIR keeps selectors below the model boundary, exposes typed
revision-checked actions, reports omissions, and uses Playwright for browser
execution.

## Benchmark language

Use this formulation for the latest hosted source qualification:

> GitHub Actions reproduced BrowserIR's deterministic fixture qualification on
> clean, source-bound v17 Drop 02 freeze commit `1b4f78a` in run `31616555262`.
> All ten required jobs passed and assembled a source-evidence dossier. This
> engineering qualification is separate from the model comparison and is not
> itself an LLM or competitor score.

For the v13 scorecard's run-specific telemetry, use this exact scoped
formulation:

> In a clean, source-bound CI deterministic qualification, BrowserIR completed 14/14 controlled
> fixture tasks through real Chromium and the official MCP client. In that run,
> the client made 302 MCP calls. BrowserIR refused one stale action before
> dispatch; the deterministic reference planner re-observed, re-resolved, and
> retried successfully.
> A separate checked-in representation corpus
> matched 31 entities, 44 capabilities, and 28 relationships without errors in
> that corpus. GitHub Actions reproduced these results on commit `14f86f6` and
> assembled a checksummed release-evidence dossier. They are system qualification,
> not an LLM or competitor score.

Do not use `100% agent success`, `production-ready`, `fastest`, `most compact`,
or superiority claims. Both available paired results are inconclusive and do
not support them.

The separate official-control compatibility result may be described only as:

> In one precommitted, score-excluded run, a selected OpenRouter Qwen3.8-Max
> configuration completed 5/5 scheduled attempts of the already-seen
> `create-customer` workflow through the safe browser-tool subset of official
> Playwright MCP `0.0.78`. There was no BrowserIR arm; this is not an uplift,
> pass-rate, generalization, or superiority result.

Use this formulation for Evidence Drop 01:

> Evidence Drop 01 adaptive v2 compared the complete BrowserIR interface with
> the official Playwright MCP accessibility-snapshot control across 30 matched
> validation-recovery blocks using Qwen3.8-Max. BrowserIR passed 30/30 and the
> control passed 27/30: an observed lift of +10.00 percentage points, with a 95%
> paired interval from −39.59 to +59.59 percentage points. Matched outcomes were
> three BrowserIR wins, zero control wins, 27 both pass, zero both fail, and zero
> invalid. The result is **inconclusive** because the interval includes zero.
> This adaptive v2 run is not a raw-DOM comparison or independent confirmation,
> and it does not establish superiority.

Do not describe the observed lift without the interval and inconclusive verdict.
Do not present this adaptive complete-interface comparison as a raw-DOM result
or independent confirmation.

Use this formulation for Evidence Drop 02:

> Evidence Drop 02 compared the complete BrowserIR interface with the official
> Playwright MCP accessibility-snapshot control across 30 fresh matched
> `query-three-conditions` blocks using Qwen3.8-Max. BrowserIR passed 21/30 and
> the control passed 20/30: an observed lift of +3.33 percentage points, with a
> 95% paired interval from −46.26 to +52.92 percentage points. Matched outcomes
> were one BrowserIR win, zero control wins, 20 both pass, nine both fail, and
> zero invalid. The result is **inconclusive**. The final nine both-failed pairs
> are provider-contaminated and best explained by exhausted OpenRouter credit;
> they remain scored and were not rerun. This is one complete-interface
> workflow within a known fixture—not a
> raw-DOM comparison, generalization result, or superiority claim.

Do not omit the interval, inconclusive verdict, or provider-exhaustion caveat
when describing Drop 02.

## Logo usage

- Preserve clear space equal to one structured-record height around the mark.
- Prefer the color mark on midnight, white, or very pale blue backgrounds; use
  the monochrome mark where gradients or tonal contrast are unavailable.
- Keep the three-part story intact: irregular UI controls, the central compile
  gate, and the bracketed structured records.
- Do not replace the gate with a generic play button, remove the browser rail,
  add effects, rotate the mark, or place copy inside it.
- Use the wordmark when the audience may not already know the BrowserIR name.

The generated hero is intentionally text-free so launch copy can change without
regenerating the art. The scorecard and system diagram are deterministic SVGs so
their labels and metrics remain exact.
