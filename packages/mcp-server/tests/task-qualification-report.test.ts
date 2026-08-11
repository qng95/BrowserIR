import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { FixtureTaskQualificationResult } from './task-qualification-harness.js';
import {
  createQualificationEvaluationReport,
  parseQualificationCliOptions,
  renderQualificationMarkdown,
  writeQualificationArtifacts,
} from './task-qualification-report.js';
import {
  collectSourceState,
  createQualificationReproducibilityMetadata,
  hashAdvertisedToolCatalog,
  QUALIFICATION_FIXTURE_PROFILE,
  QUALIFICATION_PLANNER,
  qualificationEnvironmentFailures,
  type QualificationEnvironment,
} from './task-qualification-metadata.js';

const temporaryDirectories: string[] = [];

const result = (taskId: string, outcome: 'passed' | 'failed'): FixtureTaskQualificationResult => ({
  taskId,
  prompt: `Perform ${taskId}`,
  outcome,
  passed: outcome === 'passed',
  reason: outcome === 'passed' ? 'Done.' : 'Not done.',
  plannerError: outcome === 'passed' ? undefined : 'Missing capability.',
  diagnostics: [{
    sequence: 1,
    tool: 'browser_observe',
    revision: 3,
    isError: false,
    durationMs: 12,
    summary: 'Observed.',
  }],
  isolation: {
    processId: 1234,
    origin: 'http://127.0.0.1:12345',
    browserId: `browser-${taskId}`,
    clientName: `client-${taskId}`,
    protocolVersion: '2026-07-28',
    toolCatalogSha256: 'a'.repeat(64),
    toolCatalogToolCount: 9,
  },
  durationMs: 42,
});

