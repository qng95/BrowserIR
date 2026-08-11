import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { tool, type ClientTool, type ToolSchemaBase } from '@langchain/core/tools';
import {
  createAgent,
  modelCallLimitMiddleware,
  type AnyAgentMiddleware,
} from 'langchain';

import type {
  AgentAdapterMetadata,
  AgentRunCompletion,
  AgentRunInput,
  AgentToolBroker,
  AgentToolCallResult,
  AgentToolContentBlock,
  AgentToolDescriptor,
  BrowserAgentAdapter,
} from './contracts.js';

const require = createRequire(import.meta.url);
const LANGCHAIN_VERSION = (require('langchain/package.json') as { version: string }).version;

export const DEFAULT_LANGCHAIN_BROWSER_AGENT_SYSTEM_PROMPT = [
  'You are a browser automation agent operating only through the provided BrowserIR tools.',
  'Use BrowserIR observations, semantic relationships, capabilities, stable opaque references, and revisions to understand and operate the page.',
  'Observe before acting, use references returned by the latest observation, and observe again after navigation or meaningful state changes.',
  'Never invent element references. If the page changes or a reference becomes stale, observe again and continue from the new representation.',
  'Prefer the narrowest supported browser action that accomplishes the requested task. Do not claim success from page text alone; perform the requested action and report the outcome concisely.',
].join('\n');

export const NEUTRAL_BROWSER_AGENT_SYSTEM_PROMPT = [
  'You are a browser automation agent operating only through the provided browser tools.',
  'Use the page representation and exact target references returned by those tools to understand and operate the page.',
  'Observe or navigate before acting, and inspect the updated result after navigation or meaningful state changes.',
  'Never invent target references. If a target becomes invalid, inspect the current page again and continue from fresh evidence.',
  'Complete every requirement in the Task, including work after intermediate steps such as sign-in or navigation. Before finishing, re-read the Task against the current page state.',
  'Prefer the narrowest supported browser action that accomplishes the requested task. Do not claim success from page text alone; perform the requested action.',
  'After the entire task is complete, call benchmark_submit_result exactly once. A text response does not submit the result.',
].join('\n');

export interface LangChainBrowserAgentOptions {
  /** Any provider's LangChain chat model. Provider initialization remains outside BrowserIR. */
  model: BaseChatModel;
  /** Explicit, reproducible model identifier recorded in benchmark evidence. */
  modelId: string;
  adapterId?: string | undefined;
  modelConfiguration?: Readonly<Record<string, unknown>> | undefined;
  systemPrompt?: string | undefined;
  /** Text-only is the reproducible default; multimodal forwards MCP screenshot blocks as base64 image content. */
  imageMode?: 'text-only' | 'multimodal' | undefined;
}

function normalizedJsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('structuredContent must not contain cycles.');
    const nextAncestors = new Set(ancestors).add(value);
    return value.map((entry) => normalizedJsonValue(entry, nextAncestors));
  }
  if (typeof value === 'object') {
    if (ancestors.has(value)) throw new Error('structuredContent must not contain cycles.');
    const nextAncestors = new Set(ancestors).add(value);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, normalizedJsonValue(entry, nextAncestors)]),
    );
  }
  throw new Error(`structuredContent contains unsupported ${typeof value} value.`);
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizedJsonValue(value, new Set()), null, 2);
}

function optionalContent(result: AgentToolCallResult): readonly AgentToolContentBlock[] {
  const content = result.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is AgentToolContentBlock => {
    if (block === null || typeof block !== 'object') return false;
    if (block.type === 'text') return typeof block.text === 'string';
    return (
      block.type === 'image' &&
      typeof block.data === 'string' &&
      typeof block.mimeType === 'string'
    );
  });
}

// LangChain 1.5.4's public declaration combines its v3 middleware schema with
// v4-compatible agent types in a way that exactOptionalPropertyTypes rejects,
// despite the runtime API being compatible. Keep the narrow cast at this seam.
const makeModelCallLimitMiddleware = modelCallLimitMiddleware as unknown as (options: {
  runLimit: number;
  exitBehavior: 'error';
}) => AnyAgentMiddleware;

type LangChainToolContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | {
          type: 'image';
          source_type: 'base64';
          data: string;
          mime_type: string;
        }
    >;

function renderToolResult(
  result: AgentToolCallResult,
  imageMode: 'text-only' | 'multimodal',
): LangChainToolContent {
  const sections: string[] = [];
  const images: Extract<AgentToolContentBlock, { type: 'image' }>[] = [];
  const emittedText = new Set<string>();
  const addText = (text: string): void => {
    if (text.length === 0 || emittedText.has(text)) return;
    emittedText.add(text);
    sections.push(text);
  };

  if (result.isError) sections.push('[Browser tool error]');
  addText(result.text);
  for (const block of optionalContent(result)) {
    if (block.type === 'text') {
      addText(block.text);
    } else if (imageMode === 'multimodal') {
      images.push(block);
    } else {
      sections.push(
        `[Browser image available: ${block.mimeType}; binary omitted by text-only adapter]`,
      );
    }
  }
  if (result.structuredContent !== undefined) {
    sections.push(`Structured tool content:\n${stableJson(result.structuredContent)}`);
  }
  const text = sections.join('\n\n');
  if (imageMode === 'text-only' || images.length === 0) return text;
  return [
    ...(text.length === 0 ? [] : [{ type: 'text' as const, text }]),
    ...images.map((image) => ({
      type: 'image' as const,
      source_type: 'base64' as const,
      data: image.data,
      mime_type: image.mimeType,
    })),
  ];
}

