import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  actionableContextRef,
  finalizeReleaseArtifacts,
  parsePackedConsumerArguments,
  smokePackedConsumer,
  validateArtifactDirectory,
  writePackedConsumerReport,
} from '../../../scripts/smoke-packed-consumer.mjs';
import {
  assembleReleaseEvidence,
  releaseEvidenceRequirements,
  type ReleaseEvidenceRequirement,
} from '../../../scripts/assemble-release-evidence.mjs';
import { finalizeEvidenceDirectory } from '../../../scripts/record-release-evidence.mjs';

const temporaryRoots: string[] = [];
const reviewedWorkspacePackages = [
  ['@browserir/core', 60, 0],
  ['@think-dom/fixture-app', 98, 0],
  ['@browserir/playwright', 107, 0],
  ['@browserir/benchmark', 235, 0],
  ['@browserir/mcp', 189, 19],
] as const;
const sourceFilePaths = [
  'package.json',
  'packages/benchmark/package.json',
  'packages/browser-ir/package.json',
  'packages/fixture-app/package.json',
  'packages/mcp-server/package.json',
  'packages/playwright-driver/package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
] as const;

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'browserir-artifact-test-'));
  temporaryRoots.push(root);
  return root;
}

function git(workspace: string, arguments_: string[]): string {
  return execFileSync('git', arguments_, { cwd: workspace, encoding: 'utf8' }).trim();
}

function initializeCleanWorkspace(root: string): {
  directory: string;
  revision: string;
  tree: string;
  lockfileSha256: string;
} {
  const directory = join(root, 'workspace');
  mkdirSync(directory);
  const lockfile = 'lockfileVersion: 9.0\n';
  writeFileSync(join(directory, 'pnpm-lock.yaml'), lockfile);
  git(directory, ['init', '--quiet']);
  git(directory, ['add', 'pnpm-lock.yaml']);
  git(directory, [
    '-c',
    'user.name=BrowserIR Test',
    '-c',
    'user.email=browserir-test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'test source',
  ]);
  return {
    directory,
    revision: git(directory, ['rev-parse', '--verify', 'HEAD']),
    tree: git(directory, ['rev-parse', '--verify', 'HEAD^{tree}']),
    lockfileSha256: createHash('sha256').update(lockfile).digest('hex'),
  };
}

function gateResult(requirement: ReleaseEvidenceRequirement): Record<string, unknown> {
  if (requirement.gate === 'workspace-verification') {
    return {
      outcome: 'passed',
      packages: reviewedWorkspacePackages.map(([name, tests, skipped]) => ({
        package: name,
        outcome: 'passed',
        junit: { tests, failures: 0, errors: 0, skipped, timeSeconds: 2 },
      })),
      totals: { tests: 689, failures: 0, errors: 0, skipped: 19, timeSeconds: 10 },
    };
  }
  if (requirement.gate === 'capability-qualification') {
    return {
      outcome: 'passed',
      junit: { tests: 5, failures: 0, errors: 0, skipped: 0, timeSeconds: 5 },
    };
  }
  if (requirement.gate === 'packed-consumer') {
    return { outcome: 'passed', reportOutcome: 'passed', phaseCount: 8, archiveCount: 3 };
  }
  if (requirement.gate === 'production-audit') {
    return {
      outcome: 'passed',
      classification: 'passed',
      normalized: { totalVulnerabilities: 0 },
      muted: 0,
    };
  }
  return { outcome: 'passed', missingReports: [], reportErrors: [] };
}

function createQualifiedDossier(
  root: string,
  source: { revision: string; tree: string; lockfileSha256: string },
): string {
  const input = join(root, 'evidence-input');
  for (const requirement of releaseEvidenceRequirements()) {
    const target = join(input, requirement.key);
    const logName = 'logs/gate.log';
    const log = `${requirement.key} passed\n`;
    const evidenceSource = {
      ...source,
      objectFormat: 'sha1',
      dirty: false,
      binding: { status: 'bound', reasons: [] },
      githubSha: source.revision,
      githubShaMatchesHead: true,
      files: sourceFilePaths.map((path, index) => ({
        path,
        bytes: index + 1,
        sha256: String(index + 1).repeat(64),
      })),
    };
    const sourceSnapshot = () =>
      JSON.parse(JSON.stringify(evidenceSource)) as Record<string, unknown>;
    const evidence = {
      schemaVersion: '1.1.0',
      runId: `ci-123-1-${requirement.key}`,
      gate: requirement.gate,
      outcome: 'passed',
      startedAtUtc: '2026-08-10T00:00:00.000Z',
      completedAtUtc: '2026-08-10T00:00:01.000Z',
      durationMs: 1000,
      source: evidenceSource,
      sourceVerification: {
        status: 'stable',
        changedFields: [],
        before: sourceSnapshot(),
        after: sourceSnapshot(),
      },
      runtime: {
        node: requirement.node,
        pnpm: '10.30.3',
        ci: {
          provider: 'github-actions',
          runId: '123',
          runAttempt: '1',
          job: requirement.gate,
        },
      },
      result: gateResult(requirement),
      artifacts: [
        {
          name: logName,
          bytes: Buffer.byteLength(log),
          sha256: createHash('sha256').update(log).digest('hex'),
        },
      ],
    };
    finalizeEvidenceDirectory({
      targetDirectory: target,
      artifacts: new Map([
        [logName, log],
        ['evidence.json', `${JSON.stringify(evidence, null, 2)}\n`],
      ]),
    });
  }
  const dossier = join(root, 'release-evidence');
  assembleReleaseEvidence({
    inputDirectory: input,
    outputDirectory: dossier,
    releaseId: 'browserir-test-candidate',
  });
  return dossier;
}

