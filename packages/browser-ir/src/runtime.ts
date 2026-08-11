import { compileView } from './compiler.js';
import {
  MAX_CAPTURE_BYTES,
  MAX_CAPTURE_PHYSICAL_PIXELS,
  MAX_UNSAFE_EVALUATE_EXPRESSION_BYTES,
  MAX_UNSAFE_EVALUATE_EXPRESSION_CHARACTERS,
  MAX_UNSAFE_EVALUATE_OUTPUT_BYTES,
  MAX_UNSAFE_EVALUATE_TIMEOUT_MS,
} from './limits.js';
import { sanitizeModelFacingUrl } from './url.js';
import type {
  ActRequest,
  ActionReceipt,
  BrowserAction,
  BrowserCapture,
  BrowserCreateOptions,
  BrowserDriver,
  BrowserDriverSession,
  BrowserId,
  BrowserSessionInfo,
  CaptureRequest,
  CloseRequest,
  CompiledView,
  DriverObservation,
  DriverObservedEntity,
  DriverTarget,
  DriverUnsafeEvaluateResult,
  Entity,
  EntityChange,
  EntityId,
  EntityRef,
  GraphDelta,
  GraphSnapshot,
  InspectRequest,
  NavigateRequest,
  ObservationResult,
  ObserveRequest,
  ObservedEffect,
  PageId,
  PageInfo,
  PagesRequest,
  Relation,
  ResolvedAction,
  Revision,
  UnsafeEvaluateRequest,
  UnsafeEvaluationOutcome,
  UnsafeEvaluationReceipt,
  ViewOmission,
  WaitCondition,
  WaitRequest,
} from './types.js';

interface StoredEntity {
  identityKey: string;
  sourceId: string;
  target: DriverTarget;
  entity: Entity;
}

interface RebindTransition {
  toRevision: Revision;
  rebindableEntityIds: Set<EntityId>;
}

interface PageState {
  revision: Revision;
  documentId: string | undefined;
  url: string;
  title: string | undefined;
  visibleText: string | undefined;
  capturedOmissions: ViewOmission[];
  entities: Map<EntityId, StoredEntity>;
  relations: Relation[];
  rebindTransitions: Map<Revision, RebindTransition>;
}

interface SessionState {
  driver: BrowserDriverSession;
  initialPageId: PageId;
  pages: Map<PageId, PageState>;
  nextEntityNumber: number;
}

export class BrowserIRError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserIRError';
  }
}

const emptyPage = (): PageState => ({
  revision: 0,
  documentId: undefined,
  url: '',
  title: undefined,
  visibleText: undefined,
  capturedOmissions: [],
  entities: new Map(),
  relations: [],
  rebindTransitions: new Map(),
});

/**
 * Ref rebinding is a short-lived convenience, never an unbounded identity
 * cache. Missing or pruned transitions fail closed and require observation.
 */
const MAX_REBIND_TRANSITIONS = 32;
const NON_STRUCTURAL_ENTITY_FIELDS = new Set(['value', 'state']);

const stableSerialize = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Uint8Array) return `[${[...value].join(',')}]`;
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
};

const same = (left: unknown, right: unknown): boolean => stableSerialize(left) === stableSerialize(right);

const entityChangedFields = (before: Entity, after: Entity): string[] => {
  const fields: Array<keyof Omit<Entity, 'id' | 'pageId'>> = [
    'kind',
    'role',
    'name',
    'description',
    'text',
    'value',
    'state',
    'geometry',
    'capabilities',
    'evidence',
    'confidence',
  ];
  return fields.filter((field) => !same(before[field], after[field]));
};

const relationKey = (relation: Relation): string => `${relation.from}\u0000${relation.kind}\u0000${relation.to}`;

const rebindableEntityIdsForTransition = (
  previous: PageState,
  nextEntities: ReadonlyMap<EntityId, StoredEntity>,
  changed: readonly EntityChange[],
  removed: readonly EntityId[],
  addedRelations: readonly Relation[],
  removedRelations: readonly Relation[],
  pageChanged: boolean,
  stateInvalidated: boolean,
  omissionsChanged: boolean,
  hasCapturedOmissions: boolean,
): EntityId[] => {
  if (pageChanged || stateInvalidated || omissionsChanged || hasCapturedOmissions) return [];
  const blocked = new Set<EntityId>(removed);
  for (const change of changed) {
    if (change.changedFields.some((field) => !NON_STRUCTURAL_ENTITY_FIELDS.has(field))) {
      blocked.add(change.entity.id);
    }
  }
  for (const relation of [...addedRelations, ...removedRelations]) {
    blocked.add(relation.from);
    blocked.add(relation.to);
  }
  return [...previous.entities.keys()]
    .filter((entityId) => nextEntities.has(entityId) && !blocked.has(entityId))
    .sort();
};

const appendRebindTransition = (
  previous: PageState,
  fromRevision: Revision,
  toRevision: Revision,
  rebindableEntityIds: readonly EntityId[],
): Map<Revision, RebindTransition> => {
  const transitions = new Map(previous.rebindTransitions);
  transitions.set(fromRevision, {
    toRevision,
    rebindableEntityIds: new Set(rebindableEntityIds),
  });
  while (transitions.size > MAX_REBIND_TRANSITIONS) {
    const oldest = Math.min(...transitions.keys());
    transitions.delete(oldest);
  }
  return transitions;
};

const canRebindEntityRef = (
  page: PageState,
  ref: EntityRef,
  expectedRevision: Revision,
): boolean => {
  if (
    !Number.isSafeInteger(ref.revision) ||
    ref.revision < 0 ||
    ref.revision > expectedRevision ||
    !page.entities.has(ref.entityId)
  ) {
    return false;
  }
  if (ref.revision === expectedRevision) return true;
  let revision = ref.revision;
  let traversed = 0;
  while (revision < expectedRevision && traversed <= MAX_REBIND_TRANSITIONS) {
    const transition = page.rebindTransitions.get(revision);
    if (
      transition === undefined ||
      transition.toRevision <= revision ||
      transition.toRevision > expectedRevision ||
      !transition.rebindableEntityIds.has(ref.entityId)
    ) {
      return false;
    }
    revision = transition.toRevision;
    traversed += 1;
  }
  return revision === expectedRevision;
};

