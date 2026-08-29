import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { types as nodeUtilTypes } from 'node:util';

import { audit } from './db.js';
import type { PageCtx } from './pages.js';
import { esc, layout } from './views.js';

export const INVENTORY_BROWSERIR_V3_VERSION = 'inventory-browserir-corpus/3' as const;

export const INVENTORY_BROWSERIR_V3_FAMILIES = Object.freeze([
  'grid-coordinate',
  'schedule-coordinate',
  'cross-tree-label',
] as const);

export type InventoryBrowserIrV3Family =
  (typeof INVENTORY_BROWSERIR_V3_FAMILIES)[number];

export const INVENTORY_BROWSERIR_V3_WORLD_IDS = Object.freeze([
  'opaque-p0',
  'opaque-p1',
  'semantic-p0',
  'semantic-p1',
] as const);

export type InventoryBrowserIrV3WorldId =
  (typeof INVENTORY_BROWSERIR_V3_WORLD_IDS)[number];

export const INVENTORY_BROWSERIR_V3_CASE_IDS = Object.freeze([
  'grid/warehouse-sku-stock-matrix',
  'cross-tree/inventory-exception-cards',
  'schedule/receiving-slot-dialog',
  'cross-tree/purchase-approval-form',
] as const);

export type InventoryBrowserIrV3CaseId =
  (typeof INVENTORY_BROWSERIR_V3_CASE_IDS)[number];

type GridCaseId = Extract<InventoryBrowserIrV3CaseId, `grid/${string}`>;
type ScheduleCaseId = Extract<InventoryBrowserIrV3CaseId, `schedule/${string}`>;
type CrossTreeCaseId = Extract<InventoryBrowserIrV3CaseId, `cross-tree/${string}`>;

export type InventoryBrowserIrV3RequestedRelation =
  | Readonly<{ kind: 'grid-coordinate'; row: string; column: string }>
  | Readonly<{ kind: 'schedule-coordinate'; resource: string; slot: string }>
  | Readonly<{ kind: 'cross-tree-label'; label: string }>;

export interface InventoryBrowserIrV3CaseContract {
  caseId: InventoryBrowserIrV3CaseId;
  familyId: InventoryBrowserIrV3Family;
  siteId: string;
  implementationId: string;
  path: string;
  selectionPath: string;
  prompt: string;
  actionName: string;
  targetIds: readonly string[];
  requestedRelation: InventoryBrowserIrV3RequestedRelation;
  worldIds: typeof INVENTORY_BROWSERIR_V3_WORLD_IDS;
}

const caseContract = (
  input: Omit<InventoryBrowserIrV3CaseContract, 'selectionPath' | 'worldIds'>,
): InventoryBrowserIrV3CaseContract => Object.freeze({
  ...input,
  selectionPath: `${input.path}/select`,
  targetIds: Object.freeze([...input.targetIds]),
  requestedRelation: Object.freeze({ ...input.requestedRelation }),
  worldIds: INVENTORY_BROWSERIR_V3_WORLD_IDS,
});

export const inventoryBrowserIrV3Cases = Object.freeze({
  'grid/warehouse-sku-stock-matrix': caseContract({
    caseId: 'grid/warehouse-sku-stock-matrix',
    familyId: 'grid-coordinate',
    siteId: 'warehouse-sku-stock-matrix',
    implementationId: 'inventory-stock-overlay-grid',
    path: '/app/labs/inventory-warehouse-stock',
    prompt: 'Inspect SKU INV-104 at Berlin warehouse, then stop.',
    actionName: 'Inspect stock',
    targetIds: ['iv3-g2k7', 'iv3-g8p4', 'iv3-g5v9', 'iv3-g1n6'],
    requestedRelation: {
      kind: 'grid-coordinate',
      row: 'Berlin warehouse',
      column: 'SKU INV-104',
    },
  }),
  'cross-tree/inventory-exception-cards': caseContract({
    caseId: 'cross-tree/inventory-exception-cards',
    familyId: 'cross-tree-label',
    siteId: 'inventory-exception-cards',
    implementationId: 'detached-inventory-exception-rail',
    path: '/app/labs/inventory-exceptions',
    prompt: 'Open the exception aligned with Cold-storage exception, then stop.',
    actionName: 'Open exception',
    targetIds: ['iv3-e4m8', 'iv3-e9q2'],
    requestedRelation: {
      kind: 'cross-tree-label',
      label: 'Cold-storage exception',
    },
  }),
  'schedule/receiving-slot-dialog': caseContract({
    caseId: 'schedule/receiving-slot-dialog',
    familyId: 'schedule-coordinate',
    siteId: 'receiving-slot-dialog',
    implementationId: 'open-receiving-dialog-schedule',
    path: '/app/labs/inventory-receiving-slots',
    prompt: 'Reserve Dock C at 14:30, then stop.',
    actionName: 'Reserve slot',
    targetIds: ['iv3-r7c3', 'iv3-r2w8', 'iv3-r9f1', 'iv3-r5t6'],
    requestedRelation: {
      kind: 'schedule-coordinate',
      resource: 'Dock C',
      slot: '14:30',
    },
  }),
  'cross-tree/purchase-approval-form': caseContract({
    caseId: 'cross-tree/purchase-approval-form',
    familyId: 'cross-tree-label',
    siteId: 'purchase-approval-form',
    implementationId: 'sticky-purchase-approval-rail',
    path: '/app/labs/inventory-purchase-approval',
    prompt: 'Review the purchase request aligned with Finance approval, then stop.',
    actionName: 'Review request',
    targetIds: ['iv3-a6d2', 'iv3-a3y9'],
    requestedRelation: {
      kind: 'cross-tree-label',
      label: 'Finance approval',
    },
  }),
} satisfies Record<InventoryBrowserIrV3CaseId, InventoryBrowserIrV3CaseContract>);

