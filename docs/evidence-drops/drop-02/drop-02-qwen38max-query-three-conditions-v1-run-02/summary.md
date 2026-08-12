# BrowserIR Evidence Drop comparison

> This is a controlled fixture pilot. It is not a general browser-agent benchmark.

**Pilot was inconclusive for this precommitted schedule; the 95% paired interval crosses zero.**

- Run: drop-02-sealed-2026-08-12T16-24-31-532Z
- Protocol: drop-02-qwen38max-query-three-conditions-v1 (sealed)
- Protocol SHA-256: a3b2da51540f2784dab7d324977c30fb98ced1aabe9551746083725ee243d1a3
- Control: Official Playwright MCP 0.0.78 accessibility-snapshot interface 0.0.78
- Treatment: BrowserIR complete semantic interaction interface with flat action contract 0.1.0+mcp-2026-07-28
- Schedule seed: 1515077191
- Target version: sha256:5609bf1a1e9286c14a85eb8be641104f124b7e830e6b182789de6fcb9eb7fdec
- Budgets: 300000 ms, 100 tool calls, 30 model turns per attempt
- Estimand: fixed-workflow-precommitted-seed-schedule
- Publication rule: publish-regardless-of-sign
- Decision rule: at least 30 scheduled matched blocks, no more than 1 invalid; positive only when the 95% lower bound is above 0, negative only when the upper bound is below 0, otherwise inconclusive

## Primary result

Paired treatment-minus-control success lift: **+3.33 percentage points (95% paired CI -46.26 to +52.92 pp)** across 30 valid matched block(s).
Interval method: paired-hoeffding-bound.

| Arm | Passed / paired-valid attempts | Pass rate | Invalid |
| --- | ---: | ---: | ---: |
| Official Playwright MCP 0.0.78 accessibility-snapshot interface | 20 / 30 | 66.67% | 0 |
| BrowserIR complete semantic interaction interface with flat action contract | 21 / 30 | 70.00% | 0 |

Matched outcomes: 1 treatment win(s), 0 control win(s), 20 both passed, 9 both failed, and 0 invalid block(s).

Invalid attempts remain in the evidence and are excluded only from the paired lift denominator. They are never silently rerun.

## Matched blocks

| Block | Task | Trial | Order | Outcome | Control | Treatment |
| --- | --- | ---: | --- | --- | --- | --- |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:0 | query-three-conditions | 0 | treatment → control | both_passed | passed | passed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:1 | query-three-conditions | 1 | control → treatment | both_passed | passed | passed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:2 | query-three-conditions | 2 | treatment → control | both_passed | passed | passed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:3 | query-three-conditions | 3 | control → treatment | both_passed | passed | passed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:4 | query-three-conditions | 4 | treatment → control | both_passed | passed | passed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:5 | query-three-conditions | 5 | control → treatment | both_passed | passed | passed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:6 | query-three-conditions | 6 | treatment → control | both_passed | passed | passed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:7 | query-three-conditions | 7 | control → treatment | both_passed | passed | passed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:8 | query-three-conditions | 8 | treatment → control | both_passed | passed | passed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:9 | query-three-conditions | 9 | control → treatment | both_passed | passed | passed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:10 | query-three-conditions | 10 | treatment → control | both_passed | passed | passed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:11 | query-three-conditions | 11 | control → treatment | treatment_win | failed | passed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:12 | query-three-conditions | 12 | treatment → control | both_passed | passed | passed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:13 | query-three-conditions | 13 | control → treatment | both_passed | passed | passed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:14 | query-three-conditions | 14 | treatment → control | both_passed | passed | passed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:15 | query-three-conditions | 15 | control → treatment | both_passed | passed | passed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:16 | query-three-conditions | 16 | treatment → control | both_passed | passed | passed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:17 | query-three-conditions | 17 | control → treatment | both_passed | passed | passed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:18 | query-three-conditions | 18 | treatment → control | both_passed | passed | passed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:19 | query-three-conditions | 19 | control → treatment | both_passed | passed | passed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:20 | query-three-conditions | 20 | treatment → control | both_passed | passed | passed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:21 | query-three-conditions | 21 | control → treatment | both_failed | failed | failed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:22 | query-three-conditions | 22 | treatment → control | both_failed | failed | failed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:23 | query-three-conditions | 23 | control → treatment | both_failed | failed | failed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:24 | query-three-conditions | 24 | treatment → control | both_failed | failed | failed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:25 | query-three-conditions | 25 | control → treatment | both_failed | failed | failed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:26 | query-three-conditions | 26 | treatment → control | both_failed | failed | failed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:27 | query-three-conditions | 27 | control → treatment | both_failed | failed | failed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:28 | query-three-conditions | 28 | treatment → control | both_failed | failed | failed |
| drop-02-sealed-2026-08-12T16-24-31-532Z:query-three-conditions:29 | query-three-conditions | 29 | control → treatment | both_failed | failed | failed |
