import { createHash } from 'node:crypto';
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { stableJson } from '../environment.js';
import type { AgentTrialResult, DeterministicJudgeResult } from './contracts.js';
import type {
  AgentBenchmarkArmRole,
  JournalSafeAgentTrialResult,
  JournalSafeJudgeResult,
  PairedBenchmarkEventSink,
  PairedBenchmarkLifecycleEvent,
  PairedAgentBenchmarkBlock,
  PairedBlockOutcome,
} from './paired-contracts.js';

export const PAIRED_JOURNAL_SCHEMA_VERSION = '1.0.0' as const;
/** @deprecated Use PAIRED_JOURNAL_SCHEMA_VERSION. Retained for evidence/API compatibility. */
export const PAIRED_DEVELOPMENT_JOURNAL_SCHEMA_VERSION =
  PAIRED_JOURNAL_SCHEMA_VERSION;

const sha256Pattern = /^[a-f0-9]{64}$/;
const journalFilePattern = /^(\d{6})-([a-z_]+)\.json$/;
const publicInputKeyPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const journalEventTypes = new Set<PairedBenchmarkLifecycleEvent['type']>([
  'run_started',
  'block_started',
  'attempt_started',
  'attempt_interrupted',
  'attempt_completed',
  'block_completed',
  'run_completed',
]);

const digest = (value: unknown): string =>
  createHash('sha256').update(stableJson(value), 'utf8').digest('hex');

const safeTrace = (
  trace: AgentTrialResult['toolTrace'],
): JournalSafeAgentTrialResult['toolTrace'] =>
  trace?.map((entry) => ({
    index: entry.index,
    tool: entry.tool,
    inputKeys: entry.inputKeys
      .filter((key) => publicInputKeyPattern.test(key))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    ...(entry.actionKind === undefined ? {} : { actionKind: entry.actionKind }),
    outcome: entry.outcome,
    durationMs: entry.durationMs,
    ...(entry.result === undefined
      ? {}
      : {
          result: {
            isError: entry.result.isError,
            ...(entry.result.errorCode === undefined
              ? {}
              : { errorCode: entry.result.errorCode }),
          },
        }),
    ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
  }));

const safeJudge = (
  judge: DeterministicJudgeResult | undefined,
): JournalSafeJudgeResult | undefined =>
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
          descriptionSha256: digest(criterion.description),
          ...(criterion.evidence === undefined
            ? {}
            : { evidenceSha256: digest(criterion.evidence) }),
        })),
        ...(judge.evidence === undefined ? {} : { evidenceSha256: digest(judge.evidence) }),
        ...(judge.reason === undefined ? {} : { reasonSha256: digest(judge.reason) }),
      };

/**
 * Projects an internal attempt onto the only shape accepted by the crash
 * journal. Keep this allowlist separate from the internal report: adding a
 * private field to AgentTrialResult must never make it journal-visible.
 */
export function toJournalSafeAttempt(
  attempt: AgentTrialResult,
): JournalSafeAgentTrialResult {
  const policyViolations = attempt.tools.policyViolations;
  return {
    attemptId: attempt.attemptId,
    taskId: attempt.taskId,
    ...(attempt.taskVersion === undefined ? {} : { taskVersion: attempt.taskVersion }),
    trialIndex: attempt.trialIndex,
    outcome: attempt.outcome,
    ...(attempt.failureKind === undefined ? {} : { failureKind: attempt.failureKind }),
    targetId: attempt.targetId,
    targetVersion: attempt.targetVersion,
    agentStatus: attempt.agentStatus,
    ...(attempt.agentError === undefined
      ? {}
      : { agentErrorSha256: digest(attempt.agentError) }),
    ...(attempt.finalText === undefined ? {} : { finalTextSha256: digest(attempt.finalText) }),
    ...(attempt.submittedResult === undefined
      ? {}
      : { submittedResultSha256: digest(attempt.submittedResult) }),
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
      policyViolationCount: policyViolations?.length ?? 0,
      ...(policyViolations === undefined
        ? {}
        : { policyViolationsSha256: digest(policyViolations) }),
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
    ...(attempt.toolTrace === undefined ? {} : { toolTrace: safeTrace(attempt.toolTrace) }),
    ...(attempt.baseline === undefined ? {} : { baseline: safeJudge(attempt.baseline) }),
    ...(attempt.judge === undefined ? {} : { judge: safeJudge(attempt.judge) }),
    agent: {
      adapterId: attempt.agent.adapterId,
      framework: attempt.agent.framework,
      frameworkVersion: attempt.agent.frameworkVersion,
      model: attempt.agent.model,
      ...(attempt.agent.modelConfiguration === undefined
        ? {}
        : { modelConfigurationSha256: digest(attempt.agent.modelConfiguration) }),
      ...(attempt.agent.adapterConfiguration === undefined
        ? {}
        : { adapterConfigurationSha256: digest(attempt.agent.adapterConfiguration) }),
      ...(attempt.agent.systemPromptSha256 === undefined
        ? {}
        : { systemPromptSha256: attempt.agent.systemPromptSha256 }),
    },
  };
}

