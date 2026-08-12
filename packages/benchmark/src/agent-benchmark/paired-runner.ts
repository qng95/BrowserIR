import { createHash } from 'node:crypto';

import { stableJson } from '../environment.js';
import type { AgentTrialResult } from './contracts.js';
import type {
  AgentBenchmarkArm,
  AgentBenchmarkArmRole,
  JournalSafeAgentTrialResult,
  JournalSafeJudgeResult,
  PairedAgentBenchmarkBlock,
  PairedAgentBenchmarkClaimPolicy,
  PairedAgentBenchmarkOptions,
  PairedAgentBenchmarkReport,
  PairedArmSummary,
  PairedBlockOutcome,
} from './paired-contracts.js';
import {
  PAIRED_AGENT_BENCHMARK_SCHEMA_VERSION,
  SEALED_PAIRED_AGENT_BENCHMARK_CLAIM_POLICY,
} from './paired-contracts.js';
import {
  pairedHoeffdingLiftInterval,
  pairedLiftInterval,
} from './paired-statistics.js';
import { toJournalSafeAttempt } from './paired-journal.js';
import { runAgentBenchmark } from './runner.js';
import { wilsonInterval } from './statistics.js';

const safeIdentifier = (value: string, label: string): void => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.length > 128) {
    throw new Error(`${label} must be a safe identifier of at most 128 characters.`);
  }
};

const positiveInteger = (value: number, label: string): void => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
};

const armMap = (
  arms: readonly [AgentBenchmarkArm, AgentBenchmarkArm],
): Record<AgentBenchmarkArmRole, AgentBenchmarkArm> => {
  const control = arms.find((arm) => arm.role === 'control');
  const treatment = arms.find((arm) => arm.role === 'treatment');
  if (control === undefined || treatment === undefined) {
    throw new Error('Paired benchmark requires exactly one control and one treatment arm.');
  }
  if (control.id === treatment.id) throw new Error('Paired benchmark arm IDs must differ.');
  for (const arm of [control, treatment]) {
    safeIdentifier(arm.id, `${arm.role} arm ID`);
    if (arm.label.trim().length === 0) throw new Error(`${arm.role} arm label must not be empty.`);
    if (arm.interfaceVersion.trim().length === 0) {
      throw new Error(`${arm.role} interface version must not be empty.`);
    }
  }
  return { control, treatment };
};

const taskStartsWithControl = (scheduleSeed: number, taskId: string): boolean =>
  (createHash('sha256')
    .update(`${scheduleSeed}\0${taskId}`, 'utf8')
    .digest()[0]! & 1) === 0;

export function pairedArmOrder(
  scheduleSeed: number,
  taskId: string,
  trialIndex: number,
): readonly [AgentBenchmarkArmRole, AgentBenchmarkArmRole] {
  const controlFirst = taskStartsWithControl(scheduleSeed, taskId) === (trialIndex % 2 === 0);
  return controlFirst ? ['control', 'treatment'] : ['treatment', 'control'];
}

const classifyBlock = (
  control: AgentTrialResult,
  treatment: AgentTrialResult,
): PairedBlockOutcome => {
  if (control.outcome === 'invalid' || treatment.outcome === 'invalid') return 'invalid';
  if (control.outcome === 'passed' && treatment.outcome === 'passed') return 'both_passed';
  if (control.outcome === 'failed' && treatment.outcome === 'failed') return 'both_failed';
  return treatment.outcome === 'passed' ? 'treatment_win' : 'control_win';
};

type BlockIntegrityFailure = NonNullable<
  PairedAgentBenchmarkBlock['integrityFailures']
>[number];

const blockIntegrityFailures = (
  control: AgentTrialResult,
  treatment: AgentTrialResult,
): BlockIntegrityFailure[] => {
  const failures: BlockIntegrityFailure[] = [];
  if (control.targetVersion !== treatment.targetVersion) {
    failures.push('target_version_mismatch');
  }
  if (control.taskVersion !== treatment.taskVersion) {
    failures.push('task_version_mismatch');
  }
  if (
    control.baseline !== undefined &&
    treatment.baseline !== undefined &&
    control.baseline.stateFingerprint !== treatment.baseline.stateFingerprint
  ) {
    failures.push('baseline_state_fingerprint_mismatch');
  }
  if (
    control.baseline !== undefined &&
    treatment.baseline !== undefined &&
    control.baseline.oracleVersion !== treatment.baseline.oracleVersion
  ) {
    failures.push('baseline_oracle_version_mismatch');
  }
  return failures;
};

