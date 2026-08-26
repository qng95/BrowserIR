import type {
  CallToolResult,
  Client,
  ListToolsResult,
} from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';

import {
  createGridCoordinateSnapshotPolicy as createBenchmarkGridPolicy,
  type AdaptiveSnapshotPolicy,
} from '../../benchmark/src/agent-benchmark/adaptive-snapshot-policy.js';
import {
  createCrossTreeLabelSnapshotPolicy as createBenchmarkCrossTreePolicy,
  createScheduleCoordinateSnapshotPolicy as createBenchmarkSchedulePolicy,
} from '../../benchmark/src/agent-benchmark/adaptive-qualification-policies.js';
import {
  ADAPTIVE_IDENTITY_BOUNDARY_CASE_IDS,
  ADAPTIVE_QUALIFICATION_WORLD_IDS,
  adaptiveIdentityBoundaryFixtures,
  adaptiveQualificationSiteFixtures,
  type AdaptiveQualificationFamily,
} from '../../benchmark/src/agent-benchmark/adaptive-qualification-fixtures.js';
import {
  createAdaptivePlaywrightTools,
  type AdaptivePlaywrightPolicySet,
  type AdaptivePlaywrightTelemetryEvent,
} from '../src/index.js';
import {
  ADAPTIVE_REFERENCE_POLICIES_VERSION,
  createCrossTreeLabelReferencePolicy,
  createGridCoordinateReferencePolicy,
  createScheduleCoordinateReferencePolicy,
  type AdaptivePlaywrightReferencePolicySet,
} from '../src/reference-policies.js';

type RawClient = Pick<Client, 'callTool' | 'listTools'>;
type CallArgs = Parameters<RawClient['callTool']>;

const snapshotText = (tree: string): string => [
  '### Page state',
  '- Page URL: https://fixture.test/reference-policy',
  '',
  '### Snapshot',
  '```yaml',
  tree.trim(),
  '```',
  '',
  '### Console',
  '- no messages',
].join('\n');

const snapshotResult = (
  tree: string,
  extras: Readonly<Record<PropertyKey, unknown>> = {},
): CallToolResult => ({
  content: [{ type: 'text', text: snapshotText(tree) }],
  ...extras,
}) as CallToolResult;

interface QueueClient extends RawClient {
  readonly calls: CallArgs[];
}

const queueClient = (queue: readonly CallToolResult[]): QueueClient => {
  const retained = [...queue];
  const calls: CallArgs[] = [];
  return {
    calls,
    async callTool(...args: CallArgs): Promise<CallToolResult> {
      calls.push(args);
      const next = retained.shift();
      if (next === undefined) throw new Error('Unexpected raw client call.');
      return next;
    },
    async listTools(): Promise<ListToolsResult> {
      return { tools: [] };
    },
  };
};

const onlyText = (result: CallToolResult): string => {
  const matches = result.content.filter(
    (block): block is Extract<typeof block, { type: 'text' }> =>
      block.type === 'text' && block.text.includes('### Snapshot'),
  );
  if (matches.length !== 1) throw new Error('Expected one snapshot text block.');
  return matches[0]!.text;
};

const renderedFacts = (result: CallToolResult): readonly string[] => {
  const marker = '### Adaptive context\n';
  const text = onlyText(result);
  const index = text.indexOf(marker);
  return index === -1
    ? []
    : (text.slice(index + marker.length).split('\n### ')[0] ?? '')
        .split('\n').filter((line) => line.startsWith('- '));
};

const benchmarkFactLines = (
  facts: NonNullable<Awaited<ReturnType<AdaptiveSnapshotPolicy['project']>>['supplement']>['facts'],
): readonly string[] => facts.map((fact) => {
  const attributes = Object.entries(fact.attributes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');
  return `- ${fact.kind} [ref=${fact.ref}] ${attributes}`;
}).sort((left, right) => {
  const leftIdentity = /- ([^ ]+) \[ref=([^\]]+)\]/u.exec(left);
  const rightIdentity = /- ([^ ]+) \[ref=([^\]]+)\]/u.exec(right);
  return `${leftIdentity?.[1]}\u0000${leftIdentity?.[2]}`
    .localeCompare(`${rightIdentity?.[1]}\u0000${rightIdentity?.[2]}`);
});

