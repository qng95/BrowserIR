import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  classifySourceBinding,
  finalizeEvidenceDirectory,
  releaseEvidenceSchemaVersion,
  releaseEvidenceSourceFilePaths,
} from './record-release-evidence.mjs';

const assemblerSchemaVersion = releaseEvidenceSchemaVersion;
const maxArtifactBytes = 64 * 1024 * 1024;
const maxDossierBytes = 256 * 1024 * 1024;
/**
 * Reviewed workspace test inventory for release qualification.
 *
 * This is intentionally exact and versioned. Adding, removing, splitting, or
 * newly skipping tests requires a deliberate policy review in the same change.
 */
const workspaceTestCountPolicy = Object.freeze({
  version: '2026-08-11-v14',
  aggregate: Object.freeze({ declared: 689, executed: 670, skipped: 19 }),
  packages: Object.freeze([
    Object.freeze({ package: '@browserir/core', declared: 60, executed: 60, skipped: 0 }),
    Object.freeze({ package: '@think-dom/fixture-app', declared: 98, executed: 98, skipped: 0 }),
    Object.freeze({ package: '@browserir/playwright', declared: 107, executed: 107, skipped: 0 }),
    Object.freeze({ package: '@browserir/benchmark', declared: 235, executed: 235, skipped: 0 }),
    Object.freeze({ package: '@browserir/mcp', declared: 189, executed: 170, skipped: 19 }),
  ]),
});
const requirements = [
  {
    key: 'workspace-verification-node-22.13.0',
    gate: 'workspace-verification',
    node: 'v22.13.0',
  },
  {
    key: 'workspace-verification-node-24.19.0',
    gate: 'workspace-verification',
    node: 'v24.19.0',
  },
  {
    key: 'capability-qualification-node-24.19.0',
    gate: 'capability-qualification',
    node: 'v24.19.0',
  },
  {
    key: 'task-qualification-node-24.19.0',
    gate: 'task-qualification',
    node: 'v24.19.0',
  },
  {
    key: 'representation-qualification-node-24.19.0',
    gate: 'representation-qualification',
    node: 'v24.19.0',
  },
  {
    key: 'performance-characterization-node-24.19.0',
    gate: 'performance-characterization',
    node: 'v24.19.0',
  },
  {
    key: 'packed-consumer-node-22.13.0',
    gate: 'packed-consumer',
    node: 'v22.13.0',
  },
  {
    key: 'packed-consumer-node-24.19.0',
    gate: 'packed-consumer',
    node: 'v24.19.0',
  },
  {
    key: 'production-audit-node-24.19.0',
    gate: 'production-audit',
    node: 'v24.19.0',
  },
];

const sha256 = (content) => createHash('sha256').update(content).digest('hex');

export function releaseEvidenceRequirements() {
  return requirements.map((requirement) => ({ ...requirement }));
}

function validateRelativeArtifactPath(path) {
  if (
    typeof path !== 'string' ||
    path === '' ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid evidence artifact path ${JSON.stringify(path)}.`);
  }
}

function forbiddenArtifact(path) {
  return (
    /(?:^|\/)(?:\.env(?:\.|$)|storage[-_]?state|auth[-_]?state)/i.test(path) ||
    /\.(?:tgz|tar\.gz|zip|png|jpe?g|webp|gif|har|sqlite(?:3)?|db)(?:$|\.)/i.test(path)
  );
}

function walkFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Evidence may not contain symlinks: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Unsupported evidence filesystem entry: ${path}`);
    }
  };
  visit(root);
  return files.sort();
}

function findEvidenceManifests(inputDirectory) {
  return walkFiles(inputDirectory).filter((path) => basename(path) === 'evidence.json');
}