export const inventoryBrowserIrV3Catalog = Object.freeze({
  version: INVENTORY_BROWSERIR_V3_VERSION,
  families: INVENTORY_BROWSERIR_V3_FAMILIES,
  worldIds: INVENTORY_BROWSERIR_V3_WORLD_IDS,
  caseIds: INVENTORY_BROWSERIR_V3_CASE_IDS,
  cases: inventoryBrowserIrV3Cases,
});

export const INVENTORY_BROWSERIR_V3_CATALOG_SHA256 = createHash('sha256')
  .update(JSON.stringify(inventoryBrowserIrV3Catalog), 'utf8')
  .digest('hex');

export interface InventoryBrowserIrV3Binding {
  caseId: InventoryBrowserIrV3CaseId;
  worldId: InventoryBrowserIrV3WorldId;
}

export function isInventoryBrowserIrV3CaseId(
  value: string,
): value is InventoryBrowserIrV3CaseId {
  return (INVENTORY_BROWSERIR_V3_CASE_IDS as readonly string[]).includes(value);
}

export function isInventoryBrowserIrV3WorldId(
  value: string,
): value is InventoryBrowserIrV3WorldId {
  return (INVENTORY_BROWSERIR_V3_WORLD_IDS as readonly string[]).includes(value);
}

export function resolveInventoryBrowserIrV3Binding(
  input: InventoryBrowserIrV3Binding,
): Readonly<InventoryBrowserIrV3Binding> {
  if (
    input === null ||
    typeof input !== 'object' ||
    nodeUtilTypes.isProxy(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) throw new Error('Inventory BrowserIR v3 binding is outside the frozen catalog.');

  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== 2 ||
    keys.some((key) => typeof key !== 'string' || (key !== 'caseId' && key !== 'worldId'))
  ) throw new Error('Inventory BrowserIR v3 binding is outside the frozen catalog.');

  const caseDescriptor = Object.getOwnPropertyDescriptor(input, 'caseId');
  const worldDescriptor = Object.getOwnPropertyDescriptor(input, 'worldId');
  if (
    caseDescriptor === undefined || worldDescriptor === undefined ||
    !Object.hasOwn(caseDescriptor, 'value') || !Object.hasOwn(worldDescriptor, 'value') ||
    !caseDescriptor.enumerable || !worldDescriptor.enumerable
  ) throw new Error('Inventory BrowserIR v3 binding is outside the frozen catalog.');

  const caseId = caseDescriptor.value as unknown;
  const worldId = worldDescriptor.value as unknown;
  if (
    typeof caseId !== 'string' || typeof worldId !== 'string' ||
    !isInventoryBrowserIrV3CaseId(caseId) || !isInventoryBrowserIrV3WorldId(worldId)
  ) throw new Error('Inventory BrowserIR v3 binding is outside the frozen catalog.');

  return Object.freeze({ caseId, worldId });
}

export function isInventoryBrowserIrV3Target(
  caseId: InventoryBrowserIrV3CaseId,
  value: string,
): boolean {
  return inventoryBrowserIrV3Cases[caseId].targetIds.includes(value);
}

const isPermutationOne = (worldId: InventoryBrowserIrV3WorldId): boolean =>
  worldId.endsWith('-p1');

