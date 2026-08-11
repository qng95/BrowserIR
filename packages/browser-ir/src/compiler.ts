import type {
  Capability,
  CompiledEntity,
  CompiledRelation,
  CompiledView,
  Entity,
  EntityId,
  EntityRef,
  GraphSnapshot,
  JsonValue,
  Relation,
  StructuredView,
  ViewBudget,
  ViewOmission,
} from './types.js';

export interface CompileViewOptions {
  budget?: ViewBudget;
  entityIds?: ReadonlySet<EntityId>;
  additionalOmissions?: ViewOmission[];
  includeEvidence?: boolean;
}

type EntityBudgetShrinkStrategy = 'linear-reference' | 'search';

interface CompileViewInstrumentation {
  structuredBuilds: number;
  entityBudgetCandidates: number;
}

const compareText = (left: string | undefined, right: string | undefined): number =>
  (left ?? '') < (right ?? '') ? -1 : (left ?? '') > (right ?? '') ? 1 : 0;

const entityPriority = (entity: Entity): number => {
  if (entity.state.transient || entity.kind === 'dialog' || entity.kind === 'menu') return 0;
  if (entity.kind === 'document' || entity.kind === 'region') return 1;
  if (
    entity.kind === 'input' ||
    entity.role === 'textbox' ||
    entity.role === 'combobox' ||
    entity.role === 'spinbutton'
  ) {
    return 2;
  }
  if (
    entity.role === 'button' ||
    entity.role === 'checkbox' ||
    entity.role === 'radio' ||
    entity.role === 'switch' ||
    entity.role === 'tab'
  ) {
    return 3;
  }
  if (entity.role === 'link') return 4;
  if (entity.capabilities.length > 0) return 5;
  return 6;
};

const entityVerticalPosition = (entity: Entity): number =>
  entity.geometry?.viewportY ?? entity.geometry?.y ?? Number.MAX_SAFE_INTEGER;

const compareEntities = (left: Entity, right: Entity): number =>
  entityPriority(left) - entityPriority(right) ||
  Number(right.state.focused === true) - Number(left.state.focused === true) ||
  Number(left.geometry?.inViewport === false) - Number(right.geometry?.inViewport === false) ||
  entityVerticalPosition(left) - entityVerticalPosition(right) ||
  compareText(left.name, right.name) ||
  compareText(left.role, right.role) ||
  left.kind.localeCompare(right.kind) ||
  left.id.localeCompare(right.id);

const compareCapabilities = (left: Capability, right: Capability): number =>
  left.kind.localeCompare(right.kind) || compareText(left.reason, right.reason);

const compareRelations = (left: Relation, right: Relation): number =>
  left.from.localeCompare(right.from) ||
  left.kind.localeCompare(right.kind) ||
  left.to.localeCompare(right.to);

const stableJson = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`)
    .join(',')}}`;
};

const makeRef = (snapshot: GraphSnapshot, entityId: EntityId): EntityRef => ({
  browserId: snapshot.browserId,
  pageId: snapshot.pageId,
  entityId,
  revision: snapshot.revision,
});

const compileEntity = (
  snapshot: GraphSnapshot,
  entity: Entity,
  includeEvidence: boolean,
): CompiledEntity => {
  const {
    id,
    pageId: _pageId,
    capabilities,
    evidence,
    confidence,
    ...rest
  } = entity;
  return {
    ref: makeRef(snapshot, id),
    ...rest,
    capabilities: [...capabilities].sort(compareCapabilities),
    ...(includeEvidence
      ? {
          evidence: [...evidence].sort(
            (left, right) =>
              compareText(left.sensor, right.sensor) ||
              compareText(left.detail, right.detail) ||
              (left.confidence ?? 0) - (right.confidence ?? 0),
          ),
          confidence,
        }
      : {}),
  };
};

const compileRelation = (
  snapshot: GraphSnapshot,
  relation: Relation,
  includeEvidence: boolean,
): CompiledRelation => ({
  from: makeRef(snapshot, relation.from),
  to: makeRef(snapshot, relation.to),
  kind: relation.kind,
  ...(relation.confidence === undefined ? {} : { confidence: relation.confidence }),
  ...(includeEvidence && relation.evidence !== undefined
    ? {
        evidence: [...relation.evidence].sort(
          (left, right) =>
            compareText(left.sensor, right.sensor) ||
            compareText(left.detail, right.detail) ||
            (left.confidence ?? 0) - (right.confidence ?? 0),
        ),
      }
    : {}),
});

const mergeOmission = (omissions: ViewOmission[], next: ViewOmission): void => {
  const current = omissions.find((item) => item.kind === next.kind && item.reason === next.reason);
  if (current) {
    current.count += next.count;
    if (next.exact === false) current.exact = false;
    return;
  }
  omissions.push({ ...next });
};

