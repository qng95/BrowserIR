import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ADAPTIVE_ACCURACY_HOLDOUT_AUDIT_ACTION,
  ADAPTIVE_ACCURACY_HOLDOUT_CATALOG_SHA256,
  ADAPTIVE_ACCURACY_HOLDOUT_CASE_IDS,
  ADAPTIVE_ACCURACY_HOLDOUT_FAMILIES,
  ADAPTIVE_ACCURACY_HOLDOUT_VERSION,
  ADAPTIVE_ACCURACY_HOLDOUT_WORLD_IDS,
  adaptiveAccuracyHoldoutCases,
  adaptiveAccuracyHoldoutCatalog,
  adaptiveAccuracyHoldoutPage,
  expectedAdaptiveAccuracyHoldoutTarget,
  recordAdaptiveAccuracyHoldoutSelection,
  resolveAdaptiveAccuracyHoldoutBinding,
  verifyAdaptiveAccuracyHoldoutSelection,
  type AdaptiveAccuracyHoldoutBinding,
  type AdaptiveAccuracyHoldoutCaseId,
} from '../src/adaptive-accuracy-holdout.js';
import { audit, createDb } from '../src/db.js';
import type { PageCtx } from '../src/pages.js';
import type { AppServerOptions } from '../src/server.js';

const stripStyle = (html: string): string =>
  html.replace(/<style>[\s\S]*?<\/style>/gu, '<style></style>');

const pageFor = (
  binding: AdaptiveAccuracyHoldoutBinding,
  query = '',
): string => {
  const db = createDb({ customers: 1, vehicles: 1 });
  const contract = adaptiveAccuracyHoldoutCases[binding.caseId];
  const url = new URL(`http://fixture.invalid${contract.path}${query}`);
  const ctx: PageCtx = {
    db,
    path: url.pathname,
    url,
    user: { username: 'test', display_name: 'Test User' },
  };
  try {
    return adaptiveAccuracyHoldoutPage(ctx, binding);
  } finally {
    db.close();
  }
};

const buttonTag = (html: string, targetId: string): string => {
  const id = `id="accuracy-holdout-control-${targetId}"`;
  const idIndex = html.indexOf(id);
  if (idIndex < 0) throw new Error(`Missing holdout control ${targetId}.`);
  const start = html.lastIndexOf('<button', idIndex);
  const end = html.indexOf('>', idIndex);
  if (start < 0 || end < 0) throw new Error(`Malformed holdout control ${targetId}.`);
  return html.slice(start, end + 1);
};

