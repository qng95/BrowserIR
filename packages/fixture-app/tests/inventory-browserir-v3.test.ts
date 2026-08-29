import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  INVENTORY_BROWSERIR_V3_AUDIT_ACTION,
  INVENTORY_BROWSERIR_V3_CATALOG_SHA256,
  INVENTORY_BROWSERIR_V3_CASE_IDS,
  INVENTORY_BROWSERIR_V3_FAMILIES,
  INVENTORY_BROWSERIR_V3_VERSION,
  INVENTORY_BROWSERIR_V3_WORLD_IDS,
  expectedInventoryBrowserIrV3Target,
  inventoryBrowserIrV3Cases,
  inventoryBrowserIrV3Catalog,
  inventoryBrowserIrV3Page,
  inventoryBrowserIrV3RelationForTarget,
  recordInventoryBrowserIrV3Selection,
  resolveInventoryBrowserIrV3Binding,
  verifyInventoryBrowserIrV3Selection,
  type InventoryBrowserIrV3Binding,
  type InventoryBrowserIrV3CaseId,
} from '../src/inventory-browserir-v3.js';
import { audit, createDb } from '../src/db.js';
import type { PageCtx } from '../src/pages.js';

const stripStyle = (html: string): string =>
  html.replace(/<style>[\s\S]*?<\/style>/gu, '<style></style>');

const stripActionRelations = (html: string): string => html.replace(
  / aria-labelledby="inventory-v3-(?:row|resource|relation)-[^"]+"/gu,
  '',
);

