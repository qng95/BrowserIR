import type { CallToolResult, Client, ListToolsResult } from '@modelcontextprotocol/client';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

import {
  createAdaptivePlaywrightTools,
  type AdaptivePlaywrightTelemetryEvent,
  type AdaptivePlaywrightTools,
} from '../src/index.js';
import {
  parseInlineSnapshot,
  parseSnapshotNodes,
  snapshotSemanticCommitment,
  stripSnapshotBoxes,
  type SnapshotScanCounter,
  type StructuralFact,
} from '../src/internal/snapshot.js';
import { createTestPolicySet } from './helpers/test-policy-set.js';

type RawClient = Pick<Client, 'callTool' | 'listTools'>;
type CallArgs = Parameters<RawClient['callTool']>;

const PROVENANCE = Object.freeze({
  policyId: 'test-policy',
  policyVersion: 'test-policy/1',
});

const baseline = (tree = '- application "App"\n  - button "same" [ref=e1]'): string => `### Page state
- Page URL: https://fixture.test/app

### Snapshot
\`\`\`yaml
${tree}
\`\`\`

### Console
- no messages`;

const boxed = (tree = '- application "App" [box=0,0,800,600]\n  - button "same" [ref=e9] [box=10,20,30,40]'): string => `### Page state
- Page URL: https://fixture.test/app

### Snapshot
\`\`\`yaml
${tree}
\`\`\`

### Console
- no messages`;

const result = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });

interface RecordedClient extends RawClient {
  readonly calls: CallArgs[];
}

const clientWith = (
  visible: CallToolResult,
  hidden: CallToolResult = result(boxed()),
): RecordedClient => {
  const calls: CallArgs[] = [];
  return {
    calls,
    async callTool(...args: CallArgs): Promise<CallToolResult> {
      calls.push(args);
      return calls.length === 1 ? visible : hidden;
    },
    async listTools(): Promise<ListToolsResult> {
      return { tools: [] };
    },
  };
};

const policy = (
  facts: readonly StructuralFact[] = [
    { kind: 'coordinate', ref: 'e9', attributes: { lane: 'A' } },
  ],
  overrides: Readonly<Record<string, unknown>> = {},
) => createTestPolicySet({
  policyId: 'test-policy',
  policyVersion: 'test-policy/1',
  supplementContracts: [{
    schema: 'test-projection/1',
    facts: [{ kind: 'coordinate', attributes: ['detail', 'lane'] }],
  }],
  evaluate: () => ({ kind: 'capture-boxes' }),
  project: () => ({
    kind: 'resolved',
    supplement: {
      schema: 'test-projection/1',
      provenance: PROVENANCE,
      facts,
      ...overrides,
    },
  }),
});

describe('official renderer box-separator normalization', () => {
  it('treats renderer-faithful bare-colon and scalar-colon boxes as metadata only', () => {
    const visible = [
      '- application "App" [ref=e1]:',
      '  - textbox "Status" [ref=e2]: Ready [ref=e777]',
      '',
    ].join('\n');
    const hidden = [
      '- application "App" [ref=f2e1] [box=0,0,800,600]:',
      '  - textbox "Status" [ref=f2e2] [box=10,20,300,40]: Ready [ref=e777]',
      '',
    ].join('\n');

    expect(snapshotSemanticCommitment(hidden)).toBe(snapshotSemanticCommitment(visible));
    expect(stripSnapshotBoxes(hidden)).toBe([
      '- application "App" [ref=f2e1]:',
      '  - textbox "Status" [ref=f2e2]: Ready [ref=e777]',
      '',
    ].join('\n'));
  });

  it('removes only valid pre-colon box metadata and preserves literal or malformed lookalikes', () => {
    const hidden = [
      '- application "Literal [box=1,2,3,4]" [ref=e1] [box=0,0,800,600]:',
      '  - button /Literal [box=5,6,7,8]/ [ref=e2] [box=10,20,30,40]: post [box=9,9,9,9]',
      '  - textbox "Malformed" [ref=e3] [box=1,2,3]: unchanged',
      '',
    ].join('\n');

    expect(stripSnapshotBoxes(hidden)).toBe([
      '- application "Literal [box=1,2,3,4]" [ref=e1]:',
      '  - button /Literal [box=5,6,7,8]/ [ref=e2]: post [box=9,9,9,9]',
      '  - textbox "Malformed" [ref=e3] [box=1,2,3]: unchanged',
      '',
    ].join('\n'));
  });

  it('projects renderer-faithful colons while rejecting real scalar or tree state changes', async () => {
    const visibleTree = [
      '- application "App" [ref=e1]:',
      '  - textbox "Status" [ref=e2]: Ready [ref=e777]',
    ].join('\n');
    const hiddenTree = [
      '- application "App" [ref=f2e1] [box=0,0,800,600]:',
      '  - textbox "Status" [ref=f2e2] [box=10,20,300,40]: Ready [ref=e777]',
    ].join('\n');
    const driftedTrees = [
      hiddenTree.replace('Ready [ref=e777]', 'Changed [ref=e777]'),
      hiddenTree.replace('textbox "Status"', 'textbox "Different"'),
    ];

    for (const [candidateTree, projected] of [
      [hiddenTree, true],
      ...driftedTrees.map((tree) => [tree, false] as const),
    ] as const) {
      const visibleResult = result(baseline(visibleTree));
      const client = clientWith(visibleResult, result(boxed(candidateTree)));
      const events: AdaptivePlaywrightTelemetryEvent[] = [];
      const tools = createAdaptivePlaywrightTools(client, {
        mode: 'auto',
        policySet: policy([
          { kind: 'coordinate', ref: 'f2e2', attributes: { lane: 'A' } },
        ]),
        telemetry: { onEvent: (event) => { events.push(event); } },
      });

      const returned = await tools.callTool({ name: 'browser_snapshot', arguments: {} });

      expect(client.calls).toHaveLength(2);
      if (projected) {
        expect(returned).not.toBe(visibleResult);
        const returnedText = returned.content[0];
        expect(returnedText?.type).toBe('text');
        if (returnedText?.type !== 'text') throw new Error('Expected projected snapshot text.');
        expect(returnedText.text).toContain('- application "App" [ref=f2e1]:');
        expect(returnedText.text).toContain(
          '  - textbox "Status" [ref=f2e2]: Ready [ref=e777]',
        );
        expect(returnedText.text).not.toContain('[box=0,0,800,600]');
        expect(events[0]?.outcome).toBe('projected');
      } else {
        expect(returned).toBe(visibleResult);
        expect(events[0]?.outcome).toBe('state-mismatch');
      }
      await tools.dispose();
    }
  });
});

