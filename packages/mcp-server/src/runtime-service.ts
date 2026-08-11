import { createHash, randomUUID } from 'node:crypto';

import {
  BrowserIRError,
  MAX_CAPTURE_BYTES,
  MAX_CAPTURE_PHYSICAL_PIXELS,
  type ActionReceipt,
  type BrowserAction as CoreBrowserAction,
  type BrowserCapture,
  type BrowserCreateOptions,
  type BrowserIRRuntime,
  type CapabilityKind,
  type CompiledEntity,
  type CompiledView,
  type EntityRef,
  type GraphDelta,
  type ObservationResult,
  type UnsafeEvaluationOutcome,
  type UnsafeEvaluationReceipt,
  type UploadFile,
  type WaitCondition,
} from '@browserir/core';

import {
  BrowserIrServiceError,
  type BrowserAction,
  type BrowserActInput,
  type BrowserCaptureInput,
  type BrowserCloseInput,
  type BrowserCreateInput,
  type BrowserInspectInput,
  type BrowserIrCallContext,
  type BrowserIrService,
  type BrowserIrToolResult,
  type BrowserEvaluateUnsafeInput,
  type BrowserNavigateInput,
  type BrowserObserveInput,
  type BrowserPagesInput,
  type BrowserWaitCondition,
  type BrowserWaitInput,
  type BrowserUnsafeEvaluateAuditRecord,
  type EntityTarget,
} from './types.js';
import {
  DEFAULT_UNSAFE_EVALUATE_OUTPUT_BYTES,
  DEFAULT_UNSAFE_EVALUATE_TIMEOUT_MS,
  MAX_UNSAFE_EVALUATE_EXPRESSION_BYTES,
  MAX_UNSAFE_EVALUATE_EXPRESSION_CHARACTERS,
  MAX_UNSAFE_EVALUATE_OUTPUT_BYTES,
  MAX_UNSAFE_EVALUATE_TIMEOUT_MS,
  redactUnsafeEvaluationValue,
} from './unsafe-evaluate.js';

const APPROXIMATE_CHARACTERS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 4_000;
const VIEW_BUDGET_NUMERATOR = 3;
const VIEW_BUDGET_DENOMINATOR = 4;
const DELTA_BUDGET_DIVISOR = 8;
const ACTIONABLE_CONTEXT_BUDGET_DIVISOR = 8;
const MAX_ACTIONABLE_CONTEXT_CHARACTERS = 640;
const MAX_ACTIONABLE_CONTEXT_TARGETS = 6;

export const DEFAULT_MAX_BROWSERS_PER_CONNECTION = 4;

export interface BrowserIrUnsafeEvaluateOptions {
  /** Required audit sink. Source text and result values are never included. */
  audit(record: BrowserUnsafeEvaluateAuditRecord): void | Promise<void>;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
}

export interface BrowserIrRuntimeServiceOptions {
  resolveArtifacts?: (artifactIds: readonly string[]) => Promise<UploadFile[]>;
  /** Maximum concurrently owned or in-flight browser sessions for one MCP connection. */
  maxBrowsersPerConnection?: number;
  /**
   * Omit this block to remove unsafe evaluation from the service entirely.
   * MCP registration and the stock CLI require a separate explicit opt-in.
   */
  unsafeEvaluate?: BrowserIrUnsafeEvaluateOptions;
}

type SerializedEntityRef = {
  page_id: string;
  entity_id: string;
  revision: number;
};

function responseCharacters(maxTokens: number | undefined): number {
  return (maxTokens ?? DEFAULT_MAX_TOKENS) * APPROXIMATE_CHARACTERS_PER_TOKEN;
}

function budget(maxTokens: number | undefined): { maxCharacters: number } {
  return {
    maxCharacters: Math.max(
      512,
      Math.floor(
        (responseCharacters(maxTokens) * VIEW_BUDGET_NUMERATOR) /
          VIEW_BUDGET_DENOMINATOR,
      ),
    ),
  };
}

function deltaBudgetCharacters(maxTokens: number | undefined): number {
  return Math.max(
    256,
    Math.floor(responseCharacters(maxTokens) / DELTA_BUDGET_DIVISOR),
  );
}

function actionableContextBudgetCharacters(maxTokens: number | undefined): number {
  return Math.max(
    128,
    Math.min(
      MAX_ACTIONABLE_CONTEXT_CHARACTERS,
      Math.floor(responseCharacters(maxTokens) / ACTIONABLE_CONTEXT_BUDGET_DIVISOR),
    ),
  );
}

function serializedRef(ref: EntityRef): SerializedEntityRef {
  return {
    page_id: ref.pageId,
    entity_id: ref.entityId,
    revision: ref.revision,
  };
}

type SerializedDeltaResult = {
  value: Record<string, unknown>;
  omitted: number;
};

function serializedDelta(delta: GraphDelta, maxCharacters: number): SerializedDeltaResult {
  const value = {
    from_revision: delta.fromRevision,
    to_revision: delta.toRevision,
    page_changed: delta.pageChanged,
    ...(delta.stateInvalidated === true ? { state_invalidated: true } : {}),
    added: [] as string[],
    removed: [] as string[],
    changed: [] as Array<{ entity_id: string; changed_fields: string[] }>,
    added_relations: [] as Array<{ from: string; to: string; kind: string }>,
    removed_relations: [] as Array<{ from: string; to: string; kind: string }>,
    invalidated_refs: [] as string[],
    rebindable_refs: [] as string[],
  };
  let omitted = 0;
  const append = <T>(target: T[], item: T): void => {
    target.push(item);
    if (JSON.stringify(value).length <= maxCharacters) return;
    target.pop();
    omitted += 1;
  };

  for (const entity of delta.added) append(value.added, entity.id);
  for (const entityId of delta.removed) append(value.removed, entityId);
  for (const change of delta.changed) {
    append(value.changed, {
      entity_id: change.entity.id,
      changed_fields: [...change.changedFields],
    });
  }
  for (const { from, to, kind } of delta.addedRelations) {
    append(value.added_relations, { from, to, kind });
  }
  for (const { from, to, kind } of delta.removedRelations) {
    append(value.removed_relations, { from, to, kind });
  }
  for (const entityId of delta.invalidatedRefs) append(value.invalidated_refs, entityId);
  for (const entityId of delta.rebindableRefs ?? []) append(value.rebindable_refs, entityId);

  return { value, omitted };
}

const DELTA_FIRST_ACTION_KINDS = new Set<BrowserAction['kind']>([
  'fill',
  'type',
  'select',
  'check',
  'uncheck',
]);
const DELTA_FIRST_CHANGED_FIELDS = new Set(['value', 'state']);

function actionEntityIds(action: BrowserAction): Set<string> {
  if (action.kind === 'drag') {
    return new Set([action.source.entity_id, action.target.entity_id]);
  }
  if (action.kind === 'press' || action.kind === 'scroll') {
    return new Set(action.target === undefined ? [] : [action.target.entity_id]);
  }
  return new Set([action.target.entity_id]);
}

