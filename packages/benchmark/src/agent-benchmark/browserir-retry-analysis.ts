export const BROWSERIR_RETRY_ANALYSIS_VERSION =
  'browserir-retry-analysis/2' as const;

export const BROWSERIR_RETRY_MODES = Object.freeze(['off', 'auto'] as const);
export type BrowserIrRetryMode = (typeof BROWSERIR_RETRY_MODES)[number];

export interface BrowserIrRetryAttempt {
  readonly taskId: string;
  readonly mode: BrowserIrRetryMode;
  /** One is the initial attempt; values above one are evaluation retries. */
  readonly attemptNumber: number;
  readonly exactOracleSuccess: boolean;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly costUsd: number | null;
  /**
   * End-to-end wall-clock time for this fresh task attempt. This is not the
   * provider/model-call latency: it includes runtime setup, browser/tool work,
   * the model call, and oracle verification. Post-terminal cleanup is excluded.
   */
  readonly taskAttemptLatencyMs: number;
  /** Reset/cleanup after this terminal oracle observation. */
  readonly postTerminalCleanupLatencyMs: number;
}

export interface BrowserIrRetryTask {
  readonly taskId: string;
}

export interface BrowserIrPassAtKPoint {
  readonly k: number;
  readonly solved: number;
  readonly tasks: number;
  readonly rate: number;
}

export interface BrowserIrPairedPassAtKPoint {
  readonly k: number;
  readonly tasks: number;
  readonly offSolved: number;
  readonly autoSolved: number;
  readonly offRate: number;
  readonly autoRate: number;
  readonly autoMinusOff: number;
  readonly autoOnly: number;
  readonly offOnly: number;
  readonly both: number;
  readonly neither: number;
}

export interface BrowserIrRetryArmTaskSummary {
  readonly taskId: string;
  readonly attemptsExecuted: number;
  readonly retriesUsed: number;
  readonly solved: boolean;
  readonly firstSuccessAttempt: number | null;
  readonly failedAfterMaxRetries: boolean;
  /** Sum of this arm's fresh task attempts through its terminal outcome. */
  readonly timeToTerminalMs: number;
  /** Null when the task is right-censored by the retry cap. */
  readonly timeToSuccessMs: number | null;
  readonly rightCensoredAtRetryCap: boolean;
}

export interface BrowserIrTaskLatencyDistribution {
  readonly observedTasks: number;
  readonly totalMs: number;
  readonly meanMs: number | null;
  readonly medianMs: number | null;
  /** Nearest-rank percentile. */
  readonly p90Ms: number | null;
  /** Nearest-rank percentile. */
  readonly p95Ms: number | null;
  readonly minMs: number | null;
  readonly maxMs: number | null;
}

export interface BrowserIrPairedSuccessfulTaskLatency {
  readonly commonSuccessTasks: number;
  readonly autoFaster: number;
  readonly offFaster: number;
  readonly tied: number;
  readonly meanAutoMinusOffMs: number | null;
  readonly medianAutoMinusOffMs: number | null;
  readonly taskDeltas: readonly Readonly<{
    taskId: string;
    offTimeToSuccessMs: number;
    autoTimeToSuccessMs: number;
    autoMinusOffMs: number;
  }>[];
}

export interface BrowserIrRetryArmSummary {
  readonly tasks: number;
  readonly solved: number;
  readonly failedAfterMaxRetries: number;
  readonly attemptsExecuted: number;
  readonly retriesUsed: number;
  readonly tasksNeedingRetry: number;
  readonly meanAttemptsPerTask: number;
  readonly meanRetriesPerTask: number;
  /** Includes the attempts spent on tasks that ultimately failed. */
  readonly attemptsPerSucceededTask: number | null;
  readonly successOnAttempt: readonly number[];
  readonly passAtK: readonly BrowserIrPassAtKPoint[];
  readonly usage: Readonly<{
    coveredAttempts: number;
    coverage: number;
    observedPromptTokens: number;
    observedCompletionTokens: number;
    observedTotalTokens: number;
    totalTokens: number | null;
    tokensPerSucceededTask: number | null;
  }>;
  readonly cost: Readonly<{
    coveredAttempts: number;
    coverage: number;
    observedUsd: number;
    totalUsd: number | null;
    usdPerSucceededTask: number | null;
  }>;
  readonly latency: Readonly<{
    measurement: 'active-task-time-to-terminal-across-fresh-attempts';
    oppositeAbArmTimeIncluded: false;
    retryResetTimeIncluded: true;
    terminalAttemptCleanupIncluded: false;
    successfulTaskTimeToSuccess: BrowserIrTaskLatencyDistribution;
    retryExhaustedTaskTimeToTerminal: BrowserIrTaskLatencyDistribution;
  }>;
  readonly taskResults: readonly BrowserIrRetryArmTaskSummary[];
}

