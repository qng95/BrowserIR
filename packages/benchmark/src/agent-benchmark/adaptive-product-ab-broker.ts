import { types as nodeUtilTypes } from 'node:util';

import {
  ADAPTIVE_PLAYWRIGHT_TOOLS_VERSION,
  createAdaptivePlaywrightTools,
  type AdaptivePlaywrightMode,
  type AdaptivePlaywrightRawClient,
  type AdaptivePlaywrightTelemetry,
  type AdaptivePlaywrightTools,
} from 'browserir';
import {
  ADAPTIVE_REFERENCE_POLICIES_VERSION,
  createCrossTreeLabelReferencePolicy,
  createGridCoordinateReferencePolicy,
  createScheduleCoordinateReferencePolicy,
  type AdaptivePlaywrightReferencePolicySet,
} from 'browserir/reference-policies';

export const ADAPTIVE_PRODUCT_AB_BROKER_VERSION =
  'adaptive-product-ab-broker/1' as const;

export type AdaptiveProductAbFamily =
  | 'grid-coordinate'
  | 'schedule-coordinate'
  | 'cross-tree-label';

export type AdaptiveProductAbPolicyVersion =
  | 'grid-coordinate-policy/1'
  | 'schedule-coordinate-policy/3'
  | 'cross-tree-label-policy/1';

export interface AdaptiveProductAbBinding {
  readonly schemaVersion: typeof ADAPTIVE_PRODUCT_AB_BROKER_VERSION;
  readonly productToolsVersion: typeof ADAPTIVE_PLAYWRIGHT_TOOLS_VERSION;
  readonly productPoliciesVersion: typeof ADAPTIVE_REFERENCE_POLICIES_VERSION;
  readonly mode: AdaptivePlaywrightMode;
  readonly family: AdaptiveProductAbFamily;
  readonly policyVersion: AdaptiveProductAbPolicyVersion;
}

export interface AdaptiveProductAbBroker
  extends Pick<AdaptivePlaywrightTools, 'callTool' | 'listTools' | 'dispose'> {
  readonly binding: AdaptiveProductAbBinding;
}

export interface AdaptiveProductAbBrokerOptions {
  /** The experimental arms intentionally differ only by this product option. */
  readonly mode: AdaptivePlaywrightMode;
  /** Explicit first-party product policy; benchmark-private policies are not accepted. */
  readonly family: AdaptiveProductAbFamily;
  /** Native bounded product telemetry, forwarded without translation. */
  readonly telemetry?: AdaptivePlaywrightTelemetry | undefined;
}

interface CapturedAdaptiveProductAbBrokerOptions {
  readonly mode: AdaptivePlaywrightMode;
  readonly family: AdaptiveProductAbFamily;
  readonly telemetry: AdaptivePlaywrightTelemetry | undefined;
}

