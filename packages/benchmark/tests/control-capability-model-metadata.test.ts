import { describe, expect, it, vi } from 'vitest';

import {
  collectOpenRouterControlModelSnapshot,
  openRouterControlModelFingerprint,
  verifyOpenRouterControlModelBinding,
  verifyOllamaControlModelBinding,
} from '../src/control-capability-model-metadata.js';

const binding = {
  baseUrl: 'https://openrouter.ai/api/v1' as const,
  modelId: 'qwen/qwen3.8-max',
  canonicalModelSlug: 'qwen/qwen3.8-max-20260803',
  providerRoute: 'alibaba',
};

const response = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const metadataFetch = vi.fn(async (
  input: string | URL | Request,
  _init?: RequestInit,
) => {
  const url = String(input);
  if (url.endsWith('/models')) {
    return response({
      data: [
        {
          id: binding.modelId,
          canonical_slug: binding.canonicalModelSlug,
          context_length: 1_000_000,
        },
      ],
    });
  }
  return response({
    data: {
      endpoints: [
        {
          name: 'Alibaba | qwen/qwen3.8-max-20260803',
          model_id: binding.modelId,
          provider_name: 'Alibaba',
          tag: binding.providerRoute,
          max_completion_tokens: 131_072,
          supported_parameters: [
            'max_tokens',
            'tools',
            'temperature',
            'reasoning_effort',
            'seed',
            'tool_choice',
            'reasoning',
          ],
        },
      ],
    },
  });
});

describe('OpenRouter control model metadata binding', () => {
  it('projects only stable identity and required-capability fields', async () => {
    const snapshot = await collectOpenRouterControlModelSnapshot({
      binding,
      fetch: metadataFetch as unknown as typeof fetch,
    });

    expect(snapshot).toEqual({
      schemaVersion: '1.0.0',
      modelId: binding.modelId,
      canonicalModelSlug: binding.canonicalModelSlug,
      contextWindowTokens: 1_000_000,
      providerRoute: 'alibaba',
      providerName: 'Alibaba',
      endpointName: 'Alibaba | qwen/qwen3.8-max-20260803',
      endpointModelId: binding.modelId,
      maxCompletionTokens: 131_072,
      requiredParameters: [
        'max_tokens',
        'reasoning',
        'reasoning_effort',
        'seed',
        'temperature',
        'tool_choice',
        'tools',
      ],
    });
    for (const [, init] of metadataFetch.mock.calls) {
      expect(init).toMatchObject({ redirect: 'error' });
    }
  });

  it('accepts the exact canonical metadata fingerprint', async () => {
    const snapshot = await collectOpenRouterControlModelSnapshot({
      binding,
      fetch: metadataFetch as unknown as typeof fetch,
    });
    await expect(
      verifyOpenRouterControlModelBinding({
        binding: {
          ...binding,
          modelMetadataSha256: openRouterControlModelFingerprint(snapshot),
        },
        fetch: metadataFetch as unknown as typeof fetch,
      }),
    ).resolves.toEqual(snapshot);
  });

  it('fails closed on missing tool parameters, route drift, or fingerprint drift', async () => {
    const missingTools = vi.fn(async (input: string | URL | Request) => {
      const current = await metadataFetch(input);
      if (String(input).endsWith('/models')) return current;
      const body = (await current.json()) as {
        data: { endpoints: Array<Record<string, unknown>> };
      };
      body.data.endpoints[0]!['supported_parameters'] = ['temperature'];
      return response(body);
    });
    await expect(
      collectOpenRouterControlModelSnapshot({
        binding,
        fetch: missingTools as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/lacks required parameters/i);
    await expect(
      collectOpenRouterControlModelSnapshot({
        binding: { ...binding, providerRoute: 'other-provider' },
        fetch: metadataFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/provider route is unavailable/i);
    await expect(
      verifyOpenRouterControlModelBinding({
        binding: { ...binding, modelMetadataSha256: '0'.repeat(64) },
        fetch: metadataFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/metadata drift/i);
  });
});

describe('Ollama control model metadata binding', () => {
  it('pins the endpoint-reported digest, context, and tool capability', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/api/tags')) {
        return response({
          models: [
            {
              name: 'browserir-qwen3-4b-32k:drop01-dev',
              digest: 'a'.repeat(64),
            },
          ],
        });
      }
      return response({
        parameters: 'temperature 0\nnum_ctx 32768\n',
        capabilities: ['completion', 'tools'],
      });
    });

    await expect(
      verifyOllamaControlModelBinding({
        binding: {
          baseUrl: 'http://127.0.0.1:11434/v1',
          modelId: 'browserir-qwen3-4b-32k:drop01-dev',
          modelDigest: `sha256:${'a'.repeat(64)}`,
          contextWindowTokens: 32_768,
        },
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).resolves.toEqual({
      schemaVersion: '1.0.0',
      provider: 'ollama',
      modelId: 'browserir-qwen3-4b-32k:drop01-dev',
      modelDigest: `sha256:${'a'.repeat(64)}`,
      contextWindowTokens: 32_768,
      capabilities: ['completion', 'tools'],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fails closed on digest, context, or capability drift', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/api/tags')
        ? response({
            models: [
              {
                name: 'model',
                digest: 'b'.repeat(64),
                capabilities: ['completion'],
              },
            ],
          })
        : response({ parameters: 'num_ctx 4096\n' }),
    );
    await expect(
      verifyOllamaControlModelBinding({
        binding: {
          baseUrl: 'http://127.0.0.1:11434/v1',
          modelId: 'model',
          modelDigest: `sha256:${'a'.repeat(64)}`,
          contextWindowTokens: 32_768,
        },
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/digest drift/i);
  });
});
