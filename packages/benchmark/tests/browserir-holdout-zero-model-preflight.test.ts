import type {
  CallToolResult,
  ListToolsResult,
} from '@modelcontextprotocol/client';
import type { AdaptivePlaywrightRawClient } from 'browserir-mcp';
import {
  adaptiveAccuracyHoldoutCases,
  type AdaptiveAccuracyHoldoutCaseId,
  type AdaptiveAccuracyHoldoutWorldId,
} from '@think-dom/fixture-app';
import { describe, expect, it } from 'vitest';

import {
  buildBrowserIrHoldoutZeroModelPreflightSchedule,
  runBrowserIrHoldoutZeroModelPreflight,
  type BrowserIrHoldoutZeroModelPreflightDependencies,
  type BrowserIrHoldoutZeroOracleSnapshot,
} from '../src/agent-benchmark/browserir-holdout-zero-model-preflight.js';

type CallArgs = Parameters<AdaptivePlaywrightRawClient['callTool']>;
type ListArgs = Parameters<AdaptivePlaywrightRawClient['listTools']>;

const success = (text: string, extra: Record<string, unknown> = {}): CallToolResult =>
  Object.assign({ content: [{ type: 'text' as const, text }] }, extra);

const snapshot = (url: string, tree: string, extra: Record<string, unknown> = {}): CallToolResult =>
  success([
    '### Page',
    `- Page URL: ${url}`,
    '',
    '### Snapshot',
    '```yaml',
    tree.trim(),
    '```',
    '',
    '### Console',
    '- no messages',
  ].join('\n'), extra);

const loginSnapshot = (origin: string): CallToolResult => snapshot(`${origin}/app/login`, `
- main:
  - form "Sign in":
    - textbox "Username" [ref=e1]
    - textbox "Password" [ref=e2]
    - button "Sign in" [ref=e3]
`);

interface ScheduleDefinition {
  readonly resources: readonly string[];
  readonly slots: readonly string[];
  readonly p1: readonly number[];
}

const schedules: Record<Extract<AdaptiveAccuracyHoldoutCaseId, `schedule/${string}`>, ScheduleDefinition> = {
  'schedule/clinic-imaging-board': {
    resources: ['MRI Suite', 'CT Suite', 'Ultrasound Suite'],
    slots: ['Thursday 08:20', 'Thursday 10:40'],
    p1: [5, 2, 0, 4, 1, 3],
  },
  'schedule/harbor-maintenance-rail': {
    resources: ['East service rail', 'West service rail'],
    slots: ['06:40', '11:30', '16:20'],
    p1: [2, 4, 1, 5, 0, 3],
  },
  'schedule/workshop-week-table': {
    resources: ['Bay 2', 'Bay 4'],
    slots: ['Monday 09:30', 'Tuesday 09:30'],
    p1: [3, 2, 1, 0],
  },
  'schedule/dispatch-shift-board': {
    resources: ['North crew', 'South crew'],
    slots: ['06:00', '14:00'],
    p1: [3, 2, 1, 0],
  },
};

const scheduleTree = (
  caseId: Extract<AdaptiveAccuracyHoldoutCaseId, `schedule/${string}`>,
  worldId: AdaptiveAccuracyHoldoutWorldId,
  boxed: boolean,
): string => {
  const definition = schedules[caseId];
  const study = adaptiveAccuracyHoldoutCases[caseId];
  const semantic = worldId.startsWith('semantic-');
  const p1 = worldId.endsWith('-p1');
  const columnXs = definition.slots.map((_slot, index) => 200 + index * 220);
  const rowYs = definition.resources.map((_resource, index) => 80 + index * 100);
  const box = (value: string): string => boxed ? ` [box=${value}]` : '';
  const rows = definition.resources.map((resource, row) => [
    `      - row${box(`0,${rowYs[row]!},${180 + 220 * definition.slots.length},80`)}`,
    `        - rowheader ${JSON.stringify(resource)}${box(`0,${rowYs[row]!},170,60`)}`,
  ].join('\n')).join('\n');
  const columns = definition.slots.map((slot, column) =>
    `        - columnheader ${JSON.stringify(slot)}${box(`${columnXs[column]!},0,180,50`)}`
  ).join('\n');
  const actions = study.targetIds.map((_targetId, targetIndex) => {
    const coordinateIndex = p1 ? definition.p1[targetIndex]! : targetIndex;
    const row = Math.floor(coordinateIndex / definition.slots.length);
    const column = coordinateIndex % definition.slots.length;
    const name = semantic
      ? `${definition.resources[row]!} ${definition.slots[column]!} ${study.actionName}`
      : study.actionName;
    return `    - button ${JSON.stringify(name)} [ref=e${20 + targetIndex}]${
      box(`${columnXs[column]! + 25},${rowYs[row]! + 10},110,40`)}`;
  }).join('\n');
  return `
- main "Holdout":
  - table "Bound schedule"${box(`0,0,${180 + 220 * definition.slots.length},${80 + 100 * definition.resources.length}`)}:
    - rowgroup:
      - row${box(`0,0,${180 + 220 * definition.slots.length},60`)}:
${columns}
${rows}
  - group "Available actions"${box(`0,0,${180 + 220 * definition.slots.length},${80 + 100 * definition.resources.length}`)}:
${actions}
`;
};

