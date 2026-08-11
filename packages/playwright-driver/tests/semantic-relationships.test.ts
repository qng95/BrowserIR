import { once } from 'node:events';
import { createServer, type Server } from 'node:http';

import { BrowserIRRuntime, type Entity, type Relation } from '@browserir/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPlaywrightBrowserDriver,
  SEMANTIC_RELATIONSHIP_POLICY,
} from '../src/index.js';

let server: Server;
let origin: string;

const page = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Semantic relationship fixture</title>
    <style>
      body { font: 16px sans-serif; margin: 24px; }
      section, .exact-case { margin: 0 0 28px; }
      .exact-case { display: grid; grid-template-columns: 190px 280px; align-items: center; }
      .parallel { position: relative; width: 520px; height: 98px; }
      .label-tree, .control-tree { position: absolute; top: 0; }
      .label-tree { left: 0; width: 180px; }
      .control-tree { left: 220px; width: 280px; }
      .label-row, .control-row { display: block; box-sizing: border-box; height: 44px; padding: 8px 0; }
      .control-row { width: 260px; }
      .single-row { height: 48px; }
      .ambiguous { position: relative; width: 520px; height: 52px; }
      .ambiguous .candidate { position: absolute; left: 0; top: 8px; width: 180px; }
      .ambiguous input { position: absolute; left: 220px; top: 0; width: 260px; height: 36px; }
      .cross-frame { display: grid; grid-template-columns: 190px 300px; align-items: start; }
      iframe { width: 290px; height: 72px; border: 0; }
    </style>
  </head>
  <body>
    <main aria-label="Relationship laboratory">
      <div class="exact-case">
        <div id="exact-label-branch">
          <label for="exact-account-email">Account email</label>
        </div>
        <div id="exact-control-branch">
          <input id="exact-account-email" type="email" value="exact@example.test">
        </div>
      </div>

      <section aria-label="Contact details">
        <div class="parallel">
          <div class="label-tree">
            <span class="label-row">Email address</span>
            <span class="label-row">Phone number</span>
            <span class="label-row" hidden>Email address</span>
            <span class="label-row" aria-hidden="true">Phone number</span>
          </div>
          <div class="control-tree">
            <input class="control-row" type="email" value="parallel@example.test">
            <input class="control-row" type="tel" value="+49 30 5550102">
          </div>
        </div>
      </section>

      <section aria-label="Billing details">
        <div class="parallel single-row">
          <div class="label-tree"><span class="label-row">Name</span></div>
          <div class="control-tree">
            <input class="control-row" type="text" value="billing-seed">
          </div>
        </div>
      </section>

      <section aria-label="Shipping details">
        <div class="parallel single-row">
          <div class="label-tree"><span class="label-row">Name</span></div>
          <div class="control-tree">
            <input class="control-row" type="text" value="shipping-seed">
          </div>
        </div>
      </section>

      <section aria-label="Ambiguous details">
        <div class="ambiguous">
          <span class="candidate">Reference</span>
          <span class="candidate">Reference</span>
          <input type="text" value="ambiguous-seed">
        </div>
      </section>

      <section aria-label="Embedded details" class="cross-frame">
        <span>External code</span>
        <iframe title="External editor" src="/relationship-frame"></iframe>
      </section>
    </main>
  </body>
