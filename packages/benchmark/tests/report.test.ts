import { describe, expect, it } from 'vitest';

import {
  createEvaluationReport,
  renderEvaluationJson,
  renderEvaluationMarkdown,
  renderEvaluationNdjson,
  renderEvaluationJUnit,
} from '../src/report.js';
import {
  measureIdentityStability,
  measureOmissionAccounting,
  measurePayload,
  measureRepresentation,
} from '../src/metrics.js';

const representation = {
  ...measureRepresentation(
    {
      entities: ['email', 'submit'],
      capabilities: [
        { entity: 'email', capability: 'fill' },
        { entity: 'submit', capability: 'click' },
      ],
      relations: [{ from: 'email-label', kind: 'labels', to: 'email' }],
      abstentions: ['ambiguous'],
    },
    {
      entities: ['email', 'submit'],
      capabilities: [
        { entity: 'email', capability: 'fill' },
        { entity: 'submit', capability: 'click' },
      ],
      relations: [{ from: 'email-label', kind: 'labels', to: 'email' }],
      abstentions: ['ambiguous'],
    },
  ),
  identityStability: measureIdentityStability(
    [{ logicalKey: 'email', entityId: 'e1' }],
    [{ logicalKey: 'email', entityId: 'e1' }],
  ),
  omissionAccounting: measureOmissionAccounting([], []),
};

const makeReport = (metadata: Readonly<Record<string, unknown>>) =>
  createEvaluationReport({
    runId: 'release-candidate-1',
    environmentFingerprint: 'abc123',
    metadata,
    tasks: [
      { taskId: 'z-skipped', outcome: 'not_applicable', reason: 'No upload input.' },
      { taskId: 'a-pass', outcome: 'passed' },
      {
        taskId: 'b-&-failure',
        outcome: 'failed',
        reason: 'Expected <saved> & audited.',
      },
      { taskId: 'y-skipped', outcome: 'not_applicable' },
      { taskId: 'c-pass', outcome: 'passed' },
    ],
    representation,
    payload: measurePayload('{"entities":[]}'),
  });

describe('deterministic benchmark reports', () => {
  it('emits stable JSON independent of metadata insertion order', () => {
    const left = makeReport({ z: 1, nested: { b: 2, a: 1 }, a: 2 });
    const right = makeReport({ a: 2, nested: { a: 1, b: 2 }, z: 1 });

    expect(renderEvaluationJson(left)).toBe(renderEvaluationJson(right));
    expect(renderEvaluationJson(left).endsWith('\n')).toBe(true);
    expect(JSON.parse(renderEvaluationJson(left))).toMatchObject({
      schemaVersion: '1.1.0',
      runId: 'release-candidate-1',
      taskSummary: {
        total: 5,
        applicable: 3,
        passed: 2,
        failed: 1,
        notApplicable: 2,
        passRate: 2 / 3,
      },
    });
  });

  it('emits one parseable NDJSON record per header, task, and summary', () => {
    const records = renderEvaluationNdjson(makeReport({ suite: 'fixture' }))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; taskId?: string });

    expect(records).toHaveLength(7);
    expect(records[0]).toMatchObject({ kind: 'run', runId: 'release-candidate-1' });
    expect(records.slice(1, -1).map((record) => record.taskId)).toEqual([
      'a-pass',
      'b-&-failure',
      'c-pass',
      'y-skipped',
      'z-skipped',
    ]);
    expect(records.at(-1)).toMatchObject({
      kind: 'summary',
      taskSummary: { applicable: 3, passed: 2, notApplicable: 2 },
    });
  });

  it('renders a compact Markdown quality report', () => {
    const markdown = renderEvaluationMarkdown(makeReport({ suite: 'fixture' }));

    expect(markdown).toContain('# BrowserIR benchmark report');
    expect(markdown).toContain('2 / 3 (66.67%)');
    expect(markdown).toContain('Not applicable | 2');
    expect(markdown).toContain('| Entities | 100.00% | 100.00% | 100.00% |');
    expect(markdown).toContain('UTF-8 bytes');
    expect(markdown).toContain('Token estimate');
  });

  it('renders failures and not-applicable tasks using JUnit semantics', () => {
    const junit = renderEvaluationJUnit(makeReport({ suite: 'fixture' }));

    expect(junit).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(junit).toContain('tests="5" failures="1" skipped="2"');
    expect(junit).toContain('name="b-&amp;-failure"');
    expect(junit).toContain(
      '<failure message="Expected &lt;saved&gt; &amp; audited.">',
    );
    expect(junit).toContain('<skipped message="No upload input."/>');
  });

  it('rejects duplicate task identifiers before emitting misleading reports', () => {
    expect(() =>
      createEvaluationReport({
        runId: 'duplicate',
        tasks: [
          { taskId: 'same', outcome: 'passed' },
          { taskId: 'same', outcome: 'failed' },
        ],
      }),
    ).toThrow(/duplicate task id/i);
  });
});
