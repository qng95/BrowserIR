import { randomUUID } from 'node:crypto';

import {
  MAX_UNSAFE_EVALUATE_EXPRESSION_BYTES,
  MAX_UNSAFE_EVALUATE_EXPRESSION_CHARACTERS,
  MAX_UNSAFE_EVALUATE_OUTPUT_BYTES,
  MAX_UNSAFE_EVALUATE_TIMEOUT_MS,
  type DriverUnsafeEvaluateRequest,
  type DriverUnsafeEvaluateResult,
  type JsonValue,
} from '@browserir/core';
import type { CDPSession, Page } from 'playwright';

const MAX_SERIALIZATION_DEPTH = 8;
const MAX_SERIALIZATION_ENTRIES = 512;
const INTERRUPTION_CLEANUP_GRACE_MS = 750;
const TERMINATION_PHASE_GRACE_MS = 250;
const NORMAL_CLEANUP_GRACE_MS = 250;

type RemoteObject = {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  objectId?: string;
};

type RemoteProperty = {
  name: string;
  value?: RemoteObject;
  get?: RemoteObject;
  set?: RemoteObject;
  enumerable: boolean;
  isOwn?: boolean;
};

type EvaluationResponse = {
  result: RemoteObject;
  exceptionDetails?: unknown;
};

type UnsafeOutcome = DriverUnsafeEvaluateResult['outcome'];

type SerializationState = {
  remainingBytes: number;
  remainingEntries: number;
  activeIdentities: Set<number>;
};

type SerializationResult =
  | { outcome: 'completed'; value: JsonValue; outputBytes: number }
  | { outcome: 'serialization_failed' | 'output_too_large' };

class StableEvaluationError extends Error {
  constructor(readonly outcome: UnsafeOutcome) {
    super(outcome);
    this.name = 'StableEvaluationError';
  }
}

export interface UnsafeEvaluationContainmentController {
  /**
   * Must invalidate the logical browser synchronously before returning. The
   * returned promise is only for bounded best-effort physical cleanup.
   */
  invalidateBrowser(): { invalidated: true; cleanup: Promise<unknown> };
}

/**
 * Runs explicitly enabled arbitrary page code in Chromium's default world.
 *
 * The evaluated source never receives the serializer state. Its result is
 * retained behind a closure and exposed to Node only through bounded snapshots.
 */