const boundedText = z.string().min(1).max(1_000);
const nonNegativeInteger = z.number().int().nonnegative();
const finiteNumber = z.number().finite();
const digestSchema = z.string().regex(sha256Pattern);
const roleSchema = z.enum(['control', 'treatment']);
const outcomeSchema = z.enum(['passed', 'failed', 'invalid']);
const blockOutcomeSchema = z.enum([
  'treatment_win',
  'control_win',
  'both_passed',
  'both_failed',
  'invalid',
]);

const safeJudgeSchema = z
  .object({
    outcome: outcomeSchema,
    oracleVersion: boundedText,
    stateFingerprint: boundedText,
    criteria: z.array(
      z
        .object({
          id: boundedText,
          required: z.boolean(),
          passed: z.boolean(),
          descriptionSha256: digestSchema,
          evidenceSha256: digestSchema.optional(),
        })
        .strict(),
    ),
    evidenceSha256: digestSchema.optional(),
    reasonSha256: digestSchema.optional(),
  })
  .strict();

const traceSchema = z
  .object({
    index: nonNegativeInteger,
    tool: boundedText,
    inputKeys: z.array(z.string().max(256)),
    actionKind: z.string().max(256).optional(),
    outcome: z.enum(['returned', 'threw', 'budget_exceeded']),
    durationMs: nonNegativeInteger,
    result: z
      .object({
        isError: z.boolean(),
        errorCode: z.string().max(256).optional(),
      })
      .strict()
      .optional(),
    errorCode: z.string().max(256).optional(),
  })
  .strict();

const safeAttemptSchema = z
  .object({
    attemptId: boundedText,
    taskId: boundedText,
    taskVersion: boundedText.optional(),
    trialIndex: nonNegativeInteger,
    outcome: outcomeSchema,
    failureKind: z.string().max(256).optional(),
    targetId: boundedText,
    targetVersion: boundedText,
    agentStatus: z.enum(['not_started', 'completed', 'timed_out', 'errored']),
    agentErrorSha256: digestSchema.optional(),
    finalTextSha256: digestSchema.optional(),
    submittedResultSha256: digestSchema.optional(),
    submissionAttempts: nonNegativeInteger,
    modelTurns: nonNegativeInteger,
    usage: z.record(z.string().max(256), finiteNumber).optional(),
    durationMs: nonNegativeInteger,
    agentRunDurationMs: nonNegativeInteger.optional(),
    tools: z
      .object({
        calls: nonNegativeInteger,
        errors: nonNegativeInteger,
        byTool: z.record(z.string().max(256), nonNegativeInteger),
        budgetExceeded: z.boolean(),
        adapterRejectedCalls: nonNegativeInteger.optional(),
        adapterRejectionsByCode: z
          .object({
            input_schema_invalid: nonNegativeInteger.optional(),
            unknown_tool: nonNegativeInteger.optional(),
          })
          .strict()
          .optional(),
        policyViolationCount: nonNegativeInteger,
        policyViolationsSha256: digestSchema.optional(),
        toolCatalogSha256: digestSchema.optional(),
        toolCatalogToolCount: nonNegativeInteger.optional(),
        responseBytes: nonNegativeInteger.optional(),
        screenshots: nonNegativeInteger.optional(),
        dispatchedBrowserActions: nonNegativeInteger.optional(),
      })
      .strict(),
    toolTrace: z.array(traceSchema).optional(),
    baseline: safeJudgeSchema.optional(),
    judge: safeJudgeSchema.optional(),
    agent: z
      .object({
        adapterId: boundedText,
        framework: boundedText,
        frameworkVersion: boundedText,
        model: boundedText,
        modelConfigurationSha256: digestSchema.optional(),
        adapterConfigurationSha256: digestSchema.optional(),
        systemPromptSha256: digestSchema.optional(),
      })
      .strict(),
  })
  .strict();

