import type {
  BrowserDriverSession,
  DriverUnsafeEvaluateRequest,
  DriverUnsafeEvaluateResult,
} from '@browserir/core';
import {
  MAX_UNSAFE_EVALUATE_EXPRESSION_CHARACTERS,
  MAX_UNSAFE_EVALUATE_OUTPUT_BYTES,
  MAX_UNSAFE_EVALUATE_TIMEOUT_MS,
} from '@browserir/core';
import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';

import { createPlaywrightBrowserDriver } from '../src/index.js';
import { evaluateUnsafeInPlaywrightPage } from '../src/unsafe-evaluate.js';

const sessions: BrowserDriverSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => {})));
});

async function createSession(): Promise<BrowserDriverSession> {
  const session = await createPlaywrightBrowserDriver().createSession();
  sessions.push(session);
  await session.navigate({
    pageId: session.initialPageId,
    url: 'data:text/html,<title>Unsafe evaluation fixture</title><main><p>Ready</p></main>',
  });
  expect(session.evaluateUnsafe).toBeTypeOf('function');
  return session;
}

async function evaluate(
  session: BrowserDriverSession,
  input: Omit<DriverUnsafeEvaluateRequest, 'pageId'>,
): Promise<DriverUnsafeEvaluateResult> {
  if (session.evaluateUnsafe === undefined) {
    throw new Error('Playwright driver did not expose unsafe evaluation.');
  }
  return session.evaluateUnsafe({ pageId: session.initialPageId, ...input });
}

async function expectRecoveredOrClosed(
  session: BrowserDriverSession,
  result: DriverUnsafeEvaluateResult,
): Promise<void> {
  const pages = await session.pages();
  const targetStillExists = pages.some(
    (page) => page.pageId === session.initialPageId,
  );
  if (result.terminationConfirmed === true) {
    expect(targetStillExists).toBe(true);
    const observation = await session.observe({ pageId: session.initialPageId });
    expect(observation.title).toBe('Unsafe evaluation fixture');
  } else {
    expect(targetStillExists).toBe(false);
  }
}

type AsyncBehavior = 'resolve' | 'reject' | 'stall';

