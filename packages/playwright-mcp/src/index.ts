import { types as nodeUtilTypes } from 'node:util';

import type {
  CallToolResult,
  Client,
  ContentBlock,
} from '@modelcontextprotocol/client';

import {
  resolveInternalPolicySet,
  type AdaptivePlaywrightPolicySet,
  type InternalPolicyDecision,
  type InternalPolicyProjection,
} from './internal/policy-set.js';
import {
  parseInlineSnapshot,
  parseSnapshotNodes,
  renderAdaptiveSnapshot,
  sameSnapshotState,
  type InlineSnapshotDocument,
  type SnapshotNode,
  type StructuralSupplement,
} from './internal/snapshot.js';

export type { AdaptivePlaywrightPolicySet } from './internal/policy-set.js';

export const ADAPTIVE_PLAYWRIGHT_TOOLS_VERSION = 'adaptive-playwright-tools/1' as const;

export type AdaptivePlaywrightMode = 'auto' | 'off';

export type AdaptivePlaywrightTelemetryOutcome =
  | 'disabled'
  | 'not-applicable'
  | 'passthrough'
  | 'cancelled-before-hidden'
  | 'deadline-exhausted'
  | 'hidden-failed'
  | 'state-mismatch'
  | 'projection-unresolved'
  | 'projected'
  | 'visible-failed';

/**
 * Bounded event with no URLs, refs, arguments, text, or MCP payloads.
 * `hiddenCalls` counts logical SDK calls, not lower-level transport attempts.
 */
export interface AdaptivePlaywrightTelemetryEvent {
  readonly schemaVersion: 'adaptive-playwright-telemetry/1';
  readonly mode: AdaptivePlaywrightMode;
  readonly operation: 'snapshot' | 'other';
  readonly outcome: AdaptivePlaywrightTelemetryOutcome;
  readonly hiddenCalls: 0 | 1;
}

export interface AdaptivePlaywrightTelemetry {
  readonly onEvent: (event: AdaptivePlaywrightTelemetryEvent) => void;
}

export interface AdaptivePlaywrightToolsOptions {
  readonly mode: AdaptivePlaywrightMode;
  readonly policySet: AdaptivePlaywrightPolicySet;
  /** Telemetry is disabled unless a callback is explicitly supplied. */
  readonly telemetry?: AdaptivePlaywrightTelemetry | undefined;
}

export type AdaptivePlaywrightRawClient = Pick<Client, 'callTool' | 'listTools'>;

export interface AdaptivePlaywrightTools {
  readonly callTool: AdaptivePlaywrightRawClient['callTool'];
  readonly listTools: AdaptivePlaywrightRawClient['listTools'];
  /** Stops admission and waits for accepted work. It never closes the caller-owned client. */
  dispose(): Promise<void>;
}

type CallArguments = Parameters<AdaptivePlaywrightRawClient['callTool']>;
type ListArguments = Parameters<AdaptivePlaywrightRawClient['listTools']>;
type HiddenRequestOptions = NonNullable<CallArguments[1]>;

const activeClientWrappers = new WeakMap<object, object>();

class SerialGate {
  #accepting = true;
  #tail: Promise<void> = Promise.resolve();
  #disposePromise: Promise<void> | undefined;

  run<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (!this.#accepting) return Promise.reject(new Error('Adaptive Playwright tools are disposed.'));
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#accepting = false;
    this.#disposePromise = this.#tail;
    return this.#disposePromise;
  }
}

interface SnapshotBlock {
  readonly index: number;
  readonly block: Extract<ContentBlock, { type: 'text' }>;
  readonly document: InlineSnapshotDocument;
}

const MAX_RESULT_CONTENT_BLOCKS = 256;
const MAX_RESULT_TEXT_UTF16_UNITS = 1_000_000;
const MAX_RESULT_TEXT_UTF8_BYTES = 1_000_000;
const resultTextEncoder = new TextEncoder();

const mirrorExtensibility = <Value extends object>(source: object, clone: Value): Value => {
  if (!Object.isExtensible(source)) Object.preventExtensions(clone);
  return clone;
};

