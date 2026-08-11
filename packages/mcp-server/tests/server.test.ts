import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SAFE_BROWSER_TOOL_NAMES,
  createBrowserIrMcpHandler,
  type BrowserIrService,
} from '../src/index.js';

interface ConnectedClient {
  client: Client;
  close(): Promise<void>;
}

const connectedClients: ConnectedClient[] = [];

function fakeService(): BrowserIrService {
  return {
    create: vi.fn(async () => ({
      summary: 'Created browser br_test at revision 0.',
      data: { browser_id: 'br_test', page_id: 'pg_test', revision: 0 },
    })),
    navigate: vi.fn(async (input) => ({
      summary: `Navigated to ${input.url}.`,
      data: { browser_id: input.browser_id, revision: input.expected_revision + 1 },
    })),
    observe: vi.fn(async (input) => ({
      summary: 'Observed browser.',
      data: { browser_id: input.browser_id, revision: 4, view: 'compact view' },
    })),
    inspect: vi.fn(async (input) => ({
      summary: 'Inspected entities.',
      data: { browser_id: input.browser_id, entity_ids: input.entity_ids, revision: input.expected_revision },
    })),
    act: vi.fn(async (input) => ({
      summary: 'Action verified.',
      data: {
        browser_id: input.browser_id,
        pre_revision: input.expected_revision,
        post_revision: input.expected_revision + 1,
        status: 'verified',
      },
    })),
    wait: vi.fn(async (input) => ({
      summary: 'Condition reached.',
      data: { browser_id: input.browser_id, revision: input.expected_revision },
    })),
    pages: vi.fn(async (input) => ({
      summary: 'Found one page.',
      data: { browser_id: input.browser_id, pages: [{ page_id: 'pg_test' }] },
    })),
    capture: vi.fn(async (input) => ({
      summary: 'Captured viewport.',
      data: {
        browser_id: input.browser_id,
        revision: input.expected_revision,
        mime_type: 'image/png',
        artifact_id: 'artifact_test',
      },
    })),
    close: vi.fn(async (input) => ({
      summary: `Closed ${input.browser_id}.`,
      data: { browser_id: input.browser_id, closed: true },
    })),
  };
}

