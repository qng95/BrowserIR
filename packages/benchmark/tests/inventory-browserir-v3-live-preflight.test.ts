import { describe, expect, it } from 'vitest';
import {
  INVENTORY_BROWSERIR_V3_CASE_IDS,
  INVENTORY_BROWSERIR_V3_WORLD_IDS,
  expectedInventoryBrowserIrV3Target,
  inventoryBrowserIrV3Cases,
  inventoryBrowserIrV3RelationForTarget,
  type InventoryBrowserIrV3RequestedRelation,
} from '@think-dom/fixture-app';

import {
  buildInventoryBrowserIrV3PreflightSchedule,
  runInventoryBrowserIrV3LivePreflight,
  validateInventoryBrowserIrV3ProjectedMapping,
  validateInventoryBrowserIrV3SemanticMapping,
} from '../src/agent-benchmark/inventory-browserir-v3-live-preflight.js';

const relationValues = (
  relation: InventoryBrowserIrV3RequestedRelation,
): readonly string[] => relation.kind === 'grid-coordinate'
  ? [relation.row, relation.column]
  : relation.kind === 'schedule-coordinate'
    ? [relation.resource, relation.slot]
    : [relation.label];

const relationFact = (
  ref: string,
  relation: InventoryBrowserIrV3RequestedRelation,
) => relation.kind === 'grid-coordinate'
  ? { kind: 'grid-cell', ref, attributes: { row: relation.row, column: relation.column } }
  : relation.kind === 'schedule-coordinate'
    ? { kind: 'schedule-slot', ref, attributes: { resource: relation.resource, slot: relation.slot } }
    : { kind: 'cross-tree-label', ref, attributes: { label: relation.label } };

describe('Inventory BrowserIR v3 live preflight', () => {
  it('freezes a complete four-case by four-world schedule', () => {
    const schedule = buildInventoryBrowserIrV3PreflightSchedule();
    expect(schedule).toHaveLength(16);
    expect(new Set(schedule.map(({ caseId }) => caseId))).toHaveLength(4);
    expect(new Set(schedule.map(({ worldId }) => worldId))).toHaveLength(4);
    expect(schedule.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(schedule)).toBe(true);
  });

  it('validates every projected and semantic ref relation, not only the requested one', () => {
    for (const caseId of INVENTORY_BROWSERIR_V3_CASE_IDS) {
      const study = inventoryBrowserIrV3Cases[caseId];
      for (const worldId of INVENTORY_BROWSERIR_V3_WORLD_IDS) {
        const candidates = study.targetIds.map((_, index) => ({ ref: `e${index + 1}` }));
        const relations = study.targetIds.map((targetId) =>
          inventoryBrowserIrV3RelationForTarget(caseId, worldId, targetId));
        const facts = candidates.map(({ ref }, index) => relationFact(ref, relations[index]!));
        const expectedIndex = study.targetIds.indexOf(
          expectedInventoryBrowserIrV3Target(caseId, worldId),
        );
        expect(validateInventoryBrowserIrV3ProjectedMapping(
          caseId,
          worldId,
          candidates,
          facts,
        ).ref).toBe(candidates[expectedIndex]!.ref);

        const semantic = candidates.map(({ ref }, index) => ({
          ref,
          name: [...relationValues(relations[index]!), study.actionName].join(' '),
        }));
        expect(validateInventoryBrowserIrV3SemanticMapping(
          caseId,
          worldId,
          semantic,
        )).toBe(candidates[expectedIndex]!.ref);
      }
    }

    const caseId = 'grid/warehouse-sku-stock-matrix' as const;
    const worldId = 'opaque-p0' as const;
    const study = inventoryBrowserIrV3Cases[caseId];
    const candidates = study.targetIds.map((_, index) => ({ ref: `e${index + 1}` }));
    const relations = study.targetIds.map((targetId) =>
      inventoryBrowserIrV3RelationForTarget(caseId, worldId, targetId));
    const facts = candidates.map(({ ref }, index) => relationFact(ref, relations[index]!));
    const corruptedFacts = facts.map((fact, index) => index === 1
      ? { ...fact, attributes: { ...fact.attributes, row: 'Wrong warehouse' } }
      : fact);
    expect(() => validateInventoryBrowserIrV3ProjectedMapping(
      caseId,
      worldId,
      candidates,
      corruptedFacts,
    )).toThrow(/incorrect ref relation/u);

    const semantic = candidates.map(({ ref }, index) => ({
      ref,
      name: [...relationValues(relations[index]!), study.actionName].join(' '),
    }));
    semantic[1] = { ...semantic[1]!, name: `Wrong warehouse SKU INV-219 ${study.actionName}` };
    expect(() => validateInventoryBrowserIrV3SemanticMapping(
      caseId,
      worldId,
      semantic,
    )).toThrow(/incorrect relation name/u);
  });

  const live = process.env['BROWSERIR_RUN_INVENTORY_V3_PREFLIGHT'] === '1'
    ? it
    : it.skip;

  live('clicks the exact current ref in all 16 case-world cells through official Playwright MCP', async () => {
    const result = await runInventoryBrowserIrV3LivePreflight();
    expect(result.status).toBe('passed-live-browser-product-preflight');
    expect(result.catalogSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.captures).toHaveLength(16);
    expect(result.summary).toEqual({
      cases: 4,
      worldDefinitions: 4,
      caseWorlds: 16,
      offDisabled: 16,
      opaqueProjected: 8,
      semanticPassthrough: 8,
      hiddenSnapshotCalls: 8,
      exactOraclePasses: 16,
      wrongOrCollateralMutations: 0,
      modelCalls: 0,
      providerCalls: 0,
      score: null,
      claimAuthority: false,
    });
  }, 300_000);
});
