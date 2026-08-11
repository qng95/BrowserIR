import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import * as releaseEvidenceRecorder from '../../../scripts/record-release-evidence.mjs';

import {
  classifyPnpmAuditOutcome,
  classifySourceBinding,
  finalizeEvidenceDirectory,
  normalizePnpmAuditReport,
  parseJunitSummary,
  parseReleaseEvidenceArguments,
  reportArtifactsForGate,
  vitestEvidenceArguments,
} from '../../../scripts/record-release-evidence.mjs';

const { verifyStableEvidenceSource } = releaseEvidenceRecorder as unknown as {
  verifyStableEvidenceSource: (input: {
    gateOutcome: 'passed' | 'failed';
    sourceBefore: Record<string, unknown>;
    sourceAfter: Record<string, unknown>;
  }) => unknown;
};

const temporaryRoots: string[] = [];
const invalidArgumentSets: string[][] = [
  [],
  ['unknown', '--output', 'output/evidence'],
  ['packed-consumer', '--output'],
  ['packed-consumer', '--output', 'output/evidence', '--output', 'other'],
  ['production-audit', '--output', 'output/evidence', '--run-id', '../escape'],
  ['capability-qualification', '--output', 'output/evidence', '--unexpected'],
];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'browserir-release-evidence-test-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('release evidence arguments', () => {
  it('accepts one declared gate with create-only output and a stable run id', () => {
    expect(
      parseReleaseEvidenceArguments([
        'workspace-verification',
        '--output',
        'output/ci/verify',
        '--run-id',
        'ci-123-node-24.19.0',
        '--skip-build',
      ]),
    ).toEqual({
      gate: 'workspace-verification',
      outputDirectory: 'output/ci/verify',
      runId: 'ci-123-node-24.19.0',
      skipBuild: true,
    });
  });

  it.each(invalidArgumentSets.map((arguments_) => [arguments_] as const))(
    'rejects ambiguous or unsafe arguments: %j',
    (arguments_) => {
      expect(() => parseReleaseEvidenceArguments(arguments_)).toThrow();
    },
  );

  it.each([
    'task-qualification',
    'representation-qualification',
    'performance-characterization',
  ] as const)('accepts the report-producing %s gate', (gate) => {
    expect(
      parseReleaseEvidenceArguments([
        gate,
        '--output',
        `output/${gate}`,
        '--run-id',
        `ci-123-${gate}`,
      ]).gate,
    ).toBe(gate);
  });

  it('uses exact report allowlists for benchmark and qualification evidence', () => {
    expect(reportArtifactsForGate('task-qualification')).toEqual([
      'qualification-report.json',
      'qualification-report.md',
    ]);
    expect(reportArtifactsForGate('representation-qualification')).toEqual([
      'model-payload.ndjson',
      'representation-report.json',
      'representation-report.junit.xml',
      'representation-report.md',
      'representation-report.ndjson',
    ]);
    expect(reportArtifactsForGate('performance-characterization')).toEqual([
      'environment.json',
      'samples.ndjson',
      'summary.json',
      'summary.md',
    ]);
    expect(() => reportArtifactsForGate('workspace-verification')).toThrow(/report gate/);
  });
});

describe('JUnit evidence parsing', () => {
  it('requests both human output and machine-readable JSON plus JUnit artifacts', () => {
    expect(
      vitestEvidenceArguments({
        targets: ['tests/example.test.ts'],
        jsonPath: '/tmp/example.json',
        junitPath: '/tmp/example.xml',
      }),
    ).toEqual([
      'exec',
      'vitest',
      'run',
      'tests/example.test.ts',
      '--reporter=default',
      '--reporter=json',
      '--reporter=junit',
      '--outputFile.json=/tmp/example.json',
      '--outputFile.junit=/tmp/example.xml',
    ]);
  });

  it('reads aggregate Vitest counts without scraping console output', () => {
    expect(
      parseJunitSummary(
        '<?xml version="1.0"?><testsuites name="vitest tests" tests="45" failures="1" errors="2" skipped="3" time="4.25"></testsuites>',
      ),
    ).toEqual({ tests: 45, failures: 1, errors: 2, skipped: 3, timeSeconds: 4.25 });
  });

  it('sums child-suite skipped counts when Vitest omits the root attribute', () => {
    expect(
      parseJunitSummary(
        '<testsuites tests="5" failures="0" errors="0" time="2.5"><testsuite tests="2" failures="0" errors="0" skipped="1" time="1"/><testsuite tests="3" failures="0" errors="0" skipped="2" time="1.5"/></testsuites>',
      ),
    ).toEqual({ tests: 5, failures: 0, errors: 0, skipped: 3, timeSeconds: 2.5 });
  });

  it('rejects missing, duplicate, negative, or nonnumeric aggregate counts', () => {
    expect(() => parseJunitSummary('<testsuite tests="1" failures="0"/>')).toThrow(
      /testsuites/,
    );
    expect(() =>
      parseJunitSummary(
        '<testsuites tests="1" failures="0" errors="0" skipped="0" time="1"/><testsuites tests="1" failures="0" errors="0" skipped="0" time="1"/>',
      ),
    ).toThrow(/exactly one/);
    expect(() =>
      parseJunitSummary(
        '<testsuites tests="-1" failures="0" errors="0" skipped="0" time="1"/>',
      ),
    ).toThrow(/tests/);
    expect(() =>
      parseJunitSummary(
        '<testsuites tests="one" failures="0" errors="0" skipped="0" time="1"/>',
      ),
    ).toThrow(/tests/);
  });
});