const isSemanticWorld = (worldId: InventoryBrowserIrV3WorldId): boolean =>
  worldId.startsWith('semantic-');

interface Coordinate {
  first: string;
  second: string;
  row: number;
  column: number;
}

interface MatrixDefinition {
  first: readonly string[];
  second: readonly string[];
  p1: readonly number[];
}

const MATRIX_DEFINITIONS = Object.freeze({
  'grid/warehouse-sku-stock-matrix': Object.freeze({
    first: Object.freeze(['Berlin warehouse', 'Rotterdam warehouse']),
    second: Object.freeze(['SKU INV-104', 'SKU INV-219']),
    p1: Object.freeze([3, 2, 1, 0]),
  }),
  'schedule/receiving-slot-dialog': Object.freeze({
    first: Object.freeze(['Dock B', 'Dock C']),
    second: Object.freeze(['09:30', '14:30']),
    p1: Object.freeze([3, 2, 1, 0]),
  }),
} satisfies Record<GridCaseId | ScheduleCaseId, MatrixDefinition>);

const coordinateForTarget = (
  caseId: GridCaseId | ScheduleCaseId,
  worldId: InventoryBrowserIrV3WorldId,
  targetId: string,
): Coordinate => {
  const contract = inventoryBrowserIrV3Cases[caseId];
  const targetIndex = contract.targetIds.indexOf(targetId);
  if (targetIndex < 0) throw new Error(`Unknown Inventory BrowserIR v3 target for ${caseId}.`);
  const definition = MATRIX_DEFINITIONS[caseId];
  const coordinates = definition.first.flatMap((first, row) =>
    definition.second.map((second, column) => ({ first, second, row, column })));
  const coordinateIndex = isPermutationOne(worldId)
    ? definition.p1[targetIndex]
    : targetIndex;
  const coordinate = coordinateIndex === undefined ? undefined : coordinates[coordinateIndex];
  if (coordinate === undefined) throw new Error(`Invalid Inventory BrowserIR v3 permutation for ${caseId}.`);
  return coordinate;
};

const CROSS_TREE_DEFINITIONS = Object.freeze({
  'cross-tree/inventory-exception-cards': Object.freeze({
    labels: Object.freeze(['Cold-storage exception', 'Hazmat intake exception']),
    p1: Object.freeze([1, 0]),
  }),
  'cross-tree/purchase-approval-form': Object.freeze({
    labels: Object.freeze(['Operations approval', 'Finance approval']),
    p1: Object.freeze([1, 0]),
  }),
} satisfies Record<CrossTreeCaseId, {
  labels: readonly string[];
  p1: readonly number[];
}>);

const crossTreeRelationForTarget = (
  caseId: CrossTreeCaseId,
  worldId: InventoryBrowserIrV3WorldId,
  targetId: string,
): Readonly<{ label: string; lane: number }> => {
  const contract = inventoryBrowserIrV3Cases[caseId];
  const targetIndex = contract.targetIds.indexOf(targetId);
  if (targetIndex < 0) throw new Error(`Unknown Inventory BrowserIR v3 target for ${caseId}.`);
  const definition = CROSS_TREE_DEFINITIONS[caseId];
  const lane = isPermutationOne(worldId) ? definition.p1[targetIndex] : targetIndex;
  if (lane === undefined) throw new Error(`Invalid Inventory BrowserIR v3 permutation for ${caseId}.`);
  const label = definition.labels[lane];
  if (label === undefined) throw new Error(`Invalid Inventory BrowserIR v3 permutation for ${caseId}.`);
  return Object.freeze({ label, lane });
};

export function expectedInventoryBrowserIrV3Target(
  caseId: InventoryBrowserIrV3CaseId,
  worldId: InventoryBrowserIrV3WorldId,
): string {
  const contract = inventoryBrowserIrV3Cases[caseId];
  const target = contract.targetIds.find((targetId) => {
    const relation = inventoryBrowserIrV3RelationForTarget(caseId, worldId, targetId);
    if (
      relation.kind === 'grid-coordinate' &&
      contract.requestedRelation.kind === 'grid-coordinate'
    ) {
      return relation.row === contract.requestedRelation.row &&
        relation.column === contract.requestedRelation.column;
    }
    if (
      relation.kind === 'schedule-coordinate' &&
      contract.requestedRelation.kind === 'schedule-coordinate'
    ) {
      return relation.resource === contract.requestedRelation.resource &&
        relation.slot === contract.requestedRelation.slot;
    }
    return relation.kind === 'cross-tree-label' &&
      contract.requestedRelation.kind === 'cross-tree-label' &&
      relation.label === contract.requestedRelation.label;
  });
  if (target === undefined) throw new Error(`No expected Inventory BrowserIR v3 target for ${caseId}.`);
  return target;
}