function usesDeltaFirstReceipt(action: BrowserAction, receipt: ActionReceipt): boolean {
  const delta = receipt.observation?.delta ?? receipt.delta;
  if (
    receipt.status !== 'verified' ||
    delta === undefined ||
    !DELTA_FIRST_ACTION_KINDS.has(action.kind) ||
    delta.stateInvalidated === true ||
    delta.pageChanged ||
    delta.added.length > 0 ||
    delta.removed.length > 0 ||
    delta.addedRelations.length > 0 ||
    delta.removedRelations.length > 0 ||
    (delta.rebindableRefs?.length ?? 0) === 0
  ) {
    return false;
  }
  const targets = actionEntityIds(action);
  return (
    delta.changed.some((change) => targets.has(change.entity.id)) &&
    delta.changed.every(
      (change) =>
        change.changedFields.every((field) =>
          targets.has(change.entity.id)
            ? DELTA_FIRST_CHANGED_FIELDS.has(field)
            : field === 'state',
        ),
    )
  );
}

const ACTIONABLE_CONTEXT_CAPABILITIES = new Set<CapabilityKind>([
  'click',
  'contextClick',
  'doubleClick',
  'fill',
  'select',
  'check',
  'upload',
]);

const ACTIONABLE_CONTEXT_CAPABILITY_ORDER: readonly CapabilityKind[] = [
  'select',
  'check',
  'upload',
  'fill',
  'click',
  'doubleClick',
  'contextClick',
];

type SerializedActionableTarget = {
  entity_id: string;
  kind: string;
  role?: string | undefined;
  name?: string | undefined;
  value_present?: boolean | undefined;
  current_value?: string | number | boolean | null | undefined;
  checked?: boolean | 'mixed' | undefined;
  invalid?: boolean | undefined;
  actions: CapabilityKind[];
};

type SerializedActionableContext = {
  page_id: string;
  revision: number;
  targets: SerializedActionableTarget[];
  omitted: number;
};

function contextActions(entity: CompiledEntity): CapabilityKind[] {
  const available = new Set(
    entity.capabilities
      .filter(
        (capability) =>
          capability.enabled !== false &&
          ACTIONABLE_CONTEXT_CAPABILITIES.has(capability.kind),
      )
      .map((capability) => capability.kind),
  );
  return ACTIONABLE_CONTEXT_CAPABILITY_ORDER.filter((kind) => available.has(kind)).slice(0, 2);
}

function isFormContinuationTarget(
  entity: CompiledEntity,
  actions: readonly CapabilityKind[],
): boolean {
  if (entity.state.visible === false || entity.state.enabled === false) return false;
  if (actions.length === 0) return false;
  if (entity.role === 'link') return false;
  if (entity.kind === 'input') return true;
  if (
    entity.role === 'button' ||
    entity.role === 'checkbox' ||
    entity.role === 'radio' ||
    entity.role === 'switch' ||
    entity.role === 'textbox' ||
    entity.role === 'combobox' ||
    entity.role === 'spinbutton'
  ) {
    return true;
  }
  return actions.some(
    (action) =>
      action === 'fill' ||
      action === 'select' ||
      action === 'check' ||
      action === 'upload' ||
      action === 'click' ||
      action === 'doubleClick' ||
      action === 'contextClick',
  );
}

function compactSelectValue(
  value: CompiledEntity['value'],
): string | number | boolean | null | undefined {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'string' || value.length === 0 || value.length > 80) return undefined;
  return value;
}

function narrowActionableContextEntities(
  view: CompiledView,
  actedEntityIds: ReadonlySet<string>,
): readonly CompiledEntity[] {
  const entityById = new Map(
    view.structured.entities.map((entity) => [entity.ref.entityId, entity] as const),
  );
  const narrowScopeIds = new Set(
    view.structured.relations
      .filter(
        (relation) =>
          relation.kind === 'contains' && actedEntityIds.has(relation.to.entityId),
      )
      .map((relation) => relation.from.entityId)
      .filter((entityId) => {
        const scope = entityById.get(entityId);
        return (
          scope?.kind === 'form' ||
          scope?.kind === 'dialog' ||
          scope?.kind === 'menu' ||
          scope?.kind === 'row' ||
          scope?.role === 'toolbar'
        );
      }),
  );
  if (narrowScopeIds.size === 0) return view.structured.entities;
  const scopedEntityIds = new Set<string>(actedEntityIds);
  for (const relation of view.structured.relations) {
    if (relation.kind === 'contains' && narrowScopeIds.has(relation.from.entityId)) {
      scopedEntityIds.add(relation.to.entityId);
    }
  }
  return view.structured.entities.filter((entity) => scopedEntityIds.has(entity.ref.entityId));
}

const ACTIONABLE_SAME_ROW_TOLERANCE_PX = 4;

function actionableReadingOrder(entities: readonly CompiledEntity[]): readonly CompiledEntity[] {
  const coordinate = (
    entity: CompiledEntity,
  ): { x: number; top: number; centerY: number } | undefined => {
    const top = entity.geometry?.viewportY ?? entity.geometry?.y;
    const x = entity.geometry?.viewportX ?? entity.geometry?.x;
    const height = entity.geometry?.height;
    return top === undefined || x === undefined || height === undefined
      ? undefined
      : { x, top, centerY: top + height / 2 };
  };
  type PositionedEntry = {
    entity: CompiledEntity;
    index: number;
    coordinate: { x: number; top: number; centerY: number };
  };
  type VisualRow = {
    anchorTop: number;
    anchorCenterY: number;
    sourceIndex: number;
    entries: PositionedEntry[];
  };
  const sourceEntries = entities.map((entity, index) => ({
    entity,
    index,
    coordinate: coordinate(entity),
  }));
  const entries = sourceEntries
    .filter(
      (entry): entry is PositionedEntry => entry.coordinate !== undefined,
    )
    .sort(
      (left, right) =>
        left.coordinate.top - right.coordinate.top ||
        left.coordinate.centerY - right.coordinate.centerY ||
        left.coordinate.x - right.coordinate.x ||
        left.index - right.index,
    );
  const rows: VisualRow[] = [];
  // Row anchors never move: a later control may join an anchor within the
  // tolerance, but cannot bridge two rows transitively. Because a new anchor
  // is created only when both distances exceed the tolerance, adjacent
  // numeric buckets contain only a bounded set of candidate rows.
  const topBuckets = new Map<number, VisualRow[]>();
  const centerBuckets = new Map<number, VisualRow[]>();
  const bucketKey = (value: number): number =>
    Math.floor(value / ACTIONABLE_SAME_ROW_TOLERANCE_PX);
  const register = (index: Map<number, VisualRow[]>, value: number, row: VisualRow): void => {
    const key = bucketKey(value);
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [row]);
    else bucket.push(row);
  };
  const addNearby = (
    candidates: Set<VisualRow>,
    index: ReadonlyMap<number, readonly VisualRow[]>,
    value: number,
  ): void => {
    const key = bucketKey(value);
    for (let offset = -1; offset <= 1; offset += 1) {
      for (const row of index.get(key + offset) ?? []) candidates.add(row);
    }
  };
  for (const entry of entries) {
    const nearby = new Set<VisualRow>();
    addNearby(nearby, topBuckets, entry.coordinate.top);
    addNearby(nearby, centerBuckets, entry.coordinate.centerY);
    const matches = [...nearby]
      .map((row) => ({
        row,
        distance: Math.min(
          Math.abs(entry.coordinate.top - row.anchorTop),
          Math.abs(entry.coordinate.centerY - row.anchorCenterY),
        ),
      }))
      .filter(({ distance }) => distance <= ACTIONABLE_SAME_ROW_TOLERANCE_PX)
      .sort(
        (left, right) =>
          left.distance - right.distance ||
          left.row.sourceIndex - right.row.sourceIndex,
      );
    const row = matches[0]?.row;
    if (row === undefined) {
      const created: VisualRow = {
        anchorTop: entry.coordinate.top,
        anchorCenterY: entry.coordinate.centerY,
        sourceIndex: entry.index,
        entries: [entry],
      };
      rows.push(created);
      register(topBuckets, created.anchorTop, created);
      register(centerBuckets, created.anchorCenterY, created);
    } else {
      row.entries.push(entry);
    }
  }
  rows.sort(
    (left, right) =>
      left.anchorTop - right.anchorTop ||
      left.anchorCenterY - right.anchorCenterY ||
      left.sourceIndex - right.sourceIndex,
  );
  const positioned = rows.flatMap((row) =>
    row.entries
      .sort(
        (left, right) =>
          left.coordinate.x - right.coordinate.x ||
          left.coordinate.top - right.coordinate.top ||
          left.index - right.index,
      )
      .map(({ entity }) => entity),
  );
  const unpositioned = sourceEntries
    .filter((entry) => entry.coordinate === undefined)
    .map(({ entity }) => entity);
  return [...positioned, ...unpositioned];
}

