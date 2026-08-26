import type { DatabaseSync } from 'node:sqlite';

import { audit } from './db.js';
import type { PageCtx } from './pages.js';
import { esc, layout } from './views.js';

export const ADAPTIVE_QUALIFICATION_STUDIES_VERSION =
  'adaptive-qualification-live-studies/2' as const;

export const ADAPTIVE_QUALIFICATION_STUDY_FAMILIES = Object.freeze([
  'schedule-coordinate',
  'cross-tree-label',
] as const);

export type AdaptiveQualificationStudyFamily =
  (typeof ADAPTIVE_QUALIFICATION_STUDY_FAMILIES)[number];

export const ADAPTIVE_QUALIFICATION_STUDY_WORLD_IDS = Object.freeze([
  'lossy-a',
  'lossy-b',
  'rescue-a',
  'rescue-b',
] as const);

export type AdaptiveQualificationStudyWorldId =
  (typeof ADAPTIVE_QUALIFICATION_STUDY_WORLD_IDS)[number];

export const ADAPTIVE_QUALIFICATION_STUDY_CASE_IDS = Object.freeze([
  'schedule/workshop-week-table',
  'schedule/dispatch-shift-board',
  'cross-tree/case-routing-columns',
  'cross-tree/approval-lanes',
] as const);

export type AdaptiveQualificationStudyCaseId =
  (typeof ADAPTIVE_QUALIFICATION_STUDY_CASE_IDS)[number];

export type AdaptiveQualificationRequestedRelation =
  | Readonly<{
      kind: 'schedule-coordinate';
      resource: string;
      slot: string;
    }>
  | Readonly<{
      kind: 'cross-tree-label';
      label: string;
    }>;

export interface AdaptiveQualificationStudyCaseContract {
  caseId: AdaptiveQualificationStudyCaseId;
  familyId: AdaptiveQualificationStudyFamily;
  siteId: string;
  implementationId: string;
  path: string;
  selectionPath: string;
  prompt: string;
  actionName: string;
  targetIds: readonly string[];
  requestedRelation: AdaptiveQualificationRequestedRelation;
  worldIds: typeof ADAPTIVE_QUALIFICATION_STUDY_WORLD_IDS;
}

const contract = (
  input: Omit<AdaptiveQualificationStudyCaseContract, 'selectionPath' | 'worldIds'>,
): AdaptiveQualificationStudyCaseContract => Object.freeze({
  ...input,
  selectionPath: `${input.path}/select`,
  worldIds: ADAPTIVE_QUALIFICATION_STUDY_WORLD_IDS,
  targetIds: Object.freeze([...input.targetIds]),
  requestedRelation: Object.freeze({ ...input.requestedRelation }),
});

export const adaptiveQualificationStudyCases = Object.freeze({
  'schedule/workshop-week-table': contract({
    caseId: 'schedule/workshop-week-table',
    familyId: 'schedule-coordinate',
    siteId: 'workshop-week-table',
    implementationId: 'native-workshop-week-table',
    path: '/app/labs/adaptive-schedule-workshop',
    prompt: 'Choose the open slot for Bay 4 on Tuesday 09:30, then stop.',
    actionName: 'Choose open slot',
    targetIds: ['ws-k7p2', 'ws-r4m9', 'ws-v8q1', 'ws-x3n6'],
    requestedRelation: Object.freeze({
      kind: 'schedule-coordinate',
      resource: 'Bay 4',
      slot: 'Tuesday 09:30',
    }),
  }),
  'schedule/dispatch-shift-board': contract({
    caseId: 'schedule/dispatch-shift-board',
    familyId: 'schedule-coordinate',
    siteId: 'dispatch-shift-board',
    implementationId: 'aria-dispatch-shift-board',
    path: '/app/labs/adaptive-dispatch-shifts',
    prompt: 'Assign the South crew to the 14:00 shift, then stop.',
    actionName: 'Assign shift',
    targetIds: ['ds-b6t4', 'ds-h2w8', 'ds-p9c3', 'ds-z5j7'],
    requestedRelation: Object.freeze({
      kind: 'schedule-coordinate',
      resource: 'South crew',
      slot: '14:00',
    }),
  }),
  'cross-tree/case-routing-columns': contract({
    caseId: 'cross-tree/case-routing-columns',
    familyId: 'cross-tree-label',
    siteId: 'case-routing-columns',
    implementationId: 'case-routing-parallel-columns',
    path: '/app/labs/adaptive-case-routing',
    prompt: 'Open the case aligned with the Routine queue, then stop.',
    actionName: 'Open case',
    targetIds: ['cr-d7m2', 'cr-q4v8'],
    requestedRelation: Object.freeze({
      kind: 'cross-tree-label',
      label: 'Routine queue',
    }),
  }),
  'cross-tree/approval-lanes': contract({
    caseId: 'cross-tree/approval-lanes',
    familyId: 'cross-tree-label',
    siteId: 'approval-lanes',
    implementationId: 'approval-description-list-lanes',
    path: '/app/labs/adaptive-approval-lanes',
    prompt: 'Review the request aligned with Finance review, then stop.',
    actionName: 'Review request',
    targetIds: ['al-f6p1', 'al-y9k3'],
    requestedRelation: Object.freeze({
      kind: 'cross-tree-label',
      label: 'Finance review',
    }),
  }),
} satisfies Record<AdaptiveQualificationStudyCaseId, AdaptiveQualificationStudyCaseContract>);

