import { stableJson } from './environment.js';
import type { ScenarioRunResult } from './runner.js';
import type { BenchmarkSummary } from './schema.js';

export function renderBenchmarkJson(summary: BenchmarkSummary): string {
  return `${JSON.stringify(summary, null, 2)}\n`;
}

export function renderSamplesNdjson(
  results: readonly ScenarioRunResult[],
): string {
  const records = results
    .flatMap((result) => result.samples)
    .sort(
      (left, right) =>
        left.scenarioId.localeCompare(right.scenarioId) ||
        left.iteration - right.iteration,
    )
    .map((sample) => stableJson({ kind: 'sample', ...sample }));
  return records.length === 0 ? '' : `${records.join('\n')}\n`;
}

const number = (value: number): string => value.toFixed(2);
const integer = (value: number): string => value.toLocaleString('en-US');
const interval = (lower: number, upper: number): string =>
  `${number(lower)}–${number(upper)}`;

export function renderBenchmarkMarkdown(summary: BenchmarkSummary): string {
  const lines = [
    '# BrowserIR performance benchmark',
    '',
    `- Run: ${summary.runId}`,
    `- Environment fingerprint: \`${summary.environmentFingerprint}\``,
    `- Schema: ${summary.schemaVersion}`,
    '',
    '| Scenario | Warmups | Samples | p50 ms | p50 95% CI | p95 ms | p95 95% CI | MAD ms | Median payload bytes |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...summary.scenarios.map(
      (scenario) =>
        `| ${scenario.id.replaceAll('|', '\\|')} | ${scenario.warmups} | ${scenario.latencyMs.count} | ${number(scenario.latencyMs.p50)} | ${interval(scenario.latencyMsConfidence.p50.lower, scenario.latencyMsConfidence.p50.upper)} | ${number(scenario.latencyMs.p95)} | ${interval(scenario.latencyMsConfidence.p95.lower, scenario.latencyMsConfidence.p95.upper)} | ${number(scenario.latencyMs.medianAbsoluteDeviation)} | ${scenario.payloadBytes === undefined ? 'n/a' : integer(scenario.payloadBytes)} |`,
    ),
    '',
    'Latency uses untrimmed samples and Hyndman–Fan type-7 quantiles. Uncertainty is reported as deterministic 95% seeded percentile-bootstrap intervals with 2,000 resamples. Payload is the median UTF-8 byte size of the canonical text plus structured BrowserIR view.',
    'The `observe-warm/` scenarios navigate and settle once per isolated target, then time only steady-state observe calls without reloading between iterations.',
  ];
  return `${lines.join('\n')}\n`;
}