const renderEntity = (entity: CompiledEntity): string => {
  const identity = [
    entity.kind,
    entity.role ? `role=${JSON.stringify(entity.role)}` : '',
    entity.name ? `name=${JSON.stringify(entity.name)}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const content = [
    entity.value === undefined ? '' : `value=${stableJson(entity.value)}`,
    entity.text ? `text=${JSON.stringify(entity.text)}` : '',
    entity.description ? `description=${JSON.stringify(entity.description)}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const state = Object.entries(entity.state)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(',');
  const capabilities = entity.capabilities.map((item) => item.kind).join(',');

  return [
    `[${entity.ref.entityId}@r${entity.ref.revision}]`,
    identity,
    content,
    state ? `state=${state}` : '',
    capabilities ? `actions=${capabilities}` : '',
  ]
    .filter(Boolean)
    .join(' ');
};

const renderRelation = (relation: CompiledRelation): string =>
  `[${relation.from.entityId}@r${relation.from.revision}] ${relation.kind} ` +
  `[${relation.to.entityId}@r${relation.to.revision}]`;

const renderText = (snapshot: GraphSnapshot, structured: StructuredView): string => {
  const lines = [
    `Page: ${structured.page.title ?? '(untitled)'}`,
    `URL: ${structured.page.url}`,
    `Revision: ${snapshot.revision}`,
  ];
  if (structured.page.visibleText) {
    lines.push(`Visible text: ${JSON.stringify(structured.page.visibleText)}`);
  }
  lines.push(...structured.entities.map(renderEntity));
  lines.push(...structured.relations.map(renderRelation));
  lines.push(
    ...structured.omissions.map(
      (omission) =>
        `[${omission.exact === false ? 'at least ' : ''}${omission.count} ${omission.kind} omitted: ${omission.reason}]`,
    ),
  );
  return lines.join('\n');
};

const positiveInteger = (value: number | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
};

const MIN_VIEW_BUDGET_CHARACTERS = 512;
const MAX_ENTITY_FIELD_CHARACTERS = 128;

const truncateEntityContent = (
  entity: Entity,
  includeEvidence: boolean,
): { entity: Entity; omittedCharacters: number } => {
  const next = { ...entity };
  let omittedCharacters = 0;
  const truncate = (value: string): string => {
    if (value.length <= MAX_ENTITY_FIELD_CHARACTERS) return value;
    const retainedCharacters = MAX_ENTITY_FIELD_CHARACTERS - 1;
    omittedCharacters += value.length - retainedCharacters;
    return `${value.slice(0, retainedCharacters)}…`;
  };
  const truncateValue = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') return truncate(value);
    if (Array.isArray(value)) return value.map(truncateValue);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [key, truncateValue(nested)]),
      );
    }
    return value;
  };

  if (entity.role !== undefined) next.role = truncate(entity.role);
  if (entity.name !== undefined) next.name = truncate(entity.name);
  if (entity.description !== undefined) next.description = truncate(entity.description);
  if (entity.text !== undefined) next.text = truncate(entity.text);
  if (entity.value !== undefined) next.value = truncateValue(entity.value);
  next.capabilities = entity.capabilities.map((capability) => ({
    ...capability,
    ...(capability.reason === undefined ? {} : { reason: truncate(capability.reason) }),
  }));
  if (includeEvidence) {
    next.evidence = entity.evidence.map((evidence) => ({
      ...evidence,
      sensor: truncate(evidence.sensor),
      ...(evidence.detail === undefined ? {} : { detail: truncate(evidence.detail) }),
    }));
  }
  return { entity: next, omittedCharacters };
};

