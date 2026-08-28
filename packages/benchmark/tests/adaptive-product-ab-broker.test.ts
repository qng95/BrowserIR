import type {
  CallToolResult,
  ListToolsResult,
} from '@modelcontextprotocol/client';
import {
  type AdaptivePlaywrightRawClient,
  type AdaptivePlaywrightTelemetryEvent,
} from 'browserir';
import { describe, expect, it, vi } from 'vitest';

import {
  createAdaptiveProductAbBroker,
  type AdaptiveProductAbFamily,
} from '../src/agent-benchmark/adaptive-product-ab-broker.js';

type CallArgs = Parameters<AdaptivePlaywrightRawClient['callTool']>;
type ListArgs = Parameters<AdaptivePlaywrightRawClient['listTools']>;

interface FakeRawClient extends AdaptivePlaywrightRawClient {
  readonly calls: CallArgs[];
  readonly lists: ListArgs[];
  readonly close: ReturnType<typeof vi.fn>;
}

const fakeRawClient = (options: {
  readonly callResults?: readonly CallToolResult[];
  readonly listResult?: ListToolsResult;
} = {}): FakeRawClient => {
  const callResults = [...(options.callResults ?? [])];
  const calls: CallArgs[] = [];
  const lists: ListArgs[] = [];
  const listResult = options.listResult ?? { tools: [] };
  return {
    calls,
    lists,
    close: vi.fn(),
    async callTool(...args: CallArgs): Promise<CallToolResult> {
      calls.push(args);
      const result = callResults.shift();
      if (result === undefined) throw new Error('Unexpected fake raw call.');
      return result;
    },
    async listTools(...args: ListArgs): Promise<ListToolsResult> {
      lists.push(args);
      return listResult;
    },
  };
};

const snapshotText = (tree: string): string => [
  '### Page state',
  '- Page URL: https://fixture.test/product-ab',
  '',
  '### Snapshot',
  '```yaml',
  tree.trim(),
  '```',
  '',
  '### Console',
  '- no messages',
].join('\n');

const snapshotResult = (tree: string): CallToolResult => ({
  content: [{ type: 'text', text: snapshotText(tree) }],
});

const SCHEDULE_BOXED = `
- main "Workshop weekly schedule" [box=8,8,400,260]:
  - table "Workshop weekly schedule" [box=8,8,400,240]:
    - rowgroup [box=10,10,396,236]:
      - row [box=10,10,396,77]:
        - columnheader "Monday 09:30" [box=143,10,131,77]
        - columnheader "Tuesday 09:30" [box=275,10,131,77]
      - row [box=10,89,396,77]:
        - rowheader "Bay 2" [box=10,89,131,77]
      - row [box=10,169,396,77]:
        - rowheader "Bay 4" [box=10,169,131,77]
  - generic [box=8,8,400,260]:
    - button "Choose open slot" [ref=e21] [box=138,88,90,50]
    - button "Choose open slot" [ref=e22] [box=278,88,90,50]
    - button "Choose open slot" [ref=e23] [box=138,178,90,50]
    - button "Choose open slot" [ref=e24] [box=278,178,90,50]
`;

const SCHEDULE_VISIBLE = SCHEDULE_BOXED.replace(/ \[box=[^\]]+\]/gu, '');

