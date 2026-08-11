import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

import { BrowserIRRuntime, type DriverObservation } from '@browserir/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPlaywrightBrowserDriver,
  TABLE_STRUCTURE_POLICY,
} from '../src/index.js';

let server: Server;
let origin: string;

const page = (body: string, script = ''): string => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Table structure laboratory</title>
    <style>
      body { font: 16px sans-serif; padding: 24px; }
      table { border-collapse: collapse; margin-bottom: 24px; }
      th, td, [role="columnheader"], [role="gridcell"] {
        border: 1px solid #999;
        min-width: 120px;
        padding: 6px;
      }
      [role="row"] { display: flex; }
      [role="grid"] { margin-bottom: 24px; }
      [hidden], .concealed { display: none !important; }
    </style>
  </head>
  <body>
    <main aria-label="Data workspace">
      ${body}
    </main>
    ${script}
  </body>
</html>`;

const structureFixture = (): string =>
  page(
    `<table id="customer-accounts">
      <caption>Customer accounts</caption>
      <thead>
        <tr>
          <th scope="col">Customer</th>
          <th scope="col">Account</th>
          <th scope="col">Action</th>
        </tr>
      </thead>
      <tbody>
        <tr data-record-id="customer-101">
          <td>Ada Lovelace</td>
          <td>AC-101</td>
          <td><button type="button">Open Ada account</button></td>
        </tr>
        <tr data-record-id="customer-decoy" hidden>
          <td>SECRET DECOY CUSTOMER</td>
          <td>AC-DECOY</td>
          <td><button type="button">Open decoy account</button></td>
        </tr>
      </tbody>
    </table>

    <div role="grid" aria-label="Inventory grid" aria-rowcount="2" aria-colcount="3">
      <div role="row" aria-rowindex="1">
        <div role="columnheader" aria-colindex="1">Stock number</div>
        <div role="columnheader" aria-colindex="2">Model</div>
        <div role="columnheader" aria-colindex="3">Action</div>
      </div>
      <div role="row" aria-rowindex="2" data-row-id="stock-77">
        <div role="gridcell" aria-colindex="1">ST-77</div>
        <div role="gridcell" aria-colindex="2">Roadster</div>
        <div role="gridcell" aria-colindex="3">
          <button type="button">Inspect stock 77</button>
        </div>
        <div role="gridcell" aria-colindex="4" class="concealed">SECRET GRID CELL</div>
      </div>
    </div>

    <div
      class="vehicle-records"
      role="grid"
      aria-label="Vehicle records"
      aria-rowcount="10000"
      aria-colcount="2"
    >
      <div role="row" aria-rowindex="501" data-record-id="vehicle-501">
        <div role="gridcell" aria-colindex="1" data-column-key="vehicle">Vehicle 501</div>
        <div role="gridcell" aria-colindex="2" data-column-key="status">Ready</div>
      </div>
      <div role="row" aria-rowindex="502">
        <div role="gridcell" aria-colindex="1" data-column-key="vehicle">Vehicle 502</div>
        <div role="gridcell" aria-colindex="2" data-column-key="status">Service</div>
      </div>
    </div>
    <button id="refresh-record" type="button">Refresh displayed record</button>
    <button id="recycle-record" type="button">Recycle displayed record</button>`,
    `<script>
      const firstVirtualRow = document.querySelector('.vehicle-records [role="row"]');
      const secondVirtualRow = document.querySelectorAll('.vehicle-records [role="row"]')[1];
      document.querySelector('#refresh-record').addEventListener('click', () => {
        if (!document.querySelector('#new-sibling-table')) {
          const sibling = document.createElement('table');
          sibling.id = 'new-sibling-table';
          sibling.innerHTML = '<caption>Recently inserted table</caption><tbody><tr><td>New data</td></tr></tbody>';
          document.querySelector('.vehicle-records').before(sibling);
        }
        firstVirtualRow.querySelector('[data-column-key="status"]').textContent = 'Reserved';
        secondVirtualRow.querySelector('[data-column-key="status"]').textContent = 'Service scheduled';
      });
      document.querySelector('#recycle-record').addEventListener('click', () => {
        firstVirtualRow.dataset.recordId = 'vehicle-9001';
        firstVirtualRow.setAttribute('aria-rowindex', '9001');
        firstVirtualRow.querySelector('[data-column-key="vehicle"]').textContent = 'Vehicle 9001';
        firstVirtualRow.querySelector('[data-column-key="status"]').textContent = 'Sold';
      });
    </script>`,
  );

const cappedFixture = (): string =>
  page(`<div role="grid" aria-label="Bounded result set">
    ${Array.from(
      { length: TABLE_STRUCTURE_POLICY.maxRows + 3 },
      (_, index) => `<div role="row" aria-rowindex="${index + 1}">
        <div role="gridcell" aria-colindex="1">Record ${index + 1}</div>
      </div>`,
    ).join('')}
  </div>`);

const scanCappedFixture = (): string =>
  page(`${'<div></div>'.repeat(TABLE_STRUCTURE_POLICY.maxScannedElements)}
    <div role="grid" aria-label="Outside the bounded scan">
      <div role="row"><div role="gridcell">Unseen record</div></div>
    </div>`);

beforeAll(async () => {
  server = createServer((request, response) => {
    const content =
      request.url === '/structure'
        ? structureFixture()
        : request.url === '/capped'
          ? cappedFixture()
          : request.url === '/scan-capped'
            ? scanCappedFixture()
          : undefined;
    if (content === undefined) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(content);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Table fixture server did not bind a TCP port.');
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

const entity = (
  observation: DriverObservation,
  predicate: (candidate: DriverObservation['entities'][number]) => boolean,
) => {
  const match = observation.entities.find(predicate);
  if (!match) throw new Error('Expected structural entity was not observed.');
  return match;
};

const hasRelation = (
  observation: DriverObservation,
  fromSourceId: string,
  kind: string,
  toSourceId: string,
): boolean =>
  observation.relations?.some(
    (relation) =>
      relation.fromSourceId === fromSourceId &&
      relation.kind === kind &&
      relation.toSourceId === toSourceId,
  ) ?? false;

describe('technology-neutral table and grid representation', () => {
  it('normalizes native tables and ARIA grids without losing nested actions', async () => {
    const session = await createPlaywrightBrowserDriver().createSession();
    try {
      const observation = await session.navigate({
        pageId: session.initialPageId,
        url: `${origin}/structure`,
      });

      const nativeTable = entity(
        observation,
        (candidate) => candidate.kind === 'table' && candidate.name === 'Customer accounts',
      );
      const nativeRow = entity(
        observation,
        (candidate) => candidate.kind === 'row' && candidate.text?.includes('Ada Lovelace') === true,
      );
      const nameCell = entity(
        observation,
        (candidate) => candidate.kind === 'cell' && candidate.text === 'Ada Lovelace',
      );
      const nestedAction = entity(
        observation,
        (candidate) => candidate.name === 'Open Ada account',
      );
      const ariaGrid = entity(
        observation,
        (candidate) => candidate.kind === 'table' && candidate.name === 'Inventory grid',
      );
      const ariaRow = entity(
        observation,
        (candidate) => candidate.kind === 'row' && candidate.text?.includes('ST-77') === true,
      );
      const ariaCell = entity(
        observation,
        (candidate) => candidate.kind === 'cell' && candidate.text === 'ST-77',
      );
      const ariaAction = entity(
        observation,
        (candidate) => candidate.name === 'Inspect stock 77',
      );

      expect.soft(nativeTable.role).toBe('table');
      expect.soft(ariaGrid.role).toBe('grid');
      expect.soft(hasRelation(observation, nativeTable.sourceId, 'contains', nativeRow.sourceId)).toBe(true);
      expect.soft(hasRelation(observation, nativeRow.sourceId, 'row-of', nativeTable.sourceId)).toBe(true);
      expect.soft(hasRelation(observation, nativeRow.sourceId, 'contains', nameCell.sourceId)).toBe(true);
      expect.soft(hasRelation(observation, nameCell.sourceId, 'cell-of', nativeRow.sourceId)).toBe(true);
      expect.soft(hasRelation(observation, nameCell.sourceId, 'contains', nestedAction.sourceId)).toBe(false);

      const actionCell = entity(
        observation,
        (candidate) => candidate.kind === 'cell' && candidate.text === 'Open Ada account',
      );
      expect.soft(hasRelation(observation, actionCell.sourceId, 'contains', nestedAction.sourceId)).toBe(true);
      expect.soft(hasRelation(observation, ariaGrid.sourceId, 'contains', ariaRow.sourceId)).toBe(true);
      expect.soft(hasRelation(observation, ariaRow.sourceId, 'contains', ariaCell.sourceId)).toBe(true);
      const ariaActionCell = entity(
        observation,
        (candidate) => candidate.kind === 'cell' && candidate.text === 'Inspect stock 77',
      );
      expect.soft(hasRelation(observation, ariaActionCell.sourceId, 'contains', ariaAction.sourceId)).toBe(true);
      expect.soft(
        observation.entities.some((candidate) => candidate.text?.includes('SECRET') === true),
      ).toBe(false);

      const virtualGrid = entity(
        observation,
        (candidate) => candidate.kind === 'table' && candidate.name === 'Vehicle records',
      );
      const virtualRow = entity(
        observation,
        (candidate) => candidate.kind === 'row' && candidate.text?.includes('Vehicle 501') === true,
      );
      expect.soft(virtualGrid.value).toEqual({ rowCount: 10000, columnCount: 2 });
      expect.soft(virtualRow.value).toEqual({ rowIndex: 501 });
    } finally {
      await session.close();
    }
  });

  it('keeps explicit record identity across value rerenders and replaces it for a recycled record', async () => {
    const runtime = new BrowserIRRuntime(createPlaywrightBrowserDriver());
    const created = await runtime.create();
    try {
      const initial = await runtime.navigate({
        browserId: created.browserId,
        expectedRevision: 0,
        url: `${origin}/structure`,
        budget: { maxCharacters: 50_000 },
      });
      const initialRow = initial.view.structured.entities.find(
        (candidate) => candidate.kind === 'row' && candidate.text?.includes('Vehicle 501') === true,
      );
      const refresh = initial.view.structured.entities.find(
        (candidate) => candidate.name === 'Refresh displayed record',
      );
      const initialIndexedRow = initial.view.structured.entities.find(
        (candidate) => candidate.kind === 'row' && candidate.text?.includes('Vehicle 502') === true,
      );
      const initialCell = initial.view.structured.entities.find(
        (candidate) => candidate.kind === 'cell' && candidate.text === 'Vehicle 501',
      );
      if (!initialRow || !initialIndexedRow || !initialCell || !refresh) {
        throw new Error('Missing initial virtual-grid entities.');
      }

      const refreshedReceipt = await runtime.act({
        browserId: created.browserId,
        expectedRevision: initial.view.revision,
        action: { kind: 'click', target: refresh.ref },
        budget: { maxCharacters: 50_000 },
      });
      const refreshed =
        refreshedReceipt.observation ??
        (await runtime.observe({ browserId: created.browserId, budget: { maxCharacters: 50_000 } }));
      const refreshedRow = refreshed.view.structured.entities.find(
        (candidate) => candidate.kind === 'row' && candidate.text?.includes('Vehicle 501') === true,
      );
      const recycle = refreshed.view.structured.entities.find(
        (candidate) => candidate.name === 'Recycle displayed record',
      );
      const refreshedIndexedRow = refreshed.view.structured.entities.find(
        (candidate) => candidate.kind === 'row' && candidate.text?.includes('Vehicle 502') === true,
      );
      const refreshedCell = refreshed.view.structured.entities.find(
        (candidate) => candidate.kind === 'cell' && candidate.text === 'Vehicle 501',
      );
      if (!refreshedRow || !refreshedIndexedRow || !refreshedCell || !recycle) {
        throw new Error('Missing refreshed virtual-grid entities.');
      }

      expect.soft(refreshedRow.text).toContain('Reserved');
      expect.soft(refreshedRow.ref.entityId).toBe(initialRow.ref.entityId);
      expect.soft(refreshedCell.ref.entityId).toBe(initialCell.ref.entityId);
      expect.soft(refreshedIndexedRow.text).toContain('Service scheduled');
      expect.soft(refreshedIndexedRow.ref.entityId).toBe(
        initialIndexedRow.ref.entityId,
      );

      const recycledReceipt = await runtime.act({
        browserId: created.browserId,
        expectedRevision: refreshed.view.revision,
        action: { kind: 'click', target: recycle.ref },
        budget: { maxCharacters: 50_000 },
      });
      const recycled =
        recycledReceipt.observation ??
        (await runtime.observe({ browserId: created.browserId, budget: { maxCharacters: 50_000 } }));
      const recycledRow = recycled.view.structured.entities.find(
        (candidate) => candidate.kind === 'row' && candidate.text?.includes('Vehicle 9001') === true,
      );
      const recycledCell = recycled.view.structured.entities.find(
        (candidate) => candidate.kind === 'cell' && candidate.text === 'Vehicle 9001',
      );
      if (!recycledRow || !recycledCell) {
        throw new Error('Missing recycled virtual-grid row.');
      }

      expect.soft(recycledRow.value).toEqual({ rowIndex: 9001 });
      expect.soft(recycledRow.ref.entityId).not.toBe(initialRow.ref.entityId);
      expect.soft(recycledCell.ref.entityId).not.toBe(initialCell.ref.entityId);
      expect.soft(recycled.delta.removed).toContain(initialRow.ref.entityId);
      expect.soft(recycled.delta.added.map((candidate) => candidate.id)).toContain(
        recycledRow.ref.entityId,
      );

      const staleRecycledTarget = await runtime.act({
        browserId: created.browserId,
        expectedRevision: recycled.view.revision,
        action: { kind: 'click', target: initialCell.ref },
        budget: { maxCharacters: 50_000 },
      });
      expect.soft(staleRecycledTarget.status).toBe('stale_target');
      expect.soft(staleRecycledTarget.dispatched).toBe(false);
    } finally {
      await runtime.close({ browserId: created.browserId });
    }
  });

  it('reports scan-cap omissions through the compiled BrowserIR view', async () => {
    const runtime = new BrowserIRRuntime(createPlaywrightBrowserDriver());
    const created = await runtime.create();
    try {
      const observation = await runtime.navigate({
        browserId: created.browserId,
        expectedRevision: 0,
        url: `${origin}/capped`,
        budget: { maxCharacters: 100_000 },
      });
      const omission = observation.view.structured.omissions.find(
        (candidate) => candidate.kind === 'entities' && candidate.reason === 'scan_cap',
      );
      const relationOmission = observation.view.structured.omissions.find(
        (candidate) => candidate.kind === 'relations' && candidate.reason === 'scan_cap',
      );

      expect.soft(omission?.count).toBeGreaterThanOrEqual(3);
      expect.soft(relationOmission?.count).toBeGreaterThanOrEqual(6);
      expect.soft(observation.view.truncated).toBe(true);
      expect.soft(observation.view.text).toMatch(/entities omitted: scan_cap/);
    } finally {
      await runtime.close({ browserId: created.browserId });
    }
  });

  it('marks structural scan-boundary omissions as lower bounds', async () => {
    const runtime = new BrowserIRRuntime(createPlaywrightBrowserDriver());
    const created = await runtime.create();
    try {
      const observation = await runtime.navigate({
        browserId: created.browserId,
        expectedRevision: 0,
        url: `${origin}/scan-capped`,
        budget: { maxCharacters: 100_000 },
      });
      const entityOmission = observation.view.structured.omissions.find(
        (candidate) =>
          candidate.kind === 'entities' &&
          candidate.reason === 'scan_cap' &&
          candidate.exact === false,
      );
      const relationOmission = observation.view.structured.omissions.find(
        (candidate) =>
          candidate.kind === 'relations' &&
          candidate.reason === 'scan_cap' &&
          candidate.exact === false,
      );

      expect.soft(entityOmission?.count).toBeGreaterThanOrEqual(1);
      expect.soft(relationOmission?.count).toBeGreaterThanOrEqual(1);
      expect.soft(observation.view.text).toContain(
        '[at least 1 entities omitted: scan_cap]',
      );
    } finally {
      await runtime.close({ browserId: created.browserId });
    }
  });
});