export interface AdaptiveQualificationStudyBinding {
  caseId: AdaptiveQualificationStudyCaseId;
  worldId: AdaptiveQualificationStudyWorldId;
}

export function isAdaptiveQualificationStudyCaseId(
  value: string,
): value is AdaptiveQualificationStudyCaseId {
  return (ADAPTIVE_QUALIFICATION_STUDY_CASE_IDS as readonly string[]).includes(value);
}

export function isAdaptiveQualificationStudyWorldId(
  value: string,
): value is AdaptiveQualificationStudyWorldId {
  return (ADAPTIVE_QUALIFICATION_STUDY_WORLD_IDS as readonly string[]).includes(value);
}

export function resolveAdaptiveQualificationStudyBinding(
  input: AdaptiveQualificationStudyBinding,
): Readonly<AdaptiveQualificationStudyBinding> {
  if (
    !isAdaptiveQualificationStudyCaseId(input.caseId) ||
    !isAdaptiveQualificationStudyWorldId(input.worldId) ||
    Object.keys(input).sort().join('\u0000') !== 'caseId\u0000worldId'
  ) throw new Error('Adaptive qualification study binding is outside the frozen catalog.');
  return Object.freeze({ caseId: input.caseId, worldId: input.worldId });
}

export function isAdaptiveQualificationTarget(
  caseId: AdaptiveQualificationStudyCaseId,
  value: string,
): boolean {
  return adaptiveQualificationStudyCases[caseId].targetIds.includes(value);
}

const isWorldB = (worldId: AdaptiveQualificationStudyWorldId): boolean =>
  worldId.endsWith('-b');

const isRescue = (worldId: AdaptiveQualificationStudyWorldId): boolean =>
  worldId.startsWith('rescue-');

interface ScheduleCoordinate {
  resource: string;
  slot: string;
  row: number;
  column: number;
}

const scheduleLabels = (
  caseId: Extract<AdaptiveQualificationStudyCaseId, `schedule/${string}`>,
): Readonly<{
  resources: readonly [string, string];
  slots: readonly [string, string];
}> => caseId === 'schedule/workshop-week-table'
  ? { resources: ['Bay 2', 'Bay 4'], slots: ['Monday 09:30', 'Tuesday 09:30'] }
  : { resources: ['North crew', 'South crew'], slots: ['06:00', '14:00'] };

const scheduleCoordinateForTarget = (
  caseId: Extract<AdaptiveQualificationStudyCaseId, `schedule/${string}`>,
  worldId: AdaptiveQualificationStudyWorldId,
  targetId: string,
): ScheduleCoordinate => {
  const study = adaptiveQualificationStudyCases[caseId];
  const index = study.targetIds.indexOf(targetId);
  if (index < 0) throw new Error(`Unknown target for ${caseId}.`);
  const labels = scheduleLabels(caseId);
  const coordinates = labels.resources.flatMap((resource, row) =>
    labels.slots.map((slot, column) => ({ resource, slot, row, column })));
  return (isWorldB(worldId) ? [...coordinates].reverse() : coordinates)[index]!;
};