function createArchives(root: string): Map<string, string> {
  const source = join(root, 'source');
  mkdirSync(source);
  const archiveContents = new Map([
    ['@browserir/core', 'core archive'],
    ['@browserir/playwright', 'playwright archive'],
    ['@browserir/mcp', 'mcp archive'],
  ]);
  const archives = new Map<string, string>();
  for (const [name, content] of archiveContents) {
    const path = join(source, `${name.replace('@browserir/', 'browserir-')}.tgz`);
    writeFileSync(path, content);
    archives.set(name, path);
  }
  return archives;
}

function relativeFiles(directory: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...relativeFiles(join(directory, entry.name), name));
    else if (entry.isFile()) files.push(name);
  }
  return files.sort();
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('release candidate artifact finalization', () => {
  it('continues from a delta receipt using its fresh actionable-context reference', () => {
    expect(
      actionableContextRef(
        {
          actionable_context: {
            page_id: 'page-packed',
            revision: 17,
            targets: [
              {
                entity_id: 'save-customer',
                name: 'Save customer',
                role: 'button',
                actions: ['click'],
              },
            ],
            omitted: 0,
          },
        },
        'Save customer',
        'button',
      ),
    ).toEqual({
      page_id: 'page-packed',
      entity_id: 'save-customer',
      revision: 17,
    });
  });

  it('fails closed when actionable continuation context is malformed or ambiguous', () => {
    expect(() => actionableContextRef({}, 'Save customer', 'button')).toThrow(
      /missing actionable_context/,
    );
    expect(() =>
      actionableContextRef(
        {
          actionable_context: {
            page_id: 'page-packed',
            revision: 17,
            targets: [
              { entity_id: 'save-one', name: 'Save customer', role: 'button' },
              { entity_id: 'save-two', name: 'Save customer', role: 'button' },
            ],
          },
        },
        'Save customer',
        'button',
      ),
    ).toThrow(/expected one actionable button named Save customer/i);
  });

  it('parses independent create-only report and persistent-candidate destinations', () => {
    const candidate = join(temporaryRoot(), 'candidate');
    expect(parsePackedConsumerArguments([])).toEqual({});
    expect(parsePackedConsumerArguments(['--report', 'output/packed.json'])).toEqual({
      reportPath: 'output/packed.json',
    });
    expect(
      parsePackedConsumerArguments([
        '--artifact-directory',
        candidate,
        '--release-evidence',
        'output/release-evidence',
        '--report',
        'output/packed.json',
      ]),
    ).toEqual({
      artifactDirectory: candidate,
      releaseEvidenceDirectory: 'output/release-evidence',
      reportPath: 'output/packed.json',
    });
    expect(() =>
      parsePackedConsumerArguments(['--artifact-directory', candidate]),
    ).toThrow(/--release-evidence/);
    expect(() =>
      parsePackedConsumerArguments(['--release-evidence', 'output/release-evidence']),
    ).toThrow(/--artifact-directory/);
    expect(() => parsePackedConsumerArguments(['--report'])).toThrow(/requires/);
    expect(() =>
      parsePackedConsumerArguments(['--report', 'one.json', '--report', 'two.json']),
    ).toThrow(/once/);
    expect(() => parsePackedConsumerArguments(['--unknown'])).toThrow(/Unknown/);
    expect(() => smokePackedConsumer({ artifactDirectory: candidate })).toThrow(
      /release-evidence dossier/,
    );
    expect(() =>
      smokePackedConsumer({ releaseEvidenceDirectory: 'output/release-evidence' }),
    ).toThrow(/only be used with persistent release artifacts/);
  });

  it('writes a packed-consumer report once without overwriting evidence', () => {
    const root = temporaryRoot();
    const reportPath = join(root, 'reports', 'packed-consumer.json');
    const report = {
      schemaVersion: '1.0.0',
      outcome: 'failed',
      phases: [{ name: 'build', outcome: 'failed' }],
    };
    writePackedConsumerReport(reportPath, report);
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual(report);
    expect(() => writePackedConsumerReport(reportPath, report)).toThrow(/already exists/);
  });

  it('atomically retains archives and the complete dossier under one SHA-256 integrity manifest', () => {
    const root = temporaryRoot();
    const workspace = initializeCleanWorkspace(root);
    const archives = createArchives(root);
    const releaseEvidenceDirectory = createQualifiedDossier(root, workspace);
    const candidate = join(root, 'candidate');

    const records = finalizeReleaseArtifacts({
      artifactDirectory: candidate,
      archives,
      releaseEvidenceDirectory,
      workspaceDirectory: workspace.directory,
    });

    expect(readdirSync(candidate).sort()).toEqual([
      'SHA256SUMS',
      'browserir-core.tgz',
      'browserir-mcp.tgz',
      'browserir-playwright.tgz',
      'release-evidence',
    ]);
    for (const record of records) {
      const retained = readFileSync(join(candidate, record.name));
      expect(record.bytes).toBe(retained.byteLength);
      expect(record.sha256).toBe(createHash('sha256').update(retained).digest('hex'));
    }
    expect(readFileSync(join(candidate, 'release-evidence', 'release-evidence.json'))).toEqual(
      readFileSync(join(releaseEvidenceDirectory, 'release-evidence.json')),
    );
    const sums = readFileSync(join(candidate, 'SHA256SUMS'), 'utf8');
    const entries = sums.trimEnd().split('\n').map((line) => {
      const match = line.match(/^([0-9a-f]{64})  (.+)$/);
      expect(match).not.toBeNull();
      return { sha256: match![1]!, name: match![2]! };
    });
    expect(entries.map((entry) => entry.name).sort()).toEqual(
      [
        ...records.map((record) => record.name),
        ...relativeFiles(releaseEvidenceDirectory).map((name) => `release-evidence/${name}`),
      ].sort(),
    );
    for (const entry of entries) {
      expect(entry.sha256).toBe(
        createHash('sha256').update(readFileSync(join(candidate, ...entry.name.split('/')))).digest(
          'hex',
        ),
      );
    }
  });

  it('rejects mismatched or tampered release evidence without retaining a candidate', () => {
    const root = temporaryRoot();
    const workspace = initializeCleanWorkspace(root);
    const archives = createArchives(root);
    const releaseEvidenceDirectory = createQualifiedDossier(root, {
      ...workspace,
      tree: 'f'.repeat(40),
    });
    const mismatchCandidate = join(root, 'mismatch-candidate');
    expect(() =>
      finalizeReleaseArtifacts({
        artifactDirectory: mismatchCandidate,
        archives,
        releaseEvidenceDirectory,
        workspaceDirectory: workspace.directory,
      }),
    ).toThrow(/tree/i);
    expect(existsSync(mismatchCandidate)).toBe(false);

    const validEvidence = createQualifiedDossier(join(root, 'valid'), workspace);
    writeFileSync(join(validEvidence, 'release-evidence.json'), '{}\n');
    const tamperedCandidate = join(root, 'tampered-candidate');
    expect(() =>
      finalizeReleaseArtifacts({
        artifactDirectory: tamperedCandidate,
        archives,
        releaseEvidenceDirectory: validEvidence,
        workspaceDirectory: workspace.directory,
      }),
    ).toThrow(/checksum/i);
    expect(existsSync(tamperedCandidate)).toBe(false);
  });

  it('leaves no candidate or staging directory when finalization fails', () => {
    const root = temporaryRoot();
    const source = join(root, 'source');
    mkdirSync(source);
    const validArchive = join(source, 'browserir-core.tgz');
    writeFileSync(validArchive, 'core archive');
    const candidate = join(root, 'candidate');

    expect(() =>
      finalizeReleaseArtifacts({
        artifactDirectory: candidate,
        archives: new Map([
          ['@browserir/core', validArchive],
          ['@browserir/mcp', join(source, 'missing.tgz')],
        ]),
        releaseEvidenceDirectory: join(root, 'missing-evidence'),
        workspaceDirectory: root,
      }),
    ).toThrow();

    expect(existsSync(candidate)).toBe(false);
    expect(readdirSync(root).filter((name) => name.startsWith('.browserir-candidate-'))).toEqual(
      [],
    );
  });

  it('requires a new absolute target so evidence is never overwritten', () => {
    const root = temporaryRoot();
    expect(() => validateArtifactDirectory('relative/candidate')).toThrow(/absolute path/);
    const existing = join(root, 'existing');
    mkdirSync(existing);
    expect(() => validateArtifactDirectory(existing)).toThrow(/must not already exist/);
  });
});
