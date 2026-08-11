import { describe, expect, it, vi } from 'vitest';

import {
  runAgentBenchmark,
  type AgentBenchmarkTask,
  type AgentSubmissionContract,
  type AgentToolBroker,
  type AgentToolCallResult,
  type AgentToolDescriptor,
  type AgentTrialTarget,
  type BrowserAgentAdapter,
  type DeterministicJudgeResult,
} from '../src/agent-benchmark/index.js';

const task: AgentBenchmarkTask = {
  id: 'change-record',
  prompt: 'Change record A to Done.',
};

class FakeBroker implements AgentToolBroker {
  readonly events: string[];
  readonly #result: AgentToolCallResult;
  #closed = false;
  #calls: string[] = [];
  #errors = 0;

  constructor(
    events: string[],
    result: AgentToolCallResult = { text: 'acted', isError: false },
  ) {
    this.events = events;
    this.#result = result;
  }

  async listTools(): Promise<AgentToolDescriptor[]> {
    if (this.#closed) throw new Error('broker closed');
    return [{ name: 'act', description: 'Act', inputSchema: { type: 'object' } }];
  }

  async callTool(name: string, _arguments: Record<string, unknown>): Promise<AgentToolCallResult> {
    if (this.#closed) throw new Error('broker closed');
    this.events.push(`tool:${name}`);
    this.#calls.push(name);
    return this.#result;
  }

  metrics() {
    return {
      calls: this.#calls.length,
      errors: this.#errors,
      byTool: Object.fromEntries(this.#calls.map((name) => [name, 1])),
      budgetExceeded: false,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.events.push('broker:closed');
  }
}

function judge(outcome: DeterministicJudgeResult['outcome']): DeterministicJudgeResult {
  return {
    outcome,
    oracleVersion: 'oracle-v1',
    stateFingerprint: `${outcome}-fingerprint`,
    criteria: [
      {
        id: 'record-state',
        required: true,
        passed: outcome === 'passed',
        description: 'Record A is Done and one matching audit event exists.',
      },
    ],
  };
}

function targetFactory(input: {
  baseline?: DeterministicJudgeResult['outcome'];
  final?: DeterministicJudgeResult['outcome'];
  events: string[];
  toolResult?: AgentToolCallResult;
}) {
  return async (): Promise<AgentTrialTarget> => {
    const broker = new FakeBroker(input.events, input.toolResult);
    let judgeCalls = 0;
    let accessStopped = false;
    return {
      targetId: 'fixture-instance',
      targetVersion: 'fixture-v1',
      origin: 'http://127.0.0.1:1234',
      tools: broker,
      async judge() {
        input.events.push(`judge:${judgeCalls}`);
        if (judgeCalls > 0 && !accessStopped) {
          throw new Error('final judge ran before agent access stopped');
        }
        const result = judge(judgeCalls === 0 ? input.baseline ?? 'failed' : input.final ?? 'passed');
        judgeCalls += 1;
        return result;
      },
      async stopAgentAccess() {
        accessStopped = true;
        input.events.push('target:stopped');
      },
      async dispose() {
        input.events.push('target:disposed');
      },
    };
  };
}

function agentFactory(
  run: BrowserAgentAdapter['run'],
  onClose?: () => void,
): () => Promise<BrowserAgentAdapter> {
  return async () => ({
    metadata: {
      adapterId: 'fake-agent',
      framework: 'test',
      frameworkVersion: '1',
      model: 'fake-model',
    },
    run,
    async close() {
      onClose?.();
    },
  });
}

const requiredAnswerSubmission: AgentSubmissionContract = {
  description: 'Submit the requested record number.',
  inputSchema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  },
  validateInput(input) {
    return typeof input['answer'] === 'string' ? undefined : 'answer must be a string';
  },
};

const submittedTargetFactory = (expectedAnswer: string) => async () => {
  const base = await targetFactory({ events: [] })();
  return {
    ...base,
    submission: requiredAnswerSubmission,
    async judge(input) {
      const result = await base.judge(input);
      if (input?.phase !== 'final') return result;
      const passed = result.outcome === 'passed' && input.submittedResult?.['answer'] === expectedAnswer;
      return {
        ...result,
        outcome: passed ? 'passed' as const : 'failed' as const,
        criteria: [
          ...result.criteria,
          {
            id: 'structured-result',
            required: true,
            passed,
            description: 'Submitted the exact record number.',
          },
        ],
      };
    },
  } satisfies AgentTrialTarget;
};

describe('agent benchmark runner', () => {
  it('passes only from a failing baseline after agent access is closed and the oracle passes', async () => {
    const events: string[] = [];
    const report = await runAgentBenchmark({
      runId: 'unit-pass',
      tasks: [task],
      trialsPerTask: 1,
      expectedTargetVersion: 'fixture-v1',
      budgets: { maxDurationMs: 1_000, maxToolCalls: 2, maxModelTurns: 4 },
      targetFactory: targetFactory({ events }),
      agentFactory: agentFactory(async ({ tools }) => {
        await tools.callTool('act', {});
        return { finalText: 'I succeeded.', modelTurns: 1 };
      }, () => events.push('agent:closed')),
    });

    expect(report.summary).toMatchObject({
      tasks: 1,
      trials: 1,
      passed: 1,
      failed: 0,
      invalid: 0,
    });
    expect(report.trials[0]).toMatchObject({
      taskId: 'change-record',
      outcome: 'passed',
      agentStatus: 'completed',
      agentRunDurationMs: expect.any(Number),
      judge: { outcome: 'passed' },
      tools: { calls: 1, errors: 0 },
      toolTrace: [
        {
          index: 0,
          tool: 'act',
          inputKeys: [],
          outcome: 'returned',
          result: { isError: false },
        },
      ],
    });
    expect(events).toEqual([
      'judge:0',
      'tool:act',
      'agent:closed',
      'broker:closed',
      'target:stopped',
      'judge:1',
      'target:disposed',
    ]);
  });

  it('records useful tool diagnostics without retaining input values or page text', async () => {
    const sentinel = 'SENTINEL-SECRET-849120';
    const report = await runAgentBenchmark({
      runId: 'unit-safe-tool-trace',
      tasks: [task],
      trialsPerTask: 1,
      expectedTargetVersion: 'fixture-v1',
      budgets: { maxDurationMs: 1_000, maxToolCalls: 2, maxModelTurns: 4 },
      targetFactory: targetFactory({
        events: [],
        toolResult: {
          text: `page contains ${sentinel}`,
          content: [{ type: 'text', text: `model-facing ${sentinel}` }],
          structuredContent: {
            error: { code: 'stale_target', message: `echoed ${sentinel}` },
            page: { text: sentinel },
          },
          isError: true,
        },
      }),
      agentFactory: agentFactory(async ({ tools }) => {
        await tools.callTool('browser_act', {
          browser_id: 'browser-1',
          action: { kind: 'fill', target: 'e1', value: sentinel },
          note: sentinel,
        });
        return { finalText: 'done', modelTurns: 1 };
      }),
    });

    const trace = report.trials[0]!.toolTrace;
    expect(trace).toEqual([
      expect.objectContaining({
        tool: 'browser_act',
        inputKeys: ['action', 'browser_id', 'note'],
        actionKind: 'fill',
        outcome: 'returned',
        result: { isError: true, errorCode: 'stale_target' },
      }),
    ]);
    expect(JSON.stringify(trace)).not.toContain(sentinel);
    expect(JSON.stringify(trace)).not.toContain('page contains');
  });

  it('classifies MCP input validation failures without retaining their messages', async () => {
    const sentinel = 'SENTINEL-VALIDATION-VALUE-1042';
    const report = await runAgentBenchmark({
      runId: 'unit-safe-validation-diagnostic',
      tasks: [task],
      trialsPerTask: 1,
      expectedTargetVersion: 'fixture-v1',
      budgets: { maxDurationMs: 1_000, maxToolCalls: 2, maxModelTurns: 4 },
      targetFactory: targetFactory({
        events: [],
        toolResult: {
          text: `Input validation error: invalid value ${sentinel}`,
          isError: true,
        },
      }),
      agentFactory: agentFactory(async ({ tools }) => {
        await tools.callTool('browser_act', {
          browser_id: 'browser-1',
          action: { kind: 'fill', value: sentinel },
        });
        return { finalText: 'done', modelTurns: 1 };
      }),
    });

    expect(report.trials[0]!.toolTrace).toEqual([
      expect.objectContaining({
        tool: 'browser_act',
        actionKind: 'fill',
        result: { isError: true, errorCode: 'input_validation_error' },
      }),
    ]);
    expect(JSON.stringify(report.trials[0]!.toolTrace)).not.toContain(sentinel);
  });

  it('marks an already-passing baseline invalid and never runs the agent', async () => {
    const events: string[] = [];
    const run = vi.fn<BrowserAgentAdapter['run']>();
    const report = await runAgentBenchmark({
      runId: 'unit-seed-invalid',
      tasks: [task],
      trialsPerTask: 1,
      expectedTargetVersion: 'fixture-v1',
      budgets: { maxDurationMs: 1_000, maxToolCalls: 2, maxModelTurns: 4 },
      targetFactory: targetFactory({ events, baseline: 'passed' }),
      agentFactory: agentFactory(run),
    });

    expect(run).not.toHaveBeenCalled();
    expect(report.trials[0]).toMatchObject({
      outcome: 'invalid',
      failureKind: 'baseline_already_passes',
    });
  });

  it('rejects tool-catalog drift before creating or invoking the model agent', async () => {
    const createAgent = vi.fn<() => Promise<BrowserAgentAdapter>>();
    const report = await runAgentBenchmark({
      runId: 'unit-catalog-drift',
      tasks: [task],
      trialsPerTask: 1,
      expectedTargetVersion: 'fixture-v1',
      expectedToolCatalogSha256: '0'.repeat(64),
      budgets: { maxDurationMs: 1_000, maxToolCalls: 2, maxModelTurns: 4 },
      targetFactory: targetFactory({ events: [] }),
      agentFactory: createAgent,
    });

    expect(createAgent).not.toHaveBeenCalled();
    expect(report.trials[0]).toMatchObject({
      outcome: 'invalid',
      failureKind: 'tool_catalog_mismatch',
      tools: { toolCatalogSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
  });

  it('ignores the agent self-report when the deterministic oracle fails', async () => {
    const report = await runAgentBenchmark({
      runId: 'unit-hallucination',
      tasks: [task],
      trialsPerTask: 1,
      expectedTargetVersion: 'fixture-v1',
      budgets: { maxDurationMs: 1_000, maxToolCalls: 2, maxModelTurns: 4 },
      targetFactory: targetFactory({ events: [], final: 'failed' }),
      agentFactory: agentFactory(async () => ({
        finalText: 'The task is definitely complete.',
        modelTurns: 1,
      })),
    });

    expect(report.trials[0]).toMatchObject({
      outcome: 'failed',
      failureKind: 'oracle_failed',
      agentStatus: 'completed',
      judge: { outcome: 'failed' },
    });
  });

  it('fails a timed-out agent even when its late side effect would satisfy the oracle', async () => {
    const events: string[] = [];
    const report = await runAgentBenchmark({
      runId: 'unit-timeout',
      tasks: [task],
      trialsPerTask: 1,
      expectedTargetVersion: 'fixture-v1',
      budgets: { maxDurationMs: 10, maxToolCalls: 2, maxModelTurns: 4 },
      targetFactory: targetFactory({ events, final: 'passed' }),
      agentFactory: agentFactory(async ({ signal }) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        return { finalText: 'late', modelTurns: 1 };
      }),
    });

    expect(report.trials[0]).toMatchObject({
      outcome: 'failed',
      failureKind: 'agent_timeout',
      agentStatus: 'timed_out',
      judge: { outcome: 'passed' },
    });
  });

  it('enforces the tool-call budget in the trusted broker wrapper', async () => {
    const report = await runAgentBenchmark({
      runId: 'unit-tool-budget',
      tasks: [task],
      trialsPerTask: 1,
      expectedTargetVersion: 'fixture-v1',
      budgets: { maxDurationMs: 1_000, maxToolCalls: 1, maxModelTurns: 4 },
      targetFactory: targetFactory({ events: [] }),
      agentFactory: agentFactory(async ({ tools }) => {
        await tools.callTool('act', {});
        await expect(tools.callTool('act', {})).rejects.toThrow('tool-call budget');
        return { finalText: 'done', modelTurns: 1 };
      }),
    });

    expect(report.trials[0]).toMatchObject({
      outcome: 'failed',
      failureKind: 'tool_budget_exceeded',
      tools: { calls: 1, budgetExceeded: true },
    });
  });

  it('accepts only a trusted structured result submitted through the benchmark tool', async () => {
    const report = await runAgentBenchmark({
      runId: 'unit-structured-submit',
      tasks: [task],
      trialsPerTask: 1,
      expectedTargetVersion: 'fixture-v1',
      budgets: { maxDurationMs: 1_000, maxToolCalls: 2, maxModelTurns: 4 },
      targetFactory: submittedTargetFactory('K-100042'),
      agentFactory: agentFactory(async ({ tools }) => {
        await tools.callTool('benchmark_submit_result', { answer: 'K-100042' });
        return { finalText: 'done', modelTurns: 1 };
      }),
    });

    expect(report.trials[0]).toMatchObject({
      outcome: 'passed',
      submissionAttempts: 1,
      submittedResult: { answer: 'K-100042' },
    });
  });

  it('does not let an adapter spoof submission in its completion object', async () => {
    const report = await runAgentBenchmark({
      runId: 'unit-spoofed-submit',
      tasks: [task],
      trialsPerTask: 1,
      expectedTargetVersion: 'fixture-v1',
      budgets: { maxDurationMs: 1_000, maxToolCalls: 2, maxModelTurns: 4 },
      targetFactory: submittedTargetFactory('K-100042'),
      agentFactory: agentFactory(async () => ({
        finalText: 'done',
        modelTurns: 1,
        submittedResult: { answer: 'K-100042' },
      })),
    });

    expect(report.trials[0]).toMatchObject({
      outcome: 'failed',
      failureKind: 'submission_missing',
      submissionAttempts: 0,
    });
    expect(report.trials[0]?.submittedResult).toBeUndefined();
  });

  it('fails a wrong structured answer even when the state oracle passes', async () => {
    const report = await runAgentBenchmark({
      runId: 'unit-wrong-submit',
      tasks: [task],
      trialsPerTask: 1,
      expectedTargetVersion: 'fixture-v1',
      budgets: { maxDurationMs: 1_000, maxToolCalls: 2, maxModelTurns: 4 },
      targetFactory: submittedTargetFactory('K-100042'),
      agentFactory: agentFactory(async ({ tools }) => {
        await tools.callTool('benchmark_submit_result', { answer: 'K-999999' });
        return { finalText: 'done', modelTurns: 1 };
      }),
    });

    expect(report.trials[0]).toMatchObject({
      outcome: 'failed',
      failureKind: 'submission_incorrect',
      judge: { outcome: 'failed' },
    });
  });

  it('marks a target build mismatch invalid before dispatching the agent', async () => {
    const report = await runAgentBenchmark({
      runId: 'unit-version-mismatch',
      tasks: [task],
      trialsPerTask: 1,
      expectedTargetVersion: 'fixture-v2',
      budgets: { maxDurationMs: 1_000, maxToolCalls: 1, maxModelTurns: 4 },
      targetFactory: targetFactory({ events: [] }),
      agentFactory: agentFactory(async () => ({ finalText: 'unused', modelTurns: 1 })),
    });

    expect(report.trials[0]).toMatchObject({
      outcome: 'invalid',
      failureKind: 'target_version_mismatch',
      targetVersion: 'fixture-v1',
    });
    expect(report.summary).toMatchObject({ validTasks: 0, macroPassRate: null });
  });

  it('records a provisioning failure as an invalid attempt and continues the schedule', async () => {
    let attempt = 0;
    const report = await runAgentBenchmark({
      runId: 'unit-provision-failure',
      tasks: [task],
      trialsPerTask: 2,
      expectedTargetVersion: 'fixture-v1',
      budgets: { maxDurationMs: 1_000, maxToolCalls: 1, maxModelTurns: 4 },
      targetFactory: async () => {
        if (attempt++ === 0) throw new Error('fixture port unavailable');
        return targetFactory({ events: [] })();
      },
      agentFactory: agentFactory(async () => ({ finalText: 'done', modelTurns: 1 })),
    });

    expect(report.summary).toMatchObject({ trials: 2, passed: 1, invalid: 1 });
    expect(report.trials[0]).toMatchObject({
      outcome: 'invalid',
      failureKind: 'target_setup_failed',
      targetId: 'unprovisioned',
      agentStatus: 'not_started',
    });
    expect(report.trials[1]).toMatchObject({ outcome: 'passed' });
  });

  it('records model adapter setup failure without dispatching browser actions', async () => {
    const report = await runAgentBenchmark({
      runId: 'unit-agent-setup-failure',
      tasks: [task],
      trialsPerTask: 1,
      expectedTargetVersion: 'fixture-v1',
      budgets: { maxDurationMs: 1_000, maxToolCalls: 1, maxModelTurns: 4 },
      targetFactory: targetFactory({ events: [] }),
      agentFactory: async () => {
        throw new Error('missing model credentials');
      },
    });

    expect(report.trials[0]).toMatchObject({
      outcome: 'invalid',
      failureKind: 'agent_setup_failed',
      agentStatus: 'not_started',
      tools: { calls: 0 },
    });
  });

  it('validates fixed trial counts and budgets up front', async () => {
    const base = {
      runId: 'invalid-config',
      tasks: [task],
      expectedTargetVersion: 'fixture-v1',
      targetFactory: targetFactory({ events: [] }),
      agentFactory: agentFactory(async () => ({ finalText: 'unused', modelTurns: 1 })),
    };
    await expect(
      runAgentBenchmark({
        ...base,
        trialsPerTask: 0,
        budgets: { maxDurationMs: 1_000, maxToolCalls: 1, maxModelTurns: 4 },
      }),
    ).rejects.toThrow('trialsPerTask');
    await expect(
      runAgentBenchmark({
        ...base,
        trialsPerTask: 1,
        budgets: { maxDurationMs: 0, maxToolCalls: 1, maxModelTurns: 4 },
      }),
    ).rejects.toThrow('maxDurationMs');
  });
});