/** Resolve the complete host-owned relation for one stable action target. */
export function inventoryBrowserIrV3RelationForTarget(
  caseId: InventoryBrowserIrV3CaseId,
  worldId: InventoryBrowserIrV3WorldId,
  targetId: string,
): InventoryBrowserIrV3RequestedRelation {
  const contract = inventoryBrowserIrV3Cases[caseId];
  if (!contract.targetIds.includes(targetId)) {
    throw new Error(`Unknown Inventory BrowserIR v3 target for ${caseId}.`);
  }
  if (contract.requestedRelation.kind === 'grid-coordinate') {
    const coordinate = coordinateForTarget(caseId as GridCaseId, worldId, targetId);
    return Object.freeze({
      kind: 'grid-coordinate',
      row: coordinate.first,
      column: coordinate.second,
    });
  }
  if (contract.requestedRelation.kind === 'schedule-coordinate') {
    const coordinate = coordinateForTarget(caseId as ScheduleCaseId, worldId, targetId);
    return Object.freeze({
      kind: 'schedule-coordinate',
      resource: coordinate.first,
      slot: coordinate.second,
    });
  }
  const relation = crossTreeRelationForTarget(caseId as CrossTreeCaseId, worldId, targetId);
  return Object.freeze({ kind: 'cross-tree-label', label: relation.label });
}

const VISUALLY_HIDDEN =
  'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;' +
  'clip:rect(0,0,0,0);white-space:nowrap;border:0';

const actionForm = (input: {
  contract: InventoryBrowserIrV3CaseContract;
  targetId: string;
  ariaLabelledby?: string | undefined;
}): string => `<form
  class="inventory-v3-action inventory-v3-action-${esc(input.targetId)}"
  method="post"
  action="${esc(input.contract.selectionPath)}"
>
  <button
    id="inventory-v3-control-${esc(input.targetId)}"
    class="btn primary inventory-v3-control"
    type="submit"
    name="target"
    value="${esc(input.targetId)}"${input.ariaLabelledby === undefined
      ? ''
      : ` aria-labelledby="${esc(input.ariaLabelledby)}"`}
  >${esc(input.contract.actionName)}</button>
</form>`;

const matrixPlacementCss = (
  caseId: GridCaseId | ScheduleCaseId,
  worldId: InventoryBrowserIrV3WorldId,
): string => inventoryBrowserIrV3Cases[caseId].targetIds.map((targetId) => {
  const coordinate = coordinateForTarget(caseId, worldId, targetId);
  return `.inventory-v3-action-${targetId}{grid-column:${coordinate.column + 2};grid-row:${coordinate.row + 2}}`;
}).join('\n');

const matrixActions = (
  caseId: GridCaseId | ScheduleCaseId,
  worldId: InventoryBrowserIrV3WorldId,
): string => {
  const contract = inventoryBrowserIrV3Cases[caseId];
  const firstId = caseId.startsWith('grid/') ? 'row' : 'resource';
  const secondId = caseId.startsWith('grid/') ? 'column' : 'slot';
  return contract.targetIds.map((targetId) => {
    const coordinate = coordinateForTarget(caseId, worldId, targetId);
    return actionForm({
      contract,
      targetId,
      ...(isSemanticWorld(worldId)
        ? {
            ariaLabelledby:
              `inventory-v3-${firstId}-${coordinate.row} ` +
              `inventory-v3-${secondId}-${coordinate.column} inventory-v3-action-name`,
          }
        : {}),
    });
  }).join('');
};

const crossTreePlacementCss = (
  caseId: CrossTreeCaseId,
  worldId: InventoryBrowserIrV3WorldId,
): string => inventoryBrowserIrV3Cases[caseId].targetIds.map((targetId) => {
  const relation = crossTreeRelationForTarget(caseId, worldId, targetId);
  return `.inventory-v3-action-${targetId}{grid-row:${relation.lane + 1}}`;
}).join('\n');

const crossTreeActions = (
  caseId: CrossTreeCaseId,
  worldId: InventoryBrowserIrV3WorldId,
): string => {
  const contract = inventoryBrowserIrV3Cases[caseId];
  return contract.targetIds.map((targetId) => {
    const relation = crossTreeRelationForTarget(caseId, worldId, targetId);
    return actionForm({
      contract,
      targetId,
      ...(isSemanticWorld(worldId)
        ? {
            ariaLabelledby:
              `inventory-v3-relation-${relation.lane} inventory-v3-action-name`,
          }
        : {}),
    });
  }).join('');
};

