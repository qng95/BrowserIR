import { describe, expect, it } from 'vitest';

import {
  assertControlCapabilityProviderReady,
  createControlCapabilityAgentFactory,
  createControlCapabilityModel,
  type ControlCapabilityModelSpec,
} from '../src/control-capability-agent.js';
import { deterministicModelSeed } from '../src/agent-benchmark/index.js';

const openRouterAgent = (): Extract<
  ControlCapabilityModelSpec,
  { provider: 'openrouter' }
> => ({
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKeyEnv: 'OPENROUTER_API_KEY',
  modelId: 'qwen/qwen3.8-max',
  canonicalModelSlug: 'qwen/qwen3.8-max-20260803',
  modelMetadataSha256: 'a'.repeat(64),
  providerRoute: 'alibaba',
  reasoningEffort: 'low',
  temperature: 0.2,
  maxOutputTokens: 4096,
  maxRetries: 0,
  imageMode: 'text-only',
  systemPrompt: 'Use only the provided browser tools.',
});

describe('control capability model binding', () => {
  it('fails before construction when the declared OpenRouter key is absent', () => {
    expect(() => assertControlCapabilityProviderReady(openRouterAgent(), {})).toThrow(
      /OPENROUTER_API_KEY is required/i,
    );
    expect(() => createControlCapabilityModel(openRouterAgent(), 42, {})).toThrow(
      /OPENROUTER_API_KEY is required/i,
    );
  });

  it('pins seed, reasoning, provider route, parameters, and data policy in the request', () => {
    const invocation = createControlCapabilityModel(openRouterAgent(), 42, {
      OPENROUTER_API_KEY: 'private-test-key',
    }).invocationParams() as {
      seed?: number;
      reasoning?: { effort?: string };
      provider?: Record<string, unknown>;
      max_tokens?: number;
    };

    expect(invocation).toMatchObject({
      seed: 42,
      max_tokens: 4096,
      reasoning: { effort: 'low' },
      provider: {
        only: ['alibaba'],
        allow_fallbacks: false,
        require_parameters: true,
        data_collection: 'deny',
      },
    });
    expect(JSON.stringify(invocation)).not.toContain('private-test-key');
  });

  it('derives a distinct precommitted seed per attempt and retains no secret metadata', async () => {
    const factory = createControlCapabilityAgentFactory({
      modelSeedBase: 20260812,
      agent: openRouterAgent(),
      environment: { OPENROUTER_API_KEY: 'private-test-key' },
    });
    const task = { id: 'create-customer', prompt: 'Complete the task.' };
    const first = await factory(task, 0);
    const second = await factory(task, 1);

    expect(first.metadata.modelConfiguration).toMatchObject({
      provider: 'openrouter',
      providerRoute: 'alibaba',
      reasoningEffort: 'low',
      seed: deterministicModelSeed(20260812, task.id, 0),
    });
    expect(second.metadata.modelConfiguration).toMatchObject({
      seed: deterministicModelSeed(20260812, task.id, 1),
    });
    expect(first.metadata.modelConfiguration).not.toEqual(
      second.metadata.modelConfiguration,
    );
    expect(JSON.stringify(first.metadata)).not.toContain('private-test-key');
    await Promise.all([first.close(), second.close()]);
  });
});
