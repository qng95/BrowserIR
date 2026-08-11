import { BrowserIRRuntime } from '@browserir/core';
import {
  BROWSERIR_PROTOCOL_VERSION,
  SAFE_BROWSER_TOOL_NAMES,
  createBrowserIrMcpHandler,
  createBrowserIrRuntimeService,
} from '@browserir/mcp';
import { createPlaywrightBrowserDriver } from '@browserir/playwright';
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from '@modelcontextprotocol/client';

import type {
  AgentToolBroker,
  AgentToolCallResult,
  AgentToolContentBlock,
  AgentToolDescriptor,
  AgentToolMetrics,
} from './contracts.js';

type McpFetch = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

export interface McpToolBrokerConnectionOptions {
  endpoint: URL;
  protocolVersion: string;
  clientName: string;
  fetch: McpFetch;
  closeServer?(): Promise<void>;
}

export interface BrowserIrMcpToolBrokerOptions {
  clientName?: string;
  headless?: boolean;
  allowedOrigins?: readonly string[] | undefined;
  serviceWorkers?: 'allow' | 'block' | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const modelContent = (result: CallToolResult): AgentToolContentBlock[] =>
  result.content.flatMap((item): AgentToolContentBlock[] => {
    if (item.type === 'text') return [{ type: 'text', text: item.text }];
    if (item.type === 'image') {
      return [{ type: 'image', data: item.data, mimeType: item.mimeType }];
    }
    return [];
  });

class McpToolBroker implements AgentToolBroker {
  readonly #client: Client;
  readonly #closeServer: (() => Promise<void>) | undefined;
  #catalog: readonly AgentToolDescriptor[] | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #calls = 0;
  #errors = 0;
  readonly #byTool = new Map<string, number>();

  constructor(client: Client, closeServer: (() => Promise<void>) | undefined) {
    this.#client = client;
    this.#closeServer = closeServer;
  }

  async listTools(): Promise<readonly AgentToolDescriptor[]> {
    this.#assertOpen();
    if (this.#catalog !== undefined) return this.#catalog;
    const response = await this.#client.listTools();
    this.#catalog = response.tools.map((tool) => ({
      name: tool.name,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      description: tool.description ?? '',
      inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object' },
    }));
    return this.#catalog;
  }

  async callTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<AgentToolCallResult> {
    this.#assertOpen();
    this.#calls += 1;
    this.#byTool.set(name, (this.#byTool.get(name) ?? 0) + 1);
    let result: CallToolResult;
    try {
      result = await this.#client.callTool({ name, arguments: input });
    } catch (error) {
      this.#errors += 1;
      throw error;
    }
    if (result.isError === true) this.#errors += 1;
    const content = modelContent(result);
    return {
      text: content
        .filter((item): item is Extract<AgentToolContentBlock, { type: 'text' }> =>
          item.type === 'text',
        )
        .map((item) => item.text)
        .join('\n'),
      content,
      structuredContent: result.structuredContent,
      isError: result.isError === true,
    };
  }

  metrics(): AgentToolMetrics {
    return {
      calls: this.#calls,
      errors: this.#errors,
      byTool: Object.fromEntries([...this.#byTool.entries()].sort(([a], [b]) => a.localeCompare(b))),
      budgetExceeded: false,
    };
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#closePromise ??= (async () => {
      let clientError: unknown;
      try {
        await this.#client.close();
      } catch (error) {
        clientError = error;
      }
      try {
        await this.#closeServer?.();
      } catch (error) {
        clientError ??= error;
      }
      if (clientError !== undefined) throw clientError;
    })();
    return this.#closePromise;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('MCP tool broker is closed.');
  }
}

export async function connectMcpToolBroker(
  options: McpToolBrokerConnectionOptions,
): Promise<AgentToolBroker> {
  const transport = new StreamableHTTPClientTransport(options.endpoint, {
    fetch: options.fetch,
  });
  const client = new Client(
    { name: options.clientName, version: '0.0.0' },
    { versionNegotiation: { mode: { pin: options.protocolVersion } } },
  );
  try {
    await client.connect(transport);
    return new McpToolBroker(client, options.closeServer);
  } catch (error) {
    await client.close().catch(() => {});
    await options.closeServer?.().catch(() => {});
    throw error;
  }
}

export async function createBrowserIrMcpToolBroker(
  options: BrowserIrMcpToolBrokerOptions = {},
): Promise<AgentToolBroker> {
  const runtime = new BrowserIRRuntime(
    createPlaywrightBrowserDriver({
      headless: options.headless ?? true,
      ...(options.allowedOrigins === undefined
        ? {}
        : { allowedOrigins: options.allowedOrigins }),
      ...(options.serviceWorkers === undefined
        ? {}
        : { serviceWorkers: options.serviceWorkers }),
    }),
  );
  const service = createBrowserIrRuntimeService(runtime);
  const handler = createBrowserIrMcpHandler({ service });
  const broker = await connectMcpToolBroker({
    endpoint: new URL('http://browserir.benchmark/mcp'),
    protocolVersion: BROWSERIR_PROTOCOL_VERSION,
    clientName: options.clientName ?? 'browserir-agent-benchmark',
    fetch: (url, init) => handler.fetch(new Request(url, init)),
    closeServer: async () => {
      let firstError: unknown;
      await handler.close().catch((error) => {
        firstError = error;
      });
      await service.dispose?.().catch((error) => {
        firstError ??= error;
      });
      if (firstError !== undefined) throw firstError;
    },
  });
  const names = (await broker.listTools()).map((tool) => tool.name);
  if (
    names.length !== SAFE_BROWSER_TOOL_NAMES.length ||
    names.some((name, index) => name !== SAFE_BROWSER_TOOL_NAMES[index])
  ) {
    await broker.close().catch(() => {});
    throw new Error(
      `Unsafe or unexpected BrowserIR tool catalog: ${JSON.stringify(names)}.`,
    );
  }
  return broker;
}
