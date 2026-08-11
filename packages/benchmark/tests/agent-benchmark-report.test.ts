import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentBenchmarkReport,
  AgentTrialResult,
} from '../src/agent-benchmark/contracts.js';
import {
  renderAgentBenchmarkAttemptsNdjson,
  renderAgentBenchmarkChecksums,
  renderAgentBenchmarkJson,
  renderAgentBenchmarkMarkdown,
  writeAgentBenchmarkArtifacts,
} from '../src/agent-benchmark/report.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const attempt = (
  taskId: string,
  trialIndex: number,
  outcome: AgentTrialResult['outcome'],
): AgentTrialResult => ({
  attemptId: `run-1:${taskId}:${trialIndex}`,
  taskId,
  trialIndex,
  outcome,
  ...(outcome === 'failed' ? { failureKind: 'oracle_failed' } : {}),
  targetId: 'fixture',
  targetVersion: 'fixture-v1',
  agentStatus: 'completed',
  submissionAttempts: 0,
  modelTurns: 2,
  durationMs: 125,
  tools: {
    calls: 3,
    errors: 0,
    byTool: { browser_observe: 1, browser_act: 2 },
    budgetExceeded: false,
  },
  agent: {
    adapterId: 'test-agent',
    framework: 'langchain',
    frameworkVersion: '1.5.4',
    model: 'fake',
  },
});

const report = (reverse = false): AgentBenchmarkReport => {
  const trials = [attempt('task|b', 0, 'failed'), attempt('task-a', 0, 'passed')];
  const taskSummaries = [
    {
      taskId: 'task|b',
      trials: 1,
      passed: 0,
      failed: 1,
      invalid: 0,
      passRate: {
        successes: 0,
        trials: 1,
        rate: 0,
        lower: 0,
        upper: 0.7934506856227626,
        confidence: 0.95,
        method: 'wilson-score',
      },
    },
    {
      taskId: 'task-a',
      trials: 1,
      passed: 1,
      failed: 0,
      invalid: 0,
      passRate: {
        successes: 1,
        trials: 1,
        rate: 1,
        lower: 0.20654931437723745,
        upper: 1,
        confidence: 0.95,
        method: 'wilson-score',
      },
    },
  ] as const;
  return {
    schemaVersion: '1.0.0',
    runId: 'run-1',
    expectedTargetVersion: 'fixture-v1',
    budgets: { maxDurationMs: 10_000, maxToolCalls: 20, maxModelTurns: 5 },
    summary: {
      tasks: 2,
      trials: 2,
      passed: 1,
      failed: 1,
      invalid: 0,
      macroPassRate: 0.5,
      validTasks: 2,
      invalidRate: 0,
      passRate: {
        successes: 1,
        trials: 2,
        rate: 0.5,
        lower: 0.09453120573423074,
        upper: 0.9054687942657693,
        confidence: 0.95,
        method: 'wilson-score',
      },
    },
    taskSummaries: reverse ? [...taskSummaries].reverse() : [...taskSummaries],
    trials: reverse ? [...trials].reverse() : trials,
  };
};

describe('agent benchmark artifacts', () => {
  it('renders canonical JSON and NDJSON independent of input ordering', () => {
    const json = renderAgentBenchmarkJson(report());
    expect(json).toBe(renderAgentBenchmarkJson(report(true)));
    expect(json.endsWith('\n')).toBe(true);
    expect((JSON.parse(json) as AgentBenchmarkReport).trials.map(({ taskId }) => taskId))
      .toEqual(['task-a', 'task|b']);

    const ndjson = renderAgentBenchmarkAttemptsNdjson(report());
    expect(ndjson).toBe(renderAgentBenchmarkAttemptsNdjson(report(true)));
    expect(ndjson.trimEnd().split('\n').map((line) =>
      (JSON.parse(line) as AgentTrialResult).attemptId,
    )).toEqual(['run-1:task-a:0', 'run-1:task|b:0']);
  });

  it('renders a stable human summary with invalid-trial semantics and escaping', () => {
    const markdown = renderAgentBenchmarkMarkdown(report());

    expect(markdown).toContain('# BrowserIR agent benchmark report');
    expect(markdown).toContain('1 / 2 (50.00%; 95% CI 9.45%–90.55%)');
    expect(markdown).toContain('Invalid attempts are reported separately');
    expect(markdown).toContain('| task\\|b |');
    expect(markdown).toContain('| run-1:task-a:0 | task-a | 0 | passed |');
    expect(markdown.endsWith('\n')).toBe(true);
  });

  it('writes the four create-only artifacts with verifiable SHA-256 sums', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browserir-agent-report-'));
    temporaryDirectories.push(root);
    const output = join(root, 'run-1');

    const paths = await writeAgentBenchmarkArtifacts(output, report());
    expect(Object.keys(paths).sort()).toEqual([
      'attemptsNdjson',
      'checksums',
      'reportJson',
      'summaryMarkdown',
    ]);
    expect((await readdir(output)).sort()).toEqual([
      'SHA256SUMS',
      'attempts.ndjson',
      'report.json',
      'summary.md',
    ]);

    const manifest = await readFile(paths.checksums, 'utf8');
    const entries = manifest.trimEnd().split('\n').map((line) => {
      const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
      const digest = match?.[1];
      const name = match?.[2];
      if (digest === undefined || name === undefined) {
        throw new Error(`Invalid checksum line: ${line}`);
      }
      return { digest, name };
    });
    expect(entries.map(({ name }) => name)).toEqual([
      'attempts.ndjson',
      'report.json',
      'summary.md',
    ]);
    for (const entry of entries) {
      const content = await readFile(join(output, entry.name));
      expect(createHash('sha256').update(content).digest('hex')).toBe(entry.digest);
    }
  });

  it('rolls back newly published files and preserves a colliding artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browserir-agent-report-'));
    temporaryDirectories.push(root);
    const output = join(root, 'run-1');
    await mkdir(output);
    await writeFile(join(output, 'summary.md'), 'keep me\n');

    await expect(writeAgentBenchmarkArtifacts(output, report())).rejects.toThrow(
      /already exists|exist/i,
    );
    expect(await readdir(output)).toEqual(['summary.md']);
    expect(await readFile(join(output, 'summary.md'), 'utf8')).toBe('keep me\n');
  });

  it('uses canonical filename ordering in checksum manifests', () => {
    expect(renderAgentBenchmarkChecksums({ 'z.txt': 'z\n', 'a.txt': 'a\n' }))
      .toMatch(/^[a-f0-9]{64}  a\.txt\n[a-f0-9]{64}  z\.txt\n$/);
  });
});
