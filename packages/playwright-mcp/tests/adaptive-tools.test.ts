import type {
  CallToolResult,
  Client,
  ListToolsResult,
} from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';

import {
  createAdaptivePlaywrightTools,
  type AdaptivePlaywrightTelemetryEvent,
} from '../src/index.js';
import { createTestPolicySet } from './helpers/test-policy-set.js';

type RawClient = Pick<Client, 'callTool' | 'listTools'>;
type CallArgs = Parameters<RawClient['callTool']>;
type ListArgs = Parameters<RawClient['listTools']>;

const baselineSnapshot = (name = 'same'): string => `### Page state
- Page URL: https://fixture.test/app

### Snapshot
\`\`\`yaml
- application "App"
  - button "${name}" [ref=e1]
\`\`\`

### Console
- no messages`;

const boxedSnapshot = (
  name = 'same',
  ref = 'e9',
  url = 'https://fixture.test/app',
): string => `### Page state
- Page URL: ${url}

### Snapshot
\`\`\`yaml
- application "App" [box=0,0,800,600]
  - button "${name}" [ref=${ref}] [box=10,20,30,40]
\`\`\`

### Console
- no messages`;

const textResult = (text: string, extras: Record<PropertyKey, unknown> = {}): CallToolResult => ({
  content: [{ type: 'text', text }],
  ...extras,
}) as CallToolResult;

interface RecordedClient extends RawClient {
  readonly calls: CallArgs[];
  readonly lists: ListArgs[];
  readonly close: ReturnType<typeof vi.fn>;
}

const fakeClient = (input: {
  call?(...args: CallArgs): Promise<CallToolResult>;
  list?(...args: ListArgs): Promise<ListToolsResult>;
} = {}): RecordedClient => {
  const calls: CallArgs[] = [];
  const lists: ListArgs[] = [];
  return {
    calls,
    lists,
    close: vi.fn(async () => {}),
    async callTool(...args: CallArgs): Promise<CallToolResult> {
      calls.push(args);
      return input.call?.(...args) ?? textResult('plain result');
    },
    async listTools(...args: ListArgs): Promise<ListToolsResult> {
      lists.push(args);
      return input.list?.(...args) ?? { tools: [] };
    },
  };
};

const projectingPolicy = () => createTestPolicySet({
  evaluate: () => ({ kind: 'capture-boxes' }),
  project: ({ enrichedSnapshotTree }) => ({
    kind: 'resolved',
    supplement: {
      schema: 'test-projection/1',
      facts: [{ kind: 'coordinate', ref: /\[ref=([^\]]+)\]/u.exec(enrichedSnapshotTree)?.[1] ?? 'e9', attributes: { lane: 'A' } }],
    },
  }),
});

const passthroughPolicy = () => createTestPolicySet({
  evaluate: () => ({ kind: 'passthrough' }),
  project: () => ({ kind: 'unresolved' }),
});