function createSerializationStall(options: {
  rejectEvaluation?: boolean;
  terminate?: AsyncBehavior;
  close?: AsyncBehavior;
  release?: AsyncBehavior;
  detach?: AsyncBehavior;
  closeTargetOnTerminate?: boolean;
} = {}): {
  page: Page;
  serializationStarted: Promise<void>;
  wasClosed(): boolean;
  closeAttempts(): number;
} {
  let closed = false;
  let closeAttempts = 0;
  let markSerializationStarted: (() => void) | undefined;
  const serializationStarted = new Promise<void>((resolve) => {
    markSerializationStarted = resolve;
  });
  let rejectSerialization: ((error: Error) => void) | undefined;
  const stalled = new Promise<never>((_resolve, reject) => {
    rejectSerialization = reject;
  });
  const behavior = async (selected: AsyncBehavior, name: string): Promise<unknown> => {
    if (selected === 'stall') return new Promise<never>(() => {});
    if (selected === 'reject') throw new Error(`${name} failed`);
    return {};
  };
  const client = {
    async send(method: string): Promise<unknown> {
      if (method === 'Runtime.evaluate') {
        if (options.rejectEvaluation === true) {
          throw new Error('unexpected CDP transport failure');
        }
        return { result: { type: 'object', objectId: 'retained-state' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        markSerializationStarted?.();
        return stalled;
      }
      if (method === 'Runtime.terminateExecution') {
        if (options.closeTargetOnTerminate === true) {
          closed = true;
          rejectSerialization?.(new Error('Target closed'));
        }
        return behavior(options.terminate ?? 'resolve', 'terminate');
      }
      if (method === 'Runtime.releaseObjectGroup') {
        return behavior(options.release ?? 'resolve', 'release');
      }
      throw new Error(`Unexpected fake CDP method ${method}.`);
    },
    async detach(): Promise<void> {
      await behavior(options.detach ?? 'resolve', 'detach');
    },
  };
  const page = {
    context() {
      return {
        async newCDPSession(): Promise<typeof client> {
          return client;
        },
      };
    },
    isClosed(): boolean {
      return closed;
    },
    async close(): Promise<void> {
      closeAttempts += 1;
      await behavior(options.close ?? 'resolve', 'close');
      closed = true;
    },
  } as unknown as Page;
  return {
    page,
    serializationStarted,
    wasClosed: () => closed,
    closeAttempts: () => closeAttempts,
  };
}

function createAcquisitionStall(): { page: Page; acquisitionStarted: Promise<void> } {
  let markAcquisitionStarted: (() => void) | undefined;
  const acquisitionStarted = new Promise<void>((resolve) => {
    markAcquisitionStarted = resolve;
  });
  const page = {
    context() {
      return {
        async newCDPSession(): Promise<never> {
          markAcquisitionStarted?.();
          return new Promise<never>(() => {});
        },
      };
    },
    isClosed(): boolean {
      return false;
    },
  } as unknown as Page;
  return { page, acquisitionStarted };
}

function createBrowserInvalidation(cleanup: AsyncBehavior = 'resolve') {
  let invalidated = false;
  let calls = 0;
  return {
    controller: {
      invalidateBrowser() {
        calls += 1;
        invalidated = true;
        const cleanupPromise =
          cleanup === 'stall'
            ? new Promise<never>(() => {})
            : cleanup === 'reject'
              ? Promise.reject(new Error('browser cleanup failed'))
              : Promise.resolve();
        return { invalidated: true as const, cleanup: cleanupPromise };
      },
    },
    wasInvalidated: () => invalidated,
    calls: () => calls,
  };
}

async function settleWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Unsafe evaluation did not settle within its bounded grace period.')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describe('bounded unsafe Playwright evaluation', () => {
  it('rejects requests outside the shared hard limits before dispatch', async () => {
    const session = await createSession();
    for (const overrides of [
      { expression: '' },
      { expression: 'x'.repeat(MAX_UNSAFE_EVALUATE_EXPRESSION_CHARACTERS + 1) },
      { expression: '€'.repeat(10_923) },
      { timeoutMs: MAX_UNSAFE_EVALUATE_TIMEOUT_MS + 1 },
      { maxOutputBytes: MAX_UNSAFE_EVALUATE_OUTPUT_BYTES + 1 },
    ]) {
      await expect(
        evaluate(session, {
          expression: '1 + 1',
          timeoutMs: 500,
          maxOutputBytes: 1024,
          ...overrides,
        }),
      ).rejects.toThrow(/hard limits/i);
    }
    const observation = await session.observe({ pageId: session.initialPageId });
    expect(observation.title).toBe('Unsafe evaluation fixture');
  });

  it('returns JSON-compatible primitives, arrays, and plain own-data objects', async () => {
    const session = await createSession();

    const result = await evaluate(session, {
      expression:
        '({ customer: "Ada", count: 3, active: true, tags: ["fleet", null] })',
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
    });

    expect(result).toEqual({
      dispatched: true,
      outcome: 'completed',
      value: {
        customer: 'Ada',
        count: 3,
        active: true,
        tags: ['fleet', null],
      },
      outputBytes: Buffer.byteLength(
        JSON.stringify({
          customer: 'Ada',
          count: 3,
          active: true,
          tags: ['fleet', null],
        }),
      ),
    });
  });

  it('allows deliberate DOM mutation and leaves the page observable', async () => {
    const session = await createSession();

    const result = await evaluate(session, {
      expression:
        '(() => { document.querySelector("main").innerHTML = "<button>Save customer</button>"; return { changed: true }; })()',
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
    });
    const observation = await session.observe({ pageId: session.initialPageId });

    expect(result).toMatchObject({
      dispatched: true,
      outcome: 'completed',
      value: { changed: true },
    });
    expect(observation.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Save customer', role: 'button' }),
      ]),
    );
  });

  it('does not expose thrown messages, source, or stacks', async () => {
    const session = await createSession();
    const secret = 'BROWSERIR_EXCEPTION_SECRET_7f41';
    const source = `(() => { throw new Error(${JSON.stringify(secret)}); })()`;

    const result = await evaluate(session, {
      expression: source,
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
    });
    const encoded = JSON.stringify(result);

    expect(result).toEqual({ dispatched: true, outcome: 'exception' });
    expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain(source);
    expect(encoded).not.toMatch(/stack/i);
  });

  it('rejects cycles without returning any part of the value', async () => {
    const session = await createSession();
    const result = await evaluate(session, {
      expression: '(() => { const value = {}; value.self = value; return value; })()',
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
    });

    expect(result).toEqual({
      dispatched: true,
      outcome: 'serialization_failed',
      outputOmitted: true,
    });
  });

  it('rejects accessors without invoking them', async () => {
    const session = await createSession();
    const rejected = await evaluate(session, {
      expression: `(() => {
        globalThis.__browserirGetterRuns = 0;
        const value = {};
        Object.defineProperty(value, 'secret', {
          enumerable: true,
          get() {
            globalThis.__browserirGetterRuns += 1;
            return 'must-not-be-read';
          }
        });
        return value;
      })()`,
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
    });
    const getterRuns = await evaluate(session, {
      expression: 'globalThis.__browserirGetterRuns',
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
    });

    expect(rejected).toMatchObject({
      outcome: 'serialization_failed',
      outputOmitted: true,
    });
    expect(getterRuns).toMatchObject({ outcome: 'completed', value: 0 });
  });

  it('rejects proxies before invoking their traps', async () => {
    const session = await createSession();
    const rejected = await evaluate(session, {
      expression: `(() => {
        globalThis.__browserirProxyTrapRuns = 0;
        return new Proxy({}, {
          ownKeys() {
            globalThis.__browserirProxyTrapRuns += 1;
            return [];
          }
        });
      })()`,
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
    });
    const trapRuns = await evaluate(session, {
      expression: 'globalThis.__browserirProxyTrapRuns',
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
    });

    expect(rejected).toMatchObject({
      outcome: 'serialization_failed',
      outputOmitted: true,
    });
    expect(trapRuns).toMatchObject({ outcome: 'completed', value: 0 });
  });

  it('rejects DOM nodes and oversized primitive output without transferring it', async () => {
    const session = await createSession();
    const nodeResult = await evaluate(session, {
      expression: 'document.body',
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
    });
    const marker = 'BROWSERIR_OVERSIZED_SECRET_2d3a';
    const oversized = await evaluate(session, {
      expression: `${JSON.stringify(marker)}.repeat(100)`,
      timeoutMs: 2_000,
      maxOutputBytes: 64,
    });

    expect(nodeResult).toEqual({
      dispatched: true,
      outcome: 'serialization_failed',
      outputOmitted: true,
    });
    expect(oversized).toEqual({
      dispatched: true,
      outcome: 'output_too_large',
      outputOmitted: true,
    });
    expect(JSON.stringify(oversized)).not.toContain(marker);
  });

  it('enforces the fixed depth and total-entry limits', async () => {
    const session = await createSession();
    const tooDeep = await evaluate(session, {
      expression: `(() => {
        let value = 'leaf';
        for (let index = 0; index < 9; index += 1) value = { child: value };
        return value;
      })()`,
      timeoutMs: 2_000,
      maxOutputBytes: 64_000,
    });
    const tooManyEntries = await evaluate(session, {
      expression:
        'Object.fromEntries(Array.from({ length: 513 }, (_, index) => ["field" + index, index]))',
      timeoutMs: 2_000,
      maxOutputBytes: 64_000,
    });

    expect(tooDeep).toMatchObject({
      outcome: 'serialization_failed',
      outputOmitted: true,
    });
    expect(tooManyEntries).toMatchObject({
      outcome: 'serialization_failed',
      outputOmitted: true,
    });
  });

  it('terminates a synchronous infinite loop at the protocol deadline', async () => {
    const session = await createSession();
    const startedAt = performance.now();
    const result = await evaluate(session, {
      expression: '(() => { for (;;) {} })()',
      timeoutMs: 150,
      maxOutputBytes: 4_096,
    });

    expect(result).toMatchObject({
      dispatched: true,
      outcome: 'timed_out',
      terminationAttempted: true,
    });
    expect(performance.now() - startedAt).toBeLessThan(3_000);
    await expectRecoveredOrClosed(session, result);
  });

  it('terminates a never-settling promise at the protocol deadline', async () => {
    const session = await createSession();
    const result = await evaluate(session, {
      expression: 'new Promise(() => {})',
      timeoutMs: 150,
      maxOutputBytes: 4_096,
    });

    expect(result).toMatchObject({
      dispatched: true,
      outcome: 'timed_out',
      terminationAttempted: true,
    });
    await expectRecoveredOrClosed(session, result);
  });

  it('uses AbortSignal to terminate a never-settling promise', async () => {
    const session = await createSession();
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), 75);
    try {
      const result = await evaluate(session, {
        expression: 'new Promise(() => {})',
        timeoutMs: 2_000,
        maxOutputBytes: 4_096,
        signal: controller.signal,
      });

      expect(result).toMatchObject({
        dispatched: true,
        outcome: 'cancelled',
        terminationAttempted: true,
      });
      await expectRecoveredOrClosed(session, result);
    } finally {
      clearTimeout(abort);
    }
  });

  it('applies the deadline to a stalled post-execution serialization step', async () => {
    const fixture = createSerializationStall();
    const result = await settleWithin(
      evaluateUnsafeInPlaywrightPage(fixture.page, {
        pageId: 'page_test',
        expression: '({ answer: 42 })',
        timeoutMs: 25,
        maxOutputBytes: 4_096,
      }),
      1_200,
    );

    expect(result).toMatchObject({
      dispatched: true,
      outcome: 'timed_out',
      terminationAttempted: true,
      terminationConfirmed: false,
    });
    expect(fixture.wasClosed()).toBe(true);
  });

  it('applies cancellation to a stalled post-execution serialization step', async () => {
    const fixture = createSerializationStall();
    const controller = new AbortController();
    const evaluation = evaluateUnsafeInPlaywrightPage(fixture.page, {
      pageId: 'page_test',
      expression: '({ answer: 42 })',
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
      signal: controller.signal,
    });
    await fixture.serializationStarted;
    controller.abort();
    const result = await settleWithin(evaluation, 1_200);

    expect(result).toMatchObject({
      dispatched: true,
      outcome: 'cancelled',
      terminationAttempted: true,
      terminationConfirmed: false,
    });
    expect(fixture.wasClosed()).toBe(true);
  });

  it('starts the deadline before CDP-session acquisition', async () => {
    const fixture = createAcquisitionStall();
    const result = await settleWithin(
      evaluateUnsafeInPlaywrightPage(fixture.page, {
        pageId: 'page_test',
        expression: '1 + 1',
        timeoutMs: 25,
        maxOutputBytes: 4_096,
      }),
      500,
    );

    expect(result).toEqual({ dispatched: false, outcome: 'timed_out' });
  });

  it('applies cancellation while CDP-session acquisition is stalled', async () => {
    const fixture = createAcquisitionStall();
    const controller = new AbortController();
    const evaluation = evaluateUnsafeInPlaywrightPage(fixture.page, {
      pageId: 'page_test',
      expression: '1 + 1',
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
      signal: controller.signal,
    });
    await fixture.acquisitionStarted;
    controller.abort();

    await expect(settleWithin(evaluation, 500)).resolves.toEqual({
      dispatched: false,
      outcome: 'cancelled',
    });
  });

  it('invalidates the owned browser when termination and target closure both fail', async () => {
    const fixture = createSerializationStall({
      terminate: 'reject',
      close: 'reject',
    });
    const invalidation = createBrowserInvalidation();
    const result = await settleWithin(
      evaluateUnsafeInPlaywrightPage(
        fixture.page,
        {
          pageId: 'page_test',
          expression: '({ answer: 42 })',
          timeoutMs: 25,
          maxOutputBytes: 4_096,
        },
        invalidation.controller,
      ),
      1_200,
    );

    expect(result).toMatchObject({
      dispatched: true,
      outcome: 'timed_out',
      terminationAttempted: true,
      terminationConfirmed: false,
      browserInvalidated: true,
    });
    expect(fixture.wasClosed()).toBe(false);
    expect(invalidation.wasInvalidated()).toBe(true);
    expect(invalidation.calls()).toBe(1);
  });

  it('shares one bounded cleanup deadline across stalled containment operations', async () => {
    const fixture = createSerializationStall({
      terminate: 'stall',
      close: 'stall',
      release: 'stall',
      detach: 'stall',
    });
    const invalidation = createBrowserInvalidation('stall');
    const startedAt = performance.now();
    const result = await settleWithin(
      evaluateUnsafeInPlaywrightPage(
        fixture.page,
        {
          pageId: 'page_test',
          expression: '({ answer: 42 })',
          timeoutMs: 25,
          maxOutputBytes: 4_096,
        },
        invalidation.controller,
      ),
      1_200,
    );

    expect(performance.now() - startedAt).toBeLessThan(1_200);
    expect(result).toMatchObject({
      outcome: 'timed_out',
      terminationConfirmed: false,
      browserInvalidated: true,
    });
    expect(fixture.closeAttempts()).toBe(1);
    expect(invalidation.wasInvalidated()).toBe(true);
  });

  it('never confirms execution termination after the target closes concurrently', async () => {
    const fixture = createSerializationStall({ closeTargetOnTerminate: true });
    const result = await settleWithin(
      evaluateUnsafeInPlaywrightPage(fixture.page, {
        pageId: 'page_test',
        expression: '({ answer: 42 })',
        timeoutMs: 25,
        maxOutputBytes: 4_096,
      }),
      1_200,
    );

    expect(result).toMatchObject({
      outcome: 'timed_out',
      terminationAttempted: true,
      terminationConfirmed: false,
    });
    expect(fixture.wasClosed()).toBe(true);
  });

  it('contains an unacknowledged evaluation after a generic CDP rejection', async () => {
    const fixture = createSerializationStall({
      rejectEvaluation: true,
      terminate: 'reject',
    });
    const result = await settleWithin(
      evaluateUnsafeInPlaywrightPage(fixture.page, {
        pageId: 'page_test',
        expression: 'globalThis.maybeStarted = true',
        timeoutMs: 2_000,
        maxOutputBytes: 4_096,
      }),
      1_200,
    );

    expect(result).toMatchObject({
      dispatched: true,
      outcome: 'serialization_failed',
      terminationAttempted: true,
      terminationConfirmed: false,
    });
    expect(fixture.wasClosed()).toBe(true);
    expect(fixture.closeAttempts()).toBe(1);
  });
});