function parseChecksums(directory) {
  const checksumPath = join(directory, 'SHA256SUMS');
  if (!existsSync(checksumPath)) throw new Error(`Missing evidence checksum file: ${checksumPath}`);
  const text = readFileSync(checksumPath, 'utf8');
  const checksums = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (line === '') continue;
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (!match) throw new Error(`Malformed evidence checksum line in ${checksumPath}.`);
    const [, hash, name] = match;
    validateRelativeArtifactPath(name);
    if (name === 'SHA256SUMS') throw new Error('SHA256SUMS cannot checksum itself.');
    if (checksums.has(name)) throw new Error(`Duplicate evidence checksum entry ${name}.`);
    checksums.set(name, hash);
  }
  if (checksums.size === 0) throw new Error(`Evidence checksum file is empty: ${checksumPath}`);
  return { checksums, checksumPath, text };
}

function validateFragmentDirectory(directory) {
  const { checksums, checksumPath, text: checksumText } = parseChecksums(directory);
  const files = walkFiles(directory)
    .filter((path) => path !== checksumPath)
    .map((path) => relative(directory, path).split('\\').join('/'));
  const expected = [...checksums.keys()].sort();
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error(`Evidence checksum file list does not match ${directory}.`);
  }
  const contents = new Map();
  let totalBytes = 0;
  for (const name of expected) {
    if (forbiddenArtifact(name)) {
      throw new Error(`Forbidden evidence artifact ${JSON.stringify(name)} in ${directory}.`);
    }
    const content = readFileSync(join(directory, ...name.split('/')));
    if (content.byteLength > maxArtifactBytes) {
      throw new Error(`Evidence artifact exceeds the 64 MiB limit: ${name}`);
    }
    totalBytes += content.byteLength;
    if (totalBytes > maxDossierBytes) {
      throw new Error(`Evidence fragment exceeds the 256 MiB dossier limit: ${directory}`);
    }
    const actual = sha256(content);
    if (actual !== checksums.get(name)) {
      throw new Error(`Evidence checksum mismatch for ${name} in ${directory}.`);
    }
    contents.set(name, content);
  }
  const evidenceContent = contents.get('evidence.json');
  if (evidenceContent === undefined) throw new Error(`Missing evidence.json in ${directory}.`);
  let evidence;
  try {
    evidence = JSON.parse(evidenceContent.toString('utf8'));
  } catch (error) {
    throw new Error(
      `Malformed evidence.json in ${directory}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(evidence.artifacts)) {
    throw new Error(`Evidence manifest has no artifact list: ${directory}`);
  }
  const described = new Map();
  for (const artifact of evidence.artifacts) {
    if (artifact === null || typeof artifact !== 'object') {
      throw new Error(`Malformed artifact descriptor in ${directory}.`);
    }
    validateRelativeArtifactPath(artifact.name);
    if (described.has(artifact.name)) {
      throw new Error(`Duplicate manifest artifact ${artifact.name} in ${directory}.`);
    }
    const content = contents.get(artifact.name);
    if (content === undefined) {
      throw new Error(`Manifest artifact ${artifact.name} is missing in ${directory}.`);
    }
    if (
      artifact.bytes !== content.byteLength ||
      artifact.sha256 !== sha256(content) ||
      artifact.sha256 !== checksums.get(artifact.name)
    ) {
      throw new Error(`Manifest artifact checksum mismatch for ${artifact.name}.`);
    }
    described.set(artifact.name, artifact);
  }
  const checksumArtifacts = expected.filter((name) => name !== 'evidence.json');
  if (JSON.stringify([...described.keys()].sort()) !== JSON.stringify(checksumArtifacts)) {
    throw new Error(`Manifest artifact list is incomplete in ${directory}.`);
  }
  return {
    directory,
    evidence,
    contents,
    evidenceSha256: checksums.get('evidence.json'),
    checksumSha256: sha256(checksumText),
    checksumText,
  };
}

function requiredVariant(gate, node) {
  return requirements.find((requirement) => requirement.gate === gate && requirement.node === node);
}

function evidenceRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireBoundSourceMetadata(source, requirement) {
  const fail = (detail) => {
    throw new Error(`Invalid source metadata for ${requirement.key}: ${detail}.`);
  };
  if (!evidenceRecord(source)) fail('source must be an object');
  const hashLength = source.objectFormat === 'sha1' ? 40 : source.objectFormat === 'sha256' ? 64 : 0;
  if (hashLength === 0) fail('object format must be sha1 or sha256');
  const validObjectHash = (value) =>
    typeof value === 'string' && new RegExp(`^[0-9a-f]{${hashLength}}$`).test(value);
  if (!validObjectHash(source.revision)) fail('revision is not a valid object hash');
  if (!validObjectHash(source.tree)) fail('tree is not a valid object hash');
  if (!validObjectHash(source.githubSha)) fail('GitHub SHA is not a valid object hash');
  if (source.githubSha !== source.revision || source.githubShaMatchesHead !== true) {
    fail('GitHub SHA does not match the recorded revision');
  }
  if (source.dirty !== false) fail('worktree is not clean');
  if (typeof source.lockfileSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(source.lockfileSha256)) {
    fail('lockfile SHA-256 is invalid');
  }

  if (!Array.isArray(source.files)) fail('source file inventory is missing');
  if (source.files.length !== releaseEvidenceSourceFilePaths.length) {
    fail('source file inventory is incomplete or unexpected');
  }
  for (const [index, expectedPath] of releaseEvidenceSourceFilePaths.entries()) {
    const file = source.files[index];
    if (!evidenceRecord(file)) fail(`source file descriptor ${index} is malformed`);
    if (file.path !== expectedPath) fail(`source file inventory entry ${index} is unexpected`);
    if (!Number.isInteger(file.bytes) || file.bytes < 0) {
      fail(`source file ${expectedPath} has invalid byte length`);
    }
    if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      fail(`source file ${expectedPath} has invalid SHA-256`);
    }
  }

  if (!evidenceRecord(source.binding)) fail('source binding is missing');
  if (
    source.binding.status !== 'bound' ||
    !Array.isArray(source.binding.reasons) ||
    source.binding.reasons.some((reason) => typeof reason !== 'string')
  ) {
    throw new Error(`Invalid source binding for ${requirement.key}.`);
  }
  const recomputedBinding = classifySourceBinding({
    revision: source.revision,
    tree: source.tree,
    objectFormat: source.objectFormat,
    dirty: source.dirty,
    githubSha: source.githubSha,
  });
  if (
    recomputedBinding.status !== 'bound' ||
    recomputedBinding.reasons.length !== 0 ||
    !isDeepStrictEqual(source.binding, recomputedBinding)
  ) {
    throw new Error(`Invalid source binding for ${requirement.key}.`);
  }
}

function requireStableSourceVerification(evidence, requirement) {
  const verification = evidence.sourceVerification;
  if (
    !evidenceRecord(verification) ||
    verification.status !== 'stable' ||
    !Array.isArray(verification.changedFields) ||
    verification.changedFields.length !== 0 ||
    !evidenceRecord(verification.before) ||
    !evidenceRecord(verification.after) ||
    !isDeepStrictEqual(verification.before, verification.after) ||
    !isDeepStrictEqual(verification.after, evidence.source)
  ) {
    throw new Error(`Release evidence source verification is not stable: ${requirement.key}.`);
  }
  requireBoundSourceMetadata(evidence.source, requirement);
}

function requireWorkspaceTestCountPolicy(result, requirement) {
  const fail = (detail) => {
    throw new Error(
      `Workspace test count policy ${workspaceTestCountPolicy.version} failed for ${requirement.key}: ${detail}.`,
    );
  };
  const totals = result?.totals;
  const packages = result?.packages;
  if (!Array.isArray(packages)) fail('package results are missing');
  if (packages.length !== workspaceTestCountPolicy.packages.length) {
    fail('package result count changed');
  }

  const byName = new Map();
  for (const item of packages) {
    if (item === null || typeof item !== 'object' || typeof item.package !== 'string') {
      fail('a package result is malformed');
    }
    if (byName.has(item.package)) fail(`package ${item.package} is duplicated`);
    byName.set(item.package, item);
  }

  for (const expected of workspaceTestCountPolicy.packages) {
    const item = byName.get(expected.package);
    if (item === undefined) fail(`package ${expected.package} is missing`);
    const junit = item.junit;
    const executed = junit?.tests - junit?.skipped;
    if (
      item.outcome !== 'passed' ||
      junit === null ||
      typeof junit !== 'object' ||
      junit.tests !== expected.declared ||
      executed !== expected.executed ||
      junit.skipped !== expected.skipped ||
      junit.failures !== 0 ||
      junit.errors !== 0
    ) {
      fail(
        `${expected.package} must declare ${expected.declared}, execute ${expected.executed}, skip ${expected.skipped}, and report zero failures/errors`,
      );
    }
  }

  const aggregateExecuted = totals?.tests - totals?.skipped;
  if (
    totals === null ||
    typeof totals !== 'object' ||
    totals.tests !== workspaceTestCountPolicy.aggregate.declared ||
    aggregateExecuted !== workspaceTestCountPolicy.aggregate.executed ||
    totals.skipped !== workspaceTestCountPolicy.aggregate.skipped ||
    totals.failures !== 0 ||
    totals.errors !== 0
  ) {
    fail(
      `aggregate must declare ${workspaceTestCountPolicy.aggregate.declared}, execute ${workspaceTestCountPolicy.aggregate.executed}, skip ${workspaceTestCountPolicy.aggregate.skipped}, and report zero failures/errors`,
    );
  }

  const packageTotals = packages.reduce(
    (summary, item) => {
      summary.declared += item.junit.tests;
      summary.skipped += item.junit.skipped;
      summary.executed += item.junit.tests - item.junit.skipped;
      return summary;
    },
    { declared: 0, executed: 0, skipped: 0 },
  );
  if (
    packageTotals.declared !== totals.tests ||
    packageTotals.executed !== aggregateExecuted ||
    packageTotals.skipped !== totals.skipped
  ) {
    fail('aggregate and per-package counts disagree');
  }
}

function requirePassedGate(fragment, requirement) {
  const evidence = fragment.evidence;
  if (evidence.schemaVersion !== assemblerSchemaVersion) {
    throw new Error(`Unsupported evidence schema for ${requirement.key}.`);
  }
  if (evidence.gate !== requirement.gate || evidence.runtime?.node !== requirement.node) {
    throw new Error(`Evidence variant does not match ${requirement.key}.`);
  }
  if (evidence.outcome !== 'passed' || evidence.result?.outcome !== 'passed') {
    throw new Error(`Release evidence did not pass: ${requirement.key}.`);
  }
  requireStableSourceVerification(evidence, requirement);
  if (evidence.runtime?.ci?.provider !== 'github-actions') {
    throw new Error(`Release evidence is not from GitHub Actions: ${requirement.key}.`);
  }

  if (requirement.gate === 'workspace-verification') {
    requireWorkspaceTestCountPolicy(evidence.result, requirement);
  } else if (requirement.gate === 'capability-qualification') {
    const junit = evidence.result.junit;
    if (
      junit?.tests !== 5 ||
      junit.failures !== 0 ||
      junit.errors !== 0 ||
      junit.skipped !== 0
    ) {
      throw new Error('Capability qualification must pass all five cases without skips.');
    }
  } else if (requirement.gate === 'packed-consumer') {
    if (
      evidence.result.reportOutcome !== 'passed' ||
      evidence.result.archiveCount !== 3 ||
      !Number.isInteger(evidence.result.phaseCount) ||
      evidence.result.phaseCount <= 0
    ) {
      throw new Error(`Packed-consumer evidence is incomplete: ${requirement.key}.`);
    }
  } else if (requirement.gate === 'production-audit') {
    if (
      evidence.result.classification !== 'passed' ||
      evidence.result.normalized?.totalVulnerabilities !== 0 ||
      evidence.result.muted !== 0
    ) {
      throw new Error('Production audit evidence contains vulnerabilities or muted advisories.');
    }
  } else if (
    evidence.result.missingReports?.length !== 0 ||
    evidence.result.reportErrors?.length !== 0
  ) {
    throw new Error(`Generated reports are incomplete: ${requirement.key}.`);
  }
}

function commonValue(fragments, select, label) {
  const values = new Set(fragments.map((fragment) => select(fragment)));
  if (values.size !== 1) throw new Error(`Release evidence has mismatched ${label}.`);
  return [...values][0];
}

function validateReleaseId(releaseId) {
  if (
    typeof releaseId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId)
  ) {
    throw new Error('Release evidence id must use letters, digits, dot, underscore, or hyphen.');
  }
}

function parseJsonObject(content, label) {
  let value;
  try {
    value = JSON.parse(content.toString('utf8'));
  } catch (error) {
    throw new Error(
      `Malformed ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Validate a completed release-evidence dossier without trusting its summary.
 *
 * The top-level checksums establish file integrity. The embedded fragment
 * validators then re-run the release qualification rules and the comparisons
 * below prove that the summary describes those exact fragments.
 */
export function validateReleaseEvidenceDossier(directory) {
  const root = resolve(directory);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new Error(`Release evidence dossier does not exist: ${root}`);
  }

  const { checksums, checksumPath, text: checksumText } = parseChecksums(root);
  if (Buffer.byteLength(checksumText) > maxArtifactBytes) {
    throw new Error('Release evidence dossier checksum file exceeds the 64 MiB limit.');
  }
  const relativeFiles = walkFiles(root)
    .filter((path) => path !== checksumPath)
    .map((path) => relative(root, path).split('\\').join('/'));
  const expectedFiles = [...checksums.keys()].sort();
  if (!sameJson(relativeFiles, expectedFiles)) {
    throw new Error(`Release evidence dossier checksum file list does not match ${root}.`);
  }

  const contents = new Map();
  let dossierBytes = Buffer.byteLength(checksumText);
  for (const name of expectedFiles) {
    if (forbiddenArtifact(name)) {
      throw new Error(`Forbidden evidence artifact ${JSON.stringify(name)} in ${root}.`);
    }
    const content = readFileSync(join(root, ...name.split('/')));
    if (content.byteLength > maxArtifactBytes) {
      throw new Error(`Evidence artifact exceeds the 64 MiB limit: ${name}`);
    }
    dossierBytes += content.byteLength;
    if (dossierBytes > maxDossierBytes) {
      throw new Error('Release evidence dossier exceeds 256 MiB.');
    }
    if (sha256(content) !== checksums.get(name)) {
      throw new Error(`Release evidence dossier checksum mismatch for ${name}.`);
    }
    contents.set(name, content);
  }
  contents.set('SHA256SUMS', Buffer.from(checksumText, 'utf8'));

  const reportContent = contents.get('release-evidence.json');
  if (reportContent === undefined) {
    throw new Error('Release evidence dossier is missing release-evidence.json.');
  }
  const report = parseJsonObject(reportContent, 'release-evidence.json');
  if (report.schemaVersion !== assemblerSchemaVersion || report.outcome !== 'qualified') {
    throw new Error('Release evidence dossier is not a qualified supported schema.');
  }
  validateReleaseId(report.releaseId);
  if (
    typeof report.assembledAtUtc !== 'string' ||
    !Number.isFinite(Date.parse(report.assembledAtUtc))
  ) {
    throw new Error('Release evidence dossier has an invalid assembly timestamp.');
  }
  if (!Array.isArray(report.fragments)) {
    throw new Error('Release evidence dossier has no fragment summaries.');
  }
  if (
    !sameJson(report.qualification, {
      workspaceTestCountPolicyId: workspaceTestCountPolicy.version,
    })
  ) {
    throw new Error('Release evidence dossier has an unexpected workspace test-count policy.');
  }
  const reportedKeys = report.fragments.map((fragment) => fragment?.key);
  const requiredKeys = requirements.map((requirement) => requirement.key);
  if (!sameJson(reportedKeys, requiredKeys)) {
    throw new Error('Release evidence dossier fragment variants are incomplete or unexpected.');
  }

  const fragments = [];
  const allowedFiles = new Set(['release-evidence.json']);
  for (const [index, requirement] of requirements.entries()) {
    const prefix = `fragments/${requirement.key}/`;
    const fragmentFiles = expectedFiles.filter((name) => name.startsWith(prefix));
    if (fragmentFiles.length === 0) {
      throw new Error(`Release evidence dossier is missing ${requirement.key}.`);
    }
    for (const name of fragmentFiles) allowedFiles.add(name);

    const fragment = validateFragmentDirectory(join(root, 'fragments', requirement.key));
    requirePassedGate(fragment, requirement);
    fragments.push(fragment);

    const summary = report.fragments[index];
    if (
      summary === null ||
      typeof summary !== 'object' ||
      summary.key !== requirement.key ||
      summary.gate !== requirement.gate ||
      summary.node !== requirement.node ||
      summary.runId !== fragment.evidence.runId ||
      summary.job !== fragment.evidence.runtime.ci.job ||
      summary.evidenceSha256 !== fragment.evidenceSha256 ||
      summary.checksumSha256 !== fragment.checksumSha256 ||
      summary.artifactCount !== fragment.contents.size - 1
    ) {
      throw new Error(`Release evidence dossier summary does not match ${requirement.key}.`);
    }
  }
  if (!sameJson(expectedFiles, [...allowedFiles].sort())) {
    throw new Error('Release evidence dossier contains files outside required fragments.');
  }

  const revision = commonValue(fragments, (fragment) => fragment.evidence.source.revision, 'commit');
  const tree = commonValue(fragments, (fragment) => fragment.evidence.source.tree, 'tree');
  const lockfileSha256 = commonValue(
    fragments,
    (fragment) => fragment.evidence.source.lockfileSha256,
    'lockfile',
  );
  const sourceFiles = JSON.parse(
    commonValue(
      fragments,
      (fragment) => JSON.stringify(fragment.evidence.source.files),
      'source file hashes',
    ),
  );
  const githubRunId = commonValue(
    fragments,
    (fragment) => fragment.evidence.runtime.ci.runId,
    'GitHub run id',
  );
  const githubRunAttempt = commonValue(
    fragments,
    (fragment) => fragment.evidence.runtime.ci.runAttempt,
    'GitHub run attempt',
  );
  if (
    !sameJson(report.source, { revision, tree, lockfileSha256, files: sourceFiles }) ||
    !sameJson(report.ci, {
      provider: 'github-actions',
      runId: githubRunId,
      runAttempt: githubRunAttempt,
    })
  ) {
    throw new Error('Release evidence dossier summary does not match its source or CI run.');
  }

  return { report, files: contents };
}

export function assembleReleaseEvidence({ inputDirectory, outputDirectory, releaseId }) {
  validateReleaseId(releaseId);
  const input = resolve(inputDirectory);
  if (!existsSync(input) || !lstatSync(input).isDirectory()) {
    throw new Error(`Release evidence input directory does not exist: ${input}`);
  }
  const manifests = findEvidenceManifests(input);
  if (manifests.length === 0) throw new Error('No release evidence fragments were found.');
  const byKey = new Map();
  for (const manifest of manifests) {
    const fragment = validateFragmentDirectory(dirname(manifest));
    const requirement = requiredVariant(fragment.evidence.gate, fragment.evidence.runtime?.node);
    if (requirement === undefined) {
      throw new Error(
        `Unexpected release evidence variant ${fragment.evidence.gate}@${fragment.evidence.runtime?.node}.`,
      );
    }
    if (byKey.has(requirement.key)) {
      throw new Error(`Duplicate release evidence for ${requirement.key}.`);
    }
    requirePassedGate(fragment, requirement);
    byKey.set(requirement.key, fragment);
  }
  const missing = requirements.filter((requirement) => !byKey.has(requirement.key));
  if (missing.length > 0) {
    throw new Error(`Missing release evidence: ${missing.map((item) => item.key).join(', ')}.`);
  }
  const fragments = requirements.map((requirement) => byKey.get(requirement.key));
  const revision = commonValue(fragments, (fragment) => fragment.evidence.source.revision, 'commit');
  const tree = commonValue(fragments, (fragment) => fragment.evidence.source.tree, 'tree');
  const lockfileSha256 = commonValue(
    fragments,
    (fragment) => fragment.evidence.source.lockfileSha256,
    'lockfile',
  );
  const sourceFiles = commonValue(
    fragments,
    (fragment) => JSON.stringify(fragment.evidence.source.files),
    'source file hashes',
  );
  const githubRunId = commonValue(
    fragments,
    (fragment) => fragment.evidence.runtime.ci.runId,
    'GitHub run id',
  );
  const githubRunAttempt = commonValue(
    fragments,
    (fragment) => fragment.evidence.runtime.ci.runAttempt,
    'GitHub run attempt',
  );

  const dossierArtifacts = new Map();
  let dossierBytes = 0;
  const fragmentSummaries = [];
  for (const requirement of requirements) {
    const fragment = byKey.get(requirement.key);
    for (const [name, content] of fragment.contents) {
      dossierBytes += content.byteLength;
      if (dossierBytes > maxDossierBytes) throw new Error('Release evidence dossier exceeds 256 MiB.');
      dossierArtifacts.set(`fragments/${requirement.key}/${name}`, content);
    }
    const checksumContent = Buffer.from(fragment.checksumText, 'utf8');
    dossierBytes += checksumContent.byteLength;
    dossierArtifacts.set(`fragments/${requirement.key}/SHA256SUMS`, checksumContent);
    fragmentSummaries.push({
      key: requirement.key,
      gate: requirement.gate,
      node: requirement.node,
      runId: fragment.evidence.runId,
      job: fragment.evidence.runtime.ci.job,
      evidenceSha256: fragment.evidenceSha256,
      checksumSha256: fragment.checksumSha256,
      artifactCount: fragment.contents.size - 1,
    });
  }
  const report = {
    schemaVersion: assemblerSchemaVersion,
    releaseId,
    outcome: 'qualified',
    assembledAtUtc: new Date().toISOString(),
    qualification: {
      workspaceTestCountPolicyId: workspaceTestCountPolicy.version,
    },
    source: {
      revision,
      tree,
      lockfileSha256,
      files: JSON.parse(sourceFiles),
    },
    ci: {
      provider: 'github-actions',
      runId: githubRunId,
      runAttempt: githubRunAttempt,
    },
    fragments: fragmentSummaries,
  };
  dossierArtifacts.set('release-evidence.json', `${JSON.stringify(report, null, 2)}\n`);
  finalizeEvidenceDirectory({ targetDirectory: outputDirectory, artifacts: dossierArtifacts });
  return report;
}

function parseArguments(arguments_) {
  const values = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const key =
      argument === '--input'
        ? 'inputDirectory'
        : argument === '--output'
          ? 'outputDirectory'
          : argument === '--release-id'
            ? 'releaseId'
            : undefined;
    if (key === undefined) throw new Error(`Unknown assembler argument ${JSON.stringify(argument)}.`);
    if (values[key] !== undefined) throw new Error(`${argument} may be provided only once.`);
    const value = arguments_[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
    values[key] = value;
  }
  for (const [key, option] of [
    ['inputDirectory', '--input'],
    ['outputDirectory', '--output'],
    ['releaseId', '--release-id'],
  ]) {
    if (values[key] === undefined) throw new Error(`${option} is required.`);
  }
  return values;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2).filter((argument) => argument !== '--'));
    const report = assembleReleaseEvidence(options);
    process.stdout.write(
      `Release evidence ${report.releaseId} qualified at ${resolve(options.outputDirectory)}.\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options !== undefined && !existsSync(resolve(options.outputDirectory))) {
      try {
        const failure = {
          schemaVersion: assemblerSchemaVersion,
          releaseId: options.releaseId,
          outcome: 'failed',
          assembledAtUtc: new Date().toISOString(),
          error: message,
        };
        finalizeEvidenceDirectory({
          targetDirectory: options.outputDirectory,
          artifacts: new Map([
            ['assembly-failure.json', `${JSON.stringify(failure, null, 2)}\n`],
          ]),
        });
      } catch (reportError) {
        process.stderr.write(
          `Could not retain assembly failure evidence: ${reportError instanceof Error ? reportError.message : String(reportError)}\n`,
        );
      }
    }
    process.stderr.write(
      `Release evidence assembly failed: ${message}\n`,
    );
    process.exitCode = 1;
  }
}