const crossTreeLabels = (
  caseId: Extract<AdaptiveQualificationStudyCaseId, `cross-tree/${string}`>,
): readonly [string, string] => caseId === 'cross-tree/case-routing-columns'
  ? ['Urgent queue', 'Routine queue']
  : ['Security review', 'Finance review'];

const crossTreeRelationForTarget = (
  caseId: Extract<AdaptiveQualificationStudyCaseId, `cross-tree/${string}`>,
  worldId: AdaptiveQualificationStudyWorldId,
  targetId: string,
): Readonly<{ label: string; lane: number }> => {
  const study = adaptiveQualificationStudyCases[caseId];
  const index = study.targetIds.indexOf(targetId);
  if (index < 0) throw new Error(`Unknown target for ${caseId}.`);
  const relations = crossTreeLabels(caseId).map((label, lane) => ({ label, lane }));
  return (isWorldB(worldId) ? [...relations].reverse() : relations)[index]!;
};

export function expectedAdaptiveQualificationTarget(
  caseId: AdaptiveQualificationStudyCaseId,
  worldId: AdaptiveQualificationStudyWorldId,
): string {
  const study = adaptiveQualificationStudyCases[caseId];
  const target = study.targetIds.find((targetId) => {
    if (study.requestedRelation.kind === 'schedule-coordinate') {
      const coordinate = scheduleCoordinateForTarget(
        caseId as Extract<AdaptiveQualificationStudyCaseId, `schedule/${string}`>,
        worldId,
        targetId,
      );
      return coordinate.resource === study.requestedRelation.resource &&
        coordinate.slot === study.requestedRelation.slot;
    }
    return crossTreeRelationForTarget(
      caseId as Extract<AdaptiveQualificationStudyCaseId, `cross-tree/${string}`>,
      worldId,
      targetId,
    ).label === study.requestedRelation.label;
  });
  if (target === undefined) throw new Error(`No expected target for ${caseId}.`);
  return target;
}

const visuallyHidden =
  'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;' +
  'clip:rect(0,0,0,0);white-space:nowrap;border:0';

const actionForm = (input: {
  contract: AdaptiveQualificationStudyCaseContract;
  targetId: string;
  ariaLabelledby?: string | undefined;
}): string => `<form
  class="qualification-action qualification-action-${esc(input.targetId)}"
  method="post"
  action="${esc(input.contract.selectionPath)}"
>
  <button
    id="qualification-control-${esc(input.targetId)}"
    class="btn primary qualification-control"
    type="submit"
    name="target"
    value="${esc(input.targetId)}"${
      input.ariaLabelledby === undefined
        ? ''
        : ` aria-labelledby="${esc(input.ariaLabelledby)}"`
    }
  >${esc(input.contract.actionName)}</button>
</form>`;

const schedulePlacementCss = (
  caseId: Extract<AdaptiveQualificationStudyCaseId, `schedule/${string}`>,
  worldId: AdaptiveQualificationStudyWorldId,
): string => adaptiveQualificationStudyCases[caseId].targetIds.map((targetId) => {
  const coordinate = scheduleCoordinateForTarget(caseId, worldId, targetId);
  return `.qualification-action-${targetId}{grid-column:${coordinate.column + 2};grid-row:${coordinate.row + 2}}`;
}).join('\n');

const scheduleActions = (
  caseId: Extract<AdaptiveQualificationStudyCaseId, `schedule/${string}`>,
  worldId: AdaptiveQualificationStudyWorldId,
): string => {
  const study = adaptiveQualificationStudyCases[caseId];
  const rescue = isRescue(worldId);
  return study.targetIds.map((targetId) => {
    const coordinate = scheduleCoordinateForTarget(caseId, worldId, targetId);
    return actionForm({
      contract: study,
      targetId,
      ...(rescue
        ? {
            ariaLabelledby:
              `qualification-resource-${coordinate.row} ` +
              `qualification-slot-${coordinate.column} qualification-action-name`,
          }
        : {}),
    });
  }).join('');
};