const restoredJudge = (judge: JournalSafeJudgeResult | undefined) =>
  judge === undefined
    ? undefined
    : {
        outcome: judge.outcome,
        oracleVersion: judge.oracleVersion,
        stateFingerprint: judge.stateFingerprint,
        criteria: judge.criteria.map((criterion) => ({
          id: criterion.id,
          required: criterion.required,
          passed: criterion.passed,
          description: `[recovered description sha256:${criterion.descriptionSha256}]`,
          ...(criterion.evidenceSha256 === undefined
            ? {}
            : {
                evidence: {
                  publication: '[recovered from crash journal]',
                  sha256: criterion.evidenceSha256,
                },
              }),
        })),
        ...(judge.evidenceSha256 === undefined
          ? {}
          : {
              evidence: {
                publication: '[recovered from crash journal]',
                sha256: judge.evidenceSha256,
              },
            }),
        ...(judge.reasonSha256 === undefined
          ? {}
          : { reason: `[recovered reason sha256:${judge.reasonSha256}]` }),
      };

const restoredAttempt = (attempt: JournalSafeAgentTrialResult): AgentTrialResult => ({
  attemptId: attempt.attemptId,
  taskId: attempt.taskId,
  ...(attempt.taskVersion === undefined ? {} : { taskVersion: attempt.taskVersion }),
  trialIndex: attempt.trialIndex,
  outcome: attempt.outcome,
  ...(attempt.failureKind === undefined ? {} : { failureKind: attempt.failureKind }),
  targetId: attempt.targetId,
  targetVersion: attempt.targetVersion,
  agentStatus: attempt.agentStatus,
  submissionAttempts: attempt.submissionAttempts,
  modelTurns: attempt.modelTurns,
  ...(attempt.usage === undefined ? {} : { usage: { ...attempt.usage } }),
  durationMs: attempt.durationMs,
  ...(attempt.agentRunDurationMs === undefined
    ? {}
    : { agentRunDurationMs: attempt.agentRunDurationMs }),
  tools: {
    calls: attempt.tools.calls,
    errors: attempt.tools.errors,
    byTool: { ...attempt.tools.byTool },
    budgetExceeded: attempt.tools.budgetExceeded,
    ...(attempt.tools.adapterRejectedCalls === undefined
      ? {}
      : { adapterRejectedCalls: attempt.tools.adapterRejectedCalls }),
    ...(attempt.tools.adapterRejectionsByCode === undefined
      ? {}
      : {
          adapterRejectionsByCode: {
            ...attempt.tools.adapterRejectionsByCode,
          },
        }),
    ...(attempt.tools.policyViolationCount === 0
      ? {}
      : {
          policyViolations: Array.from(
            { length: attempt.tools.policyViolationCount },
            () => '[recovered policy violation]',
          ),
        }),
    ...(attempt.tools.toolCatalogSha256 === undefined
      ? {}
      : { toolCatalogSha256: attempt.tools.toolCatalogSha256 }),
    ...(attempt.tools.toolCatalogToolCount === undefined
      ? {}
      : { toolCatalogToolCount: attempt.tools.toolCatalogToolCount }),
    ...(attempt.tools.responseBytes === undefined
      ? {}
      : { responseBytes: attempt.tools.responseBytes }),
    ...(attempt.tools.screenshots === undefined
      ? {}
      : { screenshots: attempt.tools.screenshots }),
    ...(attempt.tools.dispatchedBrowserActions === undefined
      ? {}
      : { dispatchedBrowserActions: attempt.tools.dispatchedBrowserActions }),
  },
  ...(attempt.toolTrace === undefined ? {} : { toolTrace: attempt.toolTrace }),
  ...(attempt.baseline === undefined ? {} : { baseline: restoredJudge(attempt.baseline) }),
  ...(attempt.judge === undefined ? {} : { judge: restoredJudge(attempt.judge) }),
  agent: {
    adapterId: attempt.agent.adapterId,
    framework: attempt.agent.framework,
    frameworkVersion: attempt.agent.frameworkVersion,
    model: attempt.agent.model,
    ...(attempt.agent.systemPromptSha256 === undefined
      ? {}
      : { systemPromptSha256: attempt.agent.systemPromptSha256 }),
  },
});

