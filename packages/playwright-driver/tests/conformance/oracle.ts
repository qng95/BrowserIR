import type {
  CompiledEntity,
  CompiledView,
  JsonValue,
} from '@browserir/core';

export type EntityPattern = {
  kind?: string;
  role?: string;
  name?: string;
  value?: JsonValue;
  state?: Readonly<Record<string, JsonValue>>;
  capability?: string;
};

export type ExpectedUnit = {
  key: string;
  locate: EntityPattern;
  expect: {
    kind?: string;
    role?: string;
    name?: string;
    value?: JsonValue;
    state?: Readonly<Record<string, JsonValue>>;
    actions?: readonly string[];
  };
};

export type RepresentationContract = {
  id: string;
  requireTextParity?: boolean;
  required: readonly ExpectedUnit[];
  forbidden?: readonly {
    label: string;
    match: EntityPattern;
  }[];
  allowedActionables?: readonly EntityPattern[];
  relations?: readonly {
    from: string;
    kind: string;
    to: string;
  }[];
  budget?: {
    maxCharacters: number;
    maxUnexpectedActionables?: number;
  };
};

export type OracleViolation = {
  kind:
    | 'missing'
    | 'ambiguous'
    | 'semantic'
    | 'forbidden'
    | 'relation'
    | 'text'
    | 'unexpected_actionable'
    | 'budget';
  key?: string;
  detail: string;
};

export type NormalizedRepresentation = {
  units: Array<{
    key: string;
    kind?: string;
    role?: string;
    name?: string;
    description?: string;
    text?: string;
    value?: JsonValue | undefined;
    state: Record<string, JsonValue>;
    actions: string[];
  }>;
  relations: Array<{
    from: string;
    kind: string;
    to: string;
  }>;
};

export type RepresentationGrade = {
  passed: boolean;
  scores: {
    coverage: number;
    semantics: number;
    relationRecall: number;
    actionablePrecision: number;
    compactness: number;
  };
  metrics: {
    representationCharacters: number;
    assertedFacts: number;
    usefulFactsPerThousandCharacters: number;
  };
  matches: Record<string, { entityId: string }>;
  violations: OracleViolation[];
  normalized: NormalizedRepresentation;
};

const normalizedText = (value: string): string =>
  value.normalize('NFKC').replace(/\s+/g, ' ').trim();

const normalizedValue = (value: JsonValue | undefined): JsonValue | undefined =>
  typeof value === 'string' ? normalizedText(value) : value;

const stableValue = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableValue(child)}`)
    .join(',')}}`;
};

const equalValue = (left: unknown, right: unknown): boolean =>
  stableValue(left) === stableValue(right);

const entityId = (entity: CompiledEntity): string => entity.ref.entityId;

const stateValue = (
  entity: CompiledEntity,
  key: string,
): JsonValue | undefined =>
  entity.state[key as keyof typeof entity.state] as JsonValue | undefined;

const matchesPattern = (
  entity: CompiledEntity,
  pattern: EntityPattern,
): boolean =>
  (pattern.kind === undefined || entity.kind === pattern.kind) &&
  (pattern.role === undefined || entity.role === pattern.role) &&
  (pattern.name === undefined ||
    (entity.name !== undefined &&
      normalizedText(entity.name) === normalizedText(pattern.name))) &&
  (pattern.value === undefined ||
    equalValue(normalizedValue(entity.value), normalizedValue(pattern.value))) &&
  (pattern.capability === undefined ||
    entity.capabilities.some(
      (capability) =>
        capability.kind === pattern.capability && capability.enabled !== false,
    )) &&
  Object.entries(pattern.state ?? {}).every(([key, value]) =>
    equalValue(stateValue(entity, key), value),
  );

const expectedFactCount = (unit: ExpectedUnit): number =>
  Number(unit.expect.kind !== undefined) +
  Number(unit.expect.role !== undefined) +
  Number(unit.expect.name !== undefined) +
  Number(unit.expect.value !== undefined) +
  Object.keys(unit.expect.state ?? {}).length +
  Number(unit.expect.actions !== undefined);

const actionSignatures = (entity: CompiledEntity): string[] =>
  entity.capabilities
    .map((capability) =>
      capability.enabled === false
        ? `${capability.kind}:disabled`
        : capability.kind,
    )
    .sort();