function serializedActionableContext(
  view: CompiledView,
  excludedEntityIds: ReadonlySet<string>,
  maxCharacters: number,
): SerializedActionableContext | undefined {
  const scopedEntities = actionableReadingOrder(
    narrowActionableContextEntities(view, excludedEntityIds),
  );
  const actedIndex = scopedEntities.findIndex((entity) =>
    excludedEntityIds.has(entity.ref.entityId),
  );
  if (actedIndex < 0) return undefined;
  const value: SerializedActionableContext = {
    page_id: view.pageId,
    revision: view.revision,
    targets: [],
    omitted: 0,
  };
  for (const entity of scopedEntities.slice(actedIndex + 1)) {
    const actions = contextActions(entity);
    if (!isFormContinuationTarget(entity, actions)) continue;
    const tracksValue = actions.some(
      (action) =>
        action === 'fill' ||
        action === 'upload',
    );
    const selectValue = actions.includes('select')
      ? compactSelectValue(entity.value)
      : undefined;
    const target: SerializedActionableTarget = {
      entity_id: entity.ref.entityId,
      kind: entity.kind,
      ...(entity.role === undefined ? {} : { role: entity.role }),
      ...(entity.name === undefined ? {} : { name: entity.name }),
      ...(tracksValue
        ? {
            value_present:
              entity.state.hasValue === true ||
              (entity.value !== undefined && entity.value !== null && entity.value !== ''),
          }
        : {}),
      ...(selectValue === undefined ? {} : { current_value: selectValue }),
      ...(entity.state.checked === undefined ? {} : { checked: entity.state.checked }),
      ...(entity.state.invalid === true ? { invalid: true } : {}),
      actions,
    };
    if (value.targets.length >= MAX_ACTIONABLE_CONTEXT_TARGETS) {
      value.omitted += 1;
      continue;
    }
    value.targets.push(target);
    const fits = JSON.stringify(value).length <= maxCharacters;
    if (fits) continue;
    value.targets.pop();
    value.omitted += 1;
  }
  while (value.targets.length > 0 && JSON.stringify(value).length > maxCharacters) {
    value.targets.pop();
    value.omitted += 1;
  }
  if (JSON.stringify(value).length > maxCharacters) return undefined;
  return value.targets.length === 0 && value.omitted === 0 ? undefined : value;
}

function serializedView(view: CompiledView): Record<string, unknown> {
  return {
    page: view.structured.page,
    entities: view.structured.entities.map(({ ref, ...entity }) => ({
      ...entity,
      ref: serializedRef(ref),
    })),
    relations: view.structured.relations.map((relation) => ({
      ...relation,
      from: serializedRef(relation.from),
      to: serializedRef(relation.to),
    })),
    omissions: view.structured.omissions,
  };
}

function resultOmissions(
  omissions: readonly { kind: string; count: number; reason: string }[],
  omittedChanges: number,
): Record<string, unknown>[] {
  const result = omissions.map((omission) => ({ ...omission }));
  if (omittedChanges > 0) {
    result.push({ kind: 'changes', count: omittedChanges, reason: 'budget' });
  }
  return result;
}

function observationData(
  result: ObservationResult,
  maxTokens: number | undefined,
): Record<string, unknown> {
  const changes = serializedDelta(result.delta, deltaBudgetCharacters(maxTokens));
  return {
    browser_id: result.view.browserId,
    page_id: result.view.pageId,
    revision: result.view.revision,
    changes: changes.value,
    truncated: result.view.truncated || changes.omitted > 0,
    omissions: resultOmissions(result.view.structured.omissions, changes.omitted),
  };
}

function safeActionError(error: NonNullable<ActionReceipt['error']>): {
  code: string;
  message: string;
} {
  const code = /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : 'action_failed';
  const message =
    code === 'stale_target'
      ? 'The action target is stale. Observe the page again before retrying.'
      : code === 'ambiguous_target'
        ? 'The action target is ambiguous. Inspect the current page before retrying.'
        : code === 'unsupported_action'
          ? 'The requested browser action is not supported.'
          : 'The browser action failed without a verified effect.';
  return { code, message };
}

function actionReceiptData(
  browserId: string,
  pageId: string | undefined,
  receipt: ActionReceipt,
  maxTokens: number | undefined,
): Record<string, unknown> {
  const observation = receipt.observation;
  const resolvedPageId = observation?.view.pageId ?? pageId;
  const currentRevision = observation?.view.revision ?? receipt.postRevision;
  const delta = observation?.delta ?? receipt.delta;
  const changes =
    delta === undefined
      ? undefined
      : serializedDelta(delta, deltaBudgetCharacters(maxTokens));
  const omissions = resultOmissions(
    observation?.view.structured.omissions ?? [],
    changes?.omitted ?? 0,
  );
  return {
    browser_id: browserId,
    ...(resolvedPageId === undefined ? {} : { page_id: resolvedPageId }),
    status: receipt.status,
    dispatched: receipt.dispatched,
    pre_revision: receipt.preRevision,
    ...(currentRevision === undefined ? {} : { post_revision: currentRevision }),
    effects: receipt.effects,
    ...(changes === undefined ? {} : { changes: changes.value }),
    ...(observation === undefined ? {} : { revision: currentRevision }),
    ...(observation !== undefined || (changes?.omitted ?? 0) > 0
      ? {
          truncated: (observation?.view.truncated ?? false) || (changes?.omitted ?? 0) > 0,
          omissions,
        }
      : {}),
    ...(receipt.error === undefined ? {} : { error: safeActionError(receipt.error) }),
  };
}