describe('adaptive product A/B broker seam', () => {
  it.each([
    ['schedule-coordinate', 'schedule-coordinate-policy/3'],
    ['cross-tree-label', 'cross-tree-label-policy/1'],
  ] as const)('binds the explicit first-party %s handle at %s', async (family, version) => {
    const raw = fakeRawClient();
    const broker = createAdaptiveProductAbBroker(raw, { mode: 'off', family });

    expect(broker.binding).toEqual({
      schemaVersion: 'adaptive-product-ab-broker/1',
      productToolsVersion: 'adaptive-playwright-tools/1',
      productPoliciesVersion: 'adaptive-reference-policies/1',
      mode: 'off',
      family,
      policyVersion: version,
    });
    expect(Object.isFrozen(broker)).toBe(true);
    expect(Object.isFrozen(broker.binding)).toBe(true);
    expect('rawClient' in broker).toBe(false);

    await broker.dispose();
  });

  it.each(['off', 'auto'] as const)(
    'preserves exact catalog/request/options/result identity in the %s arm',
    async (mode) => {
      const catalog = Object.assign(
        { tools: [], nextCursor: 'next' },
        { vendorCatalog: { retained: true } },
      ) as ListToolsResult;
      const result = Object.assign(
        { content: [{ type: 'text' as const, text: 'clicked' }], isError: false },
        { vendorResult: { retained: true } },
      ) as CallToolResult;
      const events: AdaptivePlaywrightTelemetryEvent[] = [];
      const raw = fakeRawClient({ callResults: [result], listResult: catalog });
      const broker = createAdaptiveProductAbBroker(raw, {
        mode,
        family: 'schedule-coordinate',
        telemetry: { onEvent: (event) => events.push(event) },
      });
      const listRequest = { cursor: 'cursor' };
      const listOptions = { timeout: 31 };
      const request = { name: 'browser_click', arguments: { ref: 'e7' } };
      const callOptions = { timeout: 29 };

      await expect(broker.listTools(listRequest, listOptions)).resolves.toBe(catalog);
      await expect(broker.callTool(request, callOptions)).resolves.toBe(result);
      expect(raw.lists[0]?.[0]).toBe(listRequest);
      expect(raw.lists[0]?.[1]).toBe(listOptions);
      expect(raw.calls[0]?.[0]).toBe(request);
      expect(raw.calls[0]?.[1]).toBe(callOptions);
      expect(events).toEqual([{
        schemaVersion: 'adaptive-playwright-telemetry/1',
        mode,
        operation: 'other',
        outcome: mode === 'off' ? 'disabled' : 'not-applicable',
        hiddenCalls: 0,
      }]);
      expect(Object.isFrozen(events[0])).toBe(true);

      await broker.dispose();
      expect(raw.close).not.toHaveBeenCalled();
    },
  );

  it('keeps the arms on one product path while auto alone performs hidden projection', async () => {
    const visibleOff = snapshotResult(SCHEDULE_VISIBLE);
    const visibleAuto = snapshotResult(SCHEDULE_VISIBLE);
    const boxedAuto = snapshotResult(SCHEDULE_BOXED);
    const offEvents: AdaptivePlaywrightTelemetryEvent[] = [];
    const autoEvents: AdaptivePlaywrightTelemetryEvent[] = [];
    const offRaw = fakeRawClient({ callResults: [visibleOff] });
    const autoRaw = fakeRawClient({ callResults: [visibleAuto, boxedAuto] });
    const family: AdaptiveProductAbFamily = 'schedule-coordinate';
    const off = createAdaptiveProductAbBroker(offRaw, {
      mode: 'off', family, telemetry: { onEvent: (event) => offEvents.push(event) },
    });
    const auto = createAdaptiveProductAbBroker(autoRaw, {
      mode: 'auto', family, telemetry: { onEvent: (event) => autoEvents.push(event) },
    });
    const offRequest = { name: 'browser_snapshot', arguments: {} };
    const autoRequest = { name: 'browser_snapshot', arguments: {} };

    const offResult = await off.callTool(offRequest);
    const autoResult = await auto.callTool(autoRequest);

    expect(offResult).toBe(visibleOff);
    expect(offRaw.calls).toHaveLength(1);
    expect(offRaw.calls[0]?.[0]).toBe(offRequest);
    expect(autoRaw.calls).toHaveLength(2);
    expect(autoRaw.calls[0]?.[0]).toBe(autoRequest);
    expect(autoRaw.calls[1]?.[0]).toEqual({
      name: 'browser_snapshot', arguments: { boxes: true },
    });
    expect(autoResult).not.toBe(visibleAuto);
    expect(JSON.stringify(autoResult)).toContain('schedule-slot');
    expect(JSON.stringify(autoResult)).not.toMatch(/\[box=/u);
    expect(offEvents).toEqual([expect.objectContaining({
      mode: 'off', outcome: 'disabled', hiddenCalls: 0,
    })]);
    expect(autoEvents).toEqual([expect.objectContaining({
      mode: 'auto', outcome: 'projected', hiddenCalls: 1,
    })]);
    const { mode: offMode, ...offBinding } = off.binding;
    const { mode: autoMode, ...autoBinding } = auto.binding;
    expect([offMode, autoMode]).toEqual(['off', 'auto']);
    expect(autoBinding).toEqual(offBinding);

    await Promise.all([off.dispose(), auto.dispose()]);
  });

  it('holds one exclusive raw lease and releases it with idempotent cleanup', async () => {
    const raw = fakeRawClient();
    const first = createAdaptiveProductAbBroker(raw, {
      mode: 'off', family: 'cross-tree-label',
    });

    expect(() => createAdaptiveProductAbBroker(raw, {
      mode: 'auto', family: 'cross-tree-label',
    })).toThrow(/already has an active adaptive wrapper/u);
    const firstDispose = first.dispose();
    expect(first.dispose()).toBe(firstDispose);
    await firstDispose;
    expect(raw.close).not.toHaveBeenCalled();

    const second = createAdaptiveProductAbBroker(raw, {
      mode: 'auto', family: 'cross-tree-label',
    });
    await second.dispose();
    await expect(second.listTools()).rejects.toThrow(/disposed/u);
    expect(raw.close).not.toHaveBeenCalled();
  });

  it('rejects changing or throwing accessors before acquisition without invoking them', async () => {
    const raw = fakeRawClient();
    let reads = 0;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(hostile, {
      mode: {
        enumerable: true,
        get() {
          reads += 1;
          if (reads === 1) return 'off';
          throw new Error('second mode read');
        },
      },
      family: {
        enumerable: true,
        value: 'schedule-coordinate',
      },
    });

    expect(() => createAdaptiveProductAbBroker(raw, hostile as never))
      .toThrow(/own data fields/u);
    expect(reads).toBe(0);

    const admitted = createAdaptiveProductAbBroker(raw, {
      mode: 'auto', family: 'schedule-coordinate',
    });
    await admitted.dispose();
  });

  it('rejects option and telemetry Proxies without invoking traps or leaking the lease', async () => {
    const raw = fakeRawClient();
    let optionTraps = 0;
    const hostileOptions = new Proxy({
      mode: 'off',
      family: 'cross-tree-label',
    }, {
      getPrototypeOf() {
        optionTraps += 1;
        return Object.prototype;
      },
      ownKeys() {
        optionTraps += 1;
        return ['mode', 'family'];
      },
      getOwnPropertyDescriptor() {
        optionTraps += 1;
        return undefined;
      },
      get() {
        optionTraps += 1;
        return undefined;
      },
    });
    expect(() => createAdaptiveProductAbBroker(raw, hostileOptions as never))
      .toThrow(/exact plain own-data object/u);
    expect(optionTraps).toBe(0);

    let telemetryTraps = 0;
    const hostileTelemetry = new Proxy({ onEvent() {} }, {
      getPrototypeOf() {
        telemetryTraps += 1;
        return Object.prototype;
      },
      ownKeys() {
        telemetryTraps += 1;
        return ['onEvent'];
      },
      getOwnPropertyDescriptor() {
        telemetryTraps += 1;
        return undefined;
      },
      get() {
        telemetryTraps += 1;
        return undefined;
      },
    });
    expect(() => createAdaptiveProductAbBroker(raw, {
      mode: 'auto', family: 'cross-tree-label', telemetry: hostileTelemetry,
    })).toThrow(/exact plain own-data object/u);
    expect(telemetryTraps).toBe(0);

    const admitted = createAdaptiveProductAbBroker(raw, {
      mode: 'off', family: 'cross-tree-label',
    });
    await admitted.dispose();
  });

  it.each([
    Object.assign({ mode: 'off', family: 'schedule-coordinate' }, { extra: true }),
    Object.assign(
      { mode: 'off', family: 'schedule-coordinate' },
      { [Symbol('extra')]: true },
    ),
  ])('rejects extra string or symbol fields before acquiring the raw lease', async (hostile) => {
    const raw = fakeRawClient();
    expect(() => createAdaptiveProductAbBroker(raw, hostile as never))
      .toThrow(/outside its exact schema/u);

    const admitted = createAdaptiveProductAbBroker(raw, {
      mode: 'off', family: 'schedule-coordinate',
    });
    await admitted.dispose();
  });

  it('rejects telemetry accessors without invoking them or leaking the lease', async () => {
    const raw = fakeRawClient();
    let reads = 0;
    const telemetry = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(telemetry, 'onEvent', {
      enumerable: true,
      get() {
        reads += 1;
        return () => {};
      },
    });

    expect(() => createAdaptiveProductAbBroker(raw, {
      mode: 'auto', family: 'schedule-coordinate', telemetry: telemetry as never,
    })).toThrow(/own data fields/u);
    expect(reads).toBe(0);

    const admitted = createAdaptiveProductAbBroker(raw, {
      mode: 'auto', family: 'schedule-coordinate',
    });
    await admitted.dispose();
  });
});
