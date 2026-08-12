import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  EVIDENCE_DROP_PROTOCOL_SCHEMA_VERSION,
  parseEvidenceDropProtocol,
} from '../src/agent-benchmark/evidence-drop-protocol.js';

const prompt = 'Use only the provided browser tools. Inspect before acting.';
const promptSha256 = createHash('sha256').update(prompt, 'utf8').digest('hex');

const developmentProtocol = () => ({
  schemaVersion: EVIDENCE_DROP_PROTOCOL_SCHEMA_VERSION,
  dropId: '01',
  protocolId: 'drop-01-development-qwen3-4b-001',
  phase: 'development',
  status: 'draft',
  question: 'Does BrowserIR improve browser task completion?',
  taskIds: ['create-customer'],
  taskContracts: [
    {
      id: 'create-customer',
      version: `sha256:${'1'.repeat(64)}`,
      promptSha256: '2'.repeat(64),
      oracleVersion: 'fixture-oracle-v1',
    },
  ],
  reservedSealedTaskIds: ['validation-recovery'],
  trialsPerTask: 1,
  schedule: {
    orderSeed: 20260811,
    bootstrapSeed: 141421,
    bootstrapResamples: 10_000,
    stoppingRule: 'run-entire-schedule',
    invalidReplacementPolicy: 'none',
  },
  budgets: {
    maxDurationMs: 120_000,
    maxToolCalls: 100,
    maxModelTurns: 30,
  },
  agent: {
    framework: 'langchain-create-agent',
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    modelId: 'qwen3:4b-instruct',
    modelDigest:
      'sha256:0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0',
    contextWindowTokens: 32768,
    temperature: 0,
    maxRetries: 0,
    imageMode: 'text-only',
    systemPrompt: prompt,
    systemPromptSha256: promptSha256,
  },
  target: {
    expectedVersion: `sha256:${'a'.repeat(64)}`,
    headless: true,
  },
  arms: {
    control: {
      role: 'control',
      id: 'playwright-mcp',
      label: 'Official Playwright MCP',
      interfaceVersion: '0.0.78',
    },
    treatment: {
      role: 'treatment',
      id: 'browserir',
      label: 'BrowserIR MCP',
      interfaceVersion: '0.1.0+mcp-2026-07-28',
    },
  },
  analysis: {
    confidence: 0.95,
    interval: 'paired-hoeffding-bound',
    invalidBlockHeadlineThreshold: 0.05,
    primaryMetric: 'paired-treatment-minus-control-pass-rate',
  },
});

const strictOpenRouterAgent = () => ({
  framework: 'langchain-create-agent' as const,
  frameworkVersion: '1.5.5' as const,
  provider: 'openrouter' as const,
  baseUrl: 'https://openrouter.ai/api/v1' as const,
  apiKeyEnv: 'OPENROUTER_API_KEY' as const,
  modelId: 'qwen/qwen3.8-max',
  canonicalModelSlug: 'qwen/qwen3.8-max-20260803',
  modelMetadataSha256: '4'.repeat(64),
  providerRoute: 'alibaba',
  reasoningEffort: 'low' as const,
  providerPolicy: {
    allowFallbacks: false as const,
    requireParameters: true as const,
    dataCollection: 'deny' as const,
  },
  modelCapabilities: {
    tools: true as const,
    seed: true as const,
    temperature: true as const,
  },
  temperature: 0.2,
  maxOutputTokens: 4096 as const,
  maxRetries: 0 as const,
  imageMode: 'text-only' as const,
  systemPrompt: prompt,
  systemPromptSha256: promptSha256,
});

