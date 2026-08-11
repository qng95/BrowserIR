import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createPairedJournal,
  PAIRED_DEVELOPMENT_JOURNAL_SCHEMA_VERSION,
  PAIRED_JOURNAL_SCHEMA_VERSION,
  readPairedJournal,
  resumePairedJournal,
  toJournalSafeAttempt,
} from '../src/agent-benchmark/paired-journal.js';
import type {
  AgentTrialResult,
  PairedBenchmarkLifecycleEvent,
} from '../src/agent-benchmark/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const safeAttempt = (
  role: 'control' | 'treatment',
  outcome: 'passed' | 'failed',
): ReturnType<typeof toJournalSafeAttempt> =>
  toJournalSafeAttempt({
    attemptId: `dev-run:paired-task:0:${role}`,
    taskId: 'paired-task',
    taskVersion: 'task-v1',
    trialIndex: 0,
    outcome,
    ...(outcome === 'failed' ? { failureKind: 'oracle_failed' } : {}),
    targetId: `${role}-target`,
    targetVersion: 'fixture-v1',
    agentStatus: 'completed',
    submissionAttempts: 1,
    modelTurns: 2,
    durationMs: 50,
    agentRunDurationMs: 40,
    usage: { inputTokens: 100, outputTokens: 20 },
    tools: {
      calls: 3,
      errors: 0,
      byTool: { browser_snapshot: 1, browser_click: 2 },
      budgetExceeded: false,
      toolCatalogSha256: 'b'.repeat(64),
      toolCatalogToolCount: 3,
      responseBytes: 800,
      screenshots: 0,
      dispatchedBrowserActions: 2,
    },
    baseline: {
      outcome: 'failed',
      oracleVersion: 'oracle-v1',
      stateFingerprint: 'shared-baseline',
      criteria: [{ id: 'fresh-state', required: true, passed: false, description: 'fails' }],
    },
    judge: {
      outcome,
      oracleVersion: 'oracle-v1',
      stateFingerprint: `${role}-final`,
      criteria: [
        { id: 'business-state', required: true, passed: outcome === 'passed', description: 'final' },
      ],
    },
    agent: {
      adapterId: 'shared-agent',
      framework: 'langchain-create-agent',
      frameworkVersion: '1.5.5',
      model: 'model-snapshot',
      systemPromptSha256: 'c'.repeat(64),
    },
  });

const lifecycle = (
  phase: 'development' | 'sealed' = 'development',
): PairedBenchmarkLifecycleEvent[] => {
  const control = safeAttempt('control', 'failed');
  const treatment = safeAttempt('treatment', 'passed');
  return [
    {
      type: 'run_started',
      runId: 'dev-run',
      protocolId: 'drop-01-dev-v1',
      protocolSha256: 'a'.repeat(64),
      phase,
      protocolBinding: phase === 'sealed' ? 'frozen_verified' : 'development',
      scheduledBlocks: 1,
    },
    {
      type: 'block_started',
      blockId: 'dev-run:paired-task:0',
      taskId: 'paired-task',
      taskVersion: 'task-v1',
      trialIndex: 0,
      order: ['control', 'treatment'],
    },
    {
      type: 'attempt_started',
      blockId: 'dev-run:paired-task:0',
      attemptId: control.attemptId,
      taskId: 'paired-task',
      trialIndex: 0,
      role: 'control',
    },
    { type: 'attempt_completed', blockId: 'dev-run:paired-task:0', role: 'control', attempt: control },
    {
      type: 'attempt_started',
      blockId: 'dev-run:paired-task:0',
      attemptId: treatment.attemptId,
      taskId: 'paired-task',
      trialIndex: 0,
      role: 'treatment',
    },
    {
      type: 'attempt_completed',
      blockId: 'dev-run:paired-task:0',
      role: 'treatment',
      attempt: treatment,
    },
    {
      type: 'block_completed',
      blockId: 'dev-run:paired-task:0',
      outcome: 'treatment_win',
      integrityFailures: [],
    },
    {
      type: 'run_completed',
      runId: 'dev-run',
      scheduledBlocks: 1,
      completedBlocks: 1,
      validBlocks: 1,
      invalidBlocks: 0,
    },
  ];
};