describe('pnpm audit evidence normalization', () => {
  it('retains the complete severity and dependency summary', () => {
    expect(
      normalizePnpmAuditReport({
        actions: [],
        advisories: {},
        muted: [],
        metadata: {
          vulnerabilities: { info: 0, low: 1, moderate: 2, high: 3, critical: 4 },
          dependencies: 12,
          devDependencies: 0,
          optionalDependencies: 0,
          totalDependencies: 12,
        },
      }),
    ).toEqual({
      vulnerabilities: { info: 0, low: 1, moderate: 2, high: 3, critical: 4 },
      totalVulnerabilities: 10,
      dependencies: {
        production: 12,
        development: 0,
        optional: 0,
        total: 12,
      },
    });
  });

  it.each([
    {},
    { metadata: { vulnerabilities: {} } },
    {
      metadata: {
        vulnerabilities: { info: 0, low: -1, moderate: 0, high: 0, critical: 0 },
        dependencies: 1,
        devDependencies: 0,
        optionalDependencies: 0,
        totalDependencies: 1,
      },
    },
  ])('rejects malformed audit output: %j', (report) => {
    expect(() => normalizePnpmAuditReport(report)).toThrow();
  });

  it('distinguishes a clean audit, discovered vulnerabilities, and unavailable audit data', () => {
    const clean = {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
      totalVulnerabilities: 0,
      dependencies: { production: 12, development: 0, optional: 0, total: 12 },
    };
    expect(classifyPnpmAuditOutcome({ exitCode: 0, normalized: clean, muted: 0 })).toBe(
      'passed',
    );
    expect(
      classifyPnpmAuditOutcome({
        exitCode: 1,
        normalized: { ...clean, totalVulnerabilities: 1 },
        muted: 0,
      }),
    ).toBe('vulnerabilities_found');
    expect(classifyPnpmAuditOutcome({ exitCode: 0, normalized: clean, muted: 1 })).toBe(
      'vulnerabilities_found',
    );
    expect(classifyPnpmAuditOutcome({ exitCode: 1, normalized: clean, muted: 0 })).toBe(
      'audit_unavailable',
    );
    expect(classifyPnpmAuditOutcome({ exitCode: null })).toBe(
      'audit_unavailable',
    );
  });
});

describe('release evidence finalization', () => {
  it('atomically retains exact artifacts and a SHA-256 manifest without overwriting', () => {
    const root = temporaryRoot();
    const target = join(root, 'evidence');
    const records = finalizeEvidenceDirectory({
      targetDirectory: target,
      artifacts: new Map([
        ['workspace.json', '{"outcome":"passed"}\n'],
        ['logs/browser-ir.stdout.log', '45 tests passed\n'],
      ]),
    });

    expect(readdirSync(target).sort()).toEqual(['SHA256SUMS', 'logs', 'workspace.json']);
    expect(readFileSync(join(target, 'workspace.json'), 'utf8')).toBe(
      '{"outcome":"passed"}\n',
    );
    for (const record of records) {
      const retained = readFileSync(join(target, record.name));
      expect(record.bytes).toBe(retained.byteLength);
      expect(record.sha256).toBe(createHash('sha256').update(retained).digest('hex'));
    }
    expect(readFileSync(join(target, 'SHA256SUMS'), 'utf8')).toBe(
      `${records.map((record) => `${record.sha256}  ${record.name}`).join('\n')}\n`,
    );
    expect(() =>
      finalizeEvidenceDirectory({
        targetDirectory: target,
        artifacts: new Map([['second.json', '{}\n']]),
      }),
    ).toThrow(/already exists/);
  });

  it('rejects paths that could escape the evidence directory and leaves no target', () => {
    const root = temporaryRoot();
    const target = join(root, 'evidence');
    expect(() =>
      finalizeEvidenceDirectory({
        targetDirectory: target,
        artifacts: new Map([['../escape.json', '{}\n']]),
      }),
    ).toThrow(/artifact path/);
    expect(existsSync(target)).toBe(false);

    const occupied = join(root, 'occupied');
    mkdirSync(occupied);
    expect(() =>
      finalizeEvidenceDirectory({
        targetDirectory: occupied,
        artifacts: new Map([['report.json', '{}\n']]),
      }),
    ).toThrow(/already exists/);
  });
});