export async function evaluateUnsafeInPlaywrightPage(
  page: Page,
  request: DriverUnsafeEvaluateRequest,
  containmentController?: UnsafeEvaluationContainmentController,
): Promise<DriverUnsafeEvaluateResult> {
  if (
    request.expression.length === 0 ||
    request.expression.length > MAX_UNSAFE_EVALUATE_EXPRESSION_CHARACTERS ||
    new TextEncoder().encode(request.expression).byteLength >
      MAX_UNSAFE_EVALUATE_EXPRESSION_BYTES ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > MAX_UNSAFE_EVALUATE_TIMEOUT_MS ||
    !Number.isSafeInteger(request.maxOutputBytes) ||
    request.maxOutputBytes < 1 ||
    request.maxOutputBytes > MAX_UNSAFE_EVALUATE_OUTPUT_BYTES
  ) {
    throw new RangeError(
      'Unsafe evaluation request exceeds the shared BrowserIR hard limits.',
    );
  }
  const isAborted = (): boolean => request.signal?.aborted ?? false;
  if (isAborted()) {
    return { dispatched: false, outcome: 'cancelled' };
  }
  const startedAt = performance.now();
  const deadlineAt = startedAt + request.timeoutMs;
  const objectGroup = `browserir_unsafe_${randomUUID()}`;
  let client: CDPSession | undefined;
  let dispatched = false;
  let evaluationAcknowledged = false;
  let deadlineExpired = false;
  let cancellationRequested = false;
  let interruptionOutcome: 'cancelled' | 'timed_out' | undefined;
  let cleanupDeadlineAt: number | undefined;
  let terminationAttempted = false;
  let terminationConfirmed = false;
  let terminationCommandSucceeded = false;
  let browserInvalidated = false;
  let terminationPromise: Promise<void> | undefined;
  let pipelineSettled = false;
  let pipelineTask:
    | Promise<
        | {
            status: 'fulfilled';
            value: DriverUnsafeEvaluateResult;
          }
        | { status: 'rejected'; error: unknown }
      >
    | undefined;
  let resolveInterruption: (() => void) | undefined;
  const interruption = new Promise<void>((resolve) => {
    resolveInterruption = resolve;
  });
  let result: DriverUnsafeEvaluateResult = {
    dispatched: false,
    outcome: 'serialization_failed',
    outputOmitted: true,
  };

  const attemptTermination = (): void => {
    cleanupDeadlineAt ??= performance.now() + INTERRUPTION_CLEANUP_GRACE_MS;
    if (
      !dispatched ||
      client === undefined ||
      terminationPromise !== undefined
    ) {
      return;
    }
    terminationAttempted = true;
    terminationPromise = client
      .send('Runtime.terminateExecution')
      .then(() => {
        terminationCommandSucceeded = true;
      })
      .catch(() => {});
  };

  const interrupt = (reason: 'timeout' | 'cancelled'): void => {
    if (reason === 'timeout') deadlineExpired = true;
    else cancellationRequested = true;
    if (interruptionOutcome === undefined) {
      interruptionOutcome = reason === 'timeout' ? 'timed_out' : 'cancelled';
      cleanupDeadlineAt = performance.now() + INTERRUPTION_CLEANUP_GRACE_MS;
      resolveInterruption?.();
    }
    attemptTermination();
  };

  const throwIfInterrupted = (): void => {
    if (cancellationRequested || isAborted()) {
      interrupt('cancelled');
      throw new StableEvaluationError(interruptionOutcome ?? 'cancelled');
    }
    if (deadlineExpired || performance.now() >= deadlineAt) {
      interrupt('timeout');
      throw new StableEvaluationError(interruptionOutcome ?? 'timed_out');
    }
  };

  const runPipeline = async (
    activeClient: CDPSession,
  ): Promise<DriverUnsafeEvaluateResult> => {
    throwIfInterrupted();
    const remainingTimeoutMs = Math.max(
      1,
      Math.ceil(deadlineAt - performance.now()),
    );
    const evaluationResponse = await activeClient.send('Runtime.evaluate', {
      expression: buildBoundedEvaluationExpression(request.expression),
      objectGroup,
      awaitPromise: true,
      returnByValue: false,
      generatePreview: false,
      silent: true,
      timeout: remainingTimeoutMs,
      disableBreaks: true,
      allowUnsafeEvalBlockedByCSP: true,
    });
    evaluationAcknowledged = true;
    const evaluation = evaluationResponse as EvaluationResponse;
    throwIfInterrupted();

    if (evaluation.exceptionDetails !== undefined) {
      return { dispatched: true, outcome: 'exception' };
    }
    if (evaluation.result.objectId === undefined) {
      return {
        dispatched: true,
        outcome: 'serialization_failed',
        outputOmitted: true,
      };
    }

    const sourceCompleted = await readSourceCompletion(
      activeClient,
      evaluation.result.objectId,
      throwIfInterrupted,
    );
    throwIfInterrupted();
    if (!sourceCompleted) {
      return { dispatched: true, outcome: 'exception' };
    }

    const serialized = await serializeRetainedResult(
      activeClient,
      evaluation.result.objectId,
      request.maxOutputBytes,
      throwIfInterrupted,
    );
    throwIfInterrupted();
    if (serialized.outcome === 'completed') {
      return {
        dispatched: true,
        outcome: 'completed',
        value: serialized.value,
        outputBytes: serialized.outputBytes,
      };
    }
    return {
      dispatched: true,
      outcome: serialized.outcome,
      outputOmitted: true,
    };
  };

  const onAbort = (): void => interrupt('cancelled');
  request.signal?.addEventListener('abort', onAbort, { once: true });
  const deadline = setTimeout(() => interrupt('timeout'), request.timeoutMs);

  try {
    const acquisitionTask = Promise.resolve().then(() =>
      page.context().newCDPSession(page),
    );
    const acquisition = await Promise.race([
      acquisitionTask.then(
        (acquired) => ({ kind: 'acquired' as const, client: acquired }),
        (error: unknown) => ({ kind: 'failed' as const, error }),
      ),
      interruption.then(() => ({ kind: 'interruption' as const })),
    ]);

    if (acquisition.kind === 'interruption') {
      void acquisitionTask.then(
        (lateClient) => lateClient.detach().catch(() => {}),
        () => {},
      );
      result = {
        dispatched: false,
        outcome: interruptionOutcome ?? 'timed_out',
      };
    } else if (acquisition.kind === 'failed') {
      result = { dispatched: false, outcome: 'context_destroyed' };
    } else {
      client = acquisition.client;
      throwIfInterrupted();
      dispatched = true;
      pipelineTask = runPipeline(client).then(
        (value): { status: 'fulfilled'; value: DriverUnsafeEvaluateResult } => {
          pipelineSettled = true;
          return { status: 'fulfilled' as const, value };
        },
        (error: unknown) => {
          pipelineSettled = true;
          return { status: 'rejected' as const, error };
        },
      );
      const first = await Promise.race([
        pipelineTask.then((pipeline) => ({
          kind: 'pipeline' as const,
          pipeline,
        })),
        interruption.then(() => ({ kind: 'interruption' as const })),
      ]);

      if (first.kind === 'interruption') {
        result = {
          dispatched: true,
          outcome: interruptionOutcome ?? 'timed_out',
        };
      } else if (first.pipeline.status === 'rejected') {
        throw first.pipeline.error;
      } else {
        result = first.pipeline.value;
      }
    }
  } catch (error) {
    if (
      dispatched &&
      !evaluationAcknowledged &&
      !page.isClosed()
    ) {
      // The command failed before Chromium acknowledged whether page code had
      // started. Preserve the stable error outcome, but contain conservatively.
      attemptTermination();
    }
    if (interruptionOutcome !== undefined) {
      result = { dispatched, outcome: interruptionOutcome };
    } else if (cancellationRequested || isAborted()) {
      interrupt('cancelled');
      result = { dispatched, outcome: interruptionOutcome ?? 'cancelled' };
    } else if (
      deadlineExpired ||
      performance.now() - startedAt >= request.timeoutMs ||
      isProtocolTimeout(error)
    ) {
      interrupt('timeout');
      result = { dispatched, outcome: interruptionOutcome ?? 'timed_out' };
    } else if (error instanceof StableEvaluationError) {
      result = {
        dispatched,
        outcome: error.outcome,
        ...(error.outcome === 'serialization_failed' ||
        error.outcome === 'output_too_large'
          ? { outputOmitted: true }
          : {}),
      };
    } else if (isContextDestroyed(error) || page.isClosed()) {
      result = { dispatched, outcome: 'context_destroyed' };
    } else {
      result = {
        dispatched,
        outcome: 'serialization_failed',
        outputOmitted: true,
      };
    }
  } finally {
    clearTimeout(deadline);
    request.signal?.removeEventListener('abort', onAbort);

    if (
      terminationAttempted &&
      pipelineTask !== undefined &&
      client !== undefined
    ) {
      const containmentDeadline =
        cleanupDeadlineAt ??
        performance.now() + INTERRUPTION_CLEANUP_GRACE_MS;
      const containment = await confirmExecutionContainment(
        page,
        terminationPromise,
        pipelineTask,
        () => terminationCommandSucceeded,
        () => pipelineSettled,
        containmentDeadline,
      );
      terminationConfirmed = containment === 'execution_terminated';
      if (containment === 'uncontained') {
        try {
          const invalidation = containmentController?.invalidateBrowser();
          if (invalidation?.invalidated === true) {
            browserInvalidated = true;
            await waitUntilDeadline(invalidation.cleanup, containmentDeadline);
          }
        } catch {
          // The receipt remains explicit that neither execution termination nor
          // logical browser invalidation could be confirmed.
        }
      }
    }

    if (client !== undefined) {
      const clientCleanupDeadline =
        cleanupDeadlineAt ?? performance.now() + NORMAL_CLEANUP_GRACE_MS;
      const release = client
        .send('Runtime.releaseObjectGroup', { objectGroup })
        .then(() => {}, () => {});
      await waitUntilDeadline(release, clientCleanupDeadline);
      const detach = client.detach().then(() => {}, () => {});
      await waitUntilDeadline(detach, clientCleanupDeadline);
    }
  }

  return withTerminationReceipt(
    browserInvalidated ? { ...result, browserInvalidated: true } : result,
    terminationAttempted,
    terminationConfirmed,
  );
}

