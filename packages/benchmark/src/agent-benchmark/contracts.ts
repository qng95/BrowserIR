export const AGENT_BENCHMARK_SCHEMA_VERSION = '1.0.0' as const;

export type AgentBenchmarkOutcome = 'passed' | 'failed' | 'invalid';

export interface AgentBenchmarkTask {
  id: string;
  prompt: string;
  skills?: readonly string[] | undefined;
  version?: string | undefined;
}

export interface AgentToolDescriptor {
  name: string;
  title?: string | undefined;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type AgentToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface AgentToolCallResult {
  text: string;
  /** Exact model-facing MCP text/image blocks. Binary images must never be silently discarded. */
  content?: readonly AgentToolContentBlock[] | undefined;
  structuredContent?: unknown;
  isError: boolean;
}

export interface AgentToolMetrics {
  calls: number;
  errors: number;
  byTool: Readonly<Record<string, number>>;
  budgetExceeded: boolean;
  policyViolations?: readonly string[] | undefined;
  toolCatalogSha256?: string | undefined;
  toolCatalogToolCount?: number | undefined;
  responseBytes?: number | undefined;
  screenshots?: number | undefined;
  dispatchedBrowserActions?: number | undefined;
}

export interface AgentToolTraceEntry {
  index: number;
  tool: string;
  /** Sorted top-level schema keys only. Input values are never retained. */
  inputKeys: readonly string[];
  /** Bounded typed action discriminator when the tool input declares one. */
  actionKind?: string | undefined;
  outcome: 'returned' | 'threw' | 'budget_exceeded';
  durationMs: number;
  result?: {
    isError: boolean;
    /** Stable machine error code only; messages and response bodies are never retained. */
    errorCode?: string | undefined;
  } | undefined;
  /** Stable machine error code for thrown/budget failures; never an error message. */
  errorCode?: string | undefined;
}

export interface AgentToolBroker {
  listTools(): Promise<readonly AgentToolDescriptor[]>;
  callTool(name: string, input: Record<string, unknown>): Promise<AgentToolCallResult>;
  metrics(): AgentToolMetrics;
  close(): Promise<void>;
}

export interface JudgeCriterionResult {
  id: string;
  required: boolean;
  passed: boolean;
  description: string;
  evidence?: unknown;
}

export interface DeterministicJudgeResult {
  outcome: AgentBenchmarkOutcome;
  oracleVersion: string;
  stateFingerprint: string;
  criteria: readonly JudgeCriterionResult[];
  evidence?: unknown;
  reason?: string | undefined;
}

export interface AgentSubmissionContract {
  description: string;
  inputSchema: Record<string, unknown>;
  /** Trusted validation invoked by the harness, never exposed to the model. Return an error message on failure. */
  validateInput(input: Record<string, unknown>): string | undefined;
}

export interface DeterministicJudgeInput {
  phase: 'baseline' | 'final';
  submissionAttempts: number;
  submitted: boolean;
  submittedResult?: Readonly<Record<string, unknown>> | undefined;
}

export interface AgentTrialTarget {
  targetId: string;
  targetVersion: string;
  origin: string;
  tools: AgentToolBroker;
  submission?: AgentSubmissionContract | undefined;
  /** Must be deterministic and read-only. Invoked before and after the agent. */
  judge(input?: DeterministicJudgeInput): Promise<DeterministicJudgeResult>;
  /** Revokes tool/browser access and crosses the target's in-flight request barrier. */
  stopAgentAccess(): Promise<void>;
  dispose(): Promise<void>;
}

export interface AgentAdapterMetadata {
  adapterId: string;
  framework: string;
  frameworkVersion: string;
  model: string;
  modelConfiguration?: Readonly<Record<string, unknown>> | undefined;
  adapterConfiguration?: Readonly<Record<string, unknown>> | undefined;
  systemPromptSha256?: string | undefined;
}

export interface AgentRunInput {
  task: AgentBenchmarkTask;
  origin: string;
  tools: AgentToolBroker;
  signal: AbortSignal;
  budgets: AgentBenchmarkBudgets;
}

export interface AgentRunCompletion {
  finalText?: string | undefined;
  modelTurns: number;
  usage?: Readonly<Record<string, number>> | undefined;
  /** Untrusted adapter metadata only. The runner ignores this for grading; use benchmark_submit_result. */
  submittedResult?: unknown;
}

export interface BrowserAgentAdapter {
  metadata: AgentAdapterMetadata;
  run(input: AgentRunInput): Promise<AgentRunCompletion>;
  close(): Promise<void>;
}

export interface AgentBenchmarkBudgets {
  maxDurationMs: number;
  maxToolCalls: number;
  maxModelTurns: number;
}

export type AgentTrialFailureKind =
  | 'target_setup_failed'
  | 'target_version_mismatch'
  | 'baseline_already_passes'
  | 'baseline_invalid'
  | 'tool_catalog_mismatch'
  | 'agent_setup_failed'
  | 'agent_timeout'
  | 'agent_error'
  | 'tool_budget_exceeded'
  | 'model_budget_exceeded'
  | 'policy_violation'
  | 'submission_missing'
  | 'submission_invalid'
  | 'submission_incorrect'
  | 'oracle_failed'
  | 'judge_invalid'
  | 'cleanup_failed';

export interface AgentTrialResult {
  attemptId: string;
  taskId: string;
  taskVersion?: string | undefined;
  trialIndex: number;
  outcome: AgentBenchmarkOutcome;
  failureKind?: AgentTrialFailureKind | undefined;
  targetId: string;
  targetVersion: string;
  agentStatus: 'not_started' | 'completed' | 'timed_out' | 'errored';
  agentError?: string | undefined;
  finalText?: string | undefined;
  submittedResult?: unknown;
  submissionAttempts: number;
  modelTurns: number;
  usage?: Readonly<Record<string, number>> | undefined;
  durationMs: number;
  /** Model/agent-loop wall time only; excludes target setup, cleanup, and oracle grading. */
  agentRunDurationMs?: number | undefined;
  tools: AgentToolMetrics;
  toolTrace?: readonly AgentToolTraceEntry[] | undefined;
  baseline?: DeterministicJudgeResult | undefined;
  judge?: DeterministicJudgeResult | undefined;
  agent: AgentAdapterMetadata;
}

export interface BinomialInterval {
  successes: number;
  trials: number;
  rate: number;
  lower: number;
  upper: number;
  confidence: 0.95;
  method: 'wilson-score';
}

export interface AgentBenchmarkTaskSummary {
  taskId: string;
  trials: number;
  passed: number;
  failed: number;
  invalid: number;
  passRate: BinomialInterval;
}

export interface AgentBenchmarkReport {
  schemaVersion: typeof AGENT_BENCHMARK_SCHEMA_VERSION;
  runId: string;
  expectedTargetVersion: string;
  budgets: AgentBenchmarkBudgets;
  summary: {
    tasks: number;
    trials: number;
    passed: number;
    failed: number;
    invalid: number;
    /** Equal-weight average of per-task valid-attempt pass rates. */
    /** Equal-weight task pass rate, or null when no task has a valid attempt. */
    macroPassRate: number | null;
    validTasks: number;
    invalidRate: number;
    passRate: BinomialInterval;
  };
  taskSummaries: AgentBenchmarkTaskSummary[];
  trials: AgentTrialResult[];
}

export interface AgentBenchmarkOptions {
  runId: string;
  tasks: readonly AgentBenchmarkTask[];
  trialsPerTask: number;
  expectedTargetVersion: string;
  expectedToolCatalogSha256?: string | undefined;
  budgets: AgentBenchmarkBudgets;
  targetFactory(task: AgentBenchmarkTask, trialIndex: number): Promise<AgentTrialTarget>;
  agentFactory(task: AgentBenchmarkTask, trialIndex: number): Promise<BrowserAgentAdapter>;
}
