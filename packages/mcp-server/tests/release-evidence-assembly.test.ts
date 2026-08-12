import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assembleReleaseEvidence,
  releaseEvidenceRequirements,
  validateReleaseEvidenceDossier,
  type ReleaseEvidenceRequirement,
} from '../../../scripts/assemble-release-evidence.mjs';
import { finalizeEvidenceDirectory } from '../../../scripts/record-release-evidence.mjs';

const temporaryRoots: string[] = [];
const revision = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const lockfileSha256 = 'c'.repeat(64);
const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));

const reviewedWorkspacePackages = [
  ['@browserir/core', 60, 0],
  ['@think-dom/fixture-app', 98, 0],
  ['@browserir/playwright', 107, 0],
  ['@browserir/benchmark', 289, 0],
  ['@browserir/mcp', 195, 19],
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

function cleanSource(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    revision,
    tree,
    objectFormat: 'sha1',
    dirty: false,
    binding: { status: 'bound', reasons: [] },
    githubSha: revision,
    githubShaMatchesHead: true,
    lockfileSha256,
    files: sourceFilePaths.map((path, index) => ({
      path,
      bytes: index + 1,
      sha256: String(index + 1).repeat(64),
    })),
    ...overrides,
  };
}

function stableSourceVerification(source: Record<string, unknown>): Record<string, unknown> {
  const snapshot = () => JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
  return {
    status: 'stable',
    changedFields: [],
    before: snapshot(),
    after: snapshot(),
  };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'browserir-evidence-assembly-test-'));
  temporaryRoots.push(root);
  return root;
}

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function rehashDossierFile(directory: string, name: string): void {
  const checksumPath = join(directory, 'SHA256SUMS');
  const content = readFileSync(join(directory, name));
  const lines = readFileSync(checksumPath, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => (line.endsWith(`  ${name}`) ? `${sha256(content)}  ${name}` : line));
  writeFileSync(checksumPath, `${lines.join('\n')}\n`);
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
      totals: { tests: 749, failures: 0, errors: 0, skipped: 19, timeSeconds: 10 },
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

function createFragment(
  input: string,
  requirement: ReleaseEvidenceRequirement,
  options: {
    suffix?: string;
    source?: Partial<Record<string, unknown>>;
    sourceVerification?: Record<string, unknown> | null;
    schemaVersion?: string;
    extraArtifact?: [string, string];
    result?: Record<string, unknown>;
  } = {},
): string {
  const target = join(input, `${requirement.key}${options.suffix ?? ''}`);
  const logName = 'logs/gate.log';
  const log = `${requirement.key} passed\n`;
  const artifactEntries: Array<[string, string]> = [[logName, log]];
  if (options.extraArtifact !== undefined) artifactEntries.push(options.extraArtifact);
  const descriptors = artifactEntries.map(([name, content]) => ({
    name,
    bytes: Buffer.byteLength(content),
    sha256: sha256(content),
  }));
  const source = cleanSource(options.source);
  const sourceVerification =
    options.sourceVerification === null
      ? undefined
      : (options.sourceVerification ?? stableSourceVerification(source));
  const report = {
    schemaVersion: options.schemaVersion ?? '1.1.0',
    runId: `ci-123-1-${requirement.key}`,
    gate: requirement.gate,
    outcome: 'passed',
    startedAtUtc: '2026-08-10T00:00:00.000Z',
    completedAtUtc: '2026-08-10T00:00:01.000Z',
    durationMs: 1000,
    source,
    ...(sourceVerification === undefined ? {} : { sourceVerification }),
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
    result: options.result ?? gateResult(requirement),
    artifacts: descriptors,
  };
  finalizeEvidenceDirectory({
    targetDirectory: target,
    artifacts: new Map([
      ...artifactEntries,
      ['evidence.json', `${JSON.stringify(report, null, 2)}\n`],
    ]),
  });
  return target;
}

function createCompleteInput(root: string): string {
  const input = join(root, 'input');
  for (const requirement of releaseEvidenceRequirements()) createFragment(input, requirement);
  return input;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('release evidence assembly', () => {
  it('creates one self-contained dossier for every required clean CI variant', () => {
    const root = temporaryRoot();
    const input = createCompleteInput(root);
    const output = join(root, 'dossier');

    const report = assembleReleaseEvidence({
      inputDirectory: input,
      outputDirectory: output,
      releaseId: 'browserir-0.1.0-alpha.1',
    });

    expect(report).toMatchObject({
      schemaVersion: '1.1.0',
      releaseId: 'browserir-0.1.0-alpha.1',
      outcome: 'qualified',
      source: { revision, tree, lockfileSha256 },
      qualification: { workspaceTestCountPolicyId: '2026-08-12-v16' },
    });
    expect((report.fragments as unknown[]).length).toBe(releaseEvidenceRequirements().length);
    expect(JSON.parse(readFileSync(join(output, 'release-evidence.json'), 'utf8'))).toEqual(
      report,
    );
    expect(readFileSync(join(output, 'SHA256SUMS'), 'utf8')).toContain(
      'release-evidence.json',
    );
    expect(validateReleaseEvidenceDossier(output).report).toEqual(report);
  });

  it('fails closed when a required variant is missing or duplicated', () => {
    const root = temporaryRoot();
    const input = join(root, 'input');
    const requirements = releaseEvidenceRequirements();
    for (const requirement of requirements.slice(1)) createFragment(input, requirement);
    expect(() =>
      assembleReleaseEvidence({
        inputDirectory: input,
        outputDirectory: join(root, 'missing'),
        releaseId: 'candidate',
      }),
    ).toThrow(/Missing release evidence/);

    createFragment(input, requirements[0]!);
    createFragment(input, requirements[0]!, { suffix: '-duplicate' });
    expect(() =>
      assembleReleaseEvidence({
        inputDirectory: input,
        outputDirectory: join(root, 'duplicate'),
        releaseId: 'candidate',
      }),
    ).toThrow(/Duplicate release evidence/);
  });

  it('rejects workspace evidence after accidental mass test deletion', () => {
    const root = temporaryRoot();
    const input = join(root, 'input');
    for (const requirement of releaseEvidenceRequirements()) {
      createFragment(
        input,
        requirement,
        requirement.gate === 'workspace-verification'
          ? {
              result: {
                outcome: 'passed',
                packages: reviewedWorkspacePackages.map(([name], index) => ({
                  package: name,
                  outcome: 'passed',
                  junit: {
                    tests: index === reviewedWorkspacePackages.length - 1 ? 20 : 1,
                    failures: 0,
                    errors: 0,
                    skipped: index === reviewedWorkspacePackages.length - 1 ? 19 : 0,
                    timeSeconds: 0.1,
                  },
                })),
                totals: {
                  tests: 24,
                  failures: 0,
                  errors: 0,
                  skipped: 19,
                  timeSeconds: 0.5,
                },
              },
            }
          : {},
      );
    }

    expect(() =>
      assembleReleaseEvidence({
        inputDirectory: input,
        outputDirectory: join(root, 'dossier'),
        releaseId: 'candidate',
      }),
    ).toThrow(/workspace test count policy/i);
  });

  it('rejects missing or internally inconsistent source endpoint verification', () => {
    const baseline = cleanSource();
    const cases: Array<{
      name: string;
      options: Parameters<typeof createFragment>[2];
      error: RegExp;
    }> = [
      {
        name: 'old schema without the mandatory verification contract',
        options: { schemaVersion: '1.0.0' },
        error: /schema/i,
      },
      {
        name: 'missing verification',
        options: { sourceVerification: null },
        error: /source verification/i,
      },
      {
        name: 'changed status',
        options: {
          sourceVerification: {
            ...stableSourceVerification(baseline),
            status: 'changed',
          },
        },
        error: /source verification/i,
      },
      {
        name: 'reported changed field',
        options: {
          sourceVerification: {
            ...stableSourceVerification(baseline),
            changedFields: ['tree'],
          },
        },
        error: /source verification/i,
      },
      {
        name: 'unequal endpoint snapshots',
        options: {
          sourceVerification: {
            status: 'stable',
            changedFields: [],
            before: baseline,
            after: { ...baseline, tree: 'd'.repeat(40) },
          },
        },
        error: /source verification/i,
      },
      {
        name: 'verified snapshot differs from reported source',
        options: {
          sourceVerification: stableSourceVerification({
            ...baseline,
            lockfileSha256: 'd'.repeat(64),
          }),
        },
        error: /source verification/i,
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const root = temporaryRoot();
      const input = join(root, 'input');
      const requirements = releaseEvidenceRequirements();
      for (const requirement of requirements) {
        createFragment(
          input,
          requirement,
          requirement === requirements[0] ? testCase.options : {},
        );
      }
      expect(
        () =>
          assembleReleaseEvidence({
            inputDirectory: input,
            outputDirectory: join(root, `dossier-${index}`),
            releaseId: 'candidate',
          }),
        testCase.name,
      ).toThrow(testCase.error);
    }
  });

  it('rejects malformed or self-asserted clean source metadata', () => {
    const files = cleanSource().files as Array<Record<string, unknown>>;
    const cases: Array<{
      name: string;
      source: Partial<Record<string, unknown>>;
    }> = [
      { name: 'unsupported object format', source: { objectFormat: 'unknown' } },
      {
        name: 'invalid revision and matching self-asserted CI SHA',
        source: { revision: 'abc', githubSha: 'abc' },
      },
      { name: 'invalid tree', source: { tree: 'tree' } },
      { name: 'invalid lockfile digest', source: { lockfileSha256: 'lockfile' } },
      {
        name: 'incomplete source file inventory',
        source: { files: files.slice(1) },
      },
      {
        name: 'malformed source file descriptor',
        source: {
          files: [{ ...files[0], path: '../escape', bytes: -1, sha256: 'invalid' }, ...files.slice(1)],
        },
      },
      {
        name: 'self-asserted binding with reasons',
        source: { binding: { status: 'bound', reasons: ['dirty_worktree'] } },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const root = temporaryRoot();
      const input = join(root, 'input');
      const requirements = releaseEvidenceRequirements();
      for (const requirement of requirements) {
        createFragment(
          input,
          requirement,
          requirement === requirements[0] ? { source: testCase.source } : {},
        );
      }
      expect(
        () =>
          assembleReleaseEvidence({
            inputDirectory: input,
            outputDirectory: join(root, `dossier-${index}`),
            releaseId: 'candidate',
          }),
        testCase.name,
      ).toThrow(/source metadata|source binding/i);
    }
  });

  it('rejects a checksum-tampered fragment', () => {
    const root = temporaryRoot();
    const input = createCompleteInput(root);
    const first = releaseEvidenceRequirements()[0]!;
    writeFileSync(join(input, first.key, 'logs/gate.log'), 'tampered\n');
    expect(() =>
      assembleReleaseEvidence({
        inputDirectory: input,
        outputDirectory: join(root, 'dossier'),
        releaseId: 'candidate',
      }),
    ).toThrow(/checksum/i);
  });

  it('rejects a checksummed dossier whose summary no longer describes its fragments', () => {
    const root = temporaryRoot();
    const output = join(root, 'dossier');
    assembleReleaseEvidence({
      inputDirectory: createCompleteInput(root),
      outputDirectory: output,
      releaseId: 'candidate',
    });
    const reportPath = join(output, 'release-evidence.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      source: { revision: string };
    };
    report.source.revision = 'f'.repeat(40);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    rehashDossierFile(output, 'release-evidence.json');

    expect(() => validateReleaseEvidenceDossier(output)).toThrow(/summary.*source|source.*summary/i);
  });

  it('rejects a checksummed dossier with a different workspace test-count policy id', () => {
    const root = temporaryRoot();
    const output = join(root, 'dossier');
    assembleReleaseEvidence({
      inputDirectory: createCompleteInput(root),
      outputDirectory: output,
      releaseId: 'candidate',
    });
    const reportPath = join(output, 'release-evidence.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      qualification: { workspaceTestCountPolicyId: string };
    };
    report.qualification.workspaceTestCountPolicyId = 'unreviewed-policy';
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    rehashDossierFile(output, 'release-evidence.json');

    expect(() => validateReleaseEvidenceDossier(output)).toThrow(/test-count policy/i);
  });

  it('rejects checksummed files outside the exact dossier structure', () => {
    const root = temporaryRoot();
    const output = join(root, 'dossier');
    assembleReleaseEvidence({
      inputDirectory: createCompleteInput(root),
      outputDirectory: output,
      releaseId: 'candidate',
    });
    writeFileSync(join(output, 'notes.txt'), 'unexpected\n');
    const checksumPath = join(output, 'SHA256SUMS');
    const checksum = readFileSync(checksumPath, 'utf8');
    writeFileSync(checksumPath, `${checksum}${sha256('unexpected\n')}  notes.txt\n`);

    expect(() => validateReleaseEvidenceDossier(output)).toThrow(/outside required fragments/i);
  });

  it('rejects dirty, unbound, or cross-source fragments', () => {
    const root = temporaryRoot();
    const input = join(root, 'input');
    const requirements = releaseEvidenceRequirements();
    for (const requirement of requirements) {
      createFragment(input, requirement, {
        source:
          requirement === requirements[0]
            ? {
                dirty: true,
                binding: { status: 'unbound', reasons: ['dirty_worktree'] },
                lockfileSha256: 'd'.repeat(64),
              }
            : {},
      });
    }
    expect(() =>
      assembleReleaseEvidence({
        inputDirectory: input,
        outputDirectory: join(root, 'dossier'),
        releaseId: 'candidate',
      }),
    ).toThrow(/source metadata|source binding|lockfile/i);
  });

  it('refuses package archives and sensitive browser artifacts in CI evidence', () => {
    const root = temporaryRoot();
    const input = join(root, 'input');
    const requirements = releaseEvidenceRequirements();
    for (const requirement of requirements) {
      createFragment(
        input,
        requirement,
        requirement === requirements[0]
          ? { extraArtifact: ['archives/browserir-core.tgz', 'archive'] }
          : {},
      );
    }
    expect(() =>
      assembleReleaseEvidence({
        inputDirectory: input,
        outputDirectory: join(root, 'dossier'),
        releaseId: 'candidate',
      }),
    ).toThrow(/forbidden evidence artifact/i);
  });

  it('retains a checksummed failure report when CLI assembly cannot qualify', () => {
    const root = temporaryRoot();
    const input = join(root, 'empty-input');
    const output = join(root, 'failed-dossier');
    mkdirSync(input);
    const result = spawnSync(
      process.execPath,
      [
        join(workspaceRoot, 'scripts/assemble-release-evidence.mjs'),
        '--input',
        input,
        '--output',
        output,
        '--release-id',
        'failed-candidate',
      ],
      { cwd: workspaceRoot, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/No release evidence fragments/);
    expect(existsSync(join(output, 'assembly-failure.json'))).toBe(true);
    expect(readFileSync(join(output, 'SHA256SUMS'), 'utf8')).toContain(
      'assembly-failure.json',
    );
  });
});
