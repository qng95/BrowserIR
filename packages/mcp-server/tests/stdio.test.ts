import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';

import {
  BrowserIRRuntime,
  type BrowserDriver,
  type BrowserDriverSession,
} from '@browserir/core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it, vi } from 'vitest';

import {
  BROWSERIR_PROTOCOL_VERSION,
  BROWSERIR_VERSION,
  SAFE_BROWSER_TOOL_NAMES,
  createBrowserIrRuntimeService,
  serveBrowserIrStdio,
} from '../src/index.js';

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const compiledCli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const captureStdioFixture = fileURLToPath(
  new URL('./fixtures/capture-stdio.mjs', import.meta.url),
);
type InspectableStdioTransport = {
  _process?: ChildProcess;
};

describe('local stdio delivery', () => {
  it('serves the final MCP protocol from the compiled CLI without unsafe evaluation', async () => {
    const captureDirectory = mkdtempSync(join(tmpdir(), 'browserir-stdio-'));
    const capturePrefix = join(captureDirectory, 'stdout');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [captureStdioFixture, compiledCli, capturePrefix],
      cwd: workspaceRoot,
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const client = new Client(
      { name: 'browserir-release-test', version: BROWSERIR_VERSION },
      { versionNegotiation: { mode: { pin: BROWSERIR_PROTOCOL_VERSION } } },
    );

    try {
      await client.connect(transport);
      expect(client.getNegotiatedProtocolVersion()).toBe(BROWSERIR_PROTOCOL_VERSION);
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getServerVersion()).toMatchObject({
        name: 'browserir',
        version: BROWSERIR_VERSION,
      });
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).not.toContain('browser_evaluate_unsafe');
      expect(tools.tools.map((tool) => tool.name)).toContain('browser_create');
    } finally {
      await client.close().catch(() => {});
    }

    try {
      expect(stderr).toBe('');
      const captures = readdirSync(captureDirectory).filter((path) =>
        path.startsWith('stdout.'),
      );
      expect(captures.length).toBeGreaterThan(0);
      const messages = captures.flatMap((path) =>
        readFileSync(join(captureDirectory, path), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean),
      );
      expect(messages.length).toBeGreaterThan(0);
      expect(
        messages.every((message) => {
          const parsed = JSON.parse(message) as { jsonrpc?: unknown };
          return parsed.jsonrpc === '2.0';
        }),
      ).toBe(true);
    } finally {
      rmSync(captureDirectory, { recursive: true, force: true });
    }
  }, 30_000);

  it('exposes and executes the audited tenth tool only with the explicit CLI flag', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [compiledCli, '--enable-unsafe-evaluate'],
      cwd: workspaceRoot,
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const client = new Client(
      { name: 'browserir-unsafe-release-test', version: BROWSERIR_VERSION },
      { versionNegotiation: { mode: { pin: BROWSERIR_PROTOCOL_VERSION } } },
    );

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        ...SAFE_BROWSER_TOOL_NAMES,
        'browser_evaluate_unsafe',
      ]);

      const created = await client.callTool({ name: 'browser_create', arguments: {} });
      const createdData = created.structuredContent as {
        browser_id: string;
        page_id: string;
      };
      const observed = await client.callTool({
        name: 'browser_observe',
        arguments: {
          browser_id: createdData.browser_id,
          page_id: createdData.page_id,
        },
      });
      const observedData = observed.structuredContent as { revision: number };
      const evaluated = await client.callTool({
        name: 'browser_evaluate_unsafe',
        arguments: {
          browser_id: createdData.browser_id,
          page_id: createdData.page_id,
          expected_revision: observedData.revision,
          expression:
            '(() => { document.body.innerHTML = "<button>Create customer</button>"; return { answer: 42 }; })()',
          timeout_ms: 1_000,
          max_output_bytes: 1_024,
          max_tokens: 1_024,
        },
      });
      const evaluatedData = evaluated.structuredContent as {
        outcome: string;
        post_revision: number;
        result: unknown;
        changes: { state_invalidated?: boolean };
      };

      expect(evaluated.isError).not.toBe(true);
      expect(evaluatedData).toMatchObject({
        outcome: 'completed',
        result: { answer: 42 },
        changes: { state_invalidated: true },
      });
      expect(evaluatedData.post_revision).toBeGreaterThan(observedData.revision);
      expect(
        evaluated.content.some(
          (block) =>
            block.type === 'text' && block.text.includes('Create customer'),
        ),
      ).toBe(true);
    } finally {
      await client.close().catch(() => {});
    }

    const auditLines = stderr
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event?: string; record?: Record<string, unknown> });
    expect(auditLines).toHaveLength(2);
    expect(auditLines.map((line) => line.event)).toEqual([
      'browserir_unsafe_evaluate',
      'browserir_unsafe_evaluate',
    ]);
    expect(auditLines.map((line) => line.record?.phase)).toEqual([
      'intent',
      'completion',
    ]);
    expect(JSON.stringify(auditLines)).not.toContain('Create customer');
    expect(JSON.stringify(auditLines)).not.toContain('answer');
  }, 30_000);

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'waits for real owned-browser cleanup before exiting on %s',
    async (signal, expectedExitCode) => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [compiledCli],
        cwd: workspaceRoot,
        stderr: 'pipe',
      });
      let stderr = '';
      transport.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const client = new Client(
        { name: `browserir-${signal.toLowerCase()}-test`, version: BROWSERIR_VERSION },
        { versionNegotiation: { mode: { pin: BROWSERIR_PROTOCOL_VERSION } } },
      );
      let child: ChildProcess | undefined;

      try {
        await client.connect(transport);
        const created = await client.callTool({ name: 'browser_create', arguments: {} });
        expect(created.isError).not.toBe(true);
        child = (transport as unknown as InspectableStdioTransport)._process;
        expect(child?.pid).toBe(transport.pid);
        const resultPromise = Promise.race([
          new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (resolve) => child!.once('close', (code, closedSignal) => {
              resolve({ code, signal: closedSignal });
            }),
          ),
          new Promise<never>((_resolve, reject) => {
            setTimeout(
              () => reject(new Error(`Timed out waiting for ${signal} shutdown.`)),
              20_000,
            ).unref();
          }),
        ]);

        process.kill(child!.pid!, signal);
        const result = await resultPromise;

        expect(result).toEqual({ code: expectedExitCode, signal: null });
        expect(stderr).toBe('');
      } finally {
        await client.close().catch(() => {});
        if (child?.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }
    },
    30_000,
  );

  it('treats stdin EOF as a normal disconnect and closes every owned runtime session', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const sessionCloses: Array<ReturnType<typeof vi.fn>> = [];
    let nextBrowser = 0;
    const driver: BrowserDriver = {
      async createSession(): Promise<BrowserDriverSession> {
        const close = vi.fn(async () => {});
        sessionCloses.push(close);
        return {
          browserId: `browser_${++nextBrowser}`,
          initialPageId: 'page_1',
          navigate: async () => {
            throw new Error('not used');
          },
          observe: async () => {
            throw new Error('not used');
          },
          act: async () => {
            throw new Error('not used');
          },
          pages: async () => [],
          capture: async () => {
            throw new Error('not used');
          },
          close,
        };
      },
    };
    const service = createBrowserIrRuntimeService(new BrowserIRRuntime(driver));
    const errors: Error[] = [];
    const handle = serveBrowserIrStdio({
      service,
      input,
      output,
      onError: (error) => errors.push(error),
    });
    await service.create({});
    await service.create({});

    await new Promise<void>((resolve) => setImmediate(resolve));
    input.end();
    await handle.closed;

    expect(sessionCloses).toHaveLength(2);
    expect(sessionCloses.every((close) => close.mock.calls.length === 1)).toBe(true);
    expect(errors).toEqual([]);
    await handle.close();
    expect(sessionCloses.every((close) => close.mock.calls.length === 1)).toBe(true);
    await expect(service.create({})).rejects.toMatchObject({ code: 'service_disposed' });
  });
});
