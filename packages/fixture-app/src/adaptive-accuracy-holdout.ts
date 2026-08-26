import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { types as nodeUtilTypes } from 'node:util';

import { audit } from './db.js';
import type { PageCtx } from './pages.js';
import { esc, layout } from './views.js';
import {
  adaptiveQualificationStudyPage,
  type AdaptiveQualificationStudyCaseId,
  type AdaptiveQualificationStudyWorldId,
} from './adaptive-qualification-studies.js';

export const ADAPTIVE_ACCURACY_HOLDOUT_VERSION =
  'browser-ir-accuracy-holdout/2' as const;

export const ADAPTIVE_ACCURACY_HOLDOUT_FAMILIES = Object.freeze([
  'schedule-coordinate',
  'cross-tree-label',
] as const);

export type AdaptiveAccuracyHoldoutFamily =
  (typeof ADAPTIVE_ACCURACY_HOLDOUT_FAMILIES)[number];

export const ADAPTIVE_ACCURACY_HOLDOUT_WORLD_IDS = Object.freeze([
  'opaque-p0',
  'opaque-p1',
  'semantic-p0',
  'semantic-p1',
] as const);

export type AdaptiveAccuracyHoldoutWorldId =
  (typeof ADAPTIVE_ACCURACY_HOLDOUT_WORLD_IDS)[number];

export const ADAPTIVE_ACCURACY_HOLDOUT_CASE_IDS = Object.freeze([
  'schedule/clinic-imaging-board',
  'schedule/harbor-maintenance-rail',
  'cross-tree/catalog-localization-queues',
  'cross-tree/storage-intake-lanes',
  'schedule/workshop-week-table',
  'schedule/dispatch-shift-board',
  'cross-tree/case-routing-columns',
  'cross-tree/approval-lanes',
] as const);

export type AdaptiveAccuracyHoldoutCaseId =
  (typeof ADAPTIVE_ACCURACY_HOLDOUT_CASE_IDS)[number];

type ScheduleHoldoutCaseId = Extract<AdaptiveAccuracyHoldoutCaseId, `schedule/${string}`>;
type CrossTreeHoldoutCaseId = Extract<AdaptiveAccuracyHoldoutCaseId, `cross-tree/${string}`>;

export type AdaptiveAccuracyHoldoutRequestedRelation =
  | Readonly<{
      kind: 'schedule-coordinate';
      resource: string;
      slot: string;
    }>
  | Readonly<{
      kind: 'cross-tree-label';
      label: string;
    }>;

export interface AdaptiveAccuracyHoldoutCaseContract {
  caseId: AdaptiveAccuracyHoldoutCaseId;
  familyId: AdaptiveAccuracyHoldoutFamily;
  siteId: string;
  implementationId: string;
  path: string;
  selectionPath: string;
  prompt: string;
  actionName: string;
  targetIds: readonly string[];
  requestedRelation: AdaptiveAccuracyHoldoutRequestedRelation;
  worldIds: typeof ADAPTIVE_ACCURACY_HOLDOUT_WORLD_IDS;
}

const caseContract = (
  input: Omit<AdaptiveAccuracyHoldoutCaseContract, 'selectionPath' | 'worldIds'>,
): AdaptiveAccuracyHoldoutCaseContract => Object.freeze({
  ...input,
  selectionPath: `${input.path}/select`,
  targetIds: Object.freeze([...input.targetIds]),
  requestedRelation: Object.freeze({ ...input.requestedRelation }),
  worldIds: ADAPTIVE_ACCURACY_HOLDOUT_WORLD_IDS,
});