const GRID_LOSSY = `
- navigation "Primary" [ref=e90]
  - button "Sign out" [ref=e91]
- grid "Quarterly matrix" [ref=e1]
  - row [ref=e2]
    - columnheader "February" [ref=e3]
    - columnheader "March" [ref=e4]
  - row [ref=e5]
    - rowheader "Berlin" [ref=e6]
  - row [ref=e7]
    - rowheader "Paris" [ref=e8]
- button "Apply value" [ref=e9]
- button "Apply value" [ref=e10]
- button "Apply value" [ref=e11]
- button "Apply value" [ref=e12]
`;

const GRID_BOXED = `
- navigation "Primary" [ref=e190] [box=0,0,50,20]
  - button "Sign out" [ref=e191] [box=0,0,50,20]
- grid "Quarterly matrix" [ref=e101] [box=0,0,300,250]
  - row [ref=e102] [box=0,0,300,50]
    - columnheader "February" [ref=e103] [box=100,0,100,50]
    - columnheader "March" [ref=e104] [box=200,0,100,50]
  - row [ref=e105] [box=0,50,300,100]
    - rowheader "Berlin" [ref=e106] [box=0,50,100,100]
  - row [ref=e107] [box=0,150,300,100]
    - rowheader "Paris" [ref=e108] [box=0,150,100,100]
- button "Apply value" [ref=e21] [box=110,75,80,50]
- button "Apply value" [ref=e22] [box=210,75,80,50]
- button "Apply value" [ref=e23] [box=110,175,80,50]
- button "Apply value" [ref=e24] [box=210,175,80,50]
`;

const GRID_SUFFICIENT = GRID_LOSSY
  .replace('button "Apply value" [ref=e9]', 'button "Berlin February Apply value" [ref=e9]')
  .replace('button "Apply value" [ref=e10]', 'button "Berlin March Apply value" [ref=e10]')
  .replace('button "Apply value" [ref=e11]', 'button "Paris February Apply value" [ref=e11]')
  .replace('button "Apply value" [ref=e12]', 'button "Paris March Apply value" [ref=e12]');

const withoutSnapshotBoxes = (tree: string): string =>
  tree.replace(/ \[box=[^\]]+\]/gu, '');

/*
 * Official Playwright snapshots round each element's getBoundingClientRect().
 * A native fixed-layout table and its sibling overlay do not share idealized
 * cell edges: the first-column controls can slightly straddle their header
 * bands while their centers remain unambiguously aligned.
 */
const WORKSHOP_RENDERER_BOXED = `
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

const WORKSHOP_RENDERER_LOSSY = withoutSnapshotBoxes(WORKSHOP_RENDERER_BOXED);

const CASE_ROUTING_RENDERER_BOXED = `
- region "Case routing" [box=8,8,620,350]:
  - group "Relationship labels" [box=28,130,300,198]:
    - heading "Urgent queue" [box=28,130,300,90]
    - heading "Routine queue" [box=28,238,300,90]
  - group "Relationship controls" [box=364,130,220,198]:
    - button "Open case" [ref=e31] [box=364,152,220,46]
    - button "Open case" [ref=e32] [box=364,260,220,46]
`;

const APPROVAL_LANES_RENDERER_BOXED = `
- form "Approval routing" [box=8,8,620,350]:
  - list "Relationship labels" [box=28,130,300,198]:
    - term "Security review" [box=28,130,300,90]
    - term "Finance review" [box=28,238,300,90]
  - list "Relationship controls" [box=370,130,214,198]:
    - listitem [box=370,130,214,90]:
      - button "Review request" [ref=e41] [box=370,152,214,46]
    - listitem [box=370,238,214,90]:
      - button "Review request" [ref=e42] [box=370,260,214,46]
