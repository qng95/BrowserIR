import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { stableJson } from '../src/environment.js';
import {
  createPairedExecutionIntegrityBinding,
  createPairedAgentBenchmarkCompletionMarker,
  deterministicModelSeed,
  modelFacingToolCatalogSha256,
  pairedArmOrder,
  pairedHoeffdingLiftInterval,
  PAIRED_CONTROL_RUNTIME_PACKAGE_NAMES,
  PAIRED_TREATMENT_RUNTIME_PACKAGE_NAMES,
  parsePairedJournalNdjson,
  parsePairedAgentBenchmarkCompletionMarker,
  readPairedAgentBenchmarkCompletionMarker,
  renderAgentBenchmarkChecksums,
  renderPairedRuntimeProvenance,
  renderPairedAgentBenchmarkMarkdown,
  renderPairedExecutionEnvironment,
  renderPairedExecutionModelMetadata,
  renderSealedBuildProvenance,
  type AgentToolDescriptor,
  type JournalSafeAgentTrialResult,
  type PairedRuntimeProvenance,
  type PairedAgentBenchmarkReport,
  type PairedExecutionEnvironment,
  type SealedBuildProvenance,
  wilsonInterval,
} from '../src/agent-benchmark/index.js';

const temporaryDirectories: string[] = [];
const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const runId = 'drop-01-development-run';
const protocolId = 'drop-01-development-v5';
const taskId = 'paired-task';
const taskVersion = `sha256:${digest('paired-task-version')}`;
const taskPromptSha256 = digest('paired task prompt');
const oracleVersion = `sha256:${digest('paired-task-oracle')}`;
const targetVersion = `sha256:${digest('target')}`;
const systemPrompt = 'Use the provided browser tools.';
const openRouterMetadata = {
  schemaVersion: '1.0.0' as const,
  modelId: 'qwen/qwen3.8-max',
  canonicalModelSlug: 'qwen/qwen3.8-max-20260803',
  contextWindowTokens: 262_144,
  providerRoute: 'alibaba',
  providerName: 'Alibaba',
  endpointName: 'Qwen3.8 Max',
  endpointModelId: 'qwen/qwen3.8-max',
  maxCompletionTokens: 32_768,
  requiredParameters: [
    'max_tokens',
    'reasoning',
    'reasoning_effort',
    'seed',
    'temperature',
    'tool_choice',
    'tools',
  ] as const,
};
const openRouterMetadataSha256 = digest(stableJson(openRouterMetadata));

const prettyStableJson = (value: unknown): string =>
  `${JSON.stringify(JSON.parse(stableJson(value)) as unknown, null, 2)}\n`;

const executionEnvironment = (): PairedExecutionEnvironment => ({
  schemaVersion: '1.2.0',
  host: {
    platform: 'darwin',
    release: '25.0.0',
    arch: 'arm64',
    hardware: {
      cpuModel: 'Apple M4 Pro',
      logicalCpuCount: 14,
      memoryBytes: 51_539_607_552,
    },
    resourceLimits: {
      attemptConcurrency: 1,
      processBoundary: false,
      containerOrVmLimits: 'unverified',
    },
  },
  harness: {
    nodeVersion: 'v22.19.0',
    pnpmVersion: '10.30.3',
    packageManager: 'pnpm@10.30.3',
    lockfileSha256: digest('lockfile'),
  },
  model: {
    provider: 'ollama',
    modelId: 'browserir-qwen3-8b-32k:drop01-dev',
    artifactDigest: `sha256:${digest('model')}`,
    verification: 'ollama-endpoint-reported-digest',
    runtime: { name: 'ollama', version: '0.11.4' },
    configuration: {
      contextWindowTokens: 32_768,
      temperature: 0,
      maxRetries: 0,
      imageMode: 'text-only',
    },
    capabilities: ['completion', 'thinking', 'tools'],
  },
  target: {
    expectedVersion: `sha256:${digest('target')}`,
    headless: true,
    profile: {
      viewport: { width: 1_440, height: 900, deviceScaleFactor: 1 },
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    },
  },
  arms: {
    control: {
      interfaceVersion: '0.0.78',
      runtimePackages: [
        { name: '@playwright/mcp', version: '0.0.78' },
        { name: 'playwright-core', version: '1.62.0' },
      ],
      browser: {
        engine: 'chromium',
        version: '144.0.7559.3',
        executableSha256: digest('browser'),
      },
    },
    treatment: {
      interfaceVersion: '0.1.0+mcp-2026-07-28',
      runtimePackages: [
        { name: '@browserir/core', version: '0.1.0' },
        { name: '@browserir/mcp', version: '0.1.0' },
        { name: '@browserir/playwright', version: '0.1.0' },
        { name: 'playwright-core', version: '1.62.0' },
      ],
      browser: {
        engine: 'chromium',
        version: '144.0.7559.3',
        executableSha256: digest('browser'),
      },
    },
  },
});