const exactPlainOwnData = (
  value: unknown,
  allowedKeySets: readonly (readonly string[])[],
  label: string,
): Readonly<Record<string, unknown>> => {
  if (
    value === null || typeof value !== 'object' || nodeUtilTypes.isProxy(value) ||
    Array.isArray(value)
  ) throw new TypeError(`${label} must be an exact plain own-data object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be an exact plain own-data object.`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError(`${label} contains fields outside its exact schema.`);
  }
  const stringKeys = keys as string[];
  if (!allowedKeySets.some((allowed) =>
    allowed.length === stringKeys.length &&
    allowed.every((key) => stringKeys.includes(key)))) {
    throw new TypeError(`${label} contains fields outside its exact schema.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const captured = Object.create(null) as Record<string, unknown>;
  for (const key of stringKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable ||
      descriptor.get !== undefined || descriptor.set !== undefined
    ) throw new TypeError(`${label} must contain only enumerable own data fields.`);
    captured[key] = descriptor.value;
  }
  return Object.freeze(captured);
};

const captureTelemetry = (value: unknown): AdaptivePlaywrightTelemetry | undefined => {
  if (value === undefined) return undefined;
  const captured = exactPlainOwnData(value, [['onEvent']], 'Adaptive product telemetry');
  const candidate = captured['onEvent'];
  if (typeof candidate !== 'function' || nodeUtilTypes.isProxy(candidate)) {
    throw new TypeError('Adaptive product telemetry requires a non-Proxy onEvent function.');
  }
  const onEvent = candidate as AdaptivePlaywrightTelemetry['onEvent'];
  return Object.freeze({ onEvent });
};

const captureOptions = (value: unknown): CapturedAdaptiveProductAbBrokerOptions => {
  const captured = exactPlainOwnData(value, [
    ['mode', 'family'],
    ['mode', 'family', 'telemetry'],
  ], 'Adaptive product A/B broker options');
  const mode = captured['mode'];
  const family = captured['family'];
  if (mode !== 'off' && mode !== 'auto') {
    throw new TypeError('Adaptive product A/B broker mode must be off or auto.');
  }
  if (
    family !== 'grid-coordinate' &&
    family !== 'schedule-coordinate' &&
    family !== 'cross-tree-label'
  ) {
    throw new TypeError('Adaptive product A/B broker family is unsupported.');
  }
  return Object.freeze({
    mode,
    family,
    telemetry: captureTelemetry(captured['telemetry']),
  });
};

const createProductPolicy = (
  family: AdaptiveProductAbFamily,
): AdaptivePlaywrightReferencePolicySet => {
  switch (family) {
    case 'grid-coordinate':
      return createGridCoordinateReferencePolicy();
    case 'schedule-coordinate':
      return createScheduleCoordinateReferencePolicy();
    case 'cross-tree-label':
      return createCrossTreeLabelReferencePolicy();
    default: {
      const exhaustive: never = family;
      throw new TypeError(`Unsupported adaptive product policy family: ${String(exhaustive)}.`);
    }
  }
};

const expectedPolicyVersion = (
  family: AdaptiveProductAbFamily,
): AdaptiveProductAbPolicyVersion => {
  switch (family) {
    case 'grid-coordinate':
      return 'grid-coordinate-policy/1';
    case 'schedule-coordinate':
      return 'schedule-coordinate-policy/3';
    case 'cross-tree-label':
      return 'cross-tree-label-policy/1';
    default: {
      const exhaustive: never = family;
      throw new TypeError(`Unsupported adaptive product policy family: ${String(exhaustive)}.`);
    }
  }
};

/**
 * Acquires the product middleware's exclusive lease on the exact raw MCP client.
 * Until `dispose()` settles, callers must not invoke the raw client's `callTool`
 * or `listTools` directly. Disposal releases the lease but never closes the
 * caller-owned client.
 */
export function createAdaptiveProductAbBroker(
  rawClient: AdaptivePlaywrightRawClient,
  options: AdaptiveProductAbBrokerOptions,
): AdaptiveProductAbBroker {
  // Capture every caller-authored field before acquiring the raw-client lease.
  // Accessors and Proxies are rejected without invoking their code.
  const captured = captureOptions(options);
  const policySet = createProductPolicy(captured.family);
  const policyVersion = expectedPolicyVersion(captured.family);
  if (policySet.family !== captured.family || policySet.version !== policyVersion) {
    throw new Error('Adaptive product reference-policy export drifted.');
  }
  const binding: AdaptiveProductAbBinding = Object.freeze({
    schemaVersion: ADAPTIVE_PRODUCT_AB_BROKER_VERSION,
    productToolsVersion: ADAPTIVE_PLAYWRIGHT_TOOLS_VERSION,
    productPoliciesVersion: ADAPTIVE_REFERENCE_POLICIES_VERSION,
    mode: captured.mode,
    family: policySet.family,
    policyVersion: policySet.version,
  });

  // Build the inert forwarding surface before lease acquisition. Acquisition
  // is the final fallible step, so no later binding/accessor failure can leak
  // the product wrapper's exclusive raw-client lease.
  let tools: AdaptivePlaywrightTools | undefined;
  const acquiredTools = (): AdaptivePlaywrightTools => {
    if (tools === undefined) throw new Error('Adaptive product broker is not acquired.');
    return tools;
  };
  const callTool: AdaptivePlaywrightTools['callTool'] = (...args) =>
    acquiredTools().callTool(...args);
  const listTools: AdaptivePlaywrightTools['listTools'] = (...args) =>
    acquiredTools().listTools(...args);
  const dispose: AdaptivePlaywrightTools['dispose'] = () => acquiredTools().dispose();
  const broker: AdaptiveProductAbBroker = Object.freeze({
    binding,
    callTool,
    listTools,
    dispose,
  });

  tools = createAdaptivePlaywrightTools(rawClient, {
    mode: captured.mode,
    policySet,
    ...(captured.telemetry === undefined ? {} : { telemetry: captured.telemetry }),
  });
  return broker;
}