const semanticFacts = (
  entity: CompiledEntity,
  unit: ExpectedUnit,
): { correct: number; violations: OracleViolation[] } => {
  let correct = 0;
  const violations: OracleViolation[] = [];
  const check = (label: string, actual: unknown, expected: unknown): void => {
    if (equalValue(actual, expected)) {
      correct += 1;
    } else {
      violations.push({
        kind: 'semantic',
        key: unit.key,
        detail: `${label}: expected ${stableValue(expected)}, received ${stableValue(actual)}`,
      });
    }
  };

  if (unit.expect.kind !== undefined) {
    check('kind', entity.kind, unit.expect.kind);
  }
  if (unit.expect.role !== undefined) {
    check('role', entity.role, unit.expect.role);
  }
  if (unit.expect.name !== undefined) {
    check(
      'name',
      entity.name === undefined ? undefined : normalizedText(entity.name),
      normalizedText(unit.expect.name),
    );
  }
  if (unit.expect.value !== undefined) {
    check(
      'value',
      normalizedValue(entity.value),
      normalizedValue(unit.expect.value),
    );
  }
  for (const [key, expected] of Object.entries(unit.expect.state ?? {})) {
    check(`state.${key}`, stateValue(entity, key), expected);
  }
  if (unit.expect.actions !== undefined) {
    check('actions', actionSignatures(entity), [...unit.expect.actions].sort());
  }

  return { correct, violations };
};

const isActionable = (entity: CompiledEntity): boolean =>
  entity.capabilities.some(
    (capability) => capability.enabled !== false,
  );

