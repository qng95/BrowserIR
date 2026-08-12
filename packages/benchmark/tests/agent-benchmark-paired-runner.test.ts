import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createPairedJournal,
  readPairedJournal,
  resumePairedJournal,
  runPairedAgentBenchmark,
  type AgentBenchmarkArm,
  type AgentBenchmarkTask,
  type AgentToolBroker,
  type AgentTrialTarget,
  type BrowserAgentAdapter,
  type DeterministicJudgeResult,
  type PairedAgentBenchmarkClaimPolicy,
  type PairedBenchmarkLifecycleEvent,
} from '../src/agent-benchmark/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const task: AgentBenchmarkTask = {
  id: 'paired-task',
  prompt: 'Complete the requested change.',
  version: 'task-v1',
};

const sealedClaimPolicy: PairedAgentBenchmarkClaimPolicy = {
  decisionRule: {
    minimumScheduledBlocks: 30,
    maximumInvalidBlocks: 1,
    positive: { lowerBoundAbove: 0 },
    negative: { upperBoundBelow: 0 },
    otherwise: 'inconclusive',
  },
  publicationRule: 'publish-regardless-of-sign',
  estimand: 'fixed-workflow-precommitted-seed-schedule',
};

const broker = (): AgentToolBroker => ({
  async listTools() {
    return [];
  },
  async callTool() {
    throw new Error('unused');
  },
  metrics() {
    return { calls: 0, errors: 0, byTool: {}, budgetExceeded: false };
  },
  async close() {},
});

const verdict = (outcome: 'passed' | 'failed'): DeterministicJudgeResult => ({
  outcome,
  oracleVersion: 'oracle-v1',
  stateFingerprint: `${outcome}-fingerprint`,
  criteria: [
    {
      id: 'state',
      required: true,
      passed: outcome === 'passed',
      description: 'Expected state exists.',
    },
  ],
});

const arm = (
  role: AgentBenchmarkArm['role'],
  finalOutcome: 'passed' | 'failed',
  order: string[],
  baselineFingerprint = 'shared-baseline-fingerprint',
): AgentBenchmarkArm => ({
  role,
  id: role === 'control' ? 'playwright-mcp' : 'browserir',
  label: role === 'control' ? 'Playwright MCP' : 'BrowserIR',
  interfaceVersion: role === 'control' ? '0.0.78' : '0.1.0-alpha',
  async targetFactory(_task, trialIndex): Promise<AgentTrialTarget> {
    order.push(`${trialIndex}:${role}`);
    let calls = 0;
    return {
      targetId: `${role}-${trialIndex}`,
      targetVersion: 'fixture-v1',
      origin: 'http://127.0.0.1:1234',
      tools: broker(),
      async judge() {
        const result = verdict(calls++ === 0 ? 'failed' : finalOutcome);
        return calls === 1 ? { ...result, stateFingerprint: baselineFingerprint } : result;
      },
      async stopAgentAccess() {},
      async dispose() {},
    };
  },
  async agentFactory(): Promise<BrowserAgentAdapter> {
    return {
      metadata: {
        adapterId: 'shared-langchain-agent',
        framework: 'langchain-create-agent',
        frameworkVersion: '1.5.5',
        model: 'same-model-snapshot',
        modelConfiguration: { temperature: 0 },
        adapterConfiguration: { imageMode: 'text-only' },
        systemPromptSha256: 'c'.repeat(64),
      },
      async run() {
        return { finalText: 'done', modelTurns: 1 };
      },
      async close() {},
    };
  },
});