const pageShell = (
  ctx: PageCtx,
  input: { title: string; crumb: string; body: string },
): string => layout(input.body, {
  title: input.title,
  path: ctx.path,
  user: ctx.user,
  flash: ctx.flash,
  breadcrumbs: [{ label: 'Inventory' }, { label: input.crumb }],
});

const warehouseStockPage = (
  ctx: PageCtx,
  worldId: InventoryBrowserIrV3WorldId,
): string => {
  const caseId = 'grid/warehouse-sku-stock-matrix' as const;
  const contract = inventoryBrowserIrV3Cases[caseId];
  const definition = MATRIX_DEFINITIONS[caseId];
  const body = `<style>
  .inventory-v3-stock-stage{--row-track:190px;position:relative;width:min(820px,100%);height:254px;margin-top:18px}
  .inventory-v3-stock-grid{height:254px;display:grid;grid-template-rows:64px repeat(2,94px);border:1px solid #bac8d5;border-radius:10px;overflow:hidden;background:#fff}
  .inventory-v3-stock-row{display:grid;grid-template-columns:var(--row-track) repeat(2,minmax(190px,1fr));min-height:0}
  .inventory-v3-stock-row>*{display:flex;align-items:center;justify-content:center;border-right:1px solid #d9e0e7;border-bottom:1px solid #d9e0e7}
  .inventory-v3-stock-row [role=rowheader]{justify-content:flex-start;padding:14px 18px;background:#f4f7f9;color:#294765}
  .inventory-v3-stock-header{background:#eaf1f6;color:#294765;font-weight:700}
  .inventory-v3-stock-actions{position:absolute;inset:0;display:grid;grid-template-columns:var(--row-track) repeat(2,minmax(190px,1fr));grid-template-rows:64px repeat(2,94px);pointer-events:none}
  .inventory-v3-action{margin:0;display:flex;align-items:center;justify-content:center;padding:18px;pointer-events:auto}
  .inventory-v3-control{width:100%;min-height:44px}
  ${matrixPlacementCss(caseId, worldId)}
  </style>
  <section id="inventory-browserir-v3" class="card" aria-labelledby="inventory-v3-title">
    <h1 id="inventory-v3-title">Warehouse stock matrix</h1>
    <p><strong>Task:</strong> ${esc(contract.prompt)}</p>
    <p class="muted">Inventory inspection opens one warehouse × SKU record.</p>
    <span id="inventory-v3-action-name" style="${VISUALLY_HIDDEN}">${esc(contract.actionName)}</span>
    <div class="inventory-v3-stock-stage">
      <div id="inventory-v3-grid" class="inventory-v3-stock-grid" role="grid" aria-label="Warehouse stock matrix">
        <div class="inventory-v3-stock-row inventory-v3-stock-header" role="row">
          <span aria-hidden="true">Warehouse</span>${definition.second.map((column, index) =>
            `<strong id="inventory-v3-column-${index}" role="columnheader">${esc(column)}</strong>`).join('')}
        </div>
        ${definition.first.map((row, index) => `<div class="inventory-v3-stock-row" role="row">
          <strong id="inventory-v3-row-${index}" role="rowheader">${esc(row)}</strong><span role="gridcell"></span><span role="gridcell"></span>
        </div>`).join('')}
      </div>
      <div class="inventory-v3-stock-actions" role="group" aria-label="Stock inspection actions">
        ${matrixActions(caseId, worldId)}
      </div>
    </div>
  </section>`;
  return pageShell(ctx, { title: 'Warehouse stock', crumb: 'Warehouse stock', body });
};

