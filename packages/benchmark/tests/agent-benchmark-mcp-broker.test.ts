import type { BrowserIrService } from '@browserir/mcp';
import {
  BROWSERIR_PROTOCOL_VERSION,
  BrowserIrServiceError,
  SAFE_BROWSER_TOOL_NAMES,
  createBrowserIrMcpHandler,
} from '@browserir/mcp';
import { describe, expect, it, vi } from 'vitest';

import { connectMcpToolBroker } from '../src/agent-benchmark/mcp-broker.js';

const result = (summary: string, data: Record<string, unknown> = {}) =>
  Promise.resolve({ summary, data });

function fakeService(): BrowserIrService {
  return {
    create: async () => ({
      summary: 'Created an isolated browser.',
      data: { browser_id: 'browser-1', page_id: 'page-1', revision: 0 },
    }),
    navigate: () => result('navigated'),
    observe: () => result('observed'),
    inspect: () => result('inspected'),
    act: () => result('acted'),
    wait: () => result('waited'),
    pages: () => result('pages'),
    capture: async () => ({
      summary: 'captured',
      data: { browser_id: 'browser-1' },
      image: { data: 'aW1hZ2U=', mime_type: 'image/png' },
    }),
    close: () => result('closed'),
  };
}

describe('MCP tool broker', () => {
  it('uses one official MCP connection and exposes exactly the safe BrowserIR catalog', async () => {
    const handler = createBrowserIrMcpHandler({ service: fakeService() });
    const closeServer = vi.fn(async () => handler.close());
    const broker = await connectMcpToolBroker({
      endpoint: new URL('http://browserir.test/mcp'),
      protocolVersion: BROWSERIR_PROTOCOL_VERSION,
      clientName: 'agent-benchmark-unit',
      fetch: (url, init) => handler.fetch(new Request(url, init)),
      closeServer,
    });

    const catalog = await broker.listTools();
    expect(catalog.map((tool) => tool.name)).toEqual(SAFE_BROWSER_TOOL_NAMES);
    expect(catalog.some((tool) => tool.name.includes('evaluate'))).toBe(false);

    const called = await broker.callTool('browser_create', {});
    expect(called).toMatchObject({
      text: 'Created an isolated browser.',
      isError: false,
      structuredContent: { browser_id: 'browser-1', page_id: 'page-1', revision: 0 },
    });
    expect(broker.metrics()).toEqual({
      calls: 1,
      errors: 0,
      byTool: { browser_create: 1 },
      budgetExceeded: false,
    });

    await broker.close();
    await broker.close();
    expect(closeServer).toHaveBeenCalledTimes(1);
    await expect(broker.callTool('browser_create', {})).rejects.toThrow('closed');
  });

  it('preserves image blocks instead of silently dropping screenshots', async () => {
    const handler = createBrowserIrMcpHandler({ service: fakeService() });
    const broker = await connectMcpToolBroker({
      endpoint: new URL('http://browserir.test/mcp'),
      protocolVersion: BROWSERIR_PROTOCOL_VERSION,
      clientName: 'agent-benchmark-image-unit',
      fetch: (url, init) => handler.fetch(new Request(url, init)),
      closeServer: () => handler.close(),
    });

    try {
      const captured = await broker.callTool('browser_capture', {
        browser_id: 'browser-1',
        page_id: 'page-1',
        expected_revision: 0,
      });
      expect(captured.content).toEqual([
        { type: 'text', text: 'captured' },
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      ]);
    } finally {
      await broker.close();
    }
  });

  it('counts protocol and tool failures as attempted calls', async () => {
    const service = fakeService();
    service.observe = async () => {
      throw new BrowserIrServiceError('observation_failed', 'fixture failure');
    };
    const handler = createBrowserIrMcpHandler({ service });
    const broker = await connectMcpToolBroker({
      endpoint: new URL('http://browserir.test/mcp'),
      protocolVersion: BROWSERIR_PROTOCOL_VERSION,
      clientName: 'agent-benchmark-error-unit',
      fetch: (url, init) => handler.fetch(new Request(url, init)),
      closeServer: () => handler.close(),
    });

    try {
      const failed = await broker.callTool('browser_observe', {
        browser_id: 'browser-1',
        page_id: 'page-1',
      });
      expect(failed).toMatchObject({ isError: true });
      expect(broker.metrics()).toMatchObject({ calls: 1, errors: 1 });
    } finally {
      await broker.close();
    }
  });
});
