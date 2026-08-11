import { describe, expect, it } from 'vitest';

import {
  compileView,
  type CapabilityKind,
  type Entity,
  type EntityKind,
  type GraphSnapshot,
  type Relation,
  type RelationKind,
} from '../src/index.js';
import {
  compileViewForTesting,
  type CompileViewOptions,
} from '../src/compiler.js';

const entityKinds: readonly EntityKind[] = [
  'document',
  'region',
  'input',
  'control',
  'option',
  'dialog',
  'table',
  'row',
  'cell',
  'text',
  'status',
];
const relationKinds: readonly RelationKind[] = [
  'contains',
  'labels',
  'controls',
  'row-of',
  'cell-of',
  'option-of',
  'describes',
];
const capabilityKinds: readonly CapabilityKind[] = [
  'click',
  'fill',
  'select',
  'hover',
  'focus',
];

const randomSource = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

const integer = (random: () => number, maxExclusive: number): number =>
  Math.floor(random() * maxExclusive);

const randomizedSnapshot = (seed: number): GraphSnapshot => {
  const random = randomSource(seed);
  const entityCount = 1 + integer(random, 72);
  const entities: Entity[] = Array.from({ length: entityCount }, (_, index) => {
    const id = `e${index + 1}`;
    const kind = entityKinds[integer(random, entityKinds.length)]!;
    const role =
      ['button', 'link', 'textbox', 'combobox', 'row', 'gridcell', undefined][
        integer(random, 7)
      ];
    const longSuffix = random() < 0.22 ? `-${'long-content-'.repeat(18)}` : '';
    const capabilityCount = integer(random, 3);
    return {
      id,
      pageId: 'page-random',
      kind,
      ...(role === undefined ? {} : { role }),
      name: `Entity ${index} "quoted" \\ slash ${seed}${longSuffix}`,
      ...(random() < 0.55
        ? { text: `Text ${index}\nline ${seed}${longSuffix}` }
        : {}),
      ...(random() < 0.35
        ? {
            value:
              random() < 0.5
                ? index
                : { seed, text: `value-${index}${longSuffix}` },
          }
        : {}),
      state: {
        visible: random() < 0.8,
        enabled: random() < 0.75,
        focused: random() < 0.08,
        transient: random() < 0.05,
      },
      ...(random() < 0.65
        ? {
            geometry: {
              x: integer(random, 1_000),
              y: integer(random, 3_000),
              width: 20 + integer(random, 500),
              height: 10 + integer(random, 100),
              inViewport: random() < 0.7,
            },
          }
        : {}),
      capabilities: Array.from({ length: capabilityCount }, (_, capabilityIndex) => ({
        kind: capabilityKinds[(index + capabilityIndex) % capabilityKinds.length]!,
        enabled: random() < 0.85,
        ...(random() < 0.25 ? { reason: `reason-${seed}-${index}${longSuffix}` } : {}),
      })),
      evidence: [
        {
          sensor: `sensor-${integer(random, 4)}${longSuffix}`,
          detail: `detail-${seed}-${index}${longSuffix}`,
          confidence: Math.round(random() * 1_000) / 1_000,
        },
      ],
      confidence: Math.round(random() * 1_000) / 1_000,
    };
  });

  const relations: Relation[] = [];
  const seenRelations = new Set<string>();
  const relationAttempts = integer(random, entityCount * 3 + 1);
  for (let attempt = 0; attempt < relationAttempts; attempt += 1) {
    const from = entities[integer(random, entities.length)]!.id;
    const to = entities[integer(random, entities.length)]!.id;
    const kind = relationKinds[integer(random, relationKinds.length)]!;
    const key = `${from}\u0000${kind}\u0000${to}`;
    if (seenRelations.has(key)) continue;
    seenRelations.add(key);
    relations.push({
      from,
      to,
      kind,
      confidence: Math.round(random() * 1_000) / 1_000,
      ...(random() < 0.4
        ? {
            evidence: [
              {
                sensor: `relation-${integer(random, 3)}`,
                detail: `edge-${attempt}`,
                confidence: Math.round(random() * 1_000) / 1_000,
              },
            ],
          }
        : {}),
    });
  }

  return {
    browserId: 'browser-random',
    pageId: 'page-random',
    revision: 1 + integer(random, 20),
    url: `https://example.test/path/${seed}?query=${'x'.repeat(integer(random, 120))}`,
    ...(random() < 0.8 ? { title: `Random page ${seed} "title"` } : {}),
    ...(random() < 0.75
      ? { visibleText: `Visible ${seed}\n${'body-content '.repeat(10 + integer(random, 80))}` }
      : {}),
    ...(random() < 0.3
      ? {
          capturedOmissions: [
            { kind: 'entities', count: 1 + integer(random, 20), reason: 'scan_cap' },
          ],
        }
      : {}),
    entities,
    relations,
  };
};