describe('release source binding', () => {
  it('binds evidence only to a clean concrete commit and matching CI SHA', () => {
    const revision = 'a'.repeat(40);
    expect(
      classifySourceBinding({
        revision,
        tree: 'b'.repeat(40),
        objectFormat: 'sha1',
        dirty: false,
        githubSha: revision,
      }),
    ).toEqual({ status: 'bound', reasons: [] });
  });

  it('reports every reason dirty or ambiguous evidence cannot qualify a release', () => {
    expect(
      classifySourceBinding({
        revision: 'unavailable',
        tree: 'unavailable',
        objectFormat: 'unknown',
        dirty: true,
        githubSha: 'c'.repeat(40),
      }),
    ).toEqual({
      status: 'unbound',
      reasons: [
        'revision_unavailable',
        'tree_unavailable',
        'unsupported_object_format',
        'dirty_worktree',
        'github_sha_mismatch',
      ],
    });
  });

  it('fails closed and removes source binding when source changes during a passing gate', () => {
    const revision = 'a'.repeat(40);
    const tree = 'b'.repeat(40);
    const sourceBefore = {
      revision,
      tree,
      objectFormat: 'sha1',
      dirty: false,
      binding: { status: 'bound', reasons: [] },
      lockfileSha256: 'c'.repeat(64),
      files: [{ path: 'package.json', bytes: 10, sha256: 'd'.repeat(64) }],
    };
    const sourceAfter = {
      ...sourceBefore,
      tree: 'e'.repeat(40),
      binding: { status: 'bound', reasons: [] },
    };

    expect(
      verifyStableEvidenceSource({
        gateOutcome: 'passed',
        sourceBefore,
        sourceAfter,
      }),
    ).toEqual({
      outcome: 'failed',
      source: {
        ...sourceAfter,
        binding: { status: 'unbound', reasons: ['source_changed_during_gate'] },
      },
      verification: {
        status: 'changed',
        changedFields: ['tree'],
        before: sourceBefore,
        after: sourceAfter,
      },
    });
  });

  it.each([
    ['revision', { revision: 'f'.repeat(40) }],
    ['tree', { tree: 'f'.repeat(40) }],
    ['dirty', { dirty: true }],
    ['binding', { binding: { status: 'unbound', reasons: ['dirty_worktree'] } }],
    ['lockfileSha256', { lockfileSha256: 'f'.repeat(64) }],
    [
      'files',
      { files: [{ path: 'package.json', bytes: 11, sha256: 'f'.repeat(64) }] },
    ],
  ] as const)('requires exact %s equality across the gate', (field, change) => {
    const sourceBefore = {
      revision: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      objectFormat: 'sha1',
      dirty: false,
      binding: { status: 'bound', reasons: [] },
      lockfileSha256: 'c'.repeat(64),
      files: [{ path: 'package.json', bytes: 10, sha256: 'd'.repeat(64) }],
    };
    const result = verifyStableEvidenceSource({
      gateOutcome: 'passed',
      sourceBefore,
      sourceAfter: { ...sourceBefore, ...change },
    }) as {
      outcome: string;
      source: { binding: { status: string; reasons: string[] } };
      verification: { status: string; changedFields: string[] };
    };

    expect(result.outcome).toBe('failed');
    expect(result.source.binding.status).toBe('unbound');
    expect(result.source.binding.reasons).toContain('source_changed_during_gate');
    expect(result.verification).toMatchObject({ status: 'changed', changedFields: [field] });
  });
});
