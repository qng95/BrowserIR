import { describe, expect, it } from 'vitest';

import {
  analyzeBrowserIrRetries,
  type BrowserIrRetryAttempt,
} from '../src/agent-benchmark/browserir-retry-analysis.js';

const attempt = (
  taskId: string,
  mode: 'off' | 'auto',
  attemptNumber: number,
  exactOracleSuccess: boolean,
  overrides: Partial<BrowserIrRetryAttempt> = {},
): BrowserIrRetryAttempt => ({
  taskId,
  mode,
  attemptNumber,
  exactOracleSuccess,
  promptTokens: 100,
  completionTokens: 10,
  costUsd: 0.01,
  taskAttemptLatencyMs: 1_000,
  postTerminalCleanupLatencyMs: 0,
  ...overrides,
});

describe('Browser IR fresh-state retry analysis', () => {
  it('computes cumulative pass@k, exact retries, final cost, and cost per success', () => {
    const analysis = analyzeBrowserIrRetries({
      tasks: [{ taskId: 'a' }, { taskId: 'b' }],
      maxRetries: 2,
      attempts: [
        attempt('a', 'off', 1, false, {
          taskAttemptLatencyMs: 100,
          postTerminalCleanupLatencyMs: 20,
        }),
        attempt('a', 'off', 2, true, {
          taskAttemptLatencyMs: 200,
          postTerminalCleanupLatencyMs: 999,
        }),
        attempt('a', 'auto', 1, true, {
          taskAttemptLatencyMs: 150,
          postTerminalCleanupLatencyMs: 999,
        }),
        attempt('b', 'off', 1, false, {
          taskAttemptLatencyMs: 300,
          postTerminalCleanupLatencyMs: 30,
        }),
        attempt('b', 'off', 2, false, {
          taskAttemptLatencyMs: 400,
          postTerminalCleanupLatencyMs: 40,
        }),
        attempt('b', 'off', 3, false, {
          taskAttemptLatencyMs: 500,
          postTerminalCleanupLatencyMs: 999,
        }),
        attempt('b', 'auto', 1, false, {
          taskAttemptLatencyMs: 50,
          postTerminalCleanupLatencyMs: 10,
        }),
        attempt('b', 'auto', 2, true, {
          taskAttemptLatencyMs: 250,
          postTerminalCleanupLatencyMs: 999,
        }),
      ],
    });

    expect(analysis).toMatchObject({
      maxRetries: 2,
      maxAttemptsPerTask: 3,
      tasks: 2,
      physicalModelCalls: 8,
      oracleFeedbackExposedToModel: false,
      arms: {
        off: {
          solved: 1,
          failedAfterMaxRetries: 1,
          attemptsExecuted: 5,
          retriesUsed: 3,
          tasksNeedingRetry: 2,
          successOnAttempt: [0, 1, 0],
          passAtK: [
            { k: 1, solved: 0, rate: 0 },
            { k: 2, solved: 1, rate: 0.5 },
            { k: 3, solved: 1, rate: 0.5 },
          ],
          usage: {
            coverage: 1,
            totalTokens: 550,
            tokensPerSucceededTask: 550,
          },
          cost: {
            coverage: 1,
            totalUsd: 0.05,
            usdPerSucceededTask: 0.05,
          },
          latency: {
            successfulTaskTimeToSuccess: {
              observedTasks: 1,
              totalMs: 320,
              meanMs: 320,
              medianMs: 320,
              p90Ms: 320,
              p95Ms: 320,
            },
            retryExhaustedTaskTimeToTerminal: {
              observedTasks: 1,
              totalMs: 1_270,
              meanMs: 1_270,
            },
          },
          taskResults: [
            {
              taskId: 'a',
              timeToTerminalMs: 320,
              timeToSuccessMs: 320,
              rightCensoredAtRetryCap: false,
            },
            {
              taskId: 'b',
              timeToTerminalMs: 1_270,
              timeToSuccessMs: null,
              rightCensoredAtRetryCap: true,
            },
          ],
        },
        auto: {
          solved: 2,
          failedAfterMaxRetries: 0,
          attemptsExecuted: 3,
          retriesUsed: 1,
          successOnAttempt: [1, 1, 0],
          latency: {
            successfulTaskTimeToSuccess: {
              observedTasks: 2,
              totalMs: 460,
              meanMs: 230,
              medianMs: 230,
              p90Ms: 310,
              p95Ms: 310,
            },
            retryExhaustedTaskTimeToTerminal: {
              observedTasks: 0,
              meanMs: null,
            },
          },
        },
      },
      pairedPassAtK: [
        { k: 1, offSolved: 0, autoSolved: 1, autoMinusOff: 0.5, autoOnly: 1 },
        { k: 2, offSolved: 1, autoSolved: 2, autoMinusOff: 0.5, autoOnly: 1 },
        { k: 3, offSolved: 1, autoSolved: 2, autoMinusOff: 0.5, autoOnly: 1 },
      ],
      pairedSuccessfulTaskLatency: {
        commonSuccessTasks: 1,
        autoFaster: 1,
        offFaster: 0,
        tied: 0,
        meanAutoMinusOffMs: -170,
        medianAutoMinusOffMs: -170,
        taskDeltas: [{
          taskId: 'a',
          offTimeToSuccessMs: 320,
          autoTimeToSuccessMs: 150,
          autoMinusOffMs: -170,
        }],
      },
      economics: {
        costCoverage: 1,
        observedUsd: 0.08,
        finalUsd: 0.08,
        solvedArmTasks: 3,
        usageCoverage: 1,
        observedTokens: 880,
        finalTokens: 880,
      },
    });
    expect(analysis.economics.usdPerSucceededArmTask).toBeCloseTo(0.08 / 3, 12);
    expect(analysis.economics.tokensPerSucceededArmTask).toBeCloseTo(880 / 3, 12);
  });

  it('reports observed totals but withholds final cost-per-success when receipts are incomplete', () => {
    const analysis = analyzeBrowserIrRetries({
      tasks: [{ taskId: 'a' }],
      maxRetries: 0,
      attempts: [
        attempt('a', 'off', 1, true, { costUsd: null }),
        attempt('a', 'auto', 1, true, { promptTokens: null, completionTokens: null }),
      ],
    });

    expect(analysis.arms.off.cost).toMatchObject({
      coveredAttempts: 0,
      coverage: 0,
      observedUsd: 0,
      totalUsd: null,
      usdPerSucceededTask: null,
    });
    expect(analysis.arms.auto.usage).toMatchObject({
      coveredAttempts: 0,
      coverage: 0,
      totalTokens: null,
      tokensPerSucceededTask: null,
    });
    expect(analysis.economics).toMatchObject({
      costCoverage: 0.5,
      finalUsd: null,
      usdPerSucceededArmTask: null,
      usageCoverage: 0.5,
      finalTokens: null,
      tokensPerSucceededArmTask: null,
    });
  });

  it('rejects gaps, early stops, duplicate attempts, and attempts after success', () => {
    const tasks = [{ taskId: 'a' }];
    const auto = [attempt('a', 'auto', 1, true)];
    expect(() => analyzeBrowserIrRetries({
      tasks,
      maxRetries: 2,
      attempts: [attempt('a', 'off', 1, false), attempt('a', 'off', 3, false), ...auto],
    })).toThrow(/contiguous/u);
    expect(() => analyzeBrowserIrRetries({
      tasks,
      maxRetries: 2,
      attempts: [attempt('a', 'off', 1, false), ...auto],
    })).toThrow(/exhausting/u);
    expect(() => analyzeBrowserIrRetries({
      tasks,
      maxRetries: 2,
      attempts: [
        attempt('a', 'off', 1, true), attempt('a', 'off', 2, true), ...auto,
      ],
    })).toThrow(/after success/u);
    expect(() => analyzeBrowserIrRetries({
      tasks,
      maxRetries: 0,
      attempts: [
        attempt('a', 'off', 1, true), attempt('a', 'off', 1, true), ...auto,
      ],
    })).toThrow(/duplicate/u);
    expect(() => analyzeBrowserIrRetries({
      tasks,
      maxRetries: 0,
      attempts: [
        attempt('a', 'off', 1, true, { postTerminalCleanupLatencyMs: -1 }),
        ...auto,
      ],
    })).toThrow(/postTerminalCleanupLatencyMs/u);
  });
});