const integrityFailureSchema = z.enum([
  'baseline_state_fingerprint_mismatch',
  'baseline_oracle_version_mismatch',
  'target_version_mismatch',
  'task_version_mismatch',
  'interrupted_attempt',
]);

const lifecycleEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('run_started'),
      runId: boundedText,
      protocolId: boundedText,
      protocolSha256: digestSchema,
      phase: z.enum(['development', 'sealed']),
      protocolBinding: z.enum(['development', 'frozen_verified']).optional(),
      scheduledBlocks: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('block_started'),
      blockId: boundedText,
      taskId: boundedText,
      taskVersion: boundedText.optional(),
      trialIndex: nonNegativeInteger,
      order: z.tuple([roleSchema, roleSchema]),
    })
    .strict(),
  z
    .object({
      type: z.literal('attempt_started'),
      blockId: boundedText,
      attemptId: boundedText,
      taskId: boundedText,
      trialIndex: nonNegativeInteger,
      role: roleSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('attempt_completed'),
      blockId: boundedText,
      role: roleSchema,
      attempt: safeAttemptSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('attempt_interrupted'),
      blockId: boundedText,
      attemptId: boundedText,
      taskId: boundedText,
      trialIndex: nonNegativeInteger,
      role: roleSchema,
      reason: z.literal('process_restart'),
    })
    .strict(),
  z
    .object({
      type: z.literal('block_completed'),
      blockId: boundedText,
      outcome: blockOutcomeSchema,
      integrityFailures: z.array(integrityFailureSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal('run_completed'),
      runId: boundedText,
      scheduledBlocks: z.number().int().positive(),
      completedBlocks: nonNegativeInteger,
      validBlocks: nonNegativeInteger,
      invalidBlocks: nonNegativeInteger,
    })
    .strict(),
]);

const journalEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(PAIRED_JOURNAL_SCHEMA_VERSION),
    sequence: nonNegativeInteger,
    recordedAt: z.string().datetime({ offset: true }),
    previousEventSha256: digestSchema.nullable(),
    event: lifecycleEventSchema,
    eventSha256: digestSchema,
  })
  .strict();

export interface PairedJournalEnvelope {
  schemaVersion: typeof PAIRED_JOURNAL_SCHEMA_VERSION;
  sequence: number;
  recordedAt: string;
  previousEventSha256: string | null;
  event: PairedBenchmarkLifecycleEvent;
  eventSha256: string;
}

/** @deprecated Use PairedJournalEnvelope. */
export type PairedDevelopmentJournalEnvelope = PairedJournalEnvelope;

export interface ReconstructedPairedBlock {
  blockId: string;
  taskId: string;
  taskVersion?: string | undefined;
  trialIndex: number;
  order: readonly [AgentBenchmarkArmRole, AgentBenchmarkArmRole];
  attempts: Partial<Record<AgentBenchmarkArmRole, JournalSafeAgentTrialResult>>;
  activeAttempts: Partial<
    Record<
      AgentBenchmarkArmRole,
      Extract<PairedBenchmarkLifecycleEvent, { type: 'attempt_started' }>
    >
  >;
  interruptions: Partial<
    Record<
      AgentBenchmarkArmRole,
      Array<Extract<PairedBenchmarkLifecycleEvent, { type: 'attempt_interrupted' }>>
    >
  >;
  outcome?: PairedBlockOutcome | undefined;
  integrityFailures?: PairedAgentBenchmarkBlock['integrityFailures'] | undefined;
}