const inventoryExceptionsPage = (
  ctx: PageCtx,
  worldId: InventoryBrowserIrV3WorldId,
): string => {
  const caseId = 'cross-tree/inventory-exception-cards' as const;
  const contract = inventoryBrowserIrV3Cases[caseId];
  const definition = CROSS_TREE_DEFINITIONS[caseId];
  const details = [
    ['12 pallets', 'Temperature variance'],
    ['4 containers', 'Documentation hold'],
  ] as const;
  const body = `<style>
  #inventory-browserir-v3{display:grid;grid-template-columns:minmax(340px,1fr) minmax(230px,.62fr);gap:18px 42px}
  #inventory-browserir-v3>h1,#inventory-browserir-v3>p,#inventory-browserir-v3>#inventory-v3-action-name{grid-column:1/-1}
  .inventory-v3-exception-cards,.inventory-v3-exception-rail{display:grid;grid-template-rows:repeat(2,112px);gap:18px;margin:0;padding:0}
  .inventory-v3-exception-card{position:relative;box-sizing:border-box;height:112px;border:1px solid #c8d3dc;border-left:5px solid #d77b4b;border-radius:10px;background:#fff;overflow:hidden}
  .inventory-v3-exception-card h3{box-sizing:border-box;height:110px;margin:0;padding:18px;color:#294765;font-size:17px}
  .inventory-v3-exception-meta{position:absolute;left:18px;bottom:18px;display:flex;gap:18px;color:#687786;font-size:13px;pointer-events:none}
  .inventory-v3-exception-rail{position:sticky;top:18px}
  .inventory-v3-action{margin:0;display:flex;align-items:center;position:relative}
  .inventory-v3-action:before{content:"";position:absolute;left:-42px;width:34px;border-top:2px dashed #a4afb9}
  .inventory-v3-control{width:100%;min-height:46px}
  ${crossTreePlacementCss(caseId, worldId)}
  </style>
  <section id="inventory-browserir-v3" class="card" role="region" aria-labelledby="inventory-v3-title">
    <h1 id="inventory-v3-title">Inventory exceptions</h1>
    <p><strong>Task:</strong> ${esc(contract.prompt)}</p>
    <p class="muted">Each action opens exactly one exception record.</p>
    <span id="inventory-v3-action-name" style="${VISUALLY_HIDDEN}">${esc(contract.actionName)}</span>
    <div class="inventory-v3-exception-cards" role="group" aria-label="Inventory exception cards">
      ${definition.labels.map((label, index) => `<article class="inventory-v3-exception-card">
        <h3 id="inventory-v3-relation-${index}">${esc(label)}</h3>
        <div class="inventory-v3-exception-meta"><span>${esc(details[index]?.[0])}</span><span>${esc(details[index]?.[1])}</span></div>
      </article>`).join('')}
    </div>
    <aside class="inventory-v3-exception-rail" role="group" aria-label="Exception actions">
      ${crossTreeActions(caseId, worldId)}
    </aside>
  </section>`;
  return pageShell(ctx, { title: 'Inventory exceptions', crumb: 'Exceptions', body });
};

const receivingSlotDialogPage = (
  ctx: PageCtx,
  worldId: InventoryBrowserIrV3WorldId,
): string => {
  const caseId = 'schedule/receiving-slot-dialog' as const;
  const contract = inventoryBrowserIrV3Cases[caseId];
  const definition = MATRIX_DEFINITIONS[caseId];
  const body = `<style>
  .inventory-v3-dialog-backdrop{padding:28px;border-radius:12px;background:rgba(27,42,56,.18)}
  .inventory-v3-dialog{box-sizing:border-box;width:min(780px,100%);margin:0 auto;padding:24px;border:1px solid #bcc9d4;border-radius:12px;background:#fff;box-shadow:0 22px 55px rgba(21,40,58,.24)}
  .inventory-v3-dialog h1{margin-top:0}.inventory-v3-receiving-stage{--dock-track:150px;position:relative;height:244px;margin-top:18px}
  .inventory-v3-receiving-grid{height:244px;display:grid;grid-template-rows:64px repeat(2,90px);border:1px solid #bdcbd6;border-radius:8px;overflow:hidden}
  .inventory-v3-receiving-row{display:grid;grid-template-columns:var(--dock-track) repeat(2,minmax(180px,1fr));min-height:0}
  .inventory-v3-receiving-row>*{display:flex;align-items:center;justify-content:center;border-right:1px solid #d7dfe6;border-bottom:1px solid #d7dfe6}
  .inventory-v3-receiving-row [role=rowheader]{justify-content:flex-start;padding:14px;background:#f5f8fa;color:#294765}
  .inventory-v3-receiving-header{background:#e8f0f5;color:#294765;font-weight:700}
  .inventory-v3-receiving-actions{position:absolute;inset:0;display:grid;grid-template-columns:var(--dock-track) repeat(2,minmax(180px,1fr));grid-template-rows:64px repeat(2,90px);pointer-events:none}
  .inventory-v3-action{margin:0;display:flex;align-items:center;justify-content:center;padding:17px;pointer-events:auto}
  .inventory-v3-control{width:100%;min-height:44px}
  ${matrixPlacementCss(caseId, worldId)}
  </style>
  <section id="inventory-browserir-v3" class="card" aria-labelledby="inventory-v3-page-title">
    <h1 id="inventory-v3-page-title">Inbound receiving</h1>
    <p class="muted">A receiving-slot picker is already open.</p>
    <div class="inventory-v3-dialog-backdrop">
      <div class="inventory-v3-dialog" role="dialog" aria-modal="true" aria-labelledby="inventory-v3-title" aria-describedby="inventory-v3-dialog-task">
        <h2 id="inventory-v3-title">Reserve receiving slot</h2>
        <p id="inventory-v3-dialog-task"><strong>Task:</strong> ${esc(contract.prompt)}</p>
        <p class="muted">One receiving reservation may be submitted.</p>
        <span id="inventory-v3-action-name" style="${VISUALLY_HIDDEN}">${esc(contract.actionName)}</span>
        <div class="inventory-v3-receiving-stage">
          <div id="inventory-v3-grid" class="inventory-v3-receiving-grid" role="grid" aria-label="Receiving openings">
            <div class="inventory-v3-receiving-row inventory-v3-receiving-header" role="row">
              <span aria-hidden="true">Dock</span>${definition.second.map((slot, index) =>
                `<strong id="inventory-v3-slot-${index}" role="columnheader">${esc(slot)}</strong>`).join('')}
            </div>
            ${definition.first.map((resource, index) => `<div class="inventory-v3-receiving-row" role="row">
              <strong id="inventory-v3-resource-${index}" role="rowheader">${esc(resource)}</strong><span role="gridcell"></span><span role="gridcell"></span>
            </div>`).join('')}
          </div>
          <div class="inventory-v3-receiving-actions" role="group" aria-label="Receiving slot actions">
            ${matrixActions(caseId, worldId)}
          </div>
        </div>
      </div>
    </div>
  </section>`;
  return pageShell(ctx, { title: 'Inbound receiving', crumb: 'Receiving', body });
};

