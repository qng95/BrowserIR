import { createHash } from 'node:crypto';

import {
  AGENT_BENCHMARK_SCHEMA_VERSION,
  type AgentBenchmarkOptions,
  type AgentBenchmarkOutcome,
  type AgentBenchmarkReport,
  type AgentBenchmarkTaskSummary,
  type AgentRunCompletion,
  type AgentRunErrorCode,
  type AgentRunProgress,
  type AgentToolBroker,
  type AgentToolAdapterRejectionCode,
  type AgentToolCallResult,
  type AgentToolDescriptor,
  type AgentToolMetrics,
  type AgentToolTraceEntry,
  type AgentTrialTarget,
  type AgentTrialFailureKind,
  type AgentTrialResult,
  type BrowserAgentAdapter,
  type DeterministicJudgeResult,
} from './contracts.js';
import { stableJson } from '../environment.js';
import { wilsonInterval } from './statistics.js';
import {
  createSubmissionBroker,
  type AgentSubmissionState,
} from './submission-broker.js';

const positiveInteger = (value: number, label: string): void => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
};

const safeError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 1_000);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const inputKeyPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const actionKindPattern = /^[a-z][a-z0-9_]{0,63}$/;
const errorCodePattern =
  /^(?:[a-z][a-z0-9_]{0,63}|[A-Z][A-Z0-9_]{0,63}|-32[0-9]{3})$/;

const traceInputKeys = (input: Readonly<Record<string, unknown>>): string[] =>
  Object.keys(input)
    .filter((key) => inputKeyPattern.test(key))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

const directActionKindByTool: Readonly<Record<string, string>> = Object.freeze({
  browser_click: 'click',
  browser_drag: 'drag',
  browser_fill_form: 'fill_form',
  browser_handle_dialog: 'handle_dialog',
  browser_hover: 'hover',
  browser_press_key: 'press',
  browser_select_option: 'select',
  browser_type: 'type',
});

const traceActionKind = (
  tool: string,
  input: Readonly<Record<string, unknown>>,
): string | undefined => {
  const action = input['action'];
  const candidate = isRecord(action)
    ? action['kind']
    : action ?? input['kind'] ?? directActionKindByTool[tool];
  return typeof candidate === 'string' && actionKindPattern.test(candidate)
    ? candidate
    : undefined;
};

const safeDiagnosticErrorCode = (value: unknown): string | undefined =>
  typeof value === 'string' && errorCodePattern.test(value) ? value : undefined;

const traceErrorCode = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  const direct = safeDiagnosticErrorCode(value['code']);
  if (direct !== undefined) return direct;
  for (const field of ['error', 'verification_error'] as const) {
    const nested = value[field];
    if (!isRecord(nested)) continue;
    const code = safeDiagnosticErrorCode(nested['code']);
    if (code !== undefined) return code;
  }
  return undefined;
};

const traceResultErrorCode = (result: AgentToolCallResult): string | undefined =>
  traceErrorCode(result.structuredContent) ??
  (result.isError && result.text.startsWith('Input validation error:')
    ? 'input_validation_error'
    : undefined);

const traceInput = (
  tool: string,
  input: Readonly<Record<string, unknown>>,
): Pick<AgentToolTraceEntry, 'inputKeys' | 'actionKind'> => {
  const actionKind = traceActionKind(tool, input);
  return {
    inputKeys: traceInputKeys(input),
    ...(actionKind === undefined ? {} : { actionKind }),
  };
};

class BudgetedToolBroker implements AgentToolBroker {
  #inner: AgentToolBroker;
  #limit: number;
  #attempts = 0;
  #budgetExceeded = false;
  #catalog: readonly AgentToolDescriptor[] | undefined;
  #catalogSha256: string | undefined;
  #responseBytes = 0;
  #screenshots = 0;
  #dispatchedBrowserActions = 0;
  #adapterRejectedCalls = 0;
  readonly #adapterRejectionsByCode: Partial<
    Record<AgentToolAdapterRejectionCode, number>
  > = {};
  readonly #trace: AgentToolTraceEntry[] = [];

  constructor(inner: AgentToolBroker, limit: number) {
    this.#inner = inner;
    this.#limit = limit;
  }

