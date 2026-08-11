export interface SetQualityMetrics {
  expected: number;
  observed: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface CapabilityFact {
  /** Stable benchmark key for the entity, not necessarily a BrowserIR runtime ref. */
  entity: string;
  capability: string;
}

export interface RelationFact {
  /** Stable benchmark keys make relation scoring independent of runtime ref allocation. */
  from: string;
  kind: string;
  to: string;
}

export interface RepresentationFacts {
  entities: readonly string[];
  capabilities: readonly CapabilityFact[];
  relations: readonly RelationFact[];
  /** Case IDs where the correct result is to decline an unsafe or ambiguous inference. */
  abstentions?: readonly string[];
}

export interface CorrectAbstentionMetrics {
  expected: number;
  observed: number;
  correct: number;
  unexpected: number;
  missed: number;
  precision: number;
  recall: number;
  f1: number;
  /** Alias for recall: the share of required abstentions that were correctly made. */
  rate: number;
}

export interface RepresentationQualityMetrics {
  entities: SetQualityMetrics;
  capabilities: SetQualityMetrics;
  relations: SetQualityMetrics;
  correctAbstention: CorrectAbstentionMetrics;
}

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 1 : numerator / denominator;

const f1Score = (precision: number, recall: number): number =>
  precision + recall === 0
    ? 0
    : (2 * precision * recall) / (precision + recall);

const keyTuple = (...parts: readonly string[]): string => JSON.stringify(parts);

const scoreKeys = (
  expectedValues: Iterable<string>,
  observedValues: Iterable<string>,
): SetQualityMetrics => {
  const expected = new Set(expectedValues);
  const observed = new Set(observedValues);
  let truePositive = 0;
  for (const value of observed) {
    if (expected.has(value)) truePositive += 1;
  }
  const falsePositive = observed.size - truePositive;
  const falseNegative = expected.size - truePositive;
  const precision = ratio(truePositive, observed.size);
  const recall = ratio(truePositive, expected.size);
  return {
    expected: expected.size,
    observed: observed.size,
    truePositive,
    falsePositive,
    falseNegative,
    precision,
    recall,
    f1: f1Score(precision, recall),
  };
};

export function measureRepresentation(
  expected: RepresentationFacts,
  observed: RepresentationFacts,
): RepresentationQualityMetrics {
  const abstentions = scoreKeys(
    expected.abstentions ?? [],
    observed.abstentions ?? [],
  );
  return {
    entities: scoreKeys(expected.entities, observed.entities),
    capabilities: scoreKeys(
      expected.capabilities.map(({ entity, capability }) =>
        keyTuple(entity, capability),
      ),
      observed.capabilities.map(({ entity, capability }) =>
        keyTuple(entity, capability),
      ),
    ),
    relations: scoreKeys(
      expected.relations.map(({ from, kind, to }) => keyTuple(from, kind, to)),
      observed.relations.map(({ from, kind, to }) => keyTuple(from, kind, to)),
    ),
    correctAbstention: {
      expected: abstentions.expected,
      observed: abstentions.observed,
      correct: abstentions.truePositive,
      unexpected: abstentions.falsePositive,
      missed: abstentions.falseNegative,
      precision: abstentions.precision,
      recall: abstentions.recall,
      f1: abstentions.f1,
      rate: abstentions.recall,
    },
  };
}

export interface IdentityObservation {
  /** Logical record/control identity supplied by benchmark ground truth. */
  logicalKey: string;
  /** BrowserIR identity observed in this revision. */
  entityId: string;
}

export interface IdentityStabilityMetrics {
  baseline: number;
  observed: number;
  comparable: number;
  stable: number;
  changed: number;
  missing: number;
  added: number;
  /** Stable baseline identities divided by all baseline identities. */
  rate: number;
}

const identityMap = (
  observations: readonly IdentityObservation[],
  label: string,
): Map<string, string> => {
  const result = new Map<string, string>();
  for (const observation of observations) {
    if (result.has(observation.logicalKey)) {
      throw new Error(
        `${label} contains duplicate logical identity ${observation.logicalKey}.`,
      );
    }
    result.set(observation.logicalKey, observation.entityId);
  }
  return result;
};

export function measureIdentityStability(
  baselineObservations: readonly IdentityObservation[],
  currentObservations: readonly IdentityObservation[],
): IdentityStabilityMetrics {
  const baseline = identityMap(baselineObservations, 'Baseline');
  const current = identityMap(currentObservations, 'Current observation');
  let comparable = 0;
  let stable = 0;
  let changed = 0;
  let missing = 0;
  for (const [logicalKey, baselineId] of baseline) {
    const currentId = current.get(logicalKey);
    if (currentId === undefined) {
      missing += 1;
    } else {
      comparable += 1;
      if (currentId === baselineId) stable += 1;
      else changed += 1;
    }
  }
  let added = 0;
  for (const logicalKey of current.keys()) {
    if (!baseline.has(logicalKey)) added += 1;
  }
  return {
    baseline: baseline.size,
    observed: current.size,
    comparable,
    stable,
    changed,
    missing,
    added,
    rate: ratio(stable, baseline.size),
  };
}

export interface OmissionCount {
  category: string;
  count: number;
}

export interface OmissionCategoryMetrics {
  category: string;
  known: number;
  reported: number;
  accounted: number;
  unreported: number;
  overreported: number;
}

export interface OmissionAccountingMetrics {
  known: number;
  reported: number;
  accounted: number;
  unreported: number;
  overreported: number;
  precision: number;
  recall: number;
  f1: number;
  exact: boolean;
  categories: OmissionCategoryMetrics[];
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const omissionMap = (
  counts: readonly OmissionCount[],
  label: string,
): Map<string, number> => {
  const result = new Map<string, number>();
  for (const item of counts) {
    if (!Number.isSafeInteger(item.count) || item.count < 0) {
      throw new Error(`${label} omission counts must be non-negative integers.`);
    }
    result.set(item.category, (result.get(item.category) ?? 0) + item.count);
  }
  return result;
};

export function measureOmissionAccounting(
  knownOmissions: readonly OmissionCount[],
  reportedOmissions: readonly OmissionCount[],
): OmissionAccountingMetrics {
  const knownByCategory = omissionMap(knownOmissions, 'Known');
  const reportedByCategory = omissionMap(reportedOmissions, 'Reported');
  const categoryNames = [...new Set([
    ...knownByCategory.keys(),
    ...reportedByCategory.keys(),
  ])].sort(compareText);
  const categories = categoryNames.map((category): OmissionCategoryMetrics => {
    const known = knownByCategory.get(category) ?? 0;
    const reported = reportedByCategory.get(category) ?? 0;
    return {
      category,
      known,
      reported,
      accounted: Math.min(known, reported),
      unreported: Math.max(known - reported, 0),
      overreported: Math.max(reported - known, 0),
    };
  });
  const sum = (field: keyof Omit<OmissionCategoryMetrics, 'category'>): number =>
    categories.reduce((total, category) => total + category[field], 0);
  const known = sum('known');
  const reported = sum('reported');
  const accounted = sum('accounted');
  const unreported = sum('unreported');
  const overreported = sum('overreported');
  const precision = ratio(accounted, reported);
  const recall = ratio(accounted, known);
  return {
    known,
    reported,
    accounted,
    unreported,
    overreported,
    precision,
    recall,
    f1: f1Score(precision, recall),
    exact: unreported === 0 && overreported === 0,
    categories,
  };
}

export const TOKEN_ESTIMATE_CHARACTERS_PER_TOKEN = 4 as const;
export const TOKEN_ESTIMATE_METHOD =
  'ceil(unicode-code-points/4)' as const;

export interface PayloadMeasurement {
  /** Number of Unicode code points; this deliberately differs from UTF-16 length. */
  characters: number;
  characterCountMethod: 'unicode-code-points';
  utf8Bytes: number;
  /**
   * Planning estimate only. Real tokenizer counts depend on model and content;
   * benchmark comparisons requiring exact counts should inject model-tokenized metrics.
   */
  estimatedTokens: number;
  tokenEstimateMethod: typeof TOKEN_ESTIMATE_METHOD;
  charactersPerEstimatedToken: typeof TOKEN_ESTIMATE_CHARACTERS_PER_TOKEN;
}

export function measurePayload(payload: string): PayloadMeasurement {
  const characters = Array.from(payload).length;
  return {
    characters,
    characterCountMethod: 'unicode-code-points',
    utf8Bytes: Buffer.byteLength(payload, 'utf8'),
    estimatedTokens: Math.ceil(
      characters / TOKEN_ESTIMATE_CHARACTERS_PER_TOKEN,
    ),
    tokenEstimateMethod: TOKEN_ESTIMATE_METHOD,
    charactersPerEstimatedToken: TOKEN_ESTIMATE_CHARACTERS_PER_TOKEN,
  };
}

export type TaskOutcome = 'passed' | 'failed' | 'not_applicable';

export interface TaskOutcomeRecord {
  taskId: string;
  outcome: TaskOutcome;
  reason?: string;
}

export interface TaskOutcomeSummary {
  total: number;
  applicable: number;
  passed: number;
  failed: number;
  notApplicable: number;
  /** Null means there were no applicable tasks, rather than implying a 100% pass. */
  passRate: number | null;
}

export function aggregateTaskOutcomes<
  RecordType extends Pick<TaskOutcomeRecord, 'outcome'>,
>(
  records: readonly RecordType[],
): TaskOutcomeSummary {
  let passed = 0;
  let failed = 0;
  let notApplicable = 0;
  for (const record of records) {
    if (record.outcome === 'passed') passed += 1;
    else if (record.outcome === 'failed') failed += 1;
    else if (record.outcome === 'not_applicable') notApplicable += 1;
    else {
      throw new Error(`Unknown task outcome: ${String(record.outcome)}.`);
    }
  }
  const applicable = passed + failed;
  return {
    total: records.length,
    applicable,
    passed,
    failed,
    notApplicable,
    passRate: applicable === 0 ? null : passed / applicable,
  };
}