describe('paired agent benchmark runner', () => {
  it('counterbalances arm order and retains every matched attempt', async () => {
    const order: string[] = [];
    const report = await runPairedAgentBenchmark({
      runId: 'paired-unit',
      protocolId: 'drop-01-dev-v1',
      protocolSha256: 'a'.repeat(64),
      protocolBinding: 'development',
      phase: 'development',
      scheduleSeed: 42,
      bootstrapSeed: 43,
      bootstrapResamples: 2_000,
      intervalMethod: 'paired-hoeffding-bound',
      tasks: [task],
      trialsPerTask: 4,
      expectedTargetVersion: 'fixture-v1',
      budgets: { maxDurationMs: 1_000, maxToolCalls: 2, maxModelTurns: 2 },
      arms: [arm('control', 'failed', order), arm('treatment', 'passed', order)],
    });

    expect(order).toHaveLength(8);
    expect(order.slice(0, 2)).not.toEqual(order.slice(2, 4));
    expect(report.blocks).toHaveLength(4);
    expect(report.blocks.every((block) => block.outcome === 'treatment_win')).toBe(true);
    expect(report.blocks.every((block) => block.attempts.control.trialIndex === block.trialIndex)).toBe(true);
    expect(report.blocks.every((block) => block.attempts.treatment.trialIndex === block.trialIndex)).toBe(true);
    expect(report.summary).toMatchObject({
      scheduledBlocks: 4,
      validBlocks: 4,
      invalidBlocks: 0,
      treatmentWins: 4,
      controlWins: 0,
      bothPassed: 0,
      bothFailed: 0,
      pairedLift: {
        estimate: 1,
        lower: expect.any(Number),
        upper: 1,
        method: 'paired-hoeffding-bound',
        pairs: 4,
      },
    });
    expect(report.arms.map(({ role, id }) => ({ role, id }))).toEqual([
      { role: 'control', id: 'playwright-mcp' },
      { role: 'treatment', id: 'browserir' },
    ]);
  });

  it('records a sealed run only with a frozen verified protocol binding', async () => {
    const order: string[] = [];
    const events: PairedBenchmarkLifecycleEvent[] = [];
    const sealed = {
      runId: 'paired-sealed',
      protocolId: 'drop-01-sealed-v1',
      protocolSha256: 'a'.repeat(64),
      phase: 'sealed' as const,
      scheduleSeed: 42,
      bootstrapSeed: 43,
      bootstrapResamples: 2_000,
      intervalMethod: 'paired-hoeffding-bound' as const,
      tasks: [task],
      trialsPerTask: 1,
      expectedTargetVersion: 'fixture-v1',
      budgets: { maxDurationMs: 1_000, maxToolCalls: 2, maxModelTurns: 2 },
      arms: [arm('control', 'failed', order), arm('treatment', 'passed', order)] as const,
    };

    await expect(
      runPairedAgentBenchmark({ ...sealed, protocolBinding: 'development' }),
    ).rejects.toThrow(/binding.*phase|phase.*binding/i);

    await expect(
      runPairedAgentBenchmark({
        ...sealed,
        protocolBinding: 'frozen_verified',
      }),
    ).rejects.toThrow(/claim policy/i);

    await expect(
      runPairedAgentBenchmark({
        ...sealed,
        protocolBinding: 'frozen_verified',
        claimPolicy: {
          ...sealedClaimPolicy,
          decisionRule: {
            ...sealedClaimPolicy.decisionRule,
            maximumInvalidBlocks: 2,
          },
        } as unknown as PairedAgentBenchmarkClaimPolicy,
      }),
    ).rejects.toThrow(/claim policy/i);

    const report = await runPairedAgentBenchmark({
      ...sealed,
      protocolBinding: 'frozen_verified',
      claimPolicy: sealedClaimPolicy,
      async eventSink(event) {
        events.push(event);
      },
    });
    expect(report).toMatchObject({
      phase: 'sealed',
      protocolBinding: 'frozen_verified',
      claimPolicy: sealedClaimPolicy,
    });
    expect(events[0]).toMatchObject({
      type: 'run_started',
      phase: 'sealed',
      protocolBinding: 'frozen_verified',
    });
  });

  it('invalidates a matched block whose arms did not start from identical state', async () => {
    const order: string[] = [];
    const report = await runPairedAgentBenchmark({
      runId: 'paired-state-drift',
      protocolId: 'drop-01-dev-v1',
      protocolSha256: 'a'.repeat(64),
      protocolBinding: 'development',
      phase: 'development',
      scheduleSeed: 42,
      bootstrapSeed: 43,
      bootstrapResamples: 2_000,
      intervalMethod: 'paired-hoeffding-bound',
      tasks: [task],
      trialsPerTask: 1,
      expectedTargetVersion: 'fixture-v1',
      budgets: { maxDurationMs: 1_000, maxToolCalls: 2, maxModelTurns: 2 },
      arms: [
        arm('control', 'passed', order, 'control-seed'),
        arm('treatment', 'passed', order, 'treatment-seed'),
      ],
    });

    expect(report.blocks[0]).toMatchObject({
      outcome: 'invalid',
      integrityFailures: ['baseline_state_fingerprint_mismatch'],
    });
    expect(report.summary).toMatchObject({ validBlocks: 0, invalidBlocks: 1 });
    expect(report.summary.arms).toMatchObject({
      control: { attempts: 0 },
      treatment: { attempts: 0 },
    });
    expect(report.summary.operationalArms).toMatchObject({
      control: { attempts: 1, passed: 1 },
      treatment: { attempts: 1, passed: 1 },
    });
    expect(report.summary.pairedLift.estimate).toBeNull();
  });

  it('awaits a public-safe lifecycle event sink around every block and attempt', async () => {
    const order: string[] = [];
    const events: PairedBenchmarkLifecycleEvent[] = [];
    const sentinel = 'SENTINEL-MODEL-TEXT-2398';
    const arms = [
      arm('control', 'failed', order),
      arm('treatment', 'passed', order),
    ] as const;
    for (const candidate of arms) {
      const original = candidate.agentFactory;
      candidate.agentFactory = async (...args) => {
        const agent = await original(...args);
        const run = agent.run.bind(agent);
        agent.run = async (input) => ({ ...(await run(input)), finalText: sentinel });
        return agent;
      };
    }

    await runPairedAgentBenchmark({
      runId: 'paired-events',
      protocolId: 'drop-01-dev-v1',
      protocolSha256: 'a'.repeat(64),
      protocolBinding: 'development',
      phase: 'development',
      scheduleSeed: 42,
      bootstrapSeed: 43,
      bootstrapResamples: 2_000,
      intervalMethod: 'paired-hoeffding-bound',
      tasks: [task],
      trialsPerTask: 1,
      expectedTargetVersion: 'fixture-v1',
      budgets: { maxDurationMs: 1_000, maxToolCalls: 2, maxModelTurns: 2 },
      arms,
      async eventSink(event) {
        events.push(event);
      },
    });

    expect(events.map((event) => event.type)).toEqual([
      'run_started',
      'block_started',
      'attempt_started',
      'attempt_completed',
      'attempt_started',
      'attempt_completed',
      'block_completed',
      'run_completed',
    ]);
    expect(JSON.stringify(events)).not.toContain(sentinel);
    expect(events.filter((event) => event.type === 'attempt_completed')).toHaveLength(2);
  });

  it('does not invoke an arm after its attempt-start event fails to persist', async () => {
    const order: string[] = [];
    await expect(
      runPairedAgentBenchmark({
        runId: 'paired-event-failure',
        protocolId: 'drop-01-dev-v1',
        protocolSha256: 'a'.repeat(64),
        protocolBinding: 'development',
        phase: 'development',
        scheduleSeed: 42,
        bootstrapSeed: 43,
        bootstrapResamples: 2_000,
        intervalMethod: 'paired-hoeffding-bound',
        tasks: [task],
        trialsPerTask: 1,
        expectedTargetVersion: 'fixture-v1',
        budgets: { maxDurationMs: 1_000, maxToolCalls: 2, maxModelTurns: 2 },
        arms: [arm('control', 'failed', order), arm('treatment', 'passed', order)],
        async eventSink(event) {
          if (event.type === 'attempt_started') throw new Error('journal unavailable');
        },
      }),
    ).rejects.toThrow(/journal unavailable/);
    expect(order).toEqual([]);
  });

  it('resumes without rerunning a completed arm and invalidates the interrupted block', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browserir-paired-resume-'));
    temporaryDirectories.push(root);
    const directory = join(root, 'journal');
    const journal = await createPairedJournal(directory);
    const order: string[] = [];
    let started = 0;
    const options = {
      runId: 'paired-resume',
      protocolId: 'drop-01-dev-v1',
      protocolSha256: 'a'.repeat(64),
      protocolBinding: 'development' as const,
      phase: 'development' as const,
      scheduleSeed: 42,
      bootstrapSeed: 43,
      bootstrapResamples: 2_000,
      intervalMethod: 'paired-hoeffding-bound' as const,
      tasks: [task],
      trialsPerTask: 1,
      expectedTargetVersion: 'fixture-v1',
      budgets: { maxDurationMs: 1_000, maxToolCalls: 2, maxModelTurns: 2 },
      arms: [arm('control', 'failed', order), arm('treatment', 'passed', order)] as const,
    };

    await expect(
      runPairedAgentBenchmark({
        ...options,
        async eventSink(event) {
          await journal.append(event);
          if (event.type === 'attempt_started' && ++started === 2) {
            throw new Error('simulated process crash');
          }
        },
      }),
    ).rejects.toThrow(/simulated process crash/);
    expect(order).toHaveLength(1);

    const recovery = await resumePairedJournal(directory);
    const report = await runPairedAgentBenchmark({
      ...options,
      resume: recovery.state,
      eventSink: recovery.journal.append,
    });

    expect(order).toHaveLength(2);
    expect(new Set(order)).toEqual(new Set(['0:control', '0:treatment']));
    expect(report.blocks[0]).toMatchObject({
      outcome: 'invalid',
      integrityFailures: ['interrupted_attempt'],
      recovery: {
        interruptedAttempts: [
          {
            attemptId: expect.stringMatching(/^paired-resume:paired-task:0:/),
            reason: 'process_restart',
          },
        ],
      },
    });
    expect(report.summary).toMatchObject({
      scheduledBlocks: 1,
      validBlocks: 0,
      invalidBlocks: 1,
    });

    const retained = await readPairedJournal(directory);
    expect(retained.complete).toBe(true);
    expect(retained.events.map(({ event }) => event.type)).toEqual([
      'run_started',
      'block_started',
      'attempt_started',
      'attempt_completed',
      'attempt_started',
      'attempt_interrupted',
      'attempt_started',
      'attempt_completed',
      'block_completed',
      'run_completed',
    ]);
  });

  it('reconstructs a completed journal for finalization without invoking either arm', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browserir-paired-finalize-only-'));
    temporaryDirectories.push(root);
    const directory = join(root, 'journal');
    const journal = await createPairedJournal(directory);
    const order: string[] = [];
    const options = {
      runId: 'paired-finalize-only',
      protocolId: 'drop-01-dev-v1',
      protocolSha256: 'a'.repeat(64),
      protocolBinding: 'development' as const,
      phase: 'development' as const,
      scheduleSeed: 42,
      bootstrapSeed: 43,
      bootstrapResamples: 2_000,
      intervalMethod: 'paired-hoeffding-bound' as const,
      tasks: [task],
      trialsPerTask: 1,
      expectedTargetVersion: 'fixture-v1',
      budgets: { maxDurationMs: 1_000, maxToolCalls: 2, maxModelTurns: 2 },
      arms: [arm('control', 'failed', order), arm('treatment', 'passed', order)] as const,
    };
    const first = await runPairedAgentBenchmark({ ...options, eventSink: journal.append });
    expect(order).toHaveLength(2);

    const recovery = await resumePairedJournal(directory);
    expect(recovery.state.complete).toBe(true);
    const reconstructed = await runPairedAgentBenchmark({
      ...options,
      resume: recovery.state,
      eventSink: recovery.journal.append,
    });

    expect(order).toHaveLength(2);
    expect(reconstructed.summary).toEqual(first.summary);
    expect(reconstructed.blocks[0]!.journalAttempts).toEqual(
      first.blocks[0]!.journalAttempts,
    );
    expect((await readPairedJournal(directory)).events).toHaveLength(
      recovery.state.events.length,
    );
  });
});
