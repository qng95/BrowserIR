# Evidence Drop 02 outcome analysis

## Result

The predeclared verdict is **inconclusive**.

Across 30 valid matched `query-three-conditions` blocks, BrowserIR passed
**21/30** and official Playwright MCP in accessibility-snapshot mode passed
**20/30**. The paired treatment-minus-control estimate is **+3.33 percentage
points**, with a conservative 95% paired Hoeffding interval of **−46.26 to
+52.92 points**. Matched outcomes were 1 BrowserIR win, 0 control wins, 20 both
pass, 9 both fail, and 0 invalid.

The interval crosses zero. This run therefore does not establish that either
interface is better.

## What happened in the nine-pair tail

Trials 21–29 are a contiguous provider-contaminated both-failed tail. Exhausted
OpenRouter credit is the best explanation; it is not independently proven as
the cause and the failures are not clean evidence about either browser
interface.

- Trial 21 control completed the required database and audit state but the
  provider failed before the required structured submission. Its BrowserIR arm
  then failed before any model turn or tool call.
- Every arm in trials 22–29 failed before any model turn or tool call.
- All affected arms carry the same redacted agent-error SHA-256,
  `a8004610c26791b262391a4c109f06b0b2385d12e276f9e1832c9140cd1977db`.
- A read-only provider-account check after the run found exhausted credit. No
  account balance or usage amount is published.

The post-run account check plus the abrupt identical-digest, zero-turn pattern
support the diagnosis but do not independently prove causality. The common-mode
tail prevents clean interpretation of the absolute 21/30 and 20/30 pass rates
as interface capability under continuously available model service.

## Why the published score does not change

The frozen protocol classifies these completed attempts as failed rather than
invalid. It recorded all 30 blocks as valid, and the publication rule requires
every scheduled outcome to remain visible. The canonical result therefore
stays 21/30 versus 20/30, 0 invalid, and inconclusive.

There is no post-hoc reclassification, shortened-prefix score, replacement, or
selective rerun. A future campaign may use a separately frozen protocol with
provider-credit preflight and explicit quota-failure handling; it cannot
rewrite this result.

## Integrity boundary

[`COMPLETE.json`](drop-02-qwen38max-query-three-conditions-v1-run-02/COMPLETE.json)
and [`SHA256SUMS`](drop-02-qwen38max-query-three-conditions-v1-run-02/SHA256SUMS)
bind 18 canonical artifacts, including the consolidated `journal.ndjson`. The
retained `journal/` directory contains redundant per-event convenience copies;
those files are not individually listed in `SHA256SUMS`. The manifest itself
has SHA-256
`ca4f5ea763362a53a35314cc2b15995338c9813cefd5c4177899680e290c8c27`.

## Claim boundary

Drop 02 used one Qwen3.8-Max configuration, one neutral agent, one new
real-model slice within a known fixture, and the complete BrowserIR and
official Playwright MCP interfaces. It is not:

- a raw-DOM comparison;
- a pure representation ablation;
- unseen-site or multi-workflow generalization evidence; or
- a superiority result.

[Inspect the unchanged result](drop-02-qwen38max-query-three-conditions-v1-run-02/summary.md) ·
[Inspect the frozen protocol](sealed.protocol.json)
