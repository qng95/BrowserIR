import { ChatOpenAI } from '@langchain/openai';

import {
  createLangChainBrowserAgent,
  deterministicModelSeed,
  type AgentBenchmarkOptions,
} from './agent-benchmark/index.js';

export type ControlCapabilityReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export type ControlCapabilityModelSpec =
  | {
      provider: 'openrouter';
      baseUrl: 'https://openrouter.ai/api/v1';
      apiKeyEnv: 'OPENROUTER_API_KEY';
      modelId: string;
      canonicalModelSlug: string;
      modelMetadataSha256: string;
      providerRoute: string;
      reasoningEffort: ControlCapabilityReasoningEffort;
      temperature: number;
      maxOutputTokens: number;
      maxRetries: 0;
      imageMode: 'text-only' | 'multimodal';
      systemPrompt: string;
    }
  | {
      provider: 'ollama';
      baseUrl: string;
      modelId: string;
      modelDigest: string;
      contextWindowTokens: number;
      temperature: number;
      maxOutputTokens: number;
      maxRetries: 0;
      imageMode: 'text-only' | 'multimodal';
      systemPrompt: string;
    };

export interface ControlCapabilityAgentFactoryInput {
  modelSeedBase: number;
  agent: ControlCapabilityModelSpec;
  environment?: Readonly<Record<string, string | undefined>> | undefined;
}

const redirectRejectingFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, { ...init, redirect: 'error' });

const safeProviderRoute = /^[a-z0-9][a-z0-9._/-]{0,127}$/;

function openRouterApiKey(
  agent: Extract<ControlCapabilityModelSpec, { provider: 'openrouter' }>,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const apiKey = environment[agent.apiKeyEnv];
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error(`${agent.apiKeyEnv} is required by the control capability protocol.`);
  }
  return apiKey;
}

/** Validates local provider prerequisites before any fixture or browser starts. */
export function assertControlCapabilityProviderReady(
  agent: ControlCapabilityModelSpec,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (agent.provider === 'openrouter') {
    openRouterApiKey(agent, environment);
  }
}

export function createControlCapabilityModel(
  agent: ControlCapabilityModelSpec,
  seed: number,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ChatOpenAI {
  if (agent.provider === 'openrouter') {
    if (!safeProviderRoute.test(agent.providerRoute)) {
      throw new Error('OpenRouter providerRoute must be a safe provider slug.');
    }
    return new ChatOpenAI({
      model: agent.modelId,
      temperature: agent.temperature,
      maxTokens: agent.maxOutputTokens,
      maxRetries: agent.maxRetries,
      useResponsesApi: false,
      apiKey: openRouterApiKey(agent, environment),
      modelKwargs: {
        seed,
        reasoning: { effort: agent.reasoningEffort },
        provider: {
          only: [agent.providerRoute],
          allow_fallbacks: false,
          require_parameters: true,
          data_collection: 'deny',
        },
      },
      configuration: {
        baseURL: agent.baseUrl,
        fetch: redirectRejectingFetch,
      },
    });
  }
  return new ChatOpenAI({
    model: agent.modelId,
    temperature: agent.temperature,
    maxTokens: agent.maxOutputTokens,
    maxRetries: agent.maxRetries,
    useResponsesApi: false,
    apiKey: 'ollama-local-no-secret',
    modelKwargs: { seed },
    configuration: {
      baseURL: agent.baseUrl,
      fetch: redirectRejectingFetch,
    },
  });
}

/**
 * Creates the one shared real-model agent configuration used for every
 * precommitted official-control qualification attempt.
 */
export function createControlCapabilityAgentFactory(
  input: ControlCapabilityAgentFactoryInput,
): AgentBenchmarkOptions['agentFactory'] {
  const environment = input.environment ?? process.env;
  assertControlCapabilityProviderReady(input.agent, environment);
  return async (task, trialIndex) => {
    const seed = deterministicModelSeed(input.modelSeedBase, task.id, trialIndex);
    const agent = input.agent;
    const modelConfiguration = Object.freeze({
      provider: agent.provider,
      modelId: agent.modelId,
      temperature: agent.temperature,
      maxOutputTokens: agent.maxOutputTokens,
      maxRetries: agent.maxRetries,
      imageMode: agent.imageMode,
      seed,
      ...(agent.provider === 'openrouter'
        ? {
            canonicalModelSlug: agent.canonicalModelSlug,
            modelMetadataSha256: agent.modelMetadataSha256,
            providerRoute: agent.providerRoute,
            reasoningEffort: agent.reasoningEffort,
            providerPolicy: {
              allowFallbacks: false,
              requireParameters: true,
              dataCollection: 'deny',
            },
          }
        : {
            modelDigest: agent.modelDigest,
            contextWindowTokens: agent.contextWindowTokens,
          }),
    });
    return createLangChainBrowserAgent({
      model: createControlCapabilityModel(agent, seed, environment),
      modelId: agent.modelId,
      adapterId: 'control-capability-langchain-agent',
      modelConfiguration,
      systemPrompt: agent.systemPrompt,
      imageMode: agent.imageMode,
    });
  };
}
