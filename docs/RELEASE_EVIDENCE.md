# Legacy full-graph BrowserIR release evidence

Scope: retained three-package release pipeline for `@browserir/core`,
`@browserir/playwright`, and `@browserir/mcp`. It is not a release dossier or
promotion path for the `browserir-mcp` thin layer. Its release path
is documented separately in the [BrowserIR npm release guide](BROWSERIR_NPM_RELEASE.md).
This legacy pipeline remains documented because its scripts, schemas, and tests
still exist in this repository.

BrowserIR records release checks as create-only, machine-readable evidence. The
purpose is to make a release claim traceable to one exact source tree, not to
turn a successful local command into permission to publish. Licensing,
repository identity, npm ownership, version/tag selection, and publication
authority remain separate maintainer decisions in the
[release checklist](RELEASE_CHECKLIST.md).

## Evidence model

The pipeline has seven logical gates and requires nine CI fragments:

| Gate | Required runtime | Evidence retained | Release condition |
| --- | --- | --- | --- |
| `workspace-verification` | Node 22.13.0 and 24.19.0 | Typecheck/package-verifier logs, optional recorder-owned build log, and per-package Vitest JSON and JUnit | Every preparation and package suite passes; no failures or errors; exactly the 19 declared opt-in skips |
| `capability-qualification` | Node 24.19.0 | Vitest JSON, JUnit, and command logs | All five browser-backed capability cases pass with no skips |
| `task-qualification` | Node 24.19.0 | Qualification JSON and Markdown plus logs | The command passes and both reports are present and valid; the underlying runner requires all 14 task oracles to pass |
| `representation-qualification` | Node 24.19.0 | JSON, NDJSON, Markdown, JUnit, exact model payloads, and logs | The checked-in representation gate passes and all five reports are present and valid |
| `performance-characterization` | Node 24.19.0 | Environment JSON, raw NDJSON samples, summary JSON/Markdown, and logs | The declared characterization completes and all four reports are present and valid |
| `packed-consumer` | Node 22.13.0 and 24.19.0 | Phase report, transient tarball names/sizes/SHA-256 values, and logs | All phases pass and exactly three package archives were built, inspected, installed, imported, and exercised through stdio |
| `production-audit` | Node 24.19.0 | Raw pnpm audit JSON, normalized counts, classification, and logs | Classification is `passed`, with zero vulnerabilities and zero muted advisories |

Every gate directory is a **fragment**. Schema `1.1.0` contains `evidence.json`, its
gate-specific reports and logs, and `SHA256SUMS`. `evidence.json` records the
gate outcome, timestamps, source identity, runtime and CI environment, command
summaries, and a size and SHA-256 descriptor for every other retained file.
Both successful and failed gates retain a fragment when the recorder can do so;
failed evidence is diagnostic evidence, never release evidence.

The recorder refuses to overwrite an existing output directory. Use a new
filesystem-safe run ID and a new output directory for every attempt:

```sh
pnpm release:evidence workspace-verification \
  --output output/release-evidence/workspace-local-1 \
  --run-id workspace-local-1

pnpm release:evidence capability-qualification \
  --output output/release-evidence/capabilities-local-1 \
  --run-id capabilities-local-1
```

The same command accepts the other five gate names in the table. Only
`workspace-verification` accepts `--skip-build`, for CI jobs that already built
the exact checkout immediately beforehand.

## Source binding

A fragment records:

- the Git commit and tree object;
- Git object format and whether the worktree is dirty;
- `GITHUB_SHA`, when present, and whether it matches `HEAD`;
- the lockfile SHA-256; and
- sizes and SHA-256 values for the root/workspace manifests, lockfile, and
  public and private package manifests that define the tested graph.

The recorder captures that metadata once before dispatching the gate and once
after the gate has finished and its artifacts have been collected. A fragment
can qualify only when both endpoint snapshots are deeply equal, the reported
source equals the second snapshot, `changedFields` is empty, and the assembler
independently recomputes a clean, valid source binding. Schema `1.0.0`
fragments predate this mandatory verification and are rejected.

This is deliberately described as **endpoint verification**. Equal snapshots
detect source drift that remains at the end of a gate; they cannot prove that a
file was never changed and restored between snapshots. Release CI therefore
uses a fresh checkout and must treat tracked source as immutable for the whole
gate. Reviewed gate commands must not rewrite and restore tracked inputs. If
that trust boundary cannot be maintained, run the gate from a read-only source
mount rather than interpreting endpoint equality as continuous monitoring.

The recorder calls source binding `bound` only when the commit and tree are
valid for the repository object format, the worktree is clean, and any supplied
`GITHUB_SHA` matches `HEAD`. Otherwise it records `unbound` with reasons such as
`revision_unavailable`, `dirty_worktree`, or `github_sha_mismatch`.

A gate may pass locally while its source is unbound. That result is useful for
development, but it cannot qualify a release. In particular, evidence from the
current pre-commit or dirty workspace must be described as **local,
dirty/unbound evidence**, not as a release dossier or public baseline.

