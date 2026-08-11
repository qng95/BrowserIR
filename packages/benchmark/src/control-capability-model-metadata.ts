import { createHash } from 'node:crypto';

import { stableJson } from './environment.js';

export const OPENROUTER_REQUIRED_CONTROL_PARAMETERS = [
  'max_tokens',
  'reasoning',
  'reasoning_effort',
  'seed',
  'temperature',
  'tool_choice',
  'tools',
] as const;

export interface OpenRouterControlModelSnapshot {
  schemaVersion: '1.0.0';
  modelId: string;
  canonicalModelSlug: string;
  contextWindowTokens: number;
  providerRoute: string;
  providerName: string;
  endpointName: string;
  endpointModelId: string;
  maxCompletionTokens: number;
  requiredParameters: typeof OPENROUTER_REQUIRED_CONTROL_PARAMETERS;
}

export interface OpenRouterControlModelBinding {
  baseUrl: 'https://openrouter.ai/api/v1';
  modelId: string;
  canonicalModelSlug: string;
  modelMetadataSha256: string;
  providerRoute: string;
}

export interface OllamaControlModelBinding {
  baseUrl: string;
  modelId: string;
  modelDigest: string;
  contextWindowTokens: number;
}

export interface OllamaControlModelSnapshot {
  schemaVersion: '1.0.0';
  provider: 'ollama';
  modelId: string;
  modelDigest: string;
  contextWindowTokens: number;
  capabilities: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const nonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`OpenRouter metadata is missing ${label}.`);
  }
  return value;
};

const positiveInteger = (value: unknown, label: string): number => {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`OpenRouter metadata has invalid ${label}.`);
  }
  return Number(value);
};

const responseJson = async (response: Response, label: string): Promise<unknown> => {
  if (!response.ok) {
    throw new Error(`OpenRouter ${label} preflight failed with HTTP ${response.status}.`);
  }
  return response.json() as Promise<unknown>;
};

export function openRouterControlModelFingerprint(
  snapshot: OpenRouterControlModelSnapshot,
): string {
  return createHash('sha256').update(stableJson(snapshot), 'utf8').digest('hex');
}

export async function collectOpenRouterControlModelSnapshot(input: {
  binding: Omit<OpenRouterControlModelBinding, 'modelMetadataSha256'>;
  fetch?: typeof fetch | undefined;
}): Promise<OpenRouterControlModelSnapshot> {
  const request = input.fetch ?? globalThis.fetch;
  const baseUrl = input.binding.baseUrl;
  const [modelsResponse, endpointsResponse] = await Promise.all([
    request(`${baseUrl}/models`, { redirect: 'error' }),
    request(`${baseUrl}/models/${input.binding.modelId}/endpoints`, {
      redirect: 'error',
    }),
  ]);
  const [modelsBody, endpointsBody] = await Promise.all([
    responseJson(modelsResponse, 'model-catalog'),
    responseJson(endpointsResponse, 'provider-endpoint'),
  ]);
  if (!isRecord(modelsBody) || !Array.isArray(modelsBody['data'])) {
    throw new Error('OpenRouter model-catalog response is malformed.');
  }
  const model = modelsBody['data'].find(
    (candidate) => isRecord(candidate) && candidate['id'] === input.binding.modelId,
  );
  if (!isRecord(model)) {
    throw new Error(`OpenRouter model is unavailable: ${input.binding.modelId}`);
  }
  if (!isRecord(endpointsBody) || !isRecord(endpointsBody['data'])) {
    throw new Error('OpenRouter provider-endpoint response is malformed.');
  }
  const endpoints = endpointsBody['data']['endpoints'];
  if (!Array.isArray(endpoints)) {
    throw new Error('OpenRouter provider-endpoint response has no endpoints.');
  }
  const endpoint = endpoints.find(
    (candidate) => isRecord(candidate) && candidate['tag'] === input.binding.providerRoute,
  );
  if (!isRecord(endpoint)) {
    throw new Error(
      `OpenRouter provider route is unavailable: ${input.binding.providerRoute}`,
    );
  }
  const supportedParameters = endpoint['supported_parameters'];
  if (
    !Array.isArray(supportedParameters) ||
    !supportedParameters.every((value) => typeof value === 'string')
  ) {
    throw new Error('OpenRouter provider endpoint has malformed supported parameters.');
  }
  const missing = OPENROUTER_REQUIRED_CONTROL_PARAMETERS.filter(
    (parameter) => !supportedParameters.includes(parameter),
  );
  if (missing.length > 0) {
    throw new Error(
      `OpenRouter provider endpoint lacks required parameters: ${missing.join(', ')}.`,
    );
  }
  const snapshot: OpenRouterControlModelSnapshot = {
    schemaVersion: '1.0.0',
    modelId: nonEmptyString(model['id'], 'model id'),
    canonicalModelSlug: nonEmptyString(model['canonical_slug'], 'canonical model slug'),
    contextWindowTokens: positiveInteger(model['context_length'], 'context window'),
    providerRoute: nonEmptyString(endpoint['tag'], 'provider route'),
    providerName: nonEmptyString(endpoint['provider_name'], 'provider name'),
    endpointName: nonEmptyString(endpoint['name'], 'endpoint name'),
    endpointModelId: nonEmptyString(endpoint['model_id'], 'endpoint model id'),
    maxCompletionTokens: positiveInteger(
      endpoint['max_completion_tokens'],
      'maximum completion tokens',
    ),
    requiredParameters: OPENROUTER_REQUIRED_CONTROL_PARAMETERS,
  };
  if (snapshot.canonicalModelSlug !== input.binding.canonicalModelSlug) {
    throw new Error(
      `OpenRouter canonical model drift: expected ${input.binding.canonicalModelSlug}, received ${snapshot.canonicalModelSlug}.`,
    );
  }
  if (snapshot.endpointModelId !== input.binding.modelId) {
    throw new Error('OpenRouter provider endpoint model identity drifted.');
  }
  return snapshot;
}