export interface BrowserIrRetryAnalysis {
  readonly schemaVersion: typeof BROWSERIR_RETRY_ANALYSIS_VERSION;
  readonly retryPolicy:
    'fresh-state-evaluator-supervised-stop-on-first-oracle-success';
  readonly oracleFeedbackExposedToModel: false;
  readonly maxRetries: number;
  readonly maxAttemptsPerTask: number;
  readonly tasks: number;
  readonly physicalModelCalls: number;
  readonly arms: Readonly<Record<BrowserIrRetryMode, BrowserIrRetryArmSummary>>;
  readonly pairedPassAtK: readonly BrowserIrPairedPassAtKPoint[];
  /** Restricted to tasks that both arms solved, avoiding survivor-set mismatch. */
  readonly pairedSuccessfulTaskLatency: BrowserIrPairedSuccessfulTaskLatency;
  readonly economics: Readonly<{
    costCoverage: number;
    observedUsd: number;
    finalUsd: number | null;
    solvedArmTasks: number;
    usdPerSucceededArmTask: number | null;
    usageCoverage: number;
    observedTokens: number;
    finalTokens: number | null;
    tokensPerSucceededArmTask: number | null;
  }>;
}

const finiteNonNegative = (value: number, label: string): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number.`);
  }
};

const safeCount = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
};

const taskAttemptKey = (
  taskId: string,
  mode: BrowserIrRetryMode,
  attemptNumber: number,
): string => `${taskId}\u0000${mode}\u0000${attemptNumber}`;

const armTaskAttempts = (
  attempts: readonly BrowserIrRetryAttempt[],
  taskId: string,
  mode: BrowserIrRetryMode,
): readonly BrowserIrRetryAttempt[] => attempts
  .filter((attempt) => attempt.taskId === taskId && attempt.mode === mode)
  .sort((left, right) => left.attemptNumber - right.attemptNumber);

const succeededBy = (
  attempts: readonly BrowserIrRetryAttempt[],
  k: number,
): boolean => attempts.some((attempt) =>
  attempt.attemptNumber <= k && attempt.exactOracleSuccess);

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
};

const nearestRank = (values: readonly number[], percentile: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1]!;
};

const summarizeTaskLatencies = (
  values: readonly number[],
): BrowserIrTaskLatencyDistribution => {
  const totalMs = values.reduce((sum, value) => sum + value, 0);
  return Object.freeze({
    observedTasks: values.length,
    totalMs,
    meanMs: values.length === 0 ? null : totalMs / values.length,
    medianMs: median(values),
    p90Ms: nearestRank(values, 0.9),
    p95Ms: nearestRank(values, 0.95),
    minMs: values.length === 0 ? null : Math.min(...values),
    maxMs: values.length === 0 ? null : Math.max(...values),
  });
};

const summarizeArm = (
  tasks: readonly BrowserIrRetryTask[],
  attempts: readonly BrowserIrRetryAttempt[],
  mode: BrowserIrRetryMode,
  maxAttemptsPerTask: number,
): BrowserIrRetryArmSummary => {
  const taskResults = tasks.map(({ taskId }): BrowserIrRetryArmTaskSummary => {
    const retained = armTaskAttempts(attempts, taskId, mode);
    const firstSuccess = retained.find(({ exactOracleSuccess }) => exactOracleSuccess);
    const timeToTerminalMs = retained.reduce(
      (sum, { taskAttemptLatencyMs, postTerminalCleanupLatencyMs }, index) =>
        sum + taskAttemptLatencyMs +
        (index === retained.length - 1 ? 0 : postTerminalCleanupLatencyMs),
      0,
    );
    return Object.freeze({
      taskId,
      attemptsExecuted: retained.length,
      retriesUsed: retained.length - 1,
      solved: firstSuccess !== undefined,
      firstSuccessAttempt: firstSuccess?.attemptNumber ?? null,
      failedAfterMaxRetries:
        firstSuccess === undefined && retained.length === maxAttemptsPerTask,
      timeToTerminalMs,
      timeToSuccessMs: firstSuccess === undefined ? null : timeToTerminalMs,
      rightCensoredAtRetryCap: firstSuccess === undefined,
    });
  });
  const retainedAttempts = attempts.filter((attempt) => attempt.mode === mode);
  const solved = taskResults.filter((task) => task.solved).length;
  const attemptsExecuted = retainedAttempts.length;
  const retriesUsed = taskResults.reduce((sum, task) => sum + task.retriesUsed, 0);
  const usageCovered = retainedAttempts.filter(({ promptTokens, completionTokens }) =>
    promptTokens !== null && completionTokens !== null);
  const observedPromptTokens = usageCovered.reduce(
    (sum, { promptTokens }) => sum + promptTokens!,
    0,
  );
  const observedCompletionTokens = usageCovered.reduce(
    (sum, { completionTokens }) => sum + completionTokens!,
    0,
  );
  const observedTotalTokens = observedPromptTokens + observedCompletionTokens;
  const costCovered = retainedAttempts.filter(({ costUsd }) => costUsd !== null);
  const observedUsd = costCovered.reduce((sum, { costUsd }) => sum + costUsd!, 0);
  const usageComplete = usageCovered.length === attemptsExecuted;
  const costComplete = costCovered.length === attemptsExecuted;
  const successfulTaskLatencies = taskResults.flatMap(({ timeToSuccessMs }) =>
    timeToSuccessMs === null ? [] : [timeToSuccessMs]);
  const retryExhaustedTaskLatencies = taskResults
    .filter(({ rightCensoredAtRetryCap }) => rightCensoredAtRetryCap)
    .map(({ timeToTerminalMs }) => timeToTerminalMs);
  return Object.freeze({
    tasks: tasks.length,
    solved,
    failedAfterMaxRetries: taskResults.filter((task) => task.failedAfterMaxRetries).length,
    attemptsExecuted,
    retriesUsed,
    tasksNeedingRetry: taskResults.filter(({ attemptsExecuted: count }) => count > 1).length,
    meanAttemptsPerTask: attemptsExecuted / tasks.length,
    meanRetriesPerTask: retriesUsed / tasks.length,
    attemptsPerSucceededTask: solved === 0 ? null : attemptsExecuted / solved,
    successOnAttempt: Object.freeze(Array.from(
      { length: maxAttemptsPerTask },
      (_, index) => taskResults.filter(({ firstSuccessAttempt }) =>
        firstSuccessAttempt === index + 1).length,
    )),
    passAtK: Object.freeze(Array.from(
      { length: maxAttemptsPerTask },
      (_, index): BrowserIrPassAtKPoint => {
        const k = index + 1;
        const solvedAtK = tasks.filter(({ taskId }) =>
          succeededBy(armTaskAttempts(attempts, taskId, mode), k)).length;
        return Object.freeze({ k, solved: solvedAtK, tasks: tasks.length,
          rate: solvedAtK / tasks.length });
      },
    )),
    usage: Object.freeze({
      coveredAttempts: usageCovered.length,
      coverage: usageCovered.length / attemptsExecuted,
      observedPromptTokens,
      observedCompletionTokens,
      observedTotalTokens,
      totalTokens: usageComplete ? observedTotalTokens : null,
      tokensPerSucceededTask:
        usageComplete && solved > 0 ? observedTotalTokens / solved : null,
    }),
    cost: Object.freeze({
      coveredAttempts: costCovered.length,
      coverage: costCovered.length / attemptsExecuted,
      observedUsd,
      totalUsd: costComplete ? observedUsd : null,
      usdPerSucceededTask: costComplete && solved > 0 ? observedUsd / solved : null,
    }),
    latency: Object.freeze({
      measurement: 'active-task-time-to-terminal-across-fresh-attempts',
      oppositeAbArmTimeIncluded: false,
      retryResetTimeIncluded: true,
      terminalAttemptCleanupIncluded: false,
      successfulTaskTimeToSuccess: summarizeTaskLatencies(successfulTaskLatencies),
      retryExhaustedTaskTimeToTerminal: summarizeTaskLatencies(
        retryExhaustedTaskLatencies,
      ),
    }),
    taskResults: Object.freeze(taskResults),
  });
};

export function analyzeBrowserIrRetries(input: Readonly<{
  tasks: readonly BrowserIrRetryTask[];
  attempts: readonly BrowserIrRetryAttempt[];
  maxRetries: number;
}>): BrowserIrRetryAnalysis {
  if (!Number.isSafeInteger(input.maxRetries) || input.maxRetries < 0 || input.maxRetries > 20) {
    throw new Error('maxRetries must be an integer in [0, 20].');
  }
  if (input.tasks.length === 0) throw new Error('Retry analysis requires at least one task.');
  const taskIds = input.tasks.map(({ taskId }) => taskId);
  if (
    taskIds.some((taskId) => taskId.length === 0 || taskId.includes('\u0000')) ||
    new Set(taskIds).size !== taskIds.length
  ) throw new Error('Retry-analysis task IDs must be unique, non-empty, and NUL-free.');
  const taskIdSet = new Set(taskIds);
  const maxAttemptsPerTask = input.maxRetries + 1;
  const seen = new Set<string>();
  for (const attempt of input.attempts) {
    if (!taskIdSet.has(attempt.taskId) || !BROWSERIR_RETRY_MODES.includes(attempt.mode)) {
      throw new Error('Retry attempt is outside the declared task/mode schedule.');
    }
    if (
      !Number.isSafeInteger(attempt.attemptNumber) || attempt.attemptNumber < 1 ||
      attempt.attemptNumber > maxAttemptsPerTask
    ) throw new Error('Retry attempt number is outside maxRetries + 1.');
    const key = taskAttemptKey(attempt.taskId, attempt.mode, attempt.attemptNumber);
    if (seen.has(key)) throw new Error('Retry schedule contains a duplicate physical attempt.');
    seen.add(key);
    if (attempt.promptTokens !== null) safeCount(attempt.promptTokens, 'promptTokens');
    if (attempt.completionTokens !== null) safeCount(attempt.completionTokens, 'completionTokens');
    if (attempt.costUsd !== null) finiteNonNegative(attempt.costUsd, 'costUsd');
    safeCount(attempt.taskAttemptLatencyMs, 'taskAttemptLatencyMs');
    safeCount(
      attempt.postTerminalCleanupLatencyMs,
      'postTerminalCleanupLatencyMs',
    );
  }
  for (const { taskId } of input.tasks) {
    for (const mode of BROWSERIR_RETRY_MODES) {
      const retained = armTaskAttempts(input.attempts, taskId, mode);
      if (retained.length === 0 || retained[0]!.attemptNumber !== 1) {
        throw new Error('Every task/mode must execute its initial attempt.');
      }
      if (retained.some((attempt, index) => attempt.attemptNumber !== index + 1)) {
        throw new Error('Retry attempts must be contiguous from attempt one.');
      }
      const successIndex = retained.findIndex(({ exactOracleSuccess }) => exactOracleSuccess);
      if (successIndex >= 0 && successIndex !== retained.length - 1) {
        throw new Error('Stop-on-success schedule contains an attempt after success.');
      }
      if (successIndex < 0 && retained.length !== maxAttemptsPerTask) {
        throw new Error('Unsolved task/mode stopped before exhausting maxRetries.');
      }
    }
  }
  const arms = Object.freeze(Object.fromEntries(BROWSERIR_RETRY_MODES.map((mode) => [
    mode,
    summarizeArm(input.tasks, input.attempts, mode, maxAttemptsPerTask),
  ])) as unknown as Record<BrowserIrRetryMode, BrowserIrRetryArmSummary>);
  const pairedPassAtK = Object.freeze(Array.from(
    { length: maxAttemptsPerTask },
    (_, index): BrowserIrPairedPassAtKPoint => {
      const k = index + 1;
      const outcomes = input.tasks.map(({ taskId }) => ({
        off: succeededBy(armTaskAttempts(input.attempts, taskId, 'off'), k),
        auto: succeededBy(armTaskAttempts(input.attempts, taskId, 'auto'), k),
      }));
      const offSolved = outcomes.filter(({ off }) => off).length;
      const autoSolved = outcomes.filter(({ auto }) => auto).length;
      const autoOnly = outcomes.filter(({ off, auto }) => !off && auto).length;
      const offOnly = outcomes.filter(({ off, auto }) => off && !auto).length;
      const both = outcomes.filter(({ off, auto }) => off && auto).length;
      const neither = outcomes.filter(({ off, auto }) => !off && !auto).length;
      return Object.freeze({
        k,
        tasks: input.tasks.length,
        offSolved,
        autoSolved,
        offRate: offSolved / input.tasks.length,
        autoRate: autoSolved / input.tasks.length,
        autoMinusOff: (autoSolved - offSolved) / input.tasks.length,
        autoOnly,
        offOnly,
        both,
        neither,
      });
    },
  ));
  const offTaskResults = new Map(arms.off.taskResults.map((task) => [task.taskId, task]));
  const autoTaskResults = new Map(arms.auto.taskResults.map((task) => [task.taskId, task]));
  const successfulTaskLatencyDeltas = input.tasks.flatMap(({ taskId }) => {
    const offTimeToSuccessMs = offTaskResults.get(taskId)?.timeToSuccessMs ?? null;
    const autoTimeToSuccessMs = autoTaskResults.get(taskId)?.timeToSuccessMs ?? null;
    return offTimeToSuccessMs === null || autoTimeToSuccessMs === null
      ? []
      : [Object.freeze({
          taskId,
          offTimeToSuccessMs,
          autoTimeToSuccessMs,
          autoMinusOffMs: autoTimeToSuccessMs - offTimeToSuccessMs,
        })];
  });
  const latencyDeltas = successfulTaskLatencyDeltas.map(({ autoMinusOffMs }) => autoMinusOffMs);
  const pairedSuccessfulTaskLatency = Object.freeze({
    commonSuccessTasks: successfulTaskLatencyDeltas.length,
    autoFaster: successfulTaskLatencyDeltas.filter(({ autoMinusOffMs }) =>
      autoMinusOffMs < 0).length,
    offFaster: successfulTaskLatencyDeltas.filter(({ autoMinusOffMs }) =>
      autoMinusOffMs > 0).length,
    tied: successfulTaskLatencyDeltas.filter(({ autoMinusOffMs }) =>
      autoMinusOffMs === 0).length,
    meanAutoMinusOffMs: latencyDeltas.length === 0
      ? null
      : latencyDeltas.reduce((sum, value) => sum + value, 0) / latencyDeltas.length,
    medianAutoMinusOffMs: median(latencyDeltas),
    taskDeltas: Object.freeze(successfulTaskLatencyDeltas),
  });
  const physicalModelCalls = input.attempts.length;
  const coveredCosts = arms.off.cost.coveredAttempts + arms.auto.cost.coveredAttempts;
  const observedUsd = arms.off.cost.observedUsd + arms.auto.cost.observedUsd;
  const coveredUsage = arms.off.usage.coveredAttempts + arms.auto.usage.coveredAttempts;
  const observedTokens = arms.off.usage.observedTotalTokens +
    arms.auto.usage.observedTotalTokens;
  const solvedArmTasks = arms.off.solved + arms.auto.solved;
  const finalUsd = coveredCosts === physicalModelCalls ? observedUsd : null;
  const finalTokens = coveredUsage === physicalModelCalls ? observedTokens : null;
  return Object.freeze({
    schemaVersion: BROWSERIR_RETRY_ANALYSIS_VERSION,
    retryPolicy: 'fresh-state-evaluator-supervised-stop-on-first-oracle-success',
    oracleFeedbackExposedToModel: false,
    maxRetries: input.maxRetries,
    maxAttemptsPerTask,
    tasks: input.tasks.length,
    physicalModelCalls,
    arms,
    pairedPassAtK,
    pairedSuccessfulTaskLatency,
    economics: Object.freeze({
      costCoverage: coveredCosts / physicalModelCalls,
      observedUsd,
      finalUsd,
      solvedArmTasks,
      usdPerSucceededArmTask:
        finalUsd !== null && solvedArmTasks > 0 ? finalUsd / solvedArmTasks : null,
      usageCoverage: coveredUsage / physicalModelCalls,
      observedTokens,
      finalTokens,
      tokensPerSucceededArmTask:
        finalTokens !== null && solvedArmTasks > 0 ? finalTokens / solvedArmTasks : null,
    }),
  });
}