const workshopSchedulePage = (
  ctx: PageCtx,
  worldId: AdaptiveQualificationStudyWorldId,
): string => {
  const caseId = 'schedule/workshop-week-table' as const;
  const study = adaptiveQualificationStudyCases[caseId];
  const labels = scheduleLabels(caseId);
  const body = `<style>
  .qualification-schedule-stage{--qualification-workshop-resource-track:150px;position:relative;width:min(760px,100%);height:244px;margin-top:18px}
  .qualification-native-table{width:100%;height:244px;table-layout:fixed;border-collapse:collapse;background:#fff}
  .qualification-native-table .qualification-workshop-resource-track{width:var(--qualification-workshop-resource-track)}
  .qualification-native-table .qualification-workshop-slot-track{width:calc((100% - var(--qualification-workshop-resource-track))/2)}
  .qualification-native-table th,.qualification-native-table td{border:1px solid #cbd5df}
  .qualification-native-table thead{height:64px}.qualification-native-table tbody tr{height:90px}
  .qualification-native-table th:first-child{background:#f3f6f9}
  .qualification-native-table th{padding:12px;color:#31465d}
  .qualification-schedule-actions{position:absolute;inset:0;display:grid;
    grid-template-columns:var(--qualification-workshop-resource-track) repeat(2,minmax(0,1fr));grid-template-rows:64px repeat(2,90px);
    pointer-events:none}
  .qualification-action{margin:0;display:flex;align-items:center;justify-content:center;padding:16px;pointer-events:auto}
  .qualification-control{width:100%;min-height:44px}
  ${schedulePlacementCss(caseId, worldId)}
  </style>
  <section id="adaptive-qualification-study" class="card" aria-labelledby="qualification-title">
    <h1 id="qualification-title">Workshop weekly schedule</h1>
    <p><strong>Task:</strong> ${esc(study.prompt)}</p>
    <p class="muted">Each open-slot choice is final.</p>
    ${isRescue(worldId)
      ? `<span id="qualification-action-name" style="${visuallyHidden}">${esc(study.actionName)}</span>`
      : ''}
    <div class="qualification-schedule-stage">
      <table class="qualification-native-table" aria-label="Workshop weekly schedule">
        <colgroup><col class="qualification-workshop-resource-track"><col class="qualification-workshop-slot-track" span="2"></colgroup>
        <thead><tr><td aria-hidden="true">Bay</td>${labels.slots.map((slot, index) =>
          `<th id="qualification-slot-${index}" role="columnheader">${esc(slot)}</th>`).join('')}</tr></thead>
        <tbody>${labels.resources.map((resource, index) =>
          `<tr><th id="qualification-resource-${index}" role="rowheader">${esc(resource)}</th><td></td><td></td></tr>`).join('')}</tbody>
      </table>
      <div class="qualification-schedule-actions" role="group" aria-label="Available schedule actions">
        ${scheduleActions(caseId, worldId)}
      </div>
    </div>
  </section>`;
  return layout(body, {
    title: 'Workshop schedule',
    path: ctx.path,
    user: ctx.user,
    flash: ctx.flash,
    breadcrumbs: [{ label: 'Labs' }, { label: 'Workshop schedule' }],
  });
};