describe('strict hidden-call admission', () => {
  it('rejects request and argument Proxies before adaptation without changing the visible call', async () => {
    for (const target of ['request', 'arguments'] as const) {
      const visible = result(baseline());
      const hidden = result(boxed());
      const calls: CallArgs[] = [];
      const seenNames: unknown[] = [];
      let requestProxyTraps = 0;
      let argumentsProxyTraps = 0;
      const proxiedArguments = new Proxy({}, {
        getPrototypeOf() {
          argumentsProxyTraps += 1;
          return Object.prototype;
        },
        ownKeys() {
          argumentsProxyTraps += 1;
          return [];
        },
        getOwnPropertyDescriptor() {
          argumentsProxyTraps += 1;
          return undefined;
        },
        isExtensible() {
          argumentsProxyTraps += 1;
          return true;
        },
      });
      const requestTarget = {
        name: 'browser_snapshot',
        arguments: target === 'arguments' ? proxiedArguments : {},
      };
      const request = target === 'request'
        ? new Proxy(requestTarget, {
            getPrototypeOf(value) {
              requestProxyTraps += 1;
              return Reflect.getPrototypeOf(value);
            },
            get(value, key, receiver) {
              requestProxyTraps += 1;
              if (key === 'name') return 'browser_click';
              return Reflect.get(value, key, receiver);
            },
          })
        : requestTarget;
      const client: RawClient = {
        async callTool(...args: CallArgs): Promise<CallToolResult> {
          calls.push(args);
          seenNames.push((args[0] as { name?: unknown }).name);
          return calls.length === 1 ? visible : hidden;
        },
        async listTools(): Promise<ListToolsResult> {
          return { tools: [] };
        },
      };
      const tools = createAdaptivePlaywrightTools(client, {
        mode: 'auto',
        policySet: policy(),
      });

      await expect(tools.callTool(request as CallArgs[0])).resolves.toBe(visible);
      expect(calls).toHaveLength(1);
      expect(seenNames).toEqual([
        target === 'request' ? 'browser_click' : 'browser_snapshot',
      ]);
      expect(requestProxyTraps).toBe(target === 'request' ? 1 : 0);
      expect(argumentsProxyTraps).toBe(0);
      await tools.dispose();
    }
  });

  it('admits frozen cross-realm snapshot requests and safe deadlines without losing commitment', async () => {
    const crossRealm = runInNewContext(`(() => {
      const requestArguments = Object.freeze({});
      const request = Object.freeze({ name: 'browser_snapshot', arguments: requestArguments });
      const options = Object.freeze({ timeout: 60000, maxTotalTimeout: 60000 });
      return Object.freeze({ request, options });
    })()`) as Readonly<{
      request: CallArgs[0];
      options: NonNullable<CallArgs[1]>;
    }>;
    const visible = result(baseline());
    const client = clientWith(visible, result(boxed()));
    const events: AdaptivePlaywrightTelemetryEvent[] = [];
    const tools = createAdaptivePlaywrightTools(client, {
      mode: 'auto',
      policySet: policy(),
      telemetry: { onEvent: (event) => { events.push(event); } },
    });

    const returned = await tools.callTool(crossRealm.request, crossRealm.options);

    expect(returned).not.toBe(visible);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]?.[0]).toBe(crossRealm.request);
    expect(client.calls[0]?.[1]).toBe(crossRealm.options);
    expect(client.calls[1]?.[0]).toEqual({
      name: 'browser_snapshot',
      arguments: { boxes: true },
    });
    expect(Object.getPrototypeOf(client.calls[1]?.[1] as object)).toBeNull();
    expect(events).toEqual([{
      schemaVersion: 'adaptive-playwright-telemetry/1',
      mode: 'auto',
      operation: 'snapshot',
      outcome: 'projected',
      hiddenCalls: 1,
    }]);
    await tools.dispose();
  });

  it('retains cross-realm request, argument, and options prototype identity during await', async () => {
    for (const target of ['request', 'arguments', 'options'] as const) {
      const crossRealm = runInNewContext(`({
        request: { name: 'browser_snapshot', arguments: {} },
        options: { timeout: 60000 },
      })`) as {
        request: Record<string, unknown>;
        options: Record<string, unknown>;
      };
      const visible = result(baseline());
      const calls: CallArgs[] = [];
      let markStarted!: () => void;
      let releaseVisible!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const release = new Promise<void>((resolve) => { releaseVisible = resolve; });
      const client: RawClient = {
        async callTool(...args: CallArgs): Promise<CallToolResult> {
          calls.push(args);
          markStarted();
          await release;
          return visible;
        },
        async listTools(): Promise<ListToolsResult> {
          return { tools: [] };
        },
      };
      const tools = createAdaptivePlaywrightTools(client, {
        mode: 'auto',
        policySet: policy(),
      });

      const pending = tools.callTool(
        crossRealm.request as CallArgs[0],
        crossRealm.options as CallArgs[1],
      );
      await started;
      const mutationTarget = target === 'request'
        ? crossRealm.request
        : target === 'arguments'
          ? crossRealm.request.arguments as object
          : crossRealm.options;
      Object.setPrototypeOf(mutationTarget, null);
      releaseVisible();

      await expect(pending).resolves.toBe(visible);
      expect(calls).toHaveLength(1);
      await tools.dispose();
    }
  });

  it('rejects cross-realm Object.prototype shape drift even when prototype identity is unchanged', async () => {
    const request = runInNewContext(`({ name: 'browser_snapshot', arguments: {} })`) as
      Record<string, unknown>;
    const foreignPrototype = Object.getPrototypeOf(request) as Record<string, unknown>;
    const visible = result(baseline());
    const calls: CallArgs[] = [];
    let markStarted!: () => void;
    let releaseVisible!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseVisible = resolve; });
    const client: RawClient = {
      async callTool(...args: CallArgs): Promise<CallToolResult> {
        calls.push(args);
        markStarted();
        await release;
        return visible;
      },
      async listTools(): Promise<ListToolsResult> {
        return { tools: [] };
      },
    };
    const tools = createAdaptivePlaywrightTools(client, {
      mode: 'auto',
      policySet: policy(),
    });

    const pending = tools.callTool(request as CallArgs[0]);
    await started;
    Object.defineProperty(foreignPrototype, '__browserirShapeDrift', {
      configurable: true,
      enumerable: false,
      value: true,
      writable: true,
    });
    releaseVisible();
    try {
      await expect(pending).resolves.toBe(visible);
      expect(calls).toHaveLength(1);
    } finally {
      Reflect.deleteProperty(foreignPrototype, '__browserirShapeDrift');
      await tools.dispose();
    }
  });

  it('rejects Proxy and lookalike request prototypes without invoking prototype traps', async () => {
    let prototypeTraps = 0;
    const proxiedPrototype = new Proxy(Object.create(null), {
      getPrototypeOf(target) {
        prototypeTraps += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        prototypeTraps += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        prototypeTraps += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const lookalikePrototype = Object.create(null);
    Object.defineProperties(
      lookalikePrototype,
      Object.getOwnPropertyDescriptors(Object.prototype),
    );
    const requests = [proxiedPrototype, lookalikePrototype].map((prototype) =>
      Object.assign(Object.create(prototype), {
        name: 'browser_snapshot',
        arguments: {},
      })) as CallArgs[0][];

    for (const request of requests) {
      const visible = result(baseline());
      const client = clientWith(visible);
      const tools = createAdaptivePlaywrightTools(client, {
        mode: 'auto',
        policySet: policy(),
      });

      await expect(tools.callTool(request)).resolves.toBe(visible);
      expect(client.calls).toHaveLength(1);
      await tools.dispose();
    }
    expect(prototypeTraps).toBe(0);
  });

  it('commits safe options before the visible call and rejects value/key/prototype drift', async () => {
    const cases: Array<{
      options: Record<string, unknown>;
      mutate(options: Record<string, unknown>): void;
    }> = [
      {
        options: { timeout: 50 },
        mutate(options) { options.timeout = 60_000; },
      },
      {
        options: {},
        mutate(options) { options.maxTotalTimeout = 60_000; },
      },
      {
        options: { timeout: 60_000 },
        mutate(options) { Object.setPrototypeOf(options, null); },
      },
      {
        options: { timeout: 60_000 },
        mutate(options) {
          Object.defineProperty(options, 'timeout', {
            configurable: true,
            enumerable: true,
            get: () => 60_000,
          });
        },
      },
    ];
    for (const testCase of cases) {
      const visible = result(baseline());
      const calls: CallArgs[] = [];
      let markStarted!: () => void;
      let releaseVisible!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const release = new Promise<void>((resolve) => { releaseVisible = resolve; });
      const client: RawClient = {
        async callTool(...args: CallArgs): Promise<CallToolResult> {
          calls.push(args);
          markStarted();
          await release;
          return visible;
        },
        async listTools(): Promise<ListToolsResult> {
          return { tools: [] };
        },
      };
      const tools = createAdaptivePlaywrightTools(client, {
        mode: 'auto',
        policySet: policy(),
      });

      const pending = tools.callTool(
        { name: 'browser_snapshot', arguments: {} },
        testCase.options as CallArgs[1],
      );
      await started;
      testCase.mutate(testCase.options);
      releaseVisible();

      await expect(pending).resolves.toBe(visible);
      expect(calls).toHaveLength(1);
      await tools.dispose();
    }
  });

  it('rejects a Proxy signal without invoking Proxy traps', async () => {
    const controller = new AbortController();
    let traps = 0;
    const signal = new Proxy(controller.signal, {
      getPrototypeOf(target) {
        traps += 1;
        return Reflect.getPrototypeOf(target);
      },
      get(target, key, receiver) {
        traps += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const visible = result(baseline());
    const client = clientWith(visible);
    const tools = createAdaptivePlaywrightTools(client, {
      mode: 'auto',
      policySet: policy(),
    });

    await expect(tools.callTool(
      { name: 'browser_snapshot', arguments: {} },
      { signal },
    )).resolves.toBe(visible);

    expect(client.calls).toHaveLength(1);
    expect(traps).toBe(0);
    await tools.dispose();
  });

  it('reads AbortSignal state through the intrinsic getter, bypassing an own accessor', async () => {
    const controller = new AbortController();
    let accessorCalls = 0;
    Object.defineProperty(controller.signal, 'aborted', {
      configurable: true,
      enumerable: true,
      get() {
        accessorCalls += 1;
        return true;
      },
    });
    const visible = result(baseline());
    const client = clientWith(visible, result(boxed()));
    const tools = createAdaptivePlaywrightTools(client, {
      mode: 'auto',
      policySet: policy(),
    });

    await expect(tools.callTool(
      { name: 'browser_snapshot', arguments: {} },
      { signal: controller.signal },
    )).resolves.not.toBe(visible);

    expect(client.calls).toHaveLength(2);
    expect(accessorCalls).toBe(0);
    await tools.dispose();
  });

  it('commits the exact request before the visible call and rejects mutation during await', async () => {
    const mutations: Array<{
      request: Record<string, unknown>;
      mutate(request: Record<string, unknown>): void;
    }> = [
      {
        request: { name: 'browser_click', arguments: {} },
        mutate(request) {
          request.name = 'browser_snapshot';
        },
      },
      {
        request: { name: 'browser_snapshot', arguments: {} },
        mutate(request) {
          (request.arguments as Record<string, unknown>).boxes = true;
        },
      },
      {
        request: { name: 'browser_snapshot', arguments: {} },
        mutate(request) {
          Object.defineProperty(request, 'name', {
            enumerable: true,
            configurable: true,
            get: () => 'browser_snapshot',
          });
        },
      },
      {
        request: { name: 'browser_snapshot', arguments: {} },
        mutate(request) {
          Object.setPrototypeOf(request.arguments as object, null);
        },
      },
      {
        request: { name: 'browser_snapshot', arguments: {} },
        mutate(request) {
          Object.setPrototypeOf(request, null);
        },
      },
    ];

    for (const testCase of mutations) {
      const visible = result(baseline());
      const calls: CallArgs[] = [];
      let markStarted!: () => void;
      let releaseVisible!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const release = new Promise<void>((resolve) => { releaseVisible = resolve; });
      const client: RawClient = {
        async callTool(...args: CallArgs): Promise<CallToolResult> {
          calls.push(args);
          markStarted();
          await release;
          return visible;
        },
        async listTools(): Promise<ListToolsResult> {
          return { tools: [] };
        },
      };
      const tools = createAdaptivePlaywrightTools(client, {
        mode: 'auto',
        policySet: policy(),
      });

      const pending = tools.callTool(testCase.request as CallArgs[0]);
      await started;
      testCase.mutate(testCase.request);
      releaseVisible();

      await expect(pending).resolves.toBe(visible);
      expect(calls).toHaveLength(1);
      await tools.dispose();
    }
  });

  it('checks the request commitment after reading a visible-result accessor', async () => {
    const request: Record<string, unknown> = { name: 'browser_snapshot', arguments: {} };
    const visible = Object.defineProperty(result(baseline()), 'isError', {
      configurable: true,
      enumerable: true,
      get() {
        (request.arguments as Record<string, unknown>).boxes = true;
        return false;
      },
    });
    const client = clientWith(visible);
    const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet: policy() });

    await expect(tools.callTool(request as CallArgs[0])).resolves.toBe(visible);
    expect(client.calls).toHaveLength(1);
    await tools.dispose();
  });

  it('rechecks the request immediately before hidden acquisition after caller-owned traps', async () => {
    for (const stage of ['visible-content', 'options-proxy'] as const) {
      const request: Record<string, unknown> = { name: 'browser_snapshot', arguments: {} };
      const visible = result(baseline());
      let options: CallArgs[1];
      if (stage === 'visible-content') {
        const content = visible.content;
        Object.defineProperty(visible, 'content', {
          configurable: true,
          enumerable: true,
          get() {
            (request.arguments as Record<string, unknown>).boxes = true;
            return content;
          },
        });
      } else {
        options = new Proxy({}, {
          getPrototypeOf: () => Object.prototype,
          ownKeys() {
            (request.arguments as Record<string, unknown>).boxes = true;
            return [];
          },
        });
      }
      const client = clientWith(visible);
      const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet: policy() });

      await expect(tools.callTool(request as CallArgs[0], options)).resolves.toBe(visible);
      expect(client.calls).toHaveLength(1);
      await tools.dispose();
    }
  });

  it('rechecks the options commitment immediately before hidden acquisition', async () => {
    const options = { timeout: 60_000 };
    const visible = result(baseline());
    const content = visible.content;
    Object.defineProperty(visible, 'content', {
      configurable: true,
      enumerable: true,
      get() {
        options.timeout = 120_000;
        return content;
      },
    });
    const client = clientWith(visible);
    const tools = createAdaptivePlaywrightTools(client, {
      mode: 'auto',
      policySet: policy(),
    });

    await expect(tools.callTool(
      { name: 'browser_snapshot', arguments: {} },
      options,
    )).resolves.toBe(visible);

    expect(client.calls).toHaveLength(1);
    await tools.dispose();
  });

  it('admits only exact empty/default browser_snapshot request arguments', async () => {
    const requests: unknown[] = [
      { name: 'browser_snapshot', arguments: { target: 'main' } },
      { name: 'browser_snapshot', arguments: { depth: 2 } },
      { name: 'browser_snapshot', arguments: { filename: 'snapshot.md' } },
      { name: 'browser_snapshot', arguments: { boxes: false } },
      { name: 'browser_snapshot', arguments: { boxes: true } },
      { name: 'browser_snapshot', arguments: null },
      { name: 'browser_snapshot', arguments: Object.create({ depth: 1 }) },
      { name: 'browser_snapshot', arguments: { [Symbol('hidden')]: true } },
      { name: 'browser_snapshot', arguments: Object.defineProperty({}, 'target', {
        get: () => 'main',
        enumerable: true,
      }) },
      { name: 'browser_snapshot', arguments: {}, _meta: { trace: true } },
      Object.assign(Object.create({ inherited: true }), { name: 'browser_snapshot', arguments: {} }),
    ];
    for (const request of requests) {
      const visible = result(baseline());
      const client = clientWith(visible);
      const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet: policy() });
      await expect(tools.callTool(request as CallArgs[0])).resolves.toBe(visible);
      expect(client.calls, JSON.stringify(request)).toHaveLength(1);
      await tools.dispose();
    }

    for (const request of [
      { name: 'browser_snapshot' },
      { name: 'browser_snapshot', arguments: {} },
      { name: 'browser_snapshot', arguments: Object.create(null) },
    ] as CallArgs[0][]) {
      const visible = result(baseline());
      const client = clientWith(visible);
      const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet: policy() });
      await expect(tools.callTool(request)).resolves.not.toBe(visible);
      expect(client.calls).toHaveLength(2);
      await tools.dispose();
    }
  });

  it('accepts only own safe signal/deadline options and carries monotonic remaining budgets', async () => {
    const visible = result(baseline());
    const client = clientWith(visible);
    const controller = new AbortController();
    const clock = vi.spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(125);
    const options = {
      signal: controller.signal,
      timeout: 100,
      maxTotalTimeout: 200,
    };
    const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet: policy() });

    await tools.callTool({ name: 'browser_snapshot', arguments: {} }, options);

    clock.mockRestore();
    expect(client.calls[0]?.[1]).toBe(options);
    const hiddenOptions = client.calls[1]?.[1];
    expect(Object.getPrototypeOf(hiddenOptions!)).toBeNull();
    expect(Reflect.ownKeys(hiddenOptions!)).toEqual(['signal', 'timeout', 'maxTotalTimeout']);
    expect(hiddenOptions?.signal).toBe(controller.signal);
    expect(hiddenOptions?.timeout).toBe(75);
    expect(hiddenOptions?.maxTotalTimeout).toBe(175);
    await tools.dispose();
  });

  it('skips hidden acquisition when either whole-call deadline is exhausted', async () => {
    for (const options of [{ timeout: 10 }, { maxTotalTimeout: 10 }]) {
      const visible = result(baseline());
      const client = clientWith(visible);
      const clock = vi.spyOn(performance, 'now')
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(111);
      const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet: policy() });
      await expect(tools.callTool({ name: 'browser_snapshot', arguments: {} }, options)).resolves.toBe(visible);
      clock.mockRestore();
      expect(client.calls).toHaveLength(1);
      await tools.dispose();
    }
  });

  it('rejects inherited, accessor, callback, resumption, stream, schema, and unknown option fields', async () => {
    const controller = new AbortController();
    const inherited = Object.create({ signal: controller.signal }) as Record<string, unknown>;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'signal', { get: () => controller.signal, enumerable: true });
    const unsafe: unknown[] = [
      inherited,
      accessor,
      { onprogress: () => {} },
      { onresumptiontoken: () => {} },
      { onRequestStreamEnd: () => {} },
      { resumptionToken: 'resume-me' },
      { toolDefinition: { name: 'browser_snapshot', inputSchema: { type: 'object' } } },
      { allowInputRequired: true },
      { headers: { authorization: 'do-not-copy' } },
      { resetTimeoutOnProgress: true },
      { relatedRequestId: 7 },
      { requestSignal: controller.signal },
    ];
    for (const options of unsafe) {
      const visible = result(baseline());
      const client = clientWith(visible);
      const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet: policy() });
      await expect(tools.callTool(
        { name: 'browser_snapshot', arguments: {} },
        options as CallArgs[1],
      )).resolves.toBe(visible);
      expect(client.calls).toHaveLength(1);
      await tools.dispose();
    }
  });

  it('requires a real tokenizer-parsed box before policy projection', async () => {
    const visible = result(baseline());
    const hiddenWithoutBoxes = result(baseline('- application "App"\n  - button "same" [ref=e9]'));
    const client = clientWith(visible, hiddenWithoutBoxes);
    const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet: policy() });

    await expect(tools.callTool({ name: 'browser_snapshot', arguments: {} })).resolves.toBe(visible);
    expect(client.calls).toHaveLength(2);
    await tools.dispose();
  });
});

