import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { deterministicModelSeed } from '../src/agent-benchmark/paired-model-seed.js';
import {
  capturePairedUpliftProviderEnvironment,
  createPairedUpliftAgentFactory,
  createPairedUpliftModel,
} from '../src/paired-uplift-agent.js';
import type {
  AgentBenchmarkTask,
  EvidenceDropProtocol,
} from '../src/agent-benchmark/index.js';

const openRouterProtocol = (): EvidenceDropProtocol =>
  ({
    phase: 'sealed',
    schedule: { modelSeedBase: 8675309 },
    agent: {
      framework: 'langchain-create-agent',
      frameworkVersion: '1.5.5',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      modelId: 'qwen/qwen3.8-max',
      canonicalModelSlug: 'qwen/qwen3.8-max-20260803',
      modelMetadataSha256: 'a'.repeat(64),
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
      systemPrompt: 'Use only the provided browser tools.',
    },
  }) as EvidenceDropProtocol;

describe('paired model seed schedule', () => {
  it('derives one stable uint32 seed for both arms in the same matched block', () => {
    const control = deterministicModelSeed(8675309, 'validation-recovery', 3);
    const treatment = deterministicModelSeed(8675309, 'validation-recovery', 3);

    expect(control).toBe(treatment);
    expect(control).toBe(2135586477);
    expect(Number.isInteger(control)).toBe(true);
    expect(control).toBeGreaterThanOrEqual(0);
    expect(control).toBeLessThanOrEqual(0xffff_ffff);
  });

  it('changes deterministically across task and trial coordinates', () => {
    const original = deterministicModelSeed(8675309, 'validation-recovery', 3);

    expect(deterministicModelSeed(8675309, 'validation-recovery', 3)).toBe(original);
    expect(deterministicModelSeed(8675309, 'validation-recovery', 4)).not.toBe(original);
    expect(deterministicModelSeed(8675309, 'create-customer', 3)).not.toBe(original);
    expect(deterministicModelSeed(8675310, 'validation-recovery', 3)).not.toBe(original);
  });

  it('wires the same derived seed into both paired agent configurations', async () => {
    const protocol = {
      schedule: { modelSeedBase: 8675309 },
      agent: {
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelId: 'qwen3:4b-instruct',
        modelDigest: `sha256:${'a'.repeat(64)}`,
        contextWindowTokens: 32768,
        temperature: 0,
        maxRetries: 0,
        imageMode: 'text-only',
        systemPrompt: 'Use only the provided browser tools.',
      },
    } as EvidenceDropProtocol;
    const task: AgentBenchmarkTask = {
      id: 'validation-recovery',
      prompt: 'Complete the task.',
    };
    const factory = createPairedUpliftAgentFactory(protocol);

    const control = await factory(task, 3);
    const treatment = await factory(task, 3);
    const nextTrial = await factory(task, 4);

    expect(control.metadata.modelConfiguration).toMatchObject({
      seed: deterministicModelSeed(8675309, task.id, 3),
    });
    expect(treatment.metadata.modelConfiguration).toEqual(
      control.metadata.modelConfiguration,
    );
    expect(nextTrial.metadata.modelConfiguration).not.toEqual(
      control.metadata.modelConfiguration,
    );
    await Promise.all([control.close(), treatment.close(), nextTrial.close()]);
  });

  it('places the seed in the actual OpenAI-compatible invocation parameters', () => {
    const protocol = {
      schedule: { modelSeedBase: 8675309 },
      agent: {
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelId: 'qwen3:4b-instruct',
        modelDigest: `sha256:${'a'.repeat(64)}`,
        contextWindowTokens: 32768,
        temperature: 0.2,
        maxRetries: 0,
        imageMode: 'text-only',
        systemPrompt: 'Use only the provided browser tools.',
      },
    } as EvidenceDropProtocol;
    const seed = deterministicModelSeed(8675309, 'validation-recovery', 3);

    const invocation = createPairedUpliftModel(protocol, seed).invocationParams() as {
      seed?: number | undefined;
    };
    expect(invocation.seed).toBe(seed);
  });

  it('fails closed when the sealed OpenRouter key is absent', () => {
    expect(() => createPairedUpliftModel(openRouterProtocol(), 42, {})).toThrow(
      /OPENROUTER_API_KEY is required/i,
    );
    expect(() => createPairedUpliftAgentFactory(openRouterProtocol(), {})).toThrow(
      /OPENROUTER_API_KEY is required/i,
    );
  });

  it('hands the OpenRouter key to the model only and removes it from ambient child setup', async () => {
    const protocol = openRouterProtocol();
    const ambientEnvironment: Record<string, string | undefined> = {
      PATH: process.env['PATH'],
      OPENROUTER_API_KEY: 'secret-handoff-sentinel',
      UNRELATED_VALUE: 'retained',
    };

    const providerEnvironment = capturePairedUpliftProviderEnvironment(
      protocol.agent,
      ambientEnvironment,
    );

    expect(Object.isFrozen(providerEnvironment)).toBe(true);
    expect(providerEnvironment).toEqual({
      OPENROUTER_API_KEY: 'secret-handoff-sentinel',
    });
    expect(ambientEnvironment).not.toHaveProperty('OPENROUTER_API_KEY');
    expect(ambientEnvironment['UNRELATED_VALUE']).toBe('retained');

    const child = spawnSync(
      process.execPath,
      [
        '-e',
        "process.stdout.write(process.env.OPENROUTER_API_KEY === undefined ? 'absent' : 'present')",
      ],
      { encoding: 'utf8', env: ambientEnvironment as NodeJS.ProcessEnv },
    );
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('absent');

    const factory = createPairedUpliftAgentFactory(protocol, providerEnvironment);
    const agent = await factory(
      { id: 'validation-recovery', prompt: 'Complete the task.' },
      0,
    );
    const model = createPairedUpliftModel(protocol, 42, providerEnvironment);
    expect(model.invocationParams()).toMatchObject({ seed: 42 });
    expect(JSON.stringify(agent.metadata)).not.toContain('secret-handoff-sentinel');
    expect(JSON.stringify(model.invocationParams())).not.toContain(
      'secret-handoff-sentinel',
    );
    await agent.close();
  });

  it.each([
    ['missing', undefined],
    ['blank', '   '],
  ] as const)(
    'does not mutate the ambient environment when the OpenRouter key is %s',
    (_case, key) => {
      const ambientEnvironment: Record<string, string | undefined> = {
        OPENROUTER_API_KEY: key,
      };

      expect(() =>
        capturePairedUpliftProviderEnvironment(
          openRouterProtocol().agent,
          ambientEnvironment,
        ),
      ).toThrow(/OPENROUTER_API_KEY is required/i);
      expect(ambientEnvironment).toHaveProperty('OPENROUTER_API_KEY', key);
    },
  );

  it('leaves legacy provider environments unchanged', () => {
    const ambientEnvironment: Record<string, string | undefined> = {
      OPENAI_API_KEY: 'legacy-development-key',
      UNRELATED_VALUE: 'retained',
    };
    const legacyAgent = {
      provider: 'ollama',
    } as EvidenceDropProtocol['agent'];

    expect(
      capturePairedUpliftProviderEnvironment(legacyAgent, ambientEnvironment),
    ).toBe(ambientEnvironment);
    expect(ambientEnvironment).toEqual({
      OPENAI_API_KEY: 'legacy-development-key',
      UNRELATED_VALUE: 'retained',
    });
  });

  it('pins output, seed, reasoning, provider route, and provider policy', () => {
    const invocation = createPairedUpliftModel(openRouterProtocol(), 42, {
      OPENROUTER_API_KEY: 'private-test-key',
    }).invocationParams() as {
      seed?: number;
      max_tokens?: number;
      reasoning?: { effort?: string };
      provider?: Record<string, unknown>;
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

  it('forces redirect rejection without making a request', async () => {
    const underlyingFetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', underlyingFetch);
    try {
      const model = createPairedUpliftModel(openRouterProtocol(), 42, {
        OPENROUTER_API_KEY: 'private-test-key',
      });
      const configuredFetch = model.clientConfig.fetch;
      expect(configuredFetch).toBeTypeOf('function');

      await configuredFetch?.('https://openrouter.ai/api/v1/chat/completions', {
        redirect: 'follow',
      });

      expect(underlyingFetch).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/chat/completions',
        expect.objectContaining({ redirect: 'error' }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('binds the same strict OpenRouter metadata and seed to both paired arms', async () => {
    const protocol = openRouterProtocol();
    const environment = { OPENROUTER_API_KEY: 'private-test-key' };
    const task: AgentBenchmarkTask = {
      id: 'validation-recovery',
      prompt: 'Complete the task.',
    };
    const factory = createPairedUpliftAgentFactory(protocol, environment);
    const control = await factory(task, 3);
    const treatment = await factory(task, 3);

    expect(control.metadata.modelConfiguration).toMatchObject({
      provider: 'openrouter',
      canonicalModelSlug: 'qwen/qwen3.8-max-20260803',
      modelMetadataSha256: 'a'.repeat(64),
      providerRoute: 'alibaba',
      reasoningEffort: 'low',
      maxOutputTokens: 4096,
      seed: deterministicModelSeed(8675309, task.id, 3),
      providerPolicy: {
        allowFallbacks: false,
        requireParameters: true,
        dataCollection: 'deny',
      },
    });
    expect(treatment.metadata.modelConfiguration).toEqual(
      control.metadata.modelConfiguration,
    );
    expect(JSON.stringify(control.metadata)).not.toContain('private-test-key');
    await Promise.all([control.close(), treatment.close()]);
  });

  it('rejects redirects from the actual development Ollama chat-completions request', async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      if (request.url === '/v1/chat/completions') {
        response.writeHead(307, { location: '/redirect-target' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'redirected-completion',
          object: 'chat.completion',
          created: 1,
          model: 'different-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'redirect followed' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const protocol = {
      schedule: { modelSeedBase: 8675309 },
      agent: {
        provider: 'ollama',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        modelId: 'qwen3:4b-instruct',
        modelDigest: `sha256:${'a'.repeat(64)}`,
        contextWindowTokens: 32768,
        temperature: 0.2,
        maxRetries: 0,
        imageMode: 'text-only',
        systemPrompt: 'Use only the provided browser tools.',
      },
    } as EvidenceDropProtocol;

    try {
      await expect(
        createPairedUpliftModel(protocol, 42).invoke('Complete the task.'),
      ).rejects.toBeDefined();
      expect(requests).toEqual(['/v1/chat/completions']);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

});
