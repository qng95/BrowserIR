import {
  assertSafeAttributeName,
  type SnapshotNode,
  type StructuralSupplement,
  type SupplementAuthority,
  type SupplementContract,
} from './snapshot.js';

declare const adaptivePolicySetTypeBrand: unique symbol;

/** Opaque handle. Version 0.1 accepts only handles minted by this package. */
export interface AdaptivePlaywrightPolicySet {
  readonly [adaptivePolicySetTypeBrand]: true;
}

export type InternalPolicyDecision =
  | Readonly<{ kind: 'passthrough' }>
  | Readonly<{ kind: 'capture-boxes' }>;

export type InternalPolicyProjection =
  | Readonly<{ kind: 'unresolved' }>
  | Readonly<{ kind: 'resolved'; supplement: StructuralSupplement }>;

export interface InternalPolicyEvaluationContext {
  readonly snapshotTree: string;
  readonly nodes: readonly SnapshotNode[];
}

export interface InternalPolicyProjectionContext {
  readonly baselineSnapshotTree: string;
  readonly baselineNodes: readonly SnapshotNode[];
  readonly enrichedSnapshotTree: string;
  readonly enrichedNodes: readonly SnapshotNode[];
}

export interface InternalPolicySetDefinition extends SupplementAuthority {
  readonly evaluate: (context: InternalPolicyEvaluationContext) => InternalPolicyDecision;
  readonly project: (context: InternalPolicyProjectionContext) => InternalPolicyProjection;
}

export interface RegisteredPolicySet extends SupplementAuthority {
  readonly evaluate: InternalPolicySetDefinition['evaluate'];
  readonly project: InternalPolicySetDefinition['project'];
}

const registry = new WeakMap<object, RegisteredPolicySet>();
const boundedCode = /^[a-z][a-z0-9-]{0,63}$/u;
const boundedVersion = /^[a-z][a-z0-9-]{0,47}\/[1-9]\d{0,5}$/u;

const versionBoundToPolicy = (policyId: string, policyVersion: string): boolean =>
  policyVersion.startsWith(`${policyId}/`) ||
  policyVersion.startsWith(`${policyId}-policy/`);

const plainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const exactOwnDataKeys: (
  value: unknown,
  expected: readonly string[],
  label: string,
) => asserts value is Record<string, unknown> = (value, expected, label) => {
  if (!plainRecord(value)) throw new TypeError(`${label} must be a plain object.`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError(`${label} cannot contain symbol keys.`);
  }
  const actual = [...keys as string[]].sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) throw new TypeError(`${label} has unexpected properties.`);
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} must use enumerable own data properties.`);
    }
  }
};

const densePlainArray: (
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
) => asserts value is unknown[] = (value, minimum, maximum, label) => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be a plain array.`);
  }
  if (value.length < minimum || value.length > maximum) {
    throw new TypeError(`${label} length is outside the bound.`);
  }
  const keys = Reflect.ownKeys(value);
  const expected = new Set<PropertyKey>(['length']);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError(`${label} must be dense.`);
    expected.add(String(index));
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} entries must be enumerable own data properties.`);
    }
  }
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new TypeError(`${label} has exotic properties.`);
  }
};

const registerContracts = (value: unknown): readonly SupplementContract[] => {
  densePlainArray(value, 0, 32, 'Supplement contracts');
  const contracts: SupplementContract[] = [];
  const schemas = new Set<string>();
  for (let contractIndex = 0; contractIndex < value.length; contractIndex += 1) {
    const contract = value[contractIndex];
    exactOwnDataKeys(contract, ['schema', 'facts'], 'Supplement contract');
    if (typeof contract.schema !== 'string' || !boundedVersion.test(contract.schema)) {
      throw new TypeError('Supplement contract has an invalid schema.');
    }
    if (schemas.has(contract.schema)) throw new TypeError('Supplement contract schema is duplicated.');
    schemas.add(contract.schema);
    densePlainArray(contract.facts, 1, 64, 'Supplement fact contracts');
    const facts: Array<{ kind: string; attributes: readonly string[] }> = [];
    const kinds = new Set<string>();
    for (let factIndex = 0; factIndex < contract.facts.length; factIndex += 1) {
      const fact = contract.facts[factIndex]!;
      exactOwnDataKeys(fact, ['kind', 'attributes'], 'Supplement fact contract');
      if (typeof fact.kind !== 'string' || !boundedCode.test(fact.kind)) {
        throw new TypeError('Supplement fact contract has an invalid kind.');
      }
      if (kinds.has(fact.kind)) throw new TypeError('Supplement fact kind is duplicated.');
      kinds.add(fact.kind);
      densePlainArray(fact.attributes, 1, 16, 'Supplement attribute allowlist');
      const attributes: string[] = [];
      const seenAttributes = new Set<string>();
      for (let index = 0; index < fact.attributes.length; index += 1) {
        const attribute = fact.attributes[index];
        if (typeof attribute !== 'string') {
          throw new TypeError('Supplement attribute allowlist must contain strings.');
        }
        assertSafeAttributeName(attribute);
        if (seenAttributes.has(attribute)) {
          throw new TypeError('Supplement attribute allowlist contains a duplicate.');
        }
        seenAttributes.add(attribute);
        attributes.push(attribute);
      }
      facts.push(Object.freeze({
        kind: fact.kind,
        attributes: Object.freeze(attributes),
      }));
    }
    contracts.push(Object.freeze({
      schema: contract.schema,
      facts: Object.freeze(facts),
    }));
  }
  return Object.freeze(contracts);
};

const registerInternalPolicySet = <Handle extends object>(
  definition: InternalPolicySetDefinition,
  handle: Handle,
): Handle & AdaptivePlaywrightPolicySet => {
  exactOwnDataKeys(
    definition,
    ['policyId', 'policyVersion', 'supplementContracts', 'evaluate', 'project'],
    'Adaptive policy set',
  );
  if (
    typeof definition.policyId !== 'string' || !boundedCode.test(definition.policyId) ||
    typeof definition.policyVersion !== 'string' || !boundedVersion.test(definition.policyVersion) ||
    !versionBoundToPolicy(definition.policyId, definition.policyVersion)
  ) throw new TypeError('Adaptive policy identity is invalid.');
  if (typeof definition.evaluate !== 'function' || typeof definition.project !== 'function') {
    throw new TypeError('Adaptive policy set requires synchronous evaluate and project functions.');
  }
  const registered: RegisteredPolicySet = Object.freeze({
    policyId: definition.policyId,
    policyVersion: definition.policyVersion,
    supplementContracts: registerContracts(definition.supplementContracts),
    evaluate: definition.evaluate,
    project: definition.project,
  });
  const frozenHandle = Object.freeze(handle) as Handle & AdaptivePlaywrightPolicySet;
  registry.set(frozenHandle, registered);
  return frozenHandle;
};

export const createInternalPolicySet = (
  definition: InternalPolicySetDefinition,
): AdaptivePlaywrightPolicySet =>
  registerInternalPolicySet(definition, Object.create(null) as object);

/** Internal-only constructor for a frozen opaque handle with inert public metadata. */
export const createInternalPolicySetWithMetadata = <Metadata extends object>(
  definition: InternalPolicySetDefinition,
  metadata: Metadata,
): AdaptivePlaywrightPolicySet & Readonly<Metadata> => {
  if (!plainRecord(metadata)) throw new TypeError('Adaptive policy metadata must be a plain object.');
  const keys = Reflect.ownKeys(metadata);
  if (keys.length > 16 || keys.some((key) => typeof key !== 'string')) {
    throw new TypeError('Adaptive policy metadata has invalid properties.');
  }
  const handle = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(metadata, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError('Adaptive policy metadata must use enumerable own data properties.');
    }
    Object.defineProperty(handle, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return registerInternalPolicySet(
    definition,
    handle as Metadata,
  );
};

export const resolveInternalPolicySet = (
  handle: AdaptivePlaywrightPolicySet,
): RegisteredPolicySet => {
  if ((typeof handle !== 'object' && typeof handle !== 'function') || handle === null) {
    throw new TypeError('Adaptive middleware requires a first-party policy set.');
  }
  const registered = registry.get(handle);
  if (registered === undefined) {
    throw new TypeError('Adaptive middleware requires a first-party policy set.');
  }
  return registered;
};