/** @deprecated Use ReconstructedPairedBlock. */
export type ReconstructedDevelopmentBlock = ReconstructedPairedBlock;

export interface ReconstructedPairedRun {
  run: Extract<PairedBenchmarkLifecycleEvent, { type: 'run_started' }>;
  blocks: ReconstructedPairedBlock[];
  complete: boolean;
  completed?: Extract<PairedBenchmarkLifecycleEvent, { type: 'run_completed' }> | undefined;
  events: readonly PairedJournalEnvelope[];
}

/** @deprecated Use ReconstructedPairedRun. */
export type ReconstructedDevelopmentRun = ReconstructedPairedRun;

const expectedBlockOutcome = (
  attempts: Record<AgentBenchmarkArmRole, JournalSafeAgentTrialResult>,
  integrityFailures: readonly string[],
): PairedBlockOutcome => {
  if (
    integrityFailures.length > 0 ||
    attempts.control.outcome === 'invalid' ||
    attempts.treatment.outcome === 'invalid'
  ) {
    return 'invalid';
  }
  if (attempts.control.outcome === 'passed' && attempts.treatment.outcome === 'passed') {
    return 'both_passed';
  }
  if (attempts.control.outcome === 'failed' && attempts.treatment.outcome === 'failed') {
    return 'both_failed';
  }
  return attempts.treatment.outcome === 'passed' ? 'treatment_win' : 'control_win';
};