export function gradeRepresentation(
  view: CompiledView,
  contract: RepresentationContract,
): RepresentationGrade {
  const entities = view.structured.entities;
  const violations: OracleViolation[] = [];
  const matchedEntities = new Map<string, CompiledEntity>();
  const claimedEntityIds = new Set<string>();
  let matchedRequired = 0;
  let assertedFacts = 0;
  let correctFacts = 0;

  for (const unit of contract.required) {
    assertedFacts +=
      expectedFactCount(unit) + Number(contract.requireTextParity === true);
    const candidates = entities.filter((entity) =>
      matchesPattern(entity, unit.locate),
    );
    if (candidates.length === 0) {
      violations.push({
        kind: 'missing',
        key: unit.key,
        detail: `No entity matched ${stableValue(unit.locate)}`,
      });
      continue;
    }
    if (candidates.length > 1) {
      violations.push({
        kind: 'ambiguous',
        key: unit.key,
        detail: `${candidates.length} entities matched ${stableValue(unit.locate)}`,
      });
      continue;
    }
    const entity = candidates[0]!;
    if (claimedEntityIds.has(entityId(entity))) {
      violations.push({
        kind: 'ambiguous',
        key: unit.key,
        detail: `Entity ${entityId(entity)} was already matched by another unit`,
      });
      continue;
    }
    claimedEntityIds.add(entityId(entity));
    matchedEntities.set(unit.key, entity);
    matchedRequired += 1;
    const semantics = semanticFacts(entity, unit);
    correctFacts += semantics.correct;
    violations.push(...semantics.violations);
    if (contract.requireTextParity === true) {
      const referenceToken = `[${entityId(entity)}@r${view.revision}]`;
      if (view.text.includes(referenceToken)) {
        correctFacts += 1;
      } else {
        violations.push({
          kind: 'text',
          key: unit.key,
          detail: `Compact text omitted required entity reference ${referenceToken}`,
        });
      }
    }
  }

  for (const forbidden of contract.forbidden ?? []) {
    const hits = entities.filter((entity) =>
      matchesPattern(entity, forbidden.match),
    );
    if (hits.length > 0) {
      violations.push({
        kind: 'forbidden',
        detail: `${forbidden.label}: matched ${hits
          .map((entity) => entityId(entity))
          .join(', ')}`,
      });
    }
  }

  let correctRelations = 0;
  for (const expected of contract.relations ?? []) {
    const from = matchedEntities.get(expected.from);
    const to = matchedEntities.get(expected.to);
    const present =
      from !== undefined &&
      to !== undefined &&
      view.structured.relations.some(
        (relation) =>
          relation.from.entityId === entityId(from) &&
          relation.to.entityId === entityId(to) &&
          relation.kind === expected.kind,
    );
    if (present) {
      correctRelations += 1;
    } else {
      violations.push({
        kind: 'relation',
        detail: `Missing ${expected.from} -[${expected.kind}]-> ${expected.to}`,
      });
    }
  }

  const actionable = entities.filter(isActionable);
  const matchedEntityIds = new Set(
    [...matchedEntities.values()].map((entity) => entityId(entity)),
  );
  const allowedActionables =
    contract.allowedActionables === undefined
      ? actionable.filter((entity) => matchedEntityIds.has(entityId(entity)))
      : actionable.filter((entity) =>
          contract.allowedActionables!.some((pattern) =>
            matchesPattern(entity, pattern),
          ),
        );
  const unexpectedActionables = actionable.filter(
    (entity) => !allowedActionables.includes(entity),
  );
  const maxUnexpectedActionables =
    contract.budget?.maxUnexpectedActionables ?? 0;
  const penalizedUnexpectedActionables = Math.max(
    0,
    unexpectedActionables.length - maxUnexpectedActionables,
  );
  if (penalizedUnexpectedActionables > 0) {
    violations.push({
      kind: 'unexpected_actionable',
      detail: `Expected at most ${maxUnexpectedActionables} unexpected actionable entities, received ${unexpectedActionables.length}: ${unexpectedActionables
        .map((entity) => entity.name ?? entityId(entity))
        .join(', ')}`,
    });
  }

  const representationCharacters = JSON.stringify({
    text: view.text,
    structured: view.structured,
  }).length;
  const maxCharacters =
    contract.budget?.maxCharacters ?? Number.POSITIVE_INFINITY;
  if (representationCharacters > maxCharacters) {
    violations.push({
      kind: 'budget',
      detail: `Representation used ${representationCharacters} characters; budget is ${maxCharacters}`,
    });
  }

  const normalizedUnits = contract.required
    .flatMap((unit) => {
      const entity = matchedEntities.get(unit.key);
      if (entity === undefined) return [];
      const state = Object.fromEntries(
        Object.entries(entity.state)
          .filter((entry): entry is [string, Exclude<typeof entry[1], undefined>] =>
            entry[1] !== undefined,
          )
          .sort(([left], [right]) => left.localeCompare(right)),
      ) as Record<string, JsonValue>;
      return [
        {
          key: unit.key,
          kind: entity.kind,
          ...(entity.role === undefined ? {} : { role: entity.role }),
          ...(entity.name === undefined
            ? {}
            : { name: normalizedText(entity.name) }),
          ...(entity.description === undefined
            ? {}
            : { description: normalizedText(entity.description) }),
          ...(entity.text === undefined
            ? {}
            : { text: normalizedText(entity.text) }),
          ...(entity.value === undefined
            ? {}
            : { value: normalizedValue(entity.value) }),
          state,
          actions: actionSignatures(entity),
        },
      ];
    })
    .sort((left, right) => left.key.localeCompare(right.key));
  const keyByEntityId = new Map(
    [...matchedEntities.entries()].map(([key, entity]) => [
      entityId(entity),
      key,
    ]),
  );
  const normalizedRelations = view.structured.relations
    .flatMap((relation) => {
      const from = keyByEntityId.get(relation.from.entityId);
      const to = keyByEntityId.get(relation.to.entityId);
      return from === undefined || to === undefined
        ? []
        : [{ from, kind: relation.kind, to }];
    })
    .sort(
      (left, right) =>
        left.from.localeCompare(right.from) ||
        left.kind.localeCompare(right.kind) ||
        left.to.localeCompare(right.to),
    );

  const coverage =
    contract.required.length === 0
      ? 1
      : matchedRequired / contract.required.length;
  const semantics = assertedFacts === 0 ? 1 : correctFacts / assertedFacts;
  const relationRecall =
    (contract.relations?.length ?? 0) === 0
      ? 1
      : correctRelations / contract.relations!.length;
  const actionablePrecision =
    actionable.length === 0
      ? 1
      : (actionable.length - penalizedUnexpectedActionables) /
        actionable.length;
  const compactness =
    Number.isFinite(maxCharacters) && representationCharacters > 0
      ? Math.min(1, maxCharacters / representationCharacters)
      : 1;
  const scores = {
    coverage,
    semantics,
    relationRecall,
    actionablePrecision,
    compactness,
  };

  return {
    passed:
      Object.values(scores).every((score) => score === 1) &&
      violations.length === 0,
    scores,
    metrics: {
      representationCharacters,
      assertedFacts,
      usefulFactsPerThousandCharacters:
        representationCharacters === 0
          ? 0
          : (correctFacts * 1_000) / representationCharacters,
    },
    matches: Object.fromEntries(
      [...matchedEntities.entries()].map(([key, entity]) => [
        key,
        { entityId: entityId(entity) },
      ]),
    ),
    violations,
    normalized: {
      units: normalizedUnits,
      relations: normalizedRelations,
    },
  };
}