const findSnapshotBlock = (result: CallToolResult): SnapshotBlock | undefined => {
  const content = result.content;
  if (
    !Array.isArray(content) ||
    nodeUtilTypes.isProxy(content) ||
    content.length > MAX_RESULT_CONTENT_BLOCKS
  ) return undefined;

  const retained: SnapshotBlock[] = [];
  let totalTextUtf16Units = 0;
  let totalTextUtf8Bytes = 0;
  for (const [index, block] of content.entries()) {
    if (block.type !== 'text') continue;
    totalTextUtf16Units += block.text.length;
    if (totalTextUtf16Units > MAX_RESULT_TEXT_UTF16_UNITS) return undefined;
    totalTextUtf8Bytes += resultTextEncoder.encode(block.text).byteLength;
    if (totalTextUtf8Bytes > MAX_RESULT_TEXT_UTF8_BYTES) return undefined;
    const document = parseInlineSnapshot(block.text);
    if (document !== undefined) retained.push({ index, block, document });
  }
  return retained.length === 1 ? retained[0] : undefined;
};

const cloneTextBlock = (
  block: Extract<ContentBlock, { type: 'text' }>,
  text: string,
): Extract<ContentBlock, { type: 'text' }> => {
  const descriptors = Object.getOwnPropertyDescriptors(block);
  const originalText = descriptors.text;
  descriptors.text = {
    ...(originalText ?? { configurable: true, enumerable: true, writable: true }),
    value: text,
  };
  const clone = Object.create(
    Object.getPrototypeOf(block),
    descriptors,
  ) as Extract<ContentBlock, { type: 'text' }>;
  return mirrorExtensibility(block, clone);
};

const cloneResultWithText = (
  result: CallToolResult,
  target: SnapshotBlock,
  text: string,
): CallToolResult => {
  const replacement = cloneTextBlock(target.block, text);
  const content = [] as ContentBlock[];
  Object.setPrototypeOf(content, Object.getPrototypeOf(result.content));
  const contentDescriptors = Object.getOwnPropertyDescriptors(result.content);
  const targetKey = String(target.index);
  contentDescriptors[targetKey] = {
    ...(contentDescriptors[targetKey] ?? {
      configurable: true,
      enumerable: true,
      writable: true,
    }),
    value: replacement,
  };
  const lengthDescriptor = contentDescriptors.length;
  Reflect.deleteProperty(contentDescriptors, 'length');
  Object.defineProperties(content, contentDescriptors as unknown as PropertyDescriptorMap);
  if (lengthDescriptor !== undefined) Object.defineProperty(content, 'length', lengthDescriptor);
  mirrorExtensibility(result.content, content);
  const descriptors = Object.getOwnPropertyDescriptors(result);
  const originalContent = descriptors.content;
  descriptors.content = {
    ...(originalContent ?? { configurable: true, enumerable: true, writable: true }),
    value: content,
  };
  const clone = Object.create(Object.getPrototypeOf(result), descriptors) as CallToolResult;
  return mirrorExtensibility(result, clone);
};

const intrinsicFunctionToString = Function.prototype.toString;
const localObjectPrototype = Object.prototype;
const localObjectPrototypeKeys = Object.freeze(Reflect.ownKeys(localObjectPrototype));
const localObjectPrototypeDescriptors = Object.getOwnPropertyDescriptors(localObjectPrototype);
const localObjectPrototypeExtensible = Object.isExtensible(localObjectPrototype);

const sameBuiltinFunctionShape = (candidate: unknown, local: unknown): boolean => {
  if (candidate === local) return true;
  if (typeof candidate !== 'function' || typeof local !== 'function') return false;
  if (nodeUtilTypes.isProxy(candidate)) return false;
  try {
    return Reflect.apply(intrinsicFunctionToString, candidate, []) ===
      Reflect.apply(intrinsicFunctionToString, local, []);
  } catch {
    return false;
  }
};

/**
 * Recognizes the intrinsic Object.prototype of this or another realm without
 * trusting constructor access, inherited properties, or user code. The
 * constructor-to-prototype identity closes the lookalike-prototype case while
 * descriptor/source matching admits a genuine Object.prototype from a VM.
 */
