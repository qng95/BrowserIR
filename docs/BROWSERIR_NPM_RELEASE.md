# Publishing `browserir-mcp`

This is the only current BrowserIR npm release path. The legacy three-package
release checklist does not apply to the Playwright MCP thin layer.

Preparing these files does not publish anything. A release happens only when a
maintainer pushes an approved `browserir-mcp-v*` tag and approves the protected
`npm` environment deployment.

## Release invariants

- The package name is exactly `browserir-mcp`.
- Public releases use npm's default `latest` dist-tag and install as
  `npm install browserir-mcp`.
- A normal release tag is exactly `browserir-mcp-v<package.json version>`.
- If a protected workflow fails before npm accepts any bytes, a fixed workflow
  may use `browserir-mcp-v<package.json version>-retry.<positive integer>`.
  Retry tags never change the npm package version and must not be used after a
  registry version exists.
- The tag's commit must be contained in the repository's default branch.
- GitHub environment `npm` must protect the publish job with required reviewers
  and allow only release tags.
- After the one-time bootstrap, the workflow uses npm trusted publishing. It
  has `id-token: write`, no npm token, and publishes with provenance.
- The GitHub repository must be public when publishing; npm cannot generate a
  provenance attestation for a public package built from a private repository.
- Build, dependency installation, tests, and package lifecycle code run in a
  separate job that cannot mint an OIDC token. The protected publish job checks
  the retained archive's SHA-256 and runs no repository code.
- npm receives the exact `.tgz` archive that the release verifier inspected.
  Publish-time lifecycle scripts are disabled.
- npm versions are immutable after publication. Never replace published bytes;
  fix the problem and choose a new version.

## Before the first public version

Namespace availability is not publishing authority. The `0.1.0` manifest is a
prepared release candidate under the new `browserir-mcp` package identity. The
earlier `browserir@0.1.0` attempts never created a registry version, so the
initial `browserir-mcp` release remains `0.1.0`. A local candidate tag may exist
for review, but do not push or announce it as a release until the maintainer
account is confirmed to have publish rights for the unscoped `browserir-mcp`
name.

The package must exist on npm before npm can attach a GitHub trusted publisher
to it. Bootstrap the first version once:

1. Enable 2FA on the maintainer account that will own the unscoped package.
2. Create a short-lived granular access token with the narrowest available
   write access to `browserir-mcp` (or the narrowest account-level permission npm
   permits before an unscoped package exists). Because this is a
   non-interactive first publish, enable bypass-2FA only on this temporary token.
   Do not use a classic token.
3. From a clean, reviewed release commit, run the build, package tests,
   typecheck, and release verifier.
4. Create and protect the GitHub `npm` environment with required reviewers and
   a deployment rule limited to the release-tag pattern. Protect tag creation
   in the repository as well.
5. Add the token temporarily as `NPM_TOKEN` in the protected GitHub `npm`
   environment. Push the matching first-version tag, inspect the retained
   candidate and verifier report, then approve the environment deployment. The
   publish job accepts this token only while npm reports that the package does
   not yet exist; it still publishes from GitHub-hosted Actions with provenance.
6. Delete the granular token immediately after the registry confirms the
   package. Remove any temporary CI secret or npm configuration that referenced
   it. Rotate it instead of investigating in place if it may have leaked.
7. In npm package settings, configure a GitHub Actions trusted publisher for
   organization `qng95`, repository `BrowserIR`, workflow
   `publish-browserir.yml`, and environment `npm`. Allow `npm publish`
   only; do not grant staged-publish permission unless the workflow adopts it.
8. In npm **Publishing access**, require 2FA and disallow traditional tokens
   after the trusted publisher is configured.

The token-authenticated bootstrap is an explicit trusted-publishing exception,
even though its GitHub-hosted publish has provenance. Every subsequent version
uses OIDC; the workflow rejects an injected `NPM_TOKEN` once the package exists.
No long-lived npm token belongs in repository or environment secrets.

## Candidate checks

Run from the workspace root on the exact commit to tag:

```sh
pnpm install --frozen-lockfile
pnpm --filter browserir-mcp build
pnpm --filter browserir-mcp typecheck
pnpm --filter browserir-mcp test
pnpm test:release-verifier
pnpm test:archive-auditor
node scripts/verify-browserir-release.mjs \
  --artifact-directory output/npm-candidate \
  --expected-version <version>
node scripts/audit-browserir-archive.mjs \
  --archive output/npm-candidate/browserir-mcp-<version>.tgz \
  --report output/npm-audit/browserir-mcp-<version>-audit.json
```

The verifier and exact-archive auditor must reject the candidate unless all of
these are true:

- release metadata, public access, Apache-2.0 license, exports, Node support,
  and the package version are internally consistent;
- there are no consumer install hooks (`preinstall`, `install`, `postinstall`,
  or `prepare`); `prepack` is a maintainer-side build hook only;
- the archive has an exact allowlist and contains no source, source maps,
  credentials, local configuration, benchmark output, or unrelated workspace
  files;
- a clean temporary consumer can install and import the packed package; and
- the production dependency audit has no unreviewed vulnerability.

Also review the dependency diff, lockfile diff, `npm pack` contents, secret-scan
result, license result, and security-sensitive code changes. A passing scanner
does not replace that review.

### `@modelcontextprotocol/client` decision for 0.1

The emitted JavaScript has no external runtime import; the generated public
types reference the official MCP `Client`. Version `0.1` deliberately keeps
`@modelcontextprotocol/client@2.0.0` as an exact dependency so a fresh consumer
receives the same client contract the declarations were built against. The
qualified closure is 15 production packages, has no install hooks, and the
current advisory audit reports zero vulnerabilities. Reconsider a peer + dev
dependency after compatibility across multiple official client versions is
demonstrated; do not change this boundary during a release.

## Normal OIDC release

1. Choose a new version and update the changelog and package documentation.
2. Complete the candidate checks from a clean checkout.
3. Merge the exact release commit to the protected default branch.
4. Create and push `browserir-mcp-v<version>` at that commit. Use the documented
   retry suffix only to recover from a pre-publication workflow failure.
5. Review the pending `npm` environment deployment. Confirm the commit, version,
   dependency diff, test result, retained candidate, and release-verifier report
   before approving it.
6. The workflow rebuilds, tests, verifies, and uploads the candidate without
   OIDC permission. After approval, a separate job checks the downloaded
   archive's name and SHA-256, then publishes it under `latest` with npm
   provenance.
7. Confirm the registry version, `latest` dist-tag, provenance attestation,
   README rendering, license, dependency list, and installation in a fresh
   consumer project.

The workflow intentionally stops when the tag and manifest version differ, the
commit is not on the default branch, npm is too old for trusted publishing, more
than one archive exists, the archive name is unexpected, or a bootstrap token
remains configured after the package exists.

## If a release is wrong

Do not overwrite the version. Move `latest` to a known-good version when
appropriate, deprecate the affected version with a precise warning, publish a
fixed new version, and document the incident. Use npm unpublish only when its
policy and the incident response decision explicitly require it.

## npm references

- [Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers/)
- [Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements/)
- [Creating and publishing unscoped public packages](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)
