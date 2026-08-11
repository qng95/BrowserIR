import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { stableJson } from '../environment.js';
import type {
  AgentBenchmarkReport,
  AgentBenchmarkTaskSummary,
  AgentTrialResult,
  BinomialInterval,
} from './contracts.js';

export interface AgentBenchmarkArtifactPaths {
  reportJson: string;
  attemptsNdjson: string;
  summaryMarkdown: string;
  checksums: string;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareAttempts = (left: AgentTrialResult, right: AgentTrialResult): number =>
  compareText(left.taskId, right.taskId) ||
  left.trialIndex - right.trialIndex ||
  compareText(left.attemptId, right.attemptId);

function orderedReport(report: AgentBenchmarkReport): AgentBenchmarkReport {
  return {
    ...report,
    taskSummaries: [...report.taskSummaries].sort((left, right) =>
      compareText(left.taskId, right.taskId),
    ),
    trials: [...report.trials].sort(compareAttempts),
  };
}

/** Canonical keys, deterministic attempt ordering, two-space indentation, and one newline. */
export function renderAgentBenchmarkJson(report: AgentBenchmarkReport): string {
  const canonical = JSON.parse(stableJson(orderedReport(report))) as unknown;
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

/** One canonical attempt per line, ordered by task, trial index, and attempt ID. */
export function renderAgentBenchmarkAttemptsNdjson(
  report: AgentBenchmarkReport,
): string {
  const attempts = [...report.trials].sort(compareAttempts);
  return attempts.length === 0
    ? ''
    : `${attempts.map((attempt) => stableJson(attempt)).join('\n')}\n`;
}

const markdownText = (value: string): string =>
  value.replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ');

const percentage = (value: number): string => `${(value * 100).toFixed(2)}%`;

const renderInterval = (interval: BinomialInterval): string =>
  interval.trials === 0
    ? 'n/a (no valid trials)'
    : `${interval.successes} / ${interval.trials} (${percentage(interval.rate)}; 95% CI ${percentage(interval.lower)}–${percentage(interval.upper)})`;

const taskRow = (summary: AgentBenchmarkTaskSummary): string =>
  `| ${markdownText(summary.taskId)} | ${summary.trials} | ${summary.passed} | ${summary.failed} | ${summary.invalid} | ${renderInterval(summary.passRate)} |`;

export function renderAgentBenchmarkMarkdown(report: AgentBenchmarkReport): string {
  const ordered = orderedReport(report);
  const lines = [
    '# BrowserIR agent benchmark report',
    '',
    `- Run: ${markdownText(ordered.runId)}`,
    `- Schema: ${markdownText(ordered.schemaVersion)}`,
    `- Expected target version: ${markdownText(ordered.expectedTargetVersion)}`,
    `- Budgets: ${ordered.budgets.maxDurationMs} ms, ${ordered.budgets.maxToolCalls} tool calls, ${ordered.budgets.maxModelTurns} model turns per attempt`,
    '',
    '## Overall result',
    '',
    '| Tasks | Attempts | Passed | Failed | Invalid | Pass rate |',
    '| ---: | ---: | ---: | ---: | ---: | --- |',
    `| ${ordered.summary.tasks} | ${ordered.summary.trials} | ${ordered.summary.passed} | ${ordered.summary.failed} | ${ordered.summary.invalid} | ${renderInterval(ordered.summary.passRate)} |`,
    '',
    `Equal-weight macro task pass rate: ${ordered.summary.macroPassRate === null ? 'n/a (no valid tasks)' : percentage(ordered.summary.macroPassRate)} across ${ordered.summary.validTasks} task(s) with valid attempts. Invalid-attempt rate: ${percentage(ordered.summary.invalidRate)}.`,
    '',
    'Invalid attempts are reported separately and excluded from the pass-rate denominator.',
    '',
    '## Task results',
    '',
    '| Task | Attempts | Passed | Failed | Invalid | Pass rate |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    ...ordered.taskSummaries.map(taskRow),
    '',
    '## Attempts',
    '',
    '| Attempt | Task | Trial | Outcome | Failure kind | Duration (ms) | Tool calls | Model turns |',
    '| --- | --- | ---: | --- | --- | ---: | ---: | ---: |',
    ...ordered.trials.map(
      (trial) =>
        `| ${markdownText(trial.attemptId)} | ${markdownText(trial.taskId)} | ${trial.trialIndex} | ${trial.outcome} | ${markdownText(trial.failureKind ?? '')} | ${trial.durationMs} | ${trial.tools.calls} | ${trial.modelTurns} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

const sha256 = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

export function renderAgentBenchmarkChecksums(
  artifacts: Readonly<Record<string, string>>,
): string {
  return `${Object.entries(artifacts)
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, content]) => `${sha256(content)}  ${name}`)
    .join('\n')}\n`;
}

/**
 * Stages complete files before exposing them. Hard links provide atomic,
 * create-only publication; a failed publication removes every file it created.
 */
export async function writeAgentBenchmarkArtifacts(
  outputDirectory: string,
  report: AgentBenchmarkReport,
): Promise<AgentBenchmarkArtifactPaths> {
  const reportJson = renderAgentBenchmarkJson(report);
  const attemptsNdjson = renderAgentBenchmarkAttemptsNdjson(report);
  const summaryMarkdown = renderAgentBenchmarkMarkdown(report);
  const dataArtifacts = {
    'attempts.ndjson': attemptsNdjson,
    'report.json': reportJson,
    'summary.md': summaryMarkdown,
  } as const;
  const allArtifacts = {
    ...dataArtifacts,
    SHA256SUMS: renderAgentBenchmarkChecksums(dataArtifacts),
  } as const;

  let createdDirectory = false;
  let stagingDirectory: string | undefined;
  const created: string[] = [];
  const paths: AgentBenchmarkArtifactPaths = {
    reportJson: join(outputDirectory, 'report.json'),
    attemptsNdjson: join(outputDirectory, 'attempts.ndjson'),
    summaryMarkdown: join(outputDirectory, 'summary.md'),
    checksums: join(outputDirectory, 'SHA256SUMS'),
  };

  try {
    createdDirectory = (await mkdir(outputDirectory, { recursive: true })) !== undefined;
    stagingDirectory = await mkdtemp(join(outputDirectory, '.agent-benchmark-'));
    for (const [name, content] of Object.entries(allArtifacts)) {
      await writeFile(join(stagingDirectory, name), content, {
        encoding: 'utf8',
        flag: 'wx',
      });
    }
    for (const name of Object.keys(allArtifacts)) {
      const destination = join(outputDirectory, name);
      await link(join(stagingDirectory, name), destination);
      created.push(destination);
    }
    await rm(stagingDirectory, { recursive: true, force: true });
    stagingDirectory = undefined;
    return paths;
  } catch (error) {
    await Promise.all(created.map((path) => rm(path, { force: true }).catch(() => {})));
    if (stagingDirectory !== undefined) {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    }
    if (createdDirectory) await rmdir(outputDirectory).catch(() => {});
    throw error;
  }
}