const realmObjectPrototype = (prototype: object): boolean => {
  if (prototype === localObjectPrototype) return true;
  if (nodeUtilTypes.isProxy(prototype)) return false;
  try {
    if (
      Object.getPrototypeOf(prototype) !== null ||
      Object.isExtensible(prototype) !== localObjectPrototypeExtensible
    ) return false;
    const keys = Reflect.ownKeys(prototype);
    if (
      keys.length !== localObjectPrototypeKeys.length ||
      keys.some((key, index) => key !== localObjectPrototypeKeys[index])
    ) return false;
    for (const key of keys) {
      const candidate = Object.getOwnPropertyDescriptor(prototype, key);
      const local = Object.getOwnPropertyDescriptor(localObjectPrototypeDescriptors, key)?.value as
        | PropertyDescriptor
        | undefined;
      if (
        candidate === undefined || local === undefined ||
        candidate.configurable !== local.configurable ||
        candidate.enumerable !== local.enumerable ||
        ('value' in candidate) !== ('value' in local)
      ) return false;
      if ('value' in candidate && 'value' in local) {
        if (
          candidate.writable !== local.writable ||
          !(typeof local.value === 'function'
            ? sameBuiltinFunctionShape(candidate.value, local.value)
            : Object.is(candidate.value, local.value))
        ) return false;
      } else {
        if (
          !sameBuiltinFunctionShape(candidate.get, local.get) ||
          !sameBuiltinFunctionShape(candidate.set, local.set)
        ) return false;
      }
    }
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
    if (
      constructor === undefined || !('value' in constructor) ||
      typeof constructor.value !== 'function' || nodeUtilTypes.isProxy(constructor.value)
    ) return false;
    const constructorPrototype = Object.getOwnPropertyDescriptor(constructor.value, 'prototype');
    return constructorPrototype !== undefined && 'value' in constructorPrototype &&
      constructorPrototype.value === prototype;
  } catch {
    return false;
  }
};

const plainRecordPrototype = (value: unknown): object | null | undefined => {
  if (value === null || typeof value !== 'object') return undefined;
  if (nodeUtilTypes.isProxy(value)) return undefined;
  if (Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || realmObjectPrototype(prototype) ? prototype : undefined;
};

const plainObject = (value: unknown): value is Record<string, unknown> =>
  plainRecordPrototype(value) !== undefined;

const exactOwnDataProperties = (
  value: unknown,
  allowedKeySets: readonly (readonly string[])[],
): value is Record<string, unknown> => {
  if (!plainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) return false;
  const strings = keys as string[];
  if (!allowedKeySets.some((allowed) =>
    allowed.length === strings.length && allowed.every((key) => strings.includes(key)))) return false;
  return strings.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable;
  });
};

const safeOwnName = (request: unknown): string | undefined => {
  try {
    if (!plainObject(request)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(request, 'name');
    return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
};

interface DataPropertyCommitment {
  readonly key: string;
  readonly value: unknown;
  readonly configurable: boolean;
  readonly enumerable: boolean;
  readonly writable: boolean;
}

interface PlainRecordCommitment {
  readonly value: Record<string, unknown>;
  readonly prototype: object | null;
  readonly extensible: boolean;
  readonly properties: readonly DataPropertyCommitment[];
}

interface DefaultSnapshotRequestCommitment {
  readonly request: PlainRecordCommitment;
  readonly arguments?: PlainRecordCommitment | undefined;
}

const capturePlainRecordCommitment = (
  value: unknown,
  allowedKeySets: readonly (readonly string[])[],
): PlainRecordCommitment | undefined => {
  const prototype = plainRecordPrototype(value);
  if (prototype === undefined) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (keys.some((key) => typeof key !== 'string')) return undefined;
  const strings = keys as string[];
  if (!allowedKeySets.some((allowed) =>
    allowed.length === strings.length && allowed.every((key) => strings.includes(key)))) {
    return undefined;
  }
  const properties: DataPropertyCommitment[] = [];
  for (const key of strings) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      return undefined;
    }
    properties.push(Object.freeze({
      key,
      value: descriptor.value,
      configurable: descriptor.configurable === true,
      enumerable: descriptor.enumerable === true,
      writable: descriptor.writable === true,
    }));
  }
  return Object.freeze({
    value: record,
    prototype,
    extensible: Object.isExtensible(record),
    properties: Object.freeze(properties),
  });
};