const modelFacingCatalog = (role: 'control' | 'treatment'): AgentToolDescriptor[] => [
  {
    name: role === 'control' ? 'browser_snapshot' : 'browser_observe',
    description: `Observe with the ${role} arm.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const sealedBuildProvenance = (variant = 'stable'): SealedBuildProvenance => {
  const packages = (
    ['@browserir/core', '@browserir/mcp', '@browserir/playwright'] as const
  ).map((name) => {
    const files = [
      { path: 'dist/index.js', bytes: 10, sha256: digest(`${variant}:${name}:dist`) },
      { path: 'package.json', bytes: 20, sha256: digest(`${variant}:${name}:manifest`) },
    ];
    const unsigned = { name, version: '0.1.0', files };
    return { ...unsigned, sha256: digest(stableJson(unsigned)) };
  });
  const unsigned = { schemaVersion: '1.0.0' as const, packages };
  return { ...unsigned, sha256: digest(stableJson(unsigned)) };
};

const installedRuntimeProvenance = (
  role: 'control' | 'treatment',
  variant = 'stable',
) => {
  const packages = (role === 'control'
    ? PAIRED_CONTROL_RUNTIME_PACKAGE_NAMES
    : PAIRED_TREATMENT_RUNTIME_PACKAGE_NAMES
  )
    .map((name) => {
      const files = [
        {
          path: 'dist/index.js',
          kind: 'package_payload' as const,
          bytes: 10,
          sha256: digest(`${role}:${variant}:${name}:runtime:dist`),
        },
        {
          path: 'package.json',
          kind: 'package_manifest' as const,
          bytes: 20,
          sha256: digest(`${role}:${variant}:${name}:runtime:manifest`),
        },
      ];
      const unsignedPackage = {
        name,
        version: name === 'playwright' || name === 'playwright-core' ? '1.62.0' : '1.5.5',
        files,
      };
      return { ...unsignedPackage, sha256: digest(stableJson(unsignedPackage)) };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const browser = {
    engine: 'chromium' as const,
    version: '144.0.7559.3',
    executableBytes: 100,
    executableSha256:
      variant === 'stable' ? digest('browser') : digest(`${role}:${variant}:chromium`),
  };
  const unsigned = { schemaVersion: '1.0.0' as const, packages, browser };
  return { ...unsigned, sha256: digest(stableJson(unsigned)) };
};

const pairedRuntimeProvenance = (
  treatmentVariant = 'stable',
): PairedRuntimeProvenance => {
  const roles = {
    control: installedRuntimeProvenance('control'),
    treatment: installedRuntimeProvenance('treatment', treatmentVariant),
  };
  const unsigned = { schemaVersion: '1.0.0' as const, roles };
  return { ...unsigned, sha256: digest(stableJson(unsigned)) };
};

const journalAgentMetadata = (
  phase: 'development' | 'sealed',
  trialIndex: number,
) => {
  if (phase === 'development') {
    return {
      adapterId: 'shared-agent',
      framework: 'langchain-create-agent',
      frameworkVersion: '1.5.5',
      model: 'development-model',
    };
  }
  const seed = deterministicModelSeed(20260812, taskId, trialIndex);
  const modelConfiguration = {
    provider: 'openrouter',
    modelId: 'qwen/qwen3.8-max',
    temperature: 0.2,
    maxRetries: 0,
    useResponsesApi: false,
    imageMode: 'text-only',
    seed,
    frameworkVersion: '1.5.5',
    canonicalModelSlug: 'qwen/qwen3.8-max-20260803',
    modelMetadataSha256: openRouterMetadataSha256,
    modelCapabilities: { tools: true, seed: true, temperature: true },
    providerRoute: 'alibaba',
    reasoningEffort: 'low',
    providerPolicy: {
      allowFallbacks: false,
      requireParameters: true,
      dataCollection: 'deny',
    },
    maxOutputTokens: 4096,
  };
  return {
    adapterId: 'shared-langchain-agent',
    framework: 'langchain-create-agent',
    frameworkVersion: '1.5.5',
    model: 'qwen/qwen3.8-max',
    modelConfigurationSha256: digest(stableJson(modelConfiguration)),
    adapterConfigurationSha256: digest(stableJson({ imageMode: 'text-only' })),
    systemPromptSha256: digest(systemPrompt),
  };
};

type SealedAttemptMutation = (
  attempt: Record<string, unknown>,
  context: { trialIndex: number; role: 'control' | 'treatment' },
) => void;

function journalNdjson(
  phase: 'development' | 'sealed',
  protocolSha256: string,
  mode: 'complete' | 'shortcut' = 'complete',
  sealedAttemptMutation?: SealedAttemptMutation | undefined,
): {
  source: string;
  finalEventSha256: string;
} {
  const trials = phase === 'sealed' ? 30 : 1;
  const attempt = (
    blockId: string,
    trialIndex: number,
    role: 'control' | 'treatment',
  ) => {
    const catalog = modelFacingCatalog(role);
    const result: Record<string, unknown> = {
      attemptId: `${blockId}:${role}`,
      taskId,
      taskVersion,
      trialIndex,
      outcome: 'passed',
      targetId: `${role}-target`,
      targetVersion,
      agentStatus: 'completed',
      submittedResultSha256: digest(`submitted:${trialIndex}`),
      submissionAttempts: 1,
      modelTurns: 1,
      durationMs: 10,
      tools: {
        calls: 1,
        errors: 0,
        byTool: { [catalog[0]!.name]: 1 },
        budgetExceeded: false,
        policyViolationCount: 0,
        toolCatalogSha256: modelFacingToolCatalogSha256(catalog),
        toolCatalogToolCount: catalog.length,
      },
      baseline: {
        outcome: 'failed',
        oracleVersion,
        stateFingerprint: digest(`baseline:${trialIndex}`),
        criteria: [
          {
            id: 'business-result',
            required: true,
            passed: false,
            descriptionSha256: digest('baseline incomplete'),
          },
        ],
      },
      judge: {
        outcome: 'passed',
        oracleVersion,
        stateFingerprint: digest(`final:${trialIndex}`),
        criteria: [
          {
            id: 'business-result',
            required: true,
            passed: true,
            descriptionSha256: digest('final complete'),
          },
        ],
      },
      agent: journalAgentMetadata(phase, trialIndex),
    };
    if (phase === 'sealed') sealedAttemptMutation?.(result, { trialIndex, role });
    return result;
  };
  const runStarted = {
    type: 'run_started',
    runId,
    protocolId,
    protocolSha256,
    phase,
    protocolBinding: phase === 'sealed' ? 'frozen_verified' : 'development',
    scheduledBlocks: trials,
  };
  const blocks = Array.from({ length: trials }, (_, trialIndex) => {
    const blockId = `${runId}:${taskId}:${trialIndex}`;
    const order = pairedArmOrder(20260811, taskId, trialIndex);
    const attempts = {
      control: attempt(blockId, trialIndex, 'control'),
      treatment: attempt(blockId, trialIndex, 'treatment'),
    };
    const integrityFailures =
      attempts.control['targetVersion'] === attempts.treatment['targetVersion']
        ? []
        : ['target_version_mismatch'];
    const outcome =
      integrityFailures.length > 0 ||
      attempts.control['outcome'] === 'invalid' ||
      attempts.treatment['outcome'] === 'invalid'
        ? 'invalid'
        : attempts.control['outcome'] === 'passed' &&
            attempts.treatment['outcome'] === 'passed'
          ? 'both_passed'
          : attempts.control['outcome'] === 'failed' &&
              attempts.treatment['outcome'] === 'failed'
            ? 'both_failed'
            : attempts.treatment['outcome'] === 'passed'
              ? 'treatment_win'
              : 'control_win';
    const events = [
      {
        type: 'block_started',
        blockId,
        taskId,
        taskVersion,
        trialIndex,
        order,
      },
      ...order.flatMap((role) => {
        const result = attempts[role];
        return [
          {
            type: 'attempt_started',
            blockId,
            attemptId: result['attemptId'],
            taskId,
            trialIndex,
            role,
          },
          {
            type: 'attempt_completed',
            blockId,
            role,
            attempt: result,
          },
        ];
      }),
      {
        type: 'block_completed',
        blockId,
        outcome,
        integrityFailures,
      },
    ];
    return { outcome, events };
  });
  const validBlocks = blocks.filter((block) => block.outcome !== 'invalid').length;
  const runCompleted = {
    type: 'run_completed',
    runId,
    scheduledBlocks: trials,
    completedBlocks: trials,
    validBlocks,
    invalidBlocks: trials - validBlocks,
  };
  const blockEvents = blocks.flatMap((block) => block.events);
  const events =
    mode === 'shortcut'
      ? [runStarted, runCompleted]
      : [runStarted, ...blockEvents, runCompleted];
  let previousEventSha256: string | null = null;
  const lines = events.map((event, sequence) => {
    const unsigned = {
      schemaVersion: '1.0.0',
      sequence,
      recordedAt: new Date(Date.UTC(2026, 7, 11, 12, sequence)).toISOString(),
      previousEventSha256,
      event,
    };
    const envelope = {
      ...unsigned,
      eventSha256: digest(stableJson(unsigned)),
    };
    previousEventSha256 = envelope.eventSha256;
    return stableJson(envelope);
  });
  return {
    source: `${lines.join('\n')}\n`,
    finalEventSha256: previousEventSha256!,
  };
}

const claimPolicy = {
  decisionRule: {
    minimumScheduledBlocks: 30,
    maximumInvalidBlocks: 1,
    positive: { lowerBoundAbove: 0 },
    negative: { upperBoundBelow: 0 },
    otherwise: 'inconclusive',
  },
  publicationRule: 'publish-regardless-of-sign',
  estimand: 'fixed-workflow-precommitted-seed-schedule',
} as const;

function protocolDocument(
  phase: 'development' | 'sealed',
  toolCatalogs: {
    control: { sha256: string; toolCount: number };
    treatment: { sha256: string; toolCount: number };
  },
): Record<string, unknown> {
  const sealed = phase === 'sealed';
  return {
    schemaVersion: '1.0.0',
    dropId: '01',
    protocolId,
    phase,
    status: sealed ? 'frozen' : 'draft',
    ...(sealed ? { freezeRef: 'refs/tags/evidence-drop-01-protocol-v1' } : {}),
    question: 'Does the treatment complete the fixed workflow more often than control?',
    taskIds: [taskId],
    taskContracts: [
      { id: taskId, version: taskVersion, promptSha256: taskPromptSha256, oracleVersion },
    ],
    reservedSealedTaskIds: [sealed ? taskId : 'validation-recovery'],
    trialsPerTask: sealed ? 30 : 1,
    schedule: {
      orderSeed: 20260811,
      bootstrapSeed: 141421,
      ...(sealed ? { modelSeedBase: 20260812 } : {}),
      bootstrapResamples: 10_000,
      stoppingRule: 'run-entire-schedule',
      invalidReplacementPolicy: 'none',
    },
    budgets: { maxDurationMs: 300_000, maxToolCalls: 100, maxModelTurns: 30 },
    agent: sealed
      ? {
          framework: 'langchain-create-agent',
          frameworkVersion: '1.5.5',
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKeyEnv: 'OPENROUTER_API_KEY',
          modelId: 'qwen/qwen3.8-max',
          canonicalModelSlug: 'qwen/qwen3.8-max-20260803',
          modelMetadataSha256: openRouterMetadataSha256,
          providerRoute: 'alibaba',
          reasoningEffort: 'low',
          providerPolicy: {
            allowFallbacks: false,
            requireParameters: true,
            dataCollection: 'deny',
          },
          modelCapabilities: { tools: true, seed: true, temperature: true },
          temperature: 0.2,
          maxOutputTokens: 4096,
          maxRetries: 0,
          imageMode: 'text-only',
          systemPrompt,
          systemPromptSha256: digest(systemPrompt),
        }
      : {
          framework: 'langchain-create-agent',
          provider: 'ollama',
          baseUrl: 'http://127.0.0.1:11434/v1',
          modelId: 'development-model',
          modelDigest: `sha256:${digest('development-model')}`,
          contextWindowTokens: 32_768,
          temperature: 0,
          maxRetries: 0,
          imageMode: 'text-only',
          systemPrompt,
          systemPromptSha256: digest(systemPrompt),
        },
    target: { expectedVersion: targetVersion, headless: true },
    arms: {
      control: {
        role: 'control',
        id: 'playwright-mcp',
        label: 'Official Playwright MCP accessibility snapshot',
        interfaceVersion: '0.0.78',
        ...(sealed ? { expectedToolCatalogSha256: toolCatalogs.control.sha256 } : {}),
      },
      treatment: {
        role: 'treatment',
        id: 'browserir',
        label: 'BrowserIR complete browser interface',
        interfaceVersion: '0.1.0+mcp-2026-07-28',
        ...(sealed ? { expectedToolCatalogSha256: toolCatalogs.treatment.sha256 } : {}),
      },
    },
    analysis: {
      confidence: 0.95,
      interval: sealed ? 'paired-hoeffding-bound' : 'paired-percentile-bootstrap',
      invalidBlockHeadlineThreshold: 0.05,
      primaryMetric: 'paired-treatment-minus-control-pass-rate',
      ...(sealed ? claimPolicy : {}),
    },
  };
}

const armSummary = (attempts: readonly JournalSafeAgentTrialResult[]) => ({
  attempts: attempts.length,
  passed: attempts.filter((attempt) => attempt.outcome === 'passed').length,
  failed: attempts.filter((attempt) => attempt.outcome === 'failed').length,
  invalid: attempts.filter((attempt) => attempt.outcome === 'invalid').length,
  passRate: wilsonInterval(
    attempts.filter((attempt) => attempt.outcome === 'passed').length,
    attempts.filter((attempt) => attempt.outcome !== 'invalid').length,
  ),
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
});

function comparisonDocument(
  phase: 'development' | 'sealed',
  protocolSha256: string,
  protocol: Record<string, unknown>,
  journal: ReturnType<typeof parsePairedJournalNdjson>,
): Record<string, unknown> {
  const trials = phase === 'sealed' ? 30 : 1;
  const validBlocks = journal.blocks.filter((block) => block.outcome !== 'invalid');
  const samples = validBlocks.map((block): -1 | 0 | 1 => {
    if (block.outcome === 'treatment_win') return 1;
    if (block.outcome === 'control_win') return -1;
    return 0;
  });
  const lift =
    phase === 'sealed'
      ? pairedHoeffdingLiftInterval(samples)
      : {
          estimate: 0,
          lower: 0,
          upper: 0,
          confidence: 0.95,
          method: 'paired-percentile-bootstrap',
          resamples: 10_000,
          seed: 141421,
          pairs: validBlocks.length,
        };
  const arms = protocol['arms'] as Record<'control' | 'treatment', Record<string, unknown>>;
  const validAttempts = {
    control: validBlocks.map((block) => block.attempts.control!),
    treatment: validBlocks.map((block) => block.attempts.treatment!),
  };
  const allAttempts = {
    control: journal.blocks.map((block) => block.attempts.control!),
    treatment: journal.blocks.map((block) => block.attempts.treatment!),
  };
  return {
    schemaVersion: '1.0.0',
    runId,
    protocolId,
    protocolSha256,
    protocolBinding: phase === 'sealed' ? 'frozen_verified' : 'development',
    phase,
    ...(phase === 'sealed' ? { claimPolicy } : {}),
    expectedTargetVersion: targetVersion,
    scheduleSeed: 20260811,
    budgets: protocol['budgets'],
    arms: (['control', 'treatment'] as const).map((role) => ({
      role,
      id: arms[role]!.id,
      label: arms[role]!.label,
      interfaceVersion: arms[role]!.interfaceVersion,
      ...(arms[role]!.expectedToolCatalogSha256 === undefined
        ? {}
        : { expectedToolCatalogSha256: arms[role]!.expectedToolCatalogSha256 }),
    })),
    summary: {
      tasks: 1,
      trialsPerTask: trials,
      scheduledBlocks: trials,
      validBlocks: validBlocks.length,
      invalidBlocks: trials - validBlocks.length,
      treatmentWins: journal.blocks.filter((block) => block.outcome === 'treatment_win')
        .length,
      controlWins: journal.blocks.filter((block) => block.outcome === 'control_win')
        .length,
      bothPassed: journal.blocks.filter((block) => block.outcome === 'both_passed').length,
      bothFailed: journal.blocks.filter((block) => block.outcome === 'both_failed').length,
      pairedLift: lift,
      arms: {
        control: armSummary(validAttempts.control),
        treatment: armSummary(validAttempts.treatment),
      },
      operationalArms: {
        control: armSummary(allAttempts.control),
        treatment: armSummary(allAttempts.treatment),
      },
    },
    blocks: journal.blocks.map((block) => ({
      blockId: block.blockId,
      taskId: block.taskId,
      taskVersion: block.taskVersion,
      trialIndex: block.trialIndex,
      order: block.order,
      outcome: block.outcome,
      ...(block.integrityFailures === undefined
        ? {}
        : { integrityFailures: block.integrityFailures }),
      attempts: {
        control: block.attempts.control,
        treatment: block.attempts.treatment,
      },
    })),
  };
}

function completeArtifacts(
  phase: 'development' | 'sealed' = 'development',
  journalMode: 'complete' | 'shortcut' = 'complete',
  sealedAttemptMutation?: SealedAttemptMutation | undefined,
): {
  artifacts: Record<string, string>;
  input: {
    runId: string;
    protocolId: string;
    protocolSha256: string;
    journalFinalEventSha256: string;
  };
} {
  const environmentStart = executionEnvironment();
  const environmentEnd = executionEnvironment();
  if (phase === 'sealed') {
    const model = {
      provider: 'openrouter' as const,
      modelId: openRouterMetadata.modelId,
      canonicalModelSlug: openRouterMetadata.canonicalModelSlug,
      modelMetadataSha256: openRouterMetadataSha256,
      providerRoute: openRouterMetadata.providerRoute,
      verification: 'openrouter-endpoint-metadata-fingerprint' as const,
      metadata: openRouterMetadata,
      configuration: {
        contextWindowTokens: openRouterMetadata.contextWindowTokens,
        temperature: 0.2,
        maxOutputTokens: 4096,
        maxRetries: 0,
        imageMode: 'text-only' as const,
      },
    };
    environmentStart.model = model;
    environmentEnd.model = structuredClone(model);
  }
  const controlCatalog = modelFacingCatalog('control');
  const treatmentCatalog = modelFacingCatalog('treatment');
  const toolCatalogs = {
    control: {
      sha256: modelFacingToolCatalogSha256(controlCatalog),
      toolCount: controlCatalog.length,
    },
    treatment: {
      sha256: modelFacingToolCatalogSha256(treatmentCatalog),
      toolCount: treatmentCatalog.length,
    },
  };
  const protocolDocumentValue = protocolDocument(phase, toolCatalogs);
  const protocol = `${JSON.stringify(protocolDocumentValue, null, 2)}\n`;
  const protocolSha256 = digest(protocol);
  const journal = journalNdjson(
    phase,
    protocolSha256,
    journalMode,
    sealedAttemptMutation,
  );
  const reconstructedJournal = parsePairedJournalNdjson(
    journalMode === 'complete'
      ? journal.source
      : journalNdjson(
          phase,
          protocolSha256,
          'complete',
          sealedAttemptMutation,
        ).source,
  );
  const attemptsNdjson = `${[...reconstructedJournal.blocks]
    .sort((left, right) =>
      left.taskId < right.taskId
        ? -1
        : left.taskId > right.taskId
          ? 1
          : left.trialIndex - right.trialIndex,
    )
    .flatMap((block) =>
      (['control', 'treatment'] as const).map((role) => ({
        blockId: block.blockId,
        order: block.order,
        blockOutcome: block.outcome,
        role,
        attempt: block.attempts[role],
      })),
    )
    .map((entry) => stableJson(entry))
    .join('\n')}\n`;
  const environment = createPairedExecutionIntegrityBinding(
    environmentStart,
    environmentEnd,
    journal.finalEventSha256,
  );
  const source = {
    revision: '1'.repeat(40),
    tree: '2'.repeat(40),
    clean: phase === 'sealed',
    ...(phase === 'sealed'
      ? { freezeRef: 'refs/tags/evidence-drop-01-protocol-v1' }
      : {}),
  };
  const sourceEnd = { ...source };
  const build = phase === 'sealed' ? sealedBuildProvenance() : undefined;
  const runtime = phase === 'sealed' ? pairedRuntimeProvenance() : undefined;
  const modelMetadataStart = renderPairedExecutionModelMetadata(environmentStart);
  const modelMetadataEnd = renderPairedExecutionModelMetadata(environmentEnd);
  const comparison = comparisonDocument(
    phase,
    protocolSha256,
    protocolDocumentValue,
    reconstructedJournal,
  );
  const artifacts: Record<string, string> = {
    'attempts.ndjson': attemptsNdjson,
    'comparison.json': prettyStableJson(comparison),
    'control-tool-catalog.json': prettyStableJson(controlCatalog),
    'environment-end.json': renderPairedExecutionEnvironment(environmentEnd),
    'environment-start.json': renderPairedExecutionEnvironment(environmentStart),
    'model-metadata-end.json': modelMetadataEnd,
    'model-metadata-start.json': modelMetadataStart,
    'execution-start.json': prettyStableJson({
      schemaVersion: '1.0.0',
      stage: 'started',
      runId,
      protocolId,
      protocolSha256,
      source,
      ...(runtime === undefined
        ? {}
        : { runtimeProvenance: { startSha256: runtime.sha256 } }),
      toolCatalogs,
    }),
    'execution.json': prettyStableJson({
      schemaVersion: '1.0.0',
      stage: 'completed',
      runId,
      protocolId,
      protocolSha256,
      source,
      sourceEnd,
      modelMetadata: {
        startSha256: digest(modelMetadataStart),
        endSha256: digest(modelMetadataEnd),
      },
      ...(runtime === undefined
        ? {}
        : {
            runtimeProvenance: {
              startSha256: runtime.sha256,
              endSha256: runtime.sha256,
            },
          }),
      ...(build === undefined
        ? {}
        : {
            buildProvenance: {
              startSha256: build.sha256,
              endSha256: build.sha256,
            },
          }),
      toolCatalogs,
      journal: { finalEventSha256: journal.finalEventSha256 },
      environment,
    }),
    'journal.ndjson': journal.source,
    'protocol.json': protocol,
    'summary.md': renderPairedAgentBenchmarkMarkdown(
      comparison as unknown as PairedAgentBenchmarkReport,
    ),
    'system-prompt.txt': systemPrompt,
    'treatment-tool-catalog.json': prettyStableJson(treatmentCatalog),
    ...(phase === 'sealed'
      ? {
          'build-provenance-start.json': renderSealedBuildProvenance(build!),
          'build-provenance-end.json': renderSealedBuildProvenance(build!),
          'runtime-provenance-start.json': renderPairedRuntimeProvenance(runtime!),
          'runtime-provenance-end.json': renderPairedRuntimeProvenance(runtime!),
        }
      : {}),
  };
  return {
    artifacts,
    input: { runId, protocolId, protocolSha256, journalFinalEventSha256: journal.finalEventSha256 },
  };
}

async function materializeArtifacts(
  prefix: string,
  artifacts: Record<string, string>,
): Promise<string> {
  const output = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(output);
  for (const [name, content] of Object.entries(artifacts)) {
    await writeFile(join(output, name), content, 'utf8');
  }
  await writeFile(
    join(output, 'SHA256SUMS'),
    renderAgentBenchmarkChecksums(artifacts),
    'utf8',
  );
  return output;
}

const makePreAgentInvalidAttempt = (
  attempt: Record<string, unknown>,
  failureKind:
    | 'target_setup_failed'
    | 'target_version_mismatch'
    | 'tool_catalog_mismatch',
): void => {
  attempt['outcome'] = 'invalid';
  attempt['failureKind'] = failureKind;
  attempt['agentStatus'] = 'not_started';
  attempt['submissionAttempts'] = 0;
  attempt['modelTurns'] = 0;
  delete attempt['submittedResultSha256'];
  delete attempt['judge'];
  attempt['agent'] = {
    adapterId: 'not-started',
    framework: 'none',
    frameworkVersion: 'none',
    model: 'none',
  };

  const tools = attempt['tools'] as Record<string, unknown>;
  tools['calls'] = 0;
  tools['errors'] = 0;
  tools['byTool'] = {};
  tools['budgetExceeded'] = false;
  tools['policyViolationCount'] = 0;

  if (failureKind === 'target_setup_failed') {
    attempt['targetId'] = 'unprovisioned';
    attempt['targetVersion'] = 'unavailable';
    delete attempt['baseline'];
    delete tools['toolCatalogSha256'];
    delete tools['toolCatalogToolCount'];
    return;
  }
  if (failureKind === 'target_version_mismatch') {
    attempt['targetVersion'] = `sha256:${digest('unexpected-target-version')}`;
    delete attempt['baseline'];
    delete tools['toolCatalogSha256'];
    delete tools['toolCatalogToolCount'];
    return;
  }

  tools['toolCatalogSha256'] = digest('unexpected-tool-catalog');
  tools['toolCatalogToolCount'] = 2;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('paired agent benchmark completion marker', () => {
  it('distinguishes journal-complete unfinalized evidence from finalized evidence', async () => {
    const output = await mkdtemp(join(tmpdir(), 'browserir-paired-complete-'));
    temporaryDirectories.push(output);
    const { artifacts, input } = completeArtifacts();
    for (const [name, content] of Object.entries(artifacts)) {
      await writeFile(join(output, name), content, 'utf8');
    }
    const checksums = renderAgentBenchmarkChecksums(artifacts);
    await writeFile(join(output, 'SHA256SUMS'), checksums, 'utf8');

    await expect(readPairedAgentBenchmarkCompletionMarker(output)).resolves.toBeUndefined();

    const marker = await createPairedAgentBenchmarkCompletionMarker(output, input);

    expect(marker).toMatchObject({
      schemaVersion: '1.0.0',
      state: 'complete',
      artifactManifestSha256: digest(checksums),
    });
    await expect(readPairedAgentBenchmarkCompletionMarker(output)).resolves.toEqual(marker);
    await expect(
      createPairedAgentBenchmarkCompletionMarker(output, input),
    ).rejects.toThrow(/complete|exist|finalized/i);

    await writeFile(join(output, 'summary.md'), '# Changed after finalization\n', 'utf8');
    await expect(readPairedAgentBenchmarkCompletionMarker(output)).rejects.toThrow(
      /artifact|digest|manifest/i,
    );
  });

  it('finalizes a sealed 30-block schedule with one genuine target-setup invalid block', async () => {
    const sealed = completeArtifacts(
      'sealed',
      'complete',
      (attempt, { trialIndex, role }) => {
        if (trialIndex === 0 && role === 'control') {
          makePreAgentInvalidAttempt(attempt, 'target_setup_failed');
        }
      },
    );
    const output = await materializeArtifacts(
      'browserir-paired-sealed-target-setup-invalid-',
      sealed.artifacts,
    );

    await expect(
      createPairedAgentBenchmarkCompletionMarker(output, sealed.input),
    ).resolves.toMatchObject({ state: 'complete' });
    const comparison = JSON.parse(sealed.artifacts['comparison.json']!) as {
      summary: {
        scheduledBlocks: number;
        validBlocks: number;
        invalidBlocks: number;
        operationalArms: {
          control: { attempts: number; invalid: number };
          treatment: { attempts: number; invalid: number };
        };
      };
    };
    expect(comparison.summary).toMatchObject({
      scheduledBlocks: 30,
      validBlocks: 29,
      invalidBlocks: 1,
      operationalArms: {
        control: { attempts: 30, invalid: 1 },
        treatment: { attempts: 30, invalid: 0 },
      },
    });
  });

  it('finalizes one stage-authentic target-version/catalog invalid block without weakening valid attempts', async () => {
    const sealed = completeArtifacts(
      'sealed',
      'complete',
      (attempt, { trialIndex, role }) => {
        if (trialIndex !== 0) return;
        makePreAgentInvalidAttempt(
          attempt,
          role === 'control' ? 'target_version_mismatch' : 'tool_catalog_mismatch',
        );
      },
    );
    const output = await materializeArtifacts(
      'browserir-paired-sealed-stage-invalid-',
      sealed.artifacts,
    );

    await expect(
      createPairedAgentBenchmarkCompletionMarker(output, sealed.input),
    ).resolves.toMatchObject({ state: 'complete' });
    const comparison = JSON.parse(sealed.artifacts['comparison.json']!) as {
      summary: {
        scheduledBlocks: number;
        validBlocks: number;
        invalidBlocks: number;
        operationalArms: {
          control: { invalid: number };
          treatment: { invalid: number };
        };
      };
    };
    expect(comparison.summary).toMatchObject({
      scheduledBlocks: 30,
      validBlocks: 29,
      invalidBlocks: 1,
      operationalArms: {
        control: { invalid: 1 },
        treatment: { invalid: 1 },
      },
    });
  });

  it('rejects invalid failure labels that retain evidence from an impossible execution stage', async () => {
    const cases: Array<{
      name: string;
      mutate: SealedAttemptMutation;
      error: RegExp;
    }> = [
      {
        name: 'target-setup-after-agent',
        mutate(attempt, { trialIndex, role }) {
          if (trialIndex !== 0 || role !== 'control') return;
          makePreAgentInvalidAttempt(attempt, 'target_setup_failed');
          attempt['modelTurns'] = 1;
        },
        error: /pre-agent failure.*post-agent evidence/i,
      },
      {
        name: 'matching-target-labelled-mismatch',
        mutate(attempt, { trialIndex, role }) {
          if (trialIndex !== 0 || role !== 'control') return;
          makePreAgentInvalidAttempt(attempt, 'target_version_mismatch');
          attempt['targetVersion'] = targetVersion;
        },
        error: /target version mismatch.*mismatched pre-baseline evidence/i,
      },
      {
        name: 'matching-catalog-labelled-mismatch',
        mutate(attempt, { trialIndex, role }) {
          if (trialIndex !== 0 || role !== 'control') return;
          makePreAgentInvalidAttempt(attempt, 'tool_catalog_mismatch');
          const catalog = modelFacingCatalog(role);
          const tools = attempt['tools'] as Record<string, unknown>;
          tools['toolCatalogSha256'] = modelFacingToolCatalogSha256(catalog);
          tools['toolCatalogToolCount'] = catalog.length;
        },
        error: /catalog mismatch.*exact frozen interface/i,
      },
    ];

    for (const candidate of cases) {
      const sealed = completeArtifacts('sealed', 'complete', candidate.mutate);
      const output = await materializeArtifacts(
        `browserir-paired-sealed-impossible-${candidate.name}-`,
        sealed.artifacts,
      );
      await expect(
        createPairedAgentBenchmarkCompletionMarker(output, sealed.input),
      ).rejects.toThrow(candidate.error);
    }
  });

  it('binds COMPLETE to the canonical journal tail and sealed provenance artifacts', async () => {
    const mismatched = await mkdtemp(join(tmpdir(), 'browserir-paired-tail-mismatch-'));
    temporaryDirectories.push(mismatched);
    const development = completeArtifacts();
    for (const [name, content] of Object.entries(development.artifacts)) {
      await writeFile(join(mismatched, name), content, 'utf8');
    }
    await writeFile(
      join(mismatched, 'SHA256SUMS'),
      renderAgentBenchmarkChecksums(development.artifacts),
      'utf8',
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(mismatched, {
        ...development.input,
        journalFinalEventSha256: 'f'.repeat(64),
      }),
    ).rejects.toThrow(/journal.*tail|final.*event|digest/i);
    await expect(readFile(join(mismatched, 'COMPLETE.json'), 'utf8')).rejects.toThrow();

    const missingBuild = await mkdtemp(join(tmpdir(), 'browserir-paired-missing-build-'));
    temporaryDirectories.push(missingBuild);
    const sealed = completeArtifacts('sealed');
    delete sealed.artifacts['build-provenance-end.json'];
    for (const [name, content] of Object.entries(sealed.artifacts)) {
      await writeFile(join(missingBuild, name), content, 'utf8');
    }
    await writeFile(
      join(missingBuild, 'SHA256SUMS'),
      renderAgentBenchmarkChecksums(sealed.artifacts),
      'utf8',
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(missingBuild, sealed.input),
    ).rejects.toThrow(/build-provenance-end\.json|required artifact/i);
  });

  it('rejects a rehashed journal that claims completion without its scheduled block', async () => {
    const output = await mkdtemp(join(tmpdir(), 'browserir-paired-shortcut-'));
    temporaryDirectories.push(output);
    const { artifacts, input } = completeArtifacts('development', 'shortcut');
    for (const [name, content] of Object.entries(artifacts)) {
      await writeFile(join(output, name), content, 'utf8');
    }
    await writeFile(
      join(output, 'SHA256SUMS'),
      renderAgentBenchmarkChecksums(artifacts),
      'utf8',
    );

    await expect(
      createPairedAgentBenchmarkCompletionMarker(output, input),
    ).rejects.toThrow(/journal|schedule|block|completed/i);
    await expect(readFile(join(output, 'COMPLETE.json'), 'utf8')).rejects.toThrow();
  });

  it('rejects drifted or malformed environment endpoints and their execution binding', async () => {
    const drifted = completeArtifacts();
    const changedEnvironment = executionEnvironment();
    changedEnvironment.host.hardware.logicalCpuCount = 12;
    drifted.artifacts['environment-end.json'] =
      renderPairedExecutionEnvironment(changedEnvironment);
    const driftedOutput = await materializeArtifacts(
      'browserir-paired-environment-drift-',
      drifted.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(driftedOutput, drifted.input),
    ).rejects.toThrow(/environment.*drift|drift.*environment/i);

    const malformed = completeArtifacts();
    malformed.artifacts['environment-end.json'] = '{"snapshot":"end"}\n';
    const malformedOutput = await materializeArtifacts(
      'browserir-paired-environment-malformed-',
      malformed.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(malformedOutput, malformed.input),
    ).rejects.toThrow(/environment.*invalid|invalid.*environment/i);

    const bindingMismatch = completeArtifacts();
    const bindingExecution = JSON.parse(
      bindingMismatch.artifacts['execution.json']!,
    ) as Record<string, unknown>;
    bindingExecution['environment'] = {
      ...(bindingExecution['environment'] as Record<string, unknown>),
      bindingSha256: '0'.repeat(64),
    };
    bindingMismatch.artifacts['execution.json'] = prettyStableJson(bindingExecution);
    const bindingOutput = await materializeArtifacts(
      'browserir-paired-environment-binding-',
      bindingMismatch.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(bindingOutput, bindingMismatch.input),
    ).rejects.toThrow(/environment binding.*differ/i);
  });

  it('requires canonical model metadata endpoints cross-linked to the environment', async () => {
    const missing = completeArtifacts();
    delete missing.artifacts['model-metadata-end.json'];
    const missingOutput = await materializeArtifacts(
      'browserir-paired-model-metadata-missing-',
      missing.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(missingOutput, missing.input),
    ).rejects.toThrow(/model metadata endpoint pair|required artifact/i);

    const forged = completeArtifacts();
    const metadata = JSON.parse(forged.artifacts['model-metadata-end.json']!) as Record<
      string,
      unknown
    >;
    metadata['modelId'] = 'forged-model';
    forged.artifacts['model-metadata-end.json'] = prettyStableJson(metadata);
    const forgedOutput = await materializeArtifacts(
      'browserir-paired-model-metadata-forged-',
      forged.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(forgedOutput, forged.input),
    ).rejects.toThrow(/model metadata.*environment|environment.*model metadata/i);
  });

  it('rejects drifted or malformed sealed build-provenance endpoints', async () => {
    const drifted = completeArtifacts('sealed');
    drifted.artifacts['build-provenance-end.json'] = renderSealedBuildProvenance(
      sealedBuildProvenance('changed'),
    );
    const driftedOutput = await materializeArtifacts(
      'browserir-paired-build-drift-',
      drifted.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(driftedOutput, drifted.input),
    ).rejects.toThrow(/build.*drift|content changed|provenance changed/i);

    const malformed = completeArtifacts('sealed');
    malformed.artifacts['build-provenance-end.json'] = '{"build":"end"}\n';
    const malformedOutput = await materializeArtifacts(
      'browserir-paired-build-malformed-',
      malformed.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(malformedOutput, malformed.input),
    ).rejects.toThrow(/build provenance.*invalid|invalid sealed build provenance/i);

    const bindingMismatch = completeArtifacts('sealed');
    const bindingExecution = JSON.parse(
      bindingMismatch.artifacts['execution.json']!,
    ) as Record<string, unknown>;
    bindingExecution['buildProvenance'] = {
      ...(bindingExecution['buildProvenance'] as Record<string, unknown>),
      startSha256: '0'.repeat(64),
    };
    bindingMismatch.artifacts['execution.json'] = prettyStableJson(bindingExecution);
    const bindingOutput = await materializeArtifacts(
      'browserir-paired-build-binding-',
      bindingMismatch.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(bindingOutput, bindingMismatch.input),
    ).rejects.toThrow(/build provenance binding.*differ/i);
  });

  it('requires exact installed runtime provenance and binds both endpoints', async () => {
    const missing = completeArtifacts('sealed');
    delete missing.artifacts['runtime-provenance-end.json'];
    const missingOutput = await materializeArtifacts(
      'browserir-paired-runtime-missing-',
      missing.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(missingOutput, missing.input),
    ).rejects.toThrow(/runtime-provenance-end\.json|required artifact/i);

    const missingServer = completeArtifacts('sealed');
    const missingServerRuntime = pairedRuntimeProvenance();
    const treatmentUnsigned = {
      schemaVersion: missingServerRuntime.roles.treatment.schemaVersion,
      packages: missingServerRuntime.roles.treatment.packages.filter(
        ({ name }) => name !== '@modelcontextprotocol/server',
      ),
      browser: missingServerRuntime.roles.treatment.browser,
    };
    const treatment = {
      ...treatmentUnsigned,
      sha256: digest(stableJson(treatmentUnsigned)),
    };
    const missingServerRoles = {
      ...missingServerRuntime.roles,
      treatment,
    };
    missingServer.artifacts['runtime-provenance-end.json'] = prettyStableJson({
      schemaVersion: '1.0.0',
      roles: missingServerRoles,
      sha256: digest(
        stableJson({ schemaVersion: '1.0.0', roles: missingServerRoles }),
      ),
    });
    const missingServerOutput = await materializeArtifacts(
      'browserir-paired-runtime-server-missing-',
      missingServer.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(
        missingServerOutput,
        missingServer.input,
      ),
    ).rejects.toThrow(/treatment.*incomplete|incomplete.*treatment/i);

    const drifted = completeArtifacts('sealed');
    drifted.artifacts['runtime-provenance-end.json'] =
      renderPairedRuntimeProvenance(pairedRuntimeProvenance('changed'));
    const driftedOutput = await materializeArtifacts(
      'browserir-paired-runtime-drift-',
      drifted.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(driftedOutput, drifted.input),
    ).rejects.toThrow(/runtime.*drift|content changed|provenance drift/i);

    const browserDrift = completeArtifacts('sealed');
    const browserRuntime = pairedRuntimeProvenance();
    const treatmentBrowserUnsigned = {
      schemaVersion: browserRuntime.roles.treatment.schemaVersion,
      packages: browserRuntime.roles.treatment.packages,
      browser: {
        ...browserRuntime.roles.treatment.browser,
        executableSha256: digest('changed-treatment-browser'),
      },
    };
    const treatmentBrowser = {
      ...treatmentBrowserUnsigned,
      sha256: digest(stableJson(treatmentBrowserUnsigned)),
    };
    const browserRoles = { ...browserRuntime.roles, treatment: treatmentBrowser };
    browserDrift.artifacts['runtime-provenance-end.json'] =
      renderPairedRuntimeProvenance({
        schemaVersion: '1.0.0',
        roles: browserRoles,
        sha256: digest(stableJson({ schemaVersion: '1.0.0', roles: browserRoles })),
      });
    const browserDriftOutput = await materializeArtifacts(
      'browserir-paired-runtime-browser-drift-',
      browserDrift.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(
        browserDriftOutput,
        browserDrift.input,
      ),
    ).rejects.toThrow(/treatment.*Chromium.*content|treatment.*executable/i);

    const bindingMismatch = completeArtifacts('sealed');
    const execution = JSON.parse(
      bindingMismatch.artifacts['execution.json']!,
    ) as Record<string, unknown>;
    execution['runtimeProvenance'] = {
      ...(execution['runtimeProvenance'] as Record<string, unknown>),
      endSha256: '0'.repeat(64),
    };
    bindingMismatch.artifacts['execution.json'] = prettyStableJson(execution);
    const bindingOutput = await materializeArtifacts(
      'browserir-paired-runtime-binding-',
      bindingMismatch.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(bindingOutput, bindingMismatch.input),
    ).rejects.toThrow(/runtime provenance binding.*differ/i);
  });

  it('rejects execution source and tool-catalog cross-link drift', async () => {
    const sourceDrift = completeArtifacts();
    const execution = JSON.parse(sourceDrift.artifacts['execution.json']!) as Record<
      string,
      unknown
    >;
    execution['source'] = {
      ...(execution['source'] as Record<string, unknown>),
      clean: true,
    };
    sourceDrift.artifacts['execution.json'] = prettyStableJson(execution);
    const sourceOutput = await materializeArtifacts(
      'browserir-paired-source-drift-',
      sourceDrift.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(sourceOutput, sourceDrift.input),
    ).rejects.toThrow(/source.*differ|source.*mismatch|source.*drift/i);

    const sealedSourceDrift = completeArtifacts('sealed');
    const sealedExecution = JSON.parse(
      sealedSourceDrift.artifacts['execution.json']!,
    ) as Record<string, unknown>;
    sealedExecution['sourceEnd'] = {
      ...(sealedExecution['sourceEnd'] as Record<string, unknown>),
      freezeRef: 'different-freeze-ref',
    };
    sealedSourceDrift.artifacts['execution.json'] = prettyStableJson(sealedExecution);
    const sealedSourceOutput = await materializeArtifacts(
      'browserir-paired-sealed-source-drift-',
      sealedSourceDrift.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(
        sealedSourceOutput,
        sealedSourceDrift.input,
      ),
    ).rejects.toThrow(/source freezeRef.*drift/i);

    const catalogDrift = completeArtifacts();
    catalogDrift.artifacts['control-tool-catalog.json'] = prettyStableJson([
      ...modelFacingCatalog('control'),
      {
        name: 'browser_click',
        description: 'Click a target.',
        inputSchema: { type: 'object' },
      },
    ]);
    const catalogOutput = await materializeArtifacts(
      'browserir-paired-catalog-drift-',
      catalogDrift.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(catalogOutput, catalogDrift.input),
    ).rejects.toThrow(/catalog.*digest|catalog.*count|tool.*catalog/i);

    const catalogBindingDrift = completeArtifacts();
    const catalogExecution = JSON.parse(
      catalogBindingDrift.artifacts['execution.json']!,
    ) as Record<string, unknown>;
    const finalCatalogs = catalogExecution['toolCatalogs'] as Record<
      string,
      Record<string, unknown>
    >;
    finalCatalogs['control'] = {
      ...finalCatalogs['control'],
      toolCount: 2,
    };
    catalogBindingDrift.artifacts['execution.json'] = prettyStableJson(catalogExecution);
    const catalogBindingOutput = await materializeArtifacts(
      'browserir-paired-catalog-binding-drift-',
      catalogBindingDrift.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(
        catalogBindingOutput,
        catalogBindingDrift.input,
      ),
    ).rejects.toThrow(/execution tool catalogs.*differ/i);
  });

  it('rejects rehashed sealed comparison drift from the frozen protocol', async () => {
    const cases: Array<{
      name: string;
      mutate(comparison: Record<string, unknown>): void;
      error: RegExp;
    }> = [
      {
        name: 'claim-policy',
        mutate(comparison) {
          const policy = comparison['claimPolicy'] as Record<string, unknown>;
          policy['publicationRule'] = 'publish-only-positive';
        },
        error: /claim policy.*protocol|protocol.*claim policy/i,
      },
      {
        name: 'target',
        mutate(comparison) {
          comparison['expectedTargetVersion'] = `sha256:${'f'.repeat(64)}`;
        },
        error: /target.*protocol|protocol.*target/i,
      },
      {
        name: 'schedule',
        mutate(comparison) {
          comparison['scheduleSeed'] = 7;
        },
        error: /schedule.*protocol|protocol.*schedule/i,
      },
      {
        name: 'budget',
        mutate(comparison) {
          comparison['budgets'] = {
            ...(comparison['budgets'] as Record<string, unknown>),
            maxModelTurns: 31,
          };
        },
        error: /budget.*protocol|protocol.*budget/i,
      },
      {
        name: 'arm',
        mutate(comparison) {
          const arms = comparison['arms'] as Array<Record<string, unknown>>;
          arms[0] = { ...arms[0], expectedToolCatalogSha256: '0'.repeat(64) };
        },
        error: /arm.*protocol|protocol.*arm|catalog.*protocol/i,
      },
      {
        name: 'trial-count',
        mutate(comparison) {
          const summary = comparison['summary'] as Record<string, unknown>;
          summary['trialsPerTask'] = 31;
        },
        error: /summary.*protocol|trial.*protocol|protocol.*trial/i,
      },
    ];

    for (const candidate of cases) {
      const sealed = completeArtifacts('sealed');
      const comparison = JSON.parse(sealed.artifacts['comparison.json']!) as Record<
        string,
        unknown
      >;
      candidate.mutate(comparison);
      sealed.artifacts['comparison.json'] = prettyStableJson(comparison);
      const output = await materializeArtifacts(
        `browserir-paired-sealed-${candidate.name}-drift-`,
        sealed.artifacts,
      );
      await expect(
        createPairedAgentBenchmarkCompletionMarker(output, sealed.input),
      ).rejects.toThrow(candidate.error);
    }
  });

  it('rejects rehashed sealed summary and block drift from the journal', async () => {
    const falseHeadline = completeArtifacts('sealed');
    falseHeadline.artifacts['summary.md'] = [
      '# BrowserIR Evidence Drop comparison',
      '',
      '**BrowserIR had higher success across this precommitted workflow/seed schedule.**',
      '',
    ].join('\n');
    const falseHeadlineOutput = await materializeArtifacts(
      'browserir-paired-sealed-false-headline-',
      falseHeadline.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(
        falseHeadlineOutput,
        falseHeadline.input,
      ),
    ).rejects.toThrow(/summary.*comparison headline|headline.*comparison/i);

    const wrongAttemptId = completeArtifacts('sealed', 'complete', (attempt) => {
      attempt['attemptId'] = 'relabelled-run:relabelled-block:control';
    });
    const wrongAttemptIdOutput = await materializeArtifacts(
      'browserir-paired-sealed-wrong-attempt-id-',
      wrongAttemptId.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(
        wrongAttemptIdOutput,
        wrongAttemptId.input,
      ),
    ).rejects.toThrow(/attempt.*frozen task|task.*attempt|attempt.*target/i);

    const wrongModelConfiguration = completeArtifacts(
      'sealed',
      'complete',
      (attempt) => {
        const agent = attempt['agent'] as Record<string, unknown>;
        agent['modelConfigurationSha256'] = '0'.repeat(64);
      },
    );
    const wrongModelConfigurationOutput = await materializeArtifacts(
      'browserir-paired-sealed-wrong-model-configuration-',
      wrongModelConfiguration.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(
        wrongModelConfigurationOutput,
        wrongModelConfiguration.input,
      ),
    ).rejects.toThrow(/agent configuration.*protocol|protocol.*agent configuration/i);

    const forgedPass = completeArtifacts('sealed', 'complete', (attempt) => {
      delete attempt['judge'];
    });
    const forgedPassOutput = await materializeArtifacts(
      'browserir-paired-sealed-forged-pass-',
      forgedPass.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(forgedPassOutput, forgedPass.input),
    ).rejects.toThrow(/passed attempt requires a final judge|trusted outcome evidence/i);

    const summaryDrift = completeArtifacts('sealed');
    const summaryComparison = JSON.parse(
      summaryDrift.artifacts['comparison.json']!,
    ) as Record<string, unknown>;
    const summary = summaryComparison['summary'] as Record<string, unknown>;
    summary['treatmentWins'] = 30;
    summary['bothPassed'] = 0;
    summary['pairedLift'] = {
      ...(summary['pairedLift'] as Record<string, unknown>),
      estimate: 1,
      lower: 0.5,
      upper: 1,
    };
    summaryDrift.artifacts['comparison.json'] = prettyStableJson(summaryComparison);
    const summaryOutput = await materializeArtifacts(
      'browserir-paired-sealed-summary-drift-',
      summaryDrift.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(summaryOutput, summaryDrift.input),
    ).rejects.toThrow(/summary.*journal|journal.*summary|paired lift/i);

    const blockDrift = completeArtifacts('sealed');
    const blockComparison = JSON.parse(
      blockDrift.artifacts['comparison.json']!,
    ) as Record<string, unknown>;
    const blocks = blockComparison['blocks'] as Array<Record<string, unknown>>;
    blocks[0] = { ...blocks[0], outcome: 'treatment_win' };
    blockDrift.artifacts['comparison.json'] = prettyStableJson(blockComparison);
    const blockOutput = await materializeArtifacts(
      'browserir-paired-sealed-block-drift-',
      blockDrift.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(blockOutput, blockDrift.input),
    ).rejects.toThrow(/block.*journal|journal.*block/i);
  });

  it('requires finalized checksums before exposing COMPLETE.json', async () => {
    const output = await mkdtemp(join(tmpdir(), 'browserir-paired-incomplete-'));
    temporaryDirectories.push(output);

    await expect(
      createPairedAgentBenchmarkCompletionMarker(output, {
        runId: 'drop-01-development-run',
        protocolId: 'drop-01-development-v5',
        protocolSha256: 'b'.repeat(64),
        journalFinalEventSha256: 'c'.repeat(64),
      }),
    ).rejects.toThrow(/SHA256SUMS|artifact/i);
    await expect(readPairedAgentBenchmarkCompletionMarker(output)).resolves.toBeUndefined();
  });

  it('strictly parses marker schema and rejects unknown or malformed fields', () => {
    const valid = {
      schemaVersion: '1.0.0',
      state: 'complete',
      runId: 'drop-01-development-run',
      protocolId: 'drop-01-development-v5',
      protocolSha256: 'b'.repeat(64),
      journalFinalEventSha256: 'c'.repeat(64),
      artifactManifestSha256: 'd'.repeat(64),
    };
    expect(parsePairedAgentBenchmarkCompletionMarker(valid)).toEqual(valid);
    expect(() => parsePairedAgentBenchmarkCompletionMarker({ ...valid, extra: true })).toThrow(
      /completion|invalid|unrecognized/i,
    );
    expect(() =>
      parsePairedAgentBenchmarkCompletionMarker({ ...valid, protocolSha256: 'not-a-digest' }),
    ).toThrow(/completion|invalid|digest/i);
  });

  it('fails closed on a corrupt retained COMPLETE.json', async () => {
    const output = await mkdtemp(join(tmpdir(), 'browserir-paired-corrupt-complete-'));
    temporaryDirectories.push(output);
    await writeFile(join(output, 'COMPLETE.json'), '{"state":"complete"}\n', 'utf8');

    await expect(readPairedAgentBenchmarkCompletionMarker(output)).rejects.toThrow(
      /completion|invalid/i,
    );
    expect(await readFile(join(output, 'COMPLETE.json'), 'utf8')).toBe(
      '{"state":"complete"}\n',
    );
  });
});