const dispatchSchedulePage = (
  ctx: PageCtx,
  worldId: AdaptiveQualificationStudyWorldId,
): string => {
  const caseId = 'schedule/dispatch-shift-board' as const;
  const study = adaptiveQualificationStudyCases[caseId];
  const labels = scheduleLabels(caseId);
  const body = `<style>
  .qualification-dispatch-stage{position:relative;width:min(720px,100%);height:245px;margin-top:18px}
  .qualification-dispatch-grid{height:245px;display:grid;grid-template-rows:64px repeat(2,90px);
    border:1px solid #9aa9b8;border-radius:7px;overflow:hidden;background:#fff}
  .qualification-dispatch-row{display:grid;grid-template-columns:150px repeat(2,minmax(170px,1fr));min-height:0}
  .qualification-dispatch-row>*{display:flex;align-items:center;justify-content:center;border-right:1px solid #d5dce3;border-bottom:1px solid #d5dce3}
  .qualification-dispatch-row [role=rowheader]{justify-content:flex-start;padding:14px;background:#f7f9fb;color:#31465d}
  .qualification-dispatch-header{background:#e9f0f7;font-weight:650;color:#31465d}
  .qualification-dispatch-actions{position:absolute;inset:0;display:grid;
    grid-template-columns:150px repeat(2,minmax(170px,1fr));grid-template-rows:64px repeat(2,90px);
    pointer-events:none}
  .qualification-action{margin:0;display:flex;align-items:center;justify-content:center;padding:16px;pointer-events:auto}
  .qualification-control{width:100%;min-height:44px}
  ${schedulePlacementCss(caseId, worldId)}
  </style>
  <section id="adaptive-qualification-study" class="card" aria-labelledby="qualification-title">
    <h1 id="qualification-title">Dispatch shift board</h1>
    <p><strong>Task:</strong> ${esc(study.prompt)}</p>
    <p class="muted">One crew assignment may be submitted.</p>
    ${isRescue(worldId)
      ? `<span id="qualification-action-name" style="${visuallyHidden}">${esc(study.actionName)}</span>`
      : ''}
    <div class="qualification-dispatch-stage">
      <div class="qualification-dispatch-grid" role="grid" aria-label="Dispatch shift board">
        <div class="qualification-dispatch-row qualification-dispatch-header" role="row">
          <span aria-hidden="true"></span>${labels.slots.map((slot, index) =>
            `<strong id="qualification-slot-${index}" role="columnheader">${esc(slot)}</strong>`).join('')}
        </div>
        ${labels.resources.map((resource, index) => `<div class="qualification-dispatch-row" role="row">
          <strong id="qualification-resource-${index}" role="rowheader">${esc(resource)}</strong><span role="gridcell"></span><span role="gridcell"></span>
        </div>`).join('')}
      </div>
      <aside class="qualification-dispatch-actions" role="group" aria-label="Available schedule actions">
        ${scheduleActions(caseId, worldId)}
      </aside>
    </div>
  </section>`;
  return layout(body, {
    title: 'Dispatch shifts',
    path: ctx.path,
    user: ctx.user,
    flash: ctx.flash,
    breadcrumbs: [{ label: 'Labs' }, { label: 'Dispatch shifts' }],
  });
};

const crossTreePlacementCss = (
  caseId: Extract<AdaptiveQualificationStudyCaseId, `cross-tree/${string}`>,
  worldId: AdaptiveQualificationStudyWorldId,
): string => adaptiveQualificationStudyCases[caseId].targetIds.map((targetId) => {
  const relation = crossTreeRelationForTarget(caseId, worldId, targetId);
  return `.qualification-action-${targetId}{grid-row:${relation.lane + 1}}`;
}).join('\n');

const crossTreeAction = (
  caseId: Extract<AdaptiveQualificationStudyCaseId, `cross-tree/${string}`>,
  worldId: AdaptiveQualificationStudyWorldId,
  targetId: string,
): string => {
  const study = adaptiveQualificationStudyCases[caseId];
  const relation = crossTreeRelationForTarget(caseId, worldId, targetId);
  return actionForm({
    contract: study,
    targetId,
    ...(isRescue(worldId)
      ? {
          ariaLabelledby:
            `qualification-relation-${relation.lane} qualification-action-name`,
        }
      : {}),
  });
};

const crossTreeActions = (
  caseId: Extract<AdaptiveQualificationStudyCaseId, `cross-tree/${string}`>,
  worldId: AdaptiveQualificationStudyWorldId,
): string => adaptiveQualificationStudyCases[caseId].targetIds
  .map((targetId) => crossTreeAction(caseId, worldId, targetId))
  .join('');