  async listTools(): Promise<readonly AgentToolDescriptor[]> {
    if (this.#catalog !== undefined) return this.#catalog;
    const catalog = await this.#inner.listTools();
    this.#catalog = catalog;
    this.#catalogSha256 = createHash('sha256')
      .update(stableJson(catalog), 'utf8')
      .digest('hex');
    return catalog;
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<AgentToolCallResult> {
    if (this.#attempts >= this.#limit) {
      this.#budgetExceeded = true;
      this.#trace.push({
        index: this.#trace.length,
        tool: name,
        ...traceInput(name, input),
        outcome: 'budget_exceeded',
        durationMs: 0,
        errorCode: 'tool_budget_exceeded',
      });
      throw new Error(`Agent tool-call budget of ${this.#limit} was exceeded.`);
    }
    this.#attempts += 1;
    if (
      name === 'browser_act' ||
      [
        'browser_click',
        'browser_drag',
        'browser_fill_form',
        'browser_handle_dialog',
        'browser_hover',
        'browser_press_key',
        'browser_select_option',
        'browser_type',
      ].includes(name)
    ) {
      this.#dispatchedBrowserActions += 1;
    }
    const traceIndex = this.#trace.length;
    const inputDiagnostic = traceInput(name, input);
    const started = performance.now();
    let result: AgentToolCallResult;
    try {
      result = await this.#inner.callTool(name, input);
    } catch (error) {
      const errorCode = traceErrorCode(error);
      this.#trace.push({
        index: traceIndex,
        tool: name,
        ...inputDiagnostic,
        outcome: 'threw',
        durationMs: Math.round(performance.now() - started),
        ...(errorCode === undefined ? {} : { errorCode }),
      });
      throw error;
    }
    this.#responseBytes += Buffer.byteLength(
      stableJson({
        text: result.text,
        content: result.content,
        structuredContent: result.structuredContent,
        isError: result.isError,
      }),
      'utf8',
    );
    this.#screenshots +=
      result.content?.filter((block) => block.type === 'image').length ?? 0;
    const errorCode = traceResultErrorCode(result);
    this.#trace.push({
      index: traceIndex,
      tool: name,
      ...inputDiagnostic,
      outcome: 'returned',
      durationMs: Math.round(performance.now() - started),
      result: {
        isError: result.isError,
        ...(errorCode === undefined ? {} : { errorCode }),
      },
    });
    return result;
  }

  trace(): readonly AgentToolTraceEntry[] {
    return this.#trace.map((entry) => ({
      ...entry,
      inputKeys: [...entry.inputKeys],
      ...(entry.result === undefined ? {} : { result: { ...entry.result } }),
    }));
  }

  recordAdapterRejection(code: AgentToolAdapterRejectionCode): void {
    this.#adapterRejectedCalls += 1;
    this.#adapterRejectionsByCode[code] =
      (this.#adapterRejectionsByCode[code] ?? 0) + 1;
  }

  metrics(): AgentToolMetrics {
    const metrics = this.#inner.metrics();
    return {
      ...metrics,
      errors: metrics.errors + this.#adapterRejectedCalls,
      budgetExceeded: metrics.budgetExceeded || this.#budgetExceeded,
      ...(this.#adapterRejectedCalls === 0
        ? {}
        : {
            adapterRejectedCalls: this.#adapterRejectedCalls,
            adapterRejectionsByCode: { ...this.#adapterRejectionsByCode },
          }),
      ...(this.#catalogSha256 === undefined
        ? {}
        : {
            toolCatalogSha256: this.#catalogSha256,
            toolCatalogToolCount: this.#catalog?.length ?? 0,
          }),
      responseBytes: this.#responseBytes,
      screenshots: this.#screenshots,
      dispatchedBrowserActions: this.#dispatchedBrowserActions,
    };
  }

  close(): Promise<void> {
    return this.#inner.close();
  }
}

interface AgentRunState {
  status: AgentTrialResult['agentStatus'];
  completion?: AgentRunCompletion | undefined;
  error?: string | undefined;
  errorCode?: AgentRunErrorCode | undefined;
}

const usageKeyPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const publicSafeProgress = (progress: AgentRunProgress): AgentRunCompletion | undefined => {
  if (!Number.isInteger(progress.modelTurns) || progress.modelTurns < 0) return undefined;
  const usage =
    progress.usage === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(progress.usage).filter(
            ([name, value]) =>
              usageKeyPattern.test(name) &&
              typeof value === 'number' &&
              Number.isFinite(value) &&
              value >= 0,
          ),
        );
  return {
    modelTurns: progress.modelTurns,
    ...(usage === undefined || Object.keys(usage).length === 0 ? {} : { usage }),
  };
};

