import { link, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { stableJson } from '../environment.js';
import type { AgentTrialFailureKind, AgentTrialResult } from './contracts.js';
import type { JournalSafeAgentTrialResult } from './paired-contracts.js';
import { toJournalSafeAttempt } from './paired-journal.js';
import { deterministicModelSeed } from './paired-model-seed.js';
import { renderAgentBenchmarkChecksums } from './report.js';
import {
  parseControlCapabilityProtocol,
  type ControlCapabilityProtocol,
} from './control-capability-protocol.js';

export const CONTROL_CAPABILITY_REPORT_SCHEMA_VERSION = '1.0.0' as const;

export type ControlCapabilityStatus =
  | 'demonstrated'
  | 'not_demonstrated'
  | 'operationally_inconclusive';

type PublicAgentBinding<T> = T extends unknown ? Omit<T, 'systemPrompt'> : never;

export interface ControlCapabilityReport {
  schemaVersion: typeof CONTROL_CAPABILITY_REPORT_SCHEMA_VERSION;
  purpose: 'control_capability_qualification';
  scoreEligible: false;
  runId: string;
  protocolId: string;
  protocolSha256: string;
  binding: {
    task: ControlCapabilityProtocol['task'];
    schedule: ControlCapabilityProtocol['schedule'];
    decisionRule: ControlCapabilityProtocol['decisionRule'];
    budgets: ControlCapabilityProtocol['budgets'];
    agent: PublicAgentBinding<ControlCapabilityProtocol['agent']>;
    target: ControlCapabilityProtocol['target'];
    control: ControlCapabilityProtocol['control'];
  };
  result: {
    status: ControlCapabilityStatus;
    scheduledAttempts: 5;
    completedAttempts: number;
    minimumPasses: number;
    maximumInvalidAttempts: number;
    passed: number;
    failed: number;
    invalid: number;
  };
  attempts: JournalSafeAgentTrialResult[];
}

export interface CreateControlCapabilityReportInput {
  runId: string;
  protocol: ControlCapabilityProtocol;
  protocolSha256: string;
  attempts: readonly AgentTrialResult[];
}

export interface ControlCapabilityArtifactPaths {
  reportJson: string;
  attemptsNdjson: string;
  summaryMarkdown: string;
  checksums: string;
}

const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sha256 = /^[a-f0-9]{64}$/;

const failedAttemptFailureKinds = new Set<AgentTrialFailureKind>([
  'agent_timeout',
  'agent_error',
  'tool_budget_exceeded',
  'model_budget_exceeded',
  'policy_violation',
  'submission_missing',
  'submission_invalid',
  'submission_incorrect',
  'oracle_failed',
]);

const invalidAttemptFailureKinds = new Set<AgentTrialFailureKind>([
  'target_setup_failed',
  'target_version_mismatch',
  'baseline_already_passes',
  'baseline_invalid',
  'tool_catalog_mismatch',
  'agent_setup_failed',
  'judge_invalid',
  'cleanup_failed',
]);

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const publicAgentBinding = (
  agent: ControlCapabilityProtocol['agent'],
): PublicAgentBinding<ControlCapabilityProtocol['agent']> => {
  const { systemPrompt: _systemPrompt, ...binding } = agent;
  return binding as PublicAgentBinding<ControlCapabilityProtocol['agent']>;
};

const expectedModelConfiguration = (
  protocol: ControlCapabilityProtocol,
  trialIndex: number,
): Readonly<Record<string, unknown>> => {
  const agent = protocol.agent;
  const common = {
    provider: agent.provider,
    modelId: agent.modelId,
    temperature: agent.temperature,
    maxOutputTokens: agent.maxOutputTokens,
    maxRetries: agent.maxRetries,
    imageMode: agent.imageMode,
    seed: deterministicModelSeed(
      protocol.schedule.modelSeedBase,
      protocol.task.id,
      trialIndex,
    ),
  } as const;
  return agent.provider === 'openrouter'
    ? {
        ...common,
        canonicalModelSlug: agent.canonicalModelSlug,
        modelMetadataSha256: agent.modelMetadataSha256,
        providerRoute: agent.providerRoute,
        reasoningEffort: agent.reasoningEffort,
        providerPolicy: { ...agent.providerPolicy },
      }
    : {
        ...common,
        modelDigest: agent.modelDigest,
        contextWindowTokens: agent.contextWindowTokens,
      };
};

function validateAttemptOutcomeEvidence(attempt: AgentTrialResult): void {
  if (attempt.outcome === 'invalid') {
    if (
      attempt.failureKind === undefined ||
      !invalidAttemptFailureKinds.has(attempt.failureKind)
    ) {
      throw new Error(
        `Control capability invalid attempt has an invalid failure kind at trial ${attempt.trialIndex}.`,
      );
    }
    return;
  }

  if (attempt.outcome === 'failed' && attempt.agentStatus === 'not_started') {
    throw new Error(
      `Control capability ${attempt.outcome} attempt requires a started agent at trial ${attempt.trialIndex}.`,
    );
  }
  if (attempt.baseline === undefined || attempt.baseline.outcome !== 'failed') {
    throw new Error(
      `Control capability ${attempt.outcome} attempt requires a failed baseline at trial ${attempt.trialIndex}.`,
    );
  }
  if (attempt.judge === undefined) {
    throw new Error(
      `Control capability ${attempt.outcome} attempt requires a final judge at trial ${attempt.trialIndex}.`,
    );
  }

  if (attempt.outcome === 'failed') {
    if (
      attempt.failureKind === undefined ||
      !failedAttemptFailureKinds.has(attempt.failureKind)
    ) {
      throw new Error(
        `Control capability failed attempt has an invalid failure kind at trial ${attempt.trialIndex}.`,
      );
    }
    return;
  }

  if (attempt.failureKind !== undefined) {
    throw new Error(
      `Control capability passed attempt cannot retain a failure kind at trial ${attempt.trialIndex}.`,
    );
  }
  if (attempt.agentStatus !== 'completed') {
    throw new Error(
      `Control capability passed attempt requires a completed agent at trial ${attempt.trialIndex}.`,
    );
  }
  if (attempt.judge.outcome !== 'passed') {
    throw new Error(
      `Control capability passed attempt requires a passed final judge at trial ${attempt.trialIndex}.`,
    );
  }
  if (
    attempt.judge.criteria.length === 0 ||
    attempt.judge.criteria.some((criterion) => !criterion.passed)
  ) {
    throw new Error(
      `Control capability passed attempt requires all final judge criteria to pass at trial ${attempt.trialIndex}.`,
    );
  }
  if (attempt.submissionAttempts !== 1 || attempt.submittedResult === undefined) {
    throw new Error(
      `Control capability passed attempt requires exactly one accepted submission at trial ${attempt.trialIndex}.`,
    );
  }
}

const validateAttempt = (
  attempt: AgentTrialResult,
  protocol: ControlCapabilityProtocol,
  runId: string,
  expectedTrialIndex: number,
): void => {
  const expectedAttemptId = `${runId}:${protocol.task.id}:${expectedTrialIndex}`;
  if (attempt.attemptId !== expectedAttemptId) {
    throw new Error(
      `Control capability attempt identity drift: expected ${expectedAttemptId}, received ${attempt.attemptId}.`,
    );
  }
  if (attempt.trialIndex !== expectedTrialIndex) {
    throw new Error(
      `Control capability attempt schedule drift: expected trial ${expectedTrialIndex}, received ${attempt.trialIndex}.`,
    );
  }
  if (attempt.taskId !== protocol.task.id || attempt.taskVersion !== protocol.task.version) {
    throw new Error(`Control capability task binding drift at trial ${attempt.trialIndex}.`);
  }
  const started = attempt.agentStatus !== 'not_started';
  if (attempt.targetVersion !== protocol.target.expectedVersion && attempt.outcome !== 'invalid') {
    throw new Error(`Control capability target binding drift at trial ${attempt.trialIndex}.`);
  }
  if (
    attempt.tools.toolCatalogSha256 !== protocol.control.expectedToolCatalogSha256 &&
    attempt.outcome !== 'invalid'
  ) {
    throw new Error(`Control capability tool catalog drift at trial ${attempt.trialIndex}.`);
  }
  validateAttemptOutcomeEvidence(attempt);
  if (started && attempt.agent.model !== protocol.agent.modelId) {
    throw new Error(`Control capability model binding drift at trial ${attempt.trialIndex}.`);
  }
  if (started && attempt.agent.adapterId !== 'control-capability-langchain-agent') {
    throw new Error(`Control capability agent adapter drift at trial ${attempt.trialIndex}.`);
  }
  if (started && attempt.agent.framework !== protocol.agent.framework) {
    throw new Error(`Control capability agent framework drift at trial ${attempt.trialIndex}.`);
  }
  if (started && attempt.agent.frameworkVersion !== protocol.agent.frameworkVersion) {
    throw new Error(
      `Control capability agent framework version drift at trial ${attempt.trialIndex}.`,
    );
  }
  if (started && attempt.agent.systemPromptSha256 !== protocol.agent.systemPromptSha256) {
    throw new Error(`Control capability system prompt drift at trial ${attempt.trialIndex}.`);
  }
  if (
    started &&
    stableJson(attempt.agent.modelConfiguration) !==
      stableJson(expectedModelConfiguration(protocol, attempt.trialIndex))
  ) {
    throw new Error(
      `Control capability model configuration binding drift at trial ${attempt.trialIndex}.`,
    );
  }
  for (const [phase, judge] of [
    ['baseline', attempt.baseline],
    ['final', attempt.judge],
  ] as const) {
    if (judge !== undefined && judge.oracleVersion !== protocol.task.oracleVersion) {
      throw new Error(
        `Control capability ${phase} oracle binding drift at trial ${attempt.trialIndex}.`,
      );
    }
  }
};

const qualificationStatus = (input: {
  completed: number;
  passed: number;
  invalid: number;
  decisionRule: ControlCapabilityProtocol['decisionRule'];
}): ControlCapabilityStatus => {
  if (
    input.completed !== input.decisionRule.requiredCompletedAttempts ||
    input.invalid > input.decisionRule.maximumInvalidAttempts
  ) {
    return 'operationally_inconclusive';
  }
  return input.passed >= input.decisionRule.minimumPasses
    ? 'demonstrated'
    : 'not_demonstrated';
};

export function createControlCapabilityReport(
  input: CreateControlCapabilityReportInput,
): ControlCapabilityReport {
  if (!safeId.test(input.runId)) {
    throw new Error('Control capability runId must be a safe identifier.');
  }
  if (!sha256.test(input.protocolSha256)) {
    throw new Error('Control capability protocolSha256 must be a lowercase SHA-256 digest.');
  }
  const protocol = parseControlCapabilityProtocol(input.protocol);
  if (input.attempts.length > protocol.schedule.attempts) {
    throw new Error('Control capability attempts exceed the precommitted schedule.');
  }
  const attempts = [...input.attempts].sort(
    (left, right) =>
      left.trialIndex - right.trialIndex || compareText(left.attemptId, right.attemptId),
  );
  attempts.forEach((attempt, index) => validateAttempt(attempt, protocol, input.runId, index));
  const passed = attempts.filter((attempt) => attempt.outcome === 'passed').length;
  const failed = attempts.filter((attempt) => attempt.outcome === 'failed').length;
  const invalid = attempts.filter((attempt) => attempt.outcome === 'invalid').length;
  return {
    schemaVersion: CONTROL_CAPABILITY_REPORT_SCHEMA_VERSION,
    purpose: 'control_capability_qualification',
    scoreEligible: false,
    runId: input.runId,
    protocolId: protocol.protocolId,
    protocolSha256: input.protocolSha256,
    binding: {
      task: { ...protocol.task },
      schedule: { ...protocol.schedule },
      decisionRule: { ...protocol.decisionRule },
      budgets: { ...protocol.budgets },
      agent: publicAgentBinding(protocol.agent),
      target: { ...protocol.target },
      control: { ...protocol.control },
    },
    result: {
      status: qualificationStatus({
        completed: attempts.length,
        passed,
        invalid,
        decisionRule: protocol.decisionRule,
      }),
      scheduledAttempts: protocol.schedule.attempts,
      completedAttempts: attempts.length,
      minimumPasses: protocol.decisionRule.minimumPasses,
      maximumInvalidAttempts: protocol.decisionRule.maximumInvalidAttempts,
      passed,
      failed,
      invalid,
    },
    attempts: attempts.map(toJournalSafeAttempt),
  };
}

export function renderControlCapabilityJson(report: ControlCapabilityReport): string {
  const canonical = JSON.parse(stableJson(report)) as unknown;
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export function renderControlCapabilityAttemptsNdjson(
  report: ControlCapabilityReport,
): string {
  const attempts = [...report.attempts].sort(
    (left, right) =>
      left.trialIndex - right.trialIndex || compareText(left.attemptId, right.attemptId),
  );
  return attempts.length === 0
    ? ''
    : `${attempts
        .map((attempt) =>
          stableJson({
            runId: report.runId,
            protocolId: report.protocolId,
            attempt,
          }),
        )
        .join('\n')}\n`;
}

const markdownText = (value: string): string =>
  value.replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ');

const statusSentence = (status: ControlCapabilityStatus): string => {
  if (status === 'demonstrated') {
    return 'Capability demonstrated: at least one complete attempt passed the deterministic judge.';
  }
  if (status === 'not_demonstrated') {
    return 'Capability not demonstrated: the complete schedule contained no passing attempt.';
  }
  return 'Operationally inconclusive: the full valid schedule did not complete.';
};

export function renderControlCapabilityMarkdown(report: ControlCapabilityReport): string {
  const result = report.result;
  const lines = [
    '# Official Playwright MCP control capability qualification',
    '',
    '> **SCORE-EXCLUDED.** This qualification contains no BrowserIR treatment arm and is not comparative evidence.',
    '',
    `**${statusSentence(result.status)}**`,
    '',
    `- Run: ${markdownText(report.runId)}`,
    `- Protocol: ${markdownText(report.protocolId)}`,
    `- Protocol SHA-256: ${report.protocolSha256}`,
    `- Task: ${markdownText(report.binding.task.id)}`,
    `- Control: ${markdownText(report.binding.control.label)} ${markdownText(report.binding.control.interfaceVersion)}`,
    `- Model: ${markdownText(report.binding.agent.modelId)} (${markdownText(report.binding.agent.provider)})`,
    `- Schedule: ${result.completedAttempts} / ${result.scheduledAttempts} completed`,
    '',
    '## Raw outcome counts',
    '',
    `**${result.passed} passed, ${result.failed} failed, ${result.invalid} invalid.**`,
    '',
    'Every scheduled outcome is retained. The qualification requires the complete five-attempt schedule, zero invalid attempts, and at least one pass.',
    '',
    '## Attempts',
    '',
    '| Trial | Outcome | Failure kind | Tool calls | Model turns |',
    '| ---: | --- | --- | ---: | ---: |',
    ...report.attempts.map(
      (attempt) =>
        `| ${attempt.trialIndex} | ${attempt.outcome} | ${markdownText(attempt.failureKind ?? '')} | ${attempt.tools.calls} | ${attempt.modelTurns} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

export async function writeControlCapabilityArtifacts(
  outputDirectory: string,
  report: ControlCapabilityReport,
  additionalArtifacts: Readonly<Record<string, string>> = {},
): Promise<ControlCapabilityArtifactPaths> {
  const dataArtifacts = {
    'attempts.ndjson': renderControlCapabilityAttemptsNdjson(report),
    'control-capability.json': renderControlCapabilityJson(report),
    'summary.md': renderControlCapabilityMarkdown(report),
  } as const;
  for (const name of Object.keys(additionalArtifacts)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
      throw new Error(`Additional control capability artifact name is unsafe: ${name}`);
    }
    if (name in dataArtifacts || name === 'SHA256SUMS') {
      throw new Error(`Additional control capability artifact name is reserved: ${name}`);
    }
  }
  const checksummedArtifacts = { ...dataArtifacts, ...additionalArtifacts };
  const allArtifacts = {
    ...checksummedArtifacts,
    SHA256SUMS: renderAgentBenchmarkChecksums(checksummedArtifacts),
  };
  const paths: ControlCapabilityArtifactPaths = {
    reportJson: join(outputDirectory, 'control-capability.json'),
    attemptsNdjson: join(outputDirectory, 'attempts.ndjson'),
    summaryMarkdown: join(outputDirectory, 'summary.md'),
    checksums: join(outputDirectory, 'SHA256SUMS'),
  };
  let createdDirectory = false;
  let stagingDirectory: string | undefined;
  const created: string[] = [];
  try {
    createdDirectory = (await mkdir(outputDirectory, { recursive: true })) !== undefined;
    stagingDirectory = await mkdtemp(join(outputDirectory, '.control-capability-'));
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