const sealedProtocol = () => ({
  ...developmentProtocol(),
  phase: 'sealed' as const,
  status: 'frozen' as const,
  taskIds: ['validation-recovery'],
  taskContracts: [
    {
      ...developmentProtocol().taskContracts[0]!,
      id: 'validation-recovery',
    },
  ],
  trialsPerTask: 30,
  freezeRef: 'refs/tags/evidence-drop-01-protocol-v1',
  schedule: {
    ...developmentProtocol().schedule,
    modelSeedBase: 8675309,
  },
  agent: strictOpenRouterAgent(),
  analysis: {
    ...developmentProtocol().analysis,
    decisionRule: {
      minimumScheduledBlocks: 30 as const,
      maximumInvalidBlocks: 1 as const,
      positive: { lowerBoundAbove: 0 as const },
      negative: { upperBoundBelow: 0 as const },
      otherwise: 'inconclusive' as const,
    },
    publicationRule: 'publish-regardless-of-sign' as const,
    estimand: 'fixed-workflow-precommitted-seed-schedule' as const,
  },
  arms: {
    control: {
      ...developmentProtocol().arms.control,
      expectedToolCatalogSha256: 'c'.repeat(64),
    },
    treatment: {
      ...developmentProtocol().arms.treatment,
      expectedToolCatalogSha256: 'd'.repeat(64),
    },
  },
});

