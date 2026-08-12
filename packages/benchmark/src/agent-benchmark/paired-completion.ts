import { createHash } from 'node:crypto';
import { link, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { stableJson } from '../environment.js';
import type { AgentToolDescriptor, AgentToolTraceEntry } from './contracts.js';
import {
  parseEvidenceDropProtocol,
  type EvidenceDropProtocol,
} from './evidence-drop-protocol.js';
import { modelFacingToolCatalogSha256 } from './evidence-drop-runner.js';
import {
  createPairedExecutionIntegrityBinding,
  parsePairedExecutionModelMetadata,
  parsePairedExecutionEnvironment,
  renderPairedExecutionEnvironment,
  renderPairedExecutionModelMetadata,
  type PairedExecutionEnvironment,
} from './paired-environment.js';
import type {
  AgentBenchmarkArmRole,
  JournalSafeAgentTrialResult,
  PairedAgentBenchmarkReport,
} from './paired-contracts.js';
import {
  parsePairedJournalNdjson,
  type ReconstructedPairedRun,
} from './paired-journal.js';
import {
  assertPairedRuntimeProvenanceStable,
  parsePairedRuntimeProvenance,
  renderPairedRuntimeProvenance,
  type PairedRuntimeProvenance,
} from './paired-runtime-provenance.js';
import { pairedArmOrder } from './paired-runner.js';
import { renderPairedAgentBenchmarkMarkdown } from './paired-report.js';
import { deterministicModelSeed } from './paired-model-seed.js';
import { pairedHoeffdingLiftInterval } from './paired-statistics.js';
import {
  assertSealedBuildProvenanceStable,
  assertSealedGitSourceStable,
  parseSealedBuildProvenance,
  renderSealedBuildProvenance,
  type SealedBuildProvenance,
  type SealedGitSourceSnapshot,
} from './sealed-execution-provenance.js';
import { wilsonInterval } from './statistics.js';

export const PAIRED_AGENT_BENCHMARK_COMPLETION_SCHEMA_VERSION = '1.0.0' as const;
export const PAIRED_AGENT_BENCHMARK_COMPLETION_FILE = 'COMPLETE.json' as const;

const sha256Pattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const checksumLinePattern = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const requiredArtifacts = new Set([
  'attempts.ndjson',
  'comparison.json',
  'control-tool-catalog.json',
  'environment-end.json',
  'environment-start.json',
  'execution-start.json',
  'execution.json',
  'journal.ndjson',
  'protocol.json',
  'summary.md',
  'system-prompt.txt',
  'treatment-tool-catalog.json',
]);
const sealedRequiredArtifacts = new Set([
  'build-provenance-end.json',
  'build-provenance-start.json',
  'model-metadata-end.json',
  'model-metadata-start.json',
  'runtime-provenance-end.json',
  'runtime-provenance-start.json',
]);

const completionIdentitySchema = z
  .object({
    runId: z.string().regex(identifierPattern),
    protocolId: z.string().regex(identifierPattern),
    protocolSha256: z.string().regex(sha256Pattern),
    journalFinalEventSha256: z.string().regex(sha256Pattern),
  })
  .strict();

const markerSchema = z
  .object({
    schemaVersion: z.literal(PAIRED_AGENT_BENCHMARK_COMPLETION_SCHEMA_VERSION),
    state: z.literal('complete'),
    ...completionIdentitySchema.shape,
    artifactManifestSha256: z.string().regex(sha256Pattern),
  })
  .strict();

const sourceSnapshotSchema = z
  .object({
    revision: z.string().nullable(),
    tree: z.string().nullable(),
    clean: z.boolean(),
    freezeRef: z.string().min(1).max(256).optional(),
  })
  .strict();

const toolDescriptorSchema = z
  .object({
    name: z.string(),
    title: z.string().optional(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();

const toolCatalogBindingsSchema = z
  .object({
    control: z
      .object({
        sha256: z.string().regex(sha256Pattern),
        toolCount: z.number().int().nonnegative(),
      })
      .strict(),
    treatment: z
      .object({
        sha256: z.string().regex(sha256Pattern),
        toolCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

const buildProvenanceBindingSchema = z
  .object({
    startSha256: z.string().regex(sha256Pattern),
    endSha256: z.string().regex(sha256Pattern),
  })
  .strict();

const runtimeProvenanceBindingSchema = z
  .object({
    startSha256: z.string().regex(sha256Pattern),
    endSha256: z.string().regex(sha256Pattern),
  })
  .strict();

const runtimeProvenanceStartBindingSchema = z
  .object({ startSha256: z.string().regex(sha256Pattern) })
  .strict();

const modelMetadataBindingSchema = z
  .object({
    startSha256: z.string().regex(sha256Pattern),
    endSha256: z.string().regex(sha256Pattern),
  })
  .strict();

export type PairedAgentBenchmarkCompletionMarker = z.output<typeof markerSchema>;

export interface CreatePairedAgentBenchmarkCompletionMarkerInput {
  runId: string;
  protocolId: string;
  protocolSha256: string;
  journalFinalEventSha256: string;
}

const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

const errorCode = (error: unknown): unknown =>
  typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;

export function parsePairedAgentBenchmarkCompletionMarker(
  input: unknown,
): PairedAgentBenchmarkCompletionMarker {
  const parsed = markerSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `Invalid paired benchmark completion marker: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

export function renderPairedAgentBenchmarkCompletionMarker(input: unknown): string {
  const marker = parsePairedAgentBenchmarkCompletionMarker(input);
  return `${JSON.stringify(marker, null, 2)}\n`;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const jsonRecord = (content: Buffer, name: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString('utf8')) as unknown;
  } catch {
    throw new Error(`Paired benchmark artifact ${name} is not valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Paired benchmark artifact ${name} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
};

const recordValue = (
  input: unknown,
  name: string,
): Record<string, unknown> => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`Paired benchmark ${name} must be a JSON object.`);
  }
  return input as Record<string, unknown>;
};

const arrayValue = (input: unknown, name: string): unknown[] => {
  if (!Array.isArray(input)) {
    throw new Error(`Paired benchmark ${name} must be a JSON array.`);
  }
  return input;
};

const exactBinding = (actual: unknown, expected: unknown, name: string): void => {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`Paired benchmark ${name} differs from its frozen protocol or journal.`);
  }
};

const fields = (
  input: Record<string, unknown>,
  names: readonly string[],
): Record<string, unknown> =>
  Object.fromEntries(names.map((name) => [name, input[name]]));

const publicInputKeyPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const publicActionKindPattern = /^[a-z][a-z0-9_]{0,63}$/;
const publicErrorCodePattern =
  /^(?:[a-z][a-z0-9_]{0,63}|[A-Z][A-Z0-9_]{0,63}|-32[0-9]{3})$/;

const publicDiagnostic = (value: unknown, pattern: RegExp): string | undefined =>
  typeof value === 'string' && pattern.test(value) ? value : undefined;

const publicTrace = (trace: readonly AgentToolTraceEntry[]): AgentToolTraceEntry[] =>
  trace.map((entry) => {
    const inputKeys = entry.inputKeys
      .filter((key) => publicInputKeyPattern.test(key))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
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
  tools: { ...attempt.tools, byTool: { ...attempt.tools.byTool } },
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

const canonicalEnvironment = (
  content: Buffer,
  name: string,
): PairedExecutionEnvironment => {
  const source = content.toString('utf8');
  const parsed = parsePairedExecutionEnvironment(jsonRecord(content, name));
  if (renderPairedExecutionEnvironment(parsed) !== source) {
    throw new Error(`Paired benchmark artifact ${name} is not canonical.`);
  }
  return parsed;
};

const canonicalModelMetadata = (content: Buffer, name: string): string => {
  const source = content.toString('utf8');
  const parsed = parsePairedExecutionModelMetadata(jsonRecord(content, name));
  if (renderPairedExecutionModelMetadata(parsed) !== source) {
    throw new Error(`Paired benchmark artifact ${name} is not canonical.`);
  }
  return source;
};

const canonicalBuildProvenance = (
  content: Buffer,
  name: string,
): SealedBuildProvenance => {
  const source = content.toString('utf8');
  const parsed = parseSealedBuildProvenance(jsonRecord(content, name));
  if (renderSealedBuildProvenance(parsed) !== source) {
    throw new Error(`Paired benchmark artifact ${name} is not canonical.`);
  }
  return parsed;
};

const canonicalRuntimeProvenance = (
  content: Buffer,
  name: string,
): PairedRuntimeProvenance => {
  const source = content.toString('utf8');
  const parsed = parsePairedRuntimeProvenance(jsonRecord(content, name));
  if (renderPairedRuntimeProvenance(parsed) !== source) {
    throw new Error(`Paired benchmark artifact ${name} is not canonical.`);
  }
  return parsed;
};

const sourceSnapshot = (input: unknown, name: string): SealedGitSourceSnapshot & {
  freezeRef?: string | undefined;
} => {
  const parsed = sourceSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `Paired benchmark ${name} source is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
};

const toolCatalog = (content: Buffer, name: string): AgentToolDescriptor[] => {
  let raw: unknown;
  try {
    raw = JSON.parse(content.toString('utf8')) as unknown;
  } catch {
    throw new Error(`Paired benchmark artifact ${name} is not valid JSON.`);
  }
  const parsed = z.array(toolDescriptorSchema).safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Paired benchmark artifact ${name} is not a valid tool catalog: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
};

const toolCatalogBindings = (
  input: unknown,
  name: string,
): z.output<typeof toolCatalogBindingsSchema> => {
  const parsed = toolCatalogBindingsSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Paired benchmark ${name} tool catalogs are invalid.`);
  }
  return parsed.data;
};

const matchingIdentity = (
  artifact: Record<string, unknown>,
  name: string,
  identity: CreatePairedAgentBenchmarkCompletionMarkerInput,
): void => {
  for (const key of ['runId', 'protocolId', 'protocolSha256'] as const) {
    if (artifact[key] !== identity[key]) {
      throw new Error(`Paired benchmark artifact ${name} has mismatched ${key}.`);
    }
  }
};

function verifiedJournal(
  source: Buffer,
  identity: CreatePairedAgentBenchmarkCompletionMarkerInput,
): ReconstructedPairedRun {
  const retained = parsePairedJournalNdjson(source.toString('utf8'));
  if (!retained.complete) {
    throw new Error('Paired benchmark journal does not retain a completed schedule.');
  }
  if (
    retained.run.runId !== identity.runId ||
    retained.run.protocolId !== identity.protocolId ||
    retained.run.protocolSha256 !== identity.protocolSha256
  ) {
    throw new Error('Paired benchmark journal run_started identity is invalid.');
  }
  if (retained.events.at(-1)?.eventSha256 !== identity.journalFinalEventSha256) {
    throw new Error('Paired benchmark journal final event digest differs from its marker.');
  }
  return retained;
}

const completedAttempts = (
  block: ReconstructedPairedRun['blocks'][number],
): { control: JournalSafeAgentTrialResult; treatment: JournalSafeAgentTrialResult } => {
  if (block.attempts.control === undefined || block.attempts.treatment === undefined) {
    throw new Error(`Paired benchmark journal block ${block.blockId} lacks two attempts.`);
  }
  return {
    control: block.attempts.control,
    treatment: block.attempts.treatment,
  };
};

const expectedSealedAgent = (
  protocol: EvidenceDropProtocol,
  taskId: string,
  trialIndex: number,
): JournalSafeAgentTrialResult['agent'] => {
  if (
    protocol.phase !== 'sealed' ||
    protocol.agent.provider !== 'openrouter' ||
    protocol.schedule.modelSeedBase === undefined
  ) {
    throw new Error('Cannot derive sealed agent metadata from a non-OpenRouter protocol.');
  }
  const agent = protocol.agent;
  const seed = deterministicModelSeed(
    protocol.schedule.modelSeedBase,
    taskId,
    trialIndex,
  );
  const modelConfiguration = {
    provider: agent.provider,
    modelId: agent.modelId,
    temperature: agent.temperature,
    maxRetries: agent.maxRetries,
    useResponsesApi: false,
    imageMode: agent.imageMode,
    seed,
    frameworkVersion: agent.frameworkVersion,
    canonicalModelSlug: agent.canonicalModelSlug,
    modelMetadataSha256: agent.modelMetadataSha256,
    modelCapabilities: { ...agent.modelCapabilities },
    providerRoute: agent.providerRoute,
    reasoningEffort: agent.reasoningEffort,
    providerPolicy: { ...agent.providerPolicy },
    maxOutputTokens: agent.maxOutputTokens,
  };
  return {
    adapterId: 'shared-langchain-agent',
    framework: agent.framework,
    frameworkVersion: agent.frameworkVersion,
    model: agent.modelId,
    modelConfigurationSha256: sha256(stableJson(modelConfiguration)),
    adapterConfigurationSha256: sha256(
      stableJson({ imageMode: agent.imageMode }),
    ),
    systemPromptSha256: agent.systemPromptSha256,
  };
};

function verifyAttemptsNdjson(input: {
  source: Buffer;
  journal: ReconstructedPairedRun;
  comparison: Record<string, unknown>;
}): void {
  const source = input.source.toString('utf8');
  if (!source.endsWith('\n')) {
    throw new Error('Paired benchmark attempts.ndjson is not canonical.');
  }
  const lines = source.slice(0, -1).split('\n');
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw new Error('Paired benchmark attempts.ndjson is empty or malformed.');
  }
  const comparisonBlocks = arrayValue(
    input.comparison['blocks'],
    'comparison blocks',
  );
  const comparisonById = new Map(
    comparisonBlocks.map((candidate, index) => {
      const block = recordValue(candidate, `comparison block ${index}`);
      const blockId = block['blockId'];
      if (typeof blockId !== 'string' || blockId.length === 0) {
        throw new Error(`Paired benchmark comparison block ${index} has no blockId.`);
      }
      if (comparisonBlocks.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          recordValue(other, `comparison block ${otherIndex}`)['blockId'] === blockId,
      )) {
        throw new Error(`Paired benchmark comparison has duplicate blockId ${blockId}.`);
      }
      return [blockId, block] as const;
    }),
  );
  const orderedBlocks = [...input.journal.blocks].sort((left, right) =>
    left.taskId < right.taskId
      ? -1
      : left.taskId > right.taskId
        ? 1
        : left.trialIndex - right.trialIndex ||
          (left.blockId < right.blockId ? -1 : left.blockId > right.blockId ? 1 : 0),
  );
  const expected = orderedBlocks.flatMap((block) => {
    const attempts = completedAttempts(block);
    const comparisonBlock = comparisonById.get(block.blockId);
    if (comparisonBlock === undefined) {
      throw new Error(
        `Paired benchmark comparison is missing journal block ${block.blockId}.`,
      );
    }
    const comparisonAttempts = recordValue(
      comparisonBlock['attempts'],
      `comparison block ${block.blockId} attempts`,
    );
    return (['control', 'treatment'] as const).map((role) => {
      const attempt = publicJournalAttempt(attempts[role]);
      exactBinding(
        comparisonAttempts[role],
        attempt,
        `comparison block ${block.blockId} ${role} attempt journal projection`,
      );
      return {
        blockId: block.blockId,
        order: block.order,
        blockOutcome: block.outcome,
        role,
        attempt,
      };
    });
  });
  if (lines.length !== expected.length) {
    throw new Error(
      'Paired benchmark attempts.ndjson does not contain exactly two entries per journal block.',
    );
  }
  for (let index = 0; index < lines.length; index += 1) {
    let raw: unknown;
    try {
      raw = JSON.parse(lines[index]!) as unknown;
    } catch (error) {
      throw new Error(
        `Paired benchmark attempts.ndjson entry ${index} is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (stableJson(raw) !== lines[index]) {
      throw new Error(`Paired benchmark attempts.ndjson entry ${index} is not canonical.`);
    }
    exactBinding(
      raw,
      expected[index],
      `attempts.ndjson entry ${index} journal projection`,
    );
  }
}

const journalArmSummary = (
  attempts: readonly JournalSafeAgentTrialResult[],
): Record<string, unknown> => {
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

const failedFailureKinds = new Set([
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
const invalidFailureKinds = new Set([
  'target_setup_failed',
  'target_version_mismatch',
  'baseline_already_passes',
  'baseline_invalid',
  'tool_catalog_mismatch',
  'agent_setup_failed',
  'judge_invalid',
  'cleanup_failed',
]);

const preAgentInvalidFailureKinds = new Set([
  'target_setup_failed',
  'target_version_mismatch',
  'baseline_already_passes',
  'baseline_invalid',
  'tool_catalog_mismatch',
  'agent_setup_failed',
]);
const preCatalogInvalidFailureKinds = new Set([
  'target_setup_failed',
  'target_version_mismatch',
  'baseline_already_passes',
  'baseline_invalid',
]);
const notStartedAgent = {
  adapterId: 'not-started',
  framework: 'none',
  frameworkVersion: 'none',
  model: 'none',
} as const;

function verifyAttemptOutcomeEvidence(
  attempt: JournalSafeAgentTrialResult,
  role: AgentBenchmarkArmRole,
): void {
  if (attempt.outcome === 'invalid') {
    if (
      attempt.failureKind === undefined ||
      !invalidFailureKinds.has(attempt.failureKind)
    ) {
      throw new Error(`Paired benchmark ${role} invalid attempt has an invalid failure kind.`);
    }
    return;
  }
  if (attempt.baseline === undefined || attempt.baseline.outcome !== 'failed') {
    throw new Error(
      `Paired benchmark ${role} ${attempt.outcome} attempt requires a failed baseline.`,
    );
  }
  if (attempt.judge === undefined) {
    throw new Error(
      `Paired benchmark ${role} ${attempt.outcome} attempt requires a final judge.`,
    );
  }
  if (attempt.outcome === 'failed') {
    if (
      attempt.agentStatus === 'not_started' ||
      attempt.failureKind === undefined ||
      !failedFailureKinds.has(attempt.failureKind)
    ) {
      throw new Error(`Paired benchmark ${role} failed attempt has invalid outcome evidence.`);
    }
    return;
  }
  if (
    attempt.failureKind !== undefined ||
    attempt.agentStatus !== 'completed' ||
    attempt.judge.outcome !== 'passed' ||
    attempt.judge.criteria.length === 0 ||
    attempt.judge.criteria.some((criterion) => criterion.required && !criterion.passed) ||
    attempt.submissionAttempts !== 1 ||
    attempt.submittedResultSha256 === undefined
  ) {
    throw new Error(
      `Paired benchmark ${role} passed attempt lacks complete trusted outcome evidence.`,
    );
  }
}

function verifySealedAttemptStageBindings(input: {
  attempt: JournalSafeAgentTrialResult;
  role: AgentBenchmarkArmRole;
  expectedTargetVersion: string;
  expectedAgent: JournalSafeAgentTrialResult['agent'];
  expectedCatalog: { sha256: string; toolCount: number };
  blockIndex: number;
}): void {
  const {
    attempt,
    role,
    expectedTargetVersion,
    expectedAgent,
    expectedCatalog,
    blockIndex,
  } = input;
  const failureKind = attempt.failureKind;

  if (failureKind === 'target_setup_failed') {
    if (
      attempt.targetId !== 'unprovisioned' ||
      attempt.targetVersion !== 'unavailable' ||
      attempt.baseline !== undefined
    ) {
      throw new Error(
        `Paired benchmark journal ${role} target setup failure has invalid pre-target evidence.`,
      );
    }
  } else if (failureKind === 'target_version_mismatch') {
    if (
      attempt.targetVersion === expectedTargetVersion ||
      attempt.targetVersion === 'unavailable' ||
      attempt.targetId === 'unprovisioned' ||
      attempt.baseline !== undefined
    ) {
      throw new Error(
        `Paired benchmark journal ${role} target version mismatch lacks mismatched pre-baseline evidence.`,
      );
    }
  } else if (attempt.targetVersion !== expectedTargetVersion) {
    throw new Error(
      `Paired benchmark journal ${role} attempt differs from its frozen target.`,
    );
  }

  if (
    attempt.outcome === 'invalid' &&
    failureKind !== undefined &&
    preAgentInvalidFailureKinds.has(failureKind)
  ) {
    if (
      attempt.agentStatus !== 'not_started' ||
      attempt.submissionAttempts !== 0 ||
      attempt.modelTurns !== 0 ||
      attempt.usage !== undefined ||
      attempt.agentRunDurationMs !== undefined ||
      attempt.finalTextSha256 !== undefined ||
      attempt.submittedResultSha256 !== undefined ||
      attempt.judge !== undefined ||
      attempt.tools.calls !== 0 ||
      attempt.tools.errors !== 0 ||
      Object.keys(attempt.tools.byTool).length !== 0 ||
      attempt.tools.budgetExceeded ||
      attempt.tools.policyViolationCount !== 0 ||
      attempt.tools.policyViolationsSha256 !== undefined ||
      (attempt.toolTrace !== undefined && attempt.toolTrace.length !== 0)
    ) {
      throw new Error(
        `Paired benchmark journal ${role} pre-agent failure retains post-agent evidence.`,
      );
    }
    exactBinding(
      attempt.agent,
      notStartedAgent,
      `sealed journal block ${blockIndex} ${role} pre-agent placeholder`,
    );
  } else {
    exactBinding(
      attempt.agent,
      expectedAgent,
      `sealed journal block ${blockIndex} ${role} agent configuration`,
    );
  }

  if (
    attempt.outcome === 'invalid' &&
    failureKind !== undefined &&
    preCatalogInvalidFailureKinds.has(failureKind)
  ) {
    if (
      attempt.tools.toolCatalogSha256 !== undefined ||
      attempt.tools.toolCatalogToolCount !== undefined
    ) {
      throw new Error(
        `Paired benchmark journal ${role} pre-catalog failure unexpectedly retains a catalog binding.`,
      );
    }
  } else if (failureKind === 'tool_catalog_mismatch') {
    const hasDigest = attempt.tools.toolCatalogSha256 !== undefined;
    const hasCount = attempt.tools.toolCatalogToolCount !== undefined;
    if (
      hasDigest !== hasCount ||
      (attempt.tools.toolCatalogSha256 === expectedCatalog.sha256 &&
        attempt.tools.toolCatalogToolCount === expectedCatalog.toolCount)
    ) {
      throw new Error(
        `Paired benchmark journal ${role} catalog mismatch retains the exact frozen interface.`,
      );
    }
  } else if (
    attempt.tools.toolCatalogSha256 !== expectedCatalog.sha256 ||
    attempt.tools.toolCatalogToolCount !== expectedCatalog.toolCount
  ) {
    throw new Error(
      `Paired benchmark journal ${role} attempt catalog differs from its frozen interface.`,
    );
  }

  if (
    failureKind === 'baseline_already_passes' &&
    attempt.baseline?.outcome !== 'passed'
  ) {
    throw new Error(
      `Paired benchmark journal ${role} baseline-already-passes failure lacks a passed baseline.`,
    );
  }
  if (
    failureKind === 'baseline_invalid' &&
    attempt.baseline !== undefined &&
    attempt.baseline.outcome !== 'invalid'
  ) {
    throw new Error(
      `Paired benchmark journal ${role} baseline-invalid failure retains a non-invalid baseline.`,
    );
  }
  if (
    attempt.outcome === 'invalid' &&
    failureKind !== undefined &&
    !preCatalogInvalidFailureKinds.has(failureKind) &&
    failureKind !== 'baseline_already_passes' &&
    failureKind !== 'baseline_invalid' &&
    attempt.baseline?.outcome !== 'failed'
  ) {
    throw new Error(
      `Paired benchmark journal ${role} post-baseline failure lacks a failed baseline.`,
    );
  }
}

function verifySealedComparison(input: {
  protocol: EvidenceDropProtocol;
  comparison: Record<string, unknown>;
  journal: ReconstructedPairedRun;
  identity: CreatePairedAgentBenchmarkCompletionMarkerInput;
  toolCatalogs: z.output<typeof toolCatalogBindingsSchema>;
}): void {
  const { protocol, comparison, journal, identity, toolCatalogs } = input;
  if (protocol.phase !== 'sealed' || journal.run.phase !== 'sealed') {
    throw new Error('Paired benchmark sealed comparison phase differs from its protocol or journal.');
  }
  const expectedClaimPolicy = {
    decisionRule: protocol.analysis.decisionRule,
    publicationRule: protocol.analysis.publicationRule,
    estimand: protocol.analysis.estimand,
  };
  exactBinding(
    comparison['claimPolicy'],
    expectedClaimPolicy,
    'sealed comparison claim policy',
  );
  exactBinding(
    fields(comparison, [
      'schemaVersion',
      'runId',
      'protocolId',
      'protocolSha256',
      'protocolBinding',
      'phase',
      'expectedTargetVersion',
      'scheduleSeed',
      'budgets',
    ]),
    {
      schemaVersion: '1.0.0',
      runId: identity.runId,
      protocolId: protocol.protocolId,
      protocolSha256: identity.protocolSha256,
      protocolBinding: 'frozen_verified',
      phase: 'sealed',
      expectedTargetVersion: protocol.target.expectedVersion,
      scheduleSeed: protocol.schedule.orderSeed,
      budgets: protocol.budgets,
    },
    'sealed comparison target, schedule, and budget binding',
  );

  const expectedArms = (['control', 'treatment'] as const).map((role) => ({
    role,
    id: protocol.arms[role].id,
    label: protocol.arms[role].label,
    interfaceVersion: protocol.arms[role].interfaceVersion,
    expectedToolCatalogSha256: protocol.arms[role].expectedToolCatalogSha256,
  }));
  exactBinding(comparison['arms'], expectedArms, 'sealed comparison arm metadata');
  for (const role of ['control', 'treatment'] as const) {
    if (
      protocol.arms[role].expectedToolCatalogSha256 !== toolCatalogs[role].sha256
    ) {
      throw new Error(
        `Paired benchmark ${role} catalog differs from its frozen protocol arm.`,
      );
    }
  }

  const expectedBlocks = protocol.taskIds.length * protocol.trialsPerTask;
  if (
    journal.run.scheduledBlocks !== expectedBlocks ||
    journal.completed?.scheduledBlocks !== expectedBlocks ||
    journal.blocks.length !== expectedBlocks
  ) {
    throw new Error('Paired benchmark journal schedule differs from its frozen protocol.');
  }
  const comparisonBlocks = arrayValue(
    comparison['blocks'],
    'sealed comparison blocks',
  );
  if (comparisonBlocks.length !== expectedBlocks) {
    throw new Error('Paired benchmark comparison block count differs from its journal.');
  }

  let blockIndex = 0;
  for (let taskIndex = 0; taskIndex < protocol.taskIds.length; taskIndex += 1) {
    const taskId = protocol.taskIds[taskIndex]!;
    const taskContract = protocol.taskContracts[taskIndex]!;
    for (let trialIndex = 0; trialIndex < protocol.trialsPerTask; trialIndex += 1) {
      const block = journal.blocks[blockIndex]!;
      const expectedBlock = {
        blockId: `${identity.runId}:${taskId}:${trialIndex}`,
        taskId,
        taskVersion: taskContract.version,
        trialIndex,
        order: pairedArmOrder(protocol.schedule.orderSeed, taskId, trialIndex),
      };
      exactBinding(
        fields(block as unknown as Record<string, unknown>, [
          'blockId',
          'taskId',
          'taskVersion',
          'trialIndex',
          'order',
        ]),
        expectedBlock,
        `sealed journal block ${blockIndex} schedule`,
      );
      const attempts = completedAttempts(block);
      const expectedAgent = expectedSealedAgent(protocol, taskId, trialIndex);
      for (const role of ['control', 'treatment'] as const) {
        const attempt = attempts[role];
        if (
          attempt.attemptId !== `${block.blockId}:${role}` ||
          attempt.taskId !== taskId ||
          attempt.taskVersion !== taskContract.version ||
          attempt.trialIndex !== trialIndex
        ) {
          throw new Error(
            `Paired benchmark journal ${role} attempt differs from its frozen task.`,
          );
        }
        verifyAttemptOutcomeEvidence(attempt, role);
        verifySealedAttemptStageBindings({
          attempt,
          role,
          expectedTargetVersion: protocol.target.expectedVersion,
          expectedAgent,
          expectedCatalog: toolCatalogs[role],
          blockIndex,
        });
        for (const judge of [attempt.baseline, attempt.judge]) {
          if (judge !== undefined && judge.oracleVersion !== taskContract.oracleVersion) {
            throw new Error(
              `Paired benchmark journal ${role} oracle differs from its frozen task contract.`,
            );
          }
        }
      }
      const comparisonBlock = recordValue(
        comparisonBlocks[blockIndex],
        `sealed comparison block ${blockIndex}`,
      );
      const interruptedAttempts = block.order.flatMap((role) =>
        (block.interruptions[role] ?? []).map((interruption) => ({
          role,
          attemptId: interruption.attemptId,
          reason: interruption.reason,
        })),
      );
      exactBinding(
        fields(comparisonBlock, [
          'blockId',
          'taskId',
          'taskVersion',
          'trialIndex',
          'order',
          'outcome',
          'integrityFailures',
          'recovery',
        ]),
        {
          ...expectedBlock,
          outcome: block.outcome,
          integrityFailures: block.integrityFailures,
          recovery:
            interruptedAttempts.length === 0 ? undefined : { interruptedAttempts },
        },
        `sealed comparison block ${blockIndex} journal binding`,
      );
      blockIndex += 1;
    }
  }

  const validBlocks = journal.blocks.filter((block) => block.outcome !== 'invalid');
  const samples = validBlocks.map((block): -1 | 0 | 1 => {
    if (block.outcome === 'treatment_win') return 1;
    if (block.outcome === 'control_win') return -1;
    return 0;
  });
  const outcomes = {
    treatmentWins: journal.blocks.filter((block) => block.outcome === 'treatment_win').length,
    controlWins: journal.blocks.filter((block) => block.outcome === 'control_win').length,
    bothPassed: journal.blocks.filter((block) => block.outcome === 'both_passed').length,
    bothFailed: journal.blocks.filter((block) => block.outcome === 'both_failed').length,
  };
  const summary = recordValue(comparison['summary'], 'sealed comparison summary');
  exactBinding(
    fields(summary, [
      'tasks',
      'trialsPerTask',
      'scheduledBlocks',
      'validBlocks',
      'invalidBlocks',
      'treatmentWins',
      'controlWins',
      'bothPassed',
      'bothFailed',
    ]),
    {
      tasks: protocol.taskIds.length,
      trialsPerTask: protocol.trialsPerTask,
      scheduledBlocks: expectedBlocks,
      validBlocks: validBlocks.length,
      invalidBlocks: expectedBlocks - validBlocks.length,
      ...outcomes,
    },
    'sealed comparison summary journal counts',
  );
  exactBinding(
    summary['pairedLift'],
    pairedHoeffdingLiftInterval(samples),
    'sealed comparison paired lift journal calculation',
  );
  const validAttempts = {
    control: validBlocks.map((block) => completedAttempts(block).control),
    treatment: validBlocks.map((block) => completedAttempts(block).treatment),
  };
  const allAttempts = {
    control: journal.blocks.map((block) => completedAttempts(block).control),
    treatment: journal.blocks.map((block) => completedAttempts(block).treatment),
  };
  exactBinding(
    summary['arms'],
    {
      control: journalArmSummary(validAttempts.control),
      treatment: journalArmSummary(validAttempts.treatment),
    },
    'sealed comparison paired-valid arm summary journal binding',
  );
  exactBinding(
    summary['operationalArms'],
    {
      control: journalArmSummary(allAttempts.control),
      treatment: journalArmSummary(allAttempts.treatment),
    },
    'sealed comparison operational arm summary journal binding',
  );
}

function verifySealedEnvironment(
  protocol: EvidenceDropProtocol,
  environment: PairedExecutionEnvironment,
): void {
  if (protocol.agent.provider !== 'openrouter' || environment.model.provider !== 'openrouter') {
    throw new Error('Paired benchmark sealed environment must retain the frozen OpenRouter model.');
  }
  exactBinding(
    fields(environment.model as unknown as Record<string, unknown>, [
      'provider',
      'modelId',
      'canonicalModelSlug',
      'modelMetadataSha256',
      'providerRoute',
      'configuration',
    ]),
    {
      provider: 'openrouter',
      modelId: protocol.agent.modelId,
      canonicalModelSlug: protocol.agent.canonicalModelSlug,
      modelMetadataSha256: protocol.agent.modelMetadataSha256,
      providerRoute: protocol.agent.providerRoute,
      configuration: {
        contextWindowTokens: environment.model.metadata.contextWindowTokens,
        temperature: protocol.agent.temperature,
        maxOutputTokens: protocol.agent.maxOutputTokens,
        maxRetries: protocol.agent.maxRetries,
        imageMode: protocol.agent.imageMode,
      },
    },
    'sealed environment model configuration',
  );
  exactBinding(
    environment.target,
    {
      expectedVersion: protocol.target.expectedVersion,
      headless: protocol.target.headless,
      profile: environment.target.profile,
    },
    'sealed environment target configuration',
  );
  exactBinding(
    {
      control: environment.arms.control.interfaceVersion,
      treatment: environment.arms.treatment.interfaceVersion,
    },
    {
      control: protocol.arms.control.interfaceVersion,
      treatment: protocol.arms.treatment.interfaceVersion,
    },
    'sealed environment arm interface versions',
  );
}

async function verifiedArtifactManifest(
  outputDirectory: string,
  identity: CreatePairedAgentBenchmarkCompletionMarkerInput,
): Promise<string> {
  let source: string;
  try {
    source = await readFile(join(outputDirectory, 'SHA256SUMS'), 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot finalize paired benchmark evidence without SHA256SUMS: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!source.endsWith('\n')) {
    throw new Error('Paired benchmark SHA256SUMS is not canonical.');
  }
  const lines = source.slice(0, -1).split('\n');
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw new Error('Paired benchmark SHA256SUMS is empty or malformed.');
  }
  const entries = lines.map((line) => {
    const match = checksumLinePattern.exec(line);
    if (match === null) throw new Error('Paired benchmark SHA256SUMS is malformed.');
    return { digest: match[1]!, name: match[2]! };
  });
  const names = entries.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    throw new Error('Paired benchmark SHA256SUMS contains duplicate artifacts.');
  }
  const canonicalNames = [...names].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (names.some((name, index) => name !== canonicalNames[index])) {
    throw new Error('Paired benchmark SHA256SUMS is not canonically ordered.');
  }
  if (names.includes('SHA256SUMS') || names.includes(PAIRED_AGENT_BENCHMARK_COMPLETION_FILE)) {
    throw new Error('Paired benchmark SHA256SUMS contains a reserved artifact.');
  }
  for (const required of requiredArtifacts) {
    if (!names.includes(required)) {
      throw new Error(`Paired benchmark SHA256SUMS is missing required artifact ${required}.`);
    }
  }
  const contents = new Map<string, Buffer>();
  for (const entry of entries) {
    let content: Buffer;
    try {
      content = await readFile(join(outputDirectory, entry.name));
    } catch (error) {
      throw new Error(
        `Paired benchmark artifact ${entry.name} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (sha256(content) !== entry.digest) {
      throw new Error(`Paired benchmark artifact digest differs for ${entry.name}.`);
    }
    contents.set(entry.name, content);
  }
  if (sha256(contents.get('protocol.json')!) !== identity.protocolSha256) {
    throw new Error('Paired benchmark protocol.json digest differs from its marker.');
  }
  const protocol = parseEvidenceDropProtocol(
    jsonRecord(contents.get('protocol.json')!, 'protocol.json'),
  );
  if (contents.get('system-prompt.txt')!.toString('utf8') !== protocol.agent.systemPrompt) {
    throw new Error('Paired benchmark system-prompt.txt differs from its protocol bytes.');
  }
  const journal = verifiedJournal(contents.get('journal.ndjson')!, identity);
  const journalPhase = journal.run.phase;
  if (journalPhase === 'sealed') {
    for (const required of sealedRequiredArtifacts) {
      if (!names.includes(required)) {
        throw new Error(`Paired benchmark SHA256SUMS is missing required artifact ${required}.`);
      }
    }
  }
  if (
    protocol.protocolId !== identity.protocolId ||
    protocol.phase !== journalPhase
  ) {
    throw new Error('Paired benchmark protocol identity or phase differs from its journal.');
  }
  const comparison = jsonRecord(contents.get('comparison.json')!, 'comparison.json');
  matchingIdentity(comparison, 'comparison.json', identity);
  if (comparison['phase'] !== journalPhase) {
    throw new Error('Paired benchmark comparison phase differs from its journal.');
  }
  verifyAttemptsNdjson({
    source: contents.get('attempts.ndjson')!,
    journal,
    comparison,
  });
  const executionStart = jsonRecord(
    contents.get('execution-start.json')!,
    'execution-start.json',
  );
  matchingIdentity(executionStart, 'execution-start.json', identity);
  if (executionStart['stage'] !== 'started') {
    throw new Error('Paired benchmark execution-start.json is not a start artifact.');
  }
  const execution = jsonRecord(contents.get('execution.json')!, 'execution.json');
  matchingIdentity(execution, 'execution.json', identity);
  if (execution['stage'] !== 'completed') {
    throw new Error('Paired benchmark execution.json is not completed.');
  }

  const executionStartSource = sourceSnapshot(
    executionStart['source'],
    'execution-start.json',
  );
  const executionSource = sourceSnapshot(execution['source'], 'execution.json');
  if (stableJson(executionStartSource) !== stableJson(executionSource)) {
    throw new Error('Paired benchmark execution source differs from its start artifact.');
  }
  const executionSourceEnd = sourceSnapshot(execution['sourceEnd'], 'execution.json end');
  if (journalPhase === 'sealed') {
    assertSealedGitSourceStable(executionSource, executionSourceEnd);
    if (
      executionSource.freezeRef === undefined ||
      executionSourceEnd.freezeRef !== executionSource.freezeRef
    ) {
      throw new Error('Paired benchmark sealed source freezeRef drifted between endpoints.');
    }
    if (executionSource.freezeRef !== protocol.freezeRef) {
      throw new Error('Paired benchmark sealed source freezeRef differs from its protocol.');
    }
  }

  const startToolCatalogs = toolCatalogBindings(
    executionStart['toolCatalogs'],
    'execution-start.json',
  );
  const endToolCatalogs = toolCatalogBindings(
    execution['toolCatalogs'],
    'execution.json',
  );
  if (stableJson(startToolCatalogs) !== stableJson(endToolCatalogs)) {
    throw new Error('Paired benchmark execution tool catalogs differ from their start artifact.');
  }
  for (const role of ['control', 'treatment'] as const) {
    const name = `${role}-tool-catalog.json`;
    const catalog = toolCatalog(contents.get(name)!, name);
    const expected = {
      sha256: modelFacingToolCatalogSha256(catalog),
      toolCount: catalog.length,
    };
    if (stableJson(startToolCatalogs[role]) !== stableJson(expected)) {
      throw new Error(`Paired benchmark ${role} tool catalog digest or count differs.`);
    }
  }
  if (journalPhase === 'sealed') {
    verifySealedComparison({
      protocol,
      comparison,
      journal,
      identity,
      toolCatalogs: startToolCatalogs,
    });
  }
  let renderedSummary: string;
  try {
    renderedSummary = renderPairedAgentBenchmarkMarkdown(
      comparison as unknown as PairedAgentBenchmarkReport,
    );
  } catch (error) {
    throw new Error(
      `Paired benchmark summary.md cannot be reconstructed from comparison.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (contents.get('summary.md')!.toString('utf8') !== renderedSummary) {
    throw new Error(
      'Paired benchmark summary.md differs from the validated comparison headline.',
    );
  }

  const executionJournal = execution['journal'];
  if (
    typeof executionJournal !== 'object' ||
    executionJournal === null ||
    Array.isArray(executionJournal) ||
    (executionJournal as Record<string, unknown>)['finalEventSha256'] !==
      identity.journalFinalEventSha256
  ) {
    throw new Error('Paired benchmark execution journal tail differs from its marker.');
  }

  const environmentStart = canonicalEnvironment(
    contents.get('environment-start.json')!,
    'environment-start.json',
  );
  const environmentEnd = canonicalEnvironment(
    contents.get('environment-end.json')!,
    'environment-end.json',
  );
  if (journalPhase === 'sealed') {
    verifySealedEnvironment(protocol, environmentStart);
    verifySealedEnvironment(protocol, environmentEnd);
  }
  const hasModelMetadataStart = contents.has('model-metadata-start.json');
  const hasModelMetadataEnd = contents.has('model-metadata-end.json');
  if (hasModelMetadataStart !== hasModelMetadataEnd) {
    throw new Error('Paired benchmark model metadata endpoint pair is incomplete.');
  }
  if (hasModelMetadataStart && hasModelMetadataEnd) {
    const modelMetadataStart = canonicalModelMetadata(
      contents.get('model-metadata-start.json')!,
      'model-metadata-start.json',
    );
    const modelMetadataEnd = canonicalModelMetadata(
      contents.get('model-metadata-end.json')!,
      'model-metadata-end.json',
    );
    if (
      modelMetadataStart !== renderPairedExecutionModelMetadata(environmentStart) ||
      modelMetadataEnd !== renderPairedExecutionModelMetadata(environmentEnd)
    ) {
      throw new Error(
        'Paired benchmark model metadata endpoints differ from their environment snapshots.',
      );
    }
    const binding = modelMetadataBindingSchema.safeParse(execution['modelMetadata']);
    if (
      !binding.success ||
      binding.data.startSha256 !== sha256(modelMetadataStart) ||
      binding.data.endSha256 !== sha256(modelMetadataEnd)
    ) {
      throw new Error('Paired benchmark execution model metadata binding differs.');
    }
  } else if (execution['modelMetadata'] !== undefined) {
    throw new Error(
      'Paired benchmark execution has a model metadata binding without endpoint artifacts.',
    );
  }
  const expectedEnvironmentBinding = createPairedExecutionIntegrityBinding(
    environmentStart,
    environmentEnd,
    identity.journalFinalEventSha256,
  );
  if (stableJson(execution['environment']) !== stableJson(expectedEnvironmentBinding)) {
    throw new Error('Paired benchmark execution environment binding differs from its endpoints.');
  }

  const hasRuntimeStart = contents.has('runtime-provenance-start.json');
  const hasRuntimeEnd = contents.has('runtime-provenance-end.json');
  if (hasRuntimeStart !== hasRuntimeEnd) {
    throw new Error('Paired benchmark runtime provenance endpoint pair is incomplete.');
  }
  if (hasRuntimeStart && hasRuntimeEnd) {
    const runtimeStart = canonicalRuntimeProvenance(
      contents.get('runtime-provenance-start.json')!,
      'runtime-provenance-start.json',
    );
    const runtimeEnd = canonicalRuntimeProvenance(
      contents.get('runtime-provenance-end.json')!,
      'runtime-provenance-end.json',
    );
    assertPairedRuntimeProvenanceStable(runtimeStart, runtimeEnd);
    for (const role of ['control', 'treatment'] as const) {
      for (const [endpoint, runtime, environment] of [
        ['start', runtimeStart, environmentStart],
        ['end', runtimeEnd, environmentEnd],
      ] as const) {
        const runtimeBrowser = runtime.roles[role].browser;
        const environmentBrowser = environment.arms[role].browser;
        exactBinding(
          {
            engine: runtimeBrowser.engine,
            version: runtimeBrowser.version,
            executableSha256: runtimeBrowser.executableSha256,
          },
          environmentBrowser,
          `${role} ${endpoint} selected Chromium runtime binding`,
        );
        const environmentCore = environment.arms[role].runtimePackages.find(
          ({ name }) => name === 'playwright-core',
        );
        const runtimeCore = runtime.roles[role].packages.find(
          ({ name }) => name === 'playwright-core',
        );
        if (
          environmentCore === undefined ||
          runtimeCore === undefined ||
          environmentCore.version !== runtimeCore.version
        ) {
          throw new Error(
            `Paired benchmark ${role} ${endpoint} Playwright core runtime differs from its environment snapshot.`,
          );
        }
      }
    }
    const runtimeStartBinding = runtimeProvenanceStartBindingSchema.safeParse(
      executionStart['runtimeProvenance'],
    );
    const runtimeBinding = runtimeProvenanceBindingSchema.safeParse(
      execution['runtimeProvenance'],
    );
    if (
      !runtimeStartBinding.success ||
      runtimeStartBinding.data.startSha256 !== runtimeStart.sha256 ||
      !runtimeBinding.success ||
      runtimeBinding.data.startSha256 !== runtimeStart.sha256 ||
      runtimeBinding.data.endSha256 !== runtimeEnd.sha256
    ) {
      throw new Error('Paired benchmark execution runtime provenance binding differs.');
    }
  } else if (
    executionStart['runtimeProvenance'] !== undefined ||
    execution['runtimeProvenance'] !== undefined
  ) {
    throw new Error(
      'Paired benchmark execution has a runtime provenance binding without endpoint artifacts.',
    );
  }

  if (journalPhase === 'sealed') {
    const buildStart = canonicalBuildProvenance(
      contents.get('build-provenance-start.json')!,
      'build-provenance-start.json',
    );
    const buildEnd = canonicalBuildProvenance(
      contents.get('build-provenance-end.json')!,
      'build-provenance-end.json',
    );
    assertSealedBuildProvenanceStable(buildStart, buildEnd);
    const buildBinding = buildProvenanceBindingSchema.safeParse(
      execution['buildProvenance'],
    );
    if (
      !buildBinding.success ||
      buildBinding.data.startSha256 !== buildStart.sha256 ||
      buildBinding.data.endSha256 !== buildEnd.sha256
    ) {
      throw new Error('Paired benchmark execution build provenance binding differs.');
    }
  } else if (execution['buildProvenance'] !== undefined) {
    throw new Error('Development paired benchmark execution has sealed build provenance.');
  }
  return source;
}

export async function readPairedAgentBenchmarkCompletionMarker(
  outputDirectory: string,
): Promise<PairedAgentBenchmarkCompletionMarker | undefined> {
  let source: string;
  try {
    source = await readFile(
      join(outputDirectory, PAIRED_AGENT_BENCHMARK_COMPLETION_FILE),
      'utf8',
    );
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid paired benchmark completion marker JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const marker = parsePairedAgentBenchmarkCompletionMarker(input);
  if (source !== renderPairedAgentBenchmarkCompletionMarker(marker)) {
    throw new Error('Invalid paired benchmark completion marker: non-canonical bytes.');
  }
  const artifactManifest = await verifiedArtifactManifest(outputDirectory, {
    runId: marker.runId,
    protocolId: marker.protocolId,
    protocolSha256: marker.protocolSha256,
    journalFinalEventSha256: marker.journalFinalEventSha256,
  });
  if (sha256(artifactManifest) !== marker.artifactManifestSha256) {
    throw new Error(
      'Invalid paired benchmark completion marker: artifact manifest digest differs.',
    );
  }
  return marker;
}

/**
 * Atomically exposes COMPLETE.json only after every checksummed final artifact
 * exists and matches its retained digest. Callers must invoke this as the last
 * publication step; an existing marker is never overwritten or silently reused.
 */
export async function createPairedAgentBenchmarkCompletionMarker(
  outputDirectory: string,
  input: CreatePairedAgentBenchmarkCompletionMarkerInput,
): Promise<PairedAgentBenchmarkCompletionMarker> {
  const identity = completionIdentitySchema.parse(input);
  const artifactManifest = await verifiedArtifactManifest(outputDirectory, identity);
  const marker = parsePairedAgentBenchmarkCompletionMarker({
    schemaVersion: PAIRED_AGENT_BENCHMARK_COMPLETION_SCHEMA_VERSION,
    state: 'complete',
    ...identity,
    artifactManifestSha256: sha256(artifactManifest),
  });
  const staging = await mkdtemp(join(outputDirectory, '.paired-completion-'));
  const staged = join(staging, PAIRED_AGENT_BENCHMARK_COMPLETION_FILE);
  const destination = join(outputDirectory, PAIRED_AGENT_BENCHMARK_COMPLETION_FILE);
  try {
    const handle = await open(staged, 'wx');
    try {
      await handle.writeFile(renderPairedAgentBenchmarkCompletionMarker(marker), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(staged, destination);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        throw new Error('Paired benchmark evidence is already finalized by COMPLETE.json.');
      }
      throw error;
    }
    await syncDirectory(outputDirectory);
    return marker;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
