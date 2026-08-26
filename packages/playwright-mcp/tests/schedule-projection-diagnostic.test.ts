import { describe, expect, it, vi } from 'vitest';

import type { CallToolResult, Client, ListToolsResult } from '@modelcontextprotocol/client';

import { resolveInternalPolicySet } from '../src/internal/policy-set.js';
import { takeScheduleProjectionDiagnostic } from '../src/internal/schedule-projection-diagnostic.js';
import { createScheduleProjectionDiagnosticChannel } from '../src/internal/schedule-projection-diagnostic-state.js';
import { parseSnapshotNodes } from '../src/internal/snapshot.js';
import {
  createAdaptivePlaywrightTools,
  type AdaptivePlaywrightPolicySet,
  type AdaptivePlaywrightTelemetryEvent,
} from '../src/index.js';
import {
  createCrossTreeLabelReferencePolicy,
  createGridCoordinateReferencePolicy,
  createScheduleCoordinateReferencePolicy,
} from '../src/reference-policies.js';

const BOXED = `
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

const LOSSY = BOXED.replace(/ \[box=[^\]]+\]/gu, '');

const NONADJACENT_MATERIAL_SLOT_OVERLAP = `
- table "Three-slot workshop" [box=0,0,400,240]:
  - row [box=0,0,400,60]:
    - columnheader "Monday 09:30" [box=100,0,100,60]
    - columnheader "Tuesday 10:30" [box=101,0,1,60]
    - columnheader "Wednesday 11:30" [box=150,0,20,60]
  - row [box=0,60,400,80]:
    - rowheader "Bay 2" [box=0,60,100,80]
  - row [box=0,140,400,80]:
    - rowheader "Bay 4" [box=0,140,100,80]