const pageFor = (
  binding: InventoryBrowserIrV3Binding,
  query = '',
): string => {
  const db = createDb({ customers: 1, vehicles: 1 });
  const contract = inventoryBrowserIrV3Cases[binding.caseId];
  const url = new URL(`http://fixture.invalid${contract.path}${query}`);
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

describe('Inventory BrowserIR v3 catalog', () => {
  it('freezes four causal Inventory ERP cases over the exact four-world contract', () => {
    expect(INVENTORY_BROWSERIR_V3_VERSION).toBe('inventory-browserir-corpus/3');
    expect(INVENTORY_BROWSERIR_V3_FAMILIES).toEqual([
      'grid-coordinate',
      'schedule-coordinate',
      'cross-tree-label',
    ]);
    expect(INVENTORY_BROWSERIR_V3_CASE_IDS).toEqual([
      'grid/warehouse-sku-stock-matrix',
      'cross-tree/inventory-exception-cards',
      'schedule/receiving-slot-dialog',
      'cross-tree/purchase-approval-form',
    ]);
    expect(INVENTORY_BROWSERIR_V3_WORLD_IDS).toEqual([
      'opaque-p0',
      'opaque-p1',
      'semantic-p0',
      'semantic-p1',
    ]);
    expect(Object.keys(inventoryBrowserIrV3Cases)).toEqual(INVENTORY_BROWSERIR_V3_CASE_IDS);
    expect(inventoryBrowserIrV3Catalog).toEqual({
      version: INVENTORY_BROWSERIR_V3_VERSION,
      families: INVENTORY_BROWSERIR_V3_FAMILIES,
      worldIds: INVENTORY_BROWSERIR_V3_WORLD_IDS,
      caseIds: INVENTORY_BROWSERIR_V3_CASE_IDS,
      cases: inventoryBrowserIrV3Cases,
    });
    expect(Object.isFrozen(inventoryBrowserIrV3Cases)).toBe(true);
    expect(Object.isFrozen(inventoryBrowserIrV3Catalog)).toBe(true);
    expect(INVENTORY_BROWSERIR_V3_CATALOG_SHA256).toBe(
      createHash('sha256')
        .update(JSON.stringify(inventoryBrowserIrV3Catalog), 'utf8')
        .digest('hex'),
    );
    expect(INVENTORY_BROWSERIR_V3_CATALOG_SHA256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('uses distinct stable routes, implementations, and target namespaces', () => {
    const cases = Object.values(inventoryBrowserIrV3Cases);
    expect(new Set(cases.map(({ siteId }) => siteId))).toHaveLength(4);
    expect(new Set(cases.map(({ implementationId }) => implementationId))).toHaveLength(4);
    expect(new Set(cases.map(({ path }) => path))).toHaveLength(4);
    expect(cases.map(({ targetIds }) => targetIds.length)).toEqual([4, 2, 4, 2]);
    expect(new Set(cases.flatMap(({ targetIds }) => targetIds))).toHaveLength(12);
    expect(cases.filter(({ familyId }) => familyId === 'grid-coordinate')).toHaveLength(1);
    expect(cases.filter(({ familyId }) => familyId === 'schedule-coordinate')).toHaveLength(1);
    expect(cases.filter(({ familyId }) => familyId === 'cross-tree-label')).toHaveLength(2);

    for (const contract of cases) {
      expect(contract.worldIds).toBe(INVENTORY_BROWSERIR_V3_WORLD_IDS);
      expect(contract.selectionPath).toBe(`${contract.path}/select`);
      expect(contract.path).not.toMatch(/opaque|semantic|p0|p1|world/iu);
      expect(Object.isFrozen(contract)).toBe(true);
      expect(Object.isFrozen(contract.targetIds)).toBe(true);
      expect(Object.isFrozen(contract.requestedRelation)).toBe(true);
    }
  });

  it('accepts only an exact host-owned binding and copies it immutably', () => {
    const input: InventoryBrowserIrV3Binding = {
      caseId: 'cross-tree/inventory-exception-cards',
      worldId: 'semantic-p1',
    };
    const retained = resolveInventoryBrowserIrV3Binding(input);
    input.worldId = 'opaque-p0';
    expect(retained).toEqual({
      caseId: 'cross-tree/inventory-exception-cards',
      worldId: 'semantic-p1',
    });
    expect(Object.isFrozen(retained)).toBe(true);

    const invalid = [
      { ...retained, leakedWorld: 'p1' },
      Object.assign(Object.create(null), retained),
      Object.assign(Object.create({ marker: true }), retained),
      Object.defineProperty({ ...retained }, 'hidden', { value: true }),
      { caseId: 'grid/not-in-catalog', worldId: 'opaque-p0' },
      { caseId: retained.caseId, worldId: 'opaque-p2' },
    ];
    for (const binding of invalid) {
      expect(() => resolveInventoryBrowserIrV3Binding(
        binding as InventoryBrowserIrV3Binding,
      )).toThrow(/outside the frozen catalog/u);
    }

    let getterCount = 0;
    const accessor = Object.defineProperties({}, {
      caseId: {
        enumerable: true,
        get: () => {
          getterCount += 1;
          return retained.caseId;
        },
      },
      worldId: { enumerable: true, value: retained.worldId },
    });
    expect(() => resolveInventoryBrowserIrV3Binding(
      accessor as InventoryBrowserIrV3Binding,
    )).toThrow(/outside the frozen catalog/u);
    expect(getterCount).toBe(0);

    let proxyTrapCount = 0;
    const proxy = new Proxy(retained, {
      get: () => {
        proxyTrapCount += 1;
        throw new Error('must not run');
      },
    });
    expect(() => resolveInventoryBrowserIrV3Binding(
      proxy as InventoryBrowserIrV3Binding,
    )).toThrow(/outside the frozen catalog/u);
    expect(proxyTrapCount).toBe(0);
  });

  it('pins a CSS-only target flip while semantic worlds mirror their opaque twin', () => {
    const expected = {
      'grid/warehouse-sku-stock-matrix': ['iv3-g2k7', 'iv3-g1n6'],
      'cross-tree/inventory-exception-cards': ['iv3-e4m8', 'iv3-e9q2'],
      'schedule/receiving-slot-dialog': ['iv3-r5t6', 'iv3-r7c3'],
      'cross-tree/purchase-approval-form': ['iv3-a3y9', 'iv3-a6d2'],
    } satisfies Record<InventoryBrowserIrV3CaseId, readonly [string, string]>;

    for (const caseId of INVENTORY_BROWSERIR_V3_CASE_IDS) {
      const [p0, p1] = expected[caseId];
      expect(expectedInventoryBrowserIrV3Target(caseId, 'opaque-p0')).toBe(p0);
      expect(expectedInventoryBrowserIrV3Target(caseId, 'opaque-p1')).toBe(p1);
      expect(p0).not.toBe(p1);
      expect(expectedInventoryBrowserIrV3Target(caseId, 'semantic-p0')).toBe(p0);
      expect(expectedInventoryBrowserIrV3Target(caseId, 'semantic-p1')).toBe(p1);
    }
  });

  it('resolves a complete unique target-to-relation mapping in every world', () => {
    for (const caseId of INVENTORY_BROWSERIR_V3_CASE_IDS) {
      const contract = inventoryBrowserIrV3Cases[caseId];
      for (const worldId of INVENTORY_BROWSERIR_V3_WORLD_IDS) {
        const relations = contract.targetIds.map((targetId) =>
          inventoryBrowserIrV3RelationForTarget(caseId, worldId, targetId));
        expect(relations.every(Object.isFrozen)).toBe(true);
        expect(new Set(relations.map((relation) => JSON.stringify(relation)))).toHaveLength(
          contract.targetIds.length,
        );
        const expectedTargetId = expectedInventoryBrowserIrV3Target(caseId, worldId);
        expect(
          inventoryBrowserIrV3RelationForTarget(caseId, worldId, expectedTargetId),
        ).toEqual(contract.requestedRelation);
      }
    }

    expect(() => inventoryBrowserIrV3RelationForTarget(
      'grid/warehouse-sku-stock-matrix',
      'opaque-p0',
      'iv3-not-in-catalog',
    )).toThrow(/Unknown Inventory BrowserIR v3 target/u);
  });
});

describe('Inventory BrowserIR v3 rendered-world isolation', () => {
  it('keeps opaque twins byte-identical outside CSS and never renders world/query identity', () => {
    for (const caseId of INVENTORY_BROWSERIR_V3_CASE_IDS) {
      const p0 = pageFor({ caseId, worldId: 'opaque-p0' });
      const p1 = pageFor({ caseId, worldId: 'opaque-p1' });
      expect(stripStyle(p0)).toBe(stripStyle(p1));
      expect(p0).not.toBe(p1);

      const queried = pageFor(
        { caseId, worldId: 'opaque-p0' },
        '?world=semantic-p1&target=iv3-query-leak&caseId=forged',
      );
      for (const html of [p0, p1, queried]) {
        for (const worldId of INVENTORY_BROWSERIR_V3_WORLD_IDS) {
          expect(html).not.toContain(worldId);
        }
        expect(html).not.toContain('iv3-query-leak');
        expect(html).not.toContain('caseId=forged');
      }
    }
  });

  it('adds only explicit action ARIA relations in each corresponding semantic world', () => {
    for (const caseId of INVENTORY_BROWSERIR_V3_CASE_IDS) {
      const contract = inventoryBrowserIrV3Cases[caseId];
      for (const permutation of ['p0', 'p1'] as const) {
        const opaque = pageFor({ caseId, worldId: `opaque-${permutation}` });
        const semantic = pageFor({ caseId, worldId: `semantic-${permutation}` });
        expect(stripActionRelations(semantic)).toBe(opaque);
        expect(semantic.match(
          / aria-labelledby="inventory-v3-(?:row|resource|relation)-[^"]+"/gu,
        )).toHaveLength(contract.targetIds.length);
      }
    }
  });

  it('renders four deliberately different Inventory ERP surfaces', () => {
    expect(pageFor({
      caseId: 'grid/warehouse-sku-stock-matrix',
      worldId: 'opaque-p0',
    })).toContain('role="grid"');
    expect(pageFor({
      caseId: 'cross-tree/inventory-exception-cards',
      worldId: 'opaque-p0',
    })).toContain('class="inventory-v3-exception-card"');
    expect(pageFor({
      caseId: 'schedule/receiving-slot-dialog',
      worldId: 'opaque-p0',
    })).toContain('role="dialog" aria-modal="true"');
    expect(pageFor({
      caseId: 'cross-tree/purchase-approval-form',
      worldId: 'opaque-p0',
    })).toContain('role="form"');
  });
});

describe('Inventory BrowserIR v3 exact one-shot oracle', () => {
  it('passes one correct selection in every one of the 16 case/world cells', () => {
    for (const caseId of INVENTORY_BROWSERIR_V3_CASE_IDS) {
      for (const worldId of INVENTORY_BROWSERIR_V3_WORLD_IDS) {
        const db = createDb({ customers: 1, vehicles: 1 });
        const binding = { caseId, worldId };
        const expectedTargetId = expectedInventoryBrowserIrV3Target(caseId, worldId);
        recordInventoryBrowserIrV3Selection(db, 'test', binding, expectedTargetId);
        expect(verifyInventoryBrowserIrV3Selection(db, binding)).toEqual({
          passed: true,
          outcome: 'passed',
          expectedTargetId,
          selectedTargetIds: [expectedTargetId],
          mutationCount: 1,
          collateralMutationCount: 0,
          totalCorpusMutationCount: 1,
          otherAuditMutationCount: 0,
          totalAuditMutationCount: 1,
        });
        db.close();
      }
    }
  });

  it('permanently fails wrong-then-correct, another world, or any unrelated mutation', () => {
    const binding = {
      caseId: 'grid/warehouse-sku-stock-matrix',
      worldId: 'opaque-p1',
    } as const;
    const contract = inventoryBrowserIrV3Cases[binding.caseId];
    const expected = expectedInventoryBrowserIrV3Target(binding.caseId, binding.worldId);
    const wrong = contract.targetIds.find((target) => target !== expected)!;

    const repaired = createDb({ customers: 1, vehicles: 1 });
    recordInventoryBrowserIrV3Selection(repaired, 'test', binding, wrong);
    recordInventoryBrowserIrV3Selection(repaired, 'test', binding, expected);
    expect(verifyInventoryBrowserIrV3Selection(repaired, binding)).toMatchObject({
      passed: false,
      selectedTargetIds: [wrong, expected],
      mutationCount: 2,
      collateralMutationCount: 0,
      totalAuditMutationCount: 2,
    });
    repaired.close();

    const otherWorld = createDb({ customers: 1, vehicles: 1 });
    recordInventoryBrowserIrV3Selection(otherWorld, 'test', binding, expected);
    const otherBinding = { ...binding, worldId: 'opaque-p0' as const };
    recordInventoryBrowserIrV3Selection(
      otherWorld,
      'test',
      otherBinding,
      expectedInventoryBrowserIrV3Target(otherBinding.caseId, otherBinding.worldId),
    );
    expect(verifyInventoryBrowserIrV3Selection(otherWorld, binding)).toMatchObject({
      passed: false,
      mutationCount: 1,
      collateralMutationCount: 1,
      totalCorpusMutationCount: 2,
    });
    otherWorld.close();

    const collateral = createDb({ customers: 1, vehicles: 1 });
    recordInventoryBrowserIrV3Selection(collateral, 'test', binding, expected);
    audit(collateral, {
      actor: 'test',
      action: 'inventory.adjust',
      entity: 'part',
      entityId: 42,
      detail: 'collateral mutation',
    });
    expect(verifyInventoryBrowserIrV3Selection(collateral, binding)).toMatchObject({
      passed: false,
      mutationCount: 1,
      collateralMutationCount: 1,
      otherAuditMutationCount: 1,
      totalAuditMutationCount: 2,
    });
    collateral.close();
  });

  it('rejects a target from another case without writing an audit row', () => {
    const db = createDb({ customers: 1, vehicles: 1 });
    const binding = {
      caseId: 'cross-tree/inventory-exception-cards',
      worldId: 'opaque-p0',
    } as const;
    expect(() => recordInventoryBrowserIrV3Selection(
      db,
      'test',
      binding,
      inventoryBrowserIrV3Cases['schedule/receiving-slot-dialog'].targetIds[0]!,
    )).toThrow(/outside the case catalog/u);
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM audit WHERE action = ?',
    ).get(INVENTORY_BROWSERIR_V3_AUDIT_ACTION)).toEqual({ count: 0 });
    db.close();
  });
});
