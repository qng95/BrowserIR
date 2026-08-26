export const ADAPTIVE_QUALIFICATION_FIXTURES_VERSION =
  'adaptive-qualification-fixtures/1' as const;

export const ADAPTIVE_QUALIFICATION_FAMILIES = Object.freeze([
  'schedule-coordinate',
  'cross-tree-label',
] as const);

export type AdaptiveQualificationFamily =
  (typeof ADAPTIVE_QUALIFICATION_FAMILIES)[number];

export const ADAPTIVE_QUALIFICATION_WORLD_IDS = Object.freeze([
  'lossy-a',
  'lossy-b',
  'rescue-a',
  'rescue-b',
] as const);

export type AdaptiveQualificationWorldId =
  (typeof ADAPTIVE_QUALIFICATION_WORLD_IDS)[number];

export type AdaptiveQualificationClass = 'needs-enrichment' | 'semantic-sufficient';

export interface AdaptiveQualificationTargetBinding {
  targetId: string;
  baselineRef: string;
  featureRef: string;
  relation: Readonly<Record<string, string>>;
}

export interface AdaptiveQualificationWorldFixture {
  worldId: AdaptiveQualificationWorldId;
  qualification: AdaptiveQualificationClass;
  expectedTargetId: string;
  targetBindings: readonly AdaptiveQualificationTargetBinding[];
  /** Deterministic implementation artifact. It has not been captured in a live browser. */
  html: string;
  /** Deterministic Playwright-format fixture used only for offline policy qualification. */
  snapshotTree: string;
  /** Same semantic state with a fresh ref epoch and complete boxes. */
  geometrySnapshotTree: string;
}

export interface AdaptiveQualificationSiteFixture {
  caseId: string;
  familyId: AdaptiveQualificationFamily;
  siteId: string;
  implementation: Readonly<{
    id: string;
    version: string;
    structure: string;
    stateModel: string;
  }>;
  prompt: string;
  actionName: string;
  worlds: Readonly<Record<AdaptiveQualificationWorldId, AdaptiveQualificationWorldFixture>>;
}

interface ScheduleSiteSpec {
  caseId: string;
  siteId: string;
  implementation: AdaptiveQualificationSiteFixture['implementation'];
  prompt: string;
  actionName: string;
  rootRole: 'table' | 'grid';
  rootName: string;
  resources: readonly [string, string];
  slots: readonly [string, string];
  targetIds: readonly [string, string, string, string];
  renderHtml(input: {
    semantic: boolean;
    assignments: readonly ScheduleAssignment[];
  }): string;
}

interface ScheduleAssignment {
  targetId: string;
  baselineRef: string;
  featureRef: string;
  resource: string;
  slot: string;
  row: number;
  column: number;
}

const ref = (epoch: '' | 'f2', number: number): string => `${epoch}e${number}`;

const metadata = (
  refValue: string,
  geometry: boolean,
  box: readonly [number, number, number, number],
): string => geometry
  ? `[ref=${refValue}] [box=${box.join(',')}]`
  : `[ref=${refValue}]`;

const worldIsB = (worldId: AdaptiveQualificationWorldId): boolean =>
  worldId.endsWith('-b');

const worldIsRescue = (worldId: AdaptiveQualificationWorldId): boolean =>
  worldId.startsWith('rescue-');

const scheduleAssignments = (
  spec: ScheduleSiteSpec,
  worldId: AdaptiveQualificationWorldId,
): readonly ScheduleAssignment[] => {
  const coordinates = spec.resources.flatMap((resource, row) =>
    spec.slots.map((slot, column) => ({ resource, slot, row, column })));
  const assigned = worldIsB(worldId) ? [...coordinates].reverse() : coordinates;
  return Object.freeze(spec.targetIds.map((targetId, index) => Object.freeze({
    targetId,
    baselineRef: ref('', 21 + index),
    featureRef: ref('f2', 21 + index),
    ...assigned[index]!,
  })));
};

