import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  createEvaluationReport,
  renderEvaluationJson,
  renderEvaluationMarkdown,
  type EvaluationReport,
} from '../../benchmark/src/report.js';

import type { FixtureTaskQualificationResult } from './task-qualification-harness.js';
import type { QualificationReproducibilityMetadata } from './task-qualification-metadata.js';

export interface QualificationArtifactPaths {
  json: string;
  markdown: string;
}

export interface QualificationCliOptions {
  runId?: string | undefined;
  outputDirectory?: string | undefined;
}

const markdownText = (value: string): string =>
  value.replaceAll('|', '\\|').replaceAll('\n', ' ');

export function parseQualificationCliOptions(args: readonly string[]): QualificationCliOptions {
  const options: QualificationCliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== '--run-id' && argument !== '--output') {
      throw new Error(`Unknown qualification option: ${argument ?? ''}.`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${argument} requires a value.`);
    }
    index += 1;
    if (argument === '--run-id') {
      if (options.runId !== undefined) throw new Error('--run-id may be specified only once.');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
        throw new Error('--run-id may contain only letters, digits, dot, underscore, and hyphen.');
      }
      options.runId = value;
    } else {
      if (options.outputDirectory !== undefined) throw new Error('--output may be specified only once.');
      options.outputDirectory = value;
    }
  }
  return options;
}

export function resolveQualificationOutputDirectory(
  workspaceRoot: string,
  outputDirectory: string | undefined,
  runId: string,
): string {
  return outputDirectory === undefined
    ? join(workspaceRoot, 'output', 'qualification', runId)
    : resolve(workspaceRoot, outputDirectory);
}

export function createQualificationEvaluationReport(
  runId: string,
  results: readonly FixtureTaskQualificationResult[],
  reproducibility?: QualificationReproducibilityMetadata,
): EvaluationReport {
  return createEvaluationReport({
    runId,
    ...(reproducibility === undefined
      ? {}
      : { environmentFingerprint: reproducibility.environmentFingerprint }),
    tasks: results.map((result) => ({
      taskId: result.taskId,
      outcome: result.outcome,
      reason: result.reason,
    })),
    metadata: {
      qualification: {
        harness: 'official-mcp-client-fixture-tasks',
        taskCount: results.length,
        ...(reproducibility === undefined ? {} : { reproducibility }),
        tasks: results.map((result) => ({
          taskId: result.taskId,
          prompt: result.prompt,
          outcome: result.outcome,
          reason: result.reason,
          plannerError: result.plannerError,
          evidence: result.evidence,
          durationMs: result.durationMs,
          toolCalls: result.diagnostics.length,
          isolation: result.isolation,
          diagnostics: result.diagnostics,
        })),
      },
    },
  });
}

export function renderQualificationMarkdown(
  report: EvaluationReport,
  results: readonly FixtureTaskQualificationResult[],
  reproducibility?: QualificationReproducibilityMetadata,
): string {
  const base = renderEvaluationMarkdown(report)
    .replace('# BrowserIR benchmark report', '# BrowserIR official MCP qualification report')
    .trimEnd();
  const rows = results.map((result) =>
    `| ${markdownText(result.taskId)} | ${result.outcome} | ${markdownText(result.reason)} | ${result.durationMs} | ${result.diagnostics.length} | ${result.isolation.processId} | ${markdownText(result.isolation.clientName)} | ${markdownText(result.isolation.browserId ?? 'unavailable')} | ${markdownText(result.isolation.origin)} | ${markdownText(result.isolation.protocolVersion)} |`,
  );
  const reproducibilitySection = reproducibility === undefined
    ? ''
    : [
        '',
        '',
        '## Reproducibility',
        '',
        `- Started (UTC): ${markdownText(reproducibility.startedAtUtc)}`,
        `- Completed (UTC): ${markdownText(reproducibility.completedAtUtc)}`,
        `- Duration: ${reproducibility.durationMs} ms`,
        `- Environment fingerprint: \`${reproducibility.environmentFingerprint}\``,
        `- Source: \`${markdownText(reproducibility.environment.source.revision)}\` (${reproducibility.environment.source.dirty ? 'dirty' : 'clean'})`,
        `- Runtime: Node ${markdownText(reproducibility.environment.runtime.node)}, pnpm ${markdownText(String(reproducibility.environment.runtime.pnpm))}`,
        `- Browser: Playwright ${markdownText(reproducibility.environment.packages.playwright)}, Chromium ${markdownText(reproducibility.environment.browser.chromium)}, ${reproducibility.environment.browser.headless ? 'headless' : 'headful'}`,
        `- Profile: ${markdownText(String(reproducibility.environment.profile.viewport))} @ ${String(reproducibility.environment.profile.deviceScaleFactor)}x, locale ${markdownText(String(reproducibility.environment.profile.locale))}, timezone ${markdownText(String(reproducibility.environment.profile.timezoneId))}, reduced motion ${markdownText(String(reproducibility.environment.profile.reducedMotion))}`,
        `- Fixture: seed ${reproducibility.environment.fixture.seed}, ${reproducibility.environment.fixture.customers} customers, ${reproducibility.environment.fixture.vehicles} vehicles, API/page latency ${reproducibility.environment.fixture.apiLatencyMs}/${reproducibility.environment.fixture.pageLatencyMs} ms`,
        `- Planner: ${markdownText(reproducibility.environment.planner.id)}`,
        `- MCP protocol: ${markdownText(reproducibility.environment.protocol.mcp)}`,
        `- Advertised tool catalog SHA-256: \`${reproducibility.environment.toolCatalog.sha256 ?? 'unavailable'}\` (${reproducibility.environment.toolCatalog.toolCount ?? 'unknown'} tools; ${reproducibility.environment.toolCatalog.status}; observed by ${reproducibility.environment.toolCatalog.observedWorkers}/${reproducibility.environment.toolCatalog.totalWorkers} workers; name + input schema)`,
        '',
      ].join('\n');
  return `${base}${reproducibilitySection}\n\n## Per-task qualification and isolation\n\n| Task | Outcome | Oracle reason | Duration (ms) | Tool calls | Process | MCP client | Browser | Origin | Protocol |\n| --- | --- | --- | ---: | ---: | ---: | --- | --- | --- | --- |\n${rows.join('\n')}\n`;
}

export async function writeQualificationArtifacts(
  outputDirectory: string,
  runId: string,
  results: readonly FixtureTaskQualificationResult[],
  reproducibility?: QualificationReproducibilityMetadata,
): Promise<QualificationArtifactPaths> {
  await mkdir(outputDirectory, { recursive: true });
  const report = createQualificationEvaluationReport(runId, results, reproducibility);
  const paths: QualificationArtifactPaths = {
    json: join(outputDirectory, 'qualification-report.json'),
    markdown: join(outputDirectory, 'qualification-report.md'),
  };
  const artifacts: readonly [string, string][] = [
    [paths.json, renderEvaluationJson(report)],
    [paths.markdown, renderQualificationMarkdown(report, results, reproducibility)],
  ];
  const created: string[] = [];
  try {
    for (const [path, content] of artifacts) {
      await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
      created.push(path);
    }
    return paths;
  } catch (error) {
    await Promise.all(created.map((path) => unlink(path).catch(() => {})));
    throw error;
  }
}