const caseRoutingPage = (
  ctx: PageCtx,
  worldId: AdaptiveQualificationStudyWorldId,
): string => {
  const caseId = 'cross-tree/case-routing-columns' as const;
  const study = adaptiveQualificationStudyCases[caseId];
  const labels = crossTreeLabels(caseId);
  const body = `<style>
  #adaptive-qualification-study{display:grid;grid-template-columns:minmax(260px,1fr) minmax(220px,.8fr);gap:18px 36px}
  #adaptive-qualification-study>h1,#adaptive-qualification-study>p,#adaptive-qualification-study>#qualification-action-name{grid-column:1/-1}
  .qualification-label-tree,.qualification-control-tree{display:grid;grid-template-rows:repeat(2,90px);gap:18px}
  .qualification-label-tree{grid-column:1}.qualification-control-tree{grid-column:2}
  .qualification-relation-label{box-sizing:border-box;height:90px;margin:0;padding:28px 18px;border:1px solid #b9c8d7;border-left:5px solid #587ba5;border-radius:7px;background:#fff;color:#294765}
  .qualification-action{margin:0;display:flex;align-items:center;position:relative}
  .qualification-action:before{content:"";position:absolute;left:-36px;width:30px;border-top:2px dashed #9aa8b6}
  .qualification-control{width:100%;min-height:46px}
  ${crossTreePlacementCss(caseId, worldId)}
  </style>
  <section id="adaptive-qualification-study" class="card" role="region" aria-labelledby="qualification-title">
    <h1 id="qualification-title">Case routing</h1>
    <p><strong>Task:</strong> ${esc(study.prompt)}</p>
    <p class="muted">The selected case route is final.</p>
    ${isRescue(worldId)
      ? `<span id="qualification-action-name" style="${visuallyHidden}">${esc(study.actionName)}</span>`
      : ''}
    <div class="qualification-label-tree" role="group" aria-label="Relationship labels">
      ${labels.map((label, index) =>
        `<h3 id="qualification-relation-${index}" class="qualification-relation-label">${esc(label)}</h3>`).join('')}
    </div>
    <div class="qualification-control-tree" role="group" aria-label="Relationship controls">
      ${crossTreeActions(caseId, worldId)}
    </div>
  </section>`;
  return layout(body, {
    title: 'Case routing',
    path: ctx.path,
    user: ctx.user,
    flash: ctx.flash,
    breadcrumbs: [{ label: 'Labs' }, { label: 'Case routing' }],
  });
};

const approvalLanesPage = (
  ctx: PageCtx,
  worldId: AdaptiveQualificationStudyWorldId,
): string => {
  const caseId = 'cross-tree/approval-lanes' as const;
  const study = adaptiveQualificationStudyCases[caseId];
  const labels = crossTreeLabels(caseId);
  const body = `<style>
  #adaptive-qualification-study{display:grid;grid-template-columns:minmax(280px,1fr) minmax(220px,.72fr);gap:18px 42px}
  #adaptive-qualification-study>h1,#adaptive-qualification-study>p,#adaptive-qualification-study>#qualification-action-name{grid-column:1/-1}
  .qualification-approval-terms,.qualification-approval-actions{display:grid;grid-template-rows:repeat(2,90px);gap:18px;margin:0;padding:0}
  .qualification-approval-terms{grid-column:1}.qualification-approval-actions{grid-column:2;list-style:none}
  .qualification-approval-terms dt{box-sizing:border-box;height:90px;grid-column:1;margin:0;border-radius:8px;background:#f1f5f8}
  .qualification-approval-terms h3{box-sizing:border-box;height:90px;margin:0;padding:25px 18px;color:#294765;font-size:16px;font-weight:650}
  .qualification-approval-terms dd{grid-column:1;align-self:end;margin:0;padding:0 18px 12px;color:#687786;pointer-events:none}
  .qualification-approval-terms dt:nth-of-type(1),.qualification-approval-terms dd:nth-of-type(1){grid-row:1}
  .qualification-approval-terms dt:nth-of-type(2),.qualification-approval-terms dd:nth-of-type(2){grid-row:2}
  .qualification-approval-actions li{display:contents}
  .qualification-action{margin:0;display:flex;align-items:center}
  .qualification-control{width:100%;min-height:46px}
  ${crossTreePlacementCss(caseId, worldId)}
  </style>
  <section id="adaptive-qualification-study" class="card" role="form" aria-labelledby="qualification-title">
    <h1 id="qualification-title">Approval routing</h1>
    <p><strong>Task:</strong> ${esc(study.prompt)}</p>
    <p class="muted">Reviewing a request records the decision immediately.</p>
    ${isRescue(worldId)
      ? `<span id="qualification-action-name" style="${visuallyHidden}">${esc(study.actionName)}</span>`
      : ''}
    <dl class="qualification-approval-terms" role="list" aria-label="Relationship labels">
      <dt role="presentation"><h3 id="qualification-relation-0" class="qualification-relation-label">${esc(labels[0])}</h3></dt><dd>Identity, permissions, and policy</dd>
      <dt role="presentation"><h3 id="qualification-relation-1" class="qualification-relation-label">${esc(labels[1])}</h3></dt><dd>Budget, invoice, and payment</dd>
    </dl>
    <ul class="qualification-approval-actions" role="list" aria-label="Relationship controls">
      ${adaptiveQualificationStudyCases[caseId].targetIds.map((targetId) =>
        `<li>${crossTreeAction(caseId, worldId, targetId)}</li>`).join('')}
    </ul>
  </section>`;
  return layout(body, {
    title: 'Approval routing',
    path: ctx.path,
    user: ctx.user,
    flash: ctx.flash,
    breadcrumbs: [{ label: 'Labs' }, { label: 'Approval routing' }],
  });
};