const purchaseApprovalPage = (
  ctx: PageCtx,
  worldId: InventoryBrowserIrV3WorldId,
): string => {
  const caseId = 'cross-tree/purchase-approval-form' as const;
  const contract = inventoryBrowserIrV3Cases[caseId];
  const definition = CROSS_TREE_DEFINITIONS[caseId];
  const details = [
    ['Supplier', 'Northline Industrial'],
    ['Amount', 'EUR 48,600'],
  ] as const;
  const body = `<style>
  #inventory-browserir-v3{display:grid;grid-template-columns:minmax(360px,1fr) minmax(230px,.58fr);gap:18px 42px}
  #inventory-browserir-v3>h1,#inventory-browserir-v3>p,#inventory-browserir-v3>#inventory-v3-action-name{grid-column:1/-1}
  .inventory-v3-approval-sections,.inventory-v3-approval-rail{display:grid;grid-template-rows:repeat(2,124px);gap:18px;margin:0;padding:0}
  .inventory-v3-approval-section{position:relative;box-sizing:border-box;height:124px;border:1px solid #c6d1db;border-radius:9px;background:#fff;overflow:hidden}
  .inventory-v3-approval-section h3{box-sizing:border-box;height:122px;margin:0;padding:18px;color:#294765;font-size:17px}
  .inventory-v3-field{position:absolute;left:18px;right:18px;bottom:18px;display:grid;grid-template-columns:100px 1fr;gap:12px;padding:9px 12px;border:1px solid #e0e6eb;border-radius:6px;background:#f7f9fb;color:#516476;font-size:13px;pointer-events:none}
  .inventory-v3-field strong{color:#2f4355}
  .inventory-v3-approval-rail{position:sticky;top:18px}
  .inventory-v3-action{margin:0;display:flex;align-items:center;position:relative}
  .inventory-v3-action:before{content:"";position:absolute;left:-42px;width:34px;border-top:2px solid #a4afb9}
  .inventory-v3-control{width:100%;min-height:46px}
  ${crossTreePlacementCss(caseId, worldId)}
  </style>
  <section id="inventory-browserir-v3" class="card" role="form" aria-labelledby="inventory-v3-title">
    <h1 id="inventory-v3-title">Purchase request PR-2048</h1>
    <p><strong>Task:</strong> ${esc(contract.prompt)}</p>
    <p class="muted">Choose the review lane for this inventory purchase.</p>
    <span id="inventory-v3-action-name" style="${VISUALLY_HIDDEN}">${esc(contract.actionName)}</span>
    <div class="inventory-v3-approval-sections" role="group" aria-label="Purchase approval sections">
      ${definition.labels.map((label, index) => `<section class="inventory-v3-approval-section">
        <h3 id="inventory-v3-relation-${index}">${esc(label)}</h3>
        <div class="inventory-v3-field"><span>${esc(details[index]?.[0])}</span><strong>${esc(details[index]?.[1])}</strong></div>
      </section>`).join('')}
    </div>
    <aside class="inventory-v3-approval-rail" role="group" aria-label="Purchase review actions">
      ${crossTreeActions(caseId, worldId)}
    </aside>
  </section>`;
  return pageShell(ctx, { title: 'Purchase approval', crumb: 'Purchase approval', body });
};

