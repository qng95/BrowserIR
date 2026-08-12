# Evidence Drop 01 — adaptive v2 analysis

> This is a controlled, adaptive fixture pilot. It is not an independent confirmation or a general browser-agent benchmark.

## Result

On the fixed `validation-recovery` workflow, BrowserIR passed 30/30 matched attempts and the official Playwright MCP accessibility-snapshot arm passed 27/30.

| Result | BrowserIR | Playwright MCP |
| --- | ---: | ---: |
| Passed | 30 / 30 | 27 / 30 |
| Pass rate | 100% | 90% |
| Invalid attempts | 0 | 0 |

The paired treatment-minus-control estimate was **+10.00 percentage points**, with a predeclared 95% paired Hoeffding interval of **-39.59 to +59.59 percentage points**. Because that interval crosses zero, the protocol classifies the result as **inconclusive**.

The 30 matched outcomes were 27 both-pass, 3 BrowserIR wins, 0 Playwright MCP wins, 0 both-fail, and 0 invalid. This is evidence about one local workflow, one model configuration, and one fixed schedule. It is not a raw-DOM comparison and does not establish general BrowserIR superiority.

## What the three control failures were

The protocol uses zero-based trial indexes.

- Trial 14 recorded two result-submission attempts and one tool error. Its database and collateral-mutation checks passed, but the deterministic judge failed the `structured-result` criterion.
- Trials 25 and 27 each recorded one submission and no tool error. Both failed the `database-and-audit-oracle` and `no-collateral-audited-mutations` criteria.
- BrowserIR passed all three matched attempts. Across all 30 BrowserIR attempts, the journal recorded no tool errors and no adapter-side schema rejections.

No private task values or model conversation are needed to classify these failures; the published journal retains only public-safe metrics, hashes, tool names, input-key names, and judge outcomes.

## How the run was controlled

Both arms used the same Qwen3.8-Max LangChain agent, system prompt, local target, hidden database-and-audit judge, per-attempt budgets, and 30-trial schedule. Arm order and model seeds were fixed before this run. The runner completed the entire schedule, made no replacement runs, retained every failure, and was bound to exact tool-catalog hashes.

The predeclared decision rule required all 30 scheduled blocks, allowed at most one invalid block, and called a direction only if the 95% paired interval excluded zero. Publication was required regardless of sign. All 30 blocks were valid, but the interval remained too wide to support a directional claim.

## Why this was an adaptive recovery

The withdrawn v1 execution was stopped after nine completed blocks when every BrowserIR attempt had failed before dispatching a browser action. Investigation found that the model was selecting `browser_act` but encoding the nested action object as a JSON string. The adapter rejected that shape before it reached the BrowserIR broker, and repeated retries ended in timeouts or model-budget exhaustion.

The recovery changed the model-facing boundary, not the task or judge:

- action and wait arguments are now flat, with `kind`, revision-bound target references, and action values at the top level;
- returned actionable context exposes copy-ready target references;
- strict validation rejects malformed references and incompatible fields;
- pre-broker schema rejections and partial failed attempts are retained as public-safe telemetry.

The revised interface passed deterministic qualification and real-model canaries before the sealed v2 run. V2 then reused the predecessor's exact schedule to isolate the contract correction. Because the correction was chosen after observing v1 failure, v2 is explicitly labeled `adaptive-recovery-not-independent-confirmation`. A new frozen task corpus and schedule are required for independent confirmation.

## Reproduce and audit

- Frozen protocol: [`sealed-adaptive-v2.protocol.json`](./sealed-adaptive-v2.protocol.json)
- Complete evidence bundle: [`drop-01-qwen38max-validation-recovery-adaptive-v2-run-01`](./drop-01-qwen38max-validation-recovery-adaptive-v2-run-01/)
- Human-readable sealed summary: [`summary.md`](./drop-01-qwen38max-validation-recovery-adaptive-v2-run-01/summary.md)
- Machine-readable comparison: [`comparison.json`](./drop-01-qwen38max-validation-recovery-adaptive-v2-run-01/comparison.json)
- Integrity manifest: [`SHA256SUMS`](./drop-01-qwen38max-validation-recovery-adaptive-v2-run-01/SHA256SUMS)
- Withdrawn predecessor: [`aborted-v1-diagnostic`](./aborted-v1-diagnostic/)

The finalized bundle contains a valid `COMPLETE.json`, 182 hash-chained journal events, 60 completed attempts, and 30 completed matched blocks. Its protocol SHA-256 is `5b666c6b7c18be2bb2128d487cfa78186286bc2855466282a7cb1bd821950c19`. The clean source revision is `5b7db5817eb6a0fcec753c34244e3930d91b64c2`, frozen at `refs/tags/evidence-drop-01-protocol-v2`; the recorded source tree is `d3ebe4af7c8b8d3024a878752bc2c80915d0d4d9`.

The checksum and completion boundary covers the 18 canonical artifacts listed
in `SHA256SUMS`, including the consolidated `journal.ndjson`. The adjacent
`journal/` directory is retained unchanged as redundant per-event operational
copies for inspection; its individual convenience files are not separate
entries in `SHA256SUMS`.

From the copied evidence directory, verify the public artifacts with:

```sh
shasum -a 256 -c SHA256SUMS
```
