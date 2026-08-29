import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  INVENTORY_BROWSERIR_V3_CASE_IDS,
  expectedInventoryBrowserIrV3Target,
  inventoryBrowserIrV3Cases,
  inventoryBrowserIrV3Page,
  type InventoryBrowserIrV3Binding,
  type InventoryBrowserIrV3CaseId,
  type InventoryBrowserIrV3WorldId,
} from '../src/inventory-browserir-v3.js';
import { createDb } from '../src/db.js';
import type { PageCtx } from '../src/pages.js';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

const htmlFor = (binding: InventoryBrowserIrV3Binding): string => {
  const db = createDb({ customers: 1, vehicles: 1 });
  const contract = inventoryBrowserIrV3Cases[binding.caseId];
  const url = new URL(`http://fixture.invalid${contract.path}`);
  const ctx: PageCtx = {
    db,
    path: url.pathname,
    url,
    user: { username: 'test', display_name: 'Test User' },
  };
  try {
    return inventoryBrowserIrV3Page(ctx, binding);
  } finally {
    db.close();
  }
};

const render = async (
  caseId: InventoryBrowserIrV3CaseId,
  worldId: InventoryBrowserIrV3WorldId,
): Promise<void> => {
  await page.setContent(htmlFor({ caseId, worldId }), { waitUntil: 'load' });
  await page.locator('#inventory-browserir-v3').waitFor();
};

const observation = async (
  caseId: InventoryBrowserIrV3CaseId,
  worldId: InventoryBrowserIrV3WorldId,
): Promise<{ text: string; aria: string; sourceOrder: string[] }> => {
  await render(caseId, worldId);
  const root = page.locator('#inventory-browserir-v3');
  return {
    text: (await root.innerText()).replace(/\s+/gu, ' ').trim(),
    aria: await root.ariaSnapshot(),
    sourceOrder: await root.locator('.inventory-v3-control').evaluateAll((nodes) =>
      nodes.map((node) => node.id)),
  };
};

const uniqueTargetAt = async (
  first: Locator,
  second: Locator,
  targetIds: readonly string[],
): Promise<string> => {
  const firstBox = await first.boundingBox();
  const secondBox = await second.boundingBox();
  if (firstBox === null || secondBox === null) throw new Error('Expected visible coordinate labels.');
  const matches: string[] = [];
  for (const targetId of targetIds) {
    const box = await page.locator(`#inventory-v3-control-${targetId}`).boundingBox();
    if (box === null) throw new Error(`Expected visible target ${targetId}.`);
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    if (
      centerY >= firstBox.y && centerY < firstBox.y + firstBox.height &&
      centerX >= secondBox.x && centerX < secondBox.x + secondBox.width
    ) matches.push(targetId);
  }
  expect(matches).toHaveLength(1);
  return matches[0]!;
};

const uniqueTargetAlignedWith = async (
  label: Locator,
  targetIds: readonly string[],
): Promise<string> => {
  const labelBox = await label.boundingBox();
  if (labelBox === null) throw new Error('Expected visible relationship label.');
  const matches: string[] = [];
  for (const targetId of targetIds) {
    const box = await page.locator(`#inventory-v3-control-${targetId}`).boundingBox();
    if (box === null) throw new Error(`Expected visible target ${targetId}.`);
    if (box.y >= labelBox.y && box.y + box.height <= labelBox.y + labelBox.height) {
      matches.push(targetId);
    }
  }
  expect(matches).toHaveLength(1);
  return matches[0]!;
};