export const adaptiveAccuracyHoldoutCases = Object.freeze({
  'schedule/clinic-imaging-board': caseContract({
    caseId: 'schedule/clinic-imaging-board',
    familyId: 'schedule-coordinate',
    siteId: 'clinic-imaging-board',
    implementationId: 'native-clinic-imaging-table',
    path: '/app/labs/holdout-clinic-imaging',
    prompt: 'Choose the open imaging slot for CT Suite on Thursday 10:40, then stop.',
    actionName: 'Choose opening',
    targetIds: ['ci-b7q2', 'ci-f4m9', 'ci-k8v1', 'ci-r3n6', 'ci-u6d5', 'ci-z1p4'],
    requestedRelation: {
      kind: 'schedule-coordinate',
      resource: 'CT Suite',
      slot: 'Thursday 10:40',
    },
  }),
  'schedule/harbor-maintenance-rail': caseContract({
    caseId: 'schedule/harbor-maintenance-rail',
    familyId: 'schedule-coordinate',
    siteId: 'harbor-maintenance-rail',
    implementationId: 'rtl-harbor-maintenance-grid',
    path: '/app/labs/holdout-harbor-maintenance',
    prompt: 'Reserve maintenance for West service rail at 11:30, then stop.',
    actionName: 'Reserve window',
    targetIds: ['hm-c2w7', 'hm-g9a4', 'hm-l5r8', 'hm-q1x6', 'hm-t7k3', 'hm-y4n9'],
    requestedRelation: {
      kind: 'schedule-coordinate',
      resource: 'West service rail',
      slot: '11:30',
    },
  }),
  'cross-tree/catalog-localization-queues': caseContract({
    caseId: 'cross-tree/catalog-localization-queues',
    familyId: 'cross-tree-label',
    siteId: 'catalog-localization-queues',
    implementationId: 'mirrored-variable-height-localization-columns',
    path: '/app/labs/holdout-localization-queues',
    prompt: 'Open the batch aligned with German catalog queue, then stop.',
    actionName: 'Open batch',
    targetIds: ['lq-d8p2', 'lq-m3v7'],
    requestedRelation: {
      kind: 'cross-tree-label',
      label: 'German catalog queue',
    },
  }),
  'cross-tree/storage-intake-lanes': caseContract({
    caseId: 'cross-tree/storage-intake-lanes',
    familyId: 'cross-tree-label',
    siteId: 'storage-intake-lanes',
    implementationId: 'staggered-storage-intake-lanes',
    path: '/app/labs/holdout-storage-intake',
    prompt: 'Inspect the load aligned with Cold-chain intake, then stop.',
    actionName: 'Inspect load',
    targetIds: ['si-f9k2', 'si-n4q8'],
    requestedRelation: {
      kind: 'cross-tree-label',
      label: 'Cold-chain intake',
    },
  }),
  'schedule/workshop-week-table': caseContract({
    caseId: 'schedule/workshop-week-table',
    familyId: 'schedule-coordinate',
    siteId: 'workshop-week-table',
    implementationId: 'native-workshop-week-table',
    path: '/app/labs/adaptive-schedule-workshop',
    prompt: 'Choose the open slot for Bay 4 on Tuesday 09:30, then stop.',
    actionName: 'Choose open slot',
    targetIds: ['ws-k7p2', 'ws-r4m9', 'ws-v8q1', 'ws-x3n6'],
    requestedRelation: {
      kind: 'schedule-coordinate',
      resource: 'Bay 4',
      slot: 'Tuesday 09:30',
    },
  }),
  'schedule/dispatch-shift-board': caseContract({
    caseId: 'schedule/dispatch-shift-board',
    familyId: 'schedule-coordinate',
    siteId: 'dispatch-shift-board',
    implementationId: 'aria-dispatch-shift-board',
    path: '/app/labs/adaptive-dispatch-shifts',
    prompt: 'Assign the South crew to the 14:00 shift, then stop.',
    actionName: 'Assign shift',
    targetIds: ['ds-b6t4', 'ds-h2w8', 'ds-p9c3', 'ds-z5j7'],
    requestedRelation: {
      kind: 'schedule-coordinate',
      resource: 'South crew',
      slot: '14:00',
    },
  }),
  'cross-tree/case-routing-columns': caseContract({
    caseId: 'cross-tree/case-routing-columns',
    familyId: 'cross-tree-label',
    siteId: 'case-routing-columns',
    implementationId: 'case-routing-parallel-columns',
    path: '/app/labs/adaptive-case-routing',
    prompt: 'Open the case aligned with the Routine queue, then stop.',
    actionName: 'Open case',
    targetIds: ['cr-d7m2', 'cr-q4v8'],
    requestedRelation: {
      kind: 'cross-tree-label',
      label: 'Routine queue',
    },
  }),
  'cross-tree/approval-lanes': caseContract({
    caseId: 'cross-tree/approval-lanes',
    familyId: 'cross-tree-label',
    siteId: 'approval-lanes',
    implementationId: 'approval-description-list-lanes',
    path: '/app/labs/adaptive-approval-lanes',
    prompt: 'Review the request aligned with Finance review, then stop.',
    actionName: 'Review request',
    targetIds: ['al-f6p1', 'al-y9k3'],
    requestedRelation: {
      kind: 'cross-tree-label',
      label: 'Finance review',
    },
  }),
} satisfies Record<AdaptiveAccuracyHoldoutCaseId, AdaptiveAccuracyHoldoutCaseContract>);

export const adaptiveAccuracyHoldoutCatalog = Object.freeze({
  version: ADAPTIVE_ACCURACY_HOLDOUT_VERSION,
  families: ADAPTIVE_ACCURACY_HOLDOUT_FAMILIES,
  worldIds: ADAPTIVE_ACCURACY_HOLDOUT_WORLD_IDS,
  caseIds: ADAPTIVE_ACCURACY_HOLDOUT_CASE_IDS,
  cases: adaptiveAccuracyHoldoutCases,
});

/** SHA-256 of the exact UTF-8 JSON serialization of `adaptiveAccuracyHoldoutCatalog`. */
export const ADAPTIVE_ACCURACY_HOLDOUT_CATALOG_SHA256 = createHash('sha256')
  .update(JSON.stringify(adaptiveAccuracyHoldoutCatalog), 'utf8')
  .digest('hex');