const runErrorCode = (error: unknown): AgentRunErrorCode | undefined => {
  if (error === null || typeof error !== 'object') return undefined;
  return (error as { code?: unknown }).code === 'model_budget_exceeded'
    ? 'model_budget_exceeded'
    : undefined;
};

async function runWithDeadline(
  agent: BrowserAgentAdapter,
  input: Parameters<BrowserAgentAdapter['run']>[0],
  timeoutMs: number,
): Promise<AgentRunState> {
  const controller = new AbortController();
  let partialCompletion: AgentRunCompletion | undefined;
  const runPromise = agent
    .run({
      ...input,
      signal: controller.signal,
      onProgress(progress) {
        const safe = publicSafeProgress(progress);
        if (safe !== undefined) partialCompletion = safe;
      },
    })
    .then<AgentRunState, AgentRunState>(
      (completion) => ({ status: 'completed', completion }),
      (error: unknown) => {
        const errorCode = runErrorCode(error);
        return {
          status: 'errored',
          ...(partialCompletion === undefined ? {} : { completion: partialCompletion }),
          error: safeError(error),
          ...(errorCode === undefined ? {} : { errorCode }),
        };
      },
    );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<AgentRunState>((resolve) => {
    timeout = setTimeout(() => {
      resolve({
        status: 'timed_out',
        ...(partialCompletion === undefined ? {} : { completion: partialCompletion }),
        error: `Agent exceeded ${timeoutMs} ms.`,
      });
      controller.abort(new Error(`Agent exceeded ${timeoutMs} ms.`));
    }, timeoutMs);
  });
  const result = await Promise.race([runPromise, timeoutPromise]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (result.status === 'timed_out') void runPromise.catch(() => {});
  return result;
}

function classifyTrial(input: {
  run: AgentRunState;
  tools: AgentToolMetrics;
  judge: DeterministicJudgeResult;
  maxModelTurns: number;
  submissionRequired: boolean;
  submission: AgentSubmissionState;
}): { outcome: AgentBenchmarkOutcome; failureKind?: AgentTrialFailureKind } {
  if (input.run.status === 'timed_out') {
    return { outcome: 'failed', failureKind: 'agent_timeout' };
  }
  if (input.run.status === 'errored') {
    if (input.run.errorCode === 'model_budget_exceeded') {
      return { outcome: 'failed', failureKind: 'model_budget_exceeded' };
    }
    return { outcome: 'failed', failureKind: 'agent_error' };
  }
  if (input.tools.budgetExceeded) {
    return { outcome: 'failed', failureKind: 'tool_budget_exceeded' };
  }
  if ((input.run.completion?.modelTurns ?? 0) > input.maxModelTurns) {
    return { outcome: 'failed', failureKind: 'model_budget_exceeded' };
  }
  if ((input.tools.policyViolations?.length ?? 0) > 0) {
    return { outcome: 'failed', failureKind: 'policy_violation' };
  }
  if (input.submissionRequired && !input.submission.submitted) {
    return {
      outcome: 'failed',
      failureKind: input.submission.attempts > 0 ? 'submission_invalid' : 'submission_missing',
    };
  }
  if (input.submissionRequired && input.submission.attempts !== 1) {
    return { outcome: 'failed', failureKind: 'submission_invalid' };
  }
  if (input.judge.outcome === 'invalid') {
    return { outcome: 'invalid', failureKind: 'judge_invalid' };
  }
  if (input.judge.outcome !== 'passed') {
    if (
      input.judge.criteria.some(
        (criterion) =>
          criterion.required &&
          !criterion.passed &&
          criterion.id === 'structured-result',
      )
    ) {
      return { outcome: 'failed', failureKind: 'submission_incorrect' };
    }
    return { outcome: 'failed', failureKind: 'oracle_failed' };
  }
  return { outcome: 'passed' };
}

function summarizeTask(taskId: string, trials: readonly AgentTrialResult[]): AgentBenchmarkTaskSummary {
  const selected = trials.filter((trial) => trial.taskId === taskId);
  const passed = selected.filter((trial) => trial.outcome === 'passed').length;
  const failed = selected.filter((trial) => trial.outcome === 'failed').length;
  const invalid = selected.filter((trial) => trial.outcome === 'invalid').length;
  return {
    taskId,
    trials: selected.length,
    passed,
    failed,
    invalid,
    passRate: wilsonInterval(passed, passed + failed),
  };
}

export async function runAgentBenchmark(
  options: AgentBenchmarkOptions,
): Promise<AgentBenchmarkReport> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.runId)) {
    throw new Error('runId must be a non-empty filesystem-safe identifier.');
  }
  if (options.tasks.length === 0) throw new Error('tasks must not be empty.');
  if (new Set(options.tasks.map((task) => task.id)).size !== options.tasks.length) {
    throw new Error('task IDs must be unique.');
  }
  positiveInteger(options.trialsPerTask, 'trialsPerTask');
  positiveInteger(options.budgets.maxDurationMs, 'maxDurationMs');
  positiveInteger(options.budgets.maxToolCalls, 'maxToolCalls');
  positiveInteger(options.budgets.maxModelTurns, 'maxModelTurns');
  if (
    options.expectedToolCatalogSha256 !== undefined &&
    !/^[a-f0-9]{64}$/.test(options.expectedToolCatalogSha256)
  ) {
    throw new Error('expectedToolCatalogSha256 must be a lowercase SHA-256 digest.');
  }

  const trials: AgentTrialResult[] = [];
  for (const task of options.tasks) {
    for (let trialIndex = 0; trialIndex < options.trialsPerTask; trialIndex += 1) {
      const started = performance.now();
      const attemptId = `${options.runId}:${task.id}:${trialIndex}`;
      let target: AgentTrialTarget;
      try {
        target = await options.targetFactory(task, trialIndex);
      } catch (error) {
        trials.push({
          attemptId,
          taskId: task.id,
          taskVersion: task.version,
          trialIndex,
          outcome: 'invalid',
          failureKind: 'target_setup_failed',
          targetId: 'unprovisioned',
          targetVersion: 'unavailable',
          agentStatus: 'not_started',
          agentError: safeError(error),
          submissionAttempts: 0,
          modelTurns: 0,
          durationMs: Math.round(performance.now() - started),
          tools: { calls: 0, errors: 0, byTool: {}, budgetExceeded: false },
          agent: {
            adapterId: 'not-started',
            framework: 'none',
            frameworkVersion: 'none',
            model: 'none',
          },
        });
        continue;
      }
      let agent: BrowserAgentAdapter | undefined;
      let baseline: DeterministicJudgeResult | undefined;
      let finalJudge: DeterministicJudgeResult | undefined;
      let run: AgentRunState = { status: 'not_started' };
      let agentRunDurationMs: number | undefined;
      let cleanupError: string | undefined;
      let agentClosed = false;
      let toolsClosed = false;
      let agentAccessStopped = false;
      let stage: 'baseline' | 'catalog' | 'agent_setup' | 'agent_run' | 'cleanup' | 'judge' = 'baseline';
      const submission = createSubmissionBroker(target.tools, target.submission);
      const tools = new BudgetedToolBroker(submission.broker, options.budgets.maxToolCalls);
      let classified: { outcome: AgentBenchmarkOutcome; failureKind?: AgentTrialFailureKind };

      try {
        if (target.targetVersion !== options.expectedTargetVersion) {
          classified = { outcome: 'invalid', failureKind: 'target_version_mismatch' };
        } else {
          baseline = await target.judge({
            phase: 'baseline',
            submissionAttempts: 0,
            submitted: false,
          });
          if (baseline.outcome === 'passed') {
            classified = { outcome: 'invalid', failureKind: 'baseline_already_passes' };
          } else if (baseline.outcome === 'invalid') {
            classified = { outcome: 'invalid', failureKind: 'baseline_invalid' };
          } else {
            if (options.expectedToolCatalogSha256 !== undefined) {
              stage = 'catalog';
              await tools.listTools();
            }
            if (
              options.expectedToolCatalogSha256 !== undefined &&
              tools.metrics().toolCatalogSha256 !== options.expectedToolCatalogSha256
            ) {
              classified = { outcome: 'invalid', failureKind: 'tool_catalog_mismatch' };
            } else {
              stage = 'agent_setup';
              agent = await options.agentFactory(task, trialIndex);
              stage = 'agent_run';
              const agentRunStarted = performance.now();
              run = await runWithDeadline(
                agent,
                {
                  task,
                  origin: target.origin,
                  tools,
                  signal: new AbortController().signal,
                  budgets: options.budgets,
                },
                options.budgets.maxDurationMs,
              );
              agentRunDurationMs = Math.round(performance.now() - agentRunStarted);
              stage = 'cleanup';
              try {
                await agent.close();
                agentClosed = true;
              } catch (error) {
                cleanupError = `agent close: ${safeError(error)}`;
              }
              try {
                await tools.close();
                toolsClosed = true;
              } catch (error) {
                cleanupError ??= `tool broker close: ${safeError(error)}`;
              }
              try {
                await target.stopAgentAccess();
                agentAccessStopped = true;
              } catch (error) {
                cleanupError ??= `target access stop: ${safeError(error)}`;
              }
              if (cleanupError === undefined) {
                stage = 'judge';
                const submitted = submission.state();
                finalJudge = await target.judge({
                  phase: 'final',
                  submissionAttempts: submitted.attempts,
                  submitted: submitted.submitted,
                  ...(submitted.result === undefined
                    ? {}
                    : { submittedResult: submitted.result }),
                });
                classified = classifyTrial({
                  run,
                  tools: tools.metrics(),
                  judge: finalJudge,
                  maxModelTurns: options.budgets.maxModelTurns,
                  submissionRequired: target.submission !== undefined,
                  submission: submitted,
                });
              } else {
                classified = { outcome: 'invalid', failureKind: 'cleanup_failed' };
              }
            }
          }
        }
      } catch (error) {
        const message = safeError(error);
        if (stage === 'catalog') {
          run = { status: 'not_started', error: message };
          classified = { outcome: 'invalid', failureKind: 'tool_catalog_mismatch' };
        } else if (stage === 'agent_setup') {
          run = { status: 'not_started', error: message };
          classified = { outcome: 'invalid', failureKind: 'agent_setup_failed' };
        } else if (stage === 'judge') {
          run.error ??= message;
          classified = { outcome: 'invalid', failureKind: 'judge_invalid' };
        } else {
          run.error ??= message;
          classified = {
            outcome: 'invalid',
            failureKind: stage === 'baseline' ? 'baseline_invalid' : 'cleanup_failed',
          };
        }
      } finally {
        if (agent !== undefined && !agentClosed) {
          await agent.close().catch(() => {});
        }
        if (!toolsClosed) await tools.close().catch(() => {});
        if (!agentAccessStopped) await target.stopAgentAccess().catch(() => {});
        await target.dispose().catch(() => {});
      }

      const completion = run.completion;
      const submitted = submission.state();
      const metadata = agent?.metadata ?? {
        adapterId: 'not-started',
        framework: 'none',
        frameworkVersion: 'none',
        model: 'none',
      };
      trials.push({
        attemptId,
        taskId: task.id,
        taskVersion: task.version,
        trialIndex,
        outcome: classified.outcome,
        failureKind: classified.failureKind,
        targetId: target.targetId,
        targetVersion: target.targetVersion,
        agentStatus: run.status,
        agentError: cleanupError ?? run.error,
        finalText: completion?.finalText,
        submittedResult: submitted.result,
        submissionAttempts: submitted.attempts,
        modelTurns: completion?.modelTurns ?? 0,
        usage: completion?.usage,
        durationMs: Math.round(performance.now() - started),
        agentRunDurationMs,
        tools: tools.metrics(),
        toolTrace: tools.trace(),
        baseline,
        judge: finalJudge,
        agent: metadata,
      });
    }
  }

  const passed = trials.filter((trial) => trial.outcome === 'passed').length;
  const failed = trials.filter((trial) => trial.outcome === 'failed').length;
  const invalid = trials.filter((trial) => trial.outcome === 'invalid').length;
  const taskSummaries = options.tasks.map((task) => summarizeTask(task.id, trials));
  const validTaskRates = taskSummaries
    .filter((summary) => summary.passRate.trials > 0)
    .map((summary) => summary.passRate.rate);
  return {
    schemaVersion: AGENT_BENCHMARK_SCHEMA_VERSION,
    runId: options.runId,
    expectedTargetVersion: options.expectedTargetVersion,
    budgets: { ...options.budgets },
    summary: {
      tasks: options.tasks.length,
      trials: trials.length,
      passed,
      failed,
      invalid,
      macroPassRate:
        validTaskRates.length === 0
          ? null
          : validTaskRates.reduce((sum, rate) => sum + rate, 0) / validTaskRates.length,
      validTasks: validTaskRates.length,
      invalidRate: trials.length === 0 ? 0 : invalid / trials.length,
      passRate: wilsonInterval(passed, passed + failed),
    },
    taskSummaries,
    trials,
  };
}
