import { describe, expect, it } from 'vitest';

import {
  assertPairedExecutionEnvironmentStable,
  collectPairedExecutionEnvironment,
  createDefaultPairedExecutionEnvironmentProbe,
  createPairedExecutionIntegrityBinding,
  pairedExecutionEnvironmentFingerprint,
  parsePairedExecutionEnvironment,
  renderPairedExecutionModelMetadata,
  renderPairedExecutionEnvironment,
  type PairedExecutionEnvironment,
  type PairedExecutionEnvironmentProbe,
} from '../src/agent-benchmark/paired-environment.js';
import {
  OPENROUTER_REQUIRED_CONTROL_PARAMETERS,
  openRouterControlModelFingerprint,
  type OpenRouterControlModelSnapshot,
} from '../src/control-capability-model-metadata.js';

const digest = (character: string): string => character.repeat(64);

const environment = (): PairedExecutionEnvironment => ({
  schemaVersion: '1.2.0',
  host: {
    platform: 'darwin',
    release: '25.0.0',
    arch: 'arm64',
    hardware: {
      cpuModel: 'Apple M4 Pro',
      logicalCpuCount: 14,
      memoryBytes: 51_539_607_552,
    },
    resourceLimits: {
      attemptConcurrency: 1,
      processBoundary: false,
      containerOrVmLimits: 'unverified',
    },
  },
  harness: {
    nodeVersion: 'v22.19.0',
    pnpmVersion: '10.30.3',
    packageManager: 'pnpm@10.30.3',
    lockfileSha256: digest('1'),
  },
  model: {
    provider: 'ollama',
    modelId: 'browserir-qwen3-8b-32k:drop01-dev',
    artifactDigest: `sha256:${digest('2')}`,
    verification: 'ollama-endpoint-reported-digest',
    runtime: { name: 'ollama', version: '0.11.4' },
    configuration: {
      contextWindowTokens: 32_768,
      temperature: 0,
      maxRetries: 0,
      imageMode: 'text-only',
    },
    capabilities: ['completion', 'thinking', 'tools'],
  },
  target: {
    expectedVersion: `sha256:${digest('3')}`,
    headless: true,
    profile: {
      viewport: { width: 1_440, height: 900, deviceScaleFactor: 1 },
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    },
  },
  arms: {
    control: {
      interfaceVersion: '0.0.78',
      runtimePackages: [
        { name: '@playwright/mcp', version: '0.0.78' },
        { name: 'playwright-core', version: '1.62.0-alpha-1783623505000' },
      ],
      browser: {
        engine: 'chromium',
        version: '144.0.7559.3',
        executableSha256: digest('4'),
      },
    },
    treatment: {
      interfaceVersion: '0.1.0+mcp-2026-07-28',
      runtimePackages: [
        { name: '@browserir/core', version: '0.1.0' },
        { name: '@browserir/mcp', version: '0.1.0' },
        { name: '@browserir/playwright', version: '0.1.0' },
        { name: 'playwright-core', version: '1.62.0' },
      ],
      browser: {
        engine: 'chromium',
        version: '144.0.7559.3',
        executableSha256: digest('4'),
      },
    },
  },
});