export interface AdaptiveAccuracyHoldoutBinding {
  caseId: AdaptiveAccuracyHoldoutCaseId;
  worldId: AdaptiveAccuracyHoldoutWorldId;
}

export function isAdaptiveAccuracyHoldoutCaseId(
  value: string,
): value is AdaptiveAccuracyHoldoutCaseId {
  return (ADAPTIVE_ACCURACY_HOLDOUT_CASE_IDS as readonly string[]).includes(value);
}

export function isAdaptiveAccuracyHoldoutWorldId(
  value: string,
): value is AdaptiveAccuracyHoldoutWorldId {
  return (ADAPTIVE_ACCURACY_HOLDOUT_WORLD_IDS as readonly string[]).includes(value);
}

export function resolveAdaptiveAccuracyHoldoutBinding(
  input: AdaptiveAccuracyHoldoutBinding,
): Readonly<AdaptiveAccuracyHoldoutBinding> {
  if (
    input === null ||
    typeof input !== 'object' ||
    nodeUtilTypes.isProxy(input)
  ) {
    throw new Error('Adaptive accuracy holdout binding is outside the frozen catalog.');
  }
  if (Object.getPrototypeOf(input) !== Object.prototype) {
    throw new Error('Adaptive accuracy holdout binding is outside the frozen catalog.');
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== 2 ||
    keys.some((key) =>
      typeof key !== 'string' || (key !== 'caseId' && key !== 'worldId'))
  ) {
    throw new Error('Adaptive accuracy holdout binding is outside the frozen catalog.');
  }
  const caseIdDescriptor = Object.getOwnPropertyDescriptor(input, 'caseId');
  const worldIdDescriptor = Object.getOwnPropertyDescriptor(input, 'worldId');
  if (
    caseIdDescriptor === undefined ||
    worldIdDescriptor === undefined ||
    !Object.hasOwn(caseIdDescriptor, 'value') ||
    !Object.hasOwn(worldIdDescriptor, 'value') ||
    !caseIdDescriptor.enumerable ||
    !worldIdDescriptor.enumerable
  ) {
    throw new Error('Adaptive accuracy holdout binding is outside the frozen catalog.');
  }
  const caseId = caseIdDescriptor.value as unknown;
  const worldId = worldIdDescriptor.value as unknown;
  if (
    typeof caseId !== 'string' ||
    typeof worldId !== 'string' ||
    !isAdaptiveAccuracyHoldoutCaseId(caseId) ||
    !isAdaptiveAccuracyHoldoutWorldId(worldId)
  ) {
    throw new Error('Adaptive accuracy holdout binding is outside the frozen catalog.');
  }
  return Object.freeze({ caseId, worldId });
}

export function isAdaptiveAccuracyHoldoutTarget(
  caseId: AdaptiveAccuracyHoldoutCaseId,
  value: string,
): boolean {
  return adaptiveAccuracyHoldoutCases[caseId].targetIds.includes(value);
}

const isPermutationOne = (worldId: AdaptiveAccuracyHoldoutWorldId): boolean =>
  worldId.endsWith('-p1');

const isSemanticWorld = (worldId: AdaptiveAccuracyHoldoutWorldId): boolean =>
  worldId.startsWith('semantic-');

interface ScheduleCoordinate {
  resource: string;
  slot: string;
  row: number;
  column: number;
}

interface ScheduleDefinition {
  resources: readonly string[];
  slots: readonly string[];
  p1: readonly number[];
}

const SCHEDULE_DEFINITIONS = Object.freeze({
  'schedule/clinic-imaging-board': Object.freeze({
    resources: Object.freeze(['MRI Suite', 'CT Suite', 'Ultrasound Suite']),
    slots: Object.freeze(['Thursday 08:20', 'Thursday 10:40']),
    p1: Object.freeze([5, 2, 0, 4, 1, 3]),
  }),
  'schedule/harbor-maintenance-rail': Object.freeze({
    resources: Object.freeze(['East service rail', 'West service rail']),
    slots: Object.freeze(['06:40', '11:30', '16:20']),
    p1: Object.freeze([2, 4, 1, 5, 0, 3]),
  }),
  'schedule/workshop-week-table': Object.freeze({
    resources: Object.freeze(['Bay 2', 'Bay 4']),
    slots: Object.freeze(['Monday 09:30', 'Tuesday 09:30']),
    p1: Object.freeze([3, 2, 1, 0]),
  }),
  'schedule/dispatch-shift-board': Object.freeze({
    resources: Object.freeze(['North crew', 'South crew']),
    slots: Object.freeze(['06:00', '14:00']),
    p1: Object.freeze([3, 2, 1, 0]),
  }),
} satisfies Record<ScheduleHoldoutCaseId, ScheduleDefinition>);