function withTerminationReceipt(
  result: DriverUnsafeEvaluateResult,
  terminationAttempted: boolean,
  terminationConfirmed: boolean,
): DriverUnsafeEvaluateResult {
  return {
    ...result,
    ...(terminationAttempted ? { terminationAttempted: true } : {}),
    ...(terminationAttempted ? { terminationConfirmed } : {}),
  };
}

type ExecutionContainment =
  | 'execution_terminated'
  | 'target_closed'
  | 'uncontained';

async function confirmExecutionContainment(
  page: Page,
  terminationPromise: Promise<void> | undefined,
  pipelineTask: Promise<unknown>,
  terminationCommandSucceeded: () => boolean,
  pipelineSettled: () => boolean,
  cleanupDeadlineAt: number,
): Promise<ExecutionContainment> {
  if (page.isClosed()) return 'target_closed';

  const terminationDeadline = Math.min(
    cleanupDeadlineAt,
    performance.now() + TERMINATION_PHASE_GRACE_MS,
  );
  if (terminationPromise !== undefined) {
    await waitUntilDeadline(terminationPromise, terminationDeadline);
  }
  if (page.isClosed()) return 'target_closed';
  if (terminationCommandSucceeded()) {
    await waitUntilDeadline(pipelineTask, terminationDeadline);
    if (page.isClosed()) return 'target_closed';
    if (pipelineSettled()) return 'execution_terminated';
  }

  const close = Promise.resolve()
    .then(() => page.close({ runBeforeUnload: false }))
    .then(() => {}, () => {});
  await waitUntilDeadline(close, cleanupDeadlineAt);
  return page.isClosed() ? 'target_closed' : 'uncontained';
}