const snapshotFrom = (browserId: BrowserId, pageId: PageId, page: PageState): GraphSnapshot => ({
  browserId,
  pageId,
  revision: page.revision,
  url: page.url,
  ...(page.title === undefined ? {} : { title: page.title }),
  ...(page.visibleText === undefined ? {} : { visibleText: page.visibleText }),
  ...(page.capturedOmissions.length === 0
    ? {}
    : { capturedOmissions: page.capturedOmissions.map((omission) => ({ ...omission })) }),
  entities: [...page.entities.values()].map((stored) => ({ ...stored.entity })),
  relations: page.relations.map((relation) => ({ ...relation })),
});

const canonicalEntity = (pageId: PageId, id: EntityId, observed: DriverObservedEntity): Entity => ({
  id,
  pageId,
  kind: observed.kind,
  ...(observed.role === undefined ? {} : { role: observed.role }),
  ...(observed.name === undefined ? {} : { name: observed.name }),
  ...(observed.description === undefined ? {} : { description: observed.description }),
  ...(observed.text === undefined ? {} : { text: observed.text }),
  ...(observed.value === undefined ? {} : { value: observed.value }),
  state: { ...(observed.state ?? {}) },
  ...(observed.geometry === undefined ? {} : { geometry: { ...observed.geometry } }),
  capabilities: (observed.capabilities ?? []).map((capability) => ({ ...capability })),
  evidence: (observed.evidence ?? []).map((evidence) => ({ ...evidence })),
  confidence: observed.confidence ?? 1,
});

const referencesForAction = (action: BrowserAction): EntityRef[] => {
  switch (action.kind) {
    case 'press':
    case 'scroll':
      return action.target ? [action.target] : [];
    case 'drag':
      return [action.target, action.destination];
    default:
      return [action.target];
  }
};

const capabilityTargetForAction = (
  action: BrowserAction,
): EntityRef | undefined => {
  switch (action.kind) {
    case 'press':
    case 'scroll':
      return action.target;
    default:
      return action.target;
  }
};

const actionHasEnabledCapability = (
  action: BrowserAction,
  page: PageState,
): boolean => {
  const target = capabilityTargetForAction(action);
  if (target === undefined) return true;
  return (
    page.entities
      .get(target.entityId)
      ?.entity.capabilities.some(
        (capability) =>
          capability.kind === action.kind && capability.enabled !== false,
      ) === true
  );
};

const hasDelta = (delta: GraphDelta): boolean =>
  delta.stateInvalidated === true ||
  delta.pageChanged ||
  delta.added.length > 0 ||
  delta.removed.length > 0 ||
  delta.changed.length > 0 ||
  delta.addedRelations.length > 0 ||
  delta.removedRelations.length > 0;

const graphChangeDetail = (delta: GraphDelta): string => {
  if (
    delta.stateInvalidated !== true &&
    !delta.pageChanged &&
    delta.added.length === 0 &&
    delta.removed.length === 0 &&
    delta.changed.length === 1 &&
    delta.addedRelations.length === 0 &&
    delta.removedRelations.length === 0
  ) {
    return '1 entity changed';
  }
  const count =
    Number(delta.stateInvalidated === true) +
    Number(delta.pageChanged) +
    delta.added.length +
    delta.removed.length +
    delta.changed.length +
    delta.addedRelations.length +
    delta.removedRelations.length;
  return `${count} graph ${count === 1 ? 'change' : 'changes'}`;
};

const EVALUATION_OUTCOMES = new Set<UnsafeEvaluationOutcome>([
  'completed',
  'exception',
  'timed_out',
  'cancelled',
  'context_destroyed',
  'serialization_failed',
  'output_too_large',
]);

const isJsonValue = (
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): boolean => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth >= 64 || seen.has(value)) return false;
  seen.add(value);
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>);
  if (entries.length > 100_000) return false;
  return entries.every(([, item]) => isJsonValue(item, depth + 1, seen));
};

const normalizeEvaluation = (
  result: DriverUnsafeEvaluateResult,
  maxOutputBytes: number,
): DriverUnsafeEvaluateResult => {
  const browserInvalidated = result.browserInvalidated === true;
  const outcome = EVALUATION_OUTCOMES.has(result.outcome)
    ? result.outcome
    : 'exception';
  const outputBytes =
    result.outputBytes !== undefined &&
    Number.isSafeInteger(result.outputBytes) &&
    result.outputBytes >= 0
      ? result.outputBytes
      : undefined;
  if (
    outcome === 'completed' &&
    (result.value === undefined ||
      !isJsonValue(result.value) ||
      outputBytes === undefined)
  ) {
    return {
      dispatched: result.dispatched === true,
      outcome: 'serialization_failed',
      outputOmitted: true,
      ...(browserInvalidated ? { browserInvalidated: true } : {}),
    };
  }
  if (
    outcome === 'completed' &&
    outputBytes !== undefined &&
    outputBytes > maxOutputBytes
  ) {
    return {
      dispatched: result.dispatched === true,
      outcome: 'output_too_large',
      outputBytes,
      outputOmitted: true,
      ...(browserInvalidated ? { browserInvalidated: true } : {}),
    };
  }
  return {
    dispatched: result.dispatched === true,
    outcome,
    ...(outcome === 'completed' ? { value: result.value! } : {}),
    ...(outputBytes === undefined ? {} : { outputBytes }),
    ...(result.outputOmitted === undefined
      ? {}
      : { outputOmitted: result.outputOmitted === true }),
    ...(result.terminationAttempted === undefined
      ? {}
      : { terminationAttempted: result.terminationAttempted === true }),
    ...(result.terminationConfirmed === undefined
      ? {}
      : { terminationConfirmed: result.terminationConfirmed === true }),
    ...(browserInvalidated ? { browserInvalidated: true } : {}),
  };
};