const samePlainRecordCommitment = (commitment: PlainRecordCommitment): boolean => {
  const recaptured = capturePlainRecordCommitment(
    commitment.value,
    [commitment.properties.map(({ key }) => key)],
  );
  if (
    recaptured === undefined ||
    recaptured.prototype !== commitment.prototype ||
    recaptured.extensible !== commitment.extensible ||
    recaptured.properties.length !== commitment.properties.length
  ) return false;
  return recaptured.properties.every((property, index) => {
    const retained = commitment.properties[index];
    return retained !== undefined &&
      property.key === retained.key &&
      Object.is(property.value, retained.value) &&
      property.configurable === retained.configurable &&
      property.enumerable === retained.enumerable &&
      property.writable === retained.writable;
  });
};

const captureDefaultSnapshotRequestCommitment = (
  request: unknown,
  callArgumentCount: number,
): DefaultSnapshotRequestCommitment | undefined => {
  if (callArgumentCount < 1 || callArgumentCount > 2) return undefined;
  const requestCommitment = capturePlainRecordCommitment(
    request,
    [['name'], ['name', 'arguments']],
  );
  if (requestCommitment === undefined) return undefined;
  const name = requestCommitment.properties.find(({ key }) => key === 'name');
  if (name?.value !== 'browser_snapshot') return undefined;
  const argumentsProperty = requestCommitment.properties.find(({ key }) => key === 'arguments');
  if (argumentsProperty === undefined || argumentsProperty.value === undefined) {
    return Object.freeze({ request: requestCommitment });
  }
  const argumentsCommitment = capturePlainRecordCommitment(argumentsProperty.value, [[]]);
  return argumentsCommitment === undefined
    ? undefined
    : Object.freeze({ request: requestCommitment, arguments: argumentsCommitment });
};

const sameDefaultSnapshotRequestCommitment = (
  commitment: DefaultSnapshotRequestCommitment,
): boolean => samePlainRecordCommitment(commitment.request) &&
  (commitment.arguments === undefined || samePlainRecordCommitment(commitment.arguments));

type HiddenOptionsPlan =
  | Readonly<{ kind: 'eligible'; options?: HiddenRequestOptions | undefined }>
  | Readonly<{ kind: 'ineligible' | 'aborted' | 'exhausted' }>;

const safeOptionKeys = ['signal', 'timeout', 'maxTotalTimeout'] as const;
const safeOptionKeySets = Object.freeze([
  Object.freeze([]),
  Object.freeze(['signal']),
  Object.freeze(['timeout']),
  Object.freeze(['maxTotalTimeout']),
  Object.freeze(['signal', 'timeout']),
  Object.freeze(['signal', 'maxTotalTimeout']),
  Object.freeze(['timeout', 'maxTotalTimeout']),
  Object.freeze(['signal', 'timeout', 'maxTotalTimeout']),
] as const);

type HiddenOptionsCommitment =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'present'; record: PlainRecordCommitment }>;

const absentHiddenOptionsCommitment: HiddenOptionsCommitment = Object.freeze({ kind: 'absent' });

const captureHiddenOptionsCommitment = (
  options: CallArguments[1],
): HiddenOptionsCommitment | undefined => {
  if (options === undefined) return absentHiddenOptionsCommitment;
  const record = capturePlainRecordCommitment(options, safeOptionKeySets);
  return record === undefined ? undefined : Object.freeze({ kind: 'present', record });
};

const sameHiddenOptionsCommitment = (commitment: HiddenOptionsCommitment): boolean =>
  commitment.kind === 'absent' || samePlainRecordCommitment(commitment.record);

const intrinsicAbortSignalAbortedGetter = (() => {
  try {
    if (typeof AbortSignal === 'undefined') return undefined;
    const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
    return typeof getter === 'function' && !nodeUtilTypes.isProxy(getter) ? getter : undefined;
  } catch {
    return undefined;
  }
})();

