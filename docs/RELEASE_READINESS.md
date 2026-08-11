# BrowserIR 0.1 alpha release readiness

Assessment updated: 2026-08-11 (Europe/Berlin)

Status: **the Apache-2.0 source alpha is public and commit `0097f28` has a
qualified, source-bound GitHub Actions dossier; npm packages and a tagged release
remain unpublished.** Publication gates must not be bypassed by weakening the
release verifier or by presenting dirty/unbound local evidence as release
evidence.

## Source and hosted release behavior

Local development and clean hosted CI produced the following engineering evidence:

| Gate | Result |
| --- | --- |
| Current local working-tree verification (v12; not yet hosted) | 631 declared cases: 612 executed passes and 19 explicitly opt-in qualification cases skipped. By package: core 60/60, fixture 85/85, Playwright driver 107/107, benchmark 191/191, and MCP 169 passed with 19 skipped. All five package type checks passed. |
| Earlier direct workspace run | 487 declared cases and 468 executed passes with 19 skips; now stale because it predates the latest product and benchmark changes and must not be presented as the current total. |
| Earlier retained machine-readable workspace evidence | 439 declared cases and 420 executed passes with 19 intentional skips; this dirty/unbound fragment predates the agent-benchmark expansion and no longer satisfies the current exact test-count policy |
| Earlier combined workspace run | 324 passed with the same 19 opt-in cases skipped; retained only as a historical pre-release-evidence count |
| Workspace type checking | Passed for all five tested packages |
| Capability qualification | 5/5 browser workflows passed |
| Database-backed task qualification | 14/14 tasks passed through the official MCP client; 299 MCP calls; 0 tool errors |
| First public GitHub Actions run | Ran against `db39b82`; its failures were reproduced locally and traced to structured delta context being discarded by the qualification consumer, small visual-row offsets, a safe child environment omitting the CI browser path, Node 22 SQLite statement lifetime, and Ubuntu SVG font metrics. |
| Clean hosted requalification | [Run `31520630516`](https://github.com/qng95/BrowserIR/actions/runs/31520630516) passed every required job on commit `0097f28`, including Node 22/24 workspace and packed-consumer matrices, 5/5 capabilities, 14/14 task oracles, representation, performance, production audit, and dossier assembly. |
| Representation release gate | 31/31 entities, 44/44 capabilities, 28/28 relations, 1/1 abstention, 3/3 stable identities, and 18/18 omissions accounted for |
| Public package verification | Passed exact package-file and manifest checks |
| Packed-consumer smoke | Passed fresh tarball install, imports and declarations, Chromium install, stock stdio MCP negotiation, all nine safe tools, PNG capture, and cleanup |
| Production dependency audit | Clean hosted audit passed with 0 vulnerabilities across 12 production dependencies and 0 muted advisories |
| Release evidence dossier | Qualified for source-bound commit `0097f28`; the GitHub artifact is checksummed and retained for 90 days |
| Public-release verifier | Apache-2.0 and repository checks pass. It now reports only six intentional npm-publication blockers: `private` and missing public `publishConfig` on each of the three product packages. |

The qualification client used MCP protocol `2026-07-28`. Every isolated
task worker observed the same nine-tool catalog with SHA-256
`5245770edc0ea30f46afdd03e0bd7d4b20a95c2a91ea1062798d619dfe6be5c3`.

The task qualification is a deterministic reference-planner test against the
fixture's database and audit-log oracles. It is not evidence that an arbitrary
LLM will generalize to unseen sites, and it is not a Browser-Use, Stagehand,
Treegress, or Playwright MCP comparison.

## Release-evidence state

The repository now defines seven create-only evidence gates and a fail-closed
dossier assembler. A complete candidate requires nine fragments because the
workspace and packed-consumer gates each run on Node.js 22.13.0 and 24.19.0.
The remaining five gates run on Node.js 24.19.0. Workspace and capability tests
retain JSON and JUnit; task, representation, and performance runners retain
their native reports; packed-consumer evidence retains phase and transient
archive hashes; the production audit records one of `passed`,
`vulnerabilities_found`, or `audit_unavailable`.

The assembler accepts only schema `1.1.0` passing fragments from one clean,
source-bound GitHub Actions commit and run attempt. It verifies stable endpoint
source snapshots, commit/tree, lockfile and source hashes, per-file checksums,
gate-specific results, and the exact reviewed workspace test-count policy ID.
The current local policy is `2026-08-11-v12`, requiring 631 declared, 612
executed, and 19 skipped cases. It includes the sealed-benchmark hardening in
this working tree and is not yet a qualified hosted dossier.

The latest qualified public dossier is
`release-evidence-dossier-31520630516-1-0097f28c754e029f5f4f32fb3476a56d3035fc64`,
bound to commit `0097f28c754e029f5f4f32fb3476a56d3035fc64` under policy `v11`
(589 declared, 570 executed, 19 skipped). GitHub reports the artifact digest as
`sha256:d995c1d73fb5fb5b3b69c2b121715f634c76e5113ff155bd6dbbb6324a32b83a`.
The new `v12` hardening must receive its own clean hosted qualification after it
is committed; the prior dossier does not certify uncommitted code.

The retained local fragments below were produced before the public Git source
commit and therefore cannot be assembled into a qualified dossier. The latest
retained pre-publication local fragments are:

| Gate | Local fragment | `evidence.json` SHA-256 |
| --- | --- | --- |
| Workspace verification | `workspace-local-2026-08-11-v8` | `bf9c772b54f29b9860188304d13771cc9706808f379a04e9edfb867aecf60626` |
| Capability qualification | `capabilities-local-2026-08-11-v7` | `ece8e3f3ada0b4a4e1d267eae22bb66399e0418834cc68da79b3beac6c704afd` |
| Task qualification | `task-local-2026-08-11-v5` | `95e42d5ea57e53b02ded61bbf985c0d168e9a12a06b5f0a59e0a9610b3ff8d39` |
| Representation qualification | `representation-local-2026-08-11-v5` | `8de8eac094770a1b795e62ff104db8cd066d8d3f1a2fe4fff41d9e64e8fd24d8` |
| Performance characterization | `performance-local-2026-08-11-v6` | `343fa537a92b9a5e3ec21f56f8a22d5a24792edf01b8abac8e9db5530a887c8f` |
| Packed consumer | `packed-consumer-local-2026-08-11-v4` | `8d5b009bdbdf55dfcb2b7f3ecf893f2707d78447d6c9345cc748f9bbebd3915c` |
| Production audit | `production-audit-local-2026-08-11-v4` | `6054c8599ba11a5d6b0bb08fc742c78dbb65972c60790f32b6210ce3b4d77f9a` |

Every entry in every fragment's `SHA256SUMS` verifies. Every fragment is also
correctly marked `dirty_worktree`, `revision_unavailable`, and
`tree_unavailable`; each also records a stable before/after source snapshot.
An earlier workspace attempt, `workspace-local-2026-08-11-v3`, correctly
retained a failure caused by another local build cleaning `dist` concurrently.
The retained `v8` run above superseded that earlier failure, but it now predates
the latest changes; both that fragment and its `v8` exact-count policy are stale.
Run `31520630516` supersedes those local fragments as the latest qualified,
clean-commit qualification.

CI fragments and the dossier are retained for 90 days. Before publication, the
qualified dossier must be promoted unchanged to approved durable release
storage. SHA-256 checks establish content integrity relative to a trusted
checksum; they are not signatures or proof of release authorization. See
[the release-evidence guide](RELEASE_EVIDENCE.md).

## Benchmark evidence

Evidence Drop 01 is in pre-seal development. Its comparison infrastructure is
implemented and tested. The official Playwright MCP control is pinned at
`0.0.78`; broker injection, the
neutral agent prompt, counterbalanced matched runner, paired interval,
model-facing tool traces, and create-only comparison artifacts have focused
tests. Both BrowserIR and Playwright MCP deterministic reference models can
complete `create-customer` through real Chromium and the same sealed
database/audit oracle.

The sealed path now requires a fresh checkout of the freeze tag, frozen
dependency installation, a complete build before the runner loads, exact
start/end Git and built-package byte identity, matching start/end environment
including CPU/RAM and explicit isolation status (sequential, shared process,
container/VM limits unverified), a hash-chained resumable
journal, one precommitted model seed shared by both arms in every matched block,
and a non-zero frozen sampling temperature. The launcher isolates child
home/config/cache state, strips ambient loader and secret variables, restricts
sealed Ollama to literal loopback with redirects rejected, and records its model
digest as endpoint-reported rather than independently weight-verified. The final
marker verifies the canonical journal tail and every required sealed provenance
artifact. The `validation-recovery` oracle also checks the requested city and
country, not only the customer name and credit workflow.

Real-model paired **development diagnostics** have now run on the excluded
`create-customer` task. Failed v4–v6 protocols remain retained. v7 produced the
first one-block development treatment win: BrowserIR passed all three trusted
criteria and official Playwright MCP did not submit. This is a capability
signal only; its 95% paired bound is still −100 to +100 percentage points. The
full adaptive history and exact caveats are in the
[development feedback ledger](EVIDENCE_DROPS.md#development-feedback-ledger).

The v6 and v7 bundles have stable start/end environment bindings, hash-chained
journals, checksums, and atomic completion markers. They still record
`source.clean=false`, `revision=null`, and `tree=null`; v7 also captured a
different pnpm runtime than v6. They are not source-bound release evidence and
cannot prove which code change caused the result.

No sealed score has been run or published. The candidate
`validation-recovery` schedule remains untouched. One development capability
check passed, but sealed-entry approval has not been recorded. Therefore there
is still no BrowserIR uplift, competitor-superiority, or general agent-quality
claim. See [the evidence-drop protocol](EVIDENCE_DROPS.md).

The representation report passed all 11 release tasks in its complete checked
corpus. Its JSON report has SHA-256
`de994549a5d942d02b2e8c9646d763e7932e42aa675e1a86d6141cce3feb08c7`.

The local performance characterization used seven isolated fixture screens,
five warmups, and 100 measured warm observations per screen. Observed p50
latency ranged from 35.31 ms to 429.28 ms; observed p95 latency ranged from
37.99 ms to 479.47 ms, and the largest of all 700 measured samples was 494.91
ms. The evidence gate completed in 171.20 seconds. The operator invoked the
outer command through `caffeinate -i`; that sleep-prevention context is not
encoded in the fragment itself. Raw samples and seeded bootstrap confidence
intervals are retained at
`output/release-evidence/performance-local-2026-08-11-v6`. The summary JSON has
SHA-256
`2116c29839a6344c1dec28ee28e681873d47c6825baa25d78808b6e6e52f67a2`,
and the evidence manifest has SHA-256
`343fa537a92b9a5e3ec21f56f8a22d5a24792edf01b8abac8e9db5530a887c8f`.

An immediately preceding local attempt was interrupted by macOS idle sleep and
contains three roughly 15–17 minute raw samples. It remains retained as
diagnostic evidence, but it is explicitly excluded from the figures above and
must not be used as a baseline or comparison. The clean rerun used
`caffeinate -i` to prevent the same environmental interruption.

These measurements came from a dirty Apple M1 Pro/macOS workspace using Node
22.19.0, pnpm 10.30.3, Playwright 1.62.0, and Chromium 151.0.7922.34. They are a
local characterization only. They are not an immutable release baseline and
must not be compared with results that have a different benchmark schema or
environment fingerprint.

The project is licensed under Apache-2.0. The production vulnerability audit
found zero advisories. A preliminary direct manifest review found Apache-2.0
for Playwright and Playwright Core, and MIT for the MCP server/core packages,
Zod, and optional `fsevents`. A reproducible clean-environment dependency-license
inventory is still required before npm publication because `pnpm licenses list`
is unusable in this local store: pnpm reports a missing Playwright package index
even after a frozen reinstall.

## Publication blockers

1. Configure the canonical GitHub repository's private security reporting
   location before launch.
2. Confirm ownership and publishing authority for `@browserir/core`,
   `@browserir/playwright`, and `@browserir/mcp`.
3. Select version and dist-tag semantics. The recommended alpha identity is
   `0.1.0-alpha.1` published under the `alpha` tag.
4. Commit the v12 hardening, run the pinned Node 22.13.0 and 24.19.0 CI matrix,
   assemble all nine source-bound fragments, and qualify that exact commit. The
   existing `0097f28` dossier remains valid for its source but does not certify
   the new code. Promote the selected qualified dossier before its 90-day CI
   retention expires and record its durable location.
5. After those decisions are recorded, remove `private` from only the three
   public packages and set their
   `publishConfig.access` to `public`. Then re-run `pnpm verify:release`; only
   after it passes may the qualified dossier be bound to retained candidate
   tarballs and an explicitly authorized publish begin.

The executable remains a local stdio alpha. It does not claim remote HTTP or
multi-tenant security, Firefox or WebKit support, complete coverage of every
modern UI, stochastic LLM success, or superiority over another browser-agent
system.

See [the full release checklist](RELEASE_CHECKLIST.md), [benchmark
methodology](BENCHMARK.md), [release-evidence guide](RELEASE_EVIDENCE.md),
[security boundary](../SECURITY.md), and [troubleshooting
guide](TROUBLESHOOTING.md).
