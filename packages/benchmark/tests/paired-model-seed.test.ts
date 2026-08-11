import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import { deterministicModelSeed } from '../src/agent-benchmark/paired-model-seed.js';
import {
  createPairedUpliftAgentFactory,
  createPairedUpliftModel,
} from '../src/paired-uplift-agent.js';
import type {
  AgentBenchmarkTask,
  EvidenceDropProtocol,
} from '../src/agent-benchmark/index.js';

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

  it('rejects redirects from the actual sealed Ollama chat-completions request', async () => {
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