const renderScheduleSnapshot = (
  spec: ScheduleSiteSpec,
  worldId: AdaptiveQualificationWorldId,
  geometry: boolean,
): string => {
  const epoch = geometry ? 'f2' : '';
  const assignments = scheduleAssignments(spec, worldId);
  const semantic = worldIsRescue(worldId);
  const lines = [
    `- ${spec.rootRole} ${JSON.stringify(spec.rootName)} ${metadata(ref(epoch, 1), geometry, [0, 0, 400, 260])}`,
    `  - row ${metadata(ref(epoch, 2), geometry, [0, 0, 400, 60])}`,
    `    - columnheader ${JSON.stringify(spec.slots[0])} ${metadata(ref(epoch, 3), geometry, [120, 0, 120, 60])}`,
    `    - columnheader ${JSON.stringify(spec.slots[1])} ${metadata(ref(epoch, 4), geometry, [260, 0, 120, 60])}`,
    `  - row ${metadata(ref(epoch, 5), geometry, [0, 60, 400, 90])}`,
    `    - rowheader ${JSON.stringify(spec.resources[0])} ${metadata(ref(epoch, 6), geometry, [0, 60, 100, 90])}`,
    `  - row ${metadata(ref(epoch, 7), geometry, [0, 150, 400, 90])}`,
    `    - rowheader ${JSON.stringify(spec.resources[1])} ${metadata(ref(epoch, 8), geometry, [0, 150, 100, 90])}`,
    `- group "Available schedule actions" ${metadata(ref(epoch, 9), geometry, [100, 60, 300, 180])}`,
    ...assignments.map((assignment) => {
      const name = semantic
        ? `${assignment.resource} ${assignment.slot} ${spec.actionName}`
        : spec.actionName;
      const x = assignment.column === 0 ? 130 : 270;
      const y = assignment.row === 0 ? 80 : 170;
      return `  - button ${JSON.stringify(name)} ${metadata(
        geometry ? assignment.featureRef : assignment.baselineRef,
        geometry,
        [x, y, 90, 50],
      )}`;
    }),
  ];
  return `${lines.join('\n')}\n`;
};

const workshopHtml = ({
  semantic,
  assignments,
}: {
  semantic: boolean;
  assignments: readonly ScheduleAssignment[];
}): string => `<!doctype html>
<html><head><style>
  main { position: relative; width: 400px; height: 260px; }
  .weekly-schedule { table-layout: fixed; width: 400px; height: 240px; }
  .schedule-actions { position: absolute; inset: 0; }
  .schedule-actions button { position: absolute; left: calc(130px + var(--column) * 140px); top: calc(80px + var(--row) * 90px); width: 90px; height: 50px; }
</style></head><body><main aria-label="Workshop weekly schedule">
  <table class="weekly-schedule" aria-label="Workshop weekly schedule"><thead><tr><th></th><th>Monday 09:30</th><th>Tuesday 09:30</th></tr></thead>
    <tbody><tr><th>Bay 2</th><td></td><td></td></tr><tr><th>Bay 4</th><td></td><td></td></tr></tbody></table>
  <div class="schedule-actions">${assignments.map((assignment) =>
    `<button id="${assignment.targetId}" style="--row:${assignment.row};--column:${assignment.column}"${
      semantic
        ? ` aria-label="${assignment.resource} ${assignment.slot} Choose open slot"`
        : ''
    }>Choose open slot</button>`).join('')}</div>
</main></body></html>`;