const evaluationError = (
  outcome: Exclude<UnsafeEvaluationOutcome, 'completed'>,
): { code: string; message: string } => {
  switch (outcome) {
    case 'exception':
      return {
        code: 'evaluation_exception',
        message: 'Page code threw an exception; details were withheld.',
      };
    case 'timed_out':
      return {
        code: 'evaluation_timeout',
        message: 'Page code exceeded its execution deadline and was terminated.',
      };
    case 'cancelled':
      return {
        code: 'evaluation_cancelled',
        message: 'Page code evaluation was cancelled.',
      };
    case 'context_destroyed':
      return {
        code: 'evaluation_context_destroyed',
        message: 'The page execution context changed during evaluation.',
      };
    case 'serialization_failed':
      return {
        code: 'evaluation_result_unsupported',
        message: 'The page result could not be represented as bounded JSON.',
      };
    case 'output_too_large':
      return {
        code: 'evaluation_output_too_large',
        message: 'The page result exceeded the configured output limit and was omitted.',
      };
  }
};

const actionEffectVerified = (
  action: BrowserAction,
  before: PageState,
  observation: ObservationResult,
): boolean => {
  const refs = referencesForAction(action);
  const primary = refs[0];
  const primaryChanged =
    primary !== undefined &&
    (observation.delta.removed.includes(primary.entityId) ||
      observation.delta.changed.some((change) => change.entity.id === primary.entityId));
  const destinationChanged =
    action.kind === 'drag' &&
    (observation.delta.removed.includes(action.destination.entityId) ||
      observation.delta.changed.some((change) => change.entity.id === action.destination.entityId));
  const beforeEntity = primary === undefined ? undefined : before.entities.get(primary.entityId)?.entity;
  const afterEntity =
    primary === undefined
      ? undefined
      : observation.snapshot.entities.find((entity) => entity.id === primary.entityId);
  const changedBeyondFocus = (
    beforeEntity: Entity | undefined,
    afterEntity: Entity | undefined,
    includeGeometry = false,
  ): boolean => {
    if (beforeEntity === undefined || afterEntity === undefined) {
      return beforeEntity !== afterEntity;
    }
    const comparable = (entity: Entity): unknown => {
      const { focused: _focused, ...state } = entity.state;
      return {
        kind: entity.kind,
        role: entity.role,
        name: entity.name,
        description: entity.description,
        text: entity.text,
        value: entity.value,
        state,
        capabilities: entity.capabilities,
        ...(includeGeometry ? { geometry: entity.geometry } : {}),
      };
    };
    return !same(comparable(beforeEntity), comparable(afterEntity));
  };
  const primaryChangedBeyondFocus = changedBeyondFocus(
    beforeEntity,
    afterEntity,
  );
  const targetCorrelatedPageFeedback = (): boolean => {
    const name = beforeEntity?.name?.normalize('NFKC').toLowerCase();
    if (!name) return false;
    const normalize = (value: string | undefined): string =>
      (value ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
    const occurrences = (value: string, needle: string): number =>
      value.split(needle).length - 1;
    const beforeText = normalize(before.visibleText);
    const afterText = normalize(observation.snapshot.visibleText);
    return (
      afterText !== beforeText &&
      occurrences(afterText, name) > occurrences(beforeText, name)
    );
  };
  const newlyObservedValidationFeedback = (): boolean => {
    const isValidationFeedback = (entity: Entity): boolean =>
      entity.state.visible !== false &&
      (entity.role === 'alert' || entity.state.invalid === true);
    return (
      observation.delta.added.some(isValidationFeedback) ||
      observation.delta.changed.some(({ entity }) => {
        if (!isValidationFeedback(entity)) return false;
        const prior = before.entities.get(entity.id)?.entity;
        return (
          prior === undefined ||
          (entity.role === 'alert' && prior.role !== 'alert') ||
          (entity.state.invalid === true && prior.state.invalid !== true)
        );
      })
    );
  };

  switch (action.kind) {
    case 'fill':
      return (
        primaryChanged === true &&
          (afterEntity?.value === action.value ||
            (afterEntity?.value === undefined &&
              afterEntity?.state.hasValue === (action.value.length > 0) &&
              beforeEntity?.state.hasValue !== afterEntity.state.hasValue))
      );
    case 'type':
      return (
        primaryChanged === true &&
          ((typeof beforeEntity?.value === 'string' &&
            typeof afterEntity?.value === 'string' &&
            afterEntity.value !== beforeEntity.value) ||
            (beforeEntity?.state.hasValue !== true &&
              afterEntity?.state.hasValue === true))
      );
    case 'select': {
      const selectedOptionValues = (
        entities: Iterable<Entity>,
        relations: Iterable<Relation>,
      ): string[] => {
        if (primary === undefined) return [];
        const optionIds = new Set(
          [...relations]
            .filter(
              (relation) =>
                relation.kind === 'option-of' &&
                relation.to === primary.entityId,
            )
            .map((relation) => relation.from),
        );
        return [...entities]
          .filter(
            (entity) =>
              optionIds.has(entity.id) &&
              entity.state.selected === true &&
              typeof entity.value === 'string',
          )
          .map((entity) => entity.value as string)
          .filter((value, index, values) => values.indexOf(value) === index)
          .sort();
      };
      const beforeSelected = selectedOptionValues(
        [...before.entities.values()].map((stored) => stored.entity),
        before.relations,
      );
      const afterSelected = selectedOptionValues(
        observation.snapshot.entities,
        observation.snapshot.relations,
      );
      if (afterSelected.length > 0 || beforeSelected.length > 0) {
        const requested = [...new Set(action.values)].sort();
        return (
          !same(beforeSelected, afterSelected) &&
          same(afterSelected, requested)
        );
      }
      const selectedValue = afterEntity?.value;
      return (
        primaryChanged === true &&
          (typeof selectedValue === 'string'
            ? action.values.includes(selectedValue)
            : Array.isArray(selectedValue) &&
              action.values.every((value) => selectedValue.includes(value)))
      );
    }
    case 'check':
      return (
        primaryChanged === true &&
        afterEntity?.state.checked === action.checked
      );
    case 'focus':
      return primaryChanged === true && afterEntity?.state.focused === true;
    case 'click':
      return (
        primaryChangedBeyondFocus ||
        targetCorrelatedPageFeedback() ||
        newlyObservedValidationFeedback()
      );
    case 'contextClick':
    case 'doubleClick':
      return primaryChangedBeyondFocus;
    case 'press':
      return primaryChangedBeyondFocus;
    case 'drag': {
      const beforeDestination = before.entities.get(
        action.destination.entityId,
      )?.entity;
      const afterDestination = observation.snapshot.entities.find(
        (entity) => entity.id === action.destination.entityId,
      );
      return (
        changedBeyondFocus(beforeEntity, afterEntity, true) ||
        (destinationChanged &&
          changedBeyondFocus(beforeDestination, afterDestination, true))
      );
    }
    case 'upload':
      return primaryChangedBeyondFocus;
    case 'hover':
    case 'scroll':
      return false;
  }
};

const conditionMatches = (condition: WaitCondition, result: ObservationResult): boolean => {
  switch (condition.kind) {
    case 'revision_after':
      return result.snapshot.revision > condition.revision;
    case 'entity_present':
      return result.snapshot.entities.some(
        (entity) =>
          (condition.role === undefined || entity.role === condition.role) &&
          (condition.name === undefined || entity.name === condition.name),
      );
    case 'entity_state': {
      const entity = result.snapshot.entities.find((candidate) => candidate.id === condition.target.entityId);
      if (!entity) return false;
      return Object.entries(condition.state).every(
        ([key, value]) => entity.state[key as keyof typeof entity.state] === value,
      );
    }
    case 'text_includes':
      return (
        (result.snapshot.visibleText ?? '').includes(condition.text) ||
        result.snapshot.entities.some(
          (entity) =>
            (entity.text ?? '').includes(condition.text) ||
            (entity.name ?? '').includes(condition.text) ||
            (typeof entity.value === 'string' && entity.value.includes(condition.text)),
        )
      );
    case 'settled':
      return false;
  }
};

export class BrowserIRRuntime {
  private readonly sessions = new Map<BrowserId, SessionState>();

  constructor(private readonly driver: BrowserDriver) {}

  async create(options?: BrowserCreateOptions): Promise<BrowserSessionInfo> {
    const driverSession = await this.driver.createSession(options);
    if (this.sessions.has(driverSession.browserId)) {
      const duplicate = new BrowserIRError(
        'duplicate_browser',
        `Browser ${driverSession.browserId} already exists.`,
      );
      await driverSession.close().catch(() => {});
      throw duplicate;
    }
    this.sessions.set(driverSession.browserId, {
      driver: driverSession,
      initialPageId: driverSession.initialPageId,
      pages: new Map(),
      nextEntityNumber: 1,
    });
    return {
      browserId: driverSession.browserId,
      initialPageId: driverSession.initialPageId,
      revision: 0,
    };
  }

  async navigate(request: NavigateRequest): Promise<ObservationResult> {
    const session = this.session(request.browserId);
    const pageId = request.pageId ?? session.initialPageId;
    const currentRevision = session.pages.get(pageId)?.revision ?? 0;
    if (request.expectedRevision !== currentRevision) {
      throw new BrowserIRError(
        'stale_revision',
        `Expected revision ${request.expectedRevision}, current revision is ${currentRevision}.`,
      );
    }
    const observed = await session.driver.navigate({ pageId, url: request.url });
    return this.reconcileAndCompile(request.browserId, session, observed, request.budget);
  }

  async observe(request: ObserveRequest): Promise<ObservationResult> {
    const session = this.session(request.browserId);
    const pageId = request.pageId ?? session.initialPageId;
    const observed = await session.driver.observe({ pageId });
    return this.reconcileAndCompile(request.browserId, session, observed, request.budget);
  }

  async inspect(request: InspectRequest): Promise<CompiledView> {
    const session = this.session(request.browserId);
    const pageId = request.pageId ?? session.initialPageId;
    let page = session.pages.get(pageId);
    if (!page) {
      await this.observe({ browserId: request.browserId, pageId });
      page = session.pages.get(pageId);
    }
    if (!page) throw new BrowserIRError('unknown_page', `Page ${pageId} has not been observed.`);

    const omissions: ViewOmission[] = [];
    let entityIds: ReadonlySet<EntityId> | undefined;
    if (request.refs) {
      const live = new Set<EntityId>();
      let stale = 0;
      for (const ref of request.refs) {
        if (
          ref.browserId !== request.browserId ||
          ref.pageId !== pageId ||
          ref.revision !== page.revision ||
          !page.entities.has(ref.entityId)
        ) {
          stale += 1;
        } else {
          live.add(ref.entityId);
        }
      }
      entityIds = live;
      if (stale > 0) omissions.push({ kind: 'stale_refs', count: stale, reason: 'stale_reference' });
    }

    return compileView(snapshotFrom(request.browserId, pageId, page), {
      ...(request.budget === undefined ? {} : { budget: request.budget }),
      ...(entityIds === undefined ? {} : { entityIds }),
      ...(omissions.length === 0 ? {} : { additionalOmissions: omissions }),
      ...(request.includeEvidence === undefined
        ? {}
        : { includeEvidence: request.includeEvidence }),
    });
  }

  async act(request: ActRequest): Promise<ActionReceipt> {
    const session = this.session(request.browserId);
    const pageId = request.pageId ?? session.initialPageId;
    let page = session.pages.get(pageId);
    const currentRevision = page?.revision ?? 0;
    if (page === undefined || request.expectedRevision !== currentRevision) {
      return this.staleReceipt(
        currentRevision,
        `Expected revision ${request.expectedRevision}, current revision is ${currentRevision}.`,
      );
    }

    try {
      const observed = await session.driver.observe({ pageId });
      const refreshed = this.reconcileAndCompile(request.browserId, session, observed, request.budget);
      if (refreshed.snapshot.revision !== request.expectedRevision) {
        return this.staleReceipt(
          refreshed.snapshot.revision,
          `Expected revision ${request.expectedRevision}, current revision is ${refreshed.snapshot.revision}.`,
        );
      }
      page = session.pages.get(pageId);
      if (page === undefined) {
        return this.staleReceipt(refreshed.snapshot.revision, `Page ${pageId} is no longer available.`);
      }
    } catch (error) {
      return {
        status: 'blocked',
        dispatched: false,
        preRevision: currentRevision,
        effects: [],
        error: {
          code: 'pre_action_observation_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const refs = referencesForAction(request.action);
    const stale = refs.find(
      (ref) =>
        ref.browserId !== request.browserId ||
        ref.pageId !== pageId ||
        !canRebindEntityRef(page, ref, request.expectedRevision),
    );
    if (stale) {
      return this.staleReceipt(currentRevision, `Entity reference ${stale.entityId} is stale.`);
    }

    if (!actionHasEnabledCapability(request.action, page)) {
      const target = capabilityTargetForAction(request.action);
      return {
        status: 'blocked',
        dispatched: false,
        preRevision: currentRevision,
        effects: [],
        error: {
          code: 'unsupported_action',
          message:
            target === undefined
              ? `Action ${request.action.kind} is not supported.`
              : `Entity ${target.entityId} does not expose an enabled ${request.action.kind} capability.`,
        },
      };
    }

    const resolved = this.resolveAction(request.action, page);
    const dispatch = await session.driver.act({ pageId, action: resolved });
    if (!dispatch.dispatched) {
      return {
        status: 'blocked',
        dispatched: false,
        preRevision: currentRevision,
        effects: dispatch.effects?.map((effect) => ({ ...effect })) ?? [],
        ...(dispatch.error === undefined ? {} : { error: { ...dispatch.error } }),
      };
    }

    let observation: ObservationResult;
    try {
      const observed = await session.driver.observe({ pageId });
      observation = this.reconcileAndCompile(request.browserId, session, observed, request.budget);
    } catch (error) {
      return {
        status: 'dispatched_unverified',
        dispatched: true,
        preRevision: currentRevision,
        effects: dispatch.effects?.map((effect) => ({ ...effect })) ?? [],
        error: {
          code: 'post_action_observation_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const effects: ObservedEffect[] = dispatch.effects?.map((effect) => ({ ...effect })) ?? [];
    if (hasDelta(observation.delta)) {
      effects.unshift({
        kind: 'graph_changed',
        verified: actionEffectVerified(request.action, page, observation),
        detail: graphChangeDetail(observation.delta),
      });
    }
    const verified = effects.some((effect) => effect.verified);

    return {
      status: verified ? 'verified' : 'dispatched_unverified',
      dispatched: true,
      preRevision: currentRevision,
      postRevision: observation.snapshot.revision,
      effects,
      delta: observation.delta,
      observation,
      ...(dispatch.error === undefined ? {} : { error: { ...dispatch.error } }),
    };
  }

  async evaluateUnsafe(
    request: UnsafeEvaluateRequest,
  ): Promise<UnsafeEvaluationReceipt> {
    if (
      request.expression.length === 0 ||
      request.expression.length >
        MAX_UNSAFE_EVALUATE_EXPRESSION_CHARACTERS ||
      new TextEncoder().encode(request.expression).byteLength >
        MAX_UNSAFE_EVALUATE_EXPRESSION_BYTES ||
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs < 1 ||
      request.timeoutMs > MAX_UNSAFE_EVALUATE_TIMEOUT_MS ||
      !Number.isSafeInteger(request.maxOutputBytes) ||
      request.maxOutputBytes < 1 ||
      request.maxOutputBytes > MAX_UNSAFE_EVALUATE_OUTPUT_BYTES
    ) {
      throw new BrowserIRError(
        'invalid_evaluation_request',
        'Unsafe evaluation requires code and execution bounds within the published hard limits.',
      );
    }
    const session = this.session(request.browserId);
    const pageId = request.pageId;
    const currentPage = session.pages.get(pageId);
    const currentRevision = currentPage?.revision ?? 0;
    if (
      currentPage === undefined ||
      request.expectedRevision !== currentRevision
    ) {
      throw new BrowserIRError(
        'stale_revision',
        `Expected revision ${request.expectedRevision}, current revision is ${currentRevision}.`,
      );
    }

    let refreshed: ObservationResult;
    try {
      const observed = await session.driver.observe({ pageId });
      refreshed = this.reconcileAndCompile(
        request.browserId,
        session,
        observed,
        request.budget,
      );
    } catch {
      throw new BrowserIRError(
        'pre_evaluation_observation_failed',
        'Could not verify the page revision before unsafe evaluation.',
      );
    }
    if (refreshed.snapshot.revision !== request.expectedRevision) {
      throw new BrowserIRError(
        'stale_revision',
        `Expected revision ${request.expectedRevision}, current revision is ${refreshed.snapshot.revision}.`,
      );
    }

    const evaluate = session.driver.evaluateUnsafe;
    if (evaluate === undefined) {
      throw new BrowserIRError(
        'unsafe_evaluation_unsupported',
        'The selected browser driver does not support unsafe page evaluation.',
      );
    }

    if (request.signal?.aborted === true) {
      return {
        outcome: 'cancelled',
        dispatched: false,
        preRevision: refreshed.snapshot.revision,
        postRevision: refreshed.snapshot.revision,
        observation: refreshed,
        postObservation: 'completed',
        openedPageIds: [],
        error: evaluationError('cancelled'),
      };
    }

    const pagesBefore = new Set(
      await session.driver
        .pages()
        .then((pages) => pages.map((page) => page.pageId))
        .catch(() => []),
    );
    let evaluation: DriverUnsafeEvaluateResult;
    let driverEvaluationThrew = false;
    try {
      evaluation = await evaluate.call(session.driver, {
        pageId,
        expression: request.expression,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch {
      // A conforming driver returns a normalized result. If it throws after the
      // call began, conservatively assume code may still be running and remove
      // the browser instead of trusting a subsequent observation.
      driverEvaluationThrew = true;
      evaluation = {
        dispatched: true,
        outcome: request.signal?.aborted ? 'cancelled' : 'exception',
        browserInvalidated: true,
      };
    }
    evaluation = normalizeEvaluation(evaluation, request.maxOutputBytes);

    if (evaluation.browserInvalidated === true) {
      this.sessions.delete(request.browserId);
      if (driverEvaluationThrew) {
        try {
          void session.driver.close().catch(() => {});
        } catch {
          // Logical removal is the fail-closed boundary even for a
          // nonconforming driver whose cleanup call throws synchronously.
        }
      }
      return {
        ...evaluation,
        preRevision: refreshed.snapshot.revision,
        postObservation: 'failed',
        browserInvalidated: true,
        openedPageIds: [],
        ...(evaluation.outcome === 'completed'
          ? {}
          : { error: evaluationError(evaluation.outcome) }),
        postObservationError: {
          code: 'evaluation_containment_failed',
          message:
            'BrowserIR could not confirm page-level execution containment; the browser was invalidated.',
        },
      };
    }

    try {
      const observed = await session.driver.observe({ pageId });
      const observation = this.reconcileAndCompile(
        request.browserId,
        session,
        observed,
        request.budget,
        evaluation.dispatched,
      );
      const pagesAfter = await session.driver.pages().catch(() => []);
      const openedPageIds = pagesAfter
        .map((page) => page.pageId)
        .filter((candidate) => !pagesBefore.has(candidate))
        .sort();
      return {
        ...evaluation,
        preRevision: refreshed.snapshot.revision,
        postRevision: observation.snapshot.revision,
        observation,
        postObservation: 'completed',
        openedPageIds,
        ...(evaluation.outcome === 'completed'
          ? {}
          : { error: evaluationError(evaluation.outcome) }),
      };
    } catch {
      try {
        await session.driver.close();
      } catch {
        // Removing the session is the final fail-closed boundary even if the
        // external browser process itself cannot confirm shutdown.
      } finally {
        this.sessions.delete(request.browserId);
      }
      return {
        ...evaluation,
        preRevision: refreshed.snapshot.revision,
        postObservation: 'failed',
        browserInvalidated: true,
        openedPageIds: [],
        ...(evaluation.outcome === 'completed'
          ? {}
          : { error: evaluationError(evaluation.outcome) }),
        postObservationError: {
          code: 'post_evaluation_observation_failed',
          message:
            'BrowserIR could not verify page state after unsafe evaluation; the browser was invalidated.',
        },
      };
    }
  }

  async wait(request: WaitRequest): Promise<ObservationResult> {
    const session = this.session(request.browserId);
    const pageId = request.pageId ?? session.initialPageId;
    const currentRevision = session.pages.get(pageId)?.revision ?? 0;
    if (request.expectedRevision !== currentRevision) {
      throw new BrowserIRError(
        'stale_revision',
        `Expected revision ${request.expectedRevision}, current revision is ${currentRevision}.`,
      );
    }
    if (request.condition.kind === 'entity_state') {
      const target = request.condition.target;
      if (
        target.browserId !== request.browserId ||
        target.pageId !== pageId ||
        target.revision !== currentRevision ||
        !session.pages.get(pageId)?.entities.has(target.entityId)
      ) {
        throw new BrowserIRError(
          'stale_target',
          `Entity reference ${target.entityId} is stale.`,
        );
      }
    }
    const timeoutMs = request.timeoutMs ?? 5_000;
    const pollIntervalMs = request.pollIntervalMs ?? 50;
    const startedAt = Date.now();
    let latest: ObservationResult;
    let stableObservations = 0;
    do {
      latest = await this.observe({
        browserId: request.browserId,
        ...(request.pageId === undefined ? {} : { pageId: request.pageId }),
        ...(request.budget === undefined ? {} : { budget: request.budget }),
      });
      if (request.condition.kind === 'settled') {
        const hasBusyEntity = latest.snapshot.entities.some(
          (entity) => entity.state.busy === true,
        );
        stableObservations =
          !hasDelta(latest.delta) && !hasBusyEntity
            ? stableObservations + 1
            : 0;
        if (stableObservations >= 2) return latest;
      } else if (conditionMatches(request.condition, latest)) {
        return latest;
      }
      if (Date.now() - startedAt >= timeoutMs) break;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    } while (true);
    throw new BrowserIRError('wait_timeout', `Wait condition was not met within ${timeoutMs}ms.`);
  }

  async pages(request: PagesRequest): Promise<PageInfo[]> {
    const session = this.session(request.browserId);
    const pages = await session.driver.pages();
    return pages
      .map((page) => ({
        browserId: request.browserId,
        pageId: page.pageId,
        url: sanitizeModelFacingUrl(page.url),
        ...(page.title === undefined ? {} : { title: page.title }),
        ...(page.openerPageId === undefined ? {} : { openerPageId: page.openerPageId }),
        revision: session.pages.get(page.pageId)?.revision ?? 0,
      }))
      .sort((left, right) => left.pageId.localeCompare(right.pageId));
  }

  async capture(request: CaptureRequest): Promise<BrowserCapture> {
    const session = this.session(request.browserId);
    const pageId = request.pageId ?? session.initialPageId;
    let page = session.pages.get(pageId);
    if (!page) {
      await this.observe({ browserId: request.browserId, pageId });
      page = session.pages.get(pageId);
    }
    if (!page) throw new BrowserIRError('unknown_page', `Page ${pageId} has not been observed.`);
    if (request.expectedRevision !== page.revision) {
      throw new BrowserIRError(
        'stale_revision',
        `Expected revision ${request.expectedRevision}, current revision is ${page.revision}.`,
      );
    }

    let target: DriverTarget | undefined;
    if (request.target) {
      if (
        request.target.browserId !== request.browserId ||
        request.target.pageId !== pageId ||
        request.target.revision !== page.revision
      ) {
        throw new BrowserIRError('stale_target', `Entity reference ${request.target.entityId} is stale.`);
      }
      target = page.entities.get(request.target.entityId)?.target;
      if (!target) throw new BrowserIRError('stale_target', `Entity reference ${request.target.entityId} is stale.`);
    }

    const capture = await session.driver.capture({
      pageId,
      kind: request.kind,
      ...(target === undefined ? {} : { target }),
    });
    const clipIsValid =
      capture.clip === undefined ||
      (Number.isFinite(capture.clip.x) &&
        Number.isFinite(capture.clip.y) &&
        Number.isFinite(capture.clip.width) &&
        capture.clip.width > 0 &&
        Number.isFinite(capture.clip.height) &&
        capture.clip.height > 0);
    if (
      capture.pageId !== pageId ||
      !(capture.data instanceof Uint8Array) ||
      !Number.isFinite(capture.width) ||
      capture.width <= 0 ||
      !Number.isFinite(capture.height) ||
      capture.height <= 0 ||
      !Number.isFinite(capture.deviceScaleFactor) ||
      capture.deviceScaleFactor <= 0 ||
      !Number.isFinite(capture.scrollX) ||
      !Number.isFinite(capture.scrollY) ||
      (capture.capturedAt !== undefined &&
        (!Number.isFinite(capture.capturedAt) || capture.capturedAt < 0)) ||
      !clipIsValid
    ) {
      throw new BrowserIRError(
        'capture_invalid',
        'The browser driver returned invalid capture identity, bytes, or geometry.',
      );
    }
    const physicalPixels =
      capture.width *
      capture.height *
      capture.deviceScaleFactor *
      capture.deviceScaleFactor;
    if (
      !Number.isFinite(physicalPixels) ||
      physicalPixels > MAX_CAPTURE_PHYSICAL_PIXELS
    ) {
      throw new BrowserIRError(
        'capture_too_large',
        `Capture exceeds the ${MAX_CAPTURE_PHYSICAL_PIXELS} physical-pixel limit.`,
      );
    }
    if (capture.data.byteLength > MAX_CAPTURE_BYTES) {
      throw new BrowserIRError(
        'capture_too_large',
        `Capture exceeds the ${MAX_CAPTURE_BYTES}-byte encoded-image limit.`,
      );
    }
    let verified: ObservationResult;
    try {
      const observed = await session.driver.observe({ pageId });
      verified = this.reconcileAndCompile(request.browserId, session, observed);
    } catch {
      throw new BrowserIRError(
        'capture_verification_failed',
        'Could not verify that the page remained stable during capture; observe and retry.',
      );
    }
    if (verified.snapshot.revision !== request.expectedRevision) {
      throw new BrowserIRError(
        'capture_invalidated',
        `Page changed from revision ${request.expectedRevision} to ${verified.snapshot.revision} during capture; observe and retry.`,
      );
    }
    return {
      ...capture,
      browserId: request.browserId,
      revision: request.expectedRevision,
      ...(request.target === undefined ? {} : { target: request.target }),
    };
  }

  async close(request: CloseRequest): Promise<void> {
    const session = this.session(request.browserId);
    await session.driver.close(request.pageId === undefined ? undefined : { pageId: request.pageId });
    if (request.pageId === undefined) {
      this.sessions.delete(request.browserId);
    } else {
      session.pages.delete(request.pageId);
    }
  }

  /**
   * Fail-closed removal used when unsafe-evaluation verification or auditing
   * cannot be completed. The handle is invalidated even if driver shutdown
   * itself reports a failure.
   */
  async invalidateBrowser(browserId: BrowserId): Promise<void> {
    const session = this.session(browserId);
    try {
      await session.driver.close();
    } finally {
      this.sessions.delete(browserId);
    }
  }

  private session(browserId: BrowserId): SessionState {
    const session = this.sessions.get(browserId);
    if (!session) throw new BrowserIRError('unknown_browser', `Browser ${browserId} does not exist.`);
    return session;
  }

  private reconcileAndCompile(
    browserId: BrowserId,
    session: SessionState,
    observation: DriverObservation,
    budget?: ObserveRequest['budget'],
    stateInvalidated = false,
  ): ObservationResult {
    const observationUrl = sanitizeModelFacingUrl(observation.url);
    const previous = session.pages.get(observation.pageId) ?? emptyPage();
    const oldByIdentity = new Map<string, StoredEntity[]>();
    for (const stored of previous.entities.values()) {
      const matches = oldByIdentity.get(stored.identityKey) ?? [];
      matches.push(stored);
      oldByIdentity.set(stored.identityKey, matches);
    }
    for (const matches of oldByIdentity.values()) {
      matches.sort((left, right) => left.entity.id.localeCompare(right.entity.id));
    }
    const oldBySource = new Map<string, StoredEntity>();
    for (const stored of previous.entities.values()) {
      oldBySource.set(stored.sourceId, stored);
    }

    const usedIds = new Set<EntityId>();
    const nextEntities = new Map<EntityId, StoredEntity>();
    const observedSorted = [...observation.entities].sort(
      (left, right) =>
        left.identityKey.localeCompare(right.identityKey) || left.sourceId.localeCompare(right.sourceId),
    );
    for (const observed of observedSorted) {
      const sourceMatch = oldBySource.get(observed.sourceId);
      const prior =
        sourceMatch?.identityKey === observed.identityKey && !usedIds.has(sourceMatch.entity.id)
          ? sourceMatch
          : oldByIdentity
              .get(observed.identityKey)
              ?.find((candidate) => !usedIds.has(candidate.entity.id));
      const id = prior?.entity.id ?? `e${session.nextEntityNumber++}`;
      usedIds.add(id);
      nextEntities.set(id, {
        identityKey: observed.identityKey,
        sourceId: observed.sourceId,
        target: { ...observed.target },
        entity: canonicalEntity(observation.pageId, id, observed),
      });
    }

    const sourceToId = new Map<string, EntityId>();
    for (const stored of nextEntities.values()) {
      sourceToId.set(stored.sourceId, stored.entity.id);
    }
    const nextRelations: Relation[] = [];
    for (const observed of observation.relations ?? []) {
      const from = sourceToId.get(observed.fromSourceId);
      const to = sourceToId.get(observed.toSourceId);
      if (!from || !to) continue;
      nextRelations.push({
        from,
        to,
        kind: observed.kind,
        ...(observed.confidence === undefined ? {} : { confidence: observed.confidence }),
        ...(observed.evidence === undefined
          ? {}
          : { evidence: observed.evidence.map((evidence) => ({ ...evidence })) }),
      });
    }
    nextRelations.sort((left, right) => relationKey(left).localeCompare(relationKey(right)));

    const added: Entity[] = [];
    const changed: EntityChange[] = [];
    for (const [id, stored] of nextEntities) {
      const old = previous.entities.get(id);
      if (!old) {
        added.push({ ...stored.entity });
        continue;
      }
      const changedFields = entityChangedFields(old.entity, stored.entity);
      if (changedFields.length > 0) changed.push({ entity: { ...stored.entity }, changedFields });
    }
    const removed = [...previous.entities.keys()].filter((id) => !nextEntities.has(id)).sort();

    const oldRelations = new Map(previous.relations.map((relation) => [relationKey(relation), relation]));
    const newRelations = new Map(nextRelations.map((relation) => [relationKey(relation), relation]));
    const addedRelations = nextRelations.filter((relation) => !oldRelations.has(relationKey(relation)));
    const removedRelations = previous.relations.filter((relation) => !newRelations.has(relationKey(relation)));
    const capturedOmissions = (observation.capturedOmissions ?? [])
      .map((omission) => ({ ...omission }))
      .sort(
        (left, right) =>
          left.kind.localeCompare(right.kind) ||
          left.reason.localeCompare(right.reason) ||
          left.count - right.count,
      );
    const omissionsChanged = !same(previous.capturedOmissions, capturedOmissions);
    const documentChanged =
      previous.documentId !== undefined &&
      observation.documentId !== undefined &&
      previous.documentId !== observation.documentId;
    const pageChanged =
      documentChanged ||
      previous.url !== observationUrl ||
      previous.title !== observation.title ||
      previous.visibleText !== observation.visibleText;
    const graphChanged =
      stateInvalidated ||
      pageChanged ||
      added.length > 0 ||
      removed.length > 0 ||
      changed.length > 0 ||
      addedRelations.length > 0 ||
      removedRelations.length > 0 ||
      omissionsChanged;
    const nextRevision = graphChanged ? previous.revision + 1 : previous.revision;

    const rebindableRefs = rebindableEntityIdsForTransition(
      previous,
      nextEntities,
      changed,
      removed,
      addedRelations,
      removedRelations,
      pageChanged,
      stateInvalidated,
      omissionsChanged,
      capturedOmissions.length > 0,
    );
    const rebindTransitions = graphChanged
      ? appendRebindTransition(previous, previous.revision, nextRevision, rebindableRefs)
      : previous.rebindTransitions;
    const page: PageState = {
      revision: nextRevision,
      documentId: observation.documentId,
      url: observationUrl,
      title: observation.title,
      visibleText: observation.visibleText,
      capturedOmissions,
      entities: nextEntities,
      relations: nextRelations,
      rebindTransitions,
    };
    session.pages.set(observation.pageId, page);

    const delta: GraphDelta = {
      fromRevision: previous.revision,
      toRevision: nextRevision,
      pageChanged,
      added: added.sort((left, right) => left.id.localeCompare(right.id)),
      removed,
      changed: changed.sort((left, right) => left.entity.id.localeCompare(right.entity.id)),
      addedRelations,
      removedRelations,
      invalidatedRefs:
        nextRevision !== previous.revision
          ? [...previous.entities.keys()].sort()
          : [],
      rebindableRefs: nextRevision !== previous.revision ? rebindableRefs : [],
      ...(stateInvalidated ? { stateInvalidated: true } : {}),
    };
    const snapshot = snapshotFrom(browserId, observation.pageId, page);
    return {
      snapshot,
      delta,
      view: compileView(snapshot, budget === undefined ? {} : { budget }),
    };
  }

  private staleReceipt(preRevision: Revision, message: string): ActionReceipt {
    return {
      status: 'stale_target',
      dispatched: false,
      preRevision,
      effects: [],
      error: { code: 'stale_target', message },
    };
  }

  private resolveAction(action: BrowserAction, page: PageState): ResolvedAction {
    const target = (ref: EntityRef): DriverTarget => {
      const resolved = page.entities.get(ref.entityId)?.target;
      if (!resolved) throw new BrowserIRError('stale_target', `Entity reference ${ref.entityId} is stale.`);
      return { ...resolved };
    };

    switch (action.kind) {
      case 'click':
        return { kind: 'click', target: target(action.target) };
      case 'contextClick':
        return { kind: 'contextClick', target: target(action.target) };
      case 'doubleClick':
        return { kind: 'doubleClick', target: target(action.target) };
      case 'fill':
        return { kind: 'fill', target: target(action.target), value: action.value };
      case 'type':
        return { kind: 'type', target: target(action.target), text: action.text };
      case 'select':
        return { kind: 'select', target: target(action.target), values: [...action.values] };
      case 'check':
        return { kind: 'check', target: target(action.target), checked: action.checked };
      case 'hover':
        return { kind: 'hover', target: target(action.target) };
      case 'press':
        return action.target
          ? { kind: 'press', target: target(action.target), key: action.key }
          : { kind: 'press', key: action.key };
      case 'scroll':
        return action.target
          ? {
              kind: 'scroll',
              target: target(action.target),
              deltaX: action.deltaX,
              deltaY: action.deltaY,
            }
          : { kind: 'scroll', deltaX: action.deltaX, deltaY: action.deltaY };
      case 'drag':
        return {
          kind: 'drag',
          target: target(action.target),
          destination: target(action.destination),
        };
      case 'upload':
        return {
          kind: 'upload',
          target: target(action.target),
          files: action.files.map((file) => ({ ...file, data: new Uint8Array(file.data) })),
        };
      case 'focus':
        return { kind: 'focus', target: target(action.target) };
    }
  }
}