- button "Choose open slot" [ref=e31] [box=110,70,10,10]
- button "Choose open slot" [ref=e32] [box=125,70,10,10]
- button "Choose open slot" [ref=e33] [box=140,70,10,10]
- button "Choose open slot" [ref=e34] [box=110,150,10,10]
- button "Choose open slot" [ref=e35] [box=125,150,10,10]
- button "Choose open slot" [ref=e36] [box=140,150,10,10]
`;

const NONADJACENT_MATERIAL_SLOT_OVERLAP_LOSSY =
  NONADJACENT_MATERIAL_SLOT_OVERLAP.replace(/ \[box=[^\]]+\]/gu, '');
const nodes = (tree: string) => parseSnapshotNodes(`${tree.trim()}\n`);

const project = (
  policy: ReturnType<typeof createScheduleCoordinateReferencePolicy>,
  baselineSnapshotTree: string,
  enrichedSnapshotTree: string,
) => resolveInternalPolicySet(policy).project({
  baselineSnapshotTree: `${baselineSnapshotTree.trim()}\n`,
  baselineNodes: nodes(baselineSnapshotTree),
  enrichedSnapshotTree: `${enrichedSnapshotTree.trim()}\n`,
  enrichedNodes: nodes(enrichedSnapshotTree),
});

const reasonCases = [
  {
    reason: 'baseline-context',
    baseline: LOSSY
      .replace('button "Choose open slot" [ref=e21]', 'button "Bay 2 Monday 09:30" [ref=e21]')
      .replace('button "Choose open slot" [ref=e22]', 'button "Bay 2 Tuesday 09:30" [ref=e22]')
      .replace('button "Choose open slot" [ref=e23]', 'button "Bay 4 Monday 09:30" [ref=e23]')
      .replace('button "Choose open slot" [ref=e24]', 'button "Bay 4 Tuesday 09:30" [ref=e24]'),
    enriched: BOXED,
  },
  {
    reason: 'enriched-context',
    baseline: LOSSY,
    enriched: BOXED.replace(/\n\s+- button "Choose open slot" \[ref=e24\][^\n]*/u, ''),
  },
  {
    reason: 'root-box',
    baseline: LOSSY,
    enriched: BOXED.replace('table "Workshop weekly schedule" [box=8,8,400,240]',
      'table "Workshop weekly schedule"'),
  },
  {
    reason: 'resource-box',
    baseline: LOSSY,
    enriched: BOXED.replace('rowheader "Bay 4" [box=10,169,131,77]', 'rowheader "Bay 4"'),
  },
  {
    reason: 'slot-box',
    baseline: LOSSY,
    enriched: BOXED.replace('columnheader "Tuesday 09:30" [box=275,10,131,77]',
      'columnheader "Tuesday 09:30"'),
  },
  {
    reason: 'candidate-box',
    baseline: LOSSY,
    enriched: BOXED.replace('[ref=e24] [box=278,178,90,50]', '[ref=e24]'),
  },
  {
    reason: 'resource-bands',
    baseline: LOSSY,
    enriched: BOXED.replace('[box=10,169,131,77]', '[box=10,150,131,77]'),
  },
  {
    reason: 'slot-bands-overlap-material',
    baseline: LOSSY,
    enriched: BOXED.replace('[box=275,10,131,77]', '[box=272,10,131,77]'),
  },
  {
    reason: 'candidate-overlap',
    baseline: LOSSY,
    enriched: BOXED
      .replace('[ref=e21] [box=138,88,90,50]', '[ref=e21] [box=180,88,100,50]')
      .replace('[ref=e22] [box=278,88,90,50]', '[ref=e22] [box=250,88,100,50]'),
  },
  {
    reason: 'resources-inside-root',
    baseline: LOSSY,
    enriched: BOXED.replace('rowheader "Bay 4" [box=10,169,131,77]',
      'rowheader "Bay 4" [box=-50,169,30,77]'),
  },
  {
    reason: 'slots-inside-root',
    baseline: LOSSY,
    enriched: BOXED.replace('columnheader "Monday 09:30" [box=143,10,131,77]',
      'columnheader "Monday 09:30" [box=-50,10,50,77]'),
  },
  {
    reason: 'candidates-inside-root',
    baseline: LOSSY,
    enriched: BOXED.replace('[ref=e24] [box=278,178,90,50]',
      '[ref=e24] [box=418,178,40,40]'),
  },
  {
    reason: 'candidate-height-spacing',
    baseline: LOSSY,
    enriched: BOXED.replace('[ref=e21] [box=138,88,90,50]',
      '[ref=e21] [box=138,88,90,80]'),
  },
  {
    reason: 'fact-count',
    baseline: LOSSY,
    enriched: BOXED.replace('[ref=e21] [box=138,88,90,50]',
      '[ref=e21] [box=100,88,30,50]'),
  },
  {
    reason: 'unique-coordinate',
    baseline: LOSSY,
    enriched: BOXED
      .replace('[ref=e21] [box=138,88,90,50]', '[ref=e21] [box=150,95,40,30]')
      .replace('[ref=e22] [box=278,88,90,50]', '[ref=e22] [box=200,95,40,30]'),
  },
  { reason: 'resolved', baseline: LOSSY, enriched: BOXED },
] as const;

describe('internal schedule projection diagnostic channel', () => {
  it.each([
    ['an exact edge touch', 274],
    ['one pixel of serialized overlap', 273],
  ] as const)('keeps %s resolved with four complete facts', (_boundary, slotX) => {
    const policy = createScheduleCoordinateReferencePolicy();
    const quantized = BOXED.replace(
      '[box=275,10,131,77]',
      `[box=${slotX},10,131,77]`,
    );

    const projection = project(policy, LOSSY, quantized);

    expect(projection.kind).toBe('resolved');
    if (projection.kind !== 'resolved') throw new Error('Expected a resolved projection.');
    expect(projection.supplement.facts).toHaveLength(4);
    expect(projection.supplement.provenance).toEqual({
      policyId: 'schedule-coordinate',
      policyVersion: 'schedule-coordinate-policy/3',
    });
    expect(takeScheduleProjectionDiagnostic(policy)).toEqual({
      schemaVersion: 'schedule-projection-diagnostic/1',
      ordinal: 1,
      reason: 'resolved',
    });
  });

  it('uses the maximum pairwise overlap so a nonadjacent material overlap cannot hide', () => {
    const policy = createScheduleCoordinateReferencePolicy();

    expect(project(
      policy,
      NONADJACENT_MATERIAL_SLOT_OVERLAP_LOSSY,
      NONADJACENT_MATERIAL_SLOT_OVERLAP,
    ).kind).toBe('unresolved');
    expect(takeScheduleProjectionDiagnostic(policy)).toEqual({
      schemaVersion: 'schedule-projection-diagnostic/1',
      ordinal: 1,
      reason: 'slot-bands-overlap-material',
    });
  });

  it('keeps resource bands strict at one pixel and before slot quantization', () => {
    const policy = createScheduleCoordinateReferencePolicy();
    const overlappingBoth = BOXED
      .replace('[box=10,169,131,77]', '[box=10,165,131,77]')
      .replace('[box=275,10,131,77]', '[box=273,10,131,77]');

    expect(project(policy, LOSSY, overlappingBoth).kind).toBe('unresolved');
    expect(takeScheduleProjectionDiagnostic(policy)).toMatchObject({
      ordinal: 1,
      reason: 'resource-bands',
    });
  });

  it('accepts a one-pixel serialized final-resource overhang at the root edge', () => {
    const policy = createScheduleCoordinateReferencePolicy();
    const onePixelOverhang = BOXED.replace(
      'rowheader "Bay 4" [box=10,169,131,77]',
      'rowheader "Bay 4" [box=10,169,131,80]',
    );

    const projection = project(policy, LOSSY, onePixelOverhang);

    expect(projection.kind).toBe('resolved');
    if (projection.kind !== 'resolved') throw new Error('Expected a resolved projection.');
    expect(projection.supplement.facts).toHaveLength(4);
    expect(takeScheduleProjectionDiagnostic(policy)).toMatchObject({
      ordinal: 1,
      reason: 'resolved',
    });
  });

  it('rejects a two-pixel final-resource overhang at the root edge', () => {
    const policy = createScheduleCoordinateReferencePolicy();
    const twoPixelOverhang = BOXED.replace(
      'rowheader "Bay 4" [box=10,169,131,77]',
      'rowheader "Bay 4" [box=10,169,131,81]',
    );

    expect(project(policy, LOSSY, twoPixelOverhang).kind).toBe('unresolved');
    expect(takeScheduleProjectionDiagnostic(policy)).toMatchObject({
      ordinal: 1,
      reason: 'resources-inside-root',
    });
  });

  it('accepts nonoverlapping wide actions when centers still form an exact slot bijection', () => {
    const policy = createScheduleCoordinateReferencePolicy();
    const wide = BOXED.replace(
      '[ref=e21] [box=138,88,90,50]',
      '[ref=e21] [box=138,88,137,50]',
    );

    const projection = project(policy, LOSSY, wide);

    expect(projection.kind).toBe('resolved');
    if (projection.kind !== 'resolved') throw new Error('Expected a resolved wide projection.');
    expect(projection.supplement.facts).toHaveLength(4);
    expect(projection.supplement.facts.map(({ ref }) => ref).sort())
      .toEqual(['e21', 'e22', 'e23', 'e24']);
    expect(takeScheduleProjectionDiagnostic(policy)).toEqual({
      schemaVersion: 'schedule-projection-diagnostic/1',
      ordinal: 1,
      reason: 'resolved',
    });
  });

  it.each([
    {
      boundary: 'overlapping candidates',
      enriched: BOXED
        .replace('[ref=e21] [box=138,88,90,50]', '[ref=e21] [box=180,88,100,50]')
        .replace('[ref=e22] [box=278,88,90,50]', '[ref=e22] [box=250,88,100,50]'),
      reason: 'candidate-overlap',
    },
    {
      boundary: 'candidate outside the root',
      enriched: BOXED.replace(
        '[ref=e24] [box=278,178,90,50]',
        '[ref=e24] [box=418,178,40,40]',
      ),
      reason: 'candidates-inside-root',
    },
    {
      boundary: 'vertically staggered candidate crossing another slot band',
      enriched: BOXED
        .replace('[box=275,10,131,77]', '[box=273,10,131,77]')
        .replace('[ref=e21] [box=138,88,90,50]', '[ref=e21] [box=100,90,250,20]')
        .replace('[ref=e22] [box=278,88,90,50]', '[ref=e22] [box=150,120,250,20]')
        .replace('[ref=e23] [box=138,178,90,50]', '[ref=e23] [box=100,170,250,20]')
        .replace('[ref=e24] [box=278,178,90,50]', '[ref=e24] [box=150,200,250,20]'),
      reason: 'candidate-cross-slot',
    },
    {
      boundary: 'candidate center outside every slot band',
      enriched: BOXED.replace(
        '[ref=e21] [box=138,88,90,50]',
        '[ref=e21] [box=100,88,30,50]',
      ),
      reason: 'fact-count',
    },
    {
      boundary: 'duplicate center mapping',
      enriched: BOXED
        .replace('[ref=e21] [box=138,88,90,50]', '[ref=e21] [box=150,95,40,30]')
        .replace('[ref=e22] [box=278,88,90,50]', '[ref=e22] [box=200,95,40,30]'),
      reason: 'unique-coordinate',
    },
  ] as const)('keeps the $boundary boundary after admitting wide actions', ({ enriched, reason }) => {
    const policy = createScheduleCoordinateReferencePolicy();

    expect(project(policy, LOSSY, enriched).kind).toBe('unresolved');
    expect(takeScheduleProjectionDiagnostic(policy)).toMatchObject({ ordinal: 1, reason });
  });

  it('rejects a candidate centered inside the shared one-pixel slot interval', () => {
    const policy = createScheduleCoordinateReferencePolicy();
    const ambiguousCenter = BOXED
      .replace('[box=275,10,131,77]', '[box=273,10,131,77]')
      .replace('[ref=e22] [box=278,88,90,50]', '[ref=e22] [box=273,88,1,50]');

    expect(project(policy, LOSSY, ambiguousCenter).kind).toBe('unresolved');
    expect(takeScheduleProjectionDiagnostic(policy)).toEqual({
      schemaVersion: 'schedule-projection-diagnostic/1',
      ordinal: 1,
      reason: 'fact-count',
    });
  });

  it.each(reasonCases)('records the authoritative $reason guard once', ({ reason, baseline, enriched }) => {
    const policy = createScheduleCoordinateReferencePolicy();
    expect(takeScheduleProjectionDiagnostic(policy)).toBeUndefined();

    const projection = project(policy, baseline, enriched);
    expect(projection.kind).toBe(reason === 'resolved' ? 'resolved' : 'unresolved');

    const diagnostic = takeScheduleProjectionDiagnostic(policy);
    expect(diagnostic).toEqual({
      schemaVersion: 'schedule-projection-diagnostic/1',
      ordinal: 1,
      reason,
    });
    expect(Object.getPrototypeOf(diagnostic)).toBeNull();
    expect(Object.isFrozen(diagnostic)).toBe(true);
    expect(Reflect.ownKeys(diagnostic!)).toEqual(['schemaVersion', 'ordinal', 'reason']);
    for (const key of Reflect.ownKeys(diagnostic!)) {
      expect(Object.getOwnPropertyDescriptor(diagnostic!, key)).toMatchObject({
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    expect(takeScheduleProjectionDiagnostic(policy)).toBeUndefined();
  });

  it('increments per actual project call and destructive take does not reset the ordinal', () => {
    const policy = createScheduleCoordinateReferencePolicy();
    expect(project(policy, LOSSY, BOXED).kind).toBe('resolved');
    expect(takeScheduleProjectionDiagnostic(policy)?.ordinal).toBe(1);
    expect(project(policy, LOSSY, BOXED).kind).toBe('resolved');
    expect(takeScheduleProjectionDiagnostic(policy)?.ordinal).toBe(2);
    expect(takeScheduleProjectionDiagnostic(policy)).toBeUndefined();
  });

  it('isolates independent policy handles', () => {
    const first = createScheduleCoordinateReferencePolicy();
    const second = createScheduleCoordinateReferencePolicy();
    project(first, LOSSY, BOXED);
    expect(takeScheduleProjectionDiagnostic(second)).toBeUndefined();
    project(second, LOSSY, BOXED.replace('[ref=e21] [box=138,88,90,50]', '[ref=e21]'));
    expect(takeScheduleProjectionDiagnostic(first)).toMatchObject({ ordinal: 1, reason: 'resolved' });
    expect(takeScheduleProjectionDiagnostic(second)).toMatchObject({
      ordinal: 1,
      reason: 'candidate-box',
    });
  });

  it('joins one actual wrapper projection without retaining raw private markers', async () => {
    const privateBoxed = BOXED
      .replaceAll('Workshop weekly schedule', 'PRIVATE_CONTEXT')
      .replace('Monday 09:30', 'PRIVATE_SLOT_A 09:30')
      .replace('Tuesday 09:30', 'PRIVATE_SLOT_B 10:30')
      .replace('Bay 2', 'PRIVATE_RESOURCE_A')
      .replace('Bay 4', 'PRIVATE_RESOURCE_B')
      .replaceAll('Choose open slot', 'PRIVATE_TARGET');
    const privateLossy = privateBoxed.replace(/ \[box=[^\]]+\]/gu, '');
    const result = (tree: string): CallToolResult => ({
      content: [{
        type: 'text',
        text: [
          '### Page state',
          '- Page URL: https://fixture.test/PRIVATE_URL',
          '',
          '### Snapshot',
          '```yaml',
          tree.trim(),
          '```',
        ].join('\n'),
      }],
    });
    type RawClient = Pick<Client, 'callTool' | 'listTools'>;
    const queue = [result(privateLossy), result(privateBoxed)];
    const client: RawClient = {
      async callTool(): Promise<CallToolResult> {
        const next = queue.shift();
        if (next === undefined) throw new Error('Unexpected raw call.');
        return next;
      },
      async listTools(): Promise<ListToolsResult> { return { tools: [] }; },
    };
    const policy = createScheduleCoordinateReferencePolicy();
    const events: AdaptivePlaywrightTelemetryEvent[] = [];
    const tools = createAdaptivePlaywrightTools(client, {
      mode: 'auto',
      policySet: policy,
      telemetry: { onEvent(event) { events.push(event); } },
    });
    expect(takeScheduleProjectionDiagnostic(policy)).toBeUndefined();

    await tools.callTool({ name: 'browser_snapshot', arguments: {} });

    expect(events).toEqual([
      expect.objectContaining({ operation: 'snapshot', outcome: 'projected', hiddenCalls: 1 }),
    ]);
    const diagnostic = takeScheduleProjectionDiagnostic(policy);
    expect(diagnostic).toEqual({
      schemaVersion: 'schedule-projection-diagnostic/1',
      ordinal: 1,
      reason: 'resolved',
    });
    const retained = JSON.stringify(diagnostic);
    for (const marker of [
      'PRIVATE_CONTEXT', 'PRIVATE_SLOT', 'PRIVATE_RESOURCE', 'PRIVATE_TARGET',
      'PRIVATE_URL', 'e21', '[box=', 'https://',
    ]) expect(retained).not.toContain(marker);
    expect(takeScheduleProjectionDiagnostic(policy)).toBeUndefined();
    await tools.dispose();
  });

  it('joins an exact-one slot overlap to one projected wrapper call with four facts', async () => {
    const exactOne = BOXED.replace('[box=275,10,131,77]', '[box=273,10,131,77]');
    const result = (tree: string): CallToolResult => ({
      content: [{
        type: 'text',
        text: [
          '### Page state',
          '- Page URL: https://fixture.test/workshop',
          '',
          '### Snapshot',
          '```yaml',
          tree.trim(),
          '```',
        ].join('\n'),
      }],
    });
    type RawClient = Pick<Client, 'callTool' | 'listTools'>;
    const visible = result(LOSSY);
    const queue = [visible, result(exactOne)];
    const client: RawClient = {
      async callTool(): Promise<CallToolResult> {
        const next = queue.shift();
        if (next === undefined) throw new Error('Unexpected raw call.');
        return next;
      },
      async listTools(): Promise<ListToolsResult> { return { tools: [] }; },
    };
    const policy = createScheduleCoordinateReferencePolicy();
    const events: AdaptivePlaywrightTelemetryEvent[] = [];
    const tools = createAdaptivePlaywrightTools(client, {
      mode: 'auto',
      policySet: policy,
      telemetry: { onEvent(event) { events.push(event); } },
    });
    expect(takeScheduleProjectionDiagnostic(policy)).toBeUndefined();

    const returned = await tools.callTool({ name: 'browser_snapshot', arguments: {} });

    expect(returned).not.toBe(visible);
    expect(queue).toHaveLength(0);
    const returnedText = returned.content
      .map((block) => block.type === 'text' ? block.text : '')
      .join('\n');
    expect(returnedText.match(/^- schedule-slot /gmu)).toHaveLength(4);
    expect(returnedText).not.toContain('[box=');
    expect(events).toEqual([
      expect.objectContaining({
        operation: 'snapshot',
        outcome: 'projected',
        hiddenCalls: 1,
      }),
    ]);
    expect(takeScheduleProjectionDiagnostic(policy)).toEqual({
      schemaVersion: 'schedule-projection-diagnostic/1',
      ordinal: 1,
      reason: 'resolved',
    });
    expect(takeScheduleProjectionDiagnostic(policy)).toBeUndefined();
    await tools.dispose();
  });

  it('rejects retired slot-overlap reasons in the private writer', () => {
    const diagnostic = createScheduleProjectionDiagnosticChannel();
    const handle = Object.freeze(Object.create(null)) as AdaptivePlaywrightPolicySet;
    expect(diagnostic.bind(handle)).toBe(true);

    diagnostic.record('slot-bands' as never);
    diagnostic.record('slot-bands-overlap-one' as never);

    expect(takeScheduleProjectionDiagnostic(handle)).toBeUndefined();
  });

  it('returns undefined for foreign families and hostile keys without observing traps', () => {
    expect(takeScheduleProjectionDiagnostic(createGridCoordinateReferencePolicy())).toBeUndefined();
    expect(takeScheduleProjectionDiagnostic(createCrossTreeLabelReferencePolicy())).toBeUndefined();
    expect(takeScheduleProjectionDiagnostic(null)).toBeUndefined();
    expect(takeScheduleProjectionDiagnostic('schedule-coordinate')).toBeUndefined();
    const trap = vi.fn(() => { throw new Error('must not run'); });
    const proxy = new Proxy({}, {
      get: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
      ownKeys: trap,
    });
    expect(takeScheduleProjectionDiagnostic(proxy)).toBeUndefined();
    expect(trap).not.toHaveBeenCalled();
  });
});