const dispatchHtml = ({
  semantic,
  assignments,
}: {
  semantic: boolean;
  assignments: readonly ScheduleAssignment[];
}): string => `<!doctype html>
<html><head><style>
  .dispatch-shell { position: relative; width: 400px; height: 260px; }
  .dispatch-board { position: absolute; inset: 0; display: grid; grid-template-columns: 100px 140px 140px; }
  .shift-actions { position: absolute; inset: 0; }
  .shift-actions button { position: absolute; left: calc(130px + var(--shift) * 140px); top: calc(80px + var(--lane) * 90px); width: 90px; height: 50px; }
</style></head><body><main class="dispatch-shell" aria-label="Dispatch scheduling">
  <section class="dispatch-board" role="grid" aria-label="Dispatch shift board">
    <header role="row"><span></span><span role="columnheader">06:00</span><span role="columnheader">14:00</span></header>
    <ol class="crew-lanes"><li role="row"><strong role="rowheader">North crew</strong></li><li role="row"><strong role="rowheader">South crew</strong></li></ol>
  </section>
  <aside class="shift-actions" aria-label="Available schedule actions">${assignments.map((assignment) =>
    `<button id="${assignment.targetId}" style="--lane:${assignment.row};--shift:${assignment.column}"${
      semantic
        ? ` aria-label="${assignment.resource} ${assignment.slot} Assign shift"`
        : ''
    }>Assign shift</button>`).join('')}</aside>
</main></body></html>`;

const scheduleSpecs: readonly ScheduleSiteSpec[] = Object.freeze([
  {
    caseId: 'schedule/workshop-week-table',
    siteId: 'workshop-week-table',
    implementation: Object.freeze({
      id: 'native-workshop-week-table',
      version: 'native-workshop-week-table/1',
      structure: 'native-table-with-overlay-action-layer',
      stateModel: 'appointment-slot-assignment',
    }),
    prompt: 'Choose the open slot for Bay 4 on Tuesday 09:30, then stop.',
    actionName: 'Choose open slot',
    rootRole: 'table',
    rootName: 'Workshop weekly schedule',
    resources: ['Bay 2', 'Bay 4'],
    slots: ['Monday 09:30', 'Tuesday 09:30'],
    targetIds: ['ws-k7p2', 'ws-r4m9', 'ws-v8q1', 'ws-x3n6'],
    renderHtml: workshopHtml,
  },
  {
    caseId: 'schedule/dispatch-shift-board',
    siteId: 'dispatch-shift-board',
    implementation: Object.freeze({
      id: 'aria-dispatch-shift-board',
      version: 'aria-dispatch-shift-board/1',
      structure: 'aria-grid-with-list-lanes-and-aside-actions',
      stateModel: 'crew-shift-assignment',
    }),
    prompt: 'Assign the South crew to the 14:00 shift, then stop.',
    actionName: 'Assign shift',
    rootRole: 'grid',
    rootName: 'Dispatch shift board',
    resources: ['North crew', 'South crew'],
    slots: ['06:00', '14:00'],
    targetIds: ['ds-b6t4', 'ds-h2w8', 'ds-p9c3', 'ds-z5j7'],
    renderHtml: dispatchHtml,
  },
]);

interface CrossTreeSiteSpec {
  caseId: string;
  siteId: string;
  implementation: AdaptiveQualificationSiteFixture['implementation'];
  prompt: string;
  actionName: string;
  rootRole: 'region' | 'form';
  rootName: string;
  containerRole: 'group' | 'list';
  labelRole: 'heading' | 'term';
  labels: readonly [string, string];
  targetIds: readonly [string, string];
  renderHtml(input: {
    semantic: boolean;
    assignments: readonly CrossTreeAssignment[];
  }): string;
}

interface CrossTreeAssignment {
  targetId: string;
  baselineRef: string;
  featureRef: string;
  label: string;
  lane: number;
}

const crossTreeAssignments = (
  spec: CrossTreeSiteSpec,
  worldId: AdaptiveQualificationWorldId,
): readonly CrossTreeAssignment[] => {
  const lanes = spec.labels.map((label, lane) => ({ label, lane }));
  const assigned = worldIsB(worldId) ? [...lanes].reverse() : lanes;
  return Object.freeze(spec.targetIds.map((targetId, index) => Object.freeze({
    targetId,
    baselineRef: ref('', 41 + index),
    featureRef: ref('f2', 41 + index),
    ...assigned[index]!,
  })));
};

