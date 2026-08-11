# BrowserIR evidence drops

## Why the evidence ships in small drops

BrowserIR is a browser representation and action layer, not an agent. Its
central product claim is therefore causal: keeping the agent, model, task,
browser, budget, and success judge fixed, does changing the browser interface
to BrowserIR improve the result?

A single enormous benchmark matrix would delay feedback and produce no public
evidence for a long time. BrowserIR instead publishes one narrow, reproducible
comparison at a time. Every evidence drop contains one claim, the complete
unfavorable as well as favorable evidence, a visual result card, reproduction
instructions, and any general product improvement exposed by the run.

An evidence drop is not complete when a score appears. It is complete when the
protocol, attempts, diagnosis, source, documentation, and release are bound
together and pushed.

## The drop lifecycle

1. **Choose one question.** State one task or benchmark slice and the exact
   claim it can support. Broader interpretation is written down as out of scope.
2. **Build on development tasks.** Test the adapters, neutral prompt, budgets,
   telemetry, and judge on tasks excluded from the sealed score.
3. **Freeze the protocol.** Commit a machine-readable manifest containing both
   interfaces, model snapshot, prompt hash, browser profile, task versions,
   trial schedule, seeds, budgets, invalid policy, statistics, stopping rule,
   and claim rules.
4. **Run every scheduled block.** Each matched block runs both arms with a fresh
   database, browser, and model conversation. Arm order alternates from a
   committed seed. There is no early stopping or favorable rerun.
5. **Judge outside the page.** Browser and tool access close before the private
   database-and-audit oracle assigns a binary result.
6. **Publish the result honestly.** Failed and invalid attempts remain visible.
   JSON, NDJSON, Markdown, catalogs, publication-safe traces, environment,
   checksums, and source binding ship together. Raw diagnostic values stay
   private and are never committed as evidence.
7. **Diagnose every BrowserIR loss.** The score never changes during diagnosis.
   Trace evidence assigns a failure class and identifies whether a general
   BrowserIR defect exists.
8. **Improve test-first.** Reduce a genuine defect to a technology-neutral UI
   pattern, add a failing regression and an adversarial negative, then implement
   the smallest general fix. Task IDs, record values, site classes, and
   fixture-specific selectors are forbidden in production inference.
9. **Verify and release.** Run focused tests, affected packages, representation
   and qualification gates, update the README and announcement assets, commit,
   push, and tag the drop.
10. **Move to a new sealed slice.** A rerun of the same scored task after a fix
    is an adaptive follow-up, not independent confirmation. The next headline
    comes from a previously unmeasured slice.

## Development and sealed evidence are different

Development tasks may be run repeatedly while the agent adapter or BrowserIR is
improved. Their results guide engineering and may be reported as development
diagnostics, but they do not support the public uplift headline.

A sealed run begins only after its manifest is frozen in Git. From that point,
the task, prompt, agent, model, interfaces, dependencies, budgets, schedule,
statistics, and analysis rules cannot change. A protocol change creates a new
version. A negative sealed result remains published even when it motivates a
later fix.

The dealership fixture has already been used throughout BrowserIR development.
Sealing an agent comparison prevents post-protocol score tuning; it does not
turn the fixture into evidence of unseen-site generalization.

## Matched comparison contract

Every block has two separate, freshly provisioned attempts:

| Fixed within a block | Control | Treatment |
| --- | --- | --- |
| Agent loop | Same neutral LangChain agent | Same neutral LangChain agent |
| Model and sampling | Exact same snapshot and settings | Identical |
| Task and judge | Fresh seed, same prompt, same hidden oracle | Identical |
| Browser profile | Chromium, 1440×900, DPR 1, `en-US`, UTC, light, reduced motion | Identical |
| Budgets | Same time, tool-call, and model-turn limits | Identical |
| Browser interface | Pinned official Playwright MCP | BrowserIR MCP |

The intervention is the complete browser interface: representation, references,
tool schemas, and action semantics. Tool catalogs are not artificially made
identical. Both catalogs and hashes are published, and arbitrary evaluation,
server-side code execution, network-body inspection, and unrestricted file
paths are absent from the scored control policy.

The primary metric is:

```text
paired success lift = BrowserIR pass rate − control pass rate
```

The runner publishes raw arm pass rates, BrowserIR wins, control wins, both-pass
and both-fail blocks, invalid blocks, and a conservative 95% Hoeffding bound
over treatment-minus-control block outcomes (`+1`, `0`, or `-1`). The bound
retains uncertainty even when every observed outcome is identical; a single
favorable pair cannot collapse into a certainty claim. Token, response-byte,
tool-call, model-turn, and agent-run-time measurements are secondary.
Token or cost language is suppressed unless normalized provider usage exists
for at least 95% of valid attempts.

## Claim rules

| Result | Public wording |
| --- | --- |
| 95% paired interval entirely above zero | “BrowserIR had higher success across this precommitted workflow/seed schedule.” |
| Interval crosses zero | “Pilot was inconclusive for this precommitted schedule.” No uplift headline. |
| Interval entirely below zero | “BrowserIR had lower success across this precommitted workflow/seed schedule.” Publish and start the diagnosis loop. |
| More than 5% of scheduled blocks invalid | “Operationally inconclusive.” No uplift headline. |