export function reconstructPairedRun(
  envelopes: readonly PairedJournalEnvelope[],
): ReconstructedPairedRun {
  if (envelopes.length === 0 || envelopes[0]!.event.type !== 'run_started') {
    throw new Error('Paired journal must begin with run_started.');
  }
  const run = envelopes[0]!.event;
  if (
    (run.phase === 'sealed' && run.protocolBinding !== 'frozen_verified') ||
    (run.phase === 'development' &&
      run.protocolBinding !== undefined &&
      run.protocolBinding !== 'development')
  ) {
    throw new Error('Paired journal protocol binding does not match its run phase.');
  }
  const blocks = new Map<string, ReconstructedPairedBlock>();
  let currentBlock: ReconstructedPairedBlock | undefined;
  let completed: Extract<PairedBenchmarkLifecycleEvent, { type: 'run_completed' }> | undefined;

  for (let index = 1; index < envelopes.length; index += 1) {
    const event = envelopes[index]!.event;
    if (completed !== undefined) throw new Error('Paired journal has events after run_completed.');
    if (event.type === 'run_started') throw new Error('Paired journal contains duplicate run_started.');
    if (event.type === 'block_started') {
      if (currentBlock !== undefined && currentBlock.outcome === undefined) {
        throw new Error(`Block ${currentBlock.blockId} is incomplete before the next block.`);
      }
      if (blocks.has(event.blockId)) throw new Error(`Duplicate block_started for ${event.blockId}.`);
      if (event.order[0] === event.order[1]) throw new Error(`Block ${event.blockId} repeats one arm.`);
      currentBlock = {
        blockId: event.blockId,
        taskId: event.taskId,
        ...(event.taskVersion === undefined ? {} : { taskVersion: event.taskVersion }),
        trialIndex: event.trialIndex,
        order: event.order,
        attempts: {},
        activeAttempts: {},
        interruptions: {},
      };
      blocks.set(event.blockId, currentBlock);
      continue;
    }
    if (event.type === 'attempt_started') {
      const block = blocks.get(event.blockId);
      if (block === undefined || block.outcome !== undefined) {
        throw new Error(`attempt_started references unavailable block ${event.blockId}.`);
      }
      if (event.taskId !== block.taskId || event.trialIndex !== block.trialIndex) {
        throw new Error(`attempt_started does not match block ${event.blockId}.`);
      }
      if (
        block.activeAttempts[event.role] !== undefined ||
        block.attempts[event.role] !== undefined
      ) {
        throw new Error(`Duplicate attempt_started for ${event.blockId}/${event.role}.`);
      }
      if (Object.keys(block.activeAttempts).length !== 0) {
        throw new Error(`Block ${event.blockId} has more than one active attempt.`);
      }
      const completedCount = Object.keys(block.attempts).length;
      if (block.order[completedCount] !== event.role) {
        throw new Error(`Attempt order drift for ${event.blockId}/${event.role}.`);
      }
      block.activeAttempts[event.role] = event;
      continue;
    }
    if (event.type === 'attempt_interrupted') {
      const block = blocks.get(event.blockId);
      const started = block?.activeAttempts[event.role];
      if (block === undefined || started === undefined || block.outcome !== undefined) {
        throw new Error(`attempt_interrupted lacks a start for ${event.blockId}/${event.role}.`);
      }
      if (
        event.attemptId !== started.attemptId ||
        event.taskId !== block.taskId ||
        event.trialIndex !== block.trialIndex
      ) {
        throw new Error(`attempt_interrupted does not match ${event.blockId}/${event.role}.`);
      }
      delete block.activeAttempts[event.role];
      (block.interruptions[event.role] ??= []).push(event);
      continue;
    }
    if (event.type === 'attempt_completed') {
      const block = blocks.get(event.blockId);
      const started = block?.activeAttempts[event.role];
      if (block === undefined || started === undefined || block.outcome !== undefined) {
        throw new Error(`attempt_completed lacks a start for ${event.blockId}/${event.role}.`);
      }
      if (block.attempts[event.role] !== undefined) {
        throw new Error(`Duplicate attempt_completed for ${event.blockId}/${event.role}.`);
      }
      if (
        event.attempt.attemptId !== started.attemptId ||
        event.attempt.taskId !== block.taskId ||
        event.attempt.trialIndex !== block.trialIndex
      ) {
        throw new Error(`attempt_completed does not match ${event.blockId}/${event.role}.`);
      }
      block.attempts[event.role] = event.attempt;
      delete block.activeAttempts[event.role];
      continue;
    }
    if (event.type === 'block_completed') {
      const block = blocks.get(event.blockId);
      if (
        block === undefined ||
        block.outcome !== undefined ||
        block.attempts.control === undefined ||
        block.attempts.treatment === undefined
      ) {
        throw new Error(`block_completed lacks two completed attempts for ${event.blockId}.`);
      }
      const attempts = block.attempts as Record<
        AgentBenchmarkArmRole,
        JournalSafeAgentTrialResult
      >;
      const expected = expectedBlockOutcome(attempts, event.integrityFailures);
      if (event.outcome !== expected) {
        throw new Error(`Block outcome drift for ${event.blockId}: expected ${expected}.`);
      }
      block.outcome = event.outcome;
      if (event.integrityFailures.length > 0) {
        block.integrityFailures = [...event.integrityFailures];
      }
      currentBlock = block;
      continue;
    }
    if (event.type === 'run_completed') {
      if (event.runId !== run.runId || event.scheduledBlocks !== run.scheduledBlocks) {
        throw new Error('run_completed does not match run_started.');
      }
      const retainedBlocks = [...blocks.values()];
      if (
        retainedBlocks.length !== run.scheduledBlocks ||
        retainedBlocks.some((block) => block.outcome === undefined)
      ) {
        throw new Error('run_completed was recorded before the full schedule completed.');
      }
      const valid = retainedBlocks.filter((block) => block.outcome !== 'invalid').length;
      if (
        event.completedBlocks !== retainedBlocks.length ||
        event.validBlocks !== valid ||
        event.invalidBlocks !== retainedBlocks.length - valid
      ) {
        throw new Error('run_completed counts do not match retained blocks.');
      }
      completed = event;
    }
  }

  return {
    run,
    blocks: [...blocks.values()],
    complete: completed !== undefined,
    ...(completed === undefined ? {} : { completed }),
    events: envelopes,
  };
}

/**
 * Parses the canonical public NDJSON projection of a paired journal. This is
 * the evidence-verification counterpart to readPairedJournal: it validates the
 * strict envelope/event schemas, hash chain, and full lifecycle state machine.
 */