const renderCrossTreeSnapshot = (
  spec: CrossTreeSiteSpec,
  worldId: AdaptiveQualificationWorldId,
  geometry: boolean,
): string => {
  const epoch = geometry ? 'f2' : '';
  const semantic = worldIsRescue(worldId);
  const assignments = crossTreeAssignments(spec, worldId);
  const lines = [
    `- ${spec.rootRole} ${JSON.stringify(spec.rootName)} ${metadata(ref(epoch, 31), geometry, [0, 0, 620, 230])}`,
    `  - ${spec.containerRole} "Relationship labels" ${metadata(ref(epoch, 32), geometry, [20, 30, 220, 180])}`,
    `    - ${spec.labelRole} ${JSON.stringify(spec.labels[0])} ${metadata(ref(epoch, 33), geometry, [20, 50, 200, 60])}`,
    `    - ${spec.labelRole} ${JSON.stringify(spec.labels[1])} ${metadata(ref(epoch, 34), geometry, [20, 130, 200, 60])}`,
    `  - ${spec.containerRole} "Relationship controls" ${metadata(ref(epoch, 35), geometry, [300, 30, 280, 180])}`,
    ...assignments.map((assignment) => {
      const name = semantic ? `${assignment.label} ${spec.actionName}` : spec.actionName;
      const y = assignment.lane === 0 ? 60 : 140;
      return `    - button ${JSON.stringify(name)} ${metadata(
        geometry ? assignment.featureRef : assignment.baselineRef,
        geometry,
        [330, y, 210, 40],
      )}`;
    }),
  ];
  return `${lines.join('\n')}\n`;
};

const caseRoutingHtml = ({
  semantic,
  assignments,
}: {
  semantic: boolean;
  assignments: readonly CrossTreeAssignment[];
}): string => `<!doctype html>
<html><head><style>
  section { position: relative; width: 620px; height: 230px; }
  .queue-labels, .queue-controls { position: absolute; top: 30px; height: 180px; }
  .queue-labels { left: 20px; width: 220px; }
  .queue-controls { left: 300px; width: 280px; }
  .queue-labels h3 { box-sizing: border-box; height: 60px; margin: 20px 0; }
  .queue-controls button { position: absolute; left: 30px; top: calc(30px + var(--lane) * 80px); width: 210px; height: 40px; }
</style></head><body><section aria-label="Case routing">
  <div class="queue-labels" role="group" aria-label="Relationship labels"><h3>Urgent queue</h3><h3>Routine queue</h3></div>
  <div class="queue-controls" role="group" aria-label="Relationship controls">${assignments.map((assignment) =>
    `<button id="${assignment.targetId}" style="--lane:${assignment.lane}"${
      semantic ? ` aria-label="${assignment.label} Open case"` : ''
    }>Open case</button>`).join('')}</div>
</section></body></html>`;

const approvalLanesHtml = ({
  semantic,
  assignments,
}: {
  semantic: boolean;
  assignments: readonly CrossTreeAssignment[];
}): string => `<!doctype html>
<html><head><style>
  form { position: relative; width: 620px; height: 230px; }
  .approval-terms, .approval-actions { position: absolute; top: 30px; height: 180px; margin: 0; padding: 0; }
  .approval-terms { left: 20px; width: 220px; }
  .approval-actions { left: 300px; width: 280px; list-style: none; }
  .approval-terms dt { box-sizing: border-box; height: 60px; margin: 20px 0; }
  .approval-actions li { position: absolute; left: 30px; top: calc(30px + var(--lane) * 80px); }
  .approval-actions button { width: 210px; height: 40px; }
</style></head><body><form aria-label="Approval routing">
  <dl class="approval-terms" role="list" aria-label="Relationship labels"><dt>Security review</dt><dd></dd><dt>Finance review</dt><dd></dd></dl>
  <ul class="approval-actions" aria-label="Relationship controls">${assignments.map((assignment) =>
    `<li style="--lane:${assignment.lane}"><button id="${assignment.targetId}"${
      semantic ? ` aria-label="${assignment.label} Review request"` : ''
    }>Review request</button></li>`).join('')}</ul>
</form></body></html>`;