describe('supplement authority and tokenizer provenance', () => {
  it('rejects unregistered attributes, geometry aliases, wrong provenance, controls, and obfuscated box tokens', async () => {
    const badFacts: readonly (readonly StructuralFact[])[] = [
      [{ kind: 'coordinate', ref: 'e9', attributes: { secret: 'value' } }],
      [{ kind: 'coordinate', ref: 'e9', attributes: { left: '10' } }],
      [{ kind: 'coordinate', ref: 'e9', attributes: { detail: '[ B O X = 10,20,30,40]' } }],
      [{ kind: 'coordinate', ref: 'e9', attributes: { detail: 'BBOX = 10,20,30,40' } }],
      [{ kind: 'coordinate', ref: 'e9', attributes: { detail: 'X : 10' } }],
      [{ kind: 'coordinate', ref: 'e9', attributes: { detail: '10,20,30,40' } }],
      [{ kind: 'coordinate', ref: 'e9', attributes: { detail: 'x 10 y 20 w 30 h 40' } }],
      [{ kind: 'coordinate', ref: 'e9', attributes: { detail: 'geometry 10 20 30 40' } }],
      [{ kind: 'coordinate', ref: 'e9', attributes: { detail: 'coords 10 / 20 / 30 / 40' } }],
      [{ kind: 'coordinate', ref: 'e9', attributes: { detail: 'box (10 20 30 40)' } }],
      [{ kind: 'coordinate', ref: 'e9', attributes: { detail: '10 20 30 40' } }],
      [{ kind: 'coordinate', ref: 'e9', attributes: { detail: 'safe\u202Eunsafe' } }],
      [{ kind: 'coordinate', ref: 'e9', attributes: { detail: 'safe\u0007unsafe' } }],
    ];
    const policyCases = [
      ...badFacts.map((facts) => policy(facts)),
      policy(undefined, {
        provenance: { policyId: 'other-policy', policyVersion: 'test-policy/1' },
      }),
    ];
    for (const policySet of policyCases) {
      const visible = result(baseline());
      const client = clientWith(visible);
      const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet });
      await expect(tools.callTool({ name: 'browser_snapshot', arguments: {} })).resolves.toBe(visible);
      await tools.dispose();
    }
  });

  it('rejects geometry aliases when a first-party attribute contract is registered', () => {
    expect(() => createTestPolicySet({
      policyId: 'test-policy',
      policyVersion: 'test-policy/1',
      supplementContracts: [{
        schema: 'test-projection/1',
        facts: [{ kind: 'coordinate', attributes: ['boundingbox'] }],
      }],
      evaluate: () => ({ kind: 'passthrough' }),
      project: () => ({ kind: 'unresolved' }),
    })).toThrow(/attribute key is forbidden/u);
  });

  it('rejects sparse and exotic facts arrays rather than skipping their entries', async () => {
    const sparse = new Array<StructuralFact>(1);
    const exotic = [{ kind: 'coordinate', ref: 'e9', attributes: { lane: 'A' } }];
    Object.defineProperty(exotic, 'extension', { value: 'hidden' });
    for (const facts of [sparse, exotic]) {
      const visible = result(baseline());
      const client = clientWith(visible);
      const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet: policy(facts) });
      await expect(tools.callTool({ name: 'browser_snapshot', arguments: {} })).resolves.toBe(visible);
      await tools.dispose();
    }
  });

  it('proves fact refs from actionable metadata, never quoted, slash-delimited, or post-colon literals', async () => {
    const cases = [
      '- application "App"\n  - button "literal [ref=e9]" [ref=e10] [box=10,20,30,40]',
      '- application "App"\n  - button /literal [ref=e9]/ [ref=e10] [box=10,20,30,40]',
      '- application "App"\n  - textbox "same" [ref=e10] [box=10,20,30,40]: literal [ref=e9]',
    ];
    const baselines = [
      '- application "App"\n  - button "literal [ref=e9]" [ref=e1]',
      '- application "App"\n  - button /literal [ref=e9]/ [ref=e1]',
      '- application "App"\n  - textbox "same" [ref=e1]: literal [ref=e9]',
    ];
    for (let index = 0; index < cases.length; index += 1) {
      const visible = result(baseline(baselines[index]));
      const hidden = result(boxed(cases[index]));
      const client = clientWith(visible, hidden);
      const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet: policy() });
      await expect(tools.callTool({ name: 'browser_snapshot', arguments: {} })).resolves.toBe(visible);
      await tools.dispose();
    }
  });
});