const scheduleCoordinateForTarget = (
  caseId: ScheduleHoldoutCaseId,
  worldId: AdaptiveAccuracyHoldoutWorldId,
  targetId: string,
): ScheduleCoordinate => {
  const study = adaptiveAccuracyHoldoutCases[caseId];
  const targetIndex = study.targetIds.indexOf(targetId);
  if (targetIndex < 0) throw new Error(`Unknown holdout target for ${caseId}.`);
  const definition = SCHEDULE_DEFINITIONS[caseId];
  const coordinates = definition.resources.flatMap((resource, row) =>
    definition.slots.map((slot, column) => ({ resource, slot, row, column })));
  const coordinateIndex = isPermutationOne(worldId)
    ? definition.p1[targetIndex]
    : targetIndex;
  const coordinate = coordinateIndex === undefined ? undefined : coordinates[coordinateIndex];
  if (coordinate === undefined) throw new Error(`Invalid holdout permutation for ${caseId}.`);
  return coordinate;
};

interface CrossTreeDefinition {
  labels: readonly string[];
  p1: readonly number[];
}

const CROSS_TREE_DEFINITIONS = Object.freeze({
  'cross-tree/catalog-localization-queues': Object.freeze({
    labels: Object.freeze([
      'Japanese catalog queue',
      'German catalog queue',
    ]),
    p1: Object.freeze([1, 0]),
  }),
  'cross-tree/storage-intake-lanes': Object.freeze({
    labels: Object.freeze(['Oversize intake', 'Cold-chain intake']),
    p1: Object.freeze([1, 0]),
  }),
  'cross-tree/case-routing-columns': Object.freeze({
    labels: Object.freeze(['Urgent queue', 'Routine queue']),
    p1: Object.freeze([1, 0]),
  }),
  'cross-tree/approval-lanes': Object.freeze({
    labels: Object.freeze(['Security review', 'Finance review']),
    p1: Object.freeze([1, 0]),
  }),
} satisfies Record<CrossTreeHoldoutCaseId, CrossTreeDefinition>);

const crossTreeRelationForTarget = (
  caseId: CrossTreeHoldoutCaseId,
  worldId: AdaptiveAccuracyHoldoutWorldId,
  targetId: string,
): Readonly<{ label: string; lane: number }> => {
  const study = adaptiveAccuracyHoldoutCases[caseId];
  const targetIndex = study.targetIds.indexOf(targetId);
  if (targetIndex < 0) throw new Error(`Unknown holdout target for ${caseId}.`);
  const definition = CROSS_TREE_DEFINITIONS[caseId];
  const lane = isPermutationOne(worldId) ? definition.p1[targetIndex] : targetIndex;
  if (lane === undefined) throw new Error(`Invalid holdout permutation for ${caseId}.`);
  const label = definition.labels[lane];
  if (label === undefined) throw new Error(`Invalid holdout permutation for ${caseId}.`);
  return Object.freeze({ label, lane });
};

export function expectedAdaptiveAccuracyHoldoutTarget(
  caseId: AdaptiveAccuracyHoldoutCaseId,
  worldId: AdaptiveAccuracyHoldoutWorldId,
): string {
  const study = adaptiveAccuracyHoldoutCases[caseId];
  const target = study.targetIds.find((targetId) => {
    if (study.requestedRelation.kind === 'schedule-coordinate') {
      const coordinate = scheduleCoordinateForTarget(
        caseId as ScheduleHoldoutCaseId,
        worldId,
        targetId,
      );
      return coordinate.resource === study.requestedRelation.resource &&
        coordinate.slot === study.requestedRelation.slot;
    }
    return crossTreeRelationForTarget(
      caseId as CrossTreeHoldoutCaseId,
      worldId,
      targetId,
    ).label === study.requestedRelation.label;
  });
  if (target === undefined) throw new Error(`No expected holdout target for ${caseId}.`);
  return target;
}

const VISUALLY_HIDDEN =
  'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;' +
  'clip:rect(0,0,0,0);white-space:nowrap;border:0';

const actionForm = (input: {
  contract: AdaptiveAccuracyHoldoutCaseContract;
  targetId: string;
  ariaLabelledby?: string | undefined;
}): string => `<form
  class="accuracy-holdout-action accuracy-holdout-action-${esc(input.targetId)}"
  method="post"
  action="${esc(input.contract.selectionPath)}"
>
  <button
    id="accuracy-holdout-control-${esc(input.targetId)}"
    class="btn primary accuracy-holdout-control"
    type="submit"
    name="target"
    value="${esc(input.targetId)}"${input.ariaLabelledby === undefined
      ? ''
      : ` aria-labelledby="${esc(input.ariaLabelledby)}"`}
  >${esc(input.contract.actionName)}</button>
</form>`;