const randomizedOptions = (
  snapshot: GraphSnapshot,
  seed: number,
): CompileViewOptions => {
  const random = randomSource(seed ^ 0x9e3779b9);
  const focused = new Set(
    snapshot.entities
      .filter(() => random() < 0.28)
      .map((entity) => entity.id),
  );
  return {
    budget: {
      maxCharacters: 512 + integer(random, 9_489),
      ...(random() < 0.45
        ? { maxEntities: integer(random, snapshot.entities.length + 1) }
        : {}),
    },
    ...(random() < 0.3 ? { entityIds: focused } : {}),
    ...(random() < 0.4
      ? {
          additionalOmissions: [
            { kind: 'content', count: 1 + integer(random, 50), reason: 'budget' },
          ],
        }
      : {}),
    includeEvidence: random() < 0.5,
  };
};

const outcome = (
  snapshot: GraphSnapshot,
  options: CompileViewOptions,
  strategy: 'linear-reference' | 'search',
): { kind: 'view'; serialized: string } | { kind: 'error'; name: string; message: string } => {
  try {
    return {
      kind: 'view',
      serialized: JSON.stringify(
        compileViewForTesting(snapshot, options, strategy).view,
      ),
    };
  } catch (error) {
    return {
      kind: 'error',
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

describe('compileView driver omission telemetry', () => {
  it('preserves scan-cap omissions and marks the representation truncated', () => {
    const snapshot: GraphSnapshot = {
      browserId: 'browser-1',
      pageId: 'page-1',
      revision: 1,
      url: 'https://example.test/grid',
      capturedOmissions: [
        { kind: 'entities', count: 7, reason: 'scan_cap' },
        { kind: 'relations', count: 4, reason: 'scan_cap' },
      ],
      entities: [],
      relations: [],
    };

    const view = compileView(snapshot);

    expect(view.structured.omissions).toEqual(snapshot.capturedOmissions);
    expect(view.truncated).toBe(true);
    expect(view.text).toContain('[7 entities omitted: scan_cap]');
  });

  it('marks a conservative scan-cap count as a lower bound in the model view', () => {
    const snapshot: GraphSnapshot = {
      browserId: 'browser-1',
      pageId: 'page-1',
      revision: 1,
      url: 'https://example.test/large-page',
      capturedOmissions: [
        { kind: 'entities', count: 1, reason: 'scan_cap', exact: false },
      ],
      entities: [],
      relations: [],
    };

    const view = compileView(snapshot);

    expect(view.structured.omissions).toEqual(snapshot.capturedOmissions);
    expect(view.text).toContain('[at least 1 entities omitted: scan_cap]');
  });
});

describe('compileView entity-budget search', () => {
  it('is byte-identical to the linear shrink oracle across randomized snapshots and budgets', () => {
    for (let seed = 1; seed <= 80; seed += 1) {
      const snapshot = randomizedSnapshot(seed);
      const options = randomizedOptions(snapshot, seed);
      const searched = outcome(snapshot, options, 'search');

      expect(searched, `seed ${seed}`).toEqual(
        outcome(snapshot, options, 'linear-reference'),
      );
      if (searched.kind === 'view') {
        const publicView = compileView(snapshot, options);
        expect(JSON.stringify(publicView), `public wrapper, seed ${seed}`).toBe(
          searched.serialized,
        );
        expect(
          JSON.stringify({
            text: publicView.text,
            structured: publicView.structured,
          }).length,
          `budget, seed ${seed}`,
        ).toBeLessThanOrEqual(options.budget!.maxCharacters!);
      }
    }
  });

  it('preserves deterministic entity and relation ordering', () => {
    const snapshot = randomizedSnapshot(4_242);
    const options: CompileViewOptions = {
      budget: { maxCharacters: 8_000 },
      includeEvidence: true,
    };
    const reversed: GraphSnapshot = {
      ...snapshot,
      entities: [...snapshot.entities].reverse(),
      relations: [...snapshot.relations].reverse(),
    };

    expect(JSON.stringify(compileView(snapshot, options))).toBe(
      JSON.stringify(compileView(reversed, options)),
    );
  });

  it('uses logarithmic structured rebuilds on an entity-heavy representation', () => {
    const base = randomizedSnapshot(9_001);
    const entities = Array.from({ length: 320 }, (_, index): Entity => ({
      ...base.entities[index % base.entities.length]!,
      id: `large-${index.toString().padStart(3, '0')}`,
      name: `Large entity ${index} ${'payload '.repeat(20)}`,
      pageId: base.pageId,
    }));
    const snapshot: GraphSnapshot = {
      ...base,
      visibleText: 'visible '.repeat(2_000),
      entities,
      relations: entities.slice(1).map((entity, index) => ({
        from: entities[index]!.id,
        to: entity.id,
        kind: 'contains',
      })),
    };
    const options: CompileViewOptions = {
      budget: { maxCharacters: 16_000 },
      includeEvidence: true,
    };

    const reference = compileViewForTesting(
      snapshot,
      options,
      'linear-reference',
    );
    const searched = compileViewForTesting(snapshot, options, 'search');

    expect(JSON.stringify(searched.view)).toBe(JSON.stringify(reference.view));
    expect(reference.structuredBuilds).toBeGreaterThan(200);
    expect(searched.structuredBuilds).toBeLessThanOrEqual(16);
    expect(searched.entityBudgetCandidates).toBeLessThanOrEqual(10);
  });
});