describe('paired evidence execution environment', () => {
  it('binds exact OpenRouter endpoint metadata without claiming a model-weight digest', async () => {
    const metadata: OpenRouterControlModelSnapshot = {
      schemaVersion: '1.0.0',
      modelId: 'qwen/qwen3.8-max',
      canonicalModelSlug: 'qwen/qwen3.8-max-20260803',
      contextWindowTokens: 262_144,
      providerRoute: 'alibaba',
      providerName: 'Alibaba',
      endpointName: 'Qwen3.8 Max',
      endpointModelId: 'qwen/qwen3.8-max',
      maxCompletionTokens: 65_536,
      requiredParameters: OPENROUTER_REQUIRED_CONTROL_PARAMETERS,
    };
    const request: typeof fetch = async (input) => {
      const url = String(input);
      return url.endsWith('/models')
        ? new Response(
            JSON.stringify({
              data: [
                {
                  id: metadata.modelId,
                  canonical_slug: metadata.canonicalModelSlug,
                  context_length: metadata.contextWindowTokens,
                },
              ],
            }),
            { status: 200 },
          )
        : new Response(
            JSON.stringify({
              data: {
                endpoints: [
                  {
                    tag: metadata.providerRoute,
                    provider_name: metadata.providerName,
                    name: metadata.endpointName,
                    model_id: metadata.endpointModelId,
                    max_completion_tokens: metadata.maxCompletionTokens,
                    supported_parameters: [...metadata.requiredParameters],
                  },
                ],
              },
            }),
            { status: 200 },
          );
    };
    const protocol = {
      agent: {
        provider: 'openrouter' as const,
        baseUrl: 'https://openrouter.ai/api/v1' as const,
        modelId: metadata.modelId,
        canonicalModelSlug: metadata.canonicalModelSlug,
        modelMetadataSha256: openRouterControlModelFingerprint(metadata),
        providerRoute: metadata.providerRoute,
        temperature: 0.2,
        maxOutputTokens: 4_096,
        maxRetries: 0,
        imageMode: 'text-only' as const,
      },
      target: { expectedVersion: `sha256:${digest('3')}`, headless: true },
      arms: {
        control: { interfaceVersion: '0.0.78' },
        treatment: { interfaceVersion: '0.1.0+mcp-2026-07-28' },
      },
    };

    const model = await createDefaultPairedExecutionEnvironmentProbe({ fetch: request }).model(
      protocol,
    );

    expect(model).toMatchObject({
      provider: 'openrouter',
      modelId: metadata.modelId,
      canonicalModelSlug: metadata.canonicalModelSlug,
      modelMetadataSha256: openRouterControlModelFingerprint(metadata),
      providerRoute: metadata.providerRoute,
      verification: 'openrouter-endpoint-metadata-fingerprint',
      metadata,
      configuration: {
        contextWindowTokens: metadata.contextWindowTokens,
        maxOutputTokens: 4_096,
      },
    });
    expect(model).not.toHaveProperty('artifactDigest');
    expect(renderPairedExecutionModelMetadata(model)).toContain(
      '"canonicalModelSlug": "qwen/qwen3.8-max-20260803"',
    );
  });

  it('fails OpenRouter endpoint metadata drift closed during environment collection', async () => {
    const expected = environment();
    const modelMetadataSha256 = digest('9');
    const protocol = {
      agent: {
        provider: 'openrouter' as const,
        baseUrl: 'https://openrouter.ai/api/v1' as const,
        modelId: 'qwen/qwen3.8-max',
        canonicalModelSlug: 'qwen/qwen3.8-max-20260803',
        modelMetadataSha256,
        providerRoute: 'alibaba',
        temperature: 0.2,
        maxOutputTokens: 4_096,
        maxRetries: 0,
        imageMode: 'text-only' as const,
      },
      target: { expectedVersion: expected.target.expectedVersion, headless: true },
      arms: {
        control: { interfaceVersion: expected.arms.control.interfaceVersion },
        treatment: { interfaceVersion: expected.arms.treatment.interfaceVersion },
      },
    };
    const probe: PairedExecutionEnvironmentProbe = {
      host: async () => expected.host,
      harness: async () => expected.harness,
      model: async () => ({
        provider: 'openrouter',
        modelId: protocol.agent.modelId,
        canonicalModelSlug: protocol.agent.canonicalModelSlug,
        modelMetadataSha256: digest('8'),
        providerRoute: protocol.agent.providerRoute,
        verification: 'openrouter-endpoint-metadata-fingerprint',
        metadata: {
          schemaVersion: '1.0.0',
          modelId: protocol.agent.modelId,
          canonicalModelSlug: protocol.agent.canonicalModelSlug,
          contextWindowTokens: 262_144,
          providerRoute: protocol.agent.providerRoute,
          providerName: 'Alibaba',
          endpointName: 'Qwen3.8 Max',
          endpointModelId: protocol.agent.modelId,
          maxCompletionTokens: 65_536,
          requiredParameters: OPENROUTER_REQUIRED_CONTROL_PARAMETERS,
        },
        configuration: {
          contextWindowTokens: 262_144,
          temperature: 0.2,
          maxOutputTokens: 4_096,
          maxRetries: 0,
          imageMode: 'text-only',
        },
      }),
      arm: async (role) => expected.arms[role],
    };

    await expect(
      collectPairedExecutionEnvironment(
        { workspaceRoot: '/not-published', protocol },
        probe,
      ),
    ).rejects.toThrow(/model.*metadata.*drift/i);
  });

  it('canonicalizes metadata and fingerprints semantic content independent of key order', () => {
    const left = environment();
    const right = JSON.parse(JSON.stringify(left)) as Record<string, unknown>;
    right['arms'] = {
      treatment: (right['arms'] as Record<string, unknown>)['treatment'],
      control: (right['arms'] as Record<string, unknown>)['control'],
    };

    expect(pairedExecutionEnvironmentFingerprint(left)).toBe(
      pairedExecutionEnvironmentFingerprint(right),
    );
    expect(renderPairedExecutionEnvironment(right)).toBe(
      renderPairedExecutionEnvironment(left),
    );
  });

  it('rejects secret-bearing or machine-identifying fields instead of publishing them', () => {
    const contaminated = {
      ...environment(),
      apiKey: 'SENTINEL-SECRET',
      host: {
        ...environment().host,
        hostname: 'private-workstation',
      },
      model: {
        ...environment().model,
        baseUrl: 'http://user:password@localhost:11434/v1',
      },
      arms: {
        ...environment().arms,
        control: {
          ...environment().arms.control,
          executablePath: '/Users/private/Library/Caches/browser',
        },
      },
    };

    expect(() => parsePairedExecutionEnvironment(contaminated)).toThrow(
      /unrecognized|invalid|environment/i,
    );
    expect(() => renderPairedExecutionEnvironment(contaminated)).toThrow();
  });

  it('detects start/end drift and reports only bounded field paths', () => {
    const start = environment();
    const end = environment();
    if (end.model.provider !== 'ollama') throw new Error('test setup');
    end.model.runtime.version = '0.11.5';
    end.arms.control.browser.version = '145.0.0.0';

    expect(() => assertPairedExecutionEnvironmentStable(start, end)).toThrow(
      /arms\.control\.browser\.version.*model\.runtime\.version|model\.runtime\.version.*arms\.control\.browser\.version/i,
    );
  });

  it('binds byte-identical start/end snapshots to the final journal event', () => {
    const snapshot = environment();
    const binding = createPairedExecutionIntegrityBinding(
      snapshot,
      snapshot,
      digest('a'),
    );

    expect(binding).toMatchObject({
      schemaVersion: '1.0.0',
      environmentFingerprint: pairedExecutionEnvironmentFingerprint(snapshot),
      environmentStartSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      environmentEndSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      journalFinalEventSha256: digest('a'),
      bindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(binding.environmentStartSha256).toBe(binding.environmentEndSha256);

    const differentJournal = createPairedExecutionIntegrityBinding(
      snapshot,
      snapshot,
      digest('b'),
    );
    expect(differentJournal.bindingSha256).not.toBe(binding.bindingSha256);
  });

  it('binds hardware and explicit local isolation limits into start/end stability', () => {
    const start = environment();
    const end = environment();
    end.host.hardware.logicalCpuCount = 12;

    expect(() => assertPairedExecutionEnvironmentStable(start, end)).toThrow(
      /host\.hardware\.logicalCpuCount/i,
    );
    expect(renderPairedExecutionEnvironment(start)).toContain('containerOrVmLimits');
  });

  it('collects only the strict allowlisted projection returned by real probes', async () => {
    const expected = environment();
    if (expected.model.provider !== 'ollama') throw new Error('test setup');
    const probe: PairedExecutionEnvironmentProbe = {
      host: async () => expected.host,
      harness: async () => expected.harness,
      model: async () => expected.model,
      arm: async (role) => expected.arms[role],
    };
    const collected = await collectPairedExecutionEnvironment(
      {
        workspaceRoot: '/not-published',
        protocol: {
          agent: {
            provider: 'ollama',
            baseUrl: 'http://user:password@localhost:11434/v1',
            modelId: expected.model.modelId,
            modelDigest: expected.model.artifactDigest,
            contextWindowTokens: 32_768,
            temperature: 0,
            maxRetries: 0,
            imageMode: 'text-only',
          },
          target: {
            expectedVersion: expected.target.expectedVersion,
            headless: true,
          },
          arms: {
            control: { interfaceVersion: expected.arms.control.interfaceVersion },
            treatment: { interfaceVersion: expected.arms.treatment.interfaceVersion },
          },
        },
      },
      probe,
    );

    const rendered = renderPairedExecutionEnvironment(collected);
    expect(collected).toEqual(expected);
    expect(rendered).not.toContain('/not-published');
    expect(rendered).not.toContain('password');
    expect(rendered).not.toContain('baseUrl');
  });

  it('rejects a pnpm runtime that differs from the workspace package-manager pin', async () => {
    const expected = environment();
    if (expected.model.provider !== 'ollama') throw new Error('test setup');
    const probe: PairedExecutionEnvironmentProbe = {
      host: async () => expected.host,
      harness: async () => ({ ...expected.harness, pnpmVersion: '11.16.0' }),
      model: async () => expected.model,
      arm: async (role) => expected.arms[role],
    };

    await expect(
      collectPairedExecutionEnvironment(
        {
          workspaceRoot: '/not-published',
          protocol: {
            agent: {
              provider: 'ollama',
              modelId: expected.model.modelId,
              modelDigest: expected.model.artifactDigest,
              contextWindowTokens: 32_768,
              temperature: 0,
              maxRetries: 0,
              imageMode: 'text-only',
            },
            target: {
              expectedVersion: expected.target.expectedVersion,
              headless: true,
            },
            arms: {
              control: { interfaceVersion: expected.arms.control.interfaceVersion },
              treatment: { interfaceVersion: expected.arms.treatment.interfaceVersion },
            },
          },
        },
        probe,
      ),
    ).rejects.toThrow(/pnpm.*11\.16\.0.*pnpm@10\.30\.3/i);
  });
});
