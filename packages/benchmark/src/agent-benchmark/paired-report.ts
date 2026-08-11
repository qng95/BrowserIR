import { link, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { stableJson } from '../environment.js';
import type {
  AgentToolTraceEntry,
} from './contracts.js';
import type {
  AgentBenchmarkArmRole,
  JournalSafeAgentTrialResult,
  PairedAgentBenchmarkBlock,
  PairedAgentBenchmarkReport,
} from './paired-contracts.js';
import { renderAgentBenchmarkChecksums } from './report.js';

export interface PairedAgentBenchmarkArtifactPaths {
  comparisonJson: string;
  attemptsNdjson: string;
  summaryMarkdown: string;
  checksums: string;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareBlocks = (
  left: Pick<PairedAgentBenchmarkBlock, 'taskId' | 'trialIndex' | 'blockId'>,
  right: Pick<PairedAgentBenchmarkBlock, 'taskId' | 'trialIndex' | 'blockId'>,
): number =>
  compareText(left.taskId, right.taskId) ||
  left.trialIndex - right.trialIndex ||
  compareText(left.blockId, right.blockId);

const orderedReport = (report: PairedAgentBenchmarkReport): PairedAgentBenchmarkReport => ({
  ...report,
  arms: [...report.arms].sort((left, right) =>
    left.role === right.role ? 0 : left.role === 'control' ? -1 : 1,
  ),
  blocks: [...report.blocks].sort(compareBlocks),
});

const publicInputKeyPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const publicActionKindPattern = /^[a-z][a-z0-9_]{0,63}$/;
const publicErrorCodePattern =
  /^(?:[a-z][a-z0-9_]{0,63}|[A-Z][A-Z0-9_]{0,63}|-32[0-9]{3})$/;

const publicDiagnostic = (
  value: unknown,
  pattern: RegExp,
): string | undefined =>
  typeof value === 'string' && pattern.test(value) ? value : undefined;

const publicTrace = (trace: readonly AgentToolTraceEntry[]): AgentToolTraceEntry[] =>
  trace.map((entry) => {
    const inputKeys = Array.isArray(entry.inputKeys)
      ? entry.inputKeys
          .filter(
            (key): key is string =>
              typeof key === 'string' && publicInputKeyPattern.test(key),
          )
          .sort(compareText)
      : [];
    const actionKind = publicDiagnostic(entry.actionKind, publicActionKindPattern);
    const resultErrorCode = publicDiagnostic(
      entry.result?.errorCode,
      publicErrorCodePattern,
    );
    const errorCode = publicDiagnostic(entry.errorCode, publicErrorCodePattern);
    return {
      index: entry.index,
      tool: entry.tool,
      inputKeys,
      ...(actionKind === undefined ? {} : { actionKind }),
      outcome: entry.outcome,
      durationMs: entry.durationMs,
      ...(entry.result === undefined
        ? {}
        : {
            result: {
              isError: entry.result.isError,
              ...(resultErrorCode === undefined ? {} : { errorCode: resultErrorCode }),
            },
          }),
      ...(errorCode === undefined ? {} : { errorCode }),
    };
  });

const publicJournalAttempt = (
  attempt: JournalSafeAgentTrialResult,
): JournalSafeAgentTrialResult => ({
  ...attempt,
  tools: {
    ...attempt.tools,
    byTool: { ...attempt.tools.byTool },
  },
  ...(attempt.toolTrace === undefined ? {} : { toolTrace: publicTrace(attempt.toolTrace) }),
  ...(attempt.baseline === undefined
    ? {}
    : {
        baseline: {
          ...attempt.baseline,
          criteria: attempt.baseline.criteria.map((criterion) => ({ ...criterion })),
        },
      }),
  ...(attempt.judge === undefined
    ? {}
    : {
        judge: {
          ...attempt.judge,
          criteria: attempt.judge.criteria.map((criterion) => ({ ...criterion })),
        },
      }),
  agent: { ...attempt.agent },
});

type PublicationBlock = Omit<PairedAgentBenchmarkBlock, 'attempts' | 'journalAttempts'> & {
  attempts: Record<AgentBenchmarkArmRole, JournalSafeAgentTrialResult>;
};

type PublicationReport = Omit<PairedAgentBenchmarkReport, 'blocks'> & {
  blocks: PublicationBlock[];
};

const publicationReport = (report: PairedAgentBenchmarkReport): PublicationReport => ({
  ...report,
  blocks: report.blocks.map((block) => {
    const { attempts: _privateAttempts, journalAttempts, ...metadata } = block;
    return {
      ...metadata,
      attempts: {
        control: publicJournalAttempt(journalAttempts.control),
        treatment: publicJournalAttempt(journalAttempts.treatment),
      },
    };
  }),
});

export function renderPairedAgentBenchmarkJson(
  report: PairedAgentBenchmarkReport,
): string {
  const canonical = JSON.parse(
    stableJson(publicationReport(orderedReport(report))),
  ) as unknown;
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export function renderPairedAgentBenchmarkAttemptsNdjson(
  report: PairedAgentBenchmarkReport,
): string {
  const entries = [...publicationReport(report).blocks].sort(compareBlocks).flatMap((block) =>
    (['control', 'treatment'] as const).map((role) => ({
      blockId: block.blockId,
      order: block.order,
      blockOutcome: block.outcome,
      role,
      attempt: block.attempts[role],
    })),
  );
  return entries.length === 0
    ? ''
    : `${entries.map((entry) => stableJson(entry)).join('\n')}\n`;
}

const markdownText = (value: string): string =>
  value.replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ');

const percentage = (value: number): string => `${(value * 100).toFixed(2)}%`;

const signedPoints = (value: number): string => {
  const points = value * 100;
  return `${points >= 0 ? '+' : ''}${points.toFixed(2)}`;
};

const armByRole = (
  report: PairedAgentBenchmarkReport,
  role: AgentBenchmarkArmRole,
) => {
  const arm = report.arms.find((candidate) => candidate.role === role);
  if (arm === undefined) throw new Error(`Paired report is missing ${role} arm metadata.`);
  return arm;
};

const claim = (report: PairedAgentBenchmarkReport): string => {
  if (report.phase !== 'sealed') return 'Development result only; no public uplift claim.';
  if (report.protocolBinding !== 'frozen_verified') {
    return 'Insufficient evidence: the result is not bound to a verified frozen protocol.';
  }
  if (report.summary.pairedLift.method !== 'paired-hoeffding-bound') {
    return 'Insufficient evidence: the interval method is not approved for a sealed headline.';
  }
  if (
    report.summary.scheduledBlocks < 30 ||
    report.blocks.length !== report.summary.scheduledBlocks ||
    report.summary.validBlocks !== report.summary.pairedLift.pairs
  ) {
    return 'Insufficient evidence: the frozen minimum schedule was not completed.';
  }
  if (report.summary.invalidBlocks / report.summary.scheduledBlocks > 0.05) {
    return 'Operationally inconclusive: more than 5% of matched blocks were invalid.';
  }
  const { lower, upper } = report.summary.pairedLift;
  if (lower !== null && lower > 0) return 'BrowserIR improved success on this workflow.';
  if (upper !== null && upper < 0) return 'BrowserIR regressed on this workflow.';
  return 'Pilot was inconclusive; the 95% paired interval crosses zero.';
};

export function renderPairedAgentBenchmarkMarkdown(
  report: PairedAgentBenchmarkReport,
): string {
  const ordered = orderedReport(report);
  const control = armByRole(ordered, 'control');
  const treatment = armByRole(ordered, 'treatment');
  const lift = ordered.summary.pairedLift;
  const recoveredInterruptions = ordered.blocks.reduce(
    (sum, block) => sum + (block.recovery?.interruptedAttempts.length ?? 0),
    0,
  );
  const liftText =
    lift.estimate === null || lift.lower === null || lift.upper === null
      ? 'n/a (no valid matched blocks)'
      : `${signedPoints(lift.estimate)} percentage points (95% paired CI ${signedPoints(lift.lower)} to ${signedPoints(lift.upper)} pp)`;
  const lines = [
    '# BrowserIR Evidence Drop comparison',
    '',
    '> This is a controlled fixture pilot. It is not a general browser-agent benchmark.',
    '',
    `**${claim(ordered)}**`,
    '',
    `- Run: ${markdownText(ordered.runId)}`,
    `- Protocol: ${markdownText(ordered.protocolId)} (${ordered.phase})`,
    `- Protocol SHA-256: ${ordered.protocolSha256}`,
    `- Control: ${markdownText(control.label)} ${markdownText(control.interfaceVersion)}`,
    `- Treatment: ${markdownText(treatment.label)} ${markdownText(treatment.interfaceVersion)}`,
    `- Schedule seed: ${ordered.scheduleSeed}`,
    `- Target version: ${markdownText(ordered.expectedTargetVersion)}`,
    `- Budgets: ${ordered.budgets.maxDurationMs} ms, ${ordered.budgets.maxToolCalls} tool calls, ${ordered.budgets.maxModelTurns} model turns per attempt`,
    '',
    '## Primary result',
    '',
    `Paired treatment-minus-control success lift: **${liftText}** across ${lift.pairs} valid matched block(s).`,
    `Interval method: ${lift.method}.`,
    '',
    '| Arm | Passed / paired-valid attempts | Pass rate | Invalid |',
    '| --- | ---: | ---: | ---: |',
    `| ${markdownText(control.label)} | ${ordered.summary.arms.control.passed} / ${ordered.summary.arms.control.passRate.trials} | ${percentage(ordered.summary.arms.control.passRate.rate)} | ${ordered.summary.arms.control.invalid} |`,
    `| ${markdownText(treatment.label)} | ${ordered.summary.arms.treatment.passed} / ${ordered.summary.arms.treatment.passRate.trials} | ${percentage(ordered.summary.arms.treatment.passRate.rate)} | ${ordered.summary.arms.treatment.invalid} |`,
    ...(ordered.summary.invalidBlocks > 0 && ordered.summary.operationalArms !== undefined
      ? [
          '',
          'Operational all-attempt counts (not used for paired lift):',
          '',
          '| Arm | Passed | Failed | Invalid |',
          '| --- | ---: | ---: | ---: |',
          `| ${markdownText(control.label)} | ${ordered.summary.operationalArms.control.passed} | ${ordered.summary.operationalArms.control.failed} | ${ordered.summary.operationalArms.control.invalid} |`,
          `| ${markdownText(treatment.label)} | ${ordered.summary.operationalArms.treatment.passed} | ${ordered.summary.operationalArms.treatment.failed} | ${ordered.summary.operationalArms.treatment.invalid} |`,
        ]
      : []),
    '',
    `Matched outcomes: ${ordered.summary.treatmentWins} treatment win(s), ${ordered.summary.controlWins} control win(s), ${ordered.summary.bothPassed} both passed, ${ordered.summary.bothFailed} both failed, and ${ordered.summary.invalidBlocks} invalid block(s).`,
    ...(recoveredInterruptions === 0
      ? []
      : [
          '',
          `Recovered process interruptions: ${recoveredInterruptions}. Every affected matched block is retained as invalid and excluded from uplift.`,
        ]),
    '',
    'Invalid attempts remain in the evidence and are excluded only from the paired lift denominator. They are never silently rerun.',
    '',
    '## Matched blocks',
    '',
    '| Block | Task | Trial | Order | Outcome | Control | Treatment |',
    '| --- | --- | ---: | --- | --- | --- | --- |',
    ...ordered.blocks.map(
      (block) =>
        `| ${markdownText(block.blockId)} | ${markdownText(block.taskId)} | ${block.trialIndex} | ${block.order.join(' → ')} | ${block.outcome} | ${block.attempts.control.outcome} | ${block.attempts.treatment.outcome} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

export async function writePairedAgentBenchmarkArtifacts(
  outputDirectory: string,
  report: PairedAgentBenchmarkReport,
  additionalArtifacts: Readonly<Record<string, string>> = {},
): Promise<PairedAgentBenchmarkArtifactPaths> {
  const dataArtifacts = {
    'attempts.ndjson': renderPairedAgentBenchmarkAttemptsNdjson(report),
    'comparison.json': renderPairedAgentBenchmarkJson(report),
    'summary.md': renderPairedAgentBenchmarkMarkdown(report),
  } as const;
  for (const name of Object.keys(additionalArtifacts)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
      throw new Error(`Additional artifact name is unsafe: ${name}`);
    }
    if (name in dataArtifacts || name === 'SHA256SUMS') {
      throw new Error(`Additional artifact name is reserved: ${name}`);
    }
  }
  const checksummedArtifacts = { ...dataArtifacts, ...additionalArtifacts };
  const allArtifacts = {
    ...checksummedArtifacts,
    SHA256SUMS: renderAgentBenchmarkChecksums(checksummedArtifacts),
  } as const;
  const paths: PairedAgentBenchmarkArtifactPaths = {
    comparisonJson: join(outputDirectory, 'comparison.json'),
    attemptsNdjson: join(outputDirectory, 'attempts.ndjson'),
    summaryMarkdown: join(outputDirectory, 'summary.md'),
    checksums: join(outputDirectory, 'SHA256SUMS'),
  };
  let createdDirectory = false;
  let stagingDirectory: string | undefined;
  const created: string[] = [];
  try {
    createdDirectory = (await mkdir(outputDirectory, { recursive: true })) !== undefined;
    stagingDirectory = await mkdtemp(join(outputDirectory, '.paired-agent-benchmark-'));
    for (const [name, content] of Object.entries(allArtifacts)) {
      await writeFile(join(stagingDirectory, name), content, { encoding: 'utf8', flag: 'wx' });
    }
    for (const name of Object.keys(allArtifacts)) {
      const destination = join(outputDirectory, name);
      try {
        await link(join(stagingDirectory, name), destination);
        created.push(destination);
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code?: unknown }).code
            : undefined;
        if (code !== 'EEXIST') throw error;
        const existing = await readFile(destination, 'utf8');
        if (existing !== allArtifacts[name as keyof typeof allArtifacts]) {
          throw new Error(`Existing artifact differs from finalized evidence: ${name}`);
        }
      }
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