const environment = (source: QualificationEnvironment['source'] = {
  revision: '0123456789abcdef',
  dirty: false,
}): QualificationEnvironment => ({
  os: { platform: 'linux', release: '6.0', arch: 'x64' },
  runtime: { node: 'v22.13.0', pnpm: '10.30.3' },
  browser: { playwright: '1.62.0', chromium: '140.0.0.0', headless: true },
  profile: {
    viewport: '1440x900',
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  },
  packages: {
    browserirCore: '0.1.0',
    browserirPlaywright: '0.1.0',
    browserirMcp: '0.1.0',
    playwright: '1.62.0',
    mcpClient: '2.0.0',
    mcpServer: '2.0.0',
  },
  fixture: QUALIFICATION_FIXTURE_PROFILE,
  protocol: { mcp: '2026-07-28' },
  planner: QUALIFICATION_PLANNER,
  toolCatalog: {
    hashAlgorithm: 'sha256',
    status: 'verified',
    sha256: 'a'.repeat(64),
    scope: 'advertised tool name and input schema',
    toolCount: 9,
    observedWorkers: 14,
    totalWorkers: 14,
    unsafeEvaluateEnabled: false,
  },
  source,
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('official MCP qualification report', () => {
  it('uses benchmark report primitives and includes per-task isolation metadata', () => {
    const results = [result('task-b', 'failed'), result('task-a', 'passed')];
    const report = createQualificationEvaluationReport('rc-1', results);
    const markdown = renderQualificationMarkdown(report, results);

    expect(report.tasks.map((task) => task.taskId)).toEqual(['task-a', 'task-b']);
    expect(report.taskSummary).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(report.metadata).toMatchObject({
      qualification: {
        harness: 'official-mcp-client-fixture-tasks',
        taskCount: 2,
        tasks: [
          expect.objectContaining({
            taskId: 'task-b',
            isolation: expect.objectContaining({ protocolVersion: '2026-07-28' }),
          }),
          expect.objectContaining({ taskId: 'task-a' }),
        ],
      },
    });
    expect(markdown).toContain('# BrowserIR official MCP qualification report');
    expect(markdown).toContain('| task-a | passed | Done. | 42 | 1 | 1234 | client-task-a | browser-task-a |');
    expect(markdown).toContain('| task-b | failed | Not done. | 42 | 1 | 1234 | client-task-b | browser-task-b |');
  });

  it('records reproducibility metadata while excluding timestamps and source provenance from the environment fingerprint', () => {
    const first = createQualificationReproducibilityMetadata({
      startedAtUtc: '2026-08-10T10:00:00.000Z',
      completedAtUtc: '2026-08-10T10:02:00.000Z',
      environment: environment(),
    });
    const second = createQualificationReproducibilityMetadata({
      startedAtUtc: '2026-08-11T11:00:00.000Z',
      completedAtUtc: '2026-08-11T11:03:00.000Z',
      environment: environment({ revision: 'fedcba9876543210', dirty: true }),
    });
    const results = [result('task-a', 'passed')];
    const report = createQualificationEvaluationReport('rc-metadata', results, first);
    const markdown = renderQualificationMarkdown(report, results, first);

    expect(first.durationMs).toBe(120_000);
    expect(first.environmentFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.environmentFingerprint).toBe(first.environmentFingerprint);
    expect(report.environmentFingerprint).toBe(first.environmentFingerprint);
    expect(report.metadata).toMatchObject({
      qualification: {
        reproducibility: {
          startedAtUtc: '2026-08-10T10:00:00.000Z',
          completedAtUtc: '2026-08-10T10:02:00.000Z',
          environment: {
            packages: {
              browserirCore: '0.1.0',
              browserirPlaywright: '0.1.0',
              browserirMcp: '0.1.0',
              playwright: '1.62.0',
              mcpClient: '2.0.0',
              mcpServer: '2.0.0',
            },
            fixture: QUALIFICATION_FIXTURE_PROFILE,
            protocol: { mcp: '2026-07-28' },
            planner: QUALIFICATION_PLANNER,
            source: { revision: '0123456789abcdef', dirty: false },
            toolCatalog: { sha256: 'a'.repeat(64), toolCount: 9 },
          },
        },
      },
    });
    expect(markdown).toContain('## Reproducibility');
    expect(markdown).toContain('Advertised tool catalog SHA-256');
    expect(markdown).toContain('seed 20260728, 5000 customers, 12000 vehicles');
  });

  it('hashes only the sorted advertised tool names and canonical input schemas', () => {
    const left = hashAdvertisedToolCatalog([
      {
        name: 'browser_observe',
        inputSchema: { type: 'object', properties: { page_id: { type: 'string' } } },
      },
      {
        name: 'browser_create',
        inputSchema: { required: ['viewport'], type: 'object' },
      },
    ]);
    const reordered = hashAdvertisedToolCatalog([
      {
        name: 'browser_create',
        inputSchema: { type: 'object', required: ['viewport'] },
      },
      {
        name: 'browser_observe',
        inputSchema: { properties: { page_id: { type: 'string' } }, type: 'object' },
      },
    ]);
    const changed = hashAdvertisedToolCatalog([
      {
        name: 'browser_create',
        inputSchema: { type: 'object', required: [] },
      },
      {
        name: 'browser_observe',
        inputSchema: { type: 'object', properties: { page_id: { type: 'string' } } },
      },
    ]);

    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered).toBe(left);
    expect(changed).not.toBe(left);
  });

  it('renders incomplete catalog evidence explicitly and fails the release-integrity gate', () => {
    const complete = environment();
    const partial: QualificationEnvironment = {
      ...complete,
      protocol: { mcp: 'inconsistent:2025-11-25,2026-07-28' },
      toolCatalog: {
        hashAlgorithm: 'sha256',
        status: 'partial',
        scope: 'advertised tool name and input schema',
        toolCount: 9,
        observedWorkers: 13,
        totalWorkers: 14,
        unsafeEvaluateEnabled: false,
      },
    };
    const reproducibility = createQualificationReproducibilityMetadata({
      startedAtUtc: '2026-08-10T10:00:00.000Z',
      completedAtUtc: '2026-08-10T10:01:00.000Z',
      environment: partial,
    });
    const results = [result('task-a', 'passed')];
    const report = createQualificationEvaluationReport('partial', results, reproducibility);
    const markdown = renderQualificationMarkdown(report, results, reproducibility);

    expect(markdown).toContain('SHA-256: `unavailable`');
    expect(markdown).toContain('partial; observed by 13/14 workers');
    expect(qualificationEnvironmentFailures(partial, '2026-07-28')).toEqual([
      'Advertised tool catalog status is partial; expected verified.',
      'Observed MCP protocol inconsistent:2025-11-25,2026-07-28; expected 2026-07-28.',
    ]);
  });

  it('writes JSON and Markdown with create-only cleanup semantics', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'browserir-qualification-'));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, 'qualification-report.md'), 'keep me\n');

    await expect(writeQualificationArtifacts(directory, 'rc-1', [result('task-a', 'passed')]))
      .rejects.toThrow(/already exists|exist/i);
    expect(await readdir(directory)).toEqual(['qualification-report.md']);
    expect(await readFile(join(directory, 'qualification-report.md'), 'utf8')).toBe('keep me\n');

    const clean = join(directory, 'clean');
    const paths = await writeQualificationArtifacts(clean, 'rc-1', [result('task-a', 'passed')]);
    expect(Object.keys(paths).sort()).toEqual(['json', 'markdown']);
    expect((await readdir(clean)).sort()).toEqual([
      'qualification-report.json',
      'qualification-report.md',
    ]);
  });

  it('parses only explicit run and output options', () => {
    expect(parseQualificationCliOptions(['--run-id', 'rc-1', '--output', 'output/q']))
      .toEqual({ runId: 'rc-1', outputDirectory: 'output/q' });
    expect(() => parseQualificationCliOptions(['--unknown'])).toThrow(/Unknown qualification option/);
    expect(() => parseQualificationCliOptions(['--run-id', '../bad'])).toThrow(/may contain only/);
    expect(() => parseQualificationCliOptions(['--run-id', 'one', '--run-id', 'two']))
      .toThrow(/only once/);
    expect(() => parseQualificationCliOptions(['--output', 'one', '--output', 'two']))
      .toThrow(/only once/);
  });

  it('records an explicit dirty unavailable source when the workspace has no Git HEAD', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'browserir-no-head-'));
    temporaryDirectories.push(directory);
    expect(collectSourceState(directory)).toEqual({ revision: 'unavailable', dirty: true });
  });
});