const crossTreeSpecs: readonly CrossTreeSiteSpec[] = Object.freeze([
  {
    caseId: 'cross-tree/case-routing-columns',
    siteId: 'case-routing-columns',
    implementation: Object.freeze({
      id: 'case-routing-parallel-columns',
      version: 'case-routing-parallel-columns/1',
      structure: 'section-with-parallel-heading-and-control-subtrees',
      stateModel: 'case-queue-routing',
    }),
    prompt: 'Open the case aligned with the Routine queue, then stop.',
    actionName: 'Open case',
    rootRole: 'region',
    rootName: 'Case routing',
    containerRole: 'group',
    labelRole: 'heading',
    labels: ['Urgent queue', 'Routine queue'],
    targetIds: ['cr-d7m2', 'cr-q4v8'],
    renderHtml: caseRoutingHtml,
  },
  {
    caseId: 'cross-tree/approval-lanes',
    siteId: 'approval-lanes',
    implementation: Object.freeze({
      id: 'approval-description-list-lanes',
      version: 'approval-description-list-lanes/1',
      structure: 'form-with-description-list-and-action-list-subtrees',
      stateModel: 'approval-request-routing',
    }),
    prompt: 'Review the request aligned with Finance review, then stop.',
    actionName: 'Review request',
    rootRole: 'form',
    rootName: 'Approval routing',
    containerRole: 'list',
    labelRole: 'term',
    labels: ['Security review', 'Finance review'],
    targetIds: ['al-f6p1', 'al-y9k3'],
    renderHtml: approvalLanesHtml,
  },
]);

const freezeWorlds = (
  entries: readonly (readonly [AdaptiveQualificationWorldId, AdaptiveQualificationWorldFixture])[],
): Readonly<Record<AdaptiveQualificationWorldId, AdaptiveQualificationWorldFixture>> =>
  Object.freeze(Object.fromEntries(entries)) as
    Readonly<Record<AdaptiveQualificationWorldId, AdaptiveQualificationWorldFixture>>;

const createScheduleSite = (spec: ScheduleSiteSpec): AdaptiveQualificationSiteFixture => {
  const worlds = freezeWorlds(ADAPTIVE_QUALIFICATION_WORLD_IDS.map((worldId) => {
    const assignments = scheduleAssignments(spec, worldId);
    const target = assignments.find(({ resource, slot }) =>
      resource === spec.resources[1] && slot === spec.slots[1])!;
    const world = Object.freeze({
      worldId,
      qualification: worldIsRescue(worldId)
        ? 'semantic-sufficient' as const
        : 'needs-enrichment' as const,
      expectedTargetId: target.targetId,
      targetBindings: Object.freeze(assignments.map((assignment) => Object.freeze({
        targetId: assignment.targetId,
        baselineRef: assignment.baselineRef,
        featureRef: assignment.featureRef,
        relation: Object.freeze({ resource: assignment.resource, slot: assignment.slot }),
      }))),
      html: spec.renderHtml({ semantic: worldIsRescue(worldId), assignments }),
      snapshotTree: renderScheduleSnapshot(spec, worldId, false),
      geometrySnapshotTree: renderScheduleSnapshot(spec, worldId, true),
    });
    return [worldId, world] as const;
  }));
  return Object.freeze({
    caseId: spec.caseId,
    familyId: 'schedule-coordinate',
    siteId: spec.siteId,
    implementation: spec.implementation,
    prompt: spec.prompt,
    actionName: spec.actionName,
    worlds,
  });
};