The 2026-08-26 thin adaptive Playwright A/B is one such separately retained
development result. Its receipt and append-only journal are checksummed and
useful for reproducing the reported 31/32 versus 24/32 outcome, but they are not
release-evidence fragments: the corpus was reused after inspection and the
receipt omits the product policy version and product-source hash. Do not place
that bundle inside a release dossier or infer release qualification from its
statistical result. See [BrowserIR thin-layer real-agent result](BROWSERIR_REAL_AGENT_RESULTS.md).

## Dossier assembly

CI uploads each fragment independently, then the dossier job downloads the
fragments and runs:

```sh
pnpm release:evidence:assemble -- \
  --input output/ci/downloaded \
  --output output/ci/release-dossier \
  --release-id ci-<run-id>-<attempt>
```

The assembler fails closed. It requires all nine exact gate/runtime variants,
rejects duplicates and unknown variants, and verifies every fragment manifest
and checksum. It also requires every fragment to:

- have passed its gate-specific release condition;
- come from a clean, source-bound GitHub Actions checkout;
- contain stable, internally consistent before/after source endpoint
  verification under schema `1.1.0`;
- match one commit, tree, lockfile, source-file set, GitHub run ID, and run
  attempt; and
- contain no symlink, forbidden sensitive/archive file type, malformed path,
  or oversized artifact.

A qualified dossier copies the nine validated fragments, adds
`release-evidence.json`, records the reviewed workspace test-count policy ID,
and writes a top-level `SHA256SUMS`. The policy is an exact per-package and
aggregate inventory: adding, removing, or newly skipping tests requires a
deliberate policy update, and a dossier with a different or missing policy ID
is rejected. If assembly fails
before creating the output directory, the CLI instead attempts to retain a
checksummed `assembly-failure.json`; that file explains a failure and does not
represent qualification.

## Audit classifications

The production audit runs `pnpm audit --prod --audit-level=low --json` and uses
three explicit outcomes:

- `passed`: the report is parseable, the command exits successfully, every
  severity count is zero, and there are no muted advisories;
- `vulnerabilities_found`: at least one vulnerability or muted advisory is
  reported; or
- `audit_unavailable`: the command/report cannot establish a clean result, for
  example because the registry is unavailable or the JSON is invalid.

Both `vulnerabilities_found` and `audit_unavailable` fail the gate. Network
failure is not treated as “no vulnerabilities,” and muted advisories are not
silently accepted. A separate license review is still required because this
gate is a vulnerability audit, not a dependency-license decision.

## Performance evidence is characterization

`performance-characterization` is required so every candidate retains its raw
observation samples and environment. Passing this evidence gate means the run
completed and its declared reports are intact. It does **not** mean:

- that a release baseline has been selected;
- that a candidate passed a comparison against an earlier run; or
- that BrowserIR outperforms Browser-Use, Stagehand, Treegress, Playwright MCP,
  or another system.

The benchmark library has environment-matched regression primitives, but a
published baseline and a fair competitor harness remain separate work. See the
[benchmark methodology](BENCHMARK.md).

## Integrity, authenticity, and retention

`SHA256SUMS` provides content-integrity checks relative to a trusted checksum.
It detects an accidental or malicious byte change after the checksum was
recorded. A SHA-256 value is **not a signature**: by itself it does not prove who
created an artifact, that CI was trustworthy, or that a release was authorized.
Authenticity needs a trusted distribution channel and the project's eventual
tag/signing or provenance policy.

GitHub Actions retains every gate fragment and assembled dossier for 90 days.
Artifacts are immutable within that workflow run, but they expire; the 90-day
CI copy is not durable release storage. Before publication, promote the
qualified dossier unchanged to maintainer-approved durable release storage and
record the source commit, workflow run/attempt, artifact ID, service-provided
digest, retention or permanence policy, and durable URL. Verify the dossier's
top-level `SHA256SUMS` after download and again after promotion.

Evidence can include command logs and model-facing page text. Treat it as
potentially sensitive even though the assembler rejects screenshots, browser
auth/storage state, databases, HAR files, package archives, and common image or
archive formats. Review the exact dossier before durable promotion or public
attachment.

## Binding the dossier to candidate packages

The ordinary packed-consumer smoke uses temporary tarballs and deletes them
after recording their names, sizes, and hashes. Persistent candidate retention
is a separate, maintainer-authorized path:

```sh
node scripts/smoke-packed-consumer.mjs \
  --release-evidence /absolute/path/to/qualified-release-dossier \
  --artifact-directory /absolute/private/path/browserir-release-candidate
```

`--artifact-directory` requires `--release-evidence`, and evidence cannot be
supplied without persistent retention. Before retaining anything, the command
validates the dossier, requires it to match the current clean `HEAD`, tree, and
lockfile, and requires `pnpm verify:legacy-release` to pass. The resulting candidate
contains the three tested `.tgz` files and an unchanged copy of the dossier
under `release-evidence/`; its top-level `SHA256SUMS` covers both the tarballs
and every copied dossier file. Do not rebuild or repack after this point.

## Relationship to publication

A qualified dossier establishes that the automated checks ran against one
clean source revision. It does not resolve npm namespace ownership,
public-package settings, alpha
version/tag, or the final publish authorization. `pnpm verify:legacy-release` remains
an explicit maintainer-run gate and is expected to fail until those decisions
are recorded. No package should be published merely because a dossier exists.