describe('createAdaptivePlaywrightTools raw fidelity', () => {
  it('returns the exact raw listTools object and forwards both arguments by identity', async () => {
    const raw = Object.assign({ tools: [], nextCursor: 'cursor' }, { extension: { retained: true } }) as ListToolsResult;
    const client = fakeClient({ list: async () => raw });
    const tools = createAdaptivePlaywrightTools(client, { mode: 'off', policySet: passthroughPolicy() });
    const params = { cursor: 'input-cursor' };
    const options = { cacheMode: 'bypass' as const, timeout: 19 };

    const returned = await tools.listTools(params, options);

    expect(returned).toBe(raw);
    expect(client.lists).toHaveLength(1);
    expect(client.lists[0]?.[0]).toBe(params);
    expect(client.lists[0]?.[1]).toBe(options);
  });

  it('returns the exact visible result in off mode and forwards request/options by identity', async () => {
    const result = textResult(baselineSnapshot(), { structuredContent: { raw: true } });
    const client = fakeClient({ call: async () => result });
    const tools = createAdaptivePlaywrightTools(client, { mode: 'off', policySet: projectingPolicy() });
    const request = { name: 'browser_snapshot', arguments: {} };
    const onprogress = vi.fn();
    const options = { timeout: 23, onprogress };

    const returned = await tools.callTool(request, options);

    expect(returned).toBe(result);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.[0]).toBe(request);
    expect(client.calls[0]?.[1]).toBe(options);
  });

  it('preserves every raw content type, order, metadata, unknown key, and unaffected reference on projection', async () => {
    const annotations = { audience: ['assistant'], priority: 0.7 };
    const blockMeta = { source: 'upstream' };
    const rootMeta = { requestId: 'raw-1' };
    const structuredContent = { nested: { retained: true } };
    const audio = { type: 'audio', data: 'AA==', mimeType: 'audio/wav', annotations };
    const resource = {
      type: 'resource',
      resource: { uri: 'memory://one', mimeType: 'text/plain', text: 'resource' },
      annotations,
      _meta: blockMeta,
    };
    const resourceLink = { type: 'resource_link', name: 'one', uri: 'memory://one', _meta: blockMeta };
    const targetText = Object.assign(
      { type: 'text', text: baselineSnapshot(), annotations, _meta: blockMeta },
      { vendorTextKey: { retained: true } },
    );
    const image = { type: 'image', data: 'AA==', mimeType: 'image/png', annotations, _meta: blockMeta };
    const trailingText = { type: 'text', text: 'trailing text', annotations, _meta: blockMeta };
    const unknownRoot = { retained: true };
    const blockSymbol = Symbol('block-extension');
    const resultSymbol = Symbol('result-extension');
    const arraySymbol = Symbol('content-extension');
    Object.defineProperty(targetText, blockSymbol, { value: blockMeta, enumerable: false });
    const content = [audio, resource, resourceLink, targetText, image, trailingText];
    Object.defineProperty(content, arraySymbol, { value: annotations, enumerable: false });
    const result = Object.assign({
      content,
      structuredContent,
      isError: false,
      _meta: rootMeta,
    }, { vendorResultKey: unknownRoot }) as unknown as CallToolResult;
    Object.defineProperty(result, resultSymbol, { value: structuredContent, enumerable: false });
    const hidden = textResult(boxedSnapshot());
    const client = fakeClient({ call: async ({ arguments: args }) => args?.boxes === true ? hidden : result });
    const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet: projectingPolicy() });

    const returned = await tools.callTool({ name: 'browser_snapshot', arguments: {} });

    expect(returned).not.toBe(result);
    expect(returned.content).not.toBe(result.content);
    expect(returned.content).toHaveLength(result.content.length);
    for (const index of [0, 1, 2, 4, 5]) expect(returned.content[index]).toBe(result.content[index]);
    const returnedText = returned.content[3] as typeof targetText;
    expect(returnedText).not.toBe(targetText);
    expect(returnedText.annotations).toBe(annotations);
    expect(returnedText._meta).toBe(blockMeta);
    expect(returnedText.vendorTextKey).toBe(targetText.vendorTextKey);
    expect((returnedText as unknown as Record<PropertyKey, unknown>)[blockSymbol]).toBe(blockMeta);
    expect((returned.content as unknown as Record<PropertyKey, unknown>)[arraySymbol]).toBe(annotations);
    expect(returned.structuredContent).toBe(structuredContent);
    expect(returned._meta).toBe(rootMeta);
    expect((returned as unknown as { vendorResultKey: unknown }).vendorResultKey).toBe(unknownRoot);
    expect((returned as unknown as Record<PropertyKey, unknown>)[resultSymbol]).toBe(structuredContent);
    expect(returned.isError).toBe(false);
    expect(returnedText.text).toContain('### Adaptive context');
    expect(returnedText.text).toContain('- coordinate [ref=e9] lane="A"');
    expect(returnedText.text).not.toMatch(/\[box=-?\d+,-?\d+,\d+,\d+\]/u);
    expect(returned.content.map(({ type }) => type)).toEqual([
      'audio', 'resource', 'resource_link', 'text', 'image', 'text',
    ]);
  });

  it('mirrors non-extensible, sealed, and frozen integrity on projected clones', async () => {
    const hardeners = [
      (value: object) => Object.preventExtensions(value),
      (value: object) => Object.seal(value),
      (value: object) => Object.freeze(value),
    ];
    for (const harden of hardeners) {
      const target = { type: 'text' as const, text: baselineSnapshot() };
      const content = [target];
      const visible = { content } as CallToolResult;
      harden(target);
      harden(content);
      harden(visible);
      const hidden = textResult(boxedSnapshot());
      const client = fakeClient({
        call: async ({ arguments: args }) => args?.boxes === true ? hidden : visible,
      });
      const tools = createAdaptivePlaywrightTools(client, {
        mode: 'auto',
        policySet: projectingPolicy(),
      });

      const projected = await tools.callTool({ name: 'browser_snapshot', arguments: {} });
      const projectedTarget = projected.content[0]!;
      expect(projected).not.toBe(visible);
      expect(Object.isExtensible(projected)).toBe(Object.isExtensible(visible));
      expect(Object.isSealed(projected)).toBe(Object.isSealed(visible));
      expect(Object.isFrozen(projected)).toBe(Object.isFrozen(visible));
      expect(Object.isExtensible(projected.content)).toBe(Object.isExtensible(content));
      expect(Object.isSealed(projected.content)).toBe(Object.isSealed(content));
      expect(Object.isFrozen(projected.content)).toBe(Object.isFrozen(content));
      expect(Object.isExtensible(projectedTarget)).toBe(Object.isExtensible(target));
      expect(Object.isSealed(projectedTarget)).toBe(Object.isSealed(target));
      expect(Object.isFrozen(projectedTarget)).toBe(Object.isFrozen(target));
      await tools.dispose();
    }
  });

  it('uses exact passthrough identity for unsupported, malformed, tool-error, hidden-error, and policy-failure paths', async () => {
    const cases: Array<{
      visible: CallToolResult;
      hidden?: CallToolResult | Error;
      policy?: ReturnType<typeof projectingPolicy>;
      expectedCalls: number;
    }> = [
      { visible: textResult('no snapshot'), expectedCalls: 1 },
      { visible: textResult(`${baselineSnapshot()}\n### Snapshot\n- duplicate`), expectedCalls: 1 },
      { visible: textResult(baselineSnapshot(), { isError: true }), expectedCalls: 1 },
      { visible: textResult(baselineSnapshot()), hidden: new Error('hidden failed'), expectedCalls: 2 },
      { visible: textResult(baselineSnapshot()), hidden: textResult('not a snapshot'), expectedCalls: 2 },
      {
        visible: Object.defineProperty(textResult(baselineSnapshot()), 'isError', {
          get: () => { throw new Error('hostile visible getter'); },
        }),
        expectedCalls: 1,
      },
      {
        visible: textResult(baselineSnapshot()),
        hidden: Object.defineProperty(textResult(boxedSnapshot()), 'isError', {
          get: () => { throw new Error('hostile hidden getter'); },
        }),
        expectedCalls: 2,
      },
      {
        visible: textResult(baselineSnapshot()),
        hidden: textResult(boxedSnapshot()),
        policy: createTestPolicySet({
          evaluate: () => ({ kind: 'capture-boxes' }),
          project: () => { throw new Error('projection failed'); },
        }),
        expectedCalls: 2,
      },
    ];

    for (const testCase of cases) {
      const client = fakeClient({
        async call({ arguments: args }) {
          if (args?.boxes !== true) return testCase.visible;
          if (testCase.hidden instanceof Error) throw testCase.hidden;
          return testCase.hidden ?? textResult(boxedSnapshot());
        },
      });
      const tools = createAdaptivePlaywrightTools(client, {
        mode: 'auto',
        policySet: testCase.policy ?? projectingPolicy(),
      });
      await expect(tools.callTool({ name: 'browser_snapshot', arguments: {} })).resolves.toBe(testCase.visible);
      expect(client.calls).toHaveLength(testCase.expectedCalls);
    }
  });
});