function compileViewInternal(
  snapshot: GraphSnapshot,
  options: CompileViewOptions,
  shrinkStrategy: EntityBudgetShrinkStrategy,
  instrumentation?: CompileViewInstrumentation,
): CompiledView {
  const requestedMaxCharacters = positiveInteger(
    options.budget?.maxCharacters,
    Number.MAX_SAFE_INTEGER,
  );
  if (
    options.budget?.maxCharacters !== undefined &&
    requestedMaxCharacters < MIN_VIEW_BUDGET_CHARACTERS
  ) {
    throw new RangeError(
      `View maxCharacters must be at least ${MIN_VIEW_BUDGET_CHARACTERS}.`,
    );
  }
  const omissions: ViewOmission[] = [];
  for (const omission of snapshot.capturedOmissions ?? []) {
    mergeOmission(omissions, omission);
  }
  for (const omission of options.additionalOmissions ?? []) {
    mergeOmission(omissions, omission);
  }
  const focusedEntityIds =
    options.entityIds === undefined ? undefined : new Set(options.entityIds);
  const includedEntityIds =
    focusedEntityIds === undefined ? undefined : new Set(focusedEntityIds);
  if (includedEntityIds !== undefined) {
    for (const relation of snapshot.relations) {
      if (focusedEntityIds!.has(relation.from) || focusedEntityIds!.has(relation.to)) {
        includedEntityIds.add(relation.from);
        includedEntityIds.add(relation.to);
      }
    }
  }
  const entityContentOmissions = new Map<EntityId, number>();
  const preparedEntities =
    requestedMaxCharacters === Number.MAX_SAFE_INTEGER
      ? [...snapshot.entities]
      : snapshot.entities.map((entity) => {
          const prepared = truncateEntityContent(entity, options.includeEvidence === true);
          if (prepared.omittedCharacters > 0) {
            entityContentOmissions.set(entity.id, prepared.omittedCharacters);
          }
          return prepared.entity;
        });
  const entityById = new Map(preparedEntities.map((entity) => [entity.id, entity]));
  const semanticScopePriority = new Map<EntityId, number>();
  for (const relation of snapshot.relations) {
    if (relation.kind !== 'contains') continue;
    const scope = entityById.get(relation.from);
    const priority =
      scope?.role === 'main' || scope?.role === 'toolbar'
        ? 0
        : scope?.role === 'navigation'
          ? 2
          : 1;
    semanticScopePriority.set(
      relation.to,
      Math.min(semanticScopePriority.get(relation.to) ?? priority, priority),
    );
  }
  const allEntities = [...preparedEntities]
    .filter((entity) => includedEntityIds === undefined || includedEntityIds.has(entity.id))
    .sort(
      (left, right) =>
        (focusedEntityIds === undefined
          ? 0
          : Number(!focusedEntityIds.has(left.id)) - Number(!focusedEntityIds.has(right.id))) ||
        entityPriority(left) - entityPriority(right) ||
        (semanticScopePriority.get(left.id) ?? 1) -
          (semanticScopePriority.get(right.id) ?? 1) ||
        compareEntities(left, right),
    );

  if (focusedEntityIds !== undefined) {
    const excluded = snapshot.entities.length - allEntities.length;
    if (excluded > 0) {
      mergeOmission(omissions, { kind: 'entities', count: excluded, reason: 'not_in_focus' });
    }
  }

  const maxEntities = positiveInteger(options.budget?.maxEntities, Number.MAX_SAFE_INTEGER);
  let included = allEntities.slice(0, maxEntities);
  let pageUrl = snapshot.url;
  let pageTitle = snapshot.title;
  let visibleText = snapshot.visibleText;
  let omittedContentCharacters = 0;
  if (included.length < allEntities.length) {
    mergeOmission(omissions, {
      kind: 'entities',
      count: allEntities.length - included.length,
      reason: 'budget',
    });
  }

  const buildStructured = (): StructuredView => {
    if (instrumentation !== undefined) instrumentation.structuredBuilds += 1;
    const includedIds = new Set(included.map((entity) => entity.id));
    const relations = [...snapshot.relations]
      .filter((relation) => includedIds.has(relation.from) && includedIds.has(relation.to))
      .sort(compareRelations);
    const excludedRelations = snapshot.relations.length - relations.length;
    const nextOmissions = omissions.map((item) => ({ ...item }));
    const totalOmittedContentCharacters =
      omittedContentCharacters +
      included.reduce(
        (total, entity) => total + (entityContentOmissions.get(entity.id) ?? 0),
        0,
      );
    if (totalOmittedContentCharacters > 0) {
      mergeOmission(nextOmissions, {
        kind: 'content',
        count: totalOmittedContentCharacters,
        reason: 'budget',
      });
    }
    if (excludedRelations > 0) {
      mergeOmission(nextOmissions, {
        kind: 'relations',
        count: excludedRelations,
        reason: included.length < allEntities.length ? 'budget' : 'not_in_focus',
      });
    }
    return {
      page: {
        url: pageUrl,
        ...(pageTitle === undefined ? {} : { title: pageTitle }),
        ...(visibleText === undefined ? {} : { visibleText }),
      },
      entities: included.map((entity) =>
        compileEntity(snapshot, entity, options.includeEvidence === true),
      ),
      relations: relations.map((relation) =>
        compileRelation(snapshot, relation, options.includeEvidence === true),
      ),
      omissions: nextOmissions,
    };
  };

  let structured = buildStructured();
  let text = renderText(snapshot, structured);
  const maxCharacters = requestedMaxCharacters;
  const representationLength = (): number =>
    JSON.stringify({ text, structured }).length;

  if (representationLength() > maxCharacters && visibleText !== undefined) {
    omittedContentCharacters += visibleText.length;
    visibleText = undefined;
    structured = buildStructured();
    text = renderText(snapshot, structured);
  }

  if (shrinkStrategy === 'linear-reference') {
    while (included.length > 0 && representationLength() > maxCharacters) {
      if (instrumentation !== undefined) {
        instrumentation.entityBudgetCandidates += 1;
      }
      included = included.slice(0, -1);
      mergeOmission(omissions, { kind: 'entities', count: 1, reason: 'budget' });
      structured = buildStructured();
      text = renderText(snapshot, structured);
    }
  } else if (included.length > 0 && representationLength() > maxCharacters) {
    const searchableEntities = included;
    const omissionsBeforeShrink = omissions.map((item) => ({ ...item }));
    let currentCount = searchableEntities.length;

    const evaluateCandidate = (count: number): boolean => {
      if (instrumentation !== undefined) {
        instrumentation.entityBudgetCandidates += 1;
      }
      currentCount = count;
      included = searchableEntities.slice(0, count);
      omissions.splice(
        0,
        omissions.length,
        ...omissionsBeforeShrink.map((item) => ({ ...item })),
      );
      const omittedEntities = searchableEntities.length - count;
      if (omittedEntities > 0) {
        mergeOmission(omissions, {
          kind: 'entities',
          count: omittedEntities,
          reason: 'budget',
        });
      }
      structured = buildStructured();
      text = renderText(snapshot, structured);
      return representationLength() <= maxCharacters;
    };

    let low = 0;
    let high = searchableEntities.length - 1;
    let bestCount = 0;
    let foundFittingCandidate = false;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (evaluateCandidate(middle)) {
        bestCount = middle;
        foundFittingCandidate = true;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    if (!foundFittingCandidate) bestCount = 0;
    if (currentCount !== bestCount) evaluateCandidate(bestCount);
  }

  if (representationLength() > maxCharacters && pageTitle !== undefined) {
    omittedContentCharacters += pageTitle.length;
    pageTitle = undefined;
    structured = buildStructured();
    text = renderText(snapshot, structured);
  }

  if (representationLength() > maxCharacters && pageUrl.length > 0) {
    const originalUrl = pageUrl;
    const baseOmittedContentCharacters = omittedContentCharacters;
    let low = 0;
    let high = originalUrl.length;
    let bestUrl: string | undefined;
    let bestOmittedContentCharacters = baseOmittedContentCharacters + originalUrl.length;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      pageUrl =
        middle === originalUrl.length
          ? originalUrl
          : middle === 0
            ? ''
            : `${originalUrl.slice(0, middle)}…`;
      omittedContentCharacters =
        baseOmittedContentCharacters + originalUrl.length - middle;
      structured = buildStructured();
      text = renderText(snapshot, structured);
      if (representationLength() <= maxCharacters) {
        bestUrl = pageUrl;
        bestOmittedContentCharacters = omittedContentCharacters;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    pageUrl = bestUrl ?? '';
    omittedContentCharacters = bestOmittedContentCharacters;
    structured = buildStructured();
    text = renderText(snapshot, structured);
  }

  if (representationLength() > maxCharacters) {
    const marker = '[content omitted: budget]';
    const sourceText = text;
    let low = 0;
    let high = sourceText.length;
    let best = '';
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate =
        middle === 0 ? marker : `${sourceText.slice(0, middle)}\n${marker}`;
      text = candidate;
      if (representationLength() <= maxCharacters) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    text = best;
  }

  if (representationLength() > maxCharacters) {
    throw new RangeError('View budget is too small for required omission metadata.');
  }

  return {
    browserId: snapshot.browserId,
    pageId: snapshot.pageId,
    revision: snapshot.revision,
    structured,
    text,
    truncated: structured.omissions.some(
      (item) => item.reason === 'budget' || item.reason === 'scan_cap',
    ),
  };
}

export function compileView(
  snapshot: GraphSnapshot,
  options: CompileViewOptions = {},
): CompiledView {
  return compileViewInternal(snapshot, options, 'search');
}

/**
 * Internal compiler harness used by parity and complexity tests. It is not
 * re-exported from the package entrypoint.
 */
export function compileViewForTesting(
  snapshot: GraphSnapshot,
  options: CompileViewOptions,
  strategy: EntityBudgetShrinkStrategy,
): { view: CompiledView; structuredBuilds: number; entityBudgetCandidates: number } {
  const instrumentation: CompileViewInstrumentation = {
    structuredBuilds: 0,
    entityBudgetCandidates: 0,
  };
  return {
    view: compileViewInternal(snapshot, options, strategy, instrumentation),
    structuredBuilds: instrumentation.structuredBuilds,
    entityBudgetCandidates: instrumentation.entityBudgetCandidates,
  };
}
