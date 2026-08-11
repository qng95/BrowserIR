import { AIMessage } from '@langchain/core/messages';
import { fakeModel } from 'langchain';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LANGCHAIN_BROWSER_AGENT_SYSTEM_PROMPT,
  NEUTRAL_BROWSER_AGENT_SYSTEM_PROMPT,
  createLangChainBrowserAgent,
} from '../src/agent-benchmark/langchain-agent.js';
import type {
  AgentRunInput,
  AgentToolBroker,
  AgentToolCallResult,
  AgentToolDescriptor,
  AgentToolMetrics,
} from '../src/agent-benchmark/contracts.js';

class RecordingBroker implements AgentToolBroker {
  readonly calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  #descriptors: readonly AgentToolDescriptor[];
  #result: AgentToolCallResult;

  constructor(
    descriptors: readonly AgentToolDescriptor[],
    result: AgentToolCallResult = { text: 'ok', isError: false },
  ) {
    this.#descriptors = descriptors;
    this.#result = result;
  }

  async listTools(): Promise<readonly AgentToolDescriptor[]> {
    return this.#descriptors;
  }

  async callTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<AgentToolCallResult> {
    this.calls.push({ name, input });
    return this.#result;
  }

  metrics(): AgentToolMetrics {
    return {
      calls: this.calls.length,
      errors: 0,
      byTool: Object.fromEntries(
        this.calls.map(({ name }) => [name, this.calls.filter((call) => call.name === name).length]),
      ),
      budgetExceeded: false,
    };
  }

  async close(): Promise<void> {}
}

const observeTool: AgentToolDescriptor = {
  name: 'browser_observe',
  title: 'Observe browser',
  description: 'Read the current BrowserIR representation.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['interactive', 'all'] },
    },
    required: ['scope'],
    additionalProperties: false,
  },
};

const runInput = (
  tools: AgentToolBroker,
  signal: AbortSignal = new AbortController().signal,
): AgentRunInput => ({
  task: {
    id: 'opaque-harness-id',
    prompt: 'Find the customer and update the requested field.',
  },
  origin: 'https://app.example.test',
  tools,
  signal,
  budgets: {
    maxDurationMs: 10_000,
    maxToolCalls: 8,
    maxModelTurns: 4,
  },
});