describe('adaptive acquisition boundaries', () => {
  it('makes zero hidden calls for non-snapshots and sufficient policies, and at most one with no retry', async () => {
    const ordinary = textResult('clicked');
    const sufficient = textResult(baselineSnapshot());
    for (const [request, policy, expected] of [
      [{ name: 'browser_click', arguments: { ref: 'e1' } }, projectingPolicy(), ordinary],
      [{ name: 'browser_snapshot', arguments: {} }, passthroughPolicy(), sufficient],
      [{ name: 'browser_snapshot', arguments: { boxes: true } }, projectingPolicy(), sufficient],
    ] as const) {
      const client = fakeClient({ call: async () => expected });
      const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet: policy });
      await expect(tools.callTool(request)).resolves.toBe(expected);
      expect(client.calls).toHaveLength(1);
    }

    let hiddenAttempts = 0;
    const visible = textResult(baselineSnapshot());
    const client = fakeClient({
      async call({ arguments: args }) {
        if (args?.boxes !== true) return visible;
        hiddenAttempts += 1;
        throw new Error('never retry me');
      },
    });
    const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet: projectingPolicy() });
    await expect(tools.callTool({ name: 'browser_snapshot', arguments: {} })).resolves.toBe(visible);
    expect(hiddenAttempts).toBe(1);
    expect(client.calls).toHaveLength(2);
  });

  it('forwards visible safe options exactly and derives an isolated remaining-budget object', async () => {
    const visible = textResult(baselineSnapshot());
    const hidden = textResult(boxedSnapshot());
    const controller = new AbortController();
    const options = {
      signal: controller.signal,
      timeout: 1_000,
      maxTotalTimeout: 2_000,
    };
    const client = fakeClient({ call: async ({ arguments: args }) => args?.boxes === true ? hidden : visible });
    const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet: projectingPolicy() });

    await tools.callTool({ name: 'browser_snapshot', arguments: {} }, options);

    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]?.[1]).toBe(options);
    const hiddenOptions = client.calls[1]?.[1];
    expect(hiddenOptions).not.toBe(options);
    expect(Object.getPrototypeOf(hiddenOptions!)).toBeNull();
    expect(hiddenOptions?.signal).toBe(controller.signal);
    expect(hiddenOptions?.timeout).toBeGreaterThan(0);
    expect(hiddenOptions?.timeout).toBeLessThanOrEqual(options.timeout);
    expect(hiddenOptions?.maxTotalTimeout).toBeGreaterThan(0);
    expect(hiddenOptions?.maxTotalTimeout).toBeLessThanOrEqual(options.maxTotalTimeout);
    expect(hiddenOptions).not.toHaveProperty('onprogress');
    expect(hiddenOptions).not.toHaveProperty('toolDefinition');
    expect(client.calls[1]?.[0]).toEqual({ name: 'browser_snapshot', arguments: { boxes: true } });
  });

  it('honors a signal aborted after the visible response and before hidden acquisition', async () => {
    const visible = textResult(baselineSnapshot());
    const controller = new AbortController();
    const client = fakeClient({
      async call() {
        controller.abort();
        return visible;
      },
    });
    const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet: projectingPolicy() });

    await expect(tools.callTool(
      { name: 'browser_snapshot', arguments: {} },
      { signal: controller.signal },
    )).resolves.toBe(visible);
    expect(client.calls).toHaveLength(1);
  });

  it('serializes each visible+hidden transaction and drains without closing the caller client', async () => {
    const visibleOne = textResult(baselineSnapshot());
    const hiddenOne = textResult(boxedSnapshot());
    const visibleTwo = textResult('second');
    let releaseVisible!: () => void;
    const visibleGate = new Promise<void>((resolve) => { releaseVisible = resolve; });
    const order: string[] = [];
    let callOrdinal = 0;
    const client = fakeClient({
      async call({ arguments: args }) {
        callOrdinal += 1;
        if (callOrdinal === 1) {
          order.push('visible-1:start');
          await visibleGate;
          order.push('visible-1:end');
          return visibleOne;
        }
        if (args?.boxes === true) {
          order.push('hidden-1');
          return hiddenOne;
        }
        order.push('visible-2');
        return visibleTwo;
      },
    });
    const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet: projectingPolicy() });
    const first = tools.callTool({ name: 'browser_snapshot', arguments: {} });
    const second = tools.callTool({ name: 'browser_click', arguments: { ref: 'e1' } });
    const disposed = tools.dispose();
    let drained = false;
    void disposed.then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(tools.listTools()).rejects.toThrow(/disposed/u);
    releaseVisible();

    await expect(first).resolves.not.toBe(visibleOne);
    await expect(second).resolves.toBe(visibleTwo);
    await disposed;
    expect(order).toEqual(['visible-1:start', 'visible-1:end', 'hidden-1', 'visible-2']);
    expect(client.close).not.toHaveBeenCalled();
    await expect(tools.dispose()).resolves.toBeUndefined();
  });
});

