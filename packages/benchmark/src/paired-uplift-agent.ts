import { ChatOpenAI } from '@langchain/openai';

import {
  createLangChainBrowserAgent,
  deterministicModelSeed,
  type AgentBenchmarkArm,
  type EvidenceDropProtocol,
} from './agent-benchmark/index.js';

const redirectRejectingFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, { ...init, redirect: 'error' });

export function createPairedUpliftModel(
  protocol: EvidenceDropProtocol,
  seed: number | undefined,
): ChatOpenAI {
  if (protocol.agent.provider === 'openai') {
    if (process.env['OPENAI_API_KEY'] === undefined) {
      throw new Error('OPENAI_API_KEY is required by the selected protocol.');
    }
    return new ChatOpenAI({
      model: protocol.agent.modelId,
      temperature: protocol.agent.temperature,
      maxRetries: protocol.agent.maxRetries,
      useResponsesApi: false,
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
): AgentBenchmarkArm['agentFactory'] {
  return async (task, trialIndex) => {
    const seed =
      protocol.schedule.modelSeedBase === undefined
        ? undefined
        : deterministicModelSeed(protocol.schedule.modelSeedBase, task.id, trialIndex);
    const modelConfiguration = Object.freeze({
      provider: protocol.agent.provider,
      modelDigest: protocol.agent.modelDigest,
      contextWindowTokens: protocol.agent.contextWindowTokens,
      temperature: protocol.agent.temperature,
      maxRetries: protocol.agent.maxRetries,
      useResponsesApi: false,
      imageMode: protocol.agent.imageMode,
      ...(seed === undefined ? {} : { seed }),
    });
    return createLangChainBrowserAgent({
      model: createPairedUpliftModel(protocol, seed),
      modelId: protocol.agent.modelId,
      adapterId: 'shared-langchain-agent',
      modelConfiguration,
      systemPrompt: protocol.agent.systemPrompt,
      imageMode: protocol.agent.imageMode,
    });
  };
}
