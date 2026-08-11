import { describe, expect, it } from 'vitest';

import {
  aggregateTaskOutcomes,
  measureIdentityStability,
  measureOmissionAccounting,
  measurePayload,
  measureRepresentation,
} from '../src/metrics.js';

describe('representation quality metrics', () => {
  it('measures entity, capability, relation, and abstention quality as sets', () => {
    const result = measureRepresentation(
      {
        entities: ['customer', 'save'],
        capabilities: [
          { entity: 'customer', capability: 'fill' },
          { entity: 'save', capability: 'click' },
        ],
        relations: [
          { from: 'customer-label', kind: 'labels', to: 'customer' },
          { from: 'dialog', kind: 'contains', to: 'save' },
        ],
        abstentions: ['ambiguous-delete', 'hidden-control'],
      },
      {
        entities: ['save', 'cancel', 'cancel'],
        capabilities: [
          { entity: 'save', capability: 'click' },
          { entity: 'cancel', capability: 'click' },
        ],
        relations: [
          { from: 'dialog', kind: 'contains', to: 'save' },
          { from: 'dialog', kind: 'contains', to: 'cancel' },
        ],
        abstentions: ['hidden-control', 'invented-case'],
      },
    );

    expect(result.entities).toEqual({
      expected: 2,
      observed: 2,
      truePositive: 1,
      falsePositive: 1,
      falseNegative: 1,
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
    });
    expect(result.capabilities).toMatchObject({
      truePositive: 1,
      falsePositive: 1,
      falseNegative: 1,
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
    });
    expect(result.relations).toMatchObject({
      truePositive: 1,
      falsePositive: 1,
      falseNegative: 1,
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
    });
    expect(result.correctAbstention).toEqual({
      expected: 2,
      observed: 2,
      correct: 1,
      unexpected: 1,
      missed: 1,
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
      rate: 0.5,
    });
  });

  it('treats an exactly empty contract as a perfect match', () => {
    const result = measureRepresentation(
      { entities: [], capabilities: [], relations: [] },
      { entities: [], capabilities: [], relations: [] },
    );

    expect(result.entities).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(result.capabilities).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(result.relations).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(result.correctAbstention).toMatchObject({
      precision: 1,
      recall: 1,
      f1: 1,
      rate: 1,
    });
  });

  it('counts changed and missing identities as unstable', () => {
    expect(
      measureIdentityStability(
        [
          { logicalKey: 'customer:1', entityId: 'e1' },
          { logicalKey: 'customer:2', entityId: 'e2' },
          { logicalKey: 'customer:3', entityId: 'e3' },
        ],
        [
          { logicalKey: 'customer:1', entityId: 'e1' },
          { logicalKey: 'customer:2', entityId: 'new-e2' },
          { logicalKey: 'customer:4', entityId: 'e4' },
        ],
      ),
    ).toEqual({
      baseline: 3,
      observed: 3,
      comparable: 2,
      stable: 1,
      changed: 1,
      missing: 1,
      added: 1,
      rate: 1 / 3,
    });
  });

  it('accounts for under- and over-reported omissions by category', () => {
    expect(
      measureOmissionAccounting(
        [
          { category: 'entities', count: 3 },
          { category: 'content', count: 4 },
        ],
        [
          { category: 'relations', count: 1 },
          { category: 'content', count: 4 },
          { category: 'entities', count: 2 },
        ],
      ),
    ).toEqual({
      known: 7,
      reported: 7,
      accounted: 6,
      unreported: 1,
      overreported: 1,
      precision: 6 / 7,
      recall: 6 / 7,
      f1: 6 / 7,
      exact: false,
      categories: [
        {
          category: 'content',
          known: 4,
          reported: 4,
          accounted: 4,
          unreported: 0,
          overreported: 0,
        },
        {
          category: 'entities',
          known: 3,
          reported: 2,
          accounted: 2,
          unreported: 1,
          overreported: 0,
        },
        {
          category: 'relations',
          known: 0,
          reported: 1,
          accounted: 0,
          unreported: 0,
          overreported: 1,
        },
      ],
    });
  });

  it('reports Unicode characters, UTF-8 bytes, and an explicitly approximate token count', () => {
    expect(measurePayload('A😀é')).toEqual({
      characters: 3,
      characterCountMethod: 'unicode-code-points',
      utf8Bytes: 7,
      estimatedTokens: 1,
      tokenEstimateMethod: 'ceil(unicode-code-points/4)',
      charactersPerEstimatedToken: 4,
    });
  });
});

describe('task outcome aggregation', () => {
  it('excludes not-applicable tasks from the pass-rate denominator', () => {
    expect(
      aggregateTaskOutcomes([
        { taskId: 'pass-1', outcome: 'passed' },
        { taskId: 'skip-1', outcome: 'not_applicable' },
        { taskId: 'fail-1', outcome: 'failed' },
        { taskId: 'pass-2', outcome: 'passed' },
        { taskId: 'skip-2', outcome: 'not_applicable' },
      ]),
    ).toEqual({
      total: 5,
      applicable: 3,
      passed: 2,
      failed: 1,
      notApplicable: 2,
      passRate: 2 / 3,
    });
  });

  it('does not claim a pass rate when every task is not applicable', () => {
    expect(
      aggregateTaskOutcomes([
        { taskId: 'skip', outcome: 'not_applicable' },
      ]).passRate,
    ).toBeNull();
  });
});