describe('bounded parsing, state commitment, and privacy', () => {
  it('accepts ref/box-only recapture differences but rejects URL or semantic state drift', async () => {
    const visible = textResult(baselineSnapshot('same'));
    for (const [hiddenText, projected] of [
      [boxedSnapshot('same', 'e91'), true],
      [boxedSnapshot('changed', 'e91'), false],
      [boxedSnapshot('same', 'e91', 'https://fixture.test/other'), false],
    ] as const) {
      const hidden = textResult(hiddenText);
      const client = fakeClient({ call: async ({ arguments: args }) => args?.boxes === true ? hidden : visible });
      const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet: projectingPolicy() });
      const result = await tools.callTool({ name: 'browser_snapshot', arguments: {} });
      if (projected) expect(result).not.toBe(visible);
      else expect(result).toBe(visible);
    }
  });

  it('fails open on oversized and fuzzed snapshot-looking text without a hidden call', async () => {
    const oversized = textResult(`### Snapshot\n${'x'.repeat(1_100_000)}`);
    const oversizedClient = fakeClient({ call: async () => oversized });
    const oversizedTools = createAdaptivePlaywrightTools(oversizedClient, { mode: 'auto', policySet: projectingPolicy() });
    await expect(oversizedTools.callTool({ name: 'browser_snapshot', arguments: {} })).resolves.toBe(oversized);
    expect(oversizedClient.calls).toHaveLength(1);

    let state = 0x1234_5678;
    const random = (): number => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    };
    for (let index = 0; index < 128; index += 1) {
      const alphabet = '# Snapshot`[]\r\n- abcXYZ0123';
      let text = index % 3 === 0 ? '### Snapshot\n' : '';
      const length = random() % 1024;
      for (let offset = 0; offset < length; offset += 1) text += alphabet[random() % alphabet.length];
      const visible = textResult(text);
      const client = fakeClient({ call: async () => visible });
      const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet: projectingPolicy() });
      const result = await tools.callTool({ name: 'browser_snapshot', arguments: {} });
      expect(result).toBe(visible);
      expect(client.calls).toHaveLength(1);
    }
  });

  it('fails open when an MCP result exceeds aggregate content bounds', async () => {
    const tooManyBlocks = {
      content: [
        ...Array.from({ length: 256 }, () => ({ type: 'text' as const, text: 'plain' })),
        { type: 'text' as const, text: baselineSnapshot() },
      ],
    } satisfies CallToolResult;
    const tooManyClient = fakeClient({ call: async () => tooManyBlocks });
    const tooManyTools = createAdaptivePlaywrightTools(tooManyClient, {
      mode: 'auto',
      policySet: projectingPolicy(),
    });

    await expect(tooManyTools.callTool({
      name: 'browser_snapshot',
      arguments: {},
    })).resolves.toBe(tooManyBlocks);
    expect(tooManyClient.calls).toHaveLength(1);

    const repeated = 'x'.repeat(250_001);
    const tooMuchText = {
      content: [
        { type: 'text' as const, text: baselineSnapshot() },
        ...Array.from({ length: 4 }, () => ({ type: 'text' as const, text: repeated })),
      ],
    } satisfies CallToolResult;
    const tooMuchTextClient = fakeClient({ call: async () => tooMuchText });
    const tooMuchTextTools = createAdaptivePlaywrightTools(tooMuchTextClient, {
      mode: 'auto',
      policySet: projectingPolicy(),
    });

    await expect(tooMuchTextTools.callTool({
      name: 'browser_snapshot',
      arguments: {},
    })).resolves.toBe(tooMuchText);
    expect(tooMuchTextClient.calls).toHaveLength(1);
  });

  it('rejects a projected supplement that could leak raw geometry', async () => {
    const visible = textResult(baselineSnapshot('never emit me'));
    const hidden = textResult(boxedSnapshot('never emit me'));
    const leakingPolicy = createTestPolicySet({
      evaluate: () => ({ kind: 'capture-boxes' }),
      project: () => ({
        kind: 'resolved',
        supplement: {
          schema: 'leak-test/1',
          facts: [{ kind: 'coordinate', ref: 'e9', attributes: { detail: '[box=10,20,30,40]' } }],
        },
      }),
    });
    const client = fakeClient({ call: async ({ arguments: args }) => args?.boxes === true ? hidden : visible });
    const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet: leakingPolicy });

    await expect(tools.callTool({ name: 'browser_snapshot', arguments: {} })).resolves.toBe(visible);
  });

  it('keeps telemetry opt-in, bounded, immutable, and free of browser payloads', async () => {
    const visible = textResult(baselineSnapshot());
    const hidden = textResult(boxedSnapshot());
    const events: AdaptivePlaywrightTelemetryEvent[] = [];
    const client = fakeClient({ call: async ({ arguments: args }) => args?.boxes === true ? hidden : visible });
    const tools = createAdaptivePlaywrightTools(client, {
      mode: 'auto',
      policySet: projectingPolicy(),
      telemetry: { onEvent: (event) => events.push(event) },
    });

    await tools.callTool({ name: 'browser_snapshot', arguments: {} });

    expect(events).toHaveLength(1);
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(JSON.stringify(events)).not.toContain('fixture.test');
    expect(JSON.stringify(events)).not.toContain('never emit me');
    expect(JSON.stringify(events)).not.toContain('e9');
    expect(events[0]).toMatchObject({ hiddenCalls: 1, outcome: 'projected' });
  });

  it('rejects unbranded policy objects at runtime', () => {
    const client = fakeClient();
    expect(() => createAdaptivePlaywrightTools(client, {
      mode: 'auto',
      policySet: {} as ReturnType<typeof projectingPolicy>,
    })).toThrow(/first-party policy set/u);
  });
});