async function waitUntilDeadline(
  promise: Promise<unknown>,
  deadlineAt: number,
): Promise<boolean> {
  const remainingMs = Math.max(0, deadlineAt - performance.now());
  if (remainingMs === 0) {
    void promise.catch(() => {});
    return false;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), remainingMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function readSourceCompletion(
  client: CDPSession,
  stateObjectId: string,
  checkInterrupted: () => void,
): Promise<boolean> {
  checkInterrupted();
  const completion = await client.send('Runtime.callFunctionOn', {
    objectId: stateObjectId,
    functionDeclaration: 'function () { return this.completed(); }',
    returnByValue: true,
    silent: true,
  });
  checkInterrupted();
  if (completion.exceptionDetails !== undefined) {
    throw new StableEvaluationError('serialization_failed');
  }
  return completion.result.type === 'boolean' && completion.result.value === true;
}

async function serializeRetainedResult(
  client: CDPSession,
  stateObjectId: string,
  maxOutputBytes: number,
  checkInterrupted: () => void,
): Promise<SerializationResult> {
  checkInterrupted();
  const state: SerializationState = {
    remainingBytes: maxOutputBytes,
    remainingEntries: MAX_SERIALIZATION_ENTRIES,
    activeIdentities: new Set(),
  };
  const rootSnapshot = await client.send('Runtime.callFunctionOn', {
    objectId: stateObjectId,
    functionDeclaration: 'function (maxBytes) { return this.root(maxBytes); }',
    arguments: [{ value: maxOutputBytes }],
    returnByValue: false,
    generatePreview: false,
    silent: true,
  });
  checkInterrupted();
  if (
    rootSnapshot.exceptionDetails !== undefined ||
    rootSnapshot.result.objectId === undefined
  ) {
    return { outcome: 'serialization_failed' };
  }

  const root = await readSnapshotProperties(
    client,
    rootSnapshot.result.objectId,
    checkInterrupted,
  );
  const rootStatus = readString(root, 'status');
  if (rootStatus === 'output_limit') return { outcome: 'output_too_large' };
  if (rootStatus === 'invalid') return { outcome: 'serialization_failed' };
  if (rootStatus === 'primitive') {
    const value = readJsonPrimitive(readRemote(root, 'value'));
    const localBytes = readBoundedInteger(root, 'localBytes', maxOutputBytes);
    return { outcome: 'completed', value, outputBytes: localBytes };
  }
  if (rootStatus !== 'object') return { outcome: 'serialization_failed' };

  const rootValue = readRemote(root, 'value');
  const value = await serializeRemoteObject(
    client,
    stateObjectId,
    rootValue,
    state,
    0,
    checkInterrupted,
  );
  checkInterrupted();
  return {
    outcome: 'completed',
    value,
    outputBytes: maxOutputBytes - state.remainingBytes,
  };
}

async function serializeRemoteObject(
  client: CDPSession,
  stateObjectId: string,
  remote: RemoteObject,
  state: SerializationState,
  depth: number,
  checkInterrupted: () => void,
): Promise<JsonValue> {
  checkInterrupted();
  if (depth > MAX_SERIALIZATION_DEPTH) {
    throw new StableEvaluationError('serialization_failed');
  }
  if (
    remote.type !== 'object' ||
    remote.objectId === undefined ||
    remote.subtype === 'null' ||
    remote.subtype === 'proxy' ||
    remote.subtype === 'node' ||
    (remote.subtype !== undefined && remote.subtype !== 'array') ||
    (remote.subtype === undefined && remote.className !== 'Object')
  ) {
    throw new StableEvaluationError('serialization_failed');
  }

  const snapshot = await client.send('Runtime.callFunctionOn', {
    objectId: stateObjectId,
    functionDeclaration:
      'function (value, maxEntries, maxBytes) { return this.snapshot(value, maxEntries, maxBytes); }',
    arguments: [
      { objectId: remote.objectId },
      { value: state.remainingEntries },
      { value: state.remainingBytes },
    ],
    returnByValue: false,
    generatePreview: false,
    silent: true,
  });
  checkInterrupted();
  if (
    snapshot.exceptionDetails !== undefined ||
    snapshot.result.objectId === undefined
  ) {
    throw new StableEvaluationError('serialization_failed');
  }

  const properties = await readSnapshotProperties(
    client,
    snapshot.result.objectId,
    checkInterrupted,
  );
  const status = readString(properties, 'status');
  if (status === 'output_limit') {
    throw new StableEvaluationError('output_too_large');
  }
  if (status !== 'ok') {
    throw new StableEvaluationError('serialization_failed');
  }

  const count = readBoundedInteger(
    properties,
    'count',
    state.remainingEntries,
  );
  const localBytes = readBoundedInteger(
    properties,
    'localBytes',
    state.remainingBytes,
  );
  const identity = readBoundedInteger(
    properties,
    'identity',
    Number.MAX_SAFE_INTEGER,
  );
  if (state.activeIdentities.has(identity)) {
    throw new StableEvaluationError('serialization_failed');
  }

  state.remainingEntries -= count;
  state.remainingBytes -= localBytes;
  state.activeIdentities.add(identity);
  try {
    const kind = readString(properties, 'kind');
    if (kind === 'array') {
      const output: JsonValue[] = [];
      for (let index = 0; index < count; index += 1) {
        checkInterrupted();
        output.push(
          await serializeSnapshotValue(
            client,
            stateObjectId,
            readRemote(properties, `value${index}`),
            state,
            depth + 1,
            checkInterrupted,
          ),
        );
      }
      return output;
    }
    if (kind === 'object') {
      const output: { [key: string]: JsonValue } = Object.create(null);
      for (let index = 0; index < count; index += 1) {
        checkInterrupted();
        const key = readString(properties, `key${index}`);
        output[key] = await serializeSnapshotValue(
          client,
          stateObjectId,
          readRemote(properties, `value${index}`),
          state,
          depth + 1,
          checkInterrupted,
        );
      }
      return output;
    }
    throw new StableEvaluationError('serialization_failed');
  } finally {
    state.activeIdentities.delete(identity);
  }
}

async function serializeSnapshotValue(
  client: CDPSession,
  stateObjectId: string,
  remote: RemoteObject,
  state: SerializationState,
  depth: number,
  checkInterrupted: () => void,
): Promise<JsonValue> {
  checkInterrupted();
  if (depth > MAX_SERIALIZATION_DEPTH) {
    throw new StableEvaluationError('serialization_failed');
  }
  if (remote.type === 'object' && remote.subtype !== 'null') {
    return serializeRemoteObject(
      client,
      stateObjectId,
      remote,
      state,
      depth,
      checkInterrupted,
    );
  }
  return readJsonPrimitive(remote);
}

async function readSnapshotProperties(
  client: CDPSession,
  objectId: string,
  checkInterrupted: () => void,
): Promise<Map<string, RemoteProperty>> {
  checkInterrupted();
  const response = await client.send('Runtime.getProperties', {
    objectId,
    ownProperties: true,
    accessorPropertiesOnly: false,
    generatePreview: false,
  });
  checkInterrupted();
  if (response.exceptionDetails !== undefined) {
    throw new StableEvaluationError('serialization_failed');
  }
  const properties = new Map<string, RemoteProperty>();
  for (const descriptor of response.result) {
    if (descriptor.isOwn === false) continue;
    if (
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.value === undefined
    ) {
      throw new StableEvaluationError('serialization_failed');
    }
    properties.set(descriptor.name, descriptor);
  }
  return properties;
}

function readRemote(
  properties: Map<string, RemoteProperty>,
  name: string,
): RemoteObject {
  const value = properties.get(name)?.value;
  if (value === undefined) {
    throw new StableEvaluationError('serialization_failed');
  }
  return value;
}

function readString(
  properties: Map<string, RemoteProperty>,
  name: string,
): string {
  const remote = readRemote(properties, name);
  if (remote.type !== 'string' || typeof remote.value !== 'string') {
    throw new StableEvaluationError('serialization_failed');
  }
  return remote.value;
}

function readBoundedInteger(
  properties: Map<string, RemoteProperty>,
  name: string,
  maximum: number,
): number {
  const remote = readRemote(properties, name);
  if (
    remote.type !== 'number' ||
    typeof remote.value !== 'number' ||
    !Number.isSafeInteger(remote.value) ||
    remote.value < 0 ||
    remote.value > maximum
  ) {
    throw new StableEvaluationError('serialization_failed');
  }
  return remote.value;
}

function readJsonPrimitive(remote: RemoteObject): JsonValue {
  if (remote.type === 'object' && remote.subtype === 'null') return null;
  if (remote.type === 'string' && typeof remote.value === 'string') {
    return remote.value;
  }
  if (remote.type === 'boolean' && typeof remote.value === 'boolean') {
    return remote.value;
  }
  if (remote.type === 'number') {
    if (remote.unserializableValue === '-0') return 0;
    if (typeof remote.value === 'number' && Number.isFinite(remote.value)) {
      return remote.value;
    }
  }
  throw new StableEvaluationError('serialization_failed');
}

function isProtocolTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed?\s*out|execution was terminated|script execution timed out/i.test(
    message,
  );
}

