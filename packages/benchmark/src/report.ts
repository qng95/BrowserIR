import { stableJson } from './environment.js';
import {
  aggregateTaskOutcomes,
  type IdentityStabilityMetrics,
  type OmissionAccountingMetrics,
  type PayloadMeasurement,
  type RepresentationQualityMetrics,
  type TaskOutcomeRecord,
  type TaskOutcomeSummary,
} from './metrics.js';
import { BENCHMARK_SCHEMA_VERSION } from './schema.js';

export interface EvaluationRepresentationMetrics
  extends RepresentationQualityMetrics {
  identityStability?: IdentityStabilityMetrics;
  omissionAccounting?: OmissionAccountingMetrics;
}

export interface EvaluationReportInput {
  runId: string;
  environmentFingerprint?: string;
  metadata?: Readonly<Record<string, unknown>>;
  tasks: readonly TaskOutcomeRecord[];
  representation?: EvaluationRepresentationMetrics;
  payload?: PayloadMeasurement;
}

export interface EvaluationReport {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  runId: string;
  environmentFingerprint?: string;
  metadata?: Readonly<Record<string, unknown>>;
  tasks: TaskOutcomeRecord[];
  taskSummary: TaskOutcomeSummary;
  representation?: EvaluationRepresentationMetrics;
  payload?: PayloadMeasurement;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export function createEvaluationReport(
  input: EvaluationReportInput,
): EvaluationReport {
  const taskIds = new Set<string>();
  const tasks = input.tasks.map((task): TaskOutcomeRecord => {
    if (taskIds.has(task.taskId)) {
      throw new Error(`Duplicate task ID: ${task.taskId}.`);
    }
    taskIds.add(task.taskId);
    return {
      taskId: task.taskId,
      outcome: task.outcome,
      ...(task.reason === undefined ? {} : { reason: task.reason }),
    };
  });
  tasks.sort((left, right) => compareText(left.taskId, right.taskId));
  const taskSummary = aggregateTaskOutcomes(tasks);
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    runId: input.runId,
    ...(input.environmentFingerprint === undefined
      ? {}
      : { environmentFingerprint: input.environmentFingerprint }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    tasks,
    taskSummary,
    ...(input.representation === undefined
      ? {}
      : { representation: input.representation }),
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  };
}

/** Canonical key ordering, two-space indentation, and exactly one trailing newline. */
export function renderEvaluationJson(report: EvaluationReport): string {
  const canonical = JSON.parse(stableJson(report)) as unknown;
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

/**
 * NDJSON layout: one run header, sorted task records, then one aggregate summary.
 * Object keys are canonicalized; array order remains semantically significant.
 */
export function renderEvaluationNdjson(report: EvaluationReport): string {
  const records: unknown[] = [
    {
      kind: 'run',
      schemaVersion: report.schemaVersion,
      runId: report.runId,
      ...(report.environmentFingerprint === undefined
        ? {}
        : { environmentFingerprint: report.environmentFingerprint }),
      ...(report.metadata === undefined ? {} : { metadata: report.metadata }),
    },
    ...report.tasks.map((task) => ({ kind: 'task', ...task })),
    {
      kind: 'summary',
      taskSummary: report.taskSummary,
      ...(report.representation === undefined
        ? {}
        : { representation: report.representation }),
      ...(report.payload === undefined ? {} : { payload: report.payload }),
    },
  ];
  return `${records.map((record) => stableJson(record)).join('\n')}\n`;
}

const percentage = (value: number): string => `${(value * 100).toFixed(2)}%`;

const markdownText = (value: string): string =>
  value.replaceAll('|', '\\|').replaceAll('\n', ' ');

export function renderEvaluationMarkdown(report: EvaluationReport): string {
  const summary = report.taskSummary;
  const passRate =
    summary.passRate === null
      ? 'n/a (no applicable tasks)'
      : `${summary.passed} / ${summary.applicable} (${percentage(summary.passRate)})`;
  const lines = [
    '# BrowserIR benchmark report',
    '',
    `- Run: ${markdownText(report.runId)}`,
    ...(report.environmentFingerprint === undefined
      ? []
      : [`- Environment: ${markdownText(report.environmentFingerprint)}`]),
    '',
    '## Task outcomes',
    '',
    '| Result | Count |',
    '| --- | ---: |',
    `| Passed | ${summary.passed} |`,
    `| Failed | ${summary.failed} |`,
    `| Not applicable | ${summary.notApplicable} |`,
    `| Applicable pass rate | ${passRate} |`,
  ];

  if (report.representation !== undefined) {
    const quality = report.representation;
    lines.push(
      '',
      '## Representation quality',
      '',
      '| Fact class | Precision | Recall | F1 | TP | FP | FN |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...([
        ['Entities', quality.entities],
        ['Capabilities', quality.capabilities],
        ['Relations', quality.relations],
      ] as const).map(
        ([label, metric]) =>
          `| ${label} | ${percentage(metric.precision)} | ${percentage(metric.recall)} | ${percentage(metric.f1)} | ${metric.truePositive} | ${metric.falsePositive} | ${metric.falseNegative} |`,
      ),
      `| Correct abstention | ${percentage(quality.correctAbstention.precision)} | ${percentage(quality.correctAbstention.recall)} | ${percentage(quality.correctAbstention.f1)} | ${quality.correctAbstention.correct} | ${quality.correctAbstention.unexpected} | ${quality.correctAbstention.missed} |`,
    );

    if (quality.identityStability !== undefined) {
      lines.push(
        '',
        `- Identity stability: ${quality.identityStability.stable} / ${quality.identityStability.baseline} (${percentage(quality.identityStability.rate)})`,
      );
    }
    if (quality.omissionAccounting !== undefined) {
      lines.push(
        `- Omission accounting: ${quality.omissionAccounting.accounted} / ${quality.omissionAccounting.known} known omissions (${percentage(quality.omissionAccounting.recall)}), ${quality.omissionAccounting.overreported} over-reported`,
      );
    }
  }

