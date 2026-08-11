import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { chromium } from 'playwright';

import type {
  AgentToolBroker,
  AgentToolCallResult,
  AgentToolContentBlock,
  AgentToolDescriptor,
  AgentToolMetrics,
} from './contracts.js';

const require = createRequire(import.meta.url);
const packageJson = require('@playwright/mcp/package.json') as {
  version: string;
};
const packageDirectory = dirname(require.resolve('@playwright/mcp/package.json'));

export const PLAYWRIGHT_MCP_VERSION = packageJson.version;

export const PLAYWRIGHT_MCP_SAFE_TOOL_NAMES = [
  'browser_close',
  'browser_handle_dialog',
  'browser_find',
  'browser_fill_form',
  'browser_press_key',
  'browser_type',
  'browser_navigate',
  'browser_navigate_back',
  'browser_take_screenshot',
  'browser_snapshot',
  'browser_click',
  'browser_drag',
  'browser_hover',
  'browser_select_option',
  'browser_tabs',
  'browser_wait_for',
] as const;

const safeToolNames = new Set<string>(PLAYWRIGHT_MCP_SAFE_TOOL_NAMES);

export interface PlaywrightMcpToolBrokerOptions {
  allowedOrigin: string;
  clientName?: string | undefined;
  headless?: boolean | undefined;
  viewport?: {
    width: number;
    height: number;
    deviceScaleFactor?: number | undefined;
  } | undefined;
  locale?: string | undefined;
  timezoneId?: string | undefined;
  colorScheme?: 'light' | 'dark' | 'no-preference' | undefined;
  reducedMotion?: 'reduce' | 'no-preference' | undefined;
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

const normalizedOrigin = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('allowedOrigin must be an absolute HTTP or HTTPS origin.');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value) {
    throw new Error('allowedOrigin must be an absolute HTTP or HTTPS origin.');
  }
  return url.origin;
};

class PlaywrightMcpToolBroker implements AgentToolBroker {
  readonly #client: Client;
  readonly #transport: StdioClientTransport;
  readonly #outputDirectory: string;
  #catalog: readonly AgentToolDescriptor[] | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #calls = 0;
  #errors = 0;
  readonly #byTool = new Map<string, number>();

  constructor(
    client: Client,
    transport: StdioClientTransport,
    outputDirectory: string,
  ) {
    this.#client = client;
    this.#transport = transport;
    this.#outputDirectory = outputDirectory;
  }

  async listTools(): Promise<readonly AgentToolDescriptor[]> {
    this.#assertOpen();
    if (this.#catalog !== undefined) return this.#catalog;
    const response = await this.#client.listTools();
    const available = new Map(response.tools.map((tool) => [tool.name, tool]));
    const missing = PLAYWRIGHT_MCP_SAFE_TOOL_NAMES.filter((name) => !available.has(name));
    if (missing.length > 0) {
      throw new Error(
        `Pinned Playwright MCP ${PLAYWRIGHT_MCP_VERSION} is missing safe tools: ${missing.join(', ')}.`,
      );
    }
    this.#catalog = PLAYWRIGHT_MCP_SAFE_TOOL_NAMES.map((name) => {
      const tool = available.get(name)!;
      return {
        name,
        ...(tool.title === undefined ? {} : { title: tool.title }),
        description: tool.description ?? '',
        inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object' },
      };
    });
    return this.#catalog;
  }

  async callTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<AgentToolCallResult> {
    this.#assertOpen();
    if (!safeToolNames.has(name)) {
      this.#errors += 1;
      throw new Error(`Playwright MCP tool is outside the benchmark allowlist: ${name}`);
    }
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
      byTool: Object.fromEntries(
        [...this.#byTool.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
      budgetExceeded: false,
    };
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#closePromise ??= (async () => {
      let firstError: unknown;
      await this.#client.close().catch((error) => {
        firstError = error;
      });
      await this.#transport.close().catch((error) => {
        firstError ??= error;
      });
      await rm(this.#outputDirectory, { recursive: true, force: true }).catch((error) => {
        firstError ??= error;
      });
      if (firstError !== undefined) throw firstError;
    })();
    return this.#closePromise;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Playwright MCP tool broker is closed.');
  }
}

export async function createPlaywrightMcpToolBroker(
  options: PlaywrightMcpToolBrokerOptions,
): Promise<AgentToolBroker> {
  const allowedOrigin = normalizedOrigin(options.allowedOrigin);
  const viewport = options.viewport ?? { width: 1_440, height: 900 };
  if (
    !Number.isInteger(viewport.width) ||
    viewport.width < 1 ||
    !Number.isInteger(viewport.height) ||
    viewport.height < 1
  ) {
    throw new Error('Playwright MCP viewport dimensions must be positive integers.');
  }
  const outputDirectory = await mkdtemp(join(tmpdir(), 'browserir-playwright-mcp-'));
  let transport: StdioClientTransport | undefined;
  let client: Client | undefined;
  try {
    const configPath = join(outputDirectory, 'playwright-mcp.config.json');
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          browser: {
            contextOptions: {
              viewport: { width: viewport.width, height: viewport.height },
              deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
              locale: options.locale ?? 'en-US',
              timezoneId: options.timezoneId ?? 'UTC',
              colorScheme: options.colorScheme ?? 'light',
              reducedMotion: options.reducedMotion ?? 'reduce',
              acceptDownloads: false,
              serviceWorkers: 'block',
            },
          },
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    const args = [
      join(packageDirectory, 'cli.js'),
      '--config',
      configPath,
      '--browser',
      'chromium',
      '--executable-path',
      chromium.executablePath(),
      '--isolated',
      '--codegen',
      'none',
      '--image-responses',
      'omit',
      '--snapshot-mode',
      'full',
      '--viewport-size',
      `${viewport.width}x${viewport.height}`,
      '--allowed-origins',
      allowedOrigin,
      '--console-level',
      'error',
      '--output-dir',
      outputDirectory,
      '--output-mode',
      'stdout',
      ...(options.headless ?? true ? ['--headless'] : []),
    ];
    transport = new StdioClientTransport({
      command: process.execPath,
      args,
      cwd: outputDirectory,
      stderr: 'pipe',
    });
    // Always drain the child stream. An unread pipe can fill and deadlock the
    // official MCP process during a long diagnostic run.
    transport.stderr?.on('data', () => {});
    client = new Client({
      name: options.clientName ?? 'browserir-playwright-mcp-benchmark',
      version: '0.0.0',
    });
    await client.connect(transport);
    const broker = new PlaywrightMcpToolBroker(client, transport, outputDirectory);
    await broker.listTools();
    return broker;
  } catch (error) {
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    await rm(outputDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
