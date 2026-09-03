# Changelog

All notable changes to BrowserIR's current thin-layer product path are recorded
here. The project intends to follow Semantic Versioning after its public
contracts stabilize.

Last updated: 2026-09-03

## Unreleased

### Added

- The initial `browserir-mcp` `0.1` release, providing
  middleware around a
  caller-owned official MCP `Client`. It preserves the official tool catalog,
  refs, actions, and lifecycle while adding only complete, evidence-backed
  relationships to eligible snapshots.
- Explicit first-party grid-coordinate, schedule-coordinate, and
  cross-tree-label policy handles. The host selects exactly one fixed policy;
  `auto` does not inspect the task prompt to route among families.
- A real-browser, zero-model qualification over 64 arms. The current schedule
  `/3` source projects all 15 independently demonstrated recoverable relations,
  safely falls back once, performs no hidden actions, and has zero demonstrated
  projection misses.
- A retry-, pass@k-, task-time-, token-, and cost-aware real-agent A/B runner.
  The retained Qwen3.8-27B development run solved 31/32 tasks in `auto` versus
  24/32 with enrichment `off`, with 7 `auto`-only wins and no `off`-only wins.
  See the [canonical result and claim
  boundary](docs/BROWSERIR_REAL_AGENT_RESULTS.md).
- Current architecture, integration, troubleshooting, measurement, reproduction,
  and result documentation indexed in [docs/README.md](docs/README.md).
- A thin-package-only npm verifier, exact-tarball consumer audit, and protected
  two-job publish workflow that keeps dependency installation outside the OIDC
  publish trust boundary.

### Changed

- Renamed the npm package and release tags from the unavailable `browserir`
  identity to `browserir-mcp`; the initial public version remains `0.1.0`.
- Advanced the schedule/resource projector to `schedule-coordinate-policy/3`.
  A one-pixel serialized final-resource overhang is accepted only at the
  schedule root edge; a two-pixel gap and all other incomplete or ambiguous
  mappings remain unresolved.
- Replaced single-terminal-outcome reporting with fresh-attempt retry counts,
  pass@1/pass@2/pass@3, physical model calls, provider tokens and cost, final
  cost per success, success-conditioned task time, and common-success paired
  task time.
- Made the thin layer the primary documented product. The older full-graph
  packages and evidence are now explicitly labelled legacy/experimental.

### Security

- Only an exact default `browser_snapshot` request can trigger adaptation.
- One eligible call can make at most one hidden boxed snapshot; the package
  performs no hidden action, navigation, evaluation, screenshot, or retry.
- Successful output uses current refs, strips raw boxes, and requires a complete
  projection over unchanged state. Every unsafe, failed, or unresolved path
  returns the exact original visible result object.
- Snapshot parsing is bounded and opt-in telemetry contains only five
  content-free fields. The caller continues to own the MCP server, browser,
  transport, authorization, network policy, data handling, and shutdown.
- MCP results now have aggregate content-block and text-byte limits in addition
  to per-snapshot parser bounds, closing a many-small-block availability edge.

### Known limitations

- `browserir-mcp@0.1.0` is prepared as the default npm release but is not
  published until the protected release completes and the registry confirms
  it. The `0.x` API may change between minor versions.
- Only exact default snapshots are eligible. The host must select one policy
  family, and the current layer is not a prompt-driven general visual reasoner.
- The real-agent run covers schedule-coordinate and cross-tree-label challenge
  cases. Grid policies have source and zero-model coverage but no claim-grade
  real-agent result yet.
- The favorable 32-task comparison is an unsealed development study on a corpus
  reused after an earlier projector round. Its receipt omits product source and
  policy-version provenance, so it is not independent confirmation, unseen-site
  generalization, or a broad superiority claim.

## Legacy full-graph research line

The unreleased `@browserir/core`, `@browserir/playwright`, and `@browserir/mcp`
runtime, its nine-tool interface, deterministic 14-workflow qualification,
release-evidence pipeline, and Evidence Drops 01/02 remain in source and
checksummed archives. They are a separate historical interface, not a prior
release of the current thin layer and not evidence for its 31/32 result.

See the [legacy architecture](docs/ARCHITECTURE.md), [evidence
archive](docs/EVIDENCE_DROPS.md), and immutable `docs/evidence-drops/`
artifacts. Both sealed legacy Evidence Drops were inconclusive.