async function connect(
  service: BrowserIrService,
  enableUnsafeEvaluate = false,
  observedMethods?: string[],
): Promise<Client> {
  const handler = createBrowserIrMcpHandler({ service, enableUnsafeEvaluate });
  const transport = new StreamableHTTPClientTransport(new URL('http://browserir.test/mcp'), {
    fetch: (url, init) => {
      const request = new Request(url, init);
      const method = request.headers.get('Mcp-Method');
      if (method !== null) observedMethods?.push(method);
      return handler.fetch(request);
    },
  });
  const client = new Client(
    { name: 'browserir-test-client', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await client.connect(transport);
  connectedClients.push({
    client,
    close: async () => {
      await client.close();
      await handler.close();
    },
  });
  return client;
}

afterEach(async () => {
  await Promise.all(connectedClients.splice(0).map((entry) => entry.close()));
});

describe('BrowserIR MCP tool discovery', () => {
  it('advertises a deterministic safe surface and hides arbitrary evaluation by default', async () => {
    const client = await connect(fakeService());

    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name);
    const observe = result.tools.find((tool) => tool.name === 'browser_observe');
    const act = result.tools.find((tool) => tool.name === 'browser_act');

    expect(names).toEqual(SAFE_BROWSER_TOOL_NAMES);
    expect(names).not.toContain('browser_evaluate_unsafe');
    expect(observe?.inputSchema).not.toHaveProperty('properties.mode');
    expect(observe?.inputSchema).not.toHaveProperty('properties.intent');
    expect(observe?.inputSchema).not.toHaveProperty('properties.focus_entity_ids');
    expect(observe?.inputSchema).not.toHaveProperty('properties.since_revision');
    expect(observe?.description).toContain('current compact BrowserIR view');
    expect(observe?.description).not.toContain('known revision');
    expect(act?.description).toContain(
      'entity-targeted or page-scoped typed action',
    );
  });

  it('advertises arbitrary page evaluation only after explicit opt-in', async () => {
    const service = {
      ...fakeService(),
      evaluateUnsafe: vi.fn(async (_input: unknown, _context?: unknown) => ({
        summary: 'Evaluated page expression.',
        data: { browser_id: 'br_test', revision: 1, value: 2 },
      })),
    };

    const client = await connect(service, true);
    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name)).toEqual([
      ...SAFE_BROWSER_TOOL_NAMES,
      'browser_evaluate_unsafe',
    ]);
    expect(result).toMatchObject({ ttlMs: 0, cacheScope: 'private' });
  });

  it('keeps unsafe evaluation schema explicit and within hard public bounds', async () => {
    const service = {
      ...fakeService(),
      evaluateUnsafe: vi.fn(async (_input: unknown, _context?: unknown) => ({
        summary: 'Evaluated page expression.',
        data: { browser_id: 'br_test', page_id: 'pg_test', revision: 2 },
      })),
    };
    const client = await connect(service, true);

    for (const arguments_ of [
      {
        browser_id: 'br_test',
        expected_revision: 1,
        expression: '1 + 1',
      },
      {
        browser_id: 'br_test',
        page_id: 'pg_test',
        expected_revision: 1,
        expression: 'x'.repeat(16_385),
      },
      {
        browser_id: 'br_test',
        page_id: 'pg_test',
        expected_revision: 1,
        expression: '1 + 1',
        timeout_ms: 5_001,
      },
      {
        browser_id: 'br_test',
        page_id: 'pg_test',
        expected_revision: 1,
        expression: '1 + 1',
        max_output_bytes: 65_537,
      },
    ]) {
      const result = await client.callTool({
        name: 'browser_evaluate_unsafe',
        arguments: arguments_,
      });
      expect(result.isError).toBe(true);
    }
    expect(service.evaluateUnsafe).not.toHaveBeenCalled();

    const result = await client.callTool({
      name: 'browser_evaluate_unsafe',
      arguments: {
        browser_id: 'br_test',
        page_id: 'pg_test',
        expected_revision: 1,
        expression: '1 + 1',
        timeout_ms: 500,
        max_output_bytes: 1024,
        max_tokens: 512,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(service.evaluateUnsafe).toHaveBeenCalledOnce();
    expect(service.evaluateUnsafe.mock.calls[0]?.[1]).toMatchObject({
      signal: expect.any(AbortSignal),
    });
  });

  it('forwards MCP request cancellation to unsafe evaluation', async () => {
    let receivedSignal: AbortSignal | undefined;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });
    const service: BrowserIrService = {
      ...fakeService(),
      evaluateUnsafe: vi.fn(async (_input, context) => {
        receivedSignal = context?.signal;
        resolveStarted();
        await new Promise<void>((resolve) => {
          const finish = () => {
            resolveAborted();
            resolve();
          };
          if (context?.signal?.aborted === true) finish();
          else context?.signal?.addEventListener('abort', finish, { once: true });
        });
        return {
          summary: 'Unsafe evaluation cancelled.',
          data: { outcome: 'cancelled' },
          is_error: true,
        };
      }),
    };
    const client = await connect(service, true);
    const controller = new AbortController();
    const pending = client.callTool(
      {
        name: 'browser_evaluate_unsafe',
        arguments: {
          browser_id: 'br_test',
          page_id: 'pg_test',
          expected_revision: 1,
          expression: 'new Promise(() => {})',
        },
      },
      { signal: controller.signal },
    );

    await started;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await aborted;
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('serves modern discovery and a publicly cacheable static tool catalog', async () => {
    const observedMethods: string[] = [];
    const client = await connect(fakeService(), false, observedMethods);

    const connectedDiscovery = client.getDiscoverResult();
    expect(connectedDiscovery).toMatchObject({
      supportedVersions: expect.arrayContaining(['2026-07-28']),
      capabilities: { tools: {} },
      ttlMs: 300_000,
      cacheScope: 'public',
    });
    expect(client.getServerCapabilities()).toEqual(connectedDiscovery?.capabilities);

    const refreshedDiscovery = await client.discover();
    expect(refreshedDiscovery).toMatchObject({
      ttlMs: 300_000,
      cacheScope: 'public',
    });
    expect(client.getDiscoverResult()).toEqual(refreshedDiscovery);

    const firstCatalog = await client.listTools();
    expect(firstCatalog).toMatchObject({
      ttlMs: 300_000,
      cacheScope: 'public',
    });
    const listRequestsAfterFirstRead = observedMethods.filter(
      (method) => method === 'tools/list',
    ).length;

    const cachedCatalog = await client.listTools();
    expect(cachedCatalog).toEqual(firstCatalog);
    expect(observedMethods.filter((method) => method === 'tools/list')).toHaveLength(
      listRequestsAfterFirstRead,
    );

    await client.listTools(undefined, { cacheMode: 'refresh' });
    expect(observedMethods.filter((method) => method === 'tools/list')).toHaveLength(
      listRequestsAfterFirstRead + 1,
    );
  });

  it('advertises only wait and type behavior that is implemented end to end', async () => {
    const service = fakeService();
    const client = await connect(service);
    const tools = await client.listTools();
    const waitSchema = tools.tools.find((tool) => tool.name === 'browser_wait')?.inputSchema;
    const actSchema = tools.tools.find((tool) => tool.name === 'browser_act')?.inputSchema;
    const waitVariants = (
      (waitSchema as { properties?: { condition?: { anyOf?: unknown[] } } } | undefined)
        ?.properties?.condition?.anyOf ?? []
    ) as Array<{ properties?: { kind?: { const?: string }; state?: unknown } }>;
    const textWait = waitVariants.find(
      (variant) => variant.properties?.kind?.const === 'text',
    );

    expect(JSON.stringify(waitSchema)).not.toContain('"url"');
    expect(textWait?.properties?.state).toMatchObject({ const: 'visible' });
    expect(JSON.stringify(actSchema)).not.toContain('"delay_ms"');

    for (const condition of [
      { kind: 'url', value: 'https://example.test/complete' },
      { kind: 'text', value: 'Complete', state: 'hidden' },
    ]) {
      const result = await client.callTool({
        name: 'browser_wait',
        arguments: {
          browser_id: 'br_test',
          expected_revision: 2,
          condition,
        },
      });
      expect(result.isError).toBe(true);
    }
    expect(service.wait).not.toHaveBeenCalled();

    const delayedType = await client.callTool({
      name: 'browser_act',
      arguments: {
        browser_id: 'br_test',
        expected_revision: 2,
        action: {
          kind: 'type',
          target: { page_id: 'pg_test', entity_id: 'entity_search', revision: 2 },
          text: 'query',
          delay_ms: 20,
        },
      },
    });
    expect(delayedType.isError).toBe(true);
    expect(service.act).not.toHaveBeenCalled();

    const visibleText = await client.callTool({
      name: 'browser_wait',
      arguments: {
        browser_id: 'br_test',
        expected_revision: 2,
        condition: { kind: 'text', value: 'Complete', state: 'visible' },
      },
    });
    expect(visibleText.isError).not.toBe(true);
    expect(service.wait).toHaveBeenCalledOnce();
  });
});

describe('BrowserIR MCP calls', () => {
  it('returns explicit opaque browser state as structured content plus compact text', async () => {
    const service = fakeService();
    const client = await connect(service);

    const result = await client.callTool({
      name: 'browser_create',
      arguments: {},
    });

    expect(service.create).toHaveBeenCalledOnce();
    expect(result.structuredContent).toEqual({
      browser_id: 'br_test',
      page_id: 'pg_test',
      revision: 0,
    });
    expect(result.content).toEqual([
      { type: 'text', text: 'Created browser br_test at revision 0.' },
    ]);
  });

  it('does not leak unexpected internal error details to the model', async () => {
    const service = fakeService();
    service.create = vi.fn(async () => {
      throw new Error('connection failed with password=super-secret');
    });
    const client = await connect(service);

    const result = await client.callTool({
      name: 'browser_create',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('super-secret');
    expect(result.structuredContent).toEqual({
      error: {
        code: 'internal_error',
        message: 'BrowserIR operation failed.',
      },
    });
  });

  it('forwards the expected revision on state-changing calls', async () => {
    const service = fakeService();
    const client = await connect(service);

    await client.callTool({
      name: 'browser_navigate',
      arguments: {
        browser_id: 'br_test',
        url: 'https://example.test/customers',
        expected_revision: 7,
        max_tokens: 512,
      },
    });

    expect(service.navigate).toHaveBeenCalledWith({
      browser_id: 'br_test',
      url: 'https://example.test/customers',
      expected_revision: 7,
      max_tokens: 512,
    });
  });

  it('accepts the page-scoped entity references emitted by BrowserIR views', async () => {
    const service = fakeService();
    const client = await connect(service);

    await client.callTool({
      name: 'browser_act',
      arguments: {
        browser_id: 'br_test',
        expected_revision: 2,
        max_tokens: 256,
        action: {
          kind: 'click',
          target: {
            page_id: 'pg_test',
            entity_id: 'entity_save',
            revision: 2,
          },
        },
      },
    });

    expect(service.act).toHaveBeenCalledWith({
      browser_id: 'br_test',
      expected_revision: 2,
      max_tokens: 256,
      action: {
        kind: 'click',
        target: {
          page_id: 'pg_test',
          entity_id: 'entity_save',
          revision: 2,
        },
      },
    });
  });

  it('forwards a model-view budget for waits', async () => {
    const service = fakeService();
    const client = await connect(service);

    await client.callTool({
      name: 'browser_wait',
      arguments: {
        browser_id: 'br_test',
        page_id: 'pg_test',
        expected_revision: 2,
        max_tokens: 300,
        condition: { kind: 'revision_change' },
      },
    });

    expect(service.wait).toHaveBeenCalledWith({
      browser_id: 'br_test',
      page_id: 'pg_test',
      expected_revision: 2,
      max_tokens: 300,
      condition: { kind: 'revision_change' },
    });
  });

  it('rejects a state-changing call that omits its expected revision before dispatch', async () => {
    const service = fakeService();
    const client = await connect(service);

    const result = await client.callTool({
      name: 'browser_navigate',
      arguments: {
        browser_id: 'br_test',
        url: 'https://example.test/customers',
      },
    });

    expect(result.isError).toBe(true);
    expect(service.navigate).not.toHaveBeenCalled();
  });

  it('rejects local-file and inline-data navigation before dispatch', async () => {
    const service = fakeService();
    const client = await connect(service);

    for (const url of ['file:///etc/passwd', 'data:text/html,<h1>unsafe</h1>']) {
      const result = await client.callTool({
        name: 'browser_navigate',
        arguments: {
          browser_id: 'br_test',
          url,
          expected_revision: 0,
        },
      });
      expect(result.isError).toBe(true);
    }

    expect(service.navigate).not.toHaveBeenCalled();
  });
});