function isContextDestroyed(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /execution context (?:was )?destroyed|cannot find context|target .*closed|session closed|page .*closed|browser .*closed|inspected target navigated/i.test(
    message,
  );
}

function buildBoundedEvaluationExpression(expression: string): string {
  const encodedSource = JSON.stringify(expression)
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  return `(() => {
    const safeEval = eval;
    const safeApply = Reflect.apply;
    const safeOwnKeys = Reflect.ownKeys;
    const safeGetPrototypeOf = Object.getPrototypeOf;
    const safeGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
    const safeCreate = Object.create;
    const safeDefineProperty = Object.defineProperty;
    const safeIsArray = Array.isArray;
    const safeIsFinite = Number.isFinite;
    const safeIsSafeInteger = Number.isSafeInteger;
    const safeJsonStringify = JSON.stringify;
    const safeCharCodeAt = String.prototype.charCodeAt;
    const safeWeakMapGet = WeakMap.prototype.get;
    const safeWeakMapSet = WeakMap.prototype.set;
    const objectPrototype = Object.prototype;
    const arrayPrototype = Array.prototype;
    const identities = new WeakMap();
    let nextIdentity = 0;

    const utf8Bytes = (text) => {
      let bytes = 0;
      for (let index = 0; index < text.length; index += 1) {
        const code = safeApply(safeCharCodeAt, text, [index]);
        if (code < 0x80) bytes += 1;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
          const next = safeApply(safeCharCodeAt, text, [index + 1]);
          if (next >= 0xdc00 && next <= 0xdfff) {
            bytes += 4;
            index += 1;
          } else bytes += 3;
        } else bytes += 3;
      }
      return bytes;
    };
    const jsonBytes = (value) => {
      const encoded = safeJsonStringify(value);
      return typeof encoded === 'string' ? utf8Bytes(encoded) : -1;
    };
    const make = () => safeCreate(null);
    const put = (target, key, value) => {
      safeDefineProperty(target, key, {
        value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    };
    const status = (name) => {
      const result = make();
      put(result, 'status', name);
      return result;
    };
    const primitiveKind = (value) => {
      if (value === null) return true;
      const kind = typeof value;
      return kind === 'string' || kind === 'boolean' ||
        (kind === 'number' && safeIsFinite(value));
    };
    const transferableKind = (value) =>
      primitiveKind(value) || (typeof value === 'object' && value !== null);
    const identityOf = (value) => {
      let identity = safeApply(safeWeakMapGet, identities, [value]);
      if (identity === undefined) {
        identity = ++nextIdentity;
        safeApply(safeWeakMapSet, identities, [value, identity]);
      }
      return identity;
    };

    const state = make();
    let sourceCompleted = false;
    let retainedValue;

    const root = (maxBytes) => {
      if (!sourceCompleted) return status('invalid');
      if (typeof retainedValue === 'object' && retainedValue !== null) {
        const result = status('object');
        put(result, 'value', retainedValue);
        return result;
      }
      if (!primitiveKind(retainedValue)) return status('invalid');
      const localBytes = jsonBytes(retainedValue);
      if (localBytes < 0) return status('invalid');
      if (localBytes > maxBytes) return status('output_limit');
      const result = status('primitive');
      put(result, 'value', retainedValue);
      put(result, 'localBytes', localBytes);
      return result;
    };

    const snapshot = (value, maxEntries, maxBytes) => {
      if (typeof value !== 'object' || value === null) return status('invalid');
      let isArray;
      let prototype;
      let keys;
      let descriptors;
      try {
        isArray = safeIsArray(value);
        prototype = safeGetPrototypeOf(value);
        if (prototype !== (isArray ? arrayPrototype : objectPrototype) &&
            !(prototype === null && !isArray)) return status('invalid');
        keys = safeOwnKeys(value);
        descriptors = safeGetOwnPropertyDescriptors(value);
      } catch {
        return status('invalid');
      }

      const entries = [];
      if (isArray) {
        const lengthDescriptor = descriptors.length;
        const length = lengthDescriptor?.value;
        if (!safeIsSafeInteger(length) || length < 0 || length > maxEntries) {
          return status('entry_limit');
        }
        for (const key of keys) {
          if (typeof key !== 'string') return status('invalid');
          const descriptor = descriptors[key];
          if (descriptor === undefined || descriptor.get !== undefined ||
              descriptor.set !== undefined || !('value' in descriptor)) {
            return status('invalid');
          }
          if (key === 'length') continue;
          if (!descriptor.enumerable || !/^(?:0|[1-9]\\d*)$/.test(key) ||
              Number(key) >= length) return status('invalid');
        }
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !descriptor.enumerable ||
              descriptor.get !== undefined || descriptor.set !== undefined ||
              !('value' in descriptor) || !transferableKind(descriptor.value)) {
            return status('invalid');
          }
          entries[index] = ['', descriptor.value];
        }
      } else {
        for (const key of keys) {
          if (typeof key !== 'string') return status('invalid');
          const descriptor = descriptors[key];
          if (descriptor === undefined || descriptor.get !== undefined ||
              descriptor.set !== undefined || !('value' in descriptor)) {
            return status('invalid');
          }
          if (!descriptor.enumerable) continue;
          if (!transferableKind(descriptor.value)) return status('invalid');
          entries[entries.length] = [key, descriptor.value];
          if (entries.length > maxEntries) return status('entry_limit');
        }
      }

      let localBytes = 2 + Math.max(0, entries.length - 1);
      for (const entry of entries) {
        if (!isArray) {
          const keyBytes = jsonBytes(entry[0]);
          if (keyBytes < 0) return status('invalid');
          localBytes += keyBytes + 1;
        }
        if (primitiveKind(entry[1])) {
          const valueBytes = jsonBytes(entry[1]);
          if (valueBytes < 0) return status('invalid');
          localBytes += valueBytes;
        }
        if (localBytes > maxBytes) return status('output_limit');
      }

      const result = status('ok');
      put(result, 'kind', isArray ? 'array' : 'object');
      put(result, 'identity', identityOf(value));
      put(result, 'count', entries.length);
      put(result, 'localBytes', localBytes);
      for (let index = 0; index < entries.length; index += 1) {
        if (!isArray) put(result, 'key' + index, entries[index][0]);
        put(result, 'value' + index, entries[index][1]);
      }
      return result;
    };

    put(state, 'completed', () => sourceCompleted);
    put(state, 'root', root);
    put(state, 'snapshot', snapshot);

    return (async () => {
      try {
        retainedValue = await (0, safeEval)(${encodedSource});
        sourceCompleted = true;
      } catch {
        sourceCompleted = false;
      }
      return state;
    })();
  })()`;
}