interface CrossTreeDefinition {
  readonly labels: readonly string[];
  readonly p1: readonly number[];
}

const crossTrees: Record<Extract<AdaptiveAccuracyHoldoutCaseId, `cross-tree/${string}`>, CrossTreeDefinition> = {
  'cross-tree/catalog-localization-queues': {
    labels: ['Japanese catalog queue', 'German catalog queue'],
    p1: [1, 0],
  },
  'cross-tree/storage-intake-lanes': {
    labels: ['Oversize intake', 'Cold-chain intake'],
    p1: [1, 0],
  },
  'cross-tree/case-routing-columns': {
    labels: ['Urgent queue', 'Routine queue'],
    p1: [1, 0],
  },
  'cross-tree/approval-lanes': {
    labels: ['Security review', 'Finance review'],
    p1: [1, 0],
  },
};

const crossTree = (
  caseId: Extract<AdaptiveAccuracyHoldoutCaseId, `cross-tree/${string}`>,
  worldId: AdaptiveAccuracyHoldoutWorldId,
  boxed: boolean,
): string => {
  const definition = crossTrees[caseId];
  const study = adaptiveAccuracyHoldoutCases[caseId];
  const semantic = worldId.startsWith('semantic-');
  const p1 = worldId.endsWith('-p1');
  const ys = [90, 240];
  const box = (value: string): string => boxed ? ` [box=${value}]` : '';
  const labels = definition.labels.map((label, lane) =>
    `      - heading ${JSON.stringify(label)}${box(`80,${ys[lane]!},300,70`)}`
  ).join('\n');
  const actions = study.targetIds.map((_targetId, targetIndex) => {
    const lane = p1 ? definition.p1[targetIndex]! : targetIndex;
    const name = semantic ? `${definition.labels[lane]!} ${study.actionName}` : study.actionName;
    return `      - button ${JSON.stringify(name)} [ref=e${40 + targetIndex}]${
      box(`500,${ys[lane]!},220,70`)}`;
  }).join('\n');
  return `
- main "Holdout":
  - region "Bound lanes"${box('40,40,760,360')}:
    - group "Labels"${box('60,60,340,300')}:
${labels}
    - group "Controls"${box('470,60,290,300')}:
${actions}
`;
};

const studySnapshot = (
  origin: string,
  caseId: AdaptiveAccuracyHoldoutCaseId,
  worldId: AdaptiveAccuracyHoldoutWorldId,
  boxed: boolean,
): CallToolResult => {
  const study = adaptiveAccuracyHoldoutCases[caseId];
  const tree = caseId.startsWith('schedule/')
    ? scheduleTree(caseId as Extract<AdaptiveAccuracyHoldoutCaseId, `schedule/${string}`>, worldId, boxed)
    : crossTree(caseId as Extract<AdaptiveAccuracyHoldoutCaseId, `cross-tree/${string}`>, worldId, boxed);
  return snapshot(`${origin}${study.path}`, tree, {
    vendorEnvelope: { exact: boxed ? 'boxed' : 'visible' },
  });
};

const catalog = (descriptionSuffix = ''): ListToolsResult => ({
  tools: [
    'browser_navigate',
    'browser_snapshot',
    'browser_type',
    'browser_click',
    'browser_network_requests',
  ].map((name) => ({
    name,
    description: `fake-${name}${descriptionSuffix}`,
    inputSchema: { type: 'object' },
  })),
});

const ZERO: BrowserIrHoldoutZeroOracleSnapshot = Object.freeze({
  exactSuccess: false,
  mutationCount: 0,
  collateralMutationCount: 0,
  totalHoldoutMutationCount: 0,
  otherAuditMutationCount: 0,
  totalAuditMutationCount: 0,
});