`;

const referencePolicyFor = (familyId: AdaptiveQualificationFamily) =>
  familyId === 'schedule-coordinate'
    ? createScheduleCoordinateReferencePolicy()
    : createCrossTreeLabelReferencePolicy();

const benchmarkPolicyFor = (familyId: AdaptiveQualificationFamily) =>
  familyId === 'schedule-coordinate'
    ? createBenchmarkSchedulePolicy()
    : createBenchmarkCrossTreePolicy();

describe('reference policy public surface', () => {
  it('returns direct branded handles with immutable family/version/support metadata only', () => {
    expect(ADAPTIVE_REFERENCE_POLICIES_VERSION).toBe('adaptive-reference-policies/1');
    const cases = [
      [
        createGridCoordinateReferencePolicy({ maxRows: 4, maxColumns: 5 }),
        'grid-coordinate',
        'grid-coordinate-policy/1',
        {
          feature: 'geometry',
          schema: 'grid-coordinate/1',
          factKind: 'grid-cell',
          attributes: ['row', 'column'],
          completeOrNone: true,
          refSource: 'current-boxed-snapshot',
          minimumFacts: 4,
          maximumFacts: 20,
          limits: { minimumRows: 2, maximumRows: 4, minimumColumns: 2, maximumColumns: 5 },
        },
      ],
      [
        createScheduleCoordinateReferencePolicy(),
        'schedule-coordinate',
        'schedule-coordinate-policy/3',
        {
          feature: 'geometry',
          schema: 'schedule-coordinate/1',
          factKind: 'schedule-slot',
          attributes: ['resource', 'slot'],
          completeOrNone: true,
          refSource: 'current-boxed-snapshot',
          minimumFacts: 4,
          maximumFacts: 64,
          limits: { minimumResources: 2, maximumResources: 12, minimumSlots: 2, maximumSlots: 12 },
        },
      ],
      [
        createCrossTreeLabelReferencePolicy(),
        'cross-tree-label',
        'cross-tree-label-policy/1',
        {
          feature: 'geometry',
          schema: 'cross-tree-label/1',
          factKind: 'cross-tree-label',
          attributes: ['label'],
          completeOrNone: true,
          refSource: 'current-boxed-snapshot',
          minimumFacts: 2,
          maximumFacts: 2,
          limits: { labels: 2, controls: 2 },
        },
      ],
    ] as const;
    for (const [policy, family, version, support] of cases) {
      expect(Reflect.ownKeys(policy)).toEqual(['family', 'version', 'support']);
      expect(Object.getPrototypeOf(policy)).toBeNull();
      expect(Object.isFrozen(policy)).toBe(true);
      expect(policy.family).toBe(family);
      expect(policy.version).toBe(version);
      expect(policy.support).toEqual(support);
      expect(Reflect.ownKeys(policy.support)).toEqual(Reflect.ownKeys(support));
      expect(Object.isFrozen(policy.support)).toBe(true);
      expect(Object.isFrozen(policy.support.attributes)).toBe(true);
      expect(Object.isFrozen(policy.support.limits)).toBe(true);
      expect(Reflect.set(policy as unknown as Record<string, unknown>, 'family', 'forged'))
        .toBe(false);
      expect(Reflect.set(
        policy.support as unknown as Record<string, unknown>,
        'maximumFacts',
        10_000,
      )).toBe(false);
      expect(policy).not.toHaveProperty('evaluate');
      expect(policy).not.toHaveProperty('project');
      expect(policy).not.toHaveProperty('policyId');
    }
  });

  it('rejects non-exact, exotic, accessor, and out-of-bound grid options', () => {
    const accessor = Object.defineProperty({}, 'maxRows', {
      enumerable: true,
      get: () => 2,
    });
    const symbol = { maxRows: 2, [Symbol('extra')]: true };
    const inherited = Object.assign(Object.create({ inherited: true }), { maxRows: 2 });
    for (const options of [
      null,
      [],
      accessor,
      symbol,
      inherited,
      { unknown: 2 },
      { maxRows: undefined },
      { maxRows: 1, maxColumns: 2 },
      { maxRows: 2.5, maxColumns: 2 },
      { maxRows: 33, maxColumns: 2 },
      { maxRows: 32, maxColumns: 32 },
    ]) {
      expect(() => createGridCoordinateReferencePolicy(options as never)).toThrow();
    }
    expect(createGridCoordinateReferencePolicy()).toMatchObject({
      support: { maximumFacts: 144 },
    });
    expect(createGridCoordinateReferencePolicy({ maxRows: 16, maxColumns: 16 }))
      .toMatchObject({ support: { maximumFacts: 256 } });
  });

  it('rejects option Proxies before invoking any user-controlled trap', () => {
    let traps = 0;
    const proxy = new Proxy({}, {
      getPrototypeOf() {
        traps += 1;
        return Object.prototype;
      },
      ownKeys() {
        traps += 1;
        return ['maxRows'];
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        return { value: 2, enumerable: true, configurable: true, writable: true };
      },
    });
    expect(() => createGridCoordinateReferencePolicy(proxy as never)).toThrow(/Proxy/u);
    expect(traps).toBe(0);
  });

  it('cannot register a forged or proxied metadata-equivalent policy handle', () => {
    const authentic = createScheduleCoordinateReferencePolicy();
    const forged = Object.freeze(Object.assign(Object.create(null), {
      family: authentic.family,
      version: authentic.version,
      support: authentic.support,
    })) as AdaptivePlaywrightPolicySet;
    const proxied = new Proxy(authentic, {});
    const client = queueClient([]);
    for (const policySet of [forged, proxied]) {
      expect(() => createAdaptivePlaywrightTools(client, { mode: 'auto', policySet }))
        .toThrow(/first-party policy set/u);
    }
  });
});

describe('differential offline reference corpus', () => {
  it('matches the frozen benchmark grid decisions and complete projected facts', async () => {
    const benchmark = createBenchmarkGridPolicy();
    for (const testCase of [
      { baseline: GRID_LOSSY, enriched: GRID_BOXED, expected: 'require' },
      { baseline: GRID_SUFFICIENT, expected: 'sufficient' },
    ] as const) {
      expect(benchmark.evaluate({ snapshotTree: testCase.baseline }).kind).toBe(testCase.expected);
      const visible = snapshotResult(testCase.baseline);
      const enriched = testCase.enriched;
      const hidden = enriched === undefined
        ? undefined
        : snapshotResult(enriched);
      const client = queueClient(hidden === undefined ? [visible] : [visible, hidden]);
      const events: AdaptivePlaywrightTelemetryEvent[] = [];
      const tools = createAdaptivePlaywrightTools(client, {
        mode: 'auto',
        policySet: createGridCoordinateReferencePolicy(),
        telemetry: { onEvent: (event) => events.push(event) },
      });
      const returned = await tools.callTool({ name: 'browser_snapshot', arguments: {} });
      if (enriched === undefined) {
        expect(returned).toBe(visible);
        expect(client.calls).toHaveLength(1);
        expect(events).toEqual([expect.objectContaining({ outcome: 'passthrough', hiddenCalls: 0 })]);
      } else {
        const projected = await benchmark.project({
          feature: 'geometry',
          baselineSnapshotTree: testCase.baseline,
          featureSnapshotTree: enriched,
        });
        expect(projected.kind).toBe('resolved');
        expect(returned).not.toBe(visible);
        expect(client.calls).toHaveLength(2);
        expect(renderedFacts(returned)).toEqual(benchmarkFactLines(projected.supplement!.facts));
        expect(onlyText(returned)).not.toContain('[box=');
        expect(events).toEqual([expect.objectContaining({ outcome: 'projected', hiddenCalls: 1 })]);
      }
      await tools.dispose();
    }
  });

  it.each([
    'schedule-coordinate',
    'cross-tree-label',
  ] as const)('matches all independent %s benchmark worlds', async (familyId) => {
    const benchmark = benchmarkPolicyFor(familyId);
    const sites = Object.values(adaptiveQualificationSiteFixtures)
      .filter((site) => site.familyId === familyId);
    expect(sites).toHaveLength(2);
    for (const site of sites) {
      for (const worldId of ADAPTIVE_QUALIFICATION_WORLD_IDS) {
        const world = site.worlds[worldId];
        const expectedDecision = world.qualification === 'needs-enrichment'
          ? 'require'
          : 'sufficient';
        expect(benchmark.evaluate({ snapshotTree: world.snapshotTree }).kind)
          .toBe(expectedDecision);
        const visible = snapshotResult(world.snapshotTree);
        const hidden = snapshotResult(world.geometrySnapshotTree);
        const client = queueClient(expectedDecision === 'require' ? [visible, hidden] : [visible]);
        const tools = createAdaptivePlaywrightTools(client, {
          mode: 'auto',
          policySet: referencePolicyFor(familyId),
        });
        const returned = await tools.callTool({ name: 'browser_snapshot', arguments: {} });
        if (expectedDecision === 'sufficient') {
          expect(returned).toBe(visible);
          expect(client.calls).toHaveLength(1);
        } else {
          const projected = await benchmark.project({
            feature: 'geometry',
            baselineSnapshotTree: world.snapshotTree,
            featureSnapshotTree: world.geometrySnapshotTree,
          });
          expect(projected.kind).toBe('resolved');
          expect(returned).not.toBe(visible);
          expect(client.calls).toHaveLength(2);
          expect(renderedFacts(returned)).toEqual(benchmarkFactLines(projected.supplement!.facts));
          expect(renderedFacts(returned).every((line) => line.includes('[ref=f2e'))).toBe(true);
          expect(onlyText(returned)).not.toContain('[box=');
        }
        await tools.dispose();
      }
    }
  });

  it('projects a renderer-faithful native table with a sibling action overlay', async () => {
    const benchmark = createBenchmarkSchedulePolicy();
    expect(benchmark.evaluate({ snapshotTree: WORKSHOP_RENDERER_LOSSY }).kind).toBe('require');
    const benchmarkProjection = await benchmark.project({
      feature: 'geometry',
      baselineSnapshotTree: WORKSHOP_RENDERER_LOSSY,
      featureSnapshotTree: WORKSHOP_RENDERER_BOXED,
    });
    expect(benchmarkProjection.kind).toBe('resolved');
    expect(benchmarkProjection.supplement?.facts).toHaveLength(4);

    const visible = snapshotResult(WORKSHOP_RENDERER_LOSSY);
    const client = queueClient([visible, snapshotResult(WORKSHOP_RENDERER_BOXED)]);
    const events: AdaptivePlaywrightTelemetryEvent[] = [];
    const tools = createAdaptivePlaywrightTools(client, {
      mode: 'auto',
      policySet: createScheduleCoordinateReferencePolicy(),
      telemetry: { onEvent: (event) => events.push(event) },
    });

    const returned = await tools.callTool({ name: 'browser_snapshot', arguments: {} });

    expect(returned).not.toBe(visible);
    expect(client.calls).toHaveLength(2);
    expect(renderedFacts(returned)).toEqual(
      benchmarkFactLines(benchmarkProjection.supplement!.facts),
    );
    expect(renderedFacts(returned).every((line) => line.includes('[ref=e2'))).toBe(true);
    expect(onlyText(returned)).not.toContain('[box=');
    expect(events).toEqual([
      expect.objectContaining({ outcome: 'projected', hiddenCalls: 1 }),
    ]);
    await tools.dispose();
  });

  it('projects a wide nonoverlapping action when its center binding remains complete', async () => {
    const enriched = WORKSHOP_RENDERER_BOXED.replace(
      '[ref=e21] [box=138,88,90,50]',
      '[ref=e21] [box=76,88,134,50]',
    );
    const benchmark = createBenchmarkSchedulePolicy();
    const benchmarkProjection = await benchmark.project({
      feature: 'geometry',
      baselineSnapshotTree: WORKSHOP_RENDERER_LOSSY,
      featureSnapshotTree: enriched,
    });
    expect(benchmarkProjection.kind).toBe('resolved');
    const visible = snapshotResult(WORKSHOP_RENDERER_LOSSY);
    const client = queueClient([visible, snapshotResult(enriched)]);
    const events: AdaptivePlaywrightTelemetryEvent[] = [];
    const tools = createAdaptivePlaywrightTools(client, {
      mode: 'auto',
      policySet: createScheduleCoordinateReferencePolicy(),
      telemetry: { onEvent: (event) => events.push(event) },
    });

    const returned = await tools.callTool({ name: 'browser_snapshot', arguments: {} });

    expect(returned).not.toBe(visible);
    expect(client.calls).toHaveLength(2);
    expect(renderedFacts(returned)).toEqual(
      benchmarkFactLines(benchmarkProjection.supplement!.facts),
    );
    expect(events).toEqual([
      expect.objectContaining({ outcome: 'projected', hiddenCalls: 1 }),
    ]);
    await tools.dispose();
  });

  it.each([
    ['case-routing sibling groups', CASE_ROUTING_RENDERER_BOXED],
    ['approval-lanes sibling lists', APPROVAL_LANES_RENDERER_BOXED],
  ] as const)('keeps strict containment for renderer-faithful %s', async (_name, boxed) => {
    const baseline = withoutSnapshotBoxes(boxed);
    const benchmark = createBenchmarkCrossTreePolicy();
    expect(benchmark.evaluate({ snapshotTree: baseline }).kind).toBe('require');
    const benchmarkProjection = await benchmark.project({
      feature: 'geometry',
      baselineSnapshotTree: baseline,
      featureSnapshotTree: boxed,
    });
    expect(benchmarkProjection.kind).toBe('resolved');
    expect(benchmarkProjection.supplement?.facts).toHaveLength(2);

    const visible = snapshotResult(baseline);
    const client = queueClient([visible, snapshotResult(boxed)]);
    const tools = createAdaptivePlaywrightTools(client, {
      mode: 'auto',
      policySet: createCrossTreeLabelReferencePolicy(),
    });
    const returned = await tools.callTool({ name: 'browser_snapshot', arguments: {} });

    expect(returned).not.toBe(visible);
    expect(client.calls).toHaveLength(2);
    expect(renderedFacts(returned)).toEqual(
      benchmarkFactLines(benchmarkProjection.supplement!.facts),
    );
    expect(onlyText(returned)).not.toContain('[box=');
    await tools.dispose();
  });
});

describe('reference policy fail-closed boundaries', () => {
  it('rejects overlapping and ambiguous renderer geometry without partial facts', async () => {
    const variants = [
      {
        kind: 'overlapping-candidates',
        benchmarkOutcome: 'resolved',
        enriched: WORKSHOP_RENDERER_BOXED
          .replace('[ref=e21] [box=138,88,90,50]', '[ref=e21] [box=180,88,100,50]')
          .replace('[ref=e22] [box=278,88,90,50]', '[ref=e22] [box=250,88,100,50]'),
      },
      {
        kind: 'ambiguous-overlapping-bands',
        benchmarkOutcome: 'unresolved',
        enriched: WORKSHOP_RENDERER_BOXED.replace(
          'columnheader "Monday 09:30" [box=143,10,131,77]',
          'columnheader "Monday 09:30" [box=143,10,160,77]',
        ),
      },
    ] as const;
    const benchmark = createBenchmarkSchedulePolicy();
    for (const variant of variants) {
      const benchmarkProjection = await benchmark.project({
        feature: 'geometry',
        baselineSnapshotTree: WORKSHOP_RENDERER_LOSSY,
        featureSnapshotTree: variant.enriched,
      });
      expect(benchmarkProjection.kind, variant.kind).toBe(variant.benchmarkOutcome);
      const visible = snapshotResult(WORKSHOP_RENDERER_LOSSY);
      const client = queueClient([visible, snapshotResult(variant.enriched)]);
      const events: AdaptivePlaywrightTelemetryEvent[] = [];
      const tools = createAdaptivePlaywrightTools(client, {
        mode: 'auto',
        policySet: createScheduleCoordinateReferencePolicy(),
        telemetry: { onEvent: (event) => events.push(event) },
      });

      const returned = await tools.callTool({ name: 'browser_snapshot', arguments: {} });

      expect(returned).toBe(visible);
      expect(client.calls).toHaveLength(2);
      expect(renderedFacts(returned)).toEqual([]);
      expect(events).toEqual([
        expect.objectContaining({ outcome: 'projection-unresolved', hiddenCalls: 1 }),
      ]);
      await tools.dispose();
    }
  });

  it('rejects multi-family documents and same-family conflicts before hidden acquisition', async () => {
    const schedule = Object.values(adaptiveQualificationSiteFixtures)
      .find((site) => site.familyId === 'schedule-coordinate')!
      .worlds['lossy-a'].snapshotTree;
    const crossTree = Object.values(adaptiveQualificationSiteFixtures)
      .find((site) => site.familyId === 'cross-tree-label')!
      .worlds['lossy-a'].snapshotTree;
    const mixed = `${GRID_LOSSY.trim()}\n${schedule.trim()}\n${crossTree.trim()}\n`;
    const sameGridConflict = `${GRID_LOSSY.trim()}\n${GRID_LOSSY
      .replace(/\[ref=e(\d+)\]/gu, '[ref=f1e$1]')
      .replace('Quarterly matrix', 'Competing matrix')
      .trim()}\n`;
    const extraGridRoot = `${GRID_LOSSY.trim()}\n- grid "Competing empty grid" [ref=f1e90]\n`;
    const rootOverflow = `${GRID_LOSSY.trim()}\n${Array.from(
      { length: 32 },
      (_, index) => `- region "Unrelated ${index}" [ref=f1e${200 + index}]`,
    ).join('\n')}\n`;
    for (const tree of [mixed, sameGridConflict, extraGridRoot, rootOverflow]) {
      for (const policySet of [
        createGridCoordinateReferencePolicy(),
        createScheduleCoordinateReferencePolicy(),
        createCrossTreeLabelReferencePolicy(),
      ]) {
        const visible = snapshotResult(tree);
        const client = queueClient([visible]);
        const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet });
        await expect(tools.callTool({ name: 'browser_snapshot', arguments: {} }))
          .resolves.toBe(visible);
        expect(client.calls).toHaveLength(1);
        await tools.dispose();
      }
    }
  });

  it('emits no partial supplement for incomplete, outside, or overlapping geometry', async () => {
    const invalidEnriched = [
      GRID_BOXED.replace('[ref=e24] [box=210,175,80,50]', '[ref=e24]'),
      GRID_BOXED.replace('[ref=e24] [box=210,175,80,50]', '[ref=e24] [box=410,175,80,50]'),
      GRID_BOXED.replace('[ref=e24] [box=210,175,80,50]', '[ref=e24] [box=110,175,80,50]'),
      GRID_BOXED
        .replace('[ref=e21] [box=110,75,80,50]', '[ref=e21] [box=150,75,80,50]')
        .replace('[ref=e22] [box=210,75,80,50]', '[ref=e22] [box=170,75,80,50]'),
    ];
    for (const enriched of invalidEnriched) {
      const visible = snapshotResult(GRID_LOSSY);
      const client = queueClient([visible, snapshotResult(enriched)]);
      const tools = createAdaptivePlaywrightTools(client, {
        mode: 'auto',
        policySet: createGridCoordinateReferencePolicy(),
      });
      const returned = await tools.callTool({ name: 'browser_snapshot', arguments: {} });
      expect(returned).toBe(visible);
      expect(client.calls).toHaveLength(2);
      expect(renderedFacts(returned)).toEqual([]);
      await tools.dispose();
    }

    for (const familyId of ['schedule-coordinate', 'cross-tree-label'] as const) {
      const world = Object.values(adaptiveQualificationSiteFixtures)
        .find((site) => site.familyId === familyId)!
        .worlds['lossy-a'];
      const incomplete = world.geometrySnapshotTree.replace(/ \[box=[^\]]+\](?=\n)/u, '');
      const invalidVariants = [incomplete];
      if (familyId === 'schedule-coordinate') {
        invalidVariants.push(world.geometrySnapshotTree
          .replace('[box=130,80,90,50]', '[box=190,80,90,50]')
          .replace('[box=270,80,90,50]', '[box=215,80,90,50]'));
      }
      for (const invalid of invalidVariants) {
        const visible = snapshotResult(world.snapshotTree);
        const client = queueClient([visible, snapshotResult(invalid)]);
        const tools = createAdaptivePlaywrightTools(client, {
          mode: 'auto',
          policySet: referencePolicyFor(familyId),
        });
        await expect(tools.callTool({ name: 'browser_snapshot', arguments: {} }))
          .resolves.toBe(visible);
        expect(client.calls).toHaveLength(2);
        await tools.dispose();
      }
    }
  });

  it('rejects a current ref collision anywhere in the boxed snapshot', async () => {
    const duplicate = GRID_BOXED.replace('[ref=e190]', '[ref=e21]');
    const visible = snapshotResult(GRID_LOSSY);
    const client = queueClient([visible, snapshotResult(duplicate)]);
    const tools = createAdaptivePlaywrightTools(client, {
      mode: 'auto',
      policySet: createGridCoordinateReferencePolicy(),
    });
    await expect(tools.callTool({ name: 'browser_snapshot', arguments: {} }))
      .resolves.toBe(visible);
    expect(client.calls).toHaveLength(2);
    await tools.dispose();
  });

  it('never treats quoted, slash-delimited, or post-colon literal refs as actionable', async () => {
    const literalCandidates = [
      '- button "Apply value [ref=e9]"',
      '- button /Apply value [ref=e9]/',
      '- button: Apply value [ref=e9]',
    ];
    for (const candidate of literalCandidates) {
      const tree = GRID_LOSSY.replace(/- button "Apply value" \[ref=e(?:9|10|11|12)\]/gu, candidate);
      const visible = snapshotResult(tree);
      const client = queueClient([visible]);
      const tools = createAdaptivePlaywrightTools(client, {
        mode: 'auto',
        policySet: createGridCoordinateReferencePolicy(),
      });
      await expect(tools.callTool({ name: 'browser_snapshot', arguments: {} }))
        .resolves.toBe(visible);
      expect(client.calls).toHaveLength(1);
      await tools.dispose();
    }
  });

  it('does not claim virtual or recycled identity support', async () => {
    const otherwiseMatchableVirtualGrid = GRID_LOSSY.replace(
      '- grid "Quarterly matrix" [ref=e1]',
      '- grid "Quarterly matrix" [ref=e1] [rowcount=10000]',
    );
    const virtualVisible = snapshotResult(otherwiseMatchableVirtualGrid);
    const virtualClient = queueClient([virtualVisible]);
    const virtualTools = createAdaptivePlaywrightTools(virtualClient, {
      mode: 'auto',
      policySet: createGridCoordinateReferencePolicy(),
    });
    await expect(virtualTools.callTool({ name: 'browser_snapshot', arguments: {} }))
      .resolves.toBe(virtualVisible);
    expect(virtualClient.calls).toHaveLength(1);
    await virtualTools.dispose();

    for (const caseId of ADAPTIVE_IDENTITY_BOUNDARY_CASE_IDS) {
      const fixture = adaptiveIdentityBoundaryFixtures[caseId];
      const [before, after] = fixture.states;
      expect(before.ref).toBe(after.ref);
      expect(before.businessKey).not.toBe(after.businessKey);
      const identityTrees = [before, after].map((state) => `