function asToolInput(value: unknown, toolName: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Browser tool ${toolName} requires an object input.`);
  }
  return value as Record<string, unknown>;
}

function validateDescriptors(
  descriptors: readonly AgentToolDescriptor[],
): readonly AgentToolDescriptor[] {
  const names = new Set<string>();
  for (const descriptor of descriptors) {
    if (descriptor.name.trim().length === 0) {
      throw new Error('Browser tool names must not be empty.');
    }
    if (names.has(descriptor.name)) {
      throw new Error(`Duplicate browser tool name: ${descriptor.name}`);
    }
    names.add(descriptor.name);
  }
  return descriptors;
}

function createBrokerTools(
  broker: AgentToolBroker,
  descriptors: readonly AgentToolDescriptor[],
  imageMode: 'text-only' | 'multimodal',
): ClientTool[] {
  return descriptors.map((descriptor) =>
    tool(
      async (rawInput: unknown): Promise<LangChainToolContent> => {
        const result = await broker.callTool(
          descriptor.name,
          asToolInput(rawInput, descriptor.name),
        );
        return renderToolResult(result, imageMode);
      },
      {
        name: descriptor.name,
        description: descriptor.description,
        schema: descriptor.inputSchema as unknown as ToolSchemaBase,
      },
    ),
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function aggregateUsage(
  messages: readonly BaseMessage[],
): Readonly<Record<string, number>> | undefined {
  const usage: Record<string, number> = {};
  for (const message of messages) {
    if (!AIMessage.isInstance(message) || message.usage_metadata === undefined) continue;
    for (const [name, value] of Object.entries(message.usage_metadata)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        usage[name] = (usage[name] ?? 0) + value;
      }
    }
  }
  return Object.keys(usage).length === 0 ? undefined : usage;
}

function completionFromMessages(messages: readonly BaseMessage[]): AgentRunCompletion {
  const modelMessages = messages.filter(AIMessage.isInstance);
  const finalText = modelMessages.at(-1)?.text.trim();
  const usage = aggregateUsage(modelMessages);
  return {
    modelTurns: modelMessages.length,
    ...(finalText === undefined || finalText.length === 0 ? {} : { finalText }),
    ...(usage === undefined ? {} : { usage }),
  };
}

function runMessage(input: AgentRunInput): string {
  return [`Target origin: ${input.origin}`, 'Task:', input.task.prompt].join('\n');
}

class LangChainBrowserAgent implements BrowserAgentAdapter {
  readonly metadata: AgentAdapterMetadata;
  #model: BaseChatModel;
  #systemPrompt: string;
  #imageMode: 'text-only' | 'multimodal';
  #closed = false;
  #running = false;
  #activeController: AbortController | undefined;

  constructor(options: LangChainBrowserAgentOptions) {
    if (options.modelId.trim().length === 0) throw new Error('modelId must not be empty.');
    const systemPrompt = options.systemPrompt ?? DEFAULT_LANGCHAIN_BROWSER_AGENT_SYSTEM_PROMPT;
    if (systemPrompt.trim().length === 0) throw new Error('systemPrompt must not be empty.');
    this.#model = options.model;
    this.#systemPrompt = systemPrompt;
    this.#imageMode = options.imageMode ?? 'text-only';
    this.metadata = {
      adapterId: options.adapterId ?? 'langchain-browser-agent',
      framework: 'langchain-create-agent',
      frameworkVersion: LANGCHAIN_VERSION,
      model: options.modelId,
      ...(options.modelConfiguration === undefined
        ? {}
        : { modelConfiguration: { ...options.modelConfiguration } }),
      adapterConfiguration: { imageMode: this.#imageMode },
      systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'),
    };
  }

  async run(input: AgentRunInput): Promise<AgentRunCompletion> {
    if (this.#closed) throw new Error('LangChain BrowserIR agent is closed.');
    if (this.#running) throw new Error('LangChain BrowserIR agent is already running.');
    input.signal.throwIfAborted();

    this.#running = true;
    const controller = new AbortController();
    this.#activeController = controller;
    const forwardAbort = (): void => controller.abort(abortReason(input.signal));
    input.signal.addEventListener('abort', forwardAbort, { once: true });

    try {
      const descriptors = validateDescriptors(
        await awaitWithSignal(input.tools.listTools(), controller.signal),
      );
      const tools = createBrokerTools(input.tools, descriptors, this.#imageMode);
      const agent = createAgent({
        model: this.#model,
        tools,
        systemPrompt: this.#systemPrompt,
        middleware: [
          makeModelCallLimitMiddleware({
            runLimit: input.budgets.maxModelTurns,
            exitBehavior: 'error',
          }),
        ],
      });
      const state = await agent.invoke(
        { messages: [{ role: 'user', content: runMessage(input) }] },
        {
          signal: controller.signal,
          // Middleware nodes consume graph steps too; keep this comfortably above the
          // authoritative model-call limit so LangGraph cannot mask that budget error.
          recursionLimit: Math.max(16, input.budgets.maxModelTurns * 8 + 8),
        },
      );
      return completionFromMessages(state.messages);
    } finally {
      input.signal.removeEventListener('abort', forwardAbort);
      this.#activeController = undefined;
      this.#running = false;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#activeController?.abort(new Error('LangChain BrowserIR agent was closed.'));
  }
}

export function createLangChainBrowserAgent(
  options: LangChainBrowserAgentOptions,
): BrowserAgentAdapter {
  return new LangChainBrowserAgent(options);
}
