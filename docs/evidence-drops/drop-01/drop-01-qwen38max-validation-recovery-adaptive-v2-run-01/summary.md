# BrowserIR Evidence Drop comparison

> This is a controlled fixture pilot. It is not a general browser-agent benchmark.

**Pilot was inconclusive for this precommitted schedule; the 95% paired interval crosses zero.**

- Run: drop-01-sealed-2026-08-12T13-26-10-153Z
- Protocol: drop-01-qwen38max-validation-recovery-adaptive-v2 (sealed)
- Protocol SHA-256: 5b666c6b7c18be2bb2128d487cfa78186286bc2855466282a7cb1bd821950c19
- Control: Official Playwright MCP 0.0.78 accessibility-snapshot interface 0.0.78
- Treatment: BrowserIR complete semantic interaction interface with flat action contract 0.1.0+mcp-2026-07-28
- Schedule seed: 20260811
- Target version: sha256:7d62e7e3e4ae0b02883d1606ca2e1eaad15a93d0dca6d582bf86c1525ca89364
- Budgets: 300000 ms, 100 tool calls, 30 model turns per attempt
- Estimand: fixed-workflow-precommitted-seed-schedule
- Publication rule: publish-regardless-of-sign
- Decision rule: at least 30 scheduled matched blocks, no more than 1 invalid; positive only when the 95% lower bound is above 0, negative only when the upper bound is below 0, otherwise inconclusive

## Primary result

Paired treatment-minus-control success lift: **+10.00 percentage points (95% paired CI -39.59 to +59.59 pp)** across 30 valid matched block(s).
Interval method: paired-hoeffding-bound.

| Arm | Passed / paired-valid attempts | Pass rate | Invalid |
| --- | ---: | ---: | ---: |
| Official Playwright MCP 0.0.78 accessibility-snapshot interface | 27 / 30 | 90.00% | 0 |
| BrowserIR complete semantic interaction interface with flat action contract | 30 / 30 | 100.00% | 0 |

Matched outcomes: 3 treatment win(s), 0 control win(s), 27 both passed, 0 both failed, and 0 invalid block(s).

Invalid attempts remain in the evidence and are excluded only from the paired lift denominator. They are never silently rerun.

## Matched blocks

| Block | Task | Trial | Order | Outcome | Control | Treatment |
| --- | --- | ---: | --- | --- | --- | --- |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:0 | validation-recovery | 0 | treatment → control | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:1 | validation-recovery | 1 | control → treatment | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:2 | validation-recovery | 2 | treatment → control | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:3 | validation-recovery | 3 | control → treatment | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:4 | validation-recovery | 4 | treatment → control | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:5 | validation-recovery | 5 | control → treatment | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:6 | validation-recovery | 6 | treatment → control | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:7 | validation-recovery | 7 | control → treatment | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:8 | validation-recovery | 8 | treatment → control | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:9 | validation-recovery | 9 | control → treatment | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:10 | validation-recovery | 10 | treatment → control | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:11 | validation-recovery | 11 | control → treatment | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:12 | validation-recovery | 12 | treatment → control | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:13 | validation-recovery | 13 | control → treatment | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:14 | validation-recovery | 14 | treatment → control | treatment_win | failed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:15 | validation-recovery | 15 | control → treatment | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:16 | validation-recovery | 16 | treatment → control | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:17 | validation-recovery | 17 | control → treatment | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:18 | validation-recovery | 18 | treatment → control | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:19 | validation-recovery | 19 | control → treatment | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:20 | validation-recovery | 20 | treatment → control | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:21 | validation-recovery | 21 | control → treatment | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:22 | validation-recovery | 22 | treatment → control | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:23 | validation-recovery | 23 | control → treatment | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:24 | validation-recovery | 24 | treatment → control | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:25 | validation-recovery | 25 | control → treatment | treatment_win | failed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:26 | validation-recovery | 26 | treatment → control | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:27 | validation-recovery | 27 | control → treatment | treatment_win | failed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:28 | validation-recovery | 28 | treatment → control | both_passed | passed | passed |
| drop-01-sealed-2026-08-12T13-26-10-153Z:validation-recovery:29 | validation-recovery | 29 | control → treatment | both_passed | passed | passed |