  if (report.payload !== undefined) {
    lines.push(
      '',
      '## Payload',
      '',
      '| Measure | Value |',
      '| --- | ---: |',
      `| Unicode characters | ${report.payload.characters} |`,
      `| UTF-8 bytes | ${report.payload.utf8Bytes} |`,
      `| Token estimate | ${report.payload.estimatedTokens} |`,
      '',
      `Token estimate method: \`${report.payload.tokenEstimateMethod}\`; this is an approximation, not a model-tokenizer count.`,
    );
  }

  return `${lines.join('\n')}\n`;
}

const xmlText = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

export function renderEvaluationJUnit(report: EvaluationReport): string {
  const summary = report.taskSummary;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${summary.total}" failures="${summary.failed}" skipped="${summary.notApplicable}">`,
    `  <testsuite name="BrowserIR benchmark" tests="${summary.total}" failures="${summary.failed}" skipped="${summary.notApplicable}">`,
  ];
  for (const task of report.tasks) {
    const name = xmlText(task.taskId);
    if (task.outcome === 'passed') {
      lines.push(`    <testcase classname="BrowserIR" name="${name}"/>`);
    } else if (task.outcome === 'failed') {
      const reason = xmlText(task.reason ?? 'Task failed.');
      lines.push(
        `    <testcase classname="BrowserIR" name="${name}">`,
        `      <failure message="${reason}">${reason}</failure>`,
        '    </testcase>',
      );
    } else {
      const reason = xmlText(task.reason ?? 'Not applicable.');
      lines.push(
        `    <testcase classname="BrowserIR" name="${name}">`,
        `      <skipped message="${reason}"/>`,
        '    </testcase>',
      );
    }
  }
  lines.push('  </testsuite>', '</testsuites>');
  return `${lines.join('\n')}\n`;
}
