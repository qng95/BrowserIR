import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import {
  renderPairedAgentBenchmarkAttemptsNdjson,
  renderPairedAgentBenchmarkJson,
  renderPairedAgentBenchmarkMarkdown,
  toJournalSafeAttempt,
  writePairedAgentBenchmarkArtifacts,
  type PairedAgentBenchmarkReport,
} from '../src/agent-benchmark/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const attempt = (role: 'control' | 'treatment', passed: boolean) => ({
  attemptId: `drop-01:validation-recovery:0:${role}`,
  taskId: 'validation-recovery',
  taskVersion: 'task-v1',
  trialIndex: 0,
  outcome: passed ? 'passed' as const : 'failed' as const,
  ...(passed ? {} : { failureKind: 'oracle_failed' as const }),
  targetId: `${role}-target`,
  targetVersion: 'fixture-v1',
  agentStatus: 'completed' as const,
  submissionAttempts: 1,
  modelTurns: 3,
  durationMs: 500,
  tools: { calls: 4, errors: 0, byTool: {}, budgetExceeded: false },
  agent: {
    adapterId: 'shared-agent',
    framework: 'langchain',
    frameworkVersion: '1.5.5',
    model: 'model-snapshot',
  },
});

const report = (): PairedAgentBenchmarkReport => ({
  schemaVersion: '1.0.0',
  runId: 'drop-01',
  protocolId: 'drop-01-sealed-v1',
  protocolSha256: 'a'.repeat(64),
  protocolBinding: 'frozen_verified',
  phase: 'sealed',
  expectedTargetVersion: 'fixture-v1',
  scheduleSeed: 20260811,
  budgets: { maxDurationMs: 120_000, maxToolCalls: 100, maxModelTurns: 30 },
  arms: [
    { role: 'control', id: 'playwright-mcp', label: 'Playwright MCP', interfaceVersion: '0.0.78' },
    { role: 'treatment', id: 'browserir', label: 'BrowserIR', interfaceVersion: '0.1.0-alpha' },
  ],
  summary: {
    tasks: 1,
    trialsPerTask: 1,
    scheduledBlocks: 1,
    validBlocks: 1,
    invalidBlocks: 0,
    treatmentWins: 1,
    controlWins: 0,
    bothPassed: 0,
    bothFailed: 0,
    pairedLift: {
      estimate: 1,
      lower: 1,
      upper: 1,
      confidence: 0.95,
      method: 'paired-hoeffding-bound',
      pairs: 1,
    },
    arms: {
      control: {
        attempts: 1,
        passed: 0,
        failed: 1,
        invalid: 0,
        passRate: { successes: 0, trials: 1, rate: 0, lower: 0, upper: 0.8, confidence: 0.95, method: 'wilson-score' },
        toolTotals: { calls: 4, errors: 0, responseBytes: 0, screenshots: 0, dispatchedBrowserActions: 0 },
      },
      treatment: {
        attempts: 1,
        passed: 1,
        failed: 0,
        invalid: 0,
        passRate: { successes: 1, trials: 1, rate: 1, lower: 0.2, upper: 1, confidence: 0.95, method: 'wilson-score' },
        toolTotals: { calls: 4, errors: 0, responseBytes: 0, screenshots: 0, dispatchedBrowserActions: 0 },
      },
    },
  },
  blocks: [
    {
      blockId: 'drop-01:validation-recovery:0',
      taskId: 'validation-recovery',
      taskVersion: 'task-v1',
      trialIndex: 0,
      order: ['control', 'treatment'],
      outcome: 'treatment_win',
      attempts: { control: attempt('control', false), treatment: attempt('treatment', true) },
      journalAttempts: {
        control: toJournalSafeAttempt(attempt('control', false)),
        treatment: toJournalSafeAttempt(attempt('treatment', true)),
      },
    },
  ],
});