interface FakeOptions {
  readonly originDriftAt?: number | undefined;
  readonly duplicateIdentityAt?: number | undefined;
  readonly mutationAt?: number | undefined;
  readonly externalNetworkAt?: number | undefined;
  readonly missingNetworkPositiveControlAt?: number | undefined;
  readonly catalogDriftAt?: number | undefined;
  readonly boundaryMutationAt?: number | undefined;
  readonly unresolvedAt?: number | undefined;
  readonly recoverableUnresolvedAt?: number | undefined;
  readonly studyFailureAt?: number | undefined;
  readonly closeFailureAt?: number | undefined;
}

const mutateAfterFirstSerialization = (result: CallToolResult): CallToolResult => {
  const block = result.content.find((candidate) => candidate.type === 'text');
  if (block?.type !== 'text') throw new Error('Fake snapshot has no text block.');
  let retained = block.text;
  Object.defineProperty(block, 'text', {
    configurable: true,
    enumerable: true,
    get() {
      const returned = retained;
      retained = `${retained}\n- boundary mutation`;
      return returned;
    },
  });
  return result;
};

const fakeDependencies = (options: FakeOptions = {}) => {
  const closed: number[] = [];
  const rawCalls: Array<readonly CallArgs[]> = [];
  let nextOrdinal = 0;
  const dependencies: BrowserIrHoldoutZeroModelPreflightDependencies = {
    async openArm(input) {
      const ordinal = nextOrdinal++;
      const origin = ordinal === options.originDriftAt
        ? 'http://127.0.0.1:31001'
        : 'http://127.0.0.1:31000';
      const calls: CallArgs[] = [];
      rawCalls.push(calls);
      let oracleCalls = 0;
      let networkAuditCalls = 0;
      const rawClient: AdaptivePlaywrightRawClient = {
        async listTools(..._args: ListArgs): Promise<ListToolsResult> {
          return catalog(ordinal === options.catalogDriftAt ? '-drift' : '');
        },
        async callTool(...args: CallArgs): Promise<CallToolResult> {
          calls.push(args);
          const request = args[0];
          if (request.name === 'browser_navigate') return success('Navigation complete.');
          if (request.name === 'browser_type') return success('Text entered.');
          if (request.name === 'browser_click') return success('Signed in.');
          if (request.name === 'browser_network_requests') {
            networkAuditCalls += 1;
            if (ordinal === options.missingNetworkPositiveControlAt) {
              return success('No network requests.');
            }
            const positiveControl = networkAuditCalls === 1
              ? `${origin}/app/login`
              : `${origin}${adaptiveAccuracyHoldoutCases[input.caseId].path}`;
            return success([
              `1. [GET] ${positiveControl} => [200] OK`,
              ...(ordinal === options.externalNetworkAt
                ? ['2. [GET] https://external.invalid/pixel => [200] OK']
                : []),
            ].join('\n'));
          }
          if (request.name === 'browser_snapshot') {
            const boxes = (request.arguments as Record<string, unknown> | undefined)?.['boxes'];
            const snapshotCallCount = calls.filter(
              ([candidate]) => candidate.name === 'browser_snapshot',
            ).length;
            if (snapshotCallCount === 1) {
              return loginSnapshot(origin);
            }
            if (ordinal === options.studyFailureAt && snapshotCallCount === 2) {
              throw new Error('synthetic study failure');
            }
            const result = studySnapshot(origin, input.caseId, input.worldId, boxes === true);
            if (ordinal === options.unresolvedAt && boxes === true) {
              return studySnapshot(origin, input.caseId, input.worldId, false);
            }
            if (ordinal === options.recoverableUnresolvedAt && boxes === true) {
              const block = result.content.find((candidate) => candidate.type === 'text');
              if (block?.type !== 'text') throw new Error('Synthetic snapshot has no text.');
              block.text = block.text.replace(
                '[box=225,90,110,40]',
                '[box=170,90,270,40]',
              );
            }
            return ordinal === options.boundaryMutationAt && snapshotCallCount === 2
              ? mutateAfterFirstSerialization(result)
              : result;
          }
          throw new Error(`Unexpected fake raw tool: ${request.name}.`);
        },
      };
      const identityOrdinal = ordinal === options.duplicateIdentityAt ? 0 : ordinal;
      return {
        origin,
        rawClient,
        runtimeIdentity: {
          fixtureProcessPid: 40_000 + identityOrdinal,
          mcpProcessPid: 50_000 + ordinal,
          databaseInstanceAttestationId: `db-attestation-${ordinal}`,
          browserContextConstructionAttestationId: `context-attestation-${ordinal}`,
          initialPageConstructionAttestationId: `page-attestation-${ordinal}`,
        },
        async verifyZeroOracle() {
          oracleCalls += 1;
          return ordinal === options.mutationAt && oracleCalls === 2
            ? { ...ZERO, mutationCount: 1, totalHoldoutMutationCount: 1, totalAuditMutationCount: 1 }
            : ZERO;
        },
        async close() {
          closed.push(ordinal);
          if (ordinal === options.closeFailureAt) throw new Error('synthetic close failure');
        },
      };
    },
  };
  return { dependencies, closed, rawCalls };
};

