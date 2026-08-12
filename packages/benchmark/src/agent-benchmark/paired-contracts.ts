import type {
  AgentBenchmarkBudgets,
  AgentBenchmarkOutcome,
  AgentBenchmarkTask,
  AgentToolTraceEntry,
  AgentTrialFailureKind,
  AgentToolMetrics,
  AgentTrialResult,
  AgentTrialTarget,
  BinomialInterval,
  BrowserAgentAdapter,
} from './contracts.js';
import type { ReconstructedPairedRun } from './paired-journal.js';

export const PAIRED_AGENT_BENCHMARK_SCHEMA_VERSION = '1.0.0' as const;

export type AgentBenchmarkArmRole = 'control' | 'treatment';
export type PairedBenchmarkPhase = 'development' | 'sealed';

/** The exact public-claim contract copied from a frozen protocol's analysis block. */
export interface PairedAgentBenchmarkClaimPolicy {
  decisionRule: {
    minimumScheduledBlocks: 30;
    maximumInvalidBlocks: 1;
    positive: { lowerBoundAbove: 0 };
    negative: { upperBoundBelow: 0 };
    otherwise: 'inconclusive';
  };
  publicationRule: 'publish-regardless-of-sign';
  estimand: 'fixed-workflow-precommitted-seed-schedule';
}

export const SEALED_PAIRED_AGENT_BENCHMARK_CLAIM_POLICY = {
  decisionRule: {
    minimumScheduledBlocks: 30,
    maximumInvalidBlocks: 1,
    positive: { lowerBoundAbove: 0 },
    negative: { upperBoundBelow: 0 },
    otherwise: 'inconclusive',
  },
  publicationRule: 'publish-regardless-of-sign',
  estimand: 'fixed-workflow-precommitted-seed-schedule',
} as const satisfies PairedAgentBenchmarkClaimPolicy;

export type PairedBlockOutcome =
  | 'treatment_win'
  | 'control_win'
  | 'both_passed'
  | 'both_failed'
  | 'invalid';

/**
 * Score-bearing attempt evidence safe for an append-only paired journal.
 *
 * This is an explicit allowlist. Model/page text, submitted values, error
 * messages, policy messages, oracle descriptions, and oracle evidence never
 * cross this boundary; optional digests retain integrity without disclosure.
 */
export interface JournalSafeAgentTrialResult {
  attemptId: string;
  taskId: string;
  taskVersion?: string | undefined;
  trialIndex: number;
  outcome: AgentBenchmarkOutcome;
  failureKind?: AgentTrialFailureKind | undefined;
  targetId: string;
  targetVersion: string;
  agentStatus: AgentTrialResult['agentStatus'];
  agentErrorSha256?: string | undefined;
  finalTextSha256?: string | undefined;
  submittedResultSha256?: string | undefined;
  submissionAttempts: number;
  modelTurns: number;
  usage?: Readonly<Record<string, number>> | undefined;
  durationMs: number;
  agentRunDurationMs?: number | undefined;
  tools: {
    calls: number;
    errors: number;
    byTool: Readonly<Record<string, number>>;
    budgetExceeded: boolean;
    adapterRejectedCalls?: number | undefined;
    adapterRejectionsByCode?: AgentToolMetrics['adapterRejectionsByCode'];
    policyViolationCount: number;
    policyViolationsSha256?: string | undefined;
    toolCatalogSha256?: string | undefined;
    toolCatalogToolCount?: number | undefined;
    responseBytes?: number | undefined;
    screenshots?: number | undefined;
    dispatchedBrowserActions?: number | undefined;
  };
  toolTrace?: readonly AgentToolTraceEntry[] | undefined;
  baseline?: JournalSafeJudgeResult | undefined;
  judge?: JournalSafeJudgeResult | undefined;
  agent: {
    adapterId: string;
    framework: string;
    frameworkVersion: string;
    model: string;
    modelConfigurationSha256?: string | undefined;
    adapterConfigurationSha256?: string | undefined;
    systemPromptSha256?: string | undefined;
  };
}

export interface JournalSafeJudgeResult {
  outcome: AgentBenchmarkOutcome;
  oracleVersion: string;
  stateFingerprint: string;
  criteria: readonly {
    id: string;
    required: boolean;
    passed: boolean;
    descriptionSha256: string;
    evidenceSha256?: string | undefined;
  }[];
  evidenceSha256?: string | undefined;
  reasonSha256?: string | undefined;
}

export type PairedBenchmarkLifecycleEvent =
  | {
      type: 'run_started';
      runId: string;
      protocolId: string;
      protocolSha256: string;
      phase: PairedBenchmarkPhase;
      /** Required for sealed journals; optional only for retained legacy development journals. */
      protocolBinding?: 'development' | 'frozen_verified' | undefined;
      scheduledBlocks: number;
    }
  | {
      type: 'block_started';
      blockId: string;
      taskId: string;
      taskVersion?: string | undefined;
      trialIndex: number;
      order: readonly [AgentBenchmarkArmRole, AgentBenchmarkArmRole];
    }
  | {
      type: 'attempt_started';
      blockId: string;
      attemptId: string;
      taskId: string;
      trialIndex: number;
      role: AgentBenchmarkArmRole;
    }
  | {
      type: 'attempt_completed';
      blockId: string;
      role: AgentBenchmarkArmRole;
      attempt: JournalSafeAgentTrialResult;
    }
  | {
      type: 'attempt_interrupted';
      blockId: string;
      attemptId: string;
      taskId: string;
      trialIndex: number;
      role: AgentBenchmarkArmRole;
      reason: 'process_restart';
    }
  | {
      type: 'block_completed';
      blockId: string;
      outcome: PairedBlockOutcome;
      integrityFailures: readonly NonNullable<
        PairedAgentBenchmarkBlock['integrityFailures']
      >[number][];
    }
  | {
      type: 'run_completed';
      runId: string;
      scheduledBlocks: number;
      completedBlocks: number;
      validBlocks: number;
      invalidBlocks: number;
    };