const schedulePlacementCss = (
  caseId: ScheduleHoldoutCaseId,
  worldId: AdaptiveAccuracyHoldoutWorldId,
): string => adaptiveAccuracyHoldoutCases[caseId].targetIds.map((targetId) => {
  const coordinate = scheduleCoordinateForTarget(caseId, worldId, targetId);
  return `.accuracy-holdout-action-${targetId}{grid-column:${coordinate.column + 2};grid-row:${coordinate.row + 2}}`;
}).join('\n');

const scheduleActions = (
  caseId: ScheduleHoldoutCaseId,
  worldId: AdaptiveAccuracyHoldoutWorldId,
): string => {
  const study = adaptiveAccuracyHoldoutCases[caseId];
  return study.targetIds.map((targetId) => {
    const coordinate = scheduleCoordinateForTarget(caseId, worldId, targetId);
    return actionForm({
      contract: study,
      targetId,
      ...(isSemanticWorld(worldId)
        ? {
            ariaLabelledby:
              `accuracy-holdout-resource-${coordinate.row} ` +
              `accuracy-holdout-slot-${coordinate.column} accuracy-holdout-action-name`,
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
  breadcrumbs: [{ label: 'Labs' }, { label: input.crumb }],
});

const clinicImagingPage = (
  ctx: PageCtx,
  worldId: AdaptiveAccuracyHoldoutWorldId,
): string => {
  const caseId = 'schedule/clinic-imaging-board' as const;
  const study = adaptiveAccuracyHoldoutCases[caseId];
  const definition = SCHEDULE_DEFINITIONS[caseId];
  const body = `<style>
  .holdout-clinic-stage{--resource-track:170px;position:relative;width:min(820px,100%);height:288px;margin-top:18px}
  .holdout-clinic-table{width:100%;height:288px;table-layout:fixed;border-collapse:collapse;background:#fff}
  .holdout-clinic-table th,.holdout-clinic-table td{border:1px solid #c7d4df}
  .holdout-clinic-table thead{height:60px}.holdout-clinic-table tbody tr{height:76px}
  .holdout-clinic-table th{padding:10px;color:#294765;background:#f2f7fa}
  .holdout-clinic-table col:first-child{width:var(--resource-track)}
  .holdout-clinic-actions{position:absolute;inset:0;display:grid;grid-template-columns:var(--resource-track) repeat(2,minmax(0,1fr));grid-template-rows:60px repeat(3,76px);pointer-events:none}
  .accuracy-holdout-action{margin:0;display:flex;align-items:center;justify-content:center;padding:13px;pointer-events:auto}
  .accuracy-holdout-control{width:100%;min-height:44px}
  ${schedulePlacementCss(caseId, worldId)}
  </style>
  <section id="adaptive-accuracy-holdout" class="card" aria-labelledby="accuracy-holdout-title">
    <h1 id="accuracy-holdout-title">Clinic imaging board</h1>
    <p><strong>Task:</strong> ${esc(study.prompt)}</p>
    <p class="muted">One imaging opening may be submitted.</p>
    ${isSemanticWorld(worldId)
      ? `<span id="accuracy-holdout-action-name" style="${VISUALLY_HIDDEN}">${esc(study.actionName)}</span>`
      : ''}
    <div class="holdout-clinic-stage">
      <table class="holdout-clinic-table" aria-label="Clinic imaging openings">
        <colgroup><col><col span="2"></colgroup>
        <thead><tr><td aria-hidden="true">Suite</td>${definition.slots.map((slot, index) =>
          `<th id="accuracy-holdout-slot-${index}" role="columnheader">${esc(slot)}</th>`).join('')}</tr></thead>
        <tbody>${definition.resources.map((resource, index) =>
          `<tr><th id="accuracy-holdout-resource-${index}" role="rowheader">${esc(resource)}</th><td></td><td></td></tr>`).join('')}</tbody>
      </table>
      <div class="holdout-clinic-actions" role="group" aria-label="Available imaging actions">
        ${scheduleActions(caseId, worldId)}
      </div>
    </div>
  </section>`;
  return pageShell(ctx, { title: 'Clinic imaging', crumb: 'Clinic imaging', body });
};

const harborMaintenancePage = (
  ctx: PageCtx,
  worldId: AdaptiveAccuracyHoldoutWorldId,
): string => {
  const caseId = 'schedule/harbor-maintenance-rail' as const;
  const study = adaptiveAccuracyHoldoutCases[caseId];
  const definition = SCHEDULE_DEFINITIONS[caseId];
  const body = `<style>
  .holdout-harbor-stage{position:relative;width:min(900px,100%);height:248px;margin-top:18px}
  .holdout-harbor-grid{height:248px;display:grid;grid-template-rows:60px repeat(2,94px);border:1px solid #9eb0bf;border-radius:8px;overflow:hidden;background:#fff;direction:rtl}
  .holdout-harbor-row{display:grid;grid-template-columns:170px repeat(3,minmax(150px,1fr));min-height:0}
  .holdout-harbor-row>*{direction:ltr;display:flex;align-items:center;justify-content:center;border-left:1px solid #d4dde5;border-bottom:1px solid #d4dde5}
  .holdout-harbor-row [role=rowheader]{padding:12px;background:#eef5f7;color:#294765}
  .holdout-harbor-header{background:#dfeef2;color:#294765;font-weight:650}
  .holdout-harbor-actions{position:absolute;inset:0;display:grid;grid-template-columns:170px repeat(3,minmax(150px,1fr));grid-template-rows:60px repeat(2,94px);direction:rtl;pointer-events:none}
  .accuracy-holdout-action{direction:ltr;margin:0;display:flex;align-items:center;justify-content:center;padding:14px;pointer-events:auto}
  .accuracy-holdout-control{width:100%;min-height:44px}
  ${schedulePlacementCss(caseId, worldId)}
  </style>
  <section id="adaptive-accuracy-holdout" class="card" aria-labelledby="accuracy-holdout-title">
    <h1 id="accuracy-holdout-title">Harbor maintenance rail</h1>
    <p><strong>Task:</strong> ${esc(study.prompt)}</p>
    <p class="muted">Maintenance reservations are committed immediately.</p>
    ${isSemanticWorld(worldId)
      ? `<span id="accuracy-holdout-action-name" style="${VISUALLY_HIDDEN}">${esc(study.actionName)}</span>`
      : ''}
    <div class="holdout-harbor-stage">
      <div class="holdout-harbor-grid" role="grid" aria-label="Harbor maintenance openings">
        <div class="holdout-harbor-row holdout-harbor-header" role="row">
          <span aria-hidden="true">Rail</span>${definition.slots.map((slot, index) =>
            `<strong id="accuracy-holdout-slot-${index}" role="columnheader">${esc(slot)}</strong>`).join('')}
        </div>
        ${definition.resources.map((resource, index) => `<div class="holdout-harbor-row" role="row">
          <strong id="accuracy-holdout-resource-${index}" role="rowheader">${esc(resource)}</strong><span role="gridcell"></span><span role="gridcell"></span><span role="gridcell"></span>
        </div>`).join('')}
      </div>
      <aside class="holdout-harbor-actions" role="group" aria-label="Available maintenance actions">
        ${scheduleActions(caseId, worldId)}
      </aside>
    </div>
  </section>`;
  return pageShell(ctx, { title: 'Harbor maintenance', crumb: 'Harbor maintenance', body });
};

const crossTreePlacementCss = (
  caseId: CrossTreeHoldoutCaseId,
  worldId: AdaptiveAccuracyHoldoutWorldId,
  laneToGridRow: (lane: number) => number = (lane) => lane + 1,
): string => adaptiveAccuracyHoldoutCases[caseId].targetIds.map((targetId) => {
  const relation = crossTreeRelationForTarget(caseId, worldId, targetId);
  return `.accuracy-holdout-action-${targetId}{grid-row:${laneToGridRow(relation.lane)}}`;
}).join('\n');

const crossTreeActions = (
  caseId: CrossTreeHoldoutCaseId,
  worldId: AdaptiveAccuracyHoldoutWorldId,
): string => {
  const study = adaptiveAccuracyHoldoutCases[caseId];
  return study.targetIds.map((targetId) => {
    const relation = crossTreeRelationForTarget(caseId, worldId, targetId);
    return actionForm({
      contract: study,
      targetId,
      ...(isSemanticWorld(worldId)
        ? {
            ariaLabelledby:
              `accuracy-holdout-relation-${relation.lane} accuracy-holdout-action-name`,
          }
        : {}),
    });
  }).join('');
};

const localizationQueuesPage = (
  ctx: PageCtx,
  worldId: AdaptiveAccuracyHoldoutWorldId,
): string => {
  const caseId = 'cross-tree/catalog-localization-queues' as const;
  const study = adaptiveAccuracyHoldoutCases[caseId];
  const definition = CROSS_TREE_DEFINITIONS[caseId];
  const mirrored = isPermutationOne(worldId);
  const body = `<style>
  #adaptive-accuracy-holdout{display:grid;grid-template-columns:minmax(310px,1fr) minmax(230px,.72fr);gap:18px 42px}
  #adaptive-accuracy-holdout>h1,#adaptive-accuracy-holdout>p,#adaptive-accuracy-holdout>#accuracy-holdout-action-name{grid-column:1/-1}
  .holdout-localization-labels,.holdout-localization-actions{display:grid;grid-template-rows:78px 124px;gap:21px;margin:0;padding:0}
  .holdout-localization-labels{grid-column:${mirrored ? 2 : 1}}
  .holdout-localization-actions{grid-column:${mirrored ? 1 : 2};list-style:none}
  .holdout-localization-label{box-sizing:border-box;height:100%;margin:0;padding:18px;border:1px solid #b9c8d7;border-${mirrored ? 'right' : 'left'}:5px solid #6b6ea8;border-radius:8px;background:#fff;color:#294765;display:flex;align-items:center}
  .accuracy-holdout-action{margin:0;display:flex;align-items:center;position:relative}
  .accuracy-holdout-action:before{content:"";position:absolute;${mirrored ? 'right' : 'left'}:-42px;width:34px;border-top:2px dashed #9aa8b6}
  .accuracy-holdout-control{width:100%;min-height:46px}
  ${crossTreePlacementCss(caseId, worldId)}
  </style>
  <section id="adaptive-accuracy-holdout" class="card" role="region" aria-labelledby="accuracy-holdout-title">
    <h1 id="accuracy-holdout-title">Catalog localization queues</h1>
    <p><strong>Task:</strong> ${esc(study.prompt)}</p>
    <p class="muted">Opening a localization batch is final.</p>
    ${isSemanticWorld(worldId)
      ? `<span id="accuracy-holdout-action-name" style="${VISUALLY_HIDDEN}">${esc(study.actionName)}</span>`
      : ''}
    <div class="holdout-localization-labels" role="group" aria-label="Localization queue labels">
      ${definition.labels.map((label, index) =>
        `<h3 id="accuracy-holdout-relation-${index}" class="holdout-localization-label accuracy-holdout-relation-label">${esc(label)}</h3>`).join('')}
    </div>
    <div class="holdout-localization-actions" role="group" aria-label="Localization queue controls">
      ${crossTreeActions(caseId, worldId)}
    </div>
  </section>`;
  return pageShell(ctx, { title: 'Localization queues', crumb: 'Localization queues', body });
};

const storageIntakePage = (
  ctx: PageCtx,
  worldId: AdaptiveAccuracyHoldoutWorldId,
): string => {
  const caseId = 'cross-tree/storage-intake-lanes' as const;
  const study = adaptiveAccuracyHoldoutCases[caseId];
  const definition = CROSS_TREE_DEFINITIONS[caseId];
  const body = `<style>
  #adaptive-accuracy-holdout{display:grid;grid-template-columns:minmax(300px,1fr) minmax(220px,.7fr);gap:18px 48px}
  #adaptive-accuracy-holdout>h1,#adaptive-accuracy-holdout>p,#adaptive-accuracy-holdout>#accuracy-holdout-action-name{grid-column:1/-1}
  .holdout-storage-labels,.holdout-storage-actions{display:grid;grid-template-rows:70px 28px 112px;margin:0;padding:0;list-style:none}
  .holdout-storage-labels li:nth-child(1){grid-row:1}.holdout-storage-labels li:nth-child(2){grid-row:3}
  .holdout-storage-label{box-sizing:border-box;height:100%;margin:0;padding:16px 18px;border:1px solid #b8c8bd;border-radius:5px 18px 5px 18px;background:#f3f8f4;color:#294b35;display:flex;align-items:center}
  .accuracy-holdout-action{margin:0;display:flex;align-items:center;position:relative}
  .accuracy-holdout-action:before{content:"";position:absolute;left:-48px;width:40px;border-top:2px dotted #91a397}
  .accuracy-holdout-control{width:100%;min-height:44px}
  ${crossTreePlacementCss(caseId, worldId, (lane) => lane * 2 + 1)}
  </style>
  <section id="adaptive-accuracy-holdout" class="card" role="region" aria-labelledby="accuracy-holdout-title">
    <h1 id="accuracy-holdout-title">Storage intake lanes</h1>
    <p><strong>Task:</strong> ${esc(study.prompt)}</p>
    <p class="muted">Only one intake load may be inspected.</p>
    ${isSemanticWorld(worldId)
      ? `<span id="accuracy-holdout-action-name" style="${VISUALLY_HIDDEN}">${esc(study.actionName)}</span>`
      : ''}
    <ol class="holdout-storage-labels" aria-label="Storage intake labels">
      ${definition.labels.map((label, index) => `<li><h3
        id="accuracy-holdout-relation-${index}"
        class="holdout-storage-label accuracy-holdout-relation-label"
      >${esc(label)}</h3></li>`).join('')}
    </ol>
    <div class="holdout-storage-actions" role="group" aria-label="Storage intake controls">
      ${crossTreeActions(caseId, worldId)}
    </div>
  </section>`;
  return pageShell(ctx, { title: 'Storage intake', crumb: 'Storage intake', body });
};

type ReplicationCaseId = Extract<
  AdaptiveAccuracyHoldoutCaseId,
  | 'schedule/workshop-week-table'
  | 'schedule/dispatch-shift-board'
  | 'cross-tree/case-routing-columns'
  | 'cross-tree/approval-lanes'
>;

const qualificationWorldFor = (
  worldId: AdaptiveAccuracyHoldoutWorldId,
): AdaptiveQualificationStudyWorldId => {
  switch (worldId) {
    case 'opaque-p0': return 'lossy-a';
    case 'opaque-p1': return 'lossy-b';
    case 'semantic-p0': return 'rescue-a';
    case 'semantic-p1': return 'rescue-b';
  }
};

/**
 * The v2 replication slice deliberately reuses four independently implemented
 * qualification sites while keeping a separate holdout binding and audit
 * namespace. Prefix normalization gives every v2 page the same holdout-facing
 * DOM contract; it does not alter target order, geometry, or relationships.
 */
const replicationSitePage = (
  ctx: PageCtx,
  caseId: ReplicationCaseId,
  worldId: AdaptiveAccuracyHoldoutWorldId,
): string => adaptiveQualificationStudyPage(ctx, {
  caseId: caseId as AdaptiveQualificationStudyCaseId,
  worldId: qualificationWorldFor(worldId),
}).replaceAll('qualification', 'accuracy-holdout');

export function adaptiveAccuracyHoldoutPage(
  ctx: PageCtx,
  rawBinding: AdaptiveAccuracyHoldoutBinding,
): string {
  const binding = resolveAdaptiveAccuracyHoldoutBinding(rawBinding);
  switch (binding.caseId) {
    case 'schedule/clinic-imaging-board':
      return clinicImagingPage(ctx, binding.worldId);
    case 'schedule/harbor-maintenance-rail':
      return harborMaintenancePage(ctx, binding.worldId);
    case 'cross-tree/catalog-localization-queues':
      return localizationQueuesPage(ctx, binding.worldId);
    case 'cross-tree/storage-intake-lanes':
      return storageIntakePage(ctx, binding.worldId);
    case 'schedule/workshop-week-table':
    case 'schedule/dispatch-shift-board':
    case 'cross-tree/case-routing-columns':
    case 'cross-tree/approval-lanes':
      return replicationSitePage(ctx, binding.caseId, binding.worldId);
  }
}

export const ADAPTIVE_ACCURACY_HOLDOUT_AUDIT_ACTION =
  'adaptive-accuracy-holdout.select' as const;

const bindingEntityId = (binding: AdaptiveAccuracyHoldoutBinding): string =>
  JSON.stringify([binding.caseId, binding.worldId]);

export function recordAdaptiveAccuracyHoldoutSelection(
  db: DatabaseSync,
  actor: string,
  rawBinding: AdaptiveAccuracyHoldoutBinding,
  targetId: string,
): void {
  const binding = resolveAdaptiveAccuracyHoldoutBinding(rawBinding);
  if (!isAdaptiveAccuracyHoldoutTarget(binding.caseId, targetId)) {
    throw new Error('Adaptive accuracy holdout target is outside the case catalog.');
  }
  audit(db, {
    actor,
    action: ADAPTIVE_ACCURACY_HOLDOUT_AUDIT_ACTION,
    entity: 'adaptive-accuracy-holdout',
    entityId: bindingEntityId(binding),
    detail: JSON.stringify({ targetId }),
  });
}

export interface AdaptiveAccuracyHoldoutOracleResult {
  passed: boolean;
  outcome: 'passed' | 'failed';
  expectedTargetId: string;
  selectedTargetIds: string[];
  mutationCount: number;
  collateralMutationCount: number;
  totalHoldoutMutationCount: number;
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

export function verifyAdaptiveAccuracyHoldoutSelection(
  db: DatabaseSync,
  rawBinding: AdaptiveAccuracyHoldoutBinding,
): AdaptiveAccuracyHoldoutOracleResult {
  const binding = resolveAdaptiveAccuracyHoldoutBinding(rawBinding);
  const allAuditRows = db.prepare(
    'SELECT action, entity, entity_id, detail FROM audit ORDER BY id ASC',
  ).all() as Array<{
    action: string;
    entity: string;
    entity_id: string;
    detail: string | null;
  }>;
  const rows = allAuditRows.filter(({ action, entity }) =>
    action === ADAPTIVE_ACCURACY_HOLDOUT_AUDIT_ACTION &&
    entity === 'adaptive-accuracy-holdout');
  const entityId = bindingEntityId(binding);
  const matching = rows.filter((row) => row.entity_id === entityId);
  const selectedTargetIds = matching.map(({ detail }) => selectedTarget(detail));
  const expectedTargetId = expectedAdaptiveAccuracyHoldoutTarget(
    binding.caseId,
    binding.worldId,
  );
  const collateralMutationCount = allAuditRows.length - matching.length;
  const otherAuditMutationCount = allAuditRows.length - rows.length;
  const passed = allAuditRows.length === 1 && rows.length === 1 && matching.length === 1 &&
    selectedTargetIds[0] === expectedTargetId;
  return {
    passed,
    outcome: passed ? 'passed' : 'failed',
    expectedTargetId,
    selectedTargetIds,
    mutationCount: matching.length,
    collateralMutationCount,
    totalHoldoutMutationCount: rows.length,
    otherAuditMutationCount,
    totalAuditMutationCount: allAuditRows.length,
  };
}