describe('paired agent benchmark artifacts', () => {
  it('renders canonical machine evidence and a scope-honest human summary', () => {
    expect(JSON.parse(renderPairedAgentBenchmarkJson(report()))).toMatchObject({
      protocolId: 'drop-01-sealed-v1',
      summary: { treatmentWins: 1, pairedLift: { estimate: 1 } },
    });
    const attempts = renderPairedAgentBenchmarkAttemptsNdjson(report())
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { role: string });
    expect(attempts.map(({ role }) => role)).toEqual(['control', 'treatment']);
    const markdown = renderPairedAgentBenchmarkMarkdown(report());
    expect(markdown).toContain('controlled fixture pilot');
    expect(markdown).toContain('Insufficient evidence');
    expect(markdown).toContain('+100.00 percentage points');
    expect(markdown).toContain('Playwright MCP 0.0.78');
  });

  it('allows the frozen positive rule only after the declared minimum schedule', () => {
    const sufficient = report();
    sufficient.blocks = Array.from({ length: 30 }, (_, trialIndex) => ({
      ...sufficient.blocks[0]!,
      blockId: `drop-01:validation-recovery:${trialIndex}`,
      trialIndex,
      attempts: {
        control: { ...attempt('control', false), trialIndex },
        treatment: { ...attempt('treatment', true), trialIndex },
      },
    }));
    sufficient.summary = {
      ...sufficient.summary,
      trialsPerTask: 30,
      scheduledBlocks: 30,
      validBlocks: 30,
      treatmentWins: 30,
      pairedLift: {
        ...sufficient.summary.pairedLift,
        lower: 0.5,
        upper: 1,
        pairs: 30,
      },
    };

    expect(renderPairedAgentBenchmarkMarkdown(sufficient)).toContain(
      'BrowserIR had higher success across this precommitted workflow/seed schedule',
    );
  });

  it('discloses recovered process interruptions in the human report', () => {
    const recovered = report();
    recovered.blocks[0] = {
      ...recovered.blocks[0]!,
      outcome: 'invalid',
      integrityFailures: ['interrupted_attempt'],
      recovery: {
        interruptedAttempts: [
          {
            role: 'control',
            attemptId: 'drop-01:validation-recovery:0:control',
            reason: 'process_restart',
          },
        ],
      },
    };
    recovered.summary = {
      ...recovered.summary,
      validBlocks: 0,
      invalidBlocks: 1,
      treatmentWins: 0,
    };

    expect(renderPairedAgentBenchmarkMarkdown(recovered)).toContain(
      'Recovered process interruptions: 1',
    );
  });

  it('removes secrets and full model-facing page content from public artifacts', () => {
    const contaminated = report();
    const sentinel = 'SENTINEL-SECRET-849120';
    contaminated.blocks[0]!.attempts.control = {
      ...contaminated.blocks[0]!.attempts.control,
      finalText: `finished with ${sentinel}`,
      submittedResult: { password: sentinel },
      agentError: `provider echoed ${sentinel}`,
      toolTrace: [
        {
          index: 0,
          tool: 'browser_type',
          inputKeys: ['text', sentinel],
          actionKind: 'type',
          outcome: 'returned',
          durationMs: 2,
          result: {
            isError: true,
            errorCode: 'stale_target',
          },
          // Simulate a legacy/untrusted report object carrying fields that are no
          // longer part of the safe trace contract. The publisher must ignore them.
          input: { text: sentinel },
          error: `page contains ${sentinel}`,
        },
      ] as unknown as NonNullable<
        PairedAgentBenchmarkReport['blocks'][number]['attempts']['control']['toolTrace']
      >,
      judge: {
        outcome: 'failed',
        oracleVersion: 'oracle-v1',
        stateFingerprint: 'state-v1',
        criteria: [],
        evidence: { password: sentinel },
      },
    };
    contaminated.blocks[0]!.journalAttempts.control = toJournalSafeAttempt(
      contaminated.blocks[0]!.attempts.control,
    );

    const publicArtifacts = [
      renderPairedAgentBenchmarkJson(contaminated),
      renderPairedAgentBenchmarkAttemptsNdjson(contaminated),
      renderPairedAgentBenchmarkMarkdown(contaminated),
    ].join('\n');
    expect(publicArtifacts).not.toContain(sentinel);
    expect(publicArtifacts).toContain('"agentErrorSha256"');
    expect(publicArtifacts).toContain('"submittedResultSha256"');
    expect(publicArtifacts).toContain('"errorCode":"stale_target"');
    expect(publicArtifacts).toContain('"actionKind":"type"');
  });

  it('renders byte-identical public attempts from retained journal evidence after recovery', () => {
    const uninterrupted = report();
    const original = uninterrupted.blocks[0]!.attempts.control;
    uninterrupted.blocks[0]!.attempts.control = {
      ...original,
      agentError: 'private provider error',
      finalText: 'private model text',
      submittedResult: { private: 'submitted value' },
      judge: {
        outcome: 'failed',
        oracleVersion: 'oracle-v1',
        stateFingerprint: 'state-v1',
        criteria: [
          {
            id: 'customer-created',
            required: true,
            passed: false,
            description: 'Customer row must exist.',
            evidence: { private: 'database evidence' },
          },
        ],
      },
      agent: {
        ...original.agent,
        modelConfiguration: { temperature: 0 },
        adapterConfiguration: { imageMode: 'text-only' },
      },
    };
    uninterrupted.blocks[0]!.journalAttempts.control = toJournalSafeAttempt(
      uninterrupted.blocks[0]!.attempts.control,
    );

    const recovered = structuredClone(uninterrupted);
    recovered.blocks[0]!.attempts.control = {
      ...attempt('control', false),
      judge: {
        outcome: 'failed',
        oracleVersion: 'oracle-v1',
        stateFingerprint: 'state-v1',
        criteria: [
          {
            id: 'customer-created',
            required: true,
            passed: false,
            description: '[recovered from digest]',
          },
        ],
      },
    };

    expect(renderPairedAgentBenchmarkJson(recovered)).toBe(
      renderPairedAgentBenchmarkJson(uninterrupted),
    );
    expect(renderPairedAgentBenchmarkAttemptsNdjson(recovered)).toBe(
      renderPairedAgentBenchmarkAttemptsNdjson(uninterrupted),
    );
  });

  it('writes create-only comparison evidence with checksums', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browserir-paired-report-'));
    temporaryDirectories.push(root);
    const output = join(root, 'drop-01');
    const paths = await writePairedAgentBenchmarkArtifacts(output, report(), {
      'protocol.json': '{"protocol":true}\n',
      'system-prompt.txt': 'neutral prompt\n',
      'build-provenance-start.json': '{"build":"start"}\n',
      'build-provenance-end.json': '{"build":"end"}\n',
      'environment-start.json': '{"snapshot":"start"}\n',
      'environment-end.json': '{"snapshot":"end"}\n',
    });
    expect((await readdir(output)).sort()).toEqual([
      'SHA256SUMS',
      'attempts.ndjson',
      'build-provenance-end.json',
      'build-provenance-start.json',
      'comparison.json',
      'environment-end.json',
      'environment-start.json',
      'protocol.json',
      'summary.md',
      'system-prompt.txt',
    ]);
    expect(await readFile(paths.summaryMarkdown, 'utf8')).toContain('Evidence Drop comparison');
    const checksums = await readFile(paths.checksums, 'utf8');
    expect(checksums).toContain('protocol.json');
    expect(checksums).toContain('build-provenance-start.json');
    expect(checksums).toContain('build-provenance-end.json');
    expect(checksums).toContain('environment-start.json');
    expect(checksums).toContain('environment-end.json');
    await expect(
      writePairedAgentBenchmarkArtifacts(output, report(), {
        'protocol.json': '{"protocol":true}\n',
        'system-prompt.txt': 'neutral prompt\n',
        'build-provenance-start.json': '{"build":"start"}\n',
        'build-provenance-end.json': '{"build":"end"}\n',
        'environment-start.json': '{"snapshot":"start"}\n',
        'environment-end.json': '{"snapshot":"end"}\n',
      }),
    ).resolves.toEqual(paths);
  });

  it('continues byte-identical score artifact finalization after partial linking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browserir-paired-partial-finalize-'));
    temporaryDirectories.push(root);
    const output = join(root, 'drop-01');
    const candidate = report();
    await mkdir(output);
    await writeFile(
      join(output, 'comparison.json'),
      renderPairedAgentBenchmarkJson(candidate),
      { encoding: 'utf8', flag: 'wx' },
    );

    await writePairedAgentBenchmarkArtifacts(output, candidate);

    expect((await readdir(output)).sort()).toEqual([
      'SHA256SUMS',
      'attempts.ndjson',
      'comparison.json',
      'summary.md',
    ]);
  });

  it('rejects a changed partially linked score artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browserir-paired-partial-drift-'));
    temporaryDirectories.push(root);
    const output = join(root, 'drop-01');
    await mkdir(output);
    await writeFile(join(output, 'comparison.json'), 'changed\n', {
      encoding: 'utf8',
      flag: 'wx',
    });

    await expect(writePairedAgentBenchmarkArtifacts(output, report())).rejects.toThrow(
      /artifact|differ|drift/i,
    );
    expect(await readFile(join(output, 'comparison.json'), 'utf8')).toBe('changed\n');
  });

  it('finalizes around byte-identical preflight artifacts without overwriting them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browserir-paired-preflight-'));
    temporaryDirectories.push(root);
    const output = join(root, 'drop-01');
    await mkdir(output);
    await writeFile(join(output, 'protocol.json'), '{"protocol":true}\n', {
      encoding: 'utf8',
      flag: 'wx',
    });

    await writePairedAgentBenchmarkArtifacts(output, report(), {
      'protocol.json': '{"protocol":true}\n',
    });

    expect(await readFile(join(output, 'protocol.json'), 'utf8')).toBe('{"protocol":true}\n');
    expect(await readFile(join(output, 'SHA256SUMS'), 'utf8')).toContain('protocol.json');
  });

  it('rejects a changed preflight artifact instead of replacing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browserir-paired-preflight-drift-'));
    temporaryDirectories.push(root);
    const output = join(root, 'drop-01');
    await mkdir(output);
    await writeFile(join(output, 'protocol.json'), 'original\n', {
      encoding: 'utf8',
      flag: 'wx',
    });

    await expect(
      writePairedAgentBenchmarkArtifacts(output, report(), {
        'protocol.json': 'changed\n',
      }),
    ).rejects.toThrow(/preflight|differ|drift/i);
    expect(await readFile(join(output, 'protocol.json'), 'utf8')).toBe('original\n');
  });

  it('rejects unsafe or reserved extra artifact names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browserir-paired-report-extra-'));
    temporaryDirectories.push(root);
    await expect(
      writePairedAgentBenchmarkArtifacts(join(root, 'unsafe'), report(), {
        '../escape.json': 'nope',
      }),
    ).rejects.toThrow(/artifact name/i);
    await expect(
      writePairedAgentBenchmarkArtifacts(join(root, 'reserved'), report(), {
        'summary.md': 'replace',
      }),
    ).rejects.toThrow(/reserved/i);
  });
});