Invalid means the infrastructure could not support a trustworthy score; it is
not a model failure. An invalid block is excluded from the paired denominator
only, retained in full, and never silently converted or rerun. Any replacement
rule must be committed before the run and retain both records.

## Failure taxonomy and feedback loop

Diagnostic labels never change pass/fail. Every label cites trace or oracle
evidence:

1. observation missing;
2. observation incorrect or invented;
3. observation ambiguous;
4. representation or context overload;
5. identity, revision, or stale-target failure;
6. capability or action-target failure;
7. dispatch or actionability failure;
8. wait, delta, or effect-verification failure;
9. tool-schema or agent-adapter ergonomics;
10. model planning or reasoning;
11. budget or policy exhaustion;
12. submission or reporting failure; or
13. target or benchmark infrastructure invalid.

When BrowserIR makes an attempt worse, the investigation asks three separate
questions: what happened, whether BrowserIR caused it, and whether the cause is
generalizable. Only a generalizable product defect enters BrowserIR production
code. Model mistakes, target defects, and benchmark defects remain visible but
are fixed at their own layer.

## Evidence Drop 01

Status: **development capability signal observed; sealed protocol not frozen
and no public result exists**.

The intended first public question is deliberately narrow:

> On the `validation-recovery` enterprise workflow, does the same model and
> LangChain agent succeed more often with BrowserIR than with pinned official
> Playwright MCP?

The candidate sealed schedule is 30 matched blocks, text-only, with alternating
arm order from a committed order seed, a precommitted model-seed base, and a
non-zero frozen sampling temperature. Each task/trial coordinate
deterministically derives one model seed shared by both arms; temperature-zero
repetition is rejected because greedy decoding may ignore seeds.
`create-customer` is the development task for adapter and reporting work
and is excluded from the Drop 01 score. The first public result must be labelled
a **controlled fixture pilot**, never a general browser-agent benchmark or an
independent-samples population estimate.

The control is pinned to official `@playwright/mcp` `0.0.78`. The exact model
will be frozen only after a development capability check; selecting it after
seeing any `validation-recovery` result is forbidden.

Development is manifest-driven through `pnpm benchmark:uplift`. The original
failed artifacts remain retained; a development failure is an input to the
engineering loop, not something to hide or rerun favorably.

### Development feedback ledger

| Protocol | Development signal | Engineering response |
| --- | --- | --- |
| `v4` — Qwen3 4B/32K | Both arms failed. BrowserIR made 12 calls with 0 tool errors but submitted benchmark completion before the application mutation was complete; the database/audit oracle failed. Control made 28 calls with 8 errors and never submitted. | Measured repeated action-result overhead. Added delta-first receipts and bounded, fail-closed reference rebinding; recycled or structurally changed identities remain stale. |
| `v5` — Qwen3 8B/32K | Both arms failed. BrowserIR stopped without submission after 264.6 seconds; control timed out after 300 seconds. | Rejected the 8B model as too slow for this local 16 GB development environment. Added crash-safe journaling, resume, start/end environment binding, checksums, and a final completion marker. |
| `v6` — Qwen3 4B/32K | Both arms failed. BrowserIR used 9 calls, 0 errors, and 29,986 response bytes but still stopped without submission; control timed out. | Diagnosed that compact delta receipts preserved freshness but did not expose enough “what can I do next?” context. |
| `v7` — Qwen3 4B/32K | BrowserIR passed the database/audit oracle and submitted exactly once; control failed without submission. BrowserIR: 1/1, control: 0/1. | The intended build added bounded forward/visual-order `actionable_context` with fresh post-revision refs and a shorter continuation summary. A deterministic real-browser regression passed at 42,471 model-facing bytes, 18.28% below the 51,970-byte legacy flow. |

> These are adaptive engineering diagnostics, not four samples from one
> experiment. Every protocol used the already-seen, score-excluded
> `create-customer` development task and only one matched block. They must not
> be pooled. In particular, v7's 1/1 result is not sealed, not source-bound,
> and not public benchmark evidence: its workspace was dirty, its Git revision
> and tree are null, and its 95% paired bound remains −100 to +100 percentage
> points. It is a signal to proceed to a frozen run, not evidence of uplift or
> superiority.

These development changes include BrowserIR production inference changes.
The reserved `validation-recovery` task remains untouched and has never been
used to select a fix, model, prompt, or budget. Development success does not
satisfy the public claim rule.

## Drop registry

| Drop | Question | Status | Public result |
| --- | --- | --- | --- |
| 01 | Playwright MCP vs BrowserIR on one database-judged validation-recovery workflow | Pre-seal development; protocol not frozen | Not run |
| 02 | External representation slice | Planned | Not run |
| 03 | WebArena-Verified Hard pilot | Planned | Not run |
| 04 | WorkArena enterprise workflows | Planned | Not run |

The registry grows one released row at a time. Later multi-model and multi-agent
matrices extend the evidence; they do not rewrite earlier drops.
