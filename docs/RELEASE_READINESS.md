# BrowserIR 0.1 alpha release readiness

Assessment updated: 2026-08-12 (Europe/Berlin)

Status: **the Apache-2.0 source alpha and Evidence Drop 01 adaptive-v2 result
are public. Result-publication commit `e448b58` passed all ten hosted v16 jobs
in [run `31608404916`](https://github.com/qng95/BrowserIR/actions/runs/31608404916)
and is bound by annotated tag `evidence-drop-01-adaptive-v2-result`. npm packages
and a product release remain unpublished.** Publication gates must
not be bypassed by weakening the release verifier or by presenting
dirty/unbound local evidence as release evidence.

## Source and hosted release behavior

Local development and clean hosted CI produced the following engineering evidence:

| Gate | Result |
| --- | --- |
| Current unqualified v17 Drop 02 freeze candidate | 754 declared cases: 735 executed and 19 explicitly opt-in qualification cases skipped. By package: core 60/60, fixture 100/100, Playwright driver 107/107, benchmark 292/292, and MCP 195 declared / 176 executed / 19 skipped. The complete local gate passes; hosted qualification and a dossier remain pending. |
| Qualified v16 result-publication workspace verification (commit `e448b58`) | 749 declared cases: 730 executed and 19 explicitly opt-in qualification cases skipped. By package: core 60/60, fixture 98/98, Playwright driver 107/107, benchmark 289/289, and MCP 195 declared / 176 executed / 19 skipped. Hosted run `31608404916` passed all ten required jobs and assembled the current dossier. |
| Qualified v15 workspace verification (commit `89c82ff`) | 735 declared cases: 716 executed and 19 explicitly opt-in qualification cases skipped. By package: core 60/60, fixture 98/98, Playwright driver 107/107, benchmark 281/281, and MCP 189 declared / 170 executed / 19 skipped. Both pinned Node jobs and all five package type checks passed. |
| Qualified v14 workspace verification (commit `6a122a2`) | 689 declared cases: 670 executed and 19 explicitly opt-in qualification cases skipped. By package: core 60/60, fixture 98/98, Playwright driver 107/107, benchmark 235/235, and MCP 189 declared / 170 executed / 19 skipped. Both pinned Node jobs and all five package type checks passed. |
| Previous qualified v13 workspace verification (commit `14f86f6`) | 632 declared cases: 613 executed passes and 19 explicitly opt-in qualification cases skipped. By package: core 60/60, fixture 85/85, Playwright driver 107/107, benchmark 191/191, and MCP 170 passed with 19 skipped on both pinned Node versions. All five package type checks passed. |
| Earlier direct workspace run | 487 declared cases and 468 executed passes with 19 skips; now stale because it predates the latest product and benchmark changes and must not be presented as the current total. |
| Earlier retained machine-readable workspace evidence | 439 declared cases and 420 executed passes with 19 intentional skips; this dirty/unbound fragment predates the agent-benchmark expansion and no longer satisfies the current exact test-count policy |
| Earlier combined workspace run | 324 passed with the same 19 opt-in cases skipped; retained only as a historical pre-release-evidence count |
| Workspace type checking | Passed for all five tested packages |
| Capability qualification | 5/5 browser workflows passed |
| Score-excluded official-control capability | One selected OpenRouter `qwen/qwen3.8-max` configuration completed the full five-attempt schedule through the safe subset of official Playwright MCP `0.0.78`: 5 passed, 0 failed, 0 invalid; 56 tool calls, 61 model turns, zero tool errors, and five exact database/audit/structured submissions. This raw 5/5 is not a score. |
| Hosted v16 database-backed task qualification | 14/14 tasks passed through the official MCP client in result-publication run `31608404916`. |
| Previous v13 task telemetry | 14/14 tasks passed in 302 MCP calls. BrowserIR refused one stale click before dispatch; the deterministic reference planner re-observed, re-resolved, and retried successfully. These exact call/refusal figures belong to v13 and are not silently relabelled as v14 telemetry. |
| First public GitHub Actions run | Ran against `db39b82`; its failures were reproduced locally and traced to structured delta context being discarded by the qualification consumer, small visual-row offsets, a safe child environment omitting the CI browser path, Node 22 SQLite statement lifetime, and Ubuntu SVG font metrics. |
| Earlier clean hosted qualification | [Run `31520630516`](https://github.com/qng95/BrowserIR/actions/runs/31520630516) passed every required v11 job on commit `0097f28`. It remains valid for that source tree. |
| Qualified v16 result-publication source run | [Run `31608404916`](https://github.com/qng95/BrowserIR/actions/runs/31608404916) passed all ten required jobs on commit `e448b58`, including both Node matrices, both packed-consumer jobs, 5/5 capabilities, 14/14 task oracles, representation, performance, production audit, and dossier assembly. The annotated result tag resolves to this commit. |
| Hosted v16 freeze source run | [Run `31600711043`](https://github.com/qng95/BrowserIR/actions/runs/31600711043) is green on commit `5b7db58`, to which `evidence-drop-01-protocol-v2` resolves. It qualifies the exact source frozen before the adaptive run. |
| Qualified v14 source run | [Run `31540028205`](https://github.com/qng95/BrowserIR/actions/runs/31540028205) passed every required v14 job on commit `6a122a2`, including Node 22/24 workspace and packed-consumer matrices, 5/5 capabilities, 14/14 task oracles, representation, performance, production audit, and dossier assembly. |
| Qualified v15 source run | [Run `31590339246`](https://github.com/qng95/BrowserIR/actions/runs/31590339246) passed every required v15 job on commit `89c82ff`, including Node 22/24 workspace and packed-consumer matrices, 5/5 capabilities, 14/14 task oracles, representation, performance, production audit, and dossier assembly. The annotated tag `evidence-drop-01-protocol-v1` peels to this exact commit. |
| Qualified v13 source run | [Run `31531657356`](https://github.com/qng95/BrowserIR/actions/runs/31531657356) passed every required v13 job on commit `14f86f6`, including Node 22/24 workspace and packed-consumer matrices, 5/5 capabilities, 14/14 task oracles, representation, performance, production audit, and dossier assembly. |
| Representation release gate | 31/31 entities, 44/44 capabilities, 28/28 relations, 1/1 abstention, 3/3 stable identities, and 18/18 omissions accounted for |
| Public package verification | Passed exact package-file and manifest checks |
| Packed-consumer smoke | Passed fresh tarball install, imports and declarations, Chromium install, stock stdio MCP negotiation, all nine safe tools, PNG capture, and cleanup |
| Production dependency audit | Clean hosted audit passed with 0 vulnerabilities across 12 production dependencies and 0 muted advisories |
| Release evidence dossier | Qualified for source-bound result-publication commit `e448b58`; the GitHub artifact is checksummed and retained until 2026-11-10 |
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
The current freeze-candidate exact-count policy is `2026-08-12-v17`, requiring
754 declared, 735 executed, and 19 skipped cases. Its focused release tests
and the complete local gate pass, but hosted qualification remains pending. The latest
qualified policy remains v16: hosted
result-publication run `31608404916` on commit `e448b58` qualified the checked-in
Drop 01 result, documentation, and visual and assembled the current dossier.

The current qualified public source release-evidence dossier is
`release-evidence-dossier-31608404916-1-e448b58705944e35a1f2b7ff76d80c45afb3b70f`,
bound to commit `e448b58705944e35a1f2b7ff76d80c45afb3b70f` under policy `v16`.
GitHub reports the artifact digest as
`sha256:199d1d585b6c55773d93a61df209e427d47a4e28e08e6e925548837f69ae1292`;
it is retained until 2026-11-10.

The previous v15 dossier,
`release-evidence-dossier-31590339246-1-89c82ff4d89ec33c1311df65729306c579192357`,
remains valid for commit `89c82ff4d89ec33c1311df65729306c579192357`, with
GitHub-reported digest
`sha256:30a6e94aaa1815cc833bbb27ada166d395cef3e48cd23e8f84a7f6903700f0d4`.

The qualified public source release-evidence dossier for the hardening commit is
`release-evidence-dossier-31540028205-1-6a122a2bfd0c1f684e1eec350659db3c7d1eadeb`,
bound to commit `6a122a2bfd0c1f684e1eec350659db3c7d1eadeb` under policy `v14`
(689 declared, 670 executed, 19 skipped). GitHub reports the artifact digest as
`sha256:230290448362e79464a59eeda808308b2f4d88ede3b8dec4372cdaca4240d899`.

The previous v13 dossier,
`release-evidence-dossier-31531657356-1-14f86f6380f164fffb9fcdb3aa74352ca4c7a8f0`,
remains valid for commit `14f86f6380f164fffb9fcdb3aa74352ca4c7a8f0`
(632 declared, 613 executed, 19 skipped), with GitHub-reported digest
`sha256:18cdf6cdd13d1ce54110204c76a354af088825293e1fcb465554ed3a996fdfe4`.

The previous v11 dossier,
`release-evidence-dossier-31520630516-1-0097f28c754e029f5f4f32fb3476a56d3035fc64`,
remains valid for commit `0097f28c754e029f5f4f32fb3476a56d3035fc64`
(589 declared, 570 executed, 19 skipped), with GitHub-reported digest
`sha256:d995c1d73fb5fb5b3b69c2b121715f634c76e5113ff155bd6dbbb6324a32b83a`.

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
Run `31608404916` supersedes those local fragments as a qualified,
clean-commit qualification.

CI fragments and the dossier are retained for 90 days. Before publication, the
qualified dossier must be promoted unchanged to approved durable release
storage. SHA-256 checks establish content integrity relative to a trusted
checksum; they are not signatures or proof of release authorization. See
[the release-evidence guide](RELEASE_EVIDENCE.md).

## Benchmark evidence

Evidence Drop 01 adaptive v2 completed all 30 matched blocks with zero invalid
blocks. BrowserIR passed 30/30 and official Playwright MCP passed 27/30: 27
both passed and 3 were BrowserIR wins. The observed paired lift is +10.00
percentage points with a conservative 95% interval from −39.59 to +59.59
points, so the predeclared result is **inconclusive**. The historical v1 prefix
remains an aborted diagnostic. The official Playwright MCP control is pinned at
`0.0.78`; broker injection, the
neutral agent prompt, counterbalanced matched runner, paired interval,
model-facing tool traces, and create-only comparison artifacts have focused
tests. Both BrowserIR and Playwright MCP deterministic reference models can
complete `create-customer` through real Chromium and the same sealed
database/audit oracle.

Evidence Drop 02 now has a provisional local freeze candidate. The discovered
direct-navigation oracle bypass was fixed test-first, and the regenerated task
and oracle bindings pass the local manifest preflight. The candidate at
[`sealed.protocol.json`](evidence-drops/drop-02/sealed.protocol.json) has
SHA-256
`a3b2da51540f2784dab7d324977c30fb98ced1aabe9551746083725ee243d1a3`.
It selects the real-model-unexposed `query-three-conditions` fixture workflow,
fixes Qwen3.8-Max across the same complete interfaces, and schedules 30 fresh
matched blocks with new order and paired model seeds and no adaptive lineage to
Drop 01. This remains a known-fixture complete-interface comparison—not raw
DOM, a pure representation ablation, or unseen-site generalization. No model
call or result exists. The complete local v17 gate is green; hosted
qualification, commit, push, and the annotated tag remain pending. Until they
complete, the local candidate is not a frozen Git
source and scored execution is prohibited.

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
criteria and official Playwright MCP did not submit. This is a BrowserIR
treatment-path signal only, not an official-control capability pass; its 95%
paired bound is still −100 to +100 percentage points. The full adaptive history
and exact caveats are in the
[development feedback ledger](EVIDENCE_DROPS.md#development-feedback-ledger).

The v6 and v7 bundles have stable start/end environment bindings, hash-chained
journals, checksums, and atomic completion markers. They still record
`source.clean=false`, `revision=null`, and `tree=null`; v7 also captured a
different pnpm runtime than v6. They are not source-bound release evidence and
cannot prove which code change caused the result.

The operator stopped v1 after nine complete matched blocks; a tenth control arm
had completed while its treatment arm was in flight. The unplanned prefix has
no arm-rate estimate, paired lift, interval, or result wording. It remains an
aborted diagnostic, not a shortened run. The
[checksummed aborted bundle](evidence-drops/drop-01/aborted-v1-diagnostic/README.md)
contains no completion marker or scored summary. The separate
score-excluded official-control qualification completed from clean source at
commit `6a122a2` on the already-seen `create-customer` task. One selected
OpenRouter `qwen/qwen3.8-max` configuration ran the full five-attempt schedule
through the safe browser-tool subset exposed by official Playwright MCP
`0.0.78`, with no early stop, replacement, or resume: **5 passed, 0 failed, 0
invalid**. The run recorded 56 tool calls, 61 model turns, zero tool errors, and
five exact database/audit/structured submissions.

The gate contained no BrowserIR arm. Its raw 5/5 is therefore not a score,
pass-rate estimate, uplift result, generalization result, or competitor-
superiority claim. It atomically reserved its create-only output before
provider, model, or browser work and retained start/end model metadata plus
exact installed agent/control/Playwright package and Chromium
executable/version provenance; drift failed closed.
[Inspect the checksummed qualification summary](evidence-drops/drop-01/control-capability-qwen38max-v1-run/summary.md).
The retained bundle's `SHA256SUMS` file has SHA-256
`35457e6cc2846c4b57e1392df0bcd68982d4369ad017058b9c7eef35653561f6`;
this is a content-integrity identifier, not standalone authentication without
trusted Git source context.
The v1 failure diagnosis found the model selecting `browser_act` but encoding
the nested `action` object as a JSON string. LangChain rejected those calls
before the BrowserIR broker, so no browser action could be dispatched. The
model-facing action and wait schemas are now flat and strict, and failed runs
retain bounded pre-broker rejection counts plus partial turn/usage metrics.
Two score-excluded canaries passed the exact judge on the already-seen
`create-customer` workflow after the fix. Those canaries are compatibility
checks, not a score. The later v2 comparison remains a controlled adaptive
complete-interface pilot, not raw-DOM evidence, a pure representation
ablation, independent confirmation, generalization, or a superiority claim. See
[the evidence-drop protocol](EVIDENCE_DROPS.md).

The historical v1 manifest is frozen at
[`sealed.protocol.json`](evidence-drops/drop-01/sealed.protocol.json) and bound
to `refs/tags/evidence-drop-01-protocol-v1`. It fixes the selected OpenRouter
Qwen3.8-Max route/configuration, both tool-catalog hashes, one reserved
workflow, 30 counterbalanced matched pairs, shared precommitted per-pair seeds,
the full schedule/no-replacement policy, and sign-independent publication.
With the conservative bound used here, 30 pairs can only support a positive or
negative headline for a large observed effect; otherwise the declared result
is inconclusive. Its aborted output cannot be resumed or finalized as a result.

Adaptive v2 reuses those exact 30 seeds and arm orders to isolate the flat-tool
contract change, but starts every control and treatment arm again in fresh
state. Its [frozen manifest](evidence-drops/drop-01/sealed-adaptive-v2.protocol.json)
is bound to `evidence-drop-01-protocol-v2` at commit `5b7db58`; hosted freeze
run `31600711043` is green. No v1 arm was reused, and v2 is explicitly an
adaptive recovery rather than independent confirmation. The completed bundle
has a valid `COMPLETE.json` and retained checksums:
[inspect its summary](evidence-drops/drop-01/drop-01-qwen38max-validation-recovery-adaptive-v2-run-01/summary.md)
or [read the outcome analysis](evidence-drops/drop-01/adaptive-v2-analysis.md).
Result-publication commit `e448b58` passed hosted run `31608404916` and is bound
by annotated tag `evidence-drop-01-adaptive-v2-result`.

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
4. Promote the v16 dossier for commit `e448b58` unchanged to approved
   durable storage before its 2026-11-10 CI expiry, and record that location.
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