const validateResume = (
  options: PairedAgentBenchmarkOptions,
  scheduledBlocks: number,
): void => {
  const resume = options.resume;
  if (resume === undefined) return;
  if (
    resume.run.runId !== options.runId ||
    resume.run.protocolId !== options.protocolId ||
    resume.run.protocolSha256 !== options.protocolSha256 ||
    resume.run.phase !== options.phase ||
    (resume.run.protocolBinding ?? 'development') !== options.protocolBinding ||
    resume.run.scheduledBlocks !== scheduledBlocks
  ) {
    throw new Error('Resume journal does not match the paired benchmark run.');
  }
  for (let index = 0; index < resume.blocks.length; index += 1) {
    const retained = resume.blocks[index]!;
    const taskIndex = Math.floor(index / options.trialsPerTask);
    const trialIndex = index % options.trialsPerTask;
    const task = options.tasks[taskIndex];
    if (task === undefined) throw new Error('Resume journal exceeds the benchmark schedule.');
    const blockId = `${options.runId}:${task.id}:${trialIndex}`;
    const order = pairedArmOrder(options.scheduleSeed, task.id, trialIndex);
    if (
      retained.blockId !== blockId ||
      retained.taskId !== task.id ||
      retained.taskVersion !== task.version ||
      retained.trialIndex !== trialIndex ||
      retained.order[0] !== order[0] ||
      retained.order[1] !== order[1]
    ) {
      throw new Error(`Resume journal schedule drift at block ${index}.`);
    }
    if (Object.keys(retained.activeAttempts).length !== 0) {
      throw new Error(
        `Resume journal still has an active attempt in ${retained.blockId}; reopen it through resumePairedJournal first.`,
      );
    }
  }
};

const summarizeArm = (attempts: readonly AgentTrialResult[]): PairedArmSummary => {
  const passed = attempts.filter((attempt) => attempt.outcome === 'passed').length;
  const failed = attempts.filter((attempt) => attempt.outcome === 'failed').length;
  const invalid = attempts.filter((attempt) => attempt.outcome === 'invalid').length;
  return {
    attempts: attempts.length,
    passed,
    failed,
    invalid,
    passRate: wilsonInterval(passed, passed + failed),
    toolTotals: {
      calls: attempts.reduce((sum, attempt) => sum + attempt.tools.calls, 0),
      errors: attempts.reduce((sum, attempt) => sum + attempt.tools.errors, 0),
      responseBytes: attempts.reduce(
        (sum, attempt) => sum + (attempt.tools.responseBytes ?? 0),
        0,
      ),
      screenshots: attempts.reduce(
        (sum, attempt) => sum + (attempt.tools.screenshots ?? 0),
        0,
      ),
      dispatchedBrowserActions: attempts.reduce(
        (sum, attempt) => sum + (attempt.tools.dispatchedBrowserActions ?? 0),
        0,
      ),
    },
  };
};

async function runArmAttempt(input: {
  options: PairedAgentBenchmarkOptions;
  arm: AgentBenchmarkArm;
  taskIndex: number;
  trialIndex: number;
}): Promise<AgentTrialResult> {
  const task = input.options.tasks[input.taskIndex]!;
  const ordinal = input.taskIndex * input.options.trialsPerTask + input.trialIndex;
  const report = await runAgentBenchmark({
    runId: `${input.options.runId}-${input.arm.role}-${ordinal}`,
    tasks: [task],
    trialsPerTask: 1,
    expectedTargetVersion: input.options.expectedTargetVersion,
    expectedToolCatalogSha256: input.arm.expectedToolCatalogSha256,
    budgets: input.options.budgets,
    targetFactory: () => input.arm.targetFactory(task, input.trialIndex),
    agentFactory: () => input.arm.agentFactory(task, input.trialIndex),
  });
  const attempt = report.trials[0]!;
  return {
    ...attempt,
    attemptId: `${input.options.runId}:${task.id}:${input.trialIndex}:${input.arm.role}`,
    trialIndex: input.trialIndex,
  };
}

const noEvents = async (): Promise<void> => {};

const validatedClaimPolicy = (
  options: PairedAgentBenchmarkOptions,
): PairedAgentBenchmarkClaimPolicy | undefined => {
  if (options.claimPolicy === undefined) {
    if (options.phase === 'sealed') {
      throw new Error('A sealed paired benchmark requires the exact frozen claim policy.');
    }
    return undefined;
  }
  if (
    stableJson(options.claimPolicy) !==
    stableJson(SEALED_PAIRED_AGENT_BENCHMARK_CLAIM_POLICY)
  ) {
    throw new Error('Paired benchmark claim policy differs from the approved frozen policy.');
  }
  return {
    decisionRule: {
      minimumScheduledBlocks: options.claimPolicy.decisionRule.minimumScheduledBlocks,
      maximumInvalidBlocks: options.claimPolicy.decisionRule.maximumInvalidBlocks,
      positive: { ...options.claimPolicy.decisionRule.positive },
      negative: { ...options.claimPolicy.decisionRule.negative },
      otherwise: options.claimPolicy.decisionRule.otherwise,
    },
    publicationRule: options.claimPolicy.publicationRule,
    estimand: options.claimPolicy.estimand,
  };
};