describe('LangChain BrowserIR agent adapter', () => {
  it('maps broker JSON schemas to tools and returns stable structured results to the model', async () => {
    const result: AgentToolCallResult = {
      text: 'Current page: Customers',
      structuredContent: {
        revision: 7,
        pageId: 'page_opaque',
        browserId: 'browser_opaque',
      },
      isError: false,
      content: [
        { type: 'text', text: 'Current page: Customers' },
        { type: 'image', data: 'base64-is-not-forwarded', mimeType: 'image/png' },
      ],
    };
    const broker = new RecordingBroker([observeTool], result);
    const finalMessage = new AIMessage('The requested browser task is complete.');
    Object.assign(finalMessage, {
      usage_metadata: {
        input_tokens: 31,
        output_tokens: 8,
        total_tokens: 39,
      },
    });
    const model = fakeModel()
      .respondWithTools([
        {
          name: 'browser_observe',
          args: { scope: 'interactive' },
          id: 'observe-1',
        },
      ])
      .respond(finalMessage);
    const agent = createLangChainBrowserAgent({
      model,
      modelId: 'deterministic-fake',
    });

    const completion = await agent.run(runInput(broker));

    expect(broker.calls).toEqual([
      { name: 'browser_observe', input: { scope: 'interactive' } },
    ]);
    expect(model.callCount).toBe(2);
    expect(completion).toMatchObject({
      finalText: 'The requested browser task is complete.',
      modelTurns: 2,
      usage: {
        input_tokens: 31,
        output_tokens: 8,
        total_tokens: 39,
      },
    });

    const secondCall = model.calls[1];
    const toolMessage = secondCall?.messages.find((message) => message._getType() === 'tool');
    expect(toolMessage?.text).toContain('Current page: Customers');
    expect(toolMessage?.text).toContain(
      '{\n  "browserId": "browser_opaque",\n  "pageId": "page_opaque",\n  "revision": 7\n}',
    );
    expect(toolMessage?.text.match(/"browserId"/gu)).toHaveLength(1);
    expect(toolMessage?.text).toContain(
      '[Browser image available: image/png; binary omitted by text-only adapter]',
    );
    expect(toolMessage?.text).not.toContain('base64-is-not-forwarded');

    const firstCall = model.calls[0];
    expect(firstCall?.messages[0]?.text).toBe(DEFAULT_LANGCHAIN_BROWSER_AGENT_SYSTEM_PROMPT);
    expect(firstCall?.messages[1]?.text).toContain('Target origin: https://app.example.test');
    expect(firstCall?.messages[1]?.text).toContain(
      'Find the customer and update the requested field.',
    );
    expect(firstCall?.messages[1]?.text).not.toContain('opaque-harness-id');
  });

  it('aggregates available usage without undercounting model turns', async () => {
    const broker = new RecordingBroker([]);
    const finalMessage = new AIMessage('Nothing else is required.');
    Object.assign(finalMessage, {
      usage_metadata: {
        input_tokens: 12,
        output_tokens: 4,
        total_tokens: 16,
      },
    });
    const model = fakeModel().respond(finalMessage);
    const agent = createLangChainBrowserAgent({
      model,
      modelId: 'deterministic-fake',
    });

    const completion = await agent.run(runInput(broker));

    expect(completion.modelTurns).toBe(1);
    expect(completion.usage).toEqual({
      input_tokens: 12,
      output_tokens: 4,
      total_tokens: 16,
    });
  });

  it('forwards screenshot bytes only in the explicitly selected multimodal profile', async () => {
    const broker = new RecordingBroker([observeTool], {
      text: 'captured',
      content: [
        { type: 'text', text: 'captured' },
        { type: 'image', data: 'c2NyZWVuc2hvdA==', mimeType: 'image/png' },
      ],
      isError: false,
    });
    const model = fakeModel()
      .respondWithTools([{ name: 'browser_observe', args: { scope: 'all' } }])
      .respond(new AIMessage('done'));
    const agent = createLangChainBrowserAgent({
      model,
      modelId: 'deterministic-fake',
      imageMode: 'multimodal',
    });

    await agent.run(runInput(broker));

    const toolMessage = model.calls[1]?.messages.find(
      (message) => message._getType() === 'tool',
    );
    expect(toolMessage?.content).toEqual([
      { type: 'text', text: 'captured' },
      {
        type: 'image',
        source_type: 'base64',
        data: 'c2NyZWVuc2hvdA==',
        mime_type: 'image/png',
      },
    ]);
    expect(agent.metadata.adapterConfiguration).toEqual({ imageMode: 'multimodal' });
  });

  it('enforces the model-turn budget before another model call', async () => {
    const broker = new RecordingBroker([observeTool]);
    const model = fakeModel()
      .respondWithTools([
        { name: 'browser_observe', args: { scope: 'all' }, id: 'observe-1' },
      ])
      .respond(new AIMessage('This response must never be requested.'));
    const agent = createLangChainBrowserAgent({
      model,
      modelId: 'deterministic-fake',
    });
    const input = runInput(broker);

    await expect(
      agent.run({
        ...input,
        budgets: { ...input.budgets, maxModelTurns: 1 },
      }),
    ).rejects.toThrow(/model call limits exceeded/iu);
    expect(model.callCount).toBe(1);
  });

  it('honors an AbortSignal before listing tools or calling the model', async () => {
    const broker = new RecordingBroker([observeTool]);
    const model = fakeModel().respond(new AIMessage('Must not run.'));
    const agent = createLangChainBrowserAgent({
      model,
      modelId: 'deterministic-fake',
    });
    const controller = new AbortController();
    controller.abort(new Error('trial cancelled'));

    await expect(agent.run(runInput(broker, controller.signal))).rejects.toThrow(
      'trial cancelled',
    );
    expect(model.callCount).toBe(0);
  });

  it('rejects duplicate broker tool names before calling the model', async () => {
    const broker = new RecordingBroker([observeTool, { ...observeTool }]);
    const model = fakeModel().respond(new AIMessage('Must not run.'));
    const agent = createLangChainBrowserAgent({
      model,
      modelId: 'deterministic-fake',
    });

    await expect(agent.run(runInput(broker))).rejects.toThrow(
      'Duplicate browser tool name: browser_observe',
    );
    expect(model.callCount).toBe(0);
  });

  it('publishes reproducible, provider-independent adapter metadata', () => {
    const model = fakeModel().respond(new AIMessage('done'));
    const agent = createLangChainBrowserAgent({
      adapterId: 'langchain-browserir-test',
      model,
      modelId: 'provider:model-version',
      modelConfiguration: { temperature: 0, seed: 42 },
    });

    expect(agent.metadata).toMatchObject({
      adapterId: 'langchain-browserir-test',
      framework: 'langchain-create-agent',
      frameworkVersion: '1.5.5',
      model: 'provider:model-version',
      modelConfiguration: { temperature: 0, seed: 42 },
    });
    expect(agent.metadata.systemPromptSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(DEFAULT_LANGCHAIN_BROWSER_AGENT_SYSTEM_PROMPT).not.toMatch(
      /fixture|task[_-]?id|selector|\/api\/|database/iu,
    );
    expect(NEUTRAL_BROWSER_AGENT_SYSTEM_PROMPT).not.toMatch(
      /BrowserIR|Playwright|fixture|task[_-]?id|selector|\/api\/|database/iu,
    );
  });
});