export async function verifyOpenRouterControlModelBinding(input: {
  binding: OpenRouterControlModelBinding;
  fetch?: typeof fetch | undefined;
}): Promise<OpenRouterControlModelSnapshot> {
  const snapshot = await collectOpenRouterControlModelSnapshot({
    binding: input.binding,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  const fingerprint = openRouterControlModelFingerprint(snapshot);
  if (fingerprint !== input.binding.modelMetadataSha256) {
    throw new Error(
      `OpenRouter model metadata drift: expected ${input.binding.modelMetadataSha256}, received ${fingerprint}.`,
    );
  }
  return snapshot;
}

export async function verifyOllamaControlModelBinding(input: {
  binding: OllamaControlModelBinding;
  fetch?: typeof fetch | undefined;
}): Promise<OllamaControlModelSnapshot> {
  const request = input.fetch ?? globalThis.fetch;
  const endpoint = new URL(input.binding.baseUrl);
  const tagsUrl = new URL('/api/tags', endpoint);
  const showUrl = new URL('/api/show', endpoint);
  const [tagsResponse, showResponse] = await Promise.all([
    request(tagsUrl, { redirect: 'error' }),
    request(showUrl, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: input.binding.modelId }),
    }),
  ]);
  const [tagsBody, showBody] = await Promise.all([
    responseJson(tagsResponse, 'Ollama model-catalog'),
    responseJson(showResponse, 'Ollama model-details'),
  ]);
  if (!isRecord(tagsBody) || !Array.isArray(tagsBody['models'])) {
    throw new Error('Ollama model-catalog response is malformed.');
  }
  const model = tagsBody['models'].find(
    (candidate) => isRecord(candidate) && candidate['name'] === input.binding.modelId,
  );
  if (!isRecord(model)) {
    throw new Error(`Ollama model is unavailable: ${input.binding.modelId}`);
  }
  const digest = `sha256:${nonEmptyString(model['digest'], 'model digest')}`;
  if (digest !== input.binding.modelDigest) {
    throw new Error(
      `Ollama model digest drift: expected ${input.binding.modelDigest}, received ${digest}.`,
    );
  }
  if (!isRecord(showBody)) {
    throw new Error('Ollama model-details response is malformed.');
  }
  const capabilities = showBody['capabilities'];
  if (
    !Array.isArray(capabilities) ||
    !capabilities.every((value) => typeof value === 'string') ||
    !capabilities.includes('tools')
  ) {
    throw new Error('Ollama model lacks declared tool-call capability.');
  }
  if (typeof showBody['parameters'] !== 'string') {
    throw new Error('Ollama model-details response is malformed.');
  }
  const configuredContext = showBody['parameters']
    .split('\n')
    .map((line) => line.trim().split(/\s+/u))
    .find(([name]) => name === 'num_ctx')?.[1];
  if (Number(configuredContext) !== input.binding.contextWindowTokens) {
    throw new Error(
      `Ollama context drift: expected ${input.binding.contextWindowTokens}, received ${configuredContext ?? 'unset'}.`,
    );
  }
  return {
    schemaVersion: '1.0.0',
    provider: 'ollama',
    modelId: input.binding.modelId,
    modelDigest: digest,
    contextWindowTokens: input.binding.contextWindowTokens,
    capabilities: [...capabilities].sort(),
  };
}