export async function runPairedAgentBenchmark(
  options: PairedAgentBenchmarkOptions,
): Promise<PairedAgentBenchmarkReport> {
  safeIdentifier(options.runId, 'runId');
  safeIdentifier(options.protocolId, 'protocolId');
  if (!/^[a-f0-9]{64}$/.test(options.protocolSha256)) {
    throw new Error('protocolSha256 must be a lowercase SHA-256 digest.');
  }
  if (
    (options.phase === 'development' && options.protocolBinding !== 'development') ||
    (options.phase === 'sealed' && options.protocolBinding !== 'frozen_verified')
  ) {
    throw new Error('Protocol binding does not match the benchmark phase.');
  }
  const claimPolicy = validatedClaimPolicy(options);
  positiveInteger(options.trialsPerTask, 'trialsPerTask');
  positiveInteger(options.bootstrapResamples, 'bootstrapResamples');
  if (options.tasks.length === 0) throw new Error('tasks must not be empty.');
  if (new Set(options.tasks.map((task) => task.id)).size !== options.tasks.length) {
    throw new Error('task IDs must be unique.');
  }
  if (
    !Number.isInteger(options.scheduleSeed) ||
    options.scheduleSeed < 0 ||
    options.scheduleSeed > 0xffff_ffff
  ) {
    throw new Error('scheduleSeed must be an unsigned 32-bit integer.');
  }
  const arms = armMap(options.arms);
  const blocks: PairedAgentBenchmarkBlock[] = [];
  const emit = options.eventSink ?? noEvents;
  const scheduledBlocks = options.tasks.length * options.trialsPerTask;
  validateResume(options, scheduledBlocks);
  if (options.resume === undefined) {
    await emit({
      type: 'run_started',
      runId: options.runId,
      protocolId: options.protocolId,
      protocolSha256: options.protocolSha256,
      phase: options.phase,
      protocolBinding: options.protocolBinding,
      scheduledBlocks,
    });
  }

  for (let taskIndex = 0; taskIndex < options.tasks.length; taskIndex += 1) {
    const task = options.tasks[taskIndex]!;
    for (let trialIndex = 0; trialIndex < options.trialsPerTask; trialIndex += 1) {
      const blockOrdinal = taskIndex * options.trialsPerTask + trialIndex;
      const retained = options.resume?.blocks[blockOrdinal];
      const order = pairedArmOrder(options.scheduleSeed, task.id, trialIndex);
      const blockId = `${options.runId}:${task.id}:${trialIndex}`;
      if (retained === undefined) {
        await emit({
          type: 'block_started',
          blockId,
          taskId: task.id,
          ...(task.version === undefined ? {} : { taskVersion: task.version }),
          trialIndex,
          order,
        });
      }
      const attempts = {} as Record<AgentBenchmarkArmRole, AgentTrialResult>;
      const attemptEvidence = {} as Record<
        AgentBenchmarkArmRole,
        JournalSafeAgentTrialResult
      >;
      for (const role of order) {
        const retainedAttempt = retained?.attempts[role];
        if (retainedAttempt === undefined) continue;
        attemptEvidence[role] = retainedAttempt;
        attempts[role] = restoredAttempt(retainedAttempt);
      }
      const recovery = retained === undefined
        ? undefined
        : {
            interruptedAttempts: order.flatMap((role) =>
              (retained.interruptions[role] ?? []).map((interruption) => ({
                role,
                attemptId: interruption.attemptId,
                reason: interruption.reason,
              })),
            ),
          };

      if (retained?.outcome !== undefined) {
        blocks.push({
          blockId,
          taskId: task.id,
          taskVersion: task.version,
          trialIndex,
          order,
          outcome: retained.outcome,
          ...(retained.integrityFailures === undefined
            ? {}
            : { integrityFailures: retained.integrityFailures }),
          ...(recovery === undefined || recovery.interruptedAttempts.length === 0
            ? {}
            : { recovery }),
          journalAttempts: attemptEvidence,
          attempts,
        });
        continue;
      }

      for (const role of order) {
        if (attemptEvidence[role] !== undefined) continue;
        const attemptId = `${options.runId}:${task.id}:${trialIndex}:${role}`;
        await emit({
          type: 'attempt_started',
          blockId,
          attemptId,
          taskId: task.id,
          trialIndex,
          role,
        });
        attempts[role] = await runArmAttempt({
          options,
          arm: arms[role],
          taskIndex,
          trialIndex,
        });
        attemptEvidence[role] = toJournalSafeAttempt(attempts[role]);
        await emit({
          type: 'attempt_completed',
          blockId,
          role,
          attempt: attemptEvidence[role],
        });
      }
      const integrityFailures = blockIntegrityFailures(
        attempts.control,
        attempts.treatment,
      );
      if (
        retained !== undefined &&
        order.some((role) => (retained.interruptions[role]?.length ?? 0) > 0)
      ) {
        integrityFailures.push('interrupted_attempt');
      }
      const outcome =
        integrityFailures.length > 0
          ? 'invalid'
          : classifyBlock(attempts.control, attempts.treatment);
      if (
        outcome !== 'invalid' &&
        stableJson(attemptEvidence.control.agent) !==
          stableJson(attemptEvidence.treatment.agent)
      ) {
        throw new Error(
          `Agent configuration differs between paired arms for ${task.id} trial ${trialIndex}.`,
        );
      }
      const block: PairedAgentBenchmarkBlock = {
        blockId,
        taskId: task.id,
        taskVersion: task.version,
        trialIndex,
        order,
        outcome,
        ...(integrityFailures.length === 0 ? {} : { integrityFailures }),
        ...(recovery === undefined || recovery.interruptedAttempts.length === 0
          ? {}
          : { recovery }),
        journalAttempts: attemptEvidence,
        attempts,
      };
      blocks.push(block);
      await emit({
        type: 'block_completed',
        blockId,
        outcome,
        integrityFailures,
      });
    }
  }

  const valid = blocks.filter((block) => block.outcome !== 'invalid');
  const samples = valid.map((block): -1 | 0 | 1 => {
    if (block.outcome === 'treatment_win') return 1;
    if (block.outcome === 'control_win') return -1;
    return 0;
  });
  const report: PairedAgentBenchmarkReport = {
    schemaVersion: PAIRED_AGENT_BENCHMARK_SCHEMA_VERSION,
    runId: options.runId,
    protocolId: options.protocolId,
    protocolSha256: options.protocolSha256,
    protocolBinding: options.protocolBinding,
    phase: options.phase,
    ...(claimPolicy === undefined ? {} : { claimPolicy }),
    expectedTargetVersion: options.expectedTargetVersion,
    scheduleSeed: options.scheduleSeed,
    budgets: { ...options.budgets },
    arms: [arms.control, arms.treatment].map((arm) => ({
      role: arm.role,
      id: arm.id,
      label: arm.label,
      interfaceVersion: arm.interfaceVersion,
      ...(arm.expectedToolCatalogSha256 === undefined
        ? {}
        : { expectedToolCatalogSha256: arm.expectedToolCatalogSha256 }),
    })),
    summary: {
      tasks: options.tasks.length,
      trialsPerTask: options.trialsPerTask,
      scheduledBlocks: blocks.length,
      validBlocks: valid.length,
      invalidBlocks: blocks.length - valid.length,
      treatmentWins: blocks.filter((block) => block.outcome === 'treatment_win').length,
      controlWins: blocks.filter((block) => block.outcome === 'control_win').length,
      bothPassed: blocks.filter((block) => block.outcome === 'both_passed').length,
      bothFailed: blocks.filter((block) => block.outcome === 'both_failed').length,
      pairedLift:
        options.intervalMethod === 'paired-hoeffding-bound'
          ? pairedHoeffdingLiftInterval(samples)
          : pairedLiftInterval(samples, {
              seed: options.bootstrapSeed,
              resamples: options.bootstrapResamples,
            }),
      arms: {
        control: summarizeArm(valid.map((block) => block.attempts.control)),
        treatment: summarizeArm(valid.map((block) => block.attempts.treatment)),
      },
      operationalArms: {
        control: summarizeArm(blocks.map((block) => block.attempts.control)),
        treatment: summarizeArm(blocks.map((block) => block.attempts.treatment)),
      },
    },
    blocks,
  };
  if (!options.resume?.complete) {
    await emit({
      type: 'run_completed',
      runId: options.runId,
      scheduledBlocks,
      completedBlocks: blocks.length,
      validBlocks: valid.length,
      invalidBlocks: blocks.length - valid.length,
    });
  }
  return report;
}
