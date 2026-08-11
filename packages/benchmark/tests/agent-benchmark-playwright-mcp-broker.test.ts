import { describe, expect, it } from 'vitest';

import {
  PLAYWRIGHT_MCP_SAFE_TOOL_NAMES,
  PLAYWRIGHT_MCP_VERSION,
  createPlaywrightMcpToolBroker,
} from '../src/agent-benchmark/index.js';

const forbiddenTools = [
  'browser_console_messages',
  'browser_evaluate',
  'browser_file_upload',
  'browser_network_request',
  'browser_network_requests',
  'browser_run_code_unsafe',
] as const;

describe('official Playwright MCP benchmark broker', () => {
  it('pins the official package and exposes only the declared safe catalog', async () => {
    expect(PLAYWRIGHT_MCP_VERSION).toBe('0.0.78');
    const broker = await createPlaywrightMcpToolBroker({
      allowedOrigin: 'http://127.0.0.1:31234',
      headless: true,
    });

    try {
      const tools = await broker.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(PLAYWRIGHT_MCP_SAFE_TOOL_NAMES);
      expect(tools.map((tool) => tool.name)).not.toEqual(
        expect.arrayContaining([...forbiddenTools]),
      );
      expect(broker.metrics()).toMatchObject({
        calls: 0,
        errors: 0,
        byTool: {},
        budgetExceeded: false,
      });
    } finally {
      await broker.close();
    }
  });
});
