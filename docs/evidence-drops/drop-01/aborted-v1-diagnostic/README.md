# Evidence Drop 01 — aborted v1 diagnostic

> **Withdrawn run. Diagnostic evidence only. This is not a benchmark result.**

The first sealed execution was deliberately stopped before its fixed 30-block schedule completed. Nine paired blocks had completed, and the treatment arm had dispatched no browser actions in its nine completed attempts. Continuing the paid run without first investigating that pattern would have produced more failures, not better evidence.

The retained journal ends during block 10, immediately after the treatment attempt started. It has no `run_completed` event, so this bundle must not be scored, summarized as uplift, or presented as Evidence Drop 01.

## Durable state at interruption

| Fact | Journal value |
|---|---:|
| Scheduled blocks | 30 |
| Blocks started / completed | 10 / 9 |
| Completed attempts | 19 |
| Control completed | 10 passed, 85 dispatched actions |
| Treatment completed | 9 failed, 0 dispatched actions |
| Active attempt at the tail | block 10 treatment |
| Journal events | 59 (`0` through `58`) |
| Final event hash | `e36c5a906244d87cd1eb7769426876123d440b2027b392e265a58edf339677ed` |

These are incomplete-run diagnostics, not comparative scores. The journal records the symptom but intentionally contains no raw model conversation, so this bundle does not claim a causal explanation for it.

## What is preserved

- The frozen protocol, system prompt, tool catalogs, and start-stage environment/build/runtime provenance, copied byte-for-byte.
- The complete 59-file public-safe journal prefix, with its original sequence and SHA-256 chain unchanged.
- [`ABORTED.json`](./ABORTED.json), a machine-readable non-scoreability marker and exact durable counts.
- `SHA256SUMS`, covering every bundled file except the checksum manifest itself.

There is deliberately no `COMPLETE.json`, paired comparison, scored summary, end-stage provenance, raw model text, or secret material.

## Verify

From this directory:

```sh
shasum -a 256 -c SHA256SUMS
```

The source revision for this withdrawn execution was `89c82ff4d89ec33c1311df65729306c579192357`, frozen at `refs/tags/evidence-drop-01-protocol-v1`.