describe('synchronous policy and client lease boundaries', () => {
  it('rejects evaluate/project thenables at runtime without awaiting them', async () => {
    for (const stage of ['evaluate', 'project'] as const) {
      const visible = result(baseline());
      const client = clientWith(visible);
      const asyncPolicy = createTestPolicySet({
        policyId: 'test-policy',
        policyVersion: 'test-policy/1',
        supplementContracts: [{
          schema: 'test-projection/1',
          facts: [{ kind: 'coordinate', attributes: ['lane'] }],
        }],
        evaluate: stage === 'evaluate'
          ? (() => Promise.resolve({ kind: 'capture-boxes' })) as never
          : () => ({ kind: 'capture-boxes' }),
        project: stage === 'project'
          ? (() => Promise.resolve({ kind: 'unresolved' })) as never
          : () => ({ kind: 'unresolved' }),
      });
      const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet: asyncPolicy });
      await expect(tools.callTool({ name: 'browser_snapshot', arguments: {} })).resolves.toBe(visible);
      expect(client.calls).toHaveLength(stage === 'evaluate' ? 1 : 2);
      await tools.dispose();
    }
  });

  it('never assimilates a rejected thenable after the policy guard is released', async () => {
    const visible = result(baseline());
    const client = clientWith(visible);
    let tools!: AdaptivePlaywrightTools;
    let thenInvocations = 0;
    let injected: Promise<CallToolResult> | undefined;
    const policySet = createTestPolicySet({
      policyId: 'test-policy',
      policyVersion: 'test-policy/1',
      supplementContracts: [],
      evaluate: (() => ({
        then() {
          thenInvocations += 1;
          injected = tools.callTool({ name: 'browser_click', arguments: {} });
        },
      })) as never,
      project: () => ({ kind: 'unresolved' }),
    });
    tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet });

    await expect(tools.callTool({ name: 'browser_snapshot', arguments: {} })).resolves.toBe(visible);
    await Promise.resolve();
    await Promise.resolve();
    expect(thenInvocations).toBe(0);
    expect(injected).toBeUndefined();
    expect(client.calls).toHaveLength(1);
    await tools.dispose();
  });

  it('silences a genuine rejected Promise without invoking arbitrary thenables', async () => {
    const visible = result(baseline());
    const client = clientWith(visible);
    const policySet = createTestPolicySet({
      policyId: 'test-policy',
      policyVersion: 'test-policy/1',
      supplementContracts: [],
      evaluate: (() => Promise.reject(new Error('async policy is forbidden'))) as never,
      project: () => ({ kind: 'unresolved' }),
    });
    const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet });

    await expect(tools.callTool({ name: 'browser_snapshot', arguments: {} })).resolves.toBe(visible);
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(client.calls).toHaveLength(1);
    await tools.dispose();
  });

  it('rejects policy re-entry instead of queueing a recursive raw-client call', async () => {
    const visible = result(baseline());
    const client = clientWith(visible);
    let tools!: AdaptivePlaywrightTools;
    let reentrant: Promise<CallToolResult> | undefined;
    let attempted = false;
    const policySet = createTestPolicySet({
      policyId: 'test-policy',
      policyVersion: 'test-policy/1',
      supplementContracts: [],
      evaluate: () => {
        if (!attempted) {
          attempted = true;
          reentrant = tools.callTool({ name: 'browser_snapshot', arguments: {} });
        }
        return { kind: 'passthrough' };
      },
      project: () => ({ kind: 'unresolved' }),
    });
    tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet });

    await expect(tools.callTool({ name: 'browser_snapshot', arguments: {} })).resolves.toBe(visible);
    await expect(reentrant).rejects.toThrow(/re-entr/u);
    expect(client.calls).toHaveLength(1);
    await tools.dispose();
  });

  it('rejects policy-owned Proxy structures without invoking their traps', async () => {
    const visible = result(baseline());
    const client = clientWith(visible);
    let traps = 0;
    const decision = new Proxy({ kind: 'passthrough' as const }, {
      getPrototypeOf(target) {
        traps += 1;
        return Reflect.getPrototypeOf(target);
      },
    });
    const policySet = createTestPolicySet({
      policyId: 'test-policy',
      policyVersion: 'test-policy/1',
      supplementContracts: [],
      evaluate: () => decision,
      project: () => ({ kind: 'unresolved' }),
    });
    const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet });

    await expect(tools.callTool({ name: 'browser_snapshot', arguments: {} })).resolves.toBe(visible);
    expect(traps).toBe(0);
    expect(client.calls).toHaveLength(1);
    await tools.dispose();
  });

  it('holds a raw-client lease until draining dispose completes', async () => {
    const visible = result(baseline());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: CallArgs[] = [];
    const client: RecordedClient = {
      calls,
      async callTool(...args: CallArgs): Promise<CallToolResult> {
        calls.push(args);
        await gate;
        return visible;
      },
      async listTools(): Promise<ListToolsResult> {
        return { tools: [] };
      },
    };
    const first = createAdaptivePlaywrightTools(client, { mode: 'off', policySet: policy() });
    const pending = first.callTool({ name: 'browser_snapshot', arguments: {} });
    const disposing = first.dispose();
    expect(() => createAdaptivePlaywrightTools(client, {
      mode: 'off',
      policySet: policy(),
    })).toThrow(/already has an active adaptive wrapper/u);
    release();
    await pending;
    await disposing;
    const second = createAdaptivePlaywrightTools(client, { mode: 'off', policySet: policy() });
    await second.dispose();
  });
});

describe('linear parser regression', () => {
  it('keeps adversarial quote/slash/colon metadata scanning linear and bounded in wall time', () => {
    const repeated = '  - button /literal [ref=e99]/ "quoted [box=1,2,3,4]" [ref=e1]: tail [ref=e88]\n';
    const source = baseline(`- application "App"\n${repeated.repeat(8_000).trimEnd()}`);
    const counter: SnapshotScanCounter = { operations: 0 };
    const started = performance.now();
    const document = parseInlineSnapshot(source, counter);
    expect(document).toBeDefined();
    parseSnapshotNodes(document!.snapshotTree, counter);
    const durationMs = performance.now() - started;

    expect(counter.operations).toBeGreaterThanOrEqual(source.length);
    expect(counter.operations).toBeLessThan(source.length * 10);
    expect(durationMs).toBeLessThan(1_500);
  });
});