function withBudgetOmission(
  data: Record<string, unknown>,
  kind: 'content',
  count: number,
): Record<string, unknown> {
  const omissions = Array.isArray(data.omissions)
    ? data.omissions
        .filter(
          (omission): omission is Record<string, unknown> =>
            typeof omission === 'object' && omission !== null,
        )
        .map((omission) => ({ ...omission }))
    : [];
  const existing = omissions.find(
    (omission) => omission.kind === kind && omission.reason === 'budget',
  );
  if (existing) {
    existing.count = Number(existing.count ?? 0) + count;
  } else {
    omissions.push({ kind, count, reason: 'budget' });
  }
  return { ...data, truncated: true, omissions };
}

function boundedModelResult(
  result: BrowserIrToolResult,
  maxTokens: number | undefined,
): BrowserIrToolResult {
  const limit = responseCharacters(maxTokens);
  const length = (summary: string, data: Record<string, unknown>): number =>
    JSON.stringify({ summary, data }).length;
  if (length(result.summary, result.data) <= limit) return result;

  const originalSummary = result.summary;
  const lines = originalSummary.split('\n');
  const marker = '[content omitted: budget]';
  let summary = originalSummary;
  let data = { ...result.data };
  while (lines.length > 0 && length(summary, data) > limit) {
    lines.pop();
    summary = lines.length === 0 ? marker : `${lines.join('\n')}\n${marker}`;
    data = withBudgetOmission(
      result.data,
      'content',
      Math.max(1, originalSummary.length - summary.length),
    );
  }
  if (length(summary, data) > limit) {
    summary = '';
    data = withBudgetOmission(result.data, 'content', originalSummary.length);
  }
  if (length(summary, data) > limit) {
    throw new BrowserIrServiceError(
      'response_budget_too_small',
      'The requested response budget is too small for required BrowserIR metadata.',
    );
  }
  return { ...result, summary, data };
}

function targetPageId(target: EntityTarget, fallback: string | undefined): string {
  const pageId = target.page_id ?? fallback;
  if (pageId === undefined) {
    throw new BrowserIrServiceError(
      'page_required',
      'The entity reference must include page_id when the action does not provide one.',
    );
  }
  return pageId;
}

function coreRef(browserId: string, target: EntityTarget, fallbackPageId?: string): EntityRef {
  return {
    browserId,
    pageId: targetPageId(target, fallbackPageId),
    entityId: target.entity_id,
    revision: target.revision,
  };
}

function explicitActionPageId(action: BrowserAction): string | undefined {
  switch (action.kind) {
    case 'press':
    case 'scroll':
      return action.target?.page_id;
    case 'drag':
      return action.source.page_id ?? action.target.page_id;
    default:
      return action.target.page_id;
  }
}

async function coreAction(
  input: BrowserActInput,
  action: BrowserAction,
  options: BrowserIrRuntimeServiceOptions,
): Promise<{ action: CoreBrowserAction; pageId?: string }> {
  switch (action.kind) {
    case 'click':
    case 'hover':
    case 'focus': {
      const target = coreRef(input.browser_id, action.target, input.page_id);
      return { action: { kind: action.kind, target }, pageId: target.pageId };
    }
    case 'double_click': {
      const target = coreRef(input.browser_id, action.target, input.page_id);
      return { action: { kind: 'doubleClick', target }, pageId: target.pageId };
    }
    case 'context_click': {
      const target = coreRef(input.browser_id, action.target, input.page_id);
      return { action: { kind: 'contextClick', target }, pageId: target.pageId };
    }
    case 'fill': {
      const target = coreRef(input.browser_id, action.target, input.page_id);
      return { action: { kind: 'fill', target, value: action.value }, pageId: target.pageId };
    }
    case 'type': {
      const target = coreRef(input.browser_id, action.target, input.page_id);
      return { action: { kind: 'type', target, text: action.text }, pageId: target.pageId };
    }
    case 'select': {
      const target = coreRef(input.browser_id, action.target, input.page_id);
      return { action: { kind: 'select', target, values: action.values }, pageId: target.pageId };
    }
    case 'check':
    case 'uncheck': {
      const target = coreRef(input.browser_id, action.target, input.page_id);
      return {
        action: { kind: 'check', target, checked: action.kind === 'check' },
        pageId: target.pageId,
      };
    }
    case 'press': {
      const target =
        action.target === undefined
          ? undefined
          : coreRef(input.browser_id, action.target, input.page_id);
      const pageId = target?.pageId ?? input.page_id;
      return {
        action: {
          kind: 'press',
          key: action.keys,
          ...(target === undefined ? {} : { target }),
        },
        ...(pageId === undefined ? {} : { pageId }),
      };
    }
    case 'scroll': {
      const target =
        action.target === undefined
          ? undefined
          : coreRef(input.browser_id, action.target, input.page_id);
      const pageId = target?.pageId ?? input.page_id;
      return {
        action: {
          kind: 'scroll',
          deltaX: action.delta_x ?? 0,
          deltaY: action.delta_y ?? 0,
          ...(target === undefined ? {} : { target }),
        },
        ...(pageId === undefined ? {} : { pageId }),
      };
    }
    case 'drag': {
      const source = coreRef(input.browser_id, action.source, input.page_id);
      const destination = coreRef(input.browser_id, action.target, source.pageId);
      return {
        action: { kind: 'drag', target: source, destination },
        pageId: source.pageId,
      };
    }
    case 'upload': {
      if (options.resolveArtifacts === undefined) {
        throw new BrowserIrServiceError(
          'artifact_resolver_unavailable',
          'Upload requires an artifact resolver configured by the BrowserIR host.',
        );
      }
      const target = coreRef(input.browser_id, action.target, input.page_id);
      const files = await options.resolveArtifacts(action.artifact_ids);
      return { action: { kind: 'upload', target, files }, pageId: target.pageId };
    }
  }
}

function coreWaitCondition(
  input: BrowserWaitInput,
  condition: BrowserWaitCondition,
): { condition: WaitCondition; pageId?: string } {
  switch (condition.kind) {
    case 'revision_change':
      return { condition: { kind: 'revision_after', revision: input.expected_revision } };
    case 'text':
      return { condition: { kind: 'text_includes', text: condition.value } };
    case 'entity_state': {
      const target = coreRef(input.browser_id, condition.target, input.page_id);
      const state =
        condition.state === 'visible'
          ? { visible: true }
          : condition.state === 'hidden'
            ? { visible: false }
            : condition.state === 'enabled'
              ? { enabled: true }
              : condition.state === 'disabled'
                ? { enabled: false }
                : condition.state === 'expanded'
                  ? { expanded: true }
                  : { expanded: false };
      return {
        condition: { kind: 'entity_state', target, state },
        pageId: target.pageId,
      };
    }
    case 'settled':
      return { condition: { kind: 'settled' } };
  }
}

function safeRuntimeError(error: BrowserIRError): BrowserIrServiceError {
  if (error.code === 'unknown_browser') {
    return new BrowserIrServiceError(
      'unknown_browser',
      'The browser handle is unknown or already closed.',
    );
  }
  if (error.code === 'unknown_page') {
    return new BrowserIrServiceError(
      'unknown_page',
      'The page handle is unknown or already closed.',
    );
  }
  return new BrowserIrServiceError(error.code, error.message);
}

async function runtimeCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BrowserIRError) {
      throw safeRuntimeError(error);
    }
    throw error;
  }
}

