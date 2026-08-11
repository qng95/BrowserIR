import { describe, expect, it } from 'vitest';

import {
  pinBrowserProfile,
  restrictBrowserNavigation,
  type AgentToolBroker,
  type AgentToolCallResult,
} from '../src/agent-benchmark/index.js';

class RecordingBroker implements AgentToolBroker {
  readonly calls: Array<{ name: string; input: Record<string, unknown> }> = [];

  async listTools() {
    return [];
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<AgentToolCallResult> {
    this.calls.push({ name, input });
    return { text: 'ok', isError: false };
  }

  metrics() {
    return {
      calls: this.calls.length,
      errors: 0,
      byTool: Object.fromEntries(this.calls.map(({ name }) => [name, 1])),
      budgetExceeded: false,
    };
  }

  async close() {}
}

describe('browser navigation policy broker', () => {
  it('allows only top-level application routes at the isolated fixture origin', async () => {
    const inner = new RecordingBroker();
    const broker = restrictBrowserNavigation(inner, {
      allowedOrigin: 'http://127.0.0.1:4567',
      allowedPathPrefixes: ['/app/'],
      allowedExactPaths: ['/'],
    });

    await expect(
      broker.callTool('browser_navigate', { url: 'http://127.0.0.1:4567/app/customers' }),
    ).resolves.toMatchObject({ isError: false });
    await expect(
      broker.callTool('browser_navigate', { url: 'http://127.0.0.1:4567/api/tasks/verify' }),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      broker.callTool('browser_navigate', { url: 'https://example.com/' }),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      broker.callTool('browser_tabs', {
        action: 'new',
        url: 'https://example.com/escape',
      }),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      broker.callTool('browser_tabs', {
        action: 'new',
        url: 'http://127.0.0.1:4567/app/customers/new',
      }),
    ).resolves.toMatchObject({ isError: false });

    expect(inner.calls).toHaveLength(2);
    expect(broker.metrics()).toMatchObject({
      calls: 5,
      errors: 3,
      policyViolations: [
        'browser_navigate blocked path /api/tasks/verify',
        'browser_navigate blocked origin https://example.com',
        'browser_tabs blocked origin https://example.com',
      ],
    });
  });

  it('treats malformed and relative navigation URLs as policy violations', async () => {
    const broker = restrictBrowserNavigation(new RecordingBroker(), {
      allowedOrigin: 'http://127.0.0.1:4567',
      allowedPathPrefixes: ['/app/'],
    });
    const malformed = await broker.callTool('browser_navigate', { url: '/app/customers' });
    expect(malformed).toMatchObject({ isError: true });
    expect(broker.metrics().policyViolations).toEqual([
      'browser_navigate blocked malformed URL',
    ]);
  });
});

describe('fixed browser profile broker', () => {
  it('forces the declared profile even when an agent requests different values', async () => {
    const inner = new RecordingBroker();
    const broker = pinBrowserProfile(inner, {
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    });

    await broker.callTool('browser_create', {
      viewport: { width: 320, height: 200, device_scale_factor: 3 },
      locale: 'de-DE',
      timezone_id: 'Europe/Berlin',
      color_scheme: 'dark',
      reduced_motion: false,
    });

    expect(inner.calls).toEqual([
      {
        name: 'browser_create',
        input: {
          viewport: { width: 1440, height: 900, device_scale_factor: 1 },
          locale: 'en-US',
          timezone_id: 'UTC',
          color_scheme: 'light',
          reduced_motion: true,
        },
      },
    ]);
  });
});