describe('evidence-drop protocol', () => {
  it('accepts a strict development protocol and preserves its typed values', () => {
    const parsed = parseEvidenceDropProtocol(developmentProtocol());

    expect(parsed.protocolId).toBe('drop-01-development-qwen3-4b-001');
    expect(parsed.taskIds).toEqual(['create-customer']);
    expect(parsed.agent.provider).toBe('ollama');
    if (parsed.agent.provider !== 'ollama') throw new Error('test setup');
    expect(parsed.agent.modelDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('rejects development use of a task reserved for sealed evaluation', () => {
    const protocol = developmentProtocol();
    protocol.taskIds = ['validation-recovery'];
    protocol.taskContracts = [
      {
        ...protocol.taskContracts[0]!,
        id: 'validation-recovery',
      },
    ];

    expect(() => parseEvidenceDropProtocol(protocol)).toThrow(/reserved.*sealed/i);
  });

  it('binds a frozen sealed protocol to a freeze ref and exact tool catalogs', () => {
    const protocol = sealedProtocol();

    expect(parseEvidenceDropProtocol(protocol).agent).toMatchObject({
      provider: 'openrouter',
      frameworkVersion: '1.5.5',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      maxOutputTokens: 4096,
      modelCapabilities: { tools: true, seed: true, temperature: true },
      providerPolicy: {
        allowFallbacks: false,
        requireParameters: true,
        dataCollection: 'deny',
      },
    });

    expect(() =>
      parseEvidenceDropProtocol({
        ...protocol,
        agent: developmentProtocol().agent,
      }),
    ).toThrow(/sealed.*OpenRouter|OpenRouter.*sealed/i);

    delete (protocol as { freezeRef?: unknown }).freezeRef;
    expect(() => parseEvidenceDropProtocol(protocol)).toThrow(/freeze.*frozen/i);
  });

  it.each([
    ['endpoint', { baseUrl: 'https://models.example.com/v1' }],
    ['key binding', { apiKeyEnv: 'SOME_OTHER_KEY' }],
    ['framework version', { frameworkVersion: '1.5.6' }],
    ['output ceiling', { maxOutputTokens: 8192 }],
    [
      'capability declaration',
      { modelCapabilities: { tools: true, seed: false, temperature: true } },
    ],
    [
      'fallback policy',
      {
        providerPolicy: {
          allowFallbacks: true,
          requireParameters: true,
          dataCollection: 'deny',
        },
      },
    ],
    [
      'parameter policy',
      {
        providerPolicy: {
          allowFallbacks: false,
          requireParameters: false,
          dataCollection: 'deny',
        },
      },
    ],
    [
      'data policy',
      {
        providerPolicy: {
          allowFallbacks: false,
          requireParameters: true,
          dataCollection: 'allow',
        },
      },
    ],
  ])('rejects sealed OpenRouter %s drift', (_label, drift) => {
    const protocol = sealedProtocol();
    expect(() =>
      parseEvidenceDropProtocol({
        ...protocol,
        agent: { ...protocol.agent, ...drift },
      }),
    ).toThrow(/invalid evidence-drop protocol/i);
  });

  it('requires sealed claim rules, minimum schedule, fixed estimand, and publication regardless of sign', () => {
    const protocol = sealedProtocol();
    expect(parseEvidenceDropProtocol(protocol).analysis).toMatchObject({
      decisionRule: {
        minimumScheduledBlocks: 30,
        maximumInvalidBlocks: 1,
        positive: { lowerBoundAbove: 0 },
        negative: { upperBoundBelow: 0 },
        otherwise: 'inconclusive',
      },
      publicationRule: 'publish-regardless-of-sign',
      estimand: 'fixed-workflow-precommitted-seed-schedule',
    });

    const { decisionRule: _decisionRule, ...analysisWithoutDecision } =
      protocol.analysis;
    expect(() =>
      parseEvidenceDropProtocol({
        ...protocol,
        analysis: analysisWithoutDecision,
      }),
    ).toThrow(/decision rule/i);
    expect(() =>
      parseEvidenceDropProtocol({
        ...protocol,
        analysis: { ...protocol.analysis, publicationRule: undefined },
      }),
    ).toThrow(/publication/i);
    expect(() =>
      parseEvidenceDropProtocol({
        ...protocol,
        analysis: { ...protocol.analysis, estimand: undefined },
      }),
    ).toThrow(/estimand/i);
    expect(() =>
      parseEvidenceDropProtocol({
        ...protocol,
        trialsPerTask: 29,
      }),
    ).toThrow(/30 scheduled matched blocks/i);
  });

  it('requires a precommitted model seed base only for sealed protocols', () => {
    expect(parseEvidenceDropProtocol(developmentProtocol()).schedule.modelSeedBase).toBeUndefined();

    const sealed = {
      ...sealedProtocol(),
      schedule: developmentProtocol().schedule,
    };

    expect(() => parseEvidenceDropProtocol(sealed)).toThrow(/modelSeedBase/i);
  });

  it('rejects greedy temperature-zero pseudo-replication for sealed inference', () => {
    const sealed = {
      ...sealedProtocol(),
      agent: { ...strictOpenRouterAgent(), temperature: 0 },
    };

    expect(() => parseEvidenceDropProtocol(sealed)).toThrow(
      /temperature.*greater than zero|stochastic.*temperature/i,
    );
    expect(parseEvidenceDropProtocol(developmentProtocol()).agent.temperature).toBe(0);
  });

  it('rejects prompt hash drift, arm coaching, unknown fields, and mutable sealed runs', () => {
    const wrongHash = developmentProtocol();
    wrongHash.agent.systemPromptSha256 = 'f'.repeat(64);
    expect(() => parseEvidenceDropProtocol(wrongHash)).toThrow(/prompt.*hash/i);

    const coached = developmentProtocol();
    coached.agent.systemPrompt = 'BrowserIR is better than Playwright. Use BrowserIR carefully.';
    coached.agent.systemPromptSha256 = createHash('sha256')
      .update(coached.agent.systemPrompt, 'utf8')
      .digest('hex');
    expect(() => parseEvidenceDropProtocol(coached)).toThrow(/neutral/i);

    expect(() =>
      parseEvidenceDropProtocol({ ...developmentProtocol(), surprise: true }),
    ).toThrow(/unrecognized|unknown/i);

    expect(() =>
      parseEvidenceDropProtocol({
        ...developmentProtocol(),
        phase: 'sealed',
        status: 'draft',
        taskIds: ['validation-recovery'],
        taskContracts: [
          {
            ...developmentProtocol().taskContracts[0]!,
            id: 'validation-recovery',
          },
        ],
      }),
    ).toThrow(/sealed.*frozen/i);
  });
});