- grid "Virtual records" [ref=e1] [rowcount=10000]
  - row "${state.businessKey}" [ref=${state.ref}] [rowindex=501]
    - button "Open record" [ref=e90]
`);
      for (const tree of identityTrees) {
        for (const policySet of [
          createGridCoordinateReferencePolicy(),
          createScheduleCoordinateReferencePolicy(),
          createCrossTreeLabelReferencePolicy(),
        ]) {
          const visible = snapshotResult(tree);
          const client = queueClient([visible]);
          const tools = createAdaptivePlaywrightTools(client, { mode: 'auto', policySet });
          await expect(tools.callTool({ name: 'browser_snapshot', arguments: {} }))
            .resolves.toBe(visible);
          expect(client.calls).toHaveLength(1);
          await tools.dispose();
        }
      }
    }
  });

  it('requires the core state commitment before using current enriched refs', async () => {
    const changed = GRID_BOXED.replaceAll('Paris', 'Vienna');
    const visible = snapshotResult(GRID_LOSSY);
    const client = queueClient([visible, snapshotResult(changed)]);
    const tools = createAdaptivePlaywrightTools(client, {
      mode: 'auto',
      policySet: createGridCoordinateReferencePolicy(),
    });
    const returned = await tools.callTool({ name: 'browser_snapshot', arguments: {} });
    expect(returned).toBe(visible);
    expect(client.calls).toHaveLength(2);
    expect(onlyText(returned)).not.toContain('Vienna');
    await tools.dispose();
  });
});

describe('real-policy raw result fidelity', () => {
  it('changes only the one snapshot text block and retains every unrelated raw identity', async () => {
    const annotations = { audience: ['assistant'] as const, priority: 0.8 };
    const meta = { requestId: 'reference-policy-raw' };
    const snapshotBlock = Object.assign({
      type: 'text' as const,
      text: snapshotText(GRID_LOSSY),
      annotations,
      _meta: meta,
    }, { vendorBlock: { retained: true } });
    const image = { type: 'image' as const, data: 'AA==', mimeType: 'image/png', _meta: meta };
    const trailing = { type: 'text' as const, text: 'trailing', _meta: meta };
    const content = [image, snapshotBlock, trailing];
    const structuredContent = { upstream: { retained: true } };
    const visible = Object.assign({
      content,
      structuredContent,
      _meta: meta,
      isError: false,
    }, { vendorResult: { retained: true } }) as unknown as CallToolResult;
    const client = queueClient([visible, snapshotResult(GRID_BOXED)]);
    const tools = createAdaptivePlaywrightTools(client, {
      mode: 'auto',
      policySet: createGridCoordinateReferencePolicy(),
    });

    const returned = await tools.callTool({ name: 'browser_snapshot', arguments: {} });

    expect(returned).not.toBe(visible);
    expect(returned.content).not.toBe(content);
    expect(returned.content[0]).toBe(image);
    expect(returned.content[2]).toBe(trailing);
    expect(returned.content[1]).not.toBe(snapshotBlock);
    const returnedSnapshotBlock = returned.content[1] as unknown as typeof snapshotBlock;
    expect(returnedSnapshotBlock.annotations).toBe(annotations);
    expect(returnedSnapshotBlock._meta).toBe(meta);
    expect(returnedSnapshotBlock.vendorBlock).toBe(snapshotBlock.vendorBlock);
    expect(returned.structuredContent).toBe(structuredContent);
    expect(returned._meta).toBe(meta);
    expect((returned as unknown as { vendorResult: unknown }).vendorResult)
      .toBe((visible as unknown as { vendorResult: unknown }).vendorResult);
    expect(renderedFacts(returned)).toHaveLength(4);
    await tools.dispose();
  });

  it('keeps exact visible identity on every fail-closed path', async () => {
    const visible = snapshotResult(GRID_LOSSY, {
      structuredContent: { raw: true },
      vendor: { retained: true },
    });
    const client = queueClient([visible, snapshotResult(GRID_BOXED.replaceAll('Paris', 'Vienna'))]);
    const tools = createAdaptivePlaywrightTools(client, {
      mode: 'auto',
      policySet: createGridCoordinateReferencePolicy(),
    });
    await expect(tools.callTool({ name: 'browser_snapshot', arguments: {} }))
      .resolves.toBe(visible);
    await tools.dispose();
  });
});

const typeOnlyPolicyCompatibility = (
  policy: AdaptivePlaywrightReferencePolicySet,
): AdaptivePlaywrightPolicySet => policy;
void typeOnlyPolicyCompatibility;