describe('Inventory BrowserIR v3 browser representation', () => {
  it('keeps every opaque p0/p1 pair identical in visible text, AX, and action source order', async () => {
    for (const caseId of INVENTORY_BROWSERIR_V3_CASE_IDS) {
      const p0 = await observation(caseId, 'opaque-p0');
      const p1 = await observation(caseId, 'opaque-p1');
      const expectedSourceOrder = inventoryBrowserIrV3Cases[caseId].targetIds
        .map((targetId) => `inventory-v3-control-${targetId}`);
      expect(p0.text).toBe(p1.text);
      expect(p0.aria).toBe(p1.aria);
      expect(p0.sourceOrder).toEqual(expectedSourceOrder);
      expect(p1.sourceOrder).toEqual(expectedSourceOrder);
      expect(await page.getByRole('button', {
        name: inventoryBrowserIrV3Cases[caseId].actionName,
        exact: true,
      }).count()).toBe(inventoryBrowserIrV3Cases[caseId].targetIds.length);
    }
  });

  it('flips the warehouse × SKU target using geometry while actions remain cross-tree', async () => {
    const caseId = 'grid/warehouse-sku-stock-matrix' as const;
    const contract = inventoryBrowserIrV3Cases[caseId];
    for (const worldId of ['opaque-p0', 'opaque-p1'] as const) {
      await render(caseId, worldId);
      const target = await uniqueTargetAt(
        page.getByRole('rowheader', { name: 'Berlin warehouse', exact: true }),
        page.getByRole('columnheader', { name: 'SKU INV-104', exact: true }),
        contract.targetIds,
      );
      expect(target).toBe(expectedInventoryBrowserIrV3Target(caseId, worldId));
      expect(await page.getByRole('grid', { name: 'Warehouse stock matrix' }).count()).toBe(1);
      for (const targetId of contract.targetIds) {
        expect(await page.locator(`#inventory-v3-control-${targetId}`).locator(
          'xpath=ancestor::*[@role="grid" or @role="row" or @role="gridcell"][1]',
        ).count()).toBe(0);
      }
    }
    expect(expectedInventoryBrowserIrV3Target(caseId, 'opaque-p0')).not.toBe(
      expectedInventoryBrowserIrV3Target(caseId, 'opaque-p1'),
    );
  });

  it('keeps the already-open receiving dialog modal while the schedule target flips', async () => {
    const caseId = 'schedule/receiving-slot-dialog' as const;
    const contract = inventoryBrowserIrV3Cases[caseId];
    for (const worldId of ['opaque-p0', 'opaque-p1'] as const) {
      await render(caseId, worldId);
      const dialog = page.getByRole('dialog', { name: 'Reserve receiving slot' });
      expect(await dialog.count()).toBe(1);
      expect(await dialog.getAttribute('aria-modal')).toBe('true');
      expect(await uniqueTargetAt(
        page.getByRole('rowheader', { name: 'Dock C', exact: true }),
        page.getByRole('columnheader', { name: '14:30', exact: true }),
        contract.targetIds,
      )).toBe(expectedInventoryBrowserIrV3Target(caseId, worldId));
      for (const targetId of contract.targetIds) {
        expect(await page.locator(`#inventory-v3-control-${targetId}`).locator(
          'xpath=ancestor::*[@role="grid" or @role="row" or @role="gridcell"][1]',
        ).count()).toBe(0);
      }
    }
  });

  it('uses the exact two-label/two-action cross-tree shape on cards and sticky form rail', async () => {
    const cases = [
      {
        caseId: 'cross-tree/inventory-exception-cards',
        rootRole: 'region',
        requestedLabel: 'Cold-storage exception',
      },
      {
        caseId: 'cross-tree/purchase-approval-form',
        rootRole: 'form',
        requestedLabel: 'Finance approval',
      },
    ] as const;
    for (const { caseId, rootRole, requestedLabel } of cases) {
      const contract = inventoryBrowserIrV3Cases[caseId];
      for (const worldId of ['opaque-p0', 'opaque-p1'] as const) {
        await render(caseId, worldId);
        const root = page.locator(`#inventory-browserir-v3[role="${rootRole}"]`);
        expect(await root.count()).toBe(1);
        expect(await root.locator(':scope > [role="group"]').count()).toBe(2);
        const directContainers = root.locator(':scope > [role="group"]');
        expect(await directContainers.nth(0).getByRole('heading').count()).toBe(2);
        expect(await directContainers.nth(0).getByRole('button').count()).toBe(0);
        expect(await directContainers.nth(1).getByRole('heading').count()).toBe(0);
        expect(await directContainers.nth(1).getByRole('button').count()).toBe(2);
        expect(await uniqueTargetAlignedWith(
          page.getByRole('heading', { name: requestedLabel, exact: true }),
          contract.targetIds,
        )).toBe(expectedInventoryBrowserIrV3Target(caseId, worldId));
      }
    }
  });

  it('gives every semantic action a unique complete accessible relation name', async () => {
    const expectedNames: Record<InventoryBrowserIrV3CaseId, readonly string[]> = {
      'grid/warehouse-sku-stock-matrix': [
        'Berlin warehouse SKU INV-104 Inspect stock',
        'Berlin warehouse SKU INV-219 Inspect stock',
        'Rotterdam warehouse SKU INV-104 Inspect stock',
        'Rotterdam warehouse SKU INV-219 Inspect stock',
      ],
      'cross-tree/inventory-exception-cards': [
        'Cold-storage exception Open exception',
        'Hazmat intake exception Open exception',
      ],
      'schedule/receiving-slot-dialog': [
        'Dock B 09:30 Reserve slot',
        'Dock B 14:30 Reserve slot',
        'Dock C 09:30 Reserve slot',
        'Dock C 14:30 Reserve slot',
      ],
      'cross-tree/purchase-approval-form': [
        'Operations approval Review request',
        'Finance approval Review request',
      ],
    };

    for (const caseId of INVENTORY_BROWSERIR_V3_CASE_IDS) {
      for (const worldId of ['semantic-p0', 'semantic-p1'] as const) {
        await render(caseId, worldId);
        const names = expectedNames[caseId];
        for (const name of names) {
          expect(await page.getByRole('button', { name, exact: true }).count()).toBe(1);
        }
        expect(await page.locator('.inventory-v3-control[aria-labelledby]').count()).toBe(
          inventoryBrowserIrV3Cases[caseId].targetIds.length,
        );
        expect(await page.getByRole('button', {
          name: inventoryBrowserIrV3Cases[caseId].actionName,
          exact: true,
        }).count()).toBe(0);
      }
    }
  });
});