export type PairedBenchmarkEventSink = (
  event: PairedBenchmarkLifecycleEvent,
) => Promise<void>;

export interface AgentBenchmarkArm {
  role: AgentBenchmarkArmRole;
  id: string;
  label: string;
  interfaceVersion: string;
  expectedToolCatalogSha256?: string | undefined;
  targetFactory(task: AgentBenchmarkTask, trialIndex: number): Promise<AgentTrialTarget>;
  agentFactory(task: AgentBenchmarkTask, trialIndex: number): Promise<BrowserAgentAdapter>;
}

interface PairedLiftIntervalBase {
  estimate: number | null;
  lower: number | null;
  upper: number | null;
  confidence: 0.95;
  pairs: number;
}

export type PairedLiftInterval =
  | (PairedLiftIntervalBase & {
      method: 'paired-percentile-bootstrap';
      resamples: number;
      seed: number;
    })
  | (PairedLiftIntervalBase & {
      method: 'paired-hoeffding-bound';
    });

export interface PairedAgentBenchmarkBlock {
  blockId: string;
  taskId: string;
  taskVersion?: string | undefined;
  trialIndex: number;
  order: readonly [AgentBenchmarkArmRole, AgentBenchmarkArmRole];
  outcome: PairedBlockOutcome;
  integrityFailures?: readonly (
    | 'baseline_state_fingerprint_mismatch'
    | 'baseline_oracle_version_mismatch'
    | 'target_version_mismatch'
    | 'task_version_mismatch'
    | 'interrupted_attempt'
  )[] | undefined;
  recovery?: {
    interruptedAttempts: readonly {
      role: AgentBenchmarkArmRole;
      attemptId: string;
      reason: 'process_restart';
    }[];
  } | undefined;
  /**
   * Canonical public-safe score evidence committed to the crash journal.
   *
   * Public artifacts are rendered from this projection, never reconstructed
   * from private model/page diagnostics retained in `attempts`.
   */
  journalAttempts: {
    control: JournalSafeAgentTrialResult;
    treatment: JournalSafeAgentTrialResult;
  };
  attempts: {
    control: AgentTrialResult;
    treatment: AgentTrialResult;
  };
}

export interface PairedArmSummary {
  attempts: number;
  passed: number;
  failed: number;
  invalid: number;
  passRate: BinomialInterval;
  toolTotals: Pick<
    AgentToolMetrics,
    'calls' | 'errors' | 'responseBytes' | 'screenshots' | 'dispatchedBrowserActions'
  >;
}

export interface PairedAgentBenchmarkReport {
  schemaVersion: typeof PAIRED_AGENT_BENCHMARK_SCHEMA_VERSION;
  runId: string;
  protocolId: string;
  protocolSha256: string;
  protocolBinding: 'development' | 'frozen_verified';
  phase: PairedBenchmarkPhase;
  /** Required and exactly validated for sealed reports; optional for development. */
  claimPolicy?: PairedAgentBenchmarkClaimPolicy | undefined;
  expectedTargetVersion: string;
  scheduleSeed: number;
  budgets: AgentBenchmarkBudgets;
  arms: Array<{
    role: AgentBenchmarkArmRole;
    id: string;
    label: string;
    interfaceVersion: string;
    expectedToolCatalogSha256?: string | undefined;
  }>;
  summary: {
    tasks: number;
    trialsPerTask: number;
    scheduledBlocks: number;
    validBlocks: number;
    invalidBlocks: number;
    treatmentWins: number;
    controlWins: number;
    bothPassed: number;
    bothFailed: number;
    pairedLift: PairedLiftInterval;
    arms: {
      control: PairedArmSummary;
      treatment: PairedArmSummary;
    };
    /** All attempts, including the individually valid side of an invalid pair. */
    operationalArms?: {
      control: PairedArmSummary;
      treatment: PairedArmSummary;
    } | undefined;
  };
  blocks: PairedAgentBenchmarkBlock[];
}

export interface PairedAgentBenchmarkOptions {
  runId: string;
  protocolId: string;
  protocolSha256: string;
  protocolBinding: 'development' | 'frozen_verified';
  phase: PairedBenchmarkPhase;
  /** Frozen analysis policy copied into the score-bearing report. */
  claimPolicy?: PairedAgentBenchmarkClaimPolicy | undefined;
  scheduleSeed: number;
  bootstrapSeed: number;
  bootstrapResamples: number;
  intervalMethod: PairedLiftInterval['method'];
  tasks: readonly AgentBenchmarkTask[];
  trialsPerTask: number;
  expectedTargetVersion: string;
  budgets: AgentBenchmarkBudgets;
  arms: readonly [AgentBenchmarkArm, AgentBenchmarkArm];
  /** Awaited before the next lifecycle step; a persistence failure aborts the run. */
  eventSink?: PairedBenchmarkEventSink | undefined;
  /** Validated journal state from the same run. Completed attempts are reused. */
  resume?: ReconstructedPairedRun | undefined;
}