</html>`;

beforeAll(async () => {
  server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (request.url === '/relationship-frame') {
      response.end(`<!doctype html>
        <html>
          <head><title>External editor</title></head>
          <body><input type="text" value="frame-seed"></body>
        </html>`);
      return;
    }
    response.end(page);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('relationship fixture did not bind a TCP port');
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.close();
  await once(server, 'close');
});

const entityByValue = (entities: readonly Entity[], value: string): Entity => {
  const matches = entities.filter((entity) => entity.value === value);
  if (matches.length !== 1) {
    throw new Error(`Expected one entity with value ${JSON.stringify(value)}, received ${matches.length}`);
  }
  return matches[0]!;
};

const incomingLabels = (
  entities: readonly Entity[],
  relations: readonly Relation[],
  control: Entity,
): Array<{ label: Entity; relation: Relation }> =>
  relations
    .filter((relation) => relation.kind === 'labels' && relation.to === control.id)
    .map((relation) => {
      const label = entities.find((entity) => entity.id === relation.from);
      if (!label) throw new Error(`Missing label entity ${relation.from}`);
      return { label, relation };
    });

describe('deterministic semantic label relationships', () => {
  it('accepts exact and high-confidence global matches while abstaining from ambiguity and frame crossing', async () => {
    expect(SEMANTIC_RELATIONSHIP_POLICY.acceptanceThreshold).toBeGreaterThanOrEqual(0.8);
    expect(SEMANTIC_RELATIONSHIP_POLICY.ambiguityMargin).toBeGreaterThanOrEqual(0.1);
    const runtime = new BrowserIRRuntime(createPlaywrightBrowserDriver());
    const created = await runtime.create();
    try {
      const observed = await runtime.navigate({
        browserId: created.browserId,
        expectedRevision: 0,
        url: origin,
        budget: { maxCharacters: 30_000 },
      });
      const { entities, relations } = observed.snapshot;
      const expected = new Map<string, string>([
        ['exact@example.test', 'Account email'],
        ['parallel@example.test', 'Email address'],
        ['+49 30 5550102', 'Phone number'],
        ['billing-seed', 'Name'],
        ['shipping-seed', 'Name'],
      ]);

      const accepted: Array<{
        value: string;
        label: string;
        confidence: number;
      }> = [];
      for (const [value, expectedLabel] of expected) {
        const control = entityByValue(entities, value);
        expect.soft(control.name, value).toBe(expectedLabel);
        const labels = incomingLabels(entities, relations, control);
        expect.soft(labels, value).toHaveLength(1);
        const matched = labels[0];
        if (!matched) continue;
        expect.soft(matched.label, value).toMatchObject({
          kind: 'text',
          role: 'label',
          text: expectedLabel,
          capabilities: [],
        });
        expect.soft(matched.relation.confidence, value).toBeGreaterThanOrEqual(
          value === 'exact@example.test'
            ? 1
            : SEMANTIC_RELATIONSHIP_POLICY.acceptanceThreshold,
        );
        expect.soft(matched.relation.evidence?.length, value).toBeGreaterThan(0);
        accepted.push({
          value,
          label: matched.label.text ?? '',
          confidence: matched.relation.confidence ?? 0,
        });
      }

      expect(accepted).toEqual(
        [...expected].map(([value, label]) => ({
          value,
          label,
          confidence: expect.any(Number),
        })),
      );
      expect(
        accepted.every(({ value, label }) => expected.get(value) === label),
      ).toBe(true);

      const exactControl = entityByValue(entities, 'exact@example.test');
      const exactRelation = incomingLabels(entities, relations, exactControl)[0]!.relation;
      expect(exactRelation).toMatchObject({
        confidence: 1,
        evidence: [
          expect.objectContaining({
            sensor: 'playwright-dom-relationship',
            detail: 'native-label',
            confidence: 1,
          }),
        ],
      });

      for (const value of [
        'parallel@example.test',
        '+49 30 5550102',
        'billing-seed',
        'shipping-seed',
      ]) {
        const control = entityByValue(entities, value);
        const relation = incomingLabels(entities, relations, control)[0]!.relation;
        expect.soft(relation.confidence, value).toBeLessThan(1);
        expect.soft(
          relation.evidence?.map((evidence) => evidence.detail),
          value,
        ).toContain('spatial-row-alignment');
      }

      for (const value of ['ambiguous-seed', 'frame-seed']) {
        const control = entityByValue(entities, value);
        expect.soft(control.name, value).toBeUndefined();
        expect.soft(incomingLabels(entities, relations, control), value).toEqual([]);
      }

      const labelEntities = entities.filter(
        (entity) => entity.kind === 'text' && entity.role === 'label',
      );
      expect(labelEntities).toHaveLength(expected.size);
      expect(labelEntities.map((entity) => entity.text)).not.toContain('External code');

      const compactLabelRelations = observed.view.structured.relations.filter(
        (relation) => relation.kind === 'labels',
      );
      expect(compactLabelRelations).toHaveLength(expected.size);
      expect(compactLabelRelations.every((relation) => !('evidence' in relation))).toBe(true);

      const evidenceView = await runtime.inspect({
        browserId: created.browserId,
        pageId: observed.snapshot.pageId,
        includeEvidence: true,
        budget: { maxCharacters: 30_000 },
      });
      const inspectedLabelRelations = evidenceView.structured.relations.filter(
        (relation) => relation.kind === 'labels',
      );
      expect(inspectedLabelRelations).toHaveLength(expected.size);
      expect(
        inspectedLabelRelations.every(
          (relation) =>
            relation.evidence !== undefined && relation.evidence.length > 0,
        ),
      ).toBe(true);
      expect(
        inspectedLabelRelations.some((relation) =>
          relation.evidence?.some((evidence) => evidence.detail === 'native-label'),
        ),
      ).toBe(true);
      expect(
        inspectedLabelRelations.some((relation) =>
          relation.evidence?.some(
            (evidence) => evidence.detail === 'spatial-row-alignment',
          ),
        ),
      ).toBe(true);
    } finally {
      await runtime.close({ browserId: created.browserId });
    }
  });
});