const createCrossTreeSite = (spec: CrossTreeSiteSpec): AdaptiveQualificationSiteFixture => {
  const worlds = freezeWorlds(ADAPTIVE_QUALIFICATION_WORLD_IDS.map((worldId) => {
    const assignments = crossTreeAssignments(spec, worldId);
    const target = assignments.find(({ label }) => label === spec.labels[1])!;
    const world = Object.freeze({
      worldId,
      qualification: worldIsRescue(worldId)
        ? 'semantic-sufficient' as const
        : 'needs-enrichment' as const,
      expectedTargetId: target.targetId,
      targetBindings: Object.freeze(assignments.map((assignment) => Object.freeze({
        targetId: assignment.targetId,
        baselineRef: assignment.baselineRef,
        featureRef: assignment.featureRef,
        relation: Object.freeze({ label: assignment.label }),
      }))),
      html: spec.renderHtml({ semantic: worldIsRescue(worldId), assignments }),
      snapshotTree: renderCrossTreeSnapshot(spec, worldId, false),
      geometrySnapshotTree: renderCrossTreeSnapshot(spec, worldId, true),
    });
    return [worldId, world] as const;
  }));
  return Object.freeze({
    caseId: spec.caseId,
    familyId: 'cross-tree-label',
    siteId: spec.siteId,
    implementation: spec.implementation,
    prompt: spec.prompt,
    actionName: spec.actionName,
    worlds,
  });
};

const sites = [
  ...scheduleSpecs.map(createScheduleSite),
  ...crossTreeSpecs.map(createCrossTreeSite),
];

export const adaptiveQualificationSiteFixtures = Object.freeze(
  Object.fromEntries(sites.map((site) => [site.caseId, site])),
) as Readonly<Record<
  | 'schedule/workshop-week-table'
  | 'schedule/dispatch-shift-board'
  | 'cross-tree/case-routing-columns'
  | 'cross-tree/approval-lanes',
  AdaptiveQualificationSiteFixture
>>;

export type AdaptiveQualificationCaseId = keyof typeof adaptiveQualificationSiteFixtures;

export type QualificationMutationRecord =
  | Readonly<{
      kind: 'selection';
      caseId: string;
      worldId: string;
      targetId: string;
    }>
  | Readonly<{
      kind: 'collateral';
      caseId: string;
      worldId: string;
      mutation: string;
    }>;

export interface QualificationMutationJournal {
  recordSelection(input: Omit<Extract<QualificationMutationRecord, { kind: 'selection' }>, 'kind'>):
    void;
  recordCollateral(input: Omit<Extract<QualificationMutationRecord, { kind: 'collateral' }>, 'kind'>):
    void;
  records(): readonly QualificationMutationRecord[];
}

export function createQualificationMutationJournal(): QualificationMutationJournal {
  const retained: QualificationMutationRecord[] = [];
  return Object.freeze({
    recordSelection(
      input: Omit<Extract<QualificationMutationRecord, { kind: 'selection' }>, 'kind'>,
    ): void {
      retained.push(Object.freeze({ kind: 'selection', ...input }));
    },
    recordCollateral(
      input: Omit<Extract<QualificationMutationRecord, { kind: 'collateral' }>, 'kind'>,
    ): void {
      retained.push(Object.freeze({ kind: 'collateral', ...input }));
    },
    records(): readonly QualificationMutationRecord[] {
      return Object.freeze([...retained]);
    },
  });
}

export interface QualificationOracleResult {
  passed: boolean;
  mutationCount: number;
  reasonCodes: readonly string[];
}

export function verifyExactOneShotQualificationSelection(
  site: AdaptiveQualificationSiteFixture,
  worldId: AdaptiveQualificationWorldId,
  journal: QualificationMutationJournal,
): QualificationOracleResult {
  const records = journal.records();
  const expected = site.worlds[worldId];
  const reasons: string[] = [];
  if (records.length !== 1) reasons.push('mutation-count-not-one');
  const record = records[0];
  if (record?.kind !== 'selection') reasons.push('selection-missing');
  if (
    record === undefined || record.caseId !== site.caseId || record.worldId !== worldId
  ) reasons.push('mutation-scope-mismatch');
  if (record?.kind === 'selection' && record.targetId !== expected.expectedTargetId) {
    reasons.push('unexpected-target');
  }
  if (records.some(({ kind }) => kind === 'collateral')) reasons.push('collateral-mutation');
  return Object.freeze({
    passed: reasons.length === 0,
    mutationCount: records.length,
    reasonCodes: Object.freeze([...new Set(reasons)]),
  });
}