function createOptions(input: BrowserCreateInput): BrowserCreateOptions {
  return {
    ...(input.viewport === undefined
      ? {}
      : { viewport: { width: input.viewport.width, height: input.viewport.height } }),
    ...(input.viewport?.device_scale_factor === undefined
      ? {}
      : { deviceScaleFactor: input.viewport.device_scale_factor }),
    ...(input.locale === undefined ? {} : { locale: input.locale }),
    ...(input.timezone_id === undefined ? {} : { timezoneId: input.timezone_id }),
    ...(input.color_scheme === undefined ? {} : { colorScheme: input.color_scheme }),
    ...(input.reduced_motion === undefined
      ? {}
      : { reducedMotion: input.reduced_motion ? ('reduce' as const) : ('no-preference' as const) }),
  };
}

function captureData(capture: BrowserCapture): Record<string, unknown> {
  return {
    browser_id: capture.browserId,
    page_id: capture.pageId,
    revision: capture.revision,
    mime_type: capture.mediaType,
    width: capture.width,
    height: capture.height,
    device_scale_factor: capture.deviceScaleFactor,
    scroll_x: capture.scrollX,
    scroll_y: capture.scrollY,
    ...(capture.clip === undefined ? {} : { clip: capture.clip }),
    ...(capture.capturedAt === undefined ? {} : { captured_at: capture.capturedAt }),
    ...(capture.target === undefined ? {} : { target: serializedRef(capture.target) }),
  };
}