describe('Browser IR accuracy holdout v2 development catalog', () => {
  it('freezes the exact eight-case, four-world v2 contract', () => {
    expect(ADAPTIVE_ACCURACY_HOLDOUT_VERSION).toBe('browser-ir-accuracy-holdout/2');
    expect(ADAPTIVE_ACCURACY_HOLDOUT_FAMILIES).toEqual([
      'schedule-coordinate',
      'cross-tree-label',
    ]);
    expect(ADAPTIVE_ACCURACY_HOLDOUT_CASE_IDS).toEqual([
      'schedule/clinic-imaging-board',
      'schedule/harbor-maintenance-rail',
      'cross-tree/catalog-localization-queues',
      'cross-tree/storage-intake-lanes',
      'schedule/workshop-week-table',
      'schedule/dispatch-shift-board',
      'cross-tree/case-routing-columns',
      'cross-tree/approval-lanes',
    ]);
    expect(ADAPTIVE_ACCURACY_HOLDOUT_WORLD_IDS).toEqual([
      'opaque-p0',
      'opaque-p1',
      'semantic-p0',
      'semantic-p1',
    ]);
    expect(Object.keys(adaptiveAccuracyHoldoutCases))
      .toEqual(ADAPTIVE_ACCURACY_HOLDOUT_CASE_IDS);
    expect(Object.isFrozen(adaptiveAccuracyHoldoutCases)).toBe(true);
    expect(adaptiveAccuracyHoldoutCatalog).toEqual({
      version: ADAPTIVE_ACCURACY_HOLDOUT_VERSION,
      families: ADAPTIVE_ACCURACY_HOLDOUT_FAMILIES,
      worldIds: ADAPTIVE_ACCURACY_HOLDOUT_WORLD_IDS,
      caseIds: ADAPTIVE_ACCURACY_HOLDOUT_CASE_IDS,
      cases: adaptiveAccuracyHoldoutCases,
    });
    expect(Object.isFrozen(adaptiveAccuracyHoldoutCatalog)).toBe(true);
    expect(ADAPTIVE_ACCURACY_HOLDOUT_CATALOG_SHA256).toBe(
      createHash('sha256')
        .update(JSON.stringify(adaptiveAccuracyHoldoutCatalog), 'utf8')
        .digest('hex'),
    );
    expect(ADAPTIVE_ACCURACY_HOLDOUT_CATALOG_SHA256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('uses eight distinct sites, routes, implementations, and target namespaces', () => {
    const cases = Object.values(adaptiveAccuracyHoldoutCases);
    expect(cases.map(({ siteId }) => siteId)).toEqual([
      'clinic-imaging-board',
      'harbor-maintenance-rail',
      'catalog-localization-queues',
      'storage-intake-lanes',
      'workshop-week-table',
      'dispatch-shift-board',
      'case-routing-columns',
      'approval-lanes',
    ]);
    expect(new Set(cases.map(({ siteId }) => siteId))).toHaveLength(8);
    expect(new Set(cases.map(({ implementationId }) => implementationId))).toHaveLength(8);
    expect(new Set(cases.map(({ path }) => path))).toHaveLength(8);
    expect(cases.map(({ targetIds }) => targetIds.length)).toEqual([6, 6, 2, 2, 4, 4, 2, 2]);
    expect(new Set(cases.flatMap(({ targetIds }) => targetIds))).toHaveLength(28);
    expect(cases.filter(({ familyId }) => familyId === 'schedule-coordinate')).toHaveLength(4);
    expect(cases.filter(({ familyId }) => familyId === 'cross-tree-label')).toHaveLength(4);

    for (const contract of cases) {
      expect(contract.worldIds).toBe(ADAPTIVE_ACCURACY_HOLDOUT_WORLD_IDS);
      expect(contract.selectionPath).toBe(`${contract.path}/select`);
      expect(contract.path).not.toMatch(/opaque|semantic|p0|p1|world/iu);
      expect(Object.isFrozen(contract)).toBe(true);
      expect(Object.isFrozen(contract.targetIds)).toBe(true);
      expect(Object.isFrozen(contract.requestedRelation)).toBe(true);
    }
  });

  it('copies an exact hidden host binding and wires that type into server options', () => {
    const input: AdaptiveAccuracyHoldoutBinding = {
      caseId: 'cross-tree/catalog-localization-queues',
      worldId: 'semantic-p1',
    };
    const retained = resolveAdaptiveAccuracyHoldoutBinding(input);
    input.worldId = 'opaque-p0';
    expect(retained).toEqual({
      caseId: 'cross-tree/catalog-localization-queues',
      worldId: 'semantic-p1',
    });
    expect(Object.isFrozen(retained)).toBe(true);
    expect(() => resolveAdaptiveAccuracyHoldoutBinding({
      caseId: 'cross-tree/catalog-localization-queues',
      worldId: 'semantic-p1',
      leakedAlias: 'p1',
    } as AdaptiveAccuracyHoldoutBinding)).toThrow(/outside the frozen catalog/u);

    const options: AppServerOptions = { adaptiveAccuracyHoldout: retained };
    expect(options.adaptiveAccuracyHoldout).toBe(retained);
  });

  it('rejects hostile binding shapes without invoking Proxy traps or accessors', () => {
    const valid = {
      caseId: 'cross-tree/catalog-localization-queues',
      worldId: 'semantic-p1',
    } as const;
    let proxyTrapCount = 0;
    const trapped = () => {
      proxyTrapCount += 1;
      throw new Error('binding Proxy trap must not run');
    };
    const proxy = new Proxy(valid, {
      get: trapped,
      getOwnPropertyDescriptor: trapped,
      getPrototypeOf: trapped,
      ownKeys: trapped,
    });
    expect(() => resolveAdaptiveAccuracyHoldoutBinding(
      proxy as AdaptiveAccuracyHoldoutBinding,
    )).toThrow(/outside the frozen catalog/u);
    expect(proxyTrapCount).toBe(0);

    let getterCount = 0;
    const getterBinding = Object.defineProperties({}, {
      caseId: {
        enumerable: true,
        get: () => {
          getterCount += 1;
          return valid.caseId;
        },
      },
      worldId: { enumerable: true, value: valid.worldId },
    });
    expect(() => resolveAdaptiveAccuracyHoldoutBinding(
      getterBinding as AdaptiveAccuracyHoldoutBinding,
    )).toThrow(/outside the frozen catalog/u);
    expect(getterCount).toBe(0);

    const setterBinding = Object.defineProperties({}, {
      caseId: { enumerable: true, value: valid.caseId },
      worldId: { enumerable: true, set: () => undefined },
    });
    expect(() => resolveAdaptiveAccuracyHoldoutBinding(
      setterBinding as AdaptiveAccuracyHoldoutBinding,
    )).toThrow(/outside the frozen catalog/u);
  });

  it('accepts only the exact two enumerable own string data properties on Object.prototype', () => {
    const valid = {
      caseId: 'cross-tree/catalog-localization-queues',
      worldId: 'semantic-p1',
    } as const;
    const enumerableExtra = { ...valid, leakedAlias: 'p1' };
    const nonEnumerableExtra = Object.defineProperty(
      { ...valid },
      'leakedAlias',
      { value: 'p1', enumerable: false },
    );
    const enumerableSymbolExtra = Object.defineProperty(
      { ...valid },
      Symbol('leakedAlias'),
      { value: 'p1', enumerable: true },
    );
    const nonEnumerableSymbolExtra = Object.defineProperty(
      { ...valid },
      Symbol('leakedAlias'),
      { value: 'p1', enumerable: false },
    );
    const nonEnumerableRequired = Object.defineProperties({}, {
      caseId: { value: valid.caseId, enumerable: false },
      worldId: { value: valid.worldId, enumerable: true },
    });
    const missingCaseId = { worldId: valid.worldId };
    const missingWorldId = { caseId: valid.caseId };
    const nullPrototype = Object.assign(Object.create(null), valid);
    const customPrototype = Object.assign(Object.create({ marker: true }), valid);
    class BindingRecord {
      caseId = valid.caseId;
      worldId = valid.worldId;
    }

    for (const rejected of [
      enumerableExtra,
      nonEnumerableExtra,
      enumerableSymbolExtra,
      nonEnumerableSymbolExtra,
      nonEnumerableRequired,
      missingCaseId,
      missingWorldId,
      nullPrototype,
      customPrototype,
      new BindingRecord(),
    ]) {
      expect(() => resolveAdaptiveAccuracyHoldoutBinding(
        rejected as AdaptiveAccuracyHoldoutBinding,
      )).toThrow(/outside the frozen catalog/u);
    }

    const accepted = resolveAdaptiveAccuracyHoldoutBinding({ ...valid });
    expect(accepted).toEqual(valid);
    expect(Object.isFrozen(accepted)).toBe(true);
  });

  it('pins a different opaque target under p0 and p1 while semantic twins preserve it', () => {
    const exactExpected = {
      'schedule/clinic-imaging-board': ['ci-r3n6', 'ci-z1p4'],
      'schedule/harbor-maintenance-rail': ['hm-t7k3', 'hm-g9a4'],
      'cross-tree/catalog-localization-queues': ['lq-m3v7', 'lq-d8p2'],
      'cross-tree/storage-intake-lanes': ['si-n4q8', 'si-f9k2'],
      'schedule/workshop-week-table': ['ws-x3n6', 'ws-k7p2'],
      'schedule/dispatch-shift-board': ['ds-z5j7', 'ds-b6t4'],
      'cross-tree/case-routing-columns': ['cr-q4v8', 'cr-d7m2'],
      'cross-tree/approval-lanes': ['al-y9k3', 'al-f6p1'],
    } satisfies Record<AdaptiveAccuracyHoldoutCaseId, readonly [string, string]>;

    for (const caseId of ADAPTIVE_ACCURACY_HOLDOUT_CASE_IDS) {
      const p0 = expectedAdaptiveAccuracyHoldoutTarget(caseId, 'opaque-p0');
      const p1 = expectedAdaptiveAccuracyHoldoutTarget(caseId, 'opaque-p1');
      expect([p0, p1]).toEqual(exactExpected[caseId]);
      expect(p0).not.toBe(p1);
      expect(expectedAdaptiveAccuracyHoldoutTarget(caseId, 'semantic-p0')).toBe(p0);
      expect(expectedAdaptiveAccuracyHoldoutTarget(caseId, 'semantic-p1')).toBe(p1);
    }
  });
});

describe('holdout representations stay hidden and mechanism-specific', () => {
  it('keeps opaque permutations text/DOM-identical outside CSS and hides every world ID', () => {
    for (const caseId of ADAPTIVE_ACCURACY_HOLDOUT_CASE_IDS) {
      const p0 = pageFor({ caseId, worldId: 'opaque-p0' });
      const p1 = pageFor({ caseId, worldId: 'opaque-p1' });
      expect(stripStyle(p0)).toBe(stripStyle(p1));
      expect(p0).not.toBe(p1);
      for (const html of [p0, p1]) {
        for (const worldId of ADAPTIVE_ACCURACY_HOLDOUT_WORLD_IDS) {
          expect(html).not.toContain(worldId);
        }
        expect(html).not.toContain('aria-labelledby="accuracy-holdout-relation-');
        expect(html).not.toContain('aria-labelledby="accuracy-holdout-resource-');
      }
    }
  });

  it('adds semantic association only to the matching semantic-world controls', () => {
    for (const caseId of ADAPTIVE_ACCURACY_HOLDOUT_CASE_IDS) {
      for (const permutation of ['p0', 'p1'] as const) {
        const opaqueWorld = `opaque-${permutation}` as const;
        const semanticWorld = `semantic-${permutation}` as const;
        const expected = expectedAdaptiveAccuracyHoldoutTarget(caseId, semanticWorld);
        const opaque = pageFor({ caseId, worldId: opaqueWorld });
        const semantic = pageFor({ caseId, worldId: semanticWorld });
        expect(buttonTag(opaque, expected)).not.toContain('aria-labelledby=');
        expect(buttonTag(semantic, expected)).toContain('aria-labelledby=');
        expect(semantic).toContain('accuracy-holdout-action-name');
        for (const worldId of ADAPTIVE_ACCURACY_HOLDOUT_WORLD_IDS) {
          expect(semantic).not.toContain(worldId);
        }
      }
    }
  });

  it('renders the finalized 3x2, RTL 2x3, mirrored variable-height, and staggered designs', () => {
    const clinic = pageFor({
      caseId: 'schedule/clinic-imaging-board',
      worldId: 'opaque-p0',
    });
    expect(clinic).toContain('<table class="holdout-clinic-table"');
    expect(clinic).toContain('repeat(2,minmax(0,1fr))');
    expect(clinic).toContain('repeat(3,76px)');

    const harbor = pageFor({
      caseId: 'schedule/harbor-maintenance-rail',
      worldId: 'opaque-p1',
    });
    expect(harbor).toContain('role="grid"');
    expect(harbor).toContain('repeat(3,minmax(150px,1fr))');
    expect(harbor).toContain('direction:rtl');

    const localizationP0 = pageFor({
      caseId: 'cross-tree/catalog-localization-queues',
      worldId: 'opaque-p0',
    });
    const localizationP1 = pageFor({
      caseId: 'cross-tree/catalog-localization-queues',
      worldId: 'opaque-p1',
    });
    expect(localizationP0).toContain('grid-template-rows:78px 124px');
    expect(localizationP0).toContain('.holdout-localization-labels{grid-column:1}');
    expect(localizationP1).toContain('.holdout-localization-labels{grid-column:2}');
    expect(localizationP0).toContain('role="region"');
    expect(stripStyle(localizationP0)).toBe(stripStyle(localizationP1));

    const storage = pageFor({
      caseId: 'cross-tree/storage-intake-lanes',
      worldId: 'opaque-p0',
    });
    expect(storage).toContain('grid-template-rows:70px 28px 112px');
    expect(storage).toContain('li:nth-child(2){grid-row:3}');
    expect(storage).toContain('role="region"');
  });

  it('ignores hostile query world/target hints because rendering uses only the host binding', () => {
    const binding = {
      caseId: 'schedule/clinic-imaging-board',
      worldId: 'opaque-p0',
    } as const;
    const clean = pageFor(binding);
    const hinted = pageFor(binding, '?world=semantic-p1&target=ci-z1p4');
    expect(hinted).toBe(clean);
    expect(buttonTag(hinted, 'ci-r3n6')).not.toContain('aria-labelledby=');
  });
});

describe('holdout exact-one database oracle', () => {
  it('passes exactly one correct selection in all 32 v2 cells', () => {
    for (const caseId of ADAPTIVE_ACCURACY_HOLDOUT_CASE_IDS) {
      for (const worldId of ADAPTIVE_ACCURACY_HOLDOUT_WORLD_IDS) {
        const db = createDb({ customers: 1, vehicles: 1 });
        const expected = expectedAdaptiveAccuracyHoldoutTarget(caseId, worldId);
        recordAdaptiveAccuracyHoldoutSelection(db, 'test', { caseId, worldId }, expected);
        expect(verifyAdaptiveAccuracyHoldoutSelection(db, { caseId, worldId })).toEqual({
          passed: true,
          outcome: 'passed',
          expectedTargetId: expected,
          selectedTargetIds: [expected],
          mutationCount: 1,
          collateralMutationCount: 0,
          totalHoldoutMutationCount: 1,
          otherAuditMutationCount: 0,
          totalAuditMutationCount: 1,
        });
        db.close();
      }
    }
  });

  it('fails zero, wrong, duplicate, wrong-then-correct, and collateral mutations', () => {
    const binding = {
      caseId: 'cross-tree/storage-intake-lanes',
      worldId: 'opaque-p1',
    } as const;
    const expected = expectedAdaptiveAccuracyHoldoutTarget(binding.caseId, binding.worldId);
    const wrong = adaptiveAccuracyHoldoutCases[binding.caseId].targetIds
      .find((targetId) => targetId !== expected)!;

    const zero = createDb({ customers: 1, vehicles: 1 });
    expect(verifyAdaptiveAccuracyHoldoutSelection(zero, binding)).toMatchObject({
      passed: false,
      mutationCount: 0,
      totalHoldoutMutationCount: 0,
      totalAuditMutationCount: 0,
    });
    zero.close();

    for (const targets of [[wrong], [expected, expected], [wrong, expected]]) {
      const db = createDb({ customers: 1, vehicles: 1 });
      for (const targetId of targets) {
        recordAdaptiveAccuracyHoldoutSelection(db, 'test', binding, targetId);
      }
      expect(verifyAdaptiveAccuracyHoldoutSelection(db, binding)).toMatchObject({
        passed: false,
        selectedTargetIds: targets,
        mutationCount: targets.length,
        collateralMutationCount: 0,
        totalHoldoutMutationCount: targets.length,
        otherAuditMutationCount: 0,
        totalAuditMutationCount: targets.length,
      });
      db.close();
    }

    const collateral = createDb({ customers: 1, vehicles: 1 });
    recordAdaptiveAccuracyHoldoutSelection(collateral, 'test', binding, expected);
    const other = {
      caseId: 'schedule/harbor-maintenance-rail',
      worldId: 'semantic-p0',
    } as const;
    recordAdaptiveAccuracyHoldoutSelection(
      collateral,
      'test',
      other,
      expectedAdaptiveAccuracyHoldoutTarget(other.caseId, other.worldId),
    );
    expect(verifyAdaptiveAccuracyHoldoutSelection(collateral, binding)).toMatchObject({
      passed: false,
      mutationCount: 1,
      collateralMutationCount: 1,
      totalHoldoutMutationCount: 2,
      otherAuditMutationCount: 0,
      totalAuditMutationCount: 2,
    });
    collateral.close();

    const domainCollateral = createDb({ customers: 1, vehicles: 1 });
    recordAdaptiveAccuracyHoldoutSelection(domainCollateral, 'test', binding, expected);
    audit(domainCollateral, {
      actor: 'test',
      action: 'customer.update',
      entity: 'customer',
      entityId: 1,
    });
    expect(verifyAdaptiveAccuracyHoldoutSelection(domainCollateral, binding)).toMatchObject({
      passed: false,
      mutationCount: 1,
      collateralMutationCount: 1,
      totalHoldoutMutationCount: 1,
      otherAuditMutationCount: 1,
      totalAuditMutationCount: 2,
    });
    domainCollateral.close();
  });

  it('rejects an out-of-catalog target without writing an audit row', () => {
    const db = createDb({ customers: 1, vehicles: 1 });
    const binding = {
      caseId: 'schedule/clinic-imaging-board',
      worldId: 'opaque-p0',
    } as const;
    expect(() => recordAdaptiveAccuracyHoldoutSelection(
      db,
      'test',
      binding,
      'qualification-era-target',
    )).toThrow(/outside the case catalog/u);
    const count = db.prepare('SELECT COUNT(*) AS n FROM audit WHERE action = ?')
      .get(ADAPTIVE_ACCURACY_HOLDOUT_AUDIT_ACTION) as { n: number };
    expect(Number(count.n)).toBe(0);
    db.close();
  });
});