export function adaptiveQualificationStudyPage(
  ctx: PageCtx,
  rawBinding: AdaptiveQualificationStudyBinding,
): string {
  const binding = resolveAdaptiveQualificationStudyBinding(rawBinding);
  switch (binding.caseId) {
    case 'schedule/workshop-week-table':
      return workshopSchedulePage(ctx, binding.worldId);
    case 'schedule/dispatch-shift-board':
      return dispatchSchedulePage(ctx, binding.worldId);
    case 'cross-tree/case-routing-columns':
      return caseRoutingPage(ctx, binding.worldId);
    case 'cross-tree/approval-lanes':
      return approvalLanesPage(ctx, binding.worldId);
  }
}

export const ADAPTIVE_QUALIFICATION_AUDIT_ACTION =
  'adaptive-qualification.select' as const;

const bindingEntityId = (binding: AdaptiveQualificationStudyBinding): string =>
  JSON.stringify([binding.caseId, binding.worldId]);

export function recordAdaptiveQualificationSelection(
  db: DatabaseSync,
  actor: string,
  rawBinding: AdaptiveQualificationStudyBinding,
  targetId: string,
): void {
  const binding = resolveAdaptiveQualificationStudyBinding(rawBinding);
  if (!isAdaptiveQualificationTarget(binding.caseId, targetId)) {
    throw new Error('Adaptive qualification selection target is outside the case catalog.');
  }
  audit(db, {
    actor,
    action: ADAPTIVE_QUALIFICATION_AUDIT_ACTION,
    entity: 'adaptive-qualification-study',
    entityId: bindingEntityId(binding),
    detail: JSON.stringify({ targetId }),
  });
}

export interface AdaptiveQualificationOracleResult {
  passed: boolean;
  outcome: 'passed' | 'failed';
  expectedTargetId: string;
  selectedTargetIds: string[];
  mutationCount: number;
  collateralMutationCount: number;
  totalStudyMutationCount: number;
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

export function verifyAdaptiveQualificationSelection(
  db: DatabaseSync,
  rawBinding: AdaptiveQualificationStudyBinding,
): AdaptiveQualificationOracleResult {
  const binding = resolveAdaptiveQualificationStudyBinding(rawBinding);
  const rows = db.prepare(
    `SELECT entity_id, detail FROM audit
     WHERE action = ? AND entity = 'adaptive-qualification-study'
     ORDER BY id ASC`,
  ).all(ADAPTIVE_QUALIFICATION_AUDIT_ACTION) as Array<{
    entity_id: string;
    detail: string | null;
  }>;
  const entityId = bindingEntityId(binding);
  const matching = rows.filter((row) => row.entity_id === entityId);
  const selectedTargetIds = matching.map(({ detail }) => selectedTarget(detail));
  const expectedTargetId = expectedAdaptiveQualificationTarget(binding.caseId, binding.worldId);
  const collateralMutationCount = rows.length - matching.length;
  const passed = rows.length === 1 && matching.length === 1 &&
    selectedTargetIds[0] === expectedTargetId;
  return {
    passed,
    outcome: passed ? 'passed' : 'failed',
    expectedTargetId,
    selectedTargetIds,
    mutationCount: matching.length,
    collateralMutationCount,
    totalStudyMutationCount: rows.length,
  };
}