export function parsePairedJournalNdjson(source: string): ReconstructedPairedRun {
  if (!source.endsWith('\n')) {
    throw new Error('Paired journal NDJSON is not canonical.');
  }
  const lines = source.slice(0, -1).split('\n');
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw new Error('Paired journal NDJSON is empty or malformed.');
  }

  const envelopes: PairedJournalEnvelope[] = [];
  let previousEventSha256: string | null = null;
  for (let sequence = 0; sequence < lines.length; sequence += 1) {
    const line = lines[sequence]!;
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(
        `Paired journal NDJSON event ${sequence} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (stableJson(raw) !== line) {
      throw new Error(`Paired journal NDJSON event ${sequence} is not canonical.`);
    }

    const parsed = journalEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Paired journal NDJSON event ${sequence} is invalid: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    const envelope = parsed.data as PairedJournalEnvelope;
    if (envelope.sequence !== sequence) {
      throw new Error(`Paired journal NDJSON sequence mismatch at event ${sequence}.`);
    }
    if (envelope.previousEventSha256 !== previousEventSha256) {
      throw new Error(`Paired journal NDJSON hash chain mismatch at event ${sequence}.`);
    }
    const { eventSha256, ...unsigned } = envelope;
    const actual = createHash('sha256')
      .update(envelopeHashInput(unsigned), 'utf8')
      .digest('hex');
    if (eventSha256 !== actual) {
      throw new Error(`Paired journal NDJSON event digest mismatch at event ${sequence}.`);
    }
    envelopes.push(envelope);
    previousEventSha256 = eventSha256;
  }
  return reconstructPairedRun(envelopes);
}

/** @deprecated Use reconstructPairedRun. */
export const reconstructPairedDevelopmentRun = reconstructPairedRun;

const envelopeHashInput = (
  envelope: Omit<PairedJournalEnvelope, 'eventSha256'>,
): string => stableJson(envelope);

const fileName = (sequence: number, type: PairedBenchmarkLifecycleEvent['type']): string =>
  `${sequence.toString().padStart(6, '0')}-${type}.json`;

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface PairedJournalWriter {
  append: PairedBenchmarkEventSink;
}

/** @deprecated Use PairedJournalWriter. */
export type PairedDevelopmentJournalWriter = PairedJournalWriter;

class JournalWriter implements PairedJournalWriter {
  readonly #directory: string;
  #sequence: number;
  #previousEventSha256: string | null;
  #events: PairedJournalEnvelope[];
  #tail: Promise<void> = Promise.resolve();
  #failure: unknown;

  constructor(
    directory: string,
    events: readonly PairedJournalEnvelope[] = [],
  ) {
    this.#directory = directory;
    this.#events = [...events];
    this.#sequence = events.length;
    this.#previousEventSha256 = events.at(-1)?.eventSha256 ?? null;
  }

  readonly append: PairedBenchmarkEventSink = (event) => {
    const operation = this.#tail.then(async () => {
      if (this.#failure !== undefined) throw this.#failure;
      try {
        const parsedEvent = lifecycleEventSchema.parse(event) as PairedBenchmarkLifecycleEvent;
        const recordedAt = new Date().toISOString();
        const unsigned = {
          schemaVersion: PAIRED_JOURNAL_SCHEMA_VERSION,
          sequence: this.#sequence,
          recordedAt,
          previousEventSha256: this.#previousEventSha256,
          event: parsedEvent,
        } as const;
        const eventSha256 = createHash('sha256')
          .update(envelopeHashInput(unsigned), 'utf8')
          .digest('hex');
        const envelope: PairedJournalEnvelope = { ...unsigned, eventSha256 };
        reconstructPairedRun([...this.#events, envelope]);

        const staging = await mkdtemp(join(this.#directory, '.stage-'));
        const staged = join(staging, 'event.json');
        const destination = join(this.#directory, fileName(this.#sequence, parsedEvent.type));
        try {
          const handle = await open(staged, 'wx');
          try {
            await handle.writeFile(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
            await handle.sync();
          } finally {
            await handle.close();
          }
          await link(staged, destination);
          await syncDirectory(this.#directory);
        } finally {
          await rm(staging, { recursive: true, force: true }).catch(() => {});
        }
        this.#events.push(envelope);
        this.#sequence += 1;
        this.#previousEventSha256 = eventSha256;
      } catch (error) {
        this.#failure = error;
        throw error;
      }
    });
    this.#tail = operation.catch(() => {});
    return operation;
  };
}

export async function createPairedJournal(
  directory: string,
): Promise<PairedJournalWriter> {
  try {
    await mkdir(directory);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Paired journal is create-only and could not be created: ${message}`);
  }
  await syncDirectory(directory);
  return new JournalWriter(directory);
}