describe('Browser IR holdout zero-model preflight', () => {
  it('freezes the exact eight-case/four-world/two-mode 64-arm schedule', () => {
    const schedule = buildBrowserIrHoldoutZeroModelPreflightSchedule();
    expect(schedule).toHaveLength(64);
    expect(new Set(schedule.map(({ caseId }) => caseId)).size).toBe(8);
    expect(new Set(schedule.map(({ worldId }) => worldId)).size).toBe(4);
    expect(schedule.filter(({ mode }) => mode === 'off')).toHaveLength(32);
    expect(schedule.filter(({ mode }) => mode === 'auto')).toHaveLength(32);
    expect(Object.isFrozen(schedule)).toBe(true);
  });

  it('qualifies all arms through the actual product broker with only observed loopback page requests', async () => {
    const fake = fakeDependencies();
    const result = await runBrowserIrHoldoutZeroModelPreflight(fake.dependencies);

    expect(result.summary).toEqual({
      arms: 64,
      pairs: 32,
      fixedLoopbackOrigin: 'http://127.0.0.1:31000',
      observedUniqueFixtureProcessPids: 64,
      observedUniqueMcpProcessPids: 64,
      freshInMemoryDatabaseConstructionAttestations: 64,
      isolatedBrowserContextConstructionAttestations: 64,
      initialPageConstructionAttestations: 64,
      disabled: 32,
      projected: 16,
      projectionUnresolved: 0,
      safeFallbacks: 0,
      demonstratedRecoverableRelations: 16,
      projectionMisses: 0,
      unresolvedWithoutRecoverabilityProof: 0,
      projectionRecallOnDemonstratedRecoverable: 1,
      passthrough: 16,
      hiddenCalls: 16,
      databaseMutations: 0,
      holdoutActionClicks: 0,
      modelCalls: 0,
      providerCalls: 0,
      observedPageRequests: 128,
      observedExternalPageRequests: 0,
      paidCalls: 0,
      score: null,
      claimAuthority: false,
    });
    expect(fake.closed).toEqual([...Array(64).keys()]);
    expect(new Set(result.captures.map(({ origin }) => origin)))
      .toEqual(new Set(['http://127.0.0.1:31000']));
    expect(result.captures.filter(({ outcome }) => outcome === 'projected'))
      .toHaveLength(16);
    expect(result.captures.filter(({ outcome }) => outcome === 'passthrough'))
      .toHaveLength(16);
    expect(result.captures.every(({ rawBoxesExposed }) => !rawBoxesExposed)).toBe(true);
    expect(result.captures.filter(({ outcome }) => outcome !== 'projected')
      .every(({ returnedRawIdentity, returnedRawBytesUnchanged }) =>
        returnedRawIdentity && returnedRawBytesUnchanged)).toBe(true);
    expect(result.captures.filter(({ outcome }) => outcome === 'projected')
      .every(({ returnedRawIdentity, hiddenCalls, factCount }) =>
        !returnedRawIdentity && hiddenCalls === 1 &&
        (factCount === 6 || factCount === 4 || factCount === 2)))
      .toBe(true);
    expect(fake.rawCalls.flat()
      .filter(([request]) => request.name === 'browser_click' &&
        (request.arguments as Record<string, unknown>)['element'] !== 'Sign in'))
      .toHaveLength(0);
  });

  it('fails closed on reused runtime identity and still cleans the rejected arm', async () => {
    const fake = fakeDependencies({ duplicateIdentityAt: 1 });
    await expect(runBrowserIrHoldoutZeroModelPreflight(fake.dependencies))
      .rejects.toThrow(/unique positive fixture process PID/u);
    expect(fake.closed).toEqual([0, 1]);
  });

  it('fails closed if the hidden DB oracle changes after the non-acting snapshot', async () => {
    const fake = fakeDependencies({ mutationAt: 3 });
    await expect(runBrowserIrHoldoutZeroModelPreflight(fake.dependencies))
      .rejects.toThrow(/DB mutation/u);
    expect(fake.closed.at(-1)).toBe(3);
  });

  it('fails closed if the browser network audit contains a non-loopback origin', async () => {
    const fake = fakeDependencies({ externalNetworkAt: 0 });
    await expect(runBrowserIrHoldoutZeroModelPreflight(fake.dependencies))
      .rejects.toThrow(/External browser request/u);
    expect(fake.closed).toEqual([0]);
  });

  it('requires login and study positive controls in the observed page-request log', async () => {
    const fake = fakeDependencies({ missingNetworkPositiveControlAt: 0 });
    await expect(runBrowserIrHoldoutZeroModelPreflight(fake.dependencies))
      .rejects.toThrow(/no observable page-request URLs/u);
    expect(fake.closed).toEqual([0]);
  });

  it('rejects any rebind away from the one prospectively selected loopback origin', async () => {
    const fake = fakeDependencies({ originDriftAt: 1 });
    await expect(runBrowserIrHoldoutZeroModelPreflight(fake.dependencies))
      .rejects.toThrow(/prospectively selected loopback origin/u);
    expect(fake.closed).toEqual([0, 1]);
  });

  it('detects in-place raw-result mutation using immutable boundary bytes', async () => {
    const fake = fakeDependencies({ boundaryMutationAt: 0 });
    await expect(runBrowserIrHoldoutZeroModelPreflight(fake.dependencies))
      .rejects.toThrow(/mutated after its raw return boundary/u);
    expect(fake.closed).toEqual([0]);
  });

  it('records a product-safe opaque fallback without rewriting it as projection success', async () => {
    const fake = fakeDependencies({ unresolvedAt: 1 });
    const result = await runBrowserIrHoldoutZeroModelPreflight(fake.dependencies);
    expect(result.summary).toMatchObject({ projected: 15, projectionUnresolved: 1 });
    expect(result.captures[1]).toMatchObject({
      mode: 'auto',
      outcome: 'projection-unresolved',
      hiddenCalls: 1,
      returnedRawIdentity: true,
      returnedRawBytesUnchanged: true,
      factCount: 0,
      relationStatus: 'recoverability-not-demonstrated',
      relationEvidence: 'none',
      referenceProjectionOutcome: 'unresolved',
      geometricWitnessOutcome: 'unresolved',
    });
    expect(result.summary).toMatchObject({
      safeFallbacks: 1,
      projectionMisses: 0,
      unresolvedWithoutRecoverabilityProof: 1,
    });
  });

  it('separates a safe fallback from a demonstrated recoverable projection miss', async () => {
    const fake = fakeDependencies({ recoverableUnresolvedAt: 1 });
    const result = await runBrowserIrHoldoutZeroModelPreflight(fake.dependencies);
    expect(result.captures[1]).toMatchObject({
      mode: 'auto',
      outcome: 'projection-unresolved',
      relationStatus: 'demonstrated-recoverable',
      relationEvidence: 'evaluation-geometric-bijection-witness',
      referenceProjectionOutcome: 'resolved',
      geometricWitnessOutcome: 'resolved',
    });
    expect(result.summary).toMatchObject({
      safeFallbacks: 1,
      demonstratedRecoverableRelations: 16,
      projectionMisses: 1,
      unresolvedWithoutRecoverabilityProof: 0,
      projectionRecallOnDemonstratedRecoverable: 15 / 16,
    });
  });

  it('aggregates a primary arm failure with its cleanup failure', async () => {
    const fake = fakeDependencies({ studyFailureAt: 0, closeFailureAt: 0 });
    let failure: unknown;
    try {
      await runBrowserIrHoldoutZeroModelPreflight(fake.dependencies);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    const retained = (failure as AggregateError).errors.map((error) => String(error)).join('\n');
    expect(retained).toContain('synthetic study failure');
    expect(retained).toContain('synthetic close failure');
    expect(fake.closed).toEqual([0]);
  });

  it('rejects non-treatment catalog drift across fresh arms', async () => {
    const fake = fakeDependencies({ catalogDriftAt: 31 });
    await expect(runBrowserIrHoldoutZeroModelPreflight(fake.dependencies))
      .rejects.toThrow(/tool catalog drifted/u);
    expect(fake.closed).toHaveLength(64);
  });

  it('supplies no product mode, ordinal, or treatment-bearing cell ID to the dependency seam', async () => {
    const inputs: unknown[] = [];
    const base = fakeDependencies();
    const open = base.dependencies.openArm;
    await runBrowserIrHoldoutZeroModelPreflight({
      async openArm(input) {
        inputs.push(input);
        return open(input);
      },
    });
    expect(inputs).toHaveLength(64);
    expect(inputs.every((input) => {
      const keys = Object.keys(input as object).sort();
      return JSON.stringify(keys) === JSON.stringify(['caseId', 'family', 'worldId']);
    })).toBe(true);
  });
});