describe('paired crash journal', () => {
  it('writes atomic create-only hash-chained events and reconstructs a completed run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browserir-journal-'));
    temporaryDirectories.push(root);
    const directory = join(root, 'journal');
    const journal = await createPairedJournal(directory);
    for (const event of lifecycle()) await journal.append(event);

    const names = (await readdir(directory)).filter((name) => !name.startsWith('.')).sort();
    expect(names).toHaveLength(8);
    expect(names[0]).toBe('000000-run_started.json');
    expect(names[7]).toBe('000007-run_completed.json');

    const first = JSON.parse(await readFile(join(directory, names[0]!), 'utf8')) as {
      previousEventSha256: string | null;
      eventSha256: string;
    };
    const second = JSON.parse(await readFile(join(directory, names[1]!), 'utf8')) as {
      previousEventSha256: string;
    };
    expect(first.previousEventSha256).toBeNull();
    expect(second.previousEventSha256).toBe(first.eventSha256);

    const retained = await readPairedJournal(directory);
    expect(retained.complete).toBe(true);
    expect(retained.run).toMatchObject({ runId: 'dev-run', scheduledBlocks: 1 });
    expect(retained.blocks).toHaveLength(1);
    expect(retained.blocks[0]).toMatchObject({
      blockId: 'dev-run:paired-task:0',
      outcome: 'treatment_win',
      attempts: {
        control: { outcome: 'failed' },
        treatment: { outcome: 'passed' },
      },
    });

    await expect(createPairedJournal(directory)).rejects.toThrow(/exist|create-only/i);
  });

  it('retains a sealed run without changing the journal evidence schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browserir-journal-sealed-'));
    temporaryDirectories.push(root);
    const directory = join(root, 'journal');
    const journal = await createPairedJournal(directory);
    for (const event of lifecycle('sealed')) await journal.append(event);

    const retained = await readPairedJournal(directory);
    expect(retained.run).toMatchObject({
      phase: 'sealed',
      protocolBinding: 'frozen_verified',
    });
    expect(retained.events[0]?.schemaVersion).toBe('1.0.0');
    expect(PAIRED_JOURNAL_SCHEMA_VERSION).toBe(
      PAIRED_DEVELOPMENT_JOURNAL_SCHEMA_VERSION,
    );

    const invalidDirectory = join(root, 'invalid-journal');
    const invalid = await createPairedJournal(invalidDirectory);
    const runStarted = lifecycle('sealed')[0]!;
    if (runStarted.type !== 'run_started') throw new Error('Expected run_started fixture.');
    await expect(
      invalid.append({ ...runStarted, protocolBinding: undefined }),
    ).rejects.toThrow(/protocol binding.*phase/i);
  });

  it('retains a valid incomplete development run after a crash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browserir-journal-partial-'));
    temporaryDirectories.push(root);
    const directory = join(root, 'journal');
    const journal = await createPairedJournal(directory);
    for (const event of lifecycle().slice(0, 4)) await journal.append(event);

    const retained = await readPairedJournal(directory);
    expect(retained.complete).toBe(false);
    expect(retained.blocks[0]).toMatchObject({
      blockId: 'dev-run:paired-task:0',
      attempts: { control: { outcome: 'failed' } },
    });
    expect(retained.blocks[0]?.outcome).toBeUndefined();
  });

  it.each(['development', 'sealed'] as const)(
    'resumes the %s hash chain and records an orphaned start as interrupted',
    async (phase) => {
      const root = await mkdtemp(join(tmpdir(), `browserir-journal-resume-${phase}-`));
      temporaryDirectories.push(root);
      const directory = join(root, 'journal');
      const journal = await createPairedJournal(directory);
      for (const event of lifecycle(phase).slice(0, 3)) await journal.append(event);

      const resumed = await resumePairedJournal(directory);

      expect(resumed.state.complete).toBe(false);
      expect(resumed.state.blocks[0]).toMatchObject({
        interruptions: {
          control: [
            {
              attemptId: 'dev-run:paired-task:0:control',
              reason: 'process_restart',
            },
          ],
        },
      });
      expect(resumed.state.blocks[0]?.activeAttempts).toEqual({});

      await resumed.journal.append({
        type: 'attempt_started',
        blockId: 'dev-run:paired-task:0',
        attemptId: 'dev-run:paired-task:0:control',
        taskId: 'paired-task',
        trialIndex: 0,
        role: 'control',
      });

      const names = (await readdir(directory))
        .filter((name) => !name.startsWith('.'))
        .sort();
      expect(names.slice(-2)).toEqual([
        '000003-attempt_interrupted.json',
        '000004-attempt_started.json',
      ]);
      const retained = await readPairedJournal(directory);
      expect(retained.blocks[0]?.activeAttempts).toMatchObject({
        control: { attemptId: 'dev-run:paired-task:0:control' },
      });
    },
  );

  it('fails closed when a committed event is changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browserir-journal-tamper-'));
    temporaryDirectories.push(root);
    const directory = join(root, 'journal');
    const journal = await createPairedJournal(directory);
    for (const event of lifecycle().slice(0, 2)) await journal.append(event);
    const names = (await readdir(directory)).filter((name) => !name.startsWith('.')).sort();
    const secondPath = join(directory, names[1]!);
    const second = JSON.parse(await readFile(secondPath, 'utf8')) as {
      event: { taskId: string };
    };
    second.event.taskId = 'tampered-task';
    await writeFile(secondPath, `${JSON.stringify(second)}\n`, 'utf8');

    await expect(readPairedJournal(directory)).rejects.toThrow(/hash|digest|chain/i);
  });

  it('projects attempts through an explicit public-safe allowlist', () => {
    const sentinel = 'SENTINEL-PRIVATE-CONTENT-7429';
    const contaminated: AgentTrialResult = {
      attemptId: 'dev:task:0:control',
      taskId: 'task',
      trialIndex: 0,
      outcome: 'failed',
      failureKind: 'agent_error',
      targetId: 'target',
      targetVersion: 'fixture-v1',
      agentStatus: 'errored',
      agentError: sentinel,
      finalText: sentinel,
      submittedResult: { secret: sentinel },
      submissionAttempts: 0,
      modelTurns: 1,
      durationMs: 10,
      tools: {
        calls: 1,
        errors: 1,
        byTool: { browser_type: 1 },
        budgetExceeded: false,
        policyViolations: [sentinel],
      },
      toolTrace: [
        {
          index: 0,
          tool: 'browser_type',
          inputKeys: ['text', sentinel],
          actionKind: 'type',
          outcome: 'threw',
          durationMs: 1,
          errorCode: 'provider_error',
          input: { text: sentinel },
        } as never,
      ],
      judge: {
        outcome: 'failed',
        oracleVersion: 'oracle-v1',
        stateFingerprint: 'state',
        reason: sentinel,
        evidence: { secret: sentinel },
        criteria: [
          { id: 'state', required: true, passed: false, description: sentinel, evidence: sentinel },
        ],
      },
      agent: {
        adapterId: 'shared-agent',
        framework: 'langchain',
        frameworkVersion: '1',
        model: 'model',
        modelConfiguration: { secret: sentinel },
        adapterConfiguration: { secret: sentinel },
      },
    };

    const safe = toJournalSafeAttempt(contaminated);
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain(sentinel);
    expect(safe).toMatchObject({
      agentErrorSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      finalTextSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      submittedResultSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      tools: { policyViolationsSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      judge: { reasonSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      agent: {
        modelConfigurationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        adapterConfigurationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(safe.toolTrace?.[0]).toEqual({
      index: 0,
      tool: 'browser_type',
      inputKeys: ['text'],
      actionKind: 'type',
      outcome: 'threw',
      durationMs: 1,
      errorCode: 'provider_error',
    });
  });
});
