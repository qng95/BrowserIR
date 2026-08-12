import { ChatOpenAI } from '@langchain/openai';

import {
  createLangChainBrowserAgent,
  deterministicModelSeed,
  type AgentBenchmarkArm,
  type EvidenceDropProtocol,
} from './agent-benchmark/index.js';

const redirectRejectingFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, { ...init, redirect: 'error' });

const safeProviderRoute = /^[a-z0-9][a-z0-9._/-]{0,127}$/;

type PairedAgentSpec = EvidenceDropProtocol['agent'];
type OpenRouterPairedAgentSpec = Extract<PairedAgentSpec, { provider: 'openrouter' }>;

function openRouterApiKey(
  agent: OpenRouterPairedAgentSpec,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const apiKey = environment[agent.apiKeyEnv];
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error(`${agent.apiKeyEnv} is required by the paired evidence protocol.`);
  }
  return apiKey;
}

/** Fails before any browser or model attempt when provider prerequisites are absent. */
export function assertPairedUpliftProviderReady(
  agent: PairedAgentSpec,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (agent.provider === 'openrouter') {
    openRouterApiKey(agent, environment);
  }
}

/**
 * Moves the one protocol-declared provider secret out of the ambient process
 * environment before provenance probes or browser children can start. The
 * returned object is intentionally key-only and is retained only by the model
 * factory closure.
 */
export function capturePairedUpliftProviderEnvironment(
  agent: PairedAgentSpec,
  environment: Record<string, string | undefined> = process.env,
): Readonly<Record<string, string | undefined>> {
  if (agent.provider !== 'openrouter') return environment;
  const apiKey = openRouterApiKey(agent, environment);
  if (
    !Reflect.deleteProperty(environment, agent.apiKeyEnv) ||
    environment[agent.apiKeyEnv] !== undefined
  ) {
    throw new Error(`${agent.apiKeyEnv} could not be removed from the ambient environment.`);
  }
  return Object.freeze({ [agent.apiKeyEnv]: apiKey });
}

export function createPairedUpliftModel(
  protocol: EvidenceDropProtocol,
  seed: number | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ChatOpenAI {
  if (protocol.agent.provider === 'openrouter') {
    const agent = protocol.agent;
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
        ...(seed === undefined ? {} : { seed }),
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
  if (protocol.agent.provider === 'openai') {
    const apiKey = environment['OPENAI_API_KEY'];
    if (apiKey === undefined || apiKey.trim().length === 0) {
      throw new Error('OPENAI_API_KEY is required by the selected protocol.');
    }
    return new ChatOpenAI({
      model: protocol.agent.modelId,
      temperature: protocol.agent.temperature,
      maxRetries: protocol.agent.maxRetries,
      useResponsesApi: false,
      apiKey,
      ...(seed === undefined ? {} : { modelKwargs: { seed } }),
    });
  }
  return new ChatOpenAI({
    model: protocol.agent.modelId,
    temperature: protocol.agent.temperature,
    maxRetries: protocol.agent.maxRetries,
    useResponsesApi: false,
    ...(seed === undefined ? {} : { modelKwargs: { seed } }),
    apiKey: 'ollama-local-no-secret',
    configuration: {
      baseURL: protocol.agent.baseUrl,
      fetch: redirectRejectingFetch,
    },
  });
}

/** Creates the shared per-block factory installed on both paired arms. */
export function createPairedUpliftAgentFactory(
  protocol: EvidenceDropProtocol,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AgentBenchmarkArm['agentFactory'] {
  assertPairedUpliftProviderReady(protocol.agent, environment);
  return async (task, trialIndex) => {
    const seed =
      protocol.schedule.modelSeedBase === undefined
        ? undefined
        : deterministicModelSeed(protocol.schedule.modelSeedBase, task.id, trialIndex);
    const agent = protocol.agent;
    const modelConfiguration = Object.freeze({
      provider: agent.provider,
      modelId: agent.modelId,
      temperature: agent.temperature,
      maxRetries: agent.maxRetries,
      useResponsesApi: false,
      imageMode: agent.imageMode,
      ...(seed === undefined ? {} : { seed }),
      ...(agent.provider === 'openrouter'
        ? {
            frameworkVersion: agent.frameworkVersion,
            canonicalModelSlug: agent.canonicalModelSlug,
            modelMetadataSha256: agent.modelMetadataSha256,
            modelCapabilities: { ...agent.modelCapabilities },
            providerRoute: agent.providerRoute,
            reasoningEffort: agent.reasoningEffort,
            providerPolicy: { ...agent.providerPolicy },
            maxOutputTokens: agent.maxOutputTokens,
          }
        : {
            modelDigest: agent.modelDigest,
            contextWindowTokens: agent.contextWindowTokens,
          }),
    });
    return createLangChainBrowserAgent({
      model: createPairedUpliftModel(protocol, seed, environment),
      modelId: agent.modelId,
      adapterId: 'shared-langchain-agent',
      modelConfiguration,
      systemPrompt: agent.systemPrompt,
      imageMode: agent.imageMode,
    });
  };
}