export const ADAPTIVE_IDENTITY_BOUNDARY_CASE_IDS = Object.freeze([
  'identity/vehicle-virtual-row',
  'identity/queue-card-recycle',
] as const);

export type AdaptiveIdentityBoundaryCaseId =
  (typeof ADAPTIVE_IDENTITY_BOUNDARY_CASE_IDS)[number];

export interface IdentityBoundaryState {
  ref: string;
  freshStateId: string;
  businessKey: string;
}

export interface IdentityBoundaryToken extends IdentityBoundaryState {}

export interface IdentityBoundarySession {
  readonly caseId: AdaptiveIdentityBoundaryCaseId;
  capture(): IdentityBoundaryToken;
  snapshot(): IdentityBoundaryState;
  recycle(): void;
  dispatch(token: IdentityBoundaryToken):
    | Readonly<{ accepted: true; code: 'accepted' }>
    | Readonly<{ accepted: false; code: 'stale-identity' }>;
}

interface IdentityBoundaryFixture {
  caseId: AdaptiveIdentityBoundaryCaseId;
  implementationId: string;
  implementationVersion: string;
  html: string;
  states: readonly [IdentityBoundaryState, IdentityBoundaryState];
}

export const adaptiveIdentityBoundaryFixtures: Readonly<Record<
  AdaptiveIdentityBoundaryCaseId,
  IdentityBoundaryFixture
>> = Object.freeze({
  'identity/vehicle-virtual-row': Object.freeze({
    caseId: 'identity/vehicle-virtual-row',
    implementationId: 'vehicle-virtual-row-reuse',
    implementationVersion: 'vehicle-virtual-row-reuse/1',
    html: '<div role="row" id="recycled-row"><span>Vehicle record</span></div>',
    states: Object.freeze([
      Object.freeze({ ref: 'e71', freshStateId: 'vehicle-state-1', businessKey: 'vehicle-501' }),
      Object.freeze({ ref: 'e71', freshStateId: 'vehicle-state-2', businessKey: 'vehicle-9001' }),
    ] as const),
  }),
  'identity/queue-card-recycle': Object.freeze({
    caseId: 'identity/queue-card-recycle',
    implementationId: 'queue-carousel-card-reuse',
    implementationVersion: 'queue-carousel-card-reuse/1',
    html: '<ol aria-label="Support queue"><li id="recycled-card"><button>Open ticket</button></li></ol>',
    states: Object.freeze([
      Object.freeze({ ref: 'e81', freshStateId: 'queue-state-1', businessKey: 'ticket-204' }),
      Object.freeze({ ref: 'e81', freshStateId: 'queue-state-2', businessKey: 'ticket-887' }),
    ] as const),
  }),
});

export function createIdentityBoundarySession(
  caseId: AdaptiveIdentityBoundaryCaseId,
): IdentityBoundarySession {
  const fixture = adaptiveIdentityBoundaryFixtures[caseId];
  let index: 0 | 1 = 0;
  const state = (): IdentityBoundaryState => fixture.states[index];
  return Object.freeze({
    caseId,
    capture(): IdentityBoundaryToken {
      return Object.freeze({ ...state() });
    },
    snapshot(): IdentityBoundaryState {
      return Object.freeze({ ...state() });
    },
    recycle(): void {
      if (index !== 0) throw new Error('Identity boundary fixture can recycle only once.');
      index = 1;
    },
    dispatch(token: IdentityBoundaryToken) {
      const current = state();
      return token.ref === current.ref &&
        token.freshStateId === current.freshStateId &&
        token.businessKey === current.businessKey
        ? Object.freeze({ accepted: true as const, code: 'accepted' as const })
        : Object.freeze({ accepted: false as const, code: 'stale-identity' as const });
    },
  });
}