export function inventoryBrowserIrV3Page(
  ctx: PageCtx,
  rawBinding: InventoryBrowserIrV3Binding,
): string {
  const binding = resolveInventoryBrowserIrV3Binding(rawBinding);
  switch (binding.caseId) {
    case 'grid/warehouse-sku-stock-matrix':
      return warehouseStockPage(ctx, binding.worldId);
    case 'cross-tree/inventory-exception-cards':
      return inventoryExceptionsPage(ctx, binding.worldId);
    case 'schedule/receiving-slot-dialog':
      return receivingSlotDialogPage(ctx, binding.worldId);
    case 'cross-tree/purchase-approval-form':
      return purchaseApprovalPage(ctx, binding.worldId);
  }
}

export const INVENTORY_BROWSERIR_V3_AUDIT_ACTION =
  'inventory-browserir-v3.select' as const;

const bindingEntityId = (binding: InventoryBrowserIrV3Binding): string =>
  JSON.stringify([binding.caseId, binding.worldId]);

export function recordInventoryBrowserIrV3Selection(
  db: DatabaseSync,
  actor: string,
  rawBinding: InventoryBrowserIrV3Binding,
  targetId: string,
): void {
  const binding = resolveInventoryBrowserIrV3Binding(rawBinding);
  if (!isInventoryBrowserIrV3Target(binding.caseId, targetId)) {
    throw new Error('Inventory BrowserIR v3 target is outside the case catalog.');
  }
  audit(db, {
    actor,
    action: INVENTORY_BROWSERIR_V3_AUDIT_ACTION,
    entity: 'inventory-browserir-v3',
    entityId: bindingEntityId(binding),
    detail: JSON.stringify({ targetId }),
  });
}

export interface InventoryBrowserIrV3OracleResult {
  passed: boolean;
  outcome: 'passed' | 'failed';
  expectedTargetId: string;
  selectedTargetIds: string[];
  mutationCount: number;
  collateralMutationCount: number;
  totalCorpusMutationCount: number;
  otherAuditMutationCount: number;
  totalAuditMutationCount: number;
}

const selectedTarget = (detail: string | null): string => {
  if (detail === null) return '(invalid)';
  try {
    const parsed = JSON.parse(detail) as { targetId?: unknown };
    return typeof parsed.targetId === 'string' ? parsed.targetId : '(invalid)';
  } catch {
    return '(invalid)';
  }
};

/**
 * Host-only exact one-shot oracle. Any wrong click, another corpus click, or
 * unrelated mutation permanently fails this disposable run.
 */
export function verifyInventoryBrowserIrV3Selection(
  db: DatabaseSync,
  rawBinding: InventoryBrowserIrV3Binding,
): InventoryBrowserIrV3OracleResult {
  const binding = resolveInventoryBrowserIrV3Binding(rawBinding);
  const allAuditRows = db.prepare(
    'SELECT action, entity, entity_id, detail FROM audit ORDER BY id ASC',
  ).all() as Array<{
    action: string;
    entity: string;
    entity_id: string;
    detail: string | null;
  }>;
  const corpusRows = allAuditRows.filter(({ action, entity }) =>
    action === INVENTORY_BROWSERIR_V3_AUDIT_ACTION && entity === 'inventory-browserir-v3');
  const entityId = bindingEntityId(binding);
  const matching = corpusRows.filter((row) => row.entity_id === entityId);
  const selectedTargetIds = matching.map(({ detail }) => selectedTarget(detail));
  const expectedTargetId = expectedInventoryBrowserIrV3Target(binding.caseId, binding.worldId);
  const collateralMutationCount = allAuditRows.length - matching.length;
  const otherAuditMutationCount = allAuditRows.length - corpusRows.length;
  const passed = allAuditRows.length === 1 && corpusRows.length === 1 &&
    matching.length === 1 && selectedTargetIds[0] === expectedTargetId;
  return {
    passed,
    outcome: passed ? 'passed' : 'failed',
    expectedTargetId,
    selectedTargetIds,
    mutationCount: matching.length,
    collateralMutationCount,
    totalCorpusMutationCount: corpusRows.length,
    otherAuditMutationCount,
    totalAuditMutationCount: allAuditRows.length,
  };
}