/** @deprecated Use createPairedJournal. */
export const createPairedDevelopmentJournal = createPairedJournal;

export async function readPairedJournal(
  directory: string,
): Promise<ReconstructedPairedRun> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.stage-')) continue;
    if (!entry.isFile() || !journalFilePattern.test(entry.name)) {
      throw new Error(`Unexpected paired journal entry: ${entry.name}`);
    }
    names.push(entry.name);
  }
  names.sort();
  const envelopes: PairedJournalEnvelope[] = [];
  let previousEventSha256: string | null = null;
  for (let sequence = 0; sequence < names.length; sequence += 1) {
    const name = names[sequence]!;
    const match = journalFilePattern.exec(name)!;
    const fileSequence = Number(match[1]);
    const fileType = match[2];
    if (fileSequence !== sequence) {
      throw new Error(`Paired journal sequence gap at ${name}.`);
    }
    if (!journalEventTypes.has(fileType as PairedBenchmarkLifecycleEvent['type'])) {
      throw new Error(`Unknown paired journal event type in ${name}.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(directory, name), 'utf8')) as unknown;
    } catch (error) {
      throw new Error(
        `Paired journal event ${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const envelope = journalEnvelopeSchema.parse(parsed) as PairedJournalEnvelope;
    if (envelope.sequence !== sequence || envelope.event.type !== fileType) {
      throw new Error(`Paired journal filename does not match envelope ${name}.`);
    }
    if (envelope.previousEventSha256 !== previousEventSha256) {
      throw new Error(`Paired journal hash chain mismatch at ${name}.`);
    }
    const { eventSha256, ...unsigned } = envelope;
    const actual = createHash('sha256')
      .update(envelopeHashInput(unsigned), 'utf8')
      .digest('hex');
    if (eventSha256 !== actual) {
      throw new Error(`Paired journal event digest mismatch at ${name}.`);
    }
    envelopes.push(envelope);
    previousEventSha256 = eventSha256;
  }
  return reconstructPairedRun(envelopes);
}

/** @deprecated Use readPairedJournal. */
export const readPairedDevelopmentJournal = readPairedJournal;

export interface ResumedPairedJournal {
  journal: PairedJournalWriter;
  state: ReconstructedPairedRun;
}

/** @deprecated Use ResumedPairedJournal. */
export type ResumedPairedDevelopmentJournal = ResumedPairedJournal;

/**
 * Reopens a validated journal at its hash-chain tail. Any attempt whose start
 * was durable but whose completion was not is closed explicitly before work
 * may continue; the paired runner then excludes that recovered block from the
 * uplift denominator.
 */
export async function resumePairedJournal(
  directory: string,
): Promise<ResumedPairedJournal> {
  let state = await readPairedJournal(directory);
  const journal = new JournalWriter(directory, state.events);
  if (state.complete) return { journal, state };

  for (const block of state.blocks) {
    for (const role of block.order) {
      const active = block.activeAttempts[role];
      if (active === undefined) continue;
      await journal.append({
        type: 'attempt_interrupted',
        blockId: block.blockId,
        attemptId: active.attemptId,
        taskId: block.taskId,
        trialIndex: block.trialIndex,
        role,
        reason: 'process_restart',
      });
    }
  }
  state = await readPairedJournal(directory);
  return { journal, state };
}

/** @deprecated Use resumePairedJournal. */
export const resumePairedDevelopmentJournal = resumePairedJournal;