const unsafeOutcomeError = (
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

function effectiveUnsafeOutputBytes(
  requested: number,
  configuredMaximum: number,
  maxTokens: number | undefined,
): number {
  const responseShare = Math.max(128, Math.floor(responseCharacters(maxTokens) / 4));
  return Math.min(requested, configuredMaximum, responseShare);
}

function unsafeEvaluationData(
  input: BrowserEvaluateUnsafeInput,
  receipt: UnsafeEvaluationReceipt,
  expressionSha256: string,
  expressionBytes: number,
  effectiveTimeoutMs: number,
  effectiveOutputBytes: number,
  redactedValue: unknown,
  redactionCount: number,
  resultBytes: number | undefined,
): Record<string, unknown> {
  const observed =
    receipt.observation === undefined
      ? undefined
      : observationData(receipt.observation, input.max_tokens);
  return {
    browser_id: input.browser_id,
    page_id: input.page_id,
    outcome: receipt.outcome,
    dispatched: receipt.dispatched,
    pre_revision: receipt.preRevision,
    ...(receipt.postRevision === undefined
      ? {}
      : { post_revision: receipt.postRevision }),
    expression_sha256: expressionSha256,
    expression_bytes: expressionBytes,
    timeout_ms: effectiveTimeoutMs,
    max_output_bytes: effectiveOutputBytes,
    ...(redactedValue === undefined ? {} : { result: redactedValue }),
    ...(resultBytes === undefined ? {} : { result_bytes: resultBytes }),
    result_omitted: receipt.outputOmitted === true,
    redaction_count: redactionCount,
    termination_attempted: receipt.terminationAttempted === true,
    termination_confirmed: receipt.terminationConfirmed === true,
    post_observation: receipt.postObservation,
    browser_invalidated: receipt.browserInvalidated === true,
    opened_page_ids: receipt.openedPageIds,
    ...(observed === undefined
      ? {}
      : {
          revision: observed.revision,
          changes: observed.changes,
          truncated: observed.truncated,
          omissions: observed.omissions,
        }),
    ...(receipt.outcome === 'completed'
      ? {}
      : { error: unsafeOutcomeError(receipt.outcome) }),
    ...(receipt.postObservation === 'failed'
      ? {
          verification_error: receipt.postObservationError ?? {
            code: 'post_evaluation_observation_failed',
            message:
              'BrowserIR could not verify page state after unsafe evaluation; the browser was invalidated.',
          },
        }
      : {}),
  };
}

export function createBrowserIrRuntimeService(
  runtime: BrowserIRRuntime,
  options: BrowserIrRuntimeServiceOptions = {},
): BrowserIrService {
  const maxBrowsersPerConnection =
    options.maxBrowsersPerConnection ?? DEFAULT_MAX_BROWSERS_PER_CONNECTION;
  if (
    !Number.isSafeInteger(maxBrowsersPerConnection) ||
    maxBrowsersPerConnection < 1
  ) {
    throw new RangeError('maxBrowsersPerConnection must be a positive safe integer.');
  }
  const unsafeOptions = options.unsafeEvaluate;
  const configuredUnsafeTimeoutMs =
    unsafeOptions?.maxTimeoutMs ?? MAX_UNSAFE_EVALUATE_TIMEOUT_MS;
  const configuredUnsafeOutputBytes =
    unsafeOptions?.maxOutputBytes ?? MAX_UNSAFE_EVALUATE_OUTPUT_BYTES;
  if (
    unsafeOptions !== undefined &&
    (!Number.isSafeInteger(configuredUnsafeTimeoutMs) ||
      configuredUnsafeTimeoutMs < 1 ||
      configuredUnsafeTimeoutMs > MAX_UNSAFE_EVALUATE_TIMEOUT_MS)
  ) {
    throw new RangeError(
      `unsafeEvaluate.maxTimeoutMs must be between 1 and ${MAX_UNSAFE_EVALUATE_TIMEOUT_MS}.`,
    );
  }
  if (
    unsafeOptions !== undefined &&
    (!Number.isSafeInteger(configuredUnsafeOutputBytes) ||
      configuredUnsafeOutputBytes < 1 ||
      configuredUnsafeOutputBytes > MAX_UNSAFE_EVALUATE_OUTPUT_BYTES)
  ) {
    throw new RangeError(
      `unsafeEvaluate.maxOutputBytes must be between 1 and ${MAX_UNSAFE_EVALUATE_OUTPUT_BYTES}.`,
    );
  }
  const ownedBrowserIds = new Set<string>();
  const pendingCreates = new Set<Promise<BrowserIrToolResult>>();
  const browserOperations = new Map<string, Promise<void>>();
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  const serviceAbort = new AbortController();

  const serviceDisposedError = (): BrowserIrServiceError =>
    new BrowserIrServiceError(
      'service_disposed',
      'This BrowserIR service connection has already closed.',
    );

  const runForBrowser = <T>(browserId: string, operation: () => Promise<T>): Promise<T> => {
    if (disposed) return Promise.reject(serviceDisposedError());
    const preceding = browserOperations.get(browserId) ?? Promise.resolve();
    const result = preceding.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    browserOperations.set(browserId, tail);
    void tail.then(() => {
      if (browserOperations.get(browserId) === tail) browserOperations.delete(browserId);
    });
    return result;
  };

  const invalidateAfterAuditFailure = async (browserId: string): Promise<void> => {
    try {
      await runtime.invalidateBrowser(browserId);
    } catch {
      // The runtime invalidates its handle in a finally block. A driver-level
      // shutdown error must not replace the stable audit failure returned here.
    } finally {
      ownedBrowserIds.delete(browserId);
    }
  };

  const evaluateUnsafe = async (
    input: BrowserEvaluateUnsafeInput,
    context: BrowserIrCallContext = {},
  ): Promise<BrowserIrToolResult> => {
    if (unsafeOptions === undefined) {
      throw new BrowserIrServiceError(
        'unsafe_evaluation_disabled',
        'Unsafe page evaluation is disabled for this BrowserIR service.',
      );
    }
    if (
      input.expression.length > MAX_UNSAFE_EVALUATE_EXPRESSION_CHARACTERS
    ) {
      throw new BrowserIrServiceError(
        'unsafe_evaluation_source_too_large',
        `Page code exceeds the ${MAX_UNSAFE_EVALUATE_EXPRESSION_CHARACTERS}-character limit.`,
      );
    }
    const expressionBytes = Buffer.byteLength(input.expression, 'utf8');
    if (expressionBytes > MAX_UNSAFE_EVALUATE_EXPRESSION_BYTES) {
      throw new BrowserIrServiceError(
        'unsafe_evaluation_source_too_large',
        `Page code exceeds the ${MAX_UNSAFE_EVALUATE_EXPRESSION_BYTES}-byte UTF-8 limit.`,
      );
    }
    const requestedTimeoutMs =
      input.timeout_ms ?? DEFAULT_UNSAFE_EVALUATE_TIMEOUT_MS;
    const requestedOutputBytes =
      input.max_output_bytes ?? DEFAULT_UNSAFE_EVALUATE_OUTPUT_BYTES;
    if (
      !Number.isSafeInteger(requestedTimeoutMs) ||
      requestedTimeoutMs < 1 ||
      requestedTimeoutMs > MAX_UNSAFE_EVALUATE_TIMEOUT_MS
    ) {
      throw new BrowserIrServiceError(
        'unsafe_evaluation_timeout_invalid',
        `timeout_ms must be between 1 and ${MAX_UNSAFE_EVALUATE_TIMEOUT_MS}.`,
      );
    }
    if (
      !Number.isSafeInteger(requestedOutputBytes) ||
      requestedOutputBytes < 1 ||
      requestedOutputBytes > MAX_UNSAFE_EVALUATE_OUTPUT_BYTES
    ) {
      throw new BrowserIrServiceError(
        'unsafe_evaluation_output_limit_invalid',
        `max_output_bytes must be between 1 and ${MAX_UNSAFE_EVALUATE_OUTPUT_BYTES}.`,
      );
    }
    const effectiveTimeoutMs = Math.min(
      requestedTimeoutMs,
      configuredUnsafeTimeoutMs,
    );
    const effectiveOutputBytes = effectiveUnsafeOutputBytes(
      requestedOutputBytes,
      configuredUnsafeOutputBytes,
      input.max_tokens,
    );
    const operationId = randomUUID();
    const expressionSha256 = createHash('sha256')
      .update(input.expression, 'utf8')
      .digest('hex');
    const startedAt = Date.now();
    const baseAudit = {
      operation_id: operationId,
      expression_sha256: expressionSha256,
      expression_bytes: expressionBytes,
      browser_id: input.browser_id,
      page_id: input.page_id,
      expected_revision: input.expected_revision,
      requested_timeout_ms: requestedTimeoutMs,
      effective_timeout_ms: effectiveTimeoutMs,
      requested_output_bytes: requestedOutputBytes,
      effective_output_bytes: effectiveOutputBytes,
    };
    try {
      await unsafeOptions.audit(
        Object.freeze({
          ...baseAudit,
          phase: 'intent' as const,
          timestamp: new Date(startedAt).toISOString(),
          post_observation: 'not_started' as const,
        }),
      );
    } catch {
      throw new BrowserIrServiceError(
        'unsafe_evaluation_audit_failed',
        'Unsafe page evaluation was blocked because its intent audit could not be recorded.',
      );
    }

    const signal =
      context.signal === undefined
        ? serviceAbort.signal
        : AbortSignal.any([context.signal, serviceAbort.signal]);
    let receipt: UnsafeEvaluationReceipt | undefined;
    let operationError: unknown;
    let redactedValue: unknown;
    let redactionCount = 0;
    let resultBytes: number | undefined;
    try {
      receipt = await runtimeCall(() =>
        runtime.evaluateUnsafe({
          browserId: input.browser_id,
          pageId: input.page_id,
          expectedRevision: input.expected_revision,
          expression: input.expression,
          timeoutMs: effectiveTimeoutMs,
          maxOutputBytes: effectiveOutputBytes,
          budget: budget(input.max_tokens),
          signal,
        }),
      );
      if (receipt.browserInvalidated === true) {
        ownedBrowserIds.delete(input.browser_id);
      }
      if (receipt.outcome === 'completed' && receipt.value !== undefined) {
        const redacted = redactUnsafeEvaluationValue(receipt.value);
        redactedValue = redacted.value;
        redactionCount = redacted.redactionCount;
        resultBytes = Buffer.byteLength(JSON.stringify(redactedValue), 'utf8');
        if (resultBytes > effectiveOutputBytes) {
          redactedValue = undefined;
          receipt = {
            ...receipt,
            outcome: 'output_too_large',
            outputOmitted: true,
            error: unsafeOutcomeError('output_too_large'),
          };
        }
      }
    } catch (error) {
      operationError = error;
    }

    const finishedAt = Date.now();
    const completionAudit: BrowserUnsafeEvaluateAuditRecord = Object.freeze({
      ...baseAudit,
      phase: 'completion' as const,
      timestamp: new Date(finishedAt).toISOString(),
      duration_ms: Math.max(0, finishedAt - startedAt),
      ...(receipt === undefined
        ? {
            dispatched: false,
            outcome:
              operationError instanceof BrowserIrServiceError
                ? operationError.code
                : signal.aborted
                  ? 'cancelled'
                  : 'failed',
            post_observation: 'not_started' as const,
          }
        : {
            pre_revision: receipt.preRevision,
            ...(receipt.postRevision === undefined
              ? {}
              : { post_revision: receipt.postRevision }),
            dispatched: receipt.dispatched,
            outcome: receipt.outcome,
            ...(receipt.outputBytes === undefined
              ? {}
              : { output_bytes: receipt.outputBytes }),
            output_omitted: receipt.outputOmitted === true,
            redaction_count: redactionCount,
            termination_attempted: receipt.terminationAttempted === true,
            termination_confirmed: receipt.terminationConfirmed === true,
            post_observation: receipt.postObservation,
            browser_invalidated: receipt.browserInvalidated === true,
            opened_page_ids: [...receipt.openedPageIds],
          }),
    });
    try {
      await unsafeOptions.audit(completionAudit);
    } catch {
      if (receipt?.dispatched === true) {
        await invalidateAfterAuditFailure(input.browser_id);
      }
      throw new BrowserIrServiceError(
        'unsafe_evaluation_audit_failed',
        'Unsafe page evaluation failed closed because its completion audit could not be recorded.',
      );
    }
    if (operationError !== undefined) throw operationError;
    if (receipt === undefined) {
      throw new BrowserIrServiceError(
        'unsafe_evaluation_failed',
        'Unsafe page evaluation failed before a receipt was produced.',
      );
    }

    const observationText = receipt.observation?.view.text;
    const result = boundedModelResult(
      {
        summary:
          `Unsafe page evaluation ${receipt.outcome}.` +
          (observationText === undefined ? '' : `\n${observationText}`),
        data: unsafeEvaluationData(
          input,
          receipt,
          expressionSha256,
          expressionBytes,
          effectiveTimeoutMs,
          effectiveOutputBytes,
          redactedValue,
          redactionCount,
          resultBytes,
        ),
        is_error:
          receipt.outcome !== 'completed' ||
          receipt.postObservation !== 'completed',
      },
      input.max_tokens,
    );
    return result;
  };

  const implementation: BrowserIrService = {
    create(input): Promise<BrowserIrToolResult> {
      if (disposed) {
        return Promise.reject(serviceDisposedError());
      }
      if (
        ownedBrowserIds.size + pendingCreates.size >=
        maxBrowsersPerConnection
      ) {
        return Promise.reject(
          new BrowserIrServiceError(
            'resource_limit',
            `This MCP connection has reached its ${maxBrowsersPerConnection}-browser connection limit. Close a browser before creating another.`,
          ),
        );
      }
      const pending = (async (): Promise<BrowserIrToolResult> => {
        const created = await runtimeCall(() => runtime.create(createOptions(input)));
        if (disposed) {
          await runtime.close({ browserId: created.browserId }).catch(() => {});
          throw new BrowserIrServiceError(
            'service_disposed',
            'The BrowserIR service connection closed while creating a browser.',
          );
        }
        ownedBrowserIds.add(created.browserId);
        return {
          summary: `Created browser ${created.browserId} at revision ${created.revision}.`,
          data: {
            browser_id: created.browserId,
            page_id: created.initialPageId,
            revision: created.revision,
          },
        };
      })();
      pendingCreates.add(pending);
      void pending.then(
        () => pendingCreates.delete(pending),
        () => pendingCreates.delete(pending),
      );
      return pending;
    },

    async navigate(input: BrowserNavigateInput): Promise<BrowserIrToolResult> {
      const viewBudget = budget(input.max_tokens);
      const result = await runtimeCall(() =>
        runtime.navigate({
          browserId: input.browser_id,
          url: input.url,
          expectedRevision: input.expected_revision,
          ...(input.page_id === undefined ? {} : { pageId: input.page_id }),
          budget: viewBudget,
        }),
      );
      return boundedModelResult(
        {
          summary: result.view.text,
          data: observationData(result, input.max_tokens),
        },
        input.max_tokens,
      );
    },

    async observe(input: BrowserObserveInput): Promise<BrowserIrToolResult> {
      if (input.expected_revision !== undefined) {
        const current = await runtimeCall(() =>
          runtime.inspect({
            browserId: input.browser_id,
            ...(input.page_id === undefined ? {} : { pageId: input.page_id }),
          }),
        );
        if (current.revision !== input.expected_revision) {
          throw new BrowserIrServiceError(
            'stale_revision',
            `Expected revision ${input.expected_revision}, current revision is ${current.revision}.`,
          );
        }
      }
      const viewBudget = budget(input.max_tokens);
      const result = await runtimeCall(() =>
        runtime.observe({
          browserId: input.browser_id,
          ...(input.page_id === undefined ? {} : { pageId: input.page_id }),
          budget: viewBudget,
        }),
      );
      return boundedModelResult(
        {
          summary: result.view.text,
          data: observationData(result, input.max_tokens),
        },
        input.max_tokens,
      );
    },

    async inspect(input: BrowserInspectInput): Promise<BrowserIrToolResult> {
      let pageId = input.page_id;
      if (pageId === undefined) {
        const pages = await runtimeCall(() => runtime.pages({ browserId: input.browser_id }));
        if (pages.length > 1) {
          throw new BrowserIrServiceError(
            'ambiguous_page',
            'page_id is required when a browser has more than one open page.',
          );
        }
        pageId = pages[0]?.pageId;
      }
      if (pageId === undefined) {
        throw new BrowserIrServiceError('unknown_page', 'BrowserIR has no page to inspect.');
      }
      const refs = input.entity_ids.map((entityId) => ({
        browserId: input.browser_id,
        pageId,
        entityId,
        revision: input.expected_revision,
      }));
      const viewBudget = budget(input.max_tokens);
      const view = await runtimeCall(() =>
        runtime.inspect({
          browserId: input.browser_id,
          pageId,
          refs,
          budget: viewBudget,
          includeEvidence: input.include_evidence === true,
        }),
      );
      if (view.revision !== input.expected_revision) {
        throw new BrowserIrServiceError(
          'stale_revision',
          `Expected revision ${input.expected_revision}, current revision is ${view.revision}.`,
        );
      }
      return boundedModelResult(
        {
          summary: view.text,
          data: {
            browser_id: view.browserId,
            page_id: view.pageId,
            revision: view.revision,
            view: serializedView(view),
            truncated: view.truncated,
            omissions: view.structured.omissions,
          },
        },
        input.max_tokens,
      );
    },

    async act(input: BrowserActInput): Promise<BrowserIrToolResult> {
      let pageId = input.page_id ?? explicitActionPageId(input.action);
      if (pageId === undefined) {
        const pages = await runtimeCall(() => runtime.pages({ browserId: input.browser_id }));
        if (pages.length > 1) {
          throw new BrowserIrServiceError(
            'ambiguous_page',
            'page_id is required when a browser has more than one open page.',
          );
        }
        pageId = pages[0]?.pageId;
      }
      if (pageId === undefined) {
        throw new BrowserIrServiceError('unknown_page', 'BrowserIR has no page to act on.');
      }
      const resolvedInput: BrowserActInput = { ...input, page_id: pageId };
      const mapped = await coreAction(resolvedInput, input.action, options);
      const viewBudget = budget(input.max_tokens);
      const receipt = await runtimeCall(() =>
        runtime.act({
          browserId: input.browser_id,
          expectedRevision: input.expected_revision,
          action: mapped.action,
          ...(mapped.pageId === undefined ? {} : { pageId: mapped.pageId }),
          budget: viewBudget,
        }),
      );
      const observation = receipt.observation?.view.text;
      const deltaFirst = usesDeltaFirstReceipt(input.action, receipt);
      const data = actionReceiptData(
        input.browser_id,
        mapped.pageId ?? input.page_id,
        receipt,
        input.max_tokens,
      );
      if (receipt.observation !== undefined) {
        data.representation = deltaFirst ? 'delta' : 'view';
      }
      let actionableContext: SerializedActionableContext | undefined;
      if (deltaFirst) {
        // These fields describe the omitted CompiledView budget. A delta-first
        // receipt intentionally returns no full view, so retaining them is both
        // misleading and repeated model context with no actionable meaning.
        delete data.truncated;
        delete data.omissions;
        actionableContext =
          receipt.observation === undefined
            ? undefined
            : serializedActionableContext(
                receipt.observation.view,
                actionEntityIds(input.action),
                actionableContextBudgetCharacters(input.max_tokens),
              );
        if (actionableContext !== undefined) {
          data.actionable_context = actionableContext;
        }
      }
      const deltaSummary =
        !deltaFirst
          ? undefined
          : `Action ${receipt.status} at revision ${receipt.postRevision ?? receipt.preRevision}; Delta only.` +
            (actionableContext === undefined
              ? ''
              : actionableContext.targets.length === 0
                ? ' Additional actionable targets were omitted by the response budget; observe to continue.'
                : ' Continue with fresh actionable_context targets using its page_id and revision.');
      return boundedModelResult(
        {
          summary:
            deltaSummary ??
            `Action ${receipt.status}.${observation === undefined ? '' : `\n${observation}`}`,
          data,
          is_error:
            receipt.status === 'blocked' ||
            receipt.status === 'stale_target' ||
            receipt.status === 'ambiguous_target',
        },
        input.max_tokens,
      );
    },

    async wait(input: BrowserWaitInput): Promise<BrowserIrToolResult> {
      const mapped = coreWaitCondition(input, input.condition);
      const pageId = mapped.pageId ?? input.page_id;
      const viewBudget = budget(input.max_tokens);
      const result = await runtimeCall(() =>
        runtime.wait({
          browserId: input.browser_id,
          expectedRevision: input.expected_revision,
          condition: mapped.condition,
          ...(pageId === undefined ? {} : { pageId }),
          ...(input.timeout_ms === undefined ? {} : { timeoutMs: input.timeout_ms }),
          budget: viewBudget,
        }),
      );
      return boundedModelResult(
        {
          summary: result.view.text,
          data: observationData(result, input.max_tokens),
        },
        input.max_tokens,
      );
    },

    async pages(input: BrowserPagesInput): Promise<BrowserIrToolResult> {
      const pages = await runtimeCall(() => runtime.pages({ browserId: input.browser_id }));
      return {
        summary:
          pages.length === 0
            ? 'No open pages.'
            : pages
                .map((page) => `${page.pageId} r${page.revision}: ${page.title ?? '(untitled)'} — ${page.url}`)
                .join('\n'),
        data: {
          browser_id: input.browser_id,
          pages: pages.map((page) => ({
            page_id: page.pageId,
            revision: page.revision,
            url: page.url,
            ...(page.title === undefined ? {} : { title: page.title }),
            ...(page.openerPageId === undefined ? {} : { opener_page_id: page.openerPageId }),
          })),
        },
      };
    },

    async capture(input: BrowserCaptureInput): Promise<BrowserIrToolResult> {
      const current = await runtimeCall(() =>
        runtime.observe({
          browserId: input.browser_id,
          ...(input.page_id === undefined ? {} : { pageId: input.page_id }),
        }),
      );
      if (current.view.revision !== input.expected_revision) {
        throw new BrowserIrServiceError(
          'stale_revision',
          `Expected revision ${input.expected_revision}, current revision is ${current.view.revision}.`,
        );
      }
      const pageId = input.page_id ?? current.view.pageId;
      const target =
        input.target_entity_id === undefined
          ? undefined
          : {
              browserId: input.browser_id,
              pageId,
              entityId: input.target_entity_id,
              revision: input.expected_revision,
            };
      const captureKind = input.kind ?? (target === undefined ? 'viewport' : 'entity');
      const capture = await runtimeCall(() =>
        runtime.capture({
          browserId: input.browser_id,
          pageId,
          expectedRevision: input.expected_revision,
          kind: captureKind,
          ...(target === undefined ? {} : { target }),
        }),
      );
      const clipIsValid =
        capture.clip === undefined ||
        (Number.isFinite(capture.clip.x) &&
          Number.isFinite(capture.clip.y) &&
          Number.isFinite(capture.clip.width) &&
          capture.clip.width > 0 &&
          Number.isFinite(capture.clip.height) &&
          capture.clip.height > 0);
      if (
        capture.browserId !== input.browser_id ||
        capture.pageId !== pageId ||
        capture.revision !== input.expected_revision ||
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
        throw new BrowserIrServiceError(
          'capture_invalid',
          'The runtime returned invalid capture identity, bytes, or geometry.',
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
        throw new BrowserIrServiceError(
          'capture_too_large',
          `Capture exceeds the ${MAX_CAPTURE_PHYSICAL_PIXELS} physical-pixel limit.`,
        );
      }
      if (capture.data.byteLength > MAX_CAPTURE_BYTES) {
        throw new BrowserIrServiceError(
          'capture_too_large',
          `Capture exceeds the ${MAX_CAPTURE_BYTES}-byte encoded-image limit.`,
        );
      }
      return {
        summary: `Captured ${captureKind} at revision ${capture.revision}.`,
        data: captureData(capture),
        image: {
          data: Buffer.from(capture.data).toString('base64'),
          mime_type: capture.mediaType,
        },
      };
    },

    async close(input: BrowserCloseInput): Promise<BrowserIrToolResult> {
      if (input.expected_revision !== undefined) {
        const current = await runtimeCall(() =>
          runtime.inspect({
            browserId: input.browser_id,
            ...(input.page_id === undefined ? {} : { pageId: input.page_id }),
          }),
        );
        if (current.revision !== input.expected_revision) {
          throw new BrowserIrServiceError(
            'stale_revision',
            `Expected revision ${input.expected_revision}, current revision is ${current.revision}.`,
          );
        }
      }
      await runtimeCall(() =>
        runtime.close({
          browserId: input.browser_id,
          ...(input.page_id === undefined ? {} : { pageId: input.page_id }),
        }),
      );
      if (input.page_id === undefined) ownedBrowserIds.delete(input.browser_id);
      return {
        summary:
          input.page_id === undefined
            ? `Closed browser ${input.browser_id}.`
            : `Closed page ${input.page_id}.`,
        data: {
          browser_id: input.browser_id,
          ...(input.page_id === undefined ? {} : { page_id: input.page_id }),
          closed: true,
        },
      };
    },

    dispose(): Promise<void> {
      disposed = true;
      if (!serviceAbort.signal.aborted) serviceAbort.abort();
      disposePromise ??= (async () => {
        await Promise.allSettled([...pendingCreates]);
        await Promise.all([...browserOperations.values()]);
        const browserIds = [...ownedBrowserIds];
        const results = await Promise.allSettled(
          browserIds.map((browserId) => runtime.close({ browserId })),
        );
        const failures: unknown[] = [];
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            ownedBrowserIds.delete(browserIds[index]!);
          } else {
            failures.push(result.reason);
          }
        });
        if (failures.length > 0) {
          throw new BrowserIrServiceError(
            'dispose_failed',
            `Failed to close ${failures.length} BrowserIR browser session${failures.length === 1 ? '' : 's'}.`,
          );
        }
      })();
      return disposePromise;
    },
  };

  return {
    create: (input) => implementation.create(input),
    navigate: (input) =>
      runForBrowser(input.browser_id, () => implementation.navigate(input)),
    observe: (input) =>
      runForBrowser(input.browser_id, () => implementation.observe(input)),
    inspect: (input) =>
      runForBrowser(input.browser_id, () => implementation.inspect(input)),
    act: (input) => runForBrowser(input.browser_id, () => implementation.act(input)),
    wait: (input) => runForBrowser(input.browser_id, () => implementation.wait(input)),
    pages: (input) => runForBrowser(input.browser_id, () => implementation.pages(input)),
    capture: (input) =>
      runForBrowser(input.browser_id, () => implementation.capture(input)),
    ...(unsafeOptions === undefined
      ? {}
      : {
          evaluateUnsafe: (
            input: BrowserEvaluateUnsafeInput,
            context?: BrowserIrCallContext,
          ) =>
            runForBrowser(input.browser_id, () =>
              evaluateUnsafe(input, context),
            ),
        }),
    close: (input) => runForBrowser(input.browser_id, () => implementation.close(input)),
    dispose: () => implementation.dispose!(),
  };
}
