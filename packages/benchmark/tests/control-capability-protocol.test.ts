import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  parseControlCapabilityProtocol,
  type ControlCapabilityProtocol,
} from '../src/agent-benchmark/control-capability-protocol.js';

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const systemPrompt = 'Use only the provided browser tools and submit exactly once.';

const protocol = (): ControlCapabilityProtocol => ({
  schemaVersion: '1.0.0',
  purpose: 'control_capability_qualification',
  scoreEligible: false,
  status: 'frozen',
  dropId: '01',
  protocolId: 'drop-01-control-capability-openrouter-v1',
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
    providerRoute: 'alibaba',
    reasoningEffort: 'low',
    providerPolicy: {
      allowFallbacks: false,
      requireParameters: true,
      dataCollection: 'deny',
    },
    modelCapabilities: { tools: true, seed: true, temperature: true },
    temperature: 0.2,
    maxOutputTokens: 4096,
    maxRetries: 0,
    imageMode: 'text-only',
    systemPrompt,
    systemPromptSha256: sha256(systemPrompt),
  },
  target: {
    expectedVersion: `sha256:${'5'.repeat(64)}`,
    headless: true,
  },
  control: {
    role: 'control',
    id: 'playwright-mcp',
    package: '@playwright/mcp',
    label: 'Official Playwright MCP',
    interfaceVersion: '0.0.78',
    expectedToolCatalogSha256: '6'.repeat(64),
  },
});

describe('control capability protocol', () => {
  it('accepts a frozen, score-excluded OpenRouter qualification', () => {
    expect(parseControlCapabilityProtocol(protocol())).toEqual(protocol());
  });

  it('accepts an exactly identified Ollama qualification', () => {
    const candidate = protocol();
    candidate.agent = {
      framework: 'langchain-create-agent',
      frameworkVersion: '1.5.5',
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      modelId: 'browserir-qwen3-4b-32k:drop01-dev',
      modelDigest: `sha256:${'7'.repeat(64)}`,
      contextWindowTokens: 32_768,
      modelCapabilities: { tools: true, seed: true, temperature: true },
      temperature: 0,
      maxOutputTokens: 4096,
      maxRetries: 0,
      imageMode: 'text-only',
      systemPrompt,
      systemPromptSha256: sha256(systemPrompt),
    };

    expect(parseControlCapabilityProtocol(candidate).agent.provider).toBe('ollama');
  });

  it.each([
    ['score bearing', { scoreEligible: true }],
    ['unfrozen', { status: 'draft' }],
    ['short schedule', { schedule: { ...protocol().schedule, attempts: 4 } }],
    [
      'early stopping',
      { schedule: { ...protocol().schedule, stoppingRule: 'stop-after-pass' } },
    ],
    [
      'replacement attempts',
      { schedule: { ...protocol().schedule, invalidReplacementPolicy: 'replace' } },
    ],
    [
      'weakened decision rule',
      { decisionRule: { ...protocol().decisionRule, minimumPasses: 0 } },
    ],
    ['unofficial control', { control: { ...protocol().control, package: '@other/mcp' } }],
  ])('rejects a %s protocol', (_label, change) => {
    expect(() => parseControlCapabilityProtocol({ ...protocol(), ...change })).toThrow(
      /invalid control capability protocol/i,
    );
  });

  it('authoritatively limits the gate to the seen task and keeps the sealed task reserved', () => {
    expect(() =>
      parseControlCapabilityProtocol({
        ...protocol(),
        task: { ...protocol().task, id: 'validation-recovery' },
        reservedSealedTaskIds: ['some-other-task'],
      }),
    ).toThrow(/create-customer|reserved/i);
    expect(() =>
      parseControlCapabilityProtocol({
        ...protocol(),
        task: { ...protocol().task, id: 'raise-credit-limit' },
      }),
    ).toThrow(/create-customer/i);
    expect(() =>
      parseControlCapabilityProtocol({
        ...protocol(),
        reservedSealedTaskIds: ['some-other-task'],
      }),
    ).toThrow(/validation-recovery|reserved/i);
  });

  it('rejects prompt, OpenRouter identity, and capability drift', () => {
    const promptDrift = protocol();
    promptDrift.agent.systemPromptSha256 = '8'.repeat(64);
    expect(() => parseControlCapabilityProtocol(promptDrift)).toThrow(/prompt hash/i);

    const source = protocol();
    if (source.agent.provider !== 'openrouter') throw new Error('test setup');
    const endpointDrift = {
      ...source,
      agent: { ...source.agent, baseUrl: 'https://example.test/v1' },
    };
    expect(() => parseControlCapabilityProtocol(endpointDrift)).toThrow(/baseUrl/i);

    const capabilityDrift = {
      ...source,
      agent: {
        ...source.agent,
        modelCapabilities: { ...source.agent.modelCapabilities, seed: false },
      },
    };
    expect(() => parseControlCapabilityProtocol(capabilityDrift)).toThrow(/seed/i);

    expect(() =>
      parseControlCapabilityProtocol({
        ...source,
        agent: { ...source.agent, frameworkVersion: '9.9.9' },
      }),
    ).toThrow(/frameworkVersion|invalid/i);
  });

  it('is strict at every public object boundary', () => {
    expect(() =>
      parseControlCapabilityProtocol({ ...protocol(), treatment: { id: 'browserir' } }),
    ).toThrow(/unrecognized|invalid/i);
    expect(() =>
      parseControlCapabilityProtocol({
        ...protocol(),
        task: { ...protocol().task, privateOracle: true },
      }),
    ).toThrow(/unrecognized|invalid/i);
  });
});