const safeSignalAborted = (value: unknown): boolean | undefined => {
  if (value === null || typeof value !== 'object' || nodeUtilTypes.isProxy(value)) return undefined;
  if (intrinsicAbortSignalAbortedGetter === undefined) return undefined;
  try {
    const aborted: unknown = Reflect.apply(intrinsicAbortSignalAbortedGetter, value, []);
    return typeof aborted === 'boolean' ? aborted : undefined;
  } catch {
    return undefined;
  }
};

const hiddenOptionsPlan = (
  commitment: HiddenOptionsCommitment,
  elapsedMs: number,
): HiddenOptionsPlan => {
  if (commitment.kind === 'absent') return { kind: 'eligible' };
  const output = Object.create(null) as HiddenRequestOptions;
  for (const key of safeOptionKeys) {
    const property = commitment.record.properties.find((candidate) => candidate.key === key);
    if (property === undefined) continue;
    const value = property.value;
    if (value === undefined) continue;
    if (key === 'signal') {
      const aborted = safeSignalAborted(value);
      if (aborted === undefined) return { kind: 'ineligible' };
      if (aborted) return { kind: 'aborted' };
      Object.defineProperty(output, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return { kind: 'ineligible' };
    }
    const remaining = value - elapsedMs;
    if (remaining <= 0) return { kind: 'exhausted' };
    Object.defineProperty(output, key, {
      value: remaining,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return Reflect.ownKeys(output).length === 0
    ? { kind: 'eligible' }
    : { kind: 'eligible', options: output };
};

const isThenable = (value: unknown): value is PromiseLike<unknown> => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  return typeof Reflect.get(value, 'then') === 'function';
};

const suppressNativePromiseRejection = (value: PromiseLike<unknown>): void => {
  try {
    // Use the intrinsic directly: this attaches a rejection handler only to
    // objects with Promise internal slots and never invokes a custom `then`.
    Reflect.apply(Promise.prototype.then, value, [undefined, () => undefined]);
  } catch {
    // Arbitrary thenables are rejected without assimilation or invocation.
  }
};

const validDecision = (value: unknown): value is InternalPolicyDecision => {
  if (!plainObject(value)) return false;
  const kind = Object.getOwnPropertyDescriptor(value, 'kind');
  return exactOwnDataProperties(value, [['kind']]) &&
    (kind?.value === 'passthrough' || kind?.value === 'capture-boxes');
};

const validProjection = (value: unknown): value is InternalPolicyProjection => {
  if (!plainObject(value)) return false;
  const kind = Object.getOwnPropertyDescriptor(value, 'kind')?.value;
  return kind === 'unresolved'
    ? exactOwnDataProperties(value, [['kind']])
    : kind === 'resolved' && exactOwnDataProperties(value, [['kind', 'supplement']]);
};

/**
 * Wraps only raw tools/list and tools/call. The client remains caller-owned.
 * While this lease is active, callers must route those two methods exclusively
 * through the wrapper; direct raw-client calls cannot be detected or serialized.
 * One hidden count means one logical `client.callTool`, not one wire attempt.
 */
export function createAdaptivePlaywrightTools(
  client: AdaptivePlaywrightRawClient,
  options: AdaptivePlaywrightToolsOptions,
): AdaptivePlaywrightTools {
  if (client === null || typeof client !== 'object' ||
    typeof client.callTool !== 'function' || typeof client.listTools !== 'function') {
    throw new TypeError('Adaptive middleware requires an MCP client.');
  }
  if (options.mode !== 'auto' && options.mode !== 'off') {
    throw new TypeError('Adaptive middleware mode must be auto or off.');
  }
  const policySet = resolveInternalPolicySet(options.policySet);
  if (options.telemetry !== undefined && typeof options.telemetry.onEvent !== 'function') {
    throw new TypeError('Adaptive telemetry requires an onEvent callback.');
  }
  if (activeClientWrappers.has(client)) {
    throw new Error('This MCP client already has an active adaptive wrapper.');
  }

  const mode = options.mode;
  const telemetrySink = options.telemetry?.onEvent;
  const gate = new SerialGate();
  const leaseToken = Object.freeze({});
  let policyRunning = false;
  let disposePromise: Promise<void> | undefined;

  const emit = (
    operation: AdaptivePlaywrightTelemetryEvent['operation'],
    outcome: AdaptivePlaywrightTelemetryOutcome,
    hiddenCalls: 0 | 1,
  ): void => {
    if (telemetrySink === undefined) return;
    const event: AdaptivePlaywrightTelemetryEvent = Object.freeze({
      schemaVersion: 'adaptive-playwright-telemetry/1',
      mode,
      operation,
      outcome,
      hiddenCalls,
    });
    try {
      const possibleThenable: unknown = telemetrySink(event);
      // Never assimilate an arbitrary thenable. The intrinsic helper only
      // attaches a rejection handler when native Promise slots are present.
      if (isThenable(possibleThenable)) {
        suppressNativePromiseRejection(possibleThenable);
        return;
      }
    } catch {
      // Observability must never change raw MCP behavior.
    }
  };

  const invokePolicy = <Value, Result>(
    operation: () => Value,
    consume: (value: Value) => Result,
  ): Result => {
    if (policyRunning) throw new Error('Adaptive policy re-entry is forbidden.');
    policyRunning = true;
    try {
      const value: unknown = operation();
      if (isThenable(value)) {
        suppressNativePromiseRejection(value);
        throw new Error('Adaptive policies must be synchronous.');
      }
      return consume(value as Value);
    } finally {
      policyRunning = false;
    }
  };

  const callTool = (...args: CallArguments): ReturnType<AdaptivePlaywrightRawClient['callTool']> => {
    if (policyRunning) return Promise.reject(new Error('Adaptive policy re-entry is forbidden.'));
    const admittedAt = performance.now();
    return gate.run(async () => {
      const request = args[0];
      const operation = safeOwnName(request) === 'browser_snapshot' ? 'snapshot' : 'other';
      let requestCommitment: DefaultSnapshotRequestCommitment | undefined;
      let optionsCommitment: HiddenOptionsCommitment | undefined;
      if (mode === 'auto') {
        try {
          requestCommitment = captureDefaultSnapshotRequestCommitment(request, args.length);
          optionsCommitment = captureHiddenOptionsCommitment(args[1]);
        } catch {
          requestCommitment = undefined;
          optionsCommitment = undefined;
        }
      }
      let visible: CallToolResult;
      try {
        visible = await client.callTool(...args);
      } catch (error) {
        emit(operation, 'visible-failed', 0);
        throw error;
      }
      if (mode === 'off') {
        emit(operation, 'disabled', 0);
        return visible;
      }
      let requestEligible = false;
      let visibleIsError = false;
      try {
        visibleIsError = visible.isError === true;
        requestEligible = requestCommitment !== undefined &&
          optionsCommitment !== undefined &&
          sameDefaultSnapshotRequestCommitment(requestCommitment) &&
          sameHiddenOptionsCommitment(optionsCommitment);
      } catch {
        emit(operation, 'not-applicable', 0);
        return visible;
      }
      if (!requestEligible || visibleIsError) {
        emit(operation, 'not-applicable', 0);
        return visible;
      }

      let baseline: SnapshotBlock | undefined;
      let baselineNodes: readonly SnapshotNode[];
      try {
        baseline = findSnapshotBlock(visible);
        if (baseline === undefined || baseline.document.pageUrl === undefined) {
          emit(operation, 'not-applicable', 0);
          return visible;
        }
        baselineNodes = parseSnapshotNodes(baseline.document.snapshotTree);
        const captureBoxes = invokePolicy(
          () => policySet.evaluate({
            snapshotTree: baseline!.document.snapshotTree,
            nodes: baselineNodes,
          }),
          (decision) => validDecision(decision) &&
            Object.getOwnPropertyDescriptor(decision, 'kind')?.value === 'capture-boxes',
        );
        if (!captureBoxes) {
          emit(operation, 'passthrough', 0);
          return visible;
        }
      } catch {
        emit(operation, 'passthrough', 0);
        return visible;
      }

      let plan: HiddenOptionsPlan;
      try {
        plan = hiddenOptionsPlan(
          optionsCommitment!,
          Math.max(0, performance.now() - admittedAt),
        );
      } catch {
        plan = { kind: 'ineligible' };
      }
      if (plan.kind !== 'eligible') {
        emit(
          operation,
          plan.kind === 'aborted'
            ? 'cancelled-before-hidden'
            : plan.kind === 'exhausted'
              ? 'deadline-exhausted'
              : 'not-applicable',
          0,
        );
        return visible;
      }

      try {
        if (
          requestCommitment === undefined ||
          optionsCommitment === undefined ||
          !sameDefaultSnapshotRequestCommitment(requestCommitment) ||
          !sameHiddenOptionsCommitment(optionsCommitment)
        ) {
          emit(operation, 'not-applicable', 0);
          return visible;
        }
      } catch {
        emit(operation, 'not-applicable', 0);
        return visible;
      }

      let enrichedResult: CallToolResult;
      try {
        enrichedResult = plan.options === undefined
          ? await client.callTool({ name: 'browser_snapshot', arguments: { boxes: true } })
          : await client.callTool(
            { name: 'browser_snapshot', arguments: { boxes: true } },
            plan.options,
          );
      } catch {
        emit(operation, 'hidden-failed', 1);
        return visible;
      }
      try {
        if (enrichedResult.isError === true) {
          emit(operation, 'hidden-failed', 1);
          return visible;
        }
      } catch {
        emit(operation, 'hidden-failed', 1);
        return visible;
      }

      try {
        const enriched = findSnapshotBlock(enrichedResult);
        if (enriched === undefined) {
          emit(operation, 'hidden-failed', 1);
          return visible;
        }
        if (!sameSnapshotState(baseline.document, enriched.document)) {
          emit(operation, 'state-mismatch', 1);
          return visible;
        }
        const enrichedNodes = parseSnapshotNodes(enriched.document.snapshotTree);
        if (!enrichedNodes.some(({ box }) => box !== undefined)) {
          emit(operation, 'projection-unresolved', 1);
          return visible;
        }
        const text = invokePolicy(
          () => policySet.project({
            baselineSnapshotTree: baseline.document.snapshotTree,
            baselineNodes,
            enrichedSnapshotTree: enriched.document.snapshotTree,
            enrichedNodes,
          }),
          (projection) => {
            if (!validProjection(projection)) return undefined;
            if (Object.getOwnPropertyDescriptor(projection, 'kind')?.value === 'unresolved') {
              return undefined;
            }
            const supplement = Object.getOwnPropertyDescriptor(
              projection,
              'supplement',
            )?.value as StructuralSupplement;
            return renderAdaptiveSnapshot(
              baseline.document,
              enriched.document.snapshotTree,
              enrichedNodes,
              supplement,
              policySet,
            );
          },
        );
        if (text === undefined) {
          emit(operation, 'projection-unresolved', 1);
          return visible;
        }
        const projected = cloneResultWithText(visible, baseline, text);
        emit(operation, 'projected', 1);
        return projected;
      } catch {
        emit(operation, 'projection-unresolved', 1);
        return visible;
      }
    });
  };

  const listTools = (...args: ListArguments): ReturnType<AdaptivePlaywrightRawClient['listTools']> => {
    if (policyRunning) return Promise.reject(new Error('Adaptive policy re-entry is forbidden.'));
    return gate.run(() => client.listTools(...args));
  };

  const dispose = (): Promise<void> => {
    if (policyRunning) return Promise.reject(new Error('Adaptive policy re-entry is forbidden.'));
    if (disposePromise !== undefined) return disposePromise;
    disposePromise = gate.dispose().then(() => {
      if (activeClientWrappers.get(client) === leaseToken) activeClientWrappers.delete(client);
    });
    return disposePromise;
  };

  const wrapped = Object.freeze({ callTool, listTools, dispose });
  activeClientWrappers.set(client, leaseToken);
  return wrapped;
}
