import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  AgentBenchmarkOptions,
  AgentBenchmarkTask,
} from '../src/agent-benchmark/index.js';
import type { ControlCapabilityProtocol } from '../src/agent-benchmark/control-capability-protocol.js';
import {
  assertControlCapabilitySourceStable,
  controlCapabilityModelMetadataArtifacts,
  createControlCapabilityBenchmarkOptions,
  reserveControlCapabilityOutput,
  runWithControlCapabilityOutputReservation,
  type ControlCapabilitySourceSnapshot,
} from '../src/control-capability-cli.js';

const protocol = {
  schemaVersion: '1.0.0',
  purpose: 'control_capability_qualification',
  scoreEligible: false,
  status: 'frozen',
  protocolId: 'drop-01-control-capability-v1',
  dropId: '01',
  task: {
    id: 'create-customer',
    version: `sha256:${'1'.repeat(64)}`,
    promptSha256: '2'.repeat(64),
    oracleVersion: `sha256:${'3'.repeat(64)}`,
  },
  reservedSealedTaskIds: ['validation-recovery'],
  schedule: {
    attempts: 5,
    modelSeedBase: 20260811,
    stoppingRule: 'run-entire-schedule',
    invalidReplacementPolicy: 'none',
  },
  decisionRule: {
    id: 'complete-five-zero-invalid-at-least-one-pass',
    requiredCompletedAttempts: 5,
    maximumInvalidAttempts: 0,
    minimumPasses: 1,
  },
  budgets: {
    maxDurationMs: 300_000,
    maxToolCalls: 100,
    maxModelTurns: 30,
  },
  agent: {
    framework: 'langchain-create-agent',
    frameworkVersion: '1.5.5',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    modelId: 'qwen/qwen3.8-max',
    canonicalModelSlug: 'qwen/qwen3.8-max-20260803',
    modelMetadataSha256: '4'.repeat(64),
    modelCapabilities: { tools: true, seed: true, temperature: true },
    providerRoute: 'alibaba',
    reasoningEffort: 'low',
    providerPolicy: {
      allowFallbacks: false,
      requireParameters: true,
      dataCollection: 'deny',
    },
    temperature: 0.2,
    maxOutputTokens: 4096,
    maxRetries: 0,
    imageMode: 'text-only',
    systemPrompt: 'Use only the browser tools and submit exactly once.',
    systemPromptSha256: '5'.repeat(64),
  },
  target: {
    expectedVersion: `sha256:${'6'.repeat(64)}`,
    headless: true,
  },
  control: {
    role: 'control',
    id: 'playwright-mcp',
    package: '@playwright/mcp',
    label: 'Official Playwright MCP',
    interfaceVersion: '0.0.78',
    expectedToolCatalogSha256: '7'.repeat(64),
  },
} as unknown as ControlCapabilityProtocol;

describe('control capability CLI lifecycle', () => {
  it('wires all five manifest attempts to the official control catalog', () => {
    const task = { id: 'create-customer' } as AgentBenchmarkTask;
    const targetFactory = vi.fn() as unknown as AgentBenchmarkOptions['targetFactory'];
    const agentFactory = vi.fn() as unknown as AgentBenchmarkOptions['agentFactory'];

    const options = createControlCapabilityBenchmarkOptions({
      runId: 'drop-01-control-v1',
      protocol,
      task,
      targetFactory,
      agentFactory,
    });

    expect(options).toMatchObject({
      runId: 'drop-01-control-v1',
      tasks: [task],
      trialsPerTask: 5,
      expectedTargetVersion: protocol.target.expectedVersion,
      expectedToolCatalogSha256: protocol.control.expectedToolCatalogSha256,
      budgets: protocol.budgets,
      targetFactory,
      agentFactory,
    });
  });

  it('requires clean, identical source identity at the end of the run', () => {
    const source: ControlCapabilitySourceSnapshot = {
      revision: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      clean: true,
    };
    expect(() => assertControlCapabilitySourceStable(source, source)).not.toThrow();
    expect(() =>
      assertControlCapabilitySourceStable(
        source,
        { ...source, tree: 'c'.repeat(40) },
      ),
    ).toThrow(/tree.*drift/i);
    expect(() =>
      assertControlCapabilitySourceStable(source, { ...source, clean: false }),
    ).toThrow(/clean/i);
    expect(() =>
      assertControlCapabilitySourceStable(
        { revision: null, tree: null, clean: true },
        { revision: null, tree: null, clean: true },
      ),
    ).toThrow(/revision|source/i);
  });

  it('atomically reserves output so a collision fails before work begins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browserir-control-cli-'));
    const output = join(root, 'nested', 'run');
    const work = vi.fn();
    try {
      const reservation = await reserveControlCapabilityOutput(output);
      await expect(reserveControlCapabilityOutput(output)).rejects.toThrow(/already.*reserved/i);
      expect(work).not.toHaveBeenCalled();
      expect(reservation.outputDirectory).toBe(output);
      expect((await lstat(output)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains a failed work reservation and blocks replacement at the same path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browserir-control-cli-'));
    const output = join(root, 'run');
    const work = vi.fn(async () => {
      throw new Error('provider failed after reservation');
    });
    try {
      await expect(
        runWithControlCapabilityOutputReservation(output, work),
      ).rejects.toThrow(/provider failed/i);
      expect(work).toHaveBeenCalledOnce();
      expect((await lstat(output)).isDirectory()).toBe(true);
      await expect(reserveControlCapabilityOutput(output)).rejects.toThrow(/already.*reserved/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains distinct start and end model-binding snapshots', () => {
    const artifacts = controlCapabilityModelMetadataArtifacts(
      { phase: 'start', modelId: 'model' },
      { phase: 'end', modelId: 'model' },
    );

    expect(Object.keys(artifacts).sort()).toEqual([
      'model-metadata-end.json',
      'model-metadata-start.json',
    ]);
    expect(artifacts['model-metadata-start.json']).toContain('"phase": "start"');
    expect(artifacts['model-metadata-end.json']).toContain('"phase": "end"');
  });
});
