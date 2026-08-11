import { describe, expect, it } from 'vitest';

import {
  BrowserIRRuntime,
  MAX_CAPTURE_BYTES,
  MAX_CAPTURE_PHYSICAL_PIXELS,
  MAX_UNSAFE_EVALUATE_EXPRESSION_CHARACTERS,
  MAX_UNSAFE_EVALUATE_OUTPUT_BYTES,
  MAX_UNSAFE_EVALUATE_TIMEOUT_MS,
  compileView,
  type BrowserAction,
  type BrowserCreateOptions,
  type BrowserDriver,
  type BrowserDriverSession,
  type CaptureResult,
  type DriverActionRequest,
  type DriverActionResult,
  type DriverCaptureRequest,
  type DriverUnsafeEvaluateRequest,
  type DriverUnsafeEvaluateResult,
  type DriverNavigateRequest,
  type DriverObservation,
  type DriverObserveRequest,
  type DriverObservedEntity,
  type DriverObservedRelation,
  type EntityRef,
  type GraphSnapshot,
  type DriverPage,
  type ResolvedAction,
} from '../src/index.js';

const observedEntity = (
  identityKey: string,
  sourceId: string,
  overrides: Partial<DriverObservedEntity> = {},
): DriverObservedEntity => ({
  sourceId,
  identityKey,
  target: { opaqueId: `target:${sourceId}` },
  kind: 'control',
  role: 'button',
  name: identityKey,
  state: { visible: true, enabled: true },
  capabilities: [{ kind: 'click' }],
  ...overrides,
});

const observation = (
  entities: DriverObservedEntity[],
  overrides: Partial<DriverObservation> = {},
): DriverObservation => ({
  pageId: 'page-1',
  url: 'https://fixture.test/app',
  title: 'Fixture',
  capturedAt: 1,
  entities,
  ...overrides,
});

const sourceRelation = (
  fromSourceId: string,
  toSourceId: string,
  kind: DriverObservedRelation['kind'],
): DriverObservedRelation =>
  ({
    fromSourceId,
    toSourceId,
    kind,
  }) as unknown as DriverObservedRelation;

class FakeSession implements BrowserDriverSession {
  readonly browserId = 'browser-1';
  readonly initialPageId = 'page-1';
  current: DriverObservation;
  readonly actions: ResolvedAction[] = [];
  readonly navigations: DriverNavigateRequest[] = [];
  readonly evaluations: DriverUnsafeEvaluateRequest[] = [];
  closeCalls = 0;
  onAct?: (request: DriverActionRequest) => void;
  onEvaluate?: (
    request: DriverUnsafeEvaluateRequest,
  ) => DriverUnsafeEvaluateResult | Promise<DriverUnsafeEvaluateResult>;
  observeError?: Error;

  constructor(current: DriverObservation) {
    this.current = current;
  }

  async navigate(request: DriverNavigateRequest): Promise<DriverObservation> {
    this.navigations.push(request);
    this.current = { ...this.current, pageId: request.pageId, url: request.url };
    return this.current;
  }

  async observe(_request: DriverObserveRequest): Promise<DriverObservation> {
    if (this.observeError !== undefined) throw this.observeError;
    return this.current;
  }

  async act(request: DriverActionRequest): Promise<DriverActionResult> {
    this.actions.push(request.action);
    this.onAct?.(request);
    return { dispatched: true };
  }

  async evaluateUnsafe(
    request: DriverUnsafeEvaluateRequest,
  ): Promise<DriverUnsafeEvaluateResult> {
    this.evaluations.push(request);
    return (
      (await this.onEvaluate?.(request)) ?? {
        dispatched: true,
        outcome: 'completed',
        value: null,
        outputBytes: 4,
      }
    );
  }

  async pages(): Promise<DriverPage[]> {
    return [
      {
        pageId: this.current.pageId,
        url: this.current.url,
        ...(this.current.title === undefined ? {} : { title: this.current.title }),
      },
    ];
  }

  async capture(_request: DriverCaptureRequest): Promise<CaptureResult> {
    return {
      pageId: this.current.pageId,
      mediaType: 'image/png',
      data: new Uint8Array(),
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      scrollX: 0,
      scrollY: 0,
    };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class FakeDriver implements BrowserDriver {
  constructor(readonly session: FakeSession) {}

  async createSession(_options?: BrowserCreateOptions): Promise<BrowserDriverSession> {
    return this.session;
  }
}

const setup = async (initial: DriverObservation) => {
  const session = new FakeSession(initial);
  const runtime = new BrowserIRRuntime(new FakeDriver(session));
  const created = await runtime.create();
  return { runtime, session, created };
};

describe('BrowserIRRuntime session lifecycle', () => {
  it('closes a newly created driver session when its browser ID is already registered', async () => {
    const first = new FakeSession(observation([]));
    const duplicate = new FakeSession(observation([]));
    let duplicateCloses = 0;
    duplicate.close = async () => {
      duplicateCloses += 1;
      throw new Error('cleanup failed');
    };
    let created = 0;
    const runtime = new BrowserIRRuntime({
      async createSession() {
        created += 1;
        return created === 1 ? first : duplicate;
      },
    });

    await runtime.create();
    await expect(runtime.create()).rejects.toMatchObject({
      code: 'duplicate_browser',
      message: 'Browser browser-1 already exists.',
    });
    expect(duplicateCloses).toBe(1);
  });

  it('retains browser ownership after a failed close so cleanup can be retried', async () => {
    const session = new FakeSession(observation([]));
    let closeAttempts = 0;
    session.close = async () => {
      closeAttempts += 1;
      if (closeAttempts === 1) throw new Error('driver close failed');
    };
    const runtime = new BrowserIRRuntime(new FakeDriver(session));
    const created = await runtime.create();

    await expect(
      runtime.close({ browserId: created.browserId }),
    ).rejects.toThrow('driver close failed');
    await expect(
      runtime.close({ browserId: created.browserId }),
    ).resolves.toBeUndefined();
    await expect(
      runtime.close({ browserId: created.browserId }),
    ).rejects.toMatchObject({ code: 'unknown_browser' });
    expect(closeAttempts).toBe(2);
  });

  it('fail-closed invalidation removes a browser even when driver shutdown fails', async () => {
    const session = new FakeSession(observation([]));
    session.close = async () => {
      throw new Error('driver shutdown failed');
    };
    const runtime = new BrowserIRRuntime(new FakeDriver(session));
    const created = await runtime.create();

    await expect(runtime.invalidateBrowser(created.browserId)).rejects.toThrow(
      'driver shutdown failed',
    );
    await expect(runtime.pages({ browserId: created.browserId })).rejects.toMatchObject({
      code: 'unknown_browser',
    });
  });
});

describe('BrowserIRRuntime unsafe evaluation', () => {
  it('rejects invalid execution bounds before calling the driver', async () => {
    const { runtime, session, created } = await setup(observation([]));
    const before = await runtime.observe({ browserId: created.browserId });
    for (const overrides of [
      { expression: '' },
      { timeoutMs: 0 },
      { timeoutMs: Number.POSITIVE_INFINITY },
      { timeoutMs: MAX_UNSAFE_EVALUATE_TIMEOUT_MS + 1 },
      { maxOutputBytes: 0 },
      { maxOutputBytes: 1.5 },
      { maxOutputBytes: MAX_UNSAFE_EVALUATE_OUTPUT_BYTES + 1 },
      { expression: 'x'.repeat(MAX_UNSAFE_EVALUATE_EXPRESSION_CHARACTERS + 1) },
      { expression: '€'.repeat(10_923) },
    ]) {
      await expect(
        runtime.evaluateUnsafe({
          browserId: created.browserId,
          pageId: created.initialPageId,
          expectedRevision: before.view.revision,
          expression: '1 + 1',
          timeoutMs: 500,
          maxOutputBytes: 1024,
          ...overrides,
        }),
      ).rejects.toMatchObject({ code: 'invalid_evaluation_request' });
    }
    expect(session.evaluations).toHaveLength(0);
  });

  it('reports an unsupported driver without dispatching page code', async () => {
    const { runtime, session, created } = await setup(observation([]));
    Object.defineProperty(session, 'evaluateUnsafe', { value: undefined });
    const before = await runtime.observe({ browserId: created.browserId });

    await expect(
      runtime.evaluateUnsafe({
        browserId: created.browserId,
        pageId: created.initialPageId,
        expectedRevision: before.view.revision,
        expression: '1 + 1',
        timeoutMs: 500,
        maxOutputBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: 'unsafe_evaluation_unsupported' });
    expect(session.evaluations).toHaveLength(0);
  });

  it('preflights the revision and never dispatches stale page code', async () => {
    const { runtime, session, created } = await setup(
      observation([observedEntity('Save', 'save')]),
    );
    const before = await runtime.observe({ browserId: created.browserId });
    session.current = observation([observedEntity('Save', 'save')], {
      visibleText: 'The page changed before evaluation.',
    });

    await expect(
      runtime.evaluateUnsafe({
        browserId: created.browserId,
        pageId: created.initialPageId,
        expectedRevision: before.view.revision,
        expression: 'globalThis.__shouldNotRun = true',
        timeoutMs: 500,
        maxOutputBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    expect(session.evaluations).toHaveLength(0);
  });

  it('forces a new revision and invalidates every old ref after dispatched code', async () => {
    const { runtime, session, created } = await setup(
      observation([observedEntity('Save', 'save')]),
    );
    const before = await runtime.observe({ browserId: created.browserId });
    const oldRef = before.view.structured.entities[0]!.ref;
    session.onEvaluate = () => ({
      dispatched: true,
      outcome: 'completed',
      value: { answer: 42 },
      outputBytes: 13,
    });

    const receipt = await runtime.evaluateUnsafe({
      browserId: created.browserId,
      pageId: created.initialPageId,
      expectedRevision: before.view.revision,
      expression: '({ answer: 42 })',
      timeoutMs: 500,
      maxOutputBytes: 1024,
    });

    expect(receipt).toMatchObject({
      outcome: 'completed',
      dispatched: true,
      preRevision: before.view.revision,
      postRevision: before.view.revision + 1,
      postObservation: 'completed',
      value: { answer: 42 },
    });
    expect(receipt.observation?.delta.stateInvalidated).toBe(true);
    expect(receipt.observation?.delta.invalidatedRefs).toContain(oldRef.entityId);
    expect(receipt.observation?.view.structured.entities[0]?.ref.revision).toBe(
      before.view.revision + 1,
    );
  });

  it.each(['exception', 'timed_out', 'cancelled'] as const)(
    're-observes and invalidates refs after a dispatched %s outcome',
    async (outcome) => {
      const { runtime, session, created } = await setup(
        observation([observedEntity('Run', 'run')]),
      );
      const before = await runtime.observe({ browserId: created.browserId });
      session.onEvaluate = () => ({
        dispatched: true,
        outcome,
        ...(outcome === 'timed_out'
          ? { terminationAttempted: true, terminationConfirmed: true }
          : {}),
      });

      const receipt = await runtime.evaluateUnsafe({
        browserId: created.browserId,
        pageId: created.initialPageId,
        expectedRevision: before.view.revision,
        expression: 'while (true) {}',
        timeoutMs: 25,
        maxOutputBytes: 1024,
      });

      expect(receipt.outcome).toBe(outcome);
      expect(receipt.postRevision).toBe(before.view.revision + 1);
      expect(receipt.observation?.delta.stateInvalidated).toBe(true);
      expect(receipt.error?.message).not.toContain('while (true)');
    },
  );

  it('does not dispatch when cancellation is already requested', async () => {
    const { runtime, session, created } = await setup(observation([]));
    const before = await runtime.observe({ browserId: created.browserId });
    const controller = new AbortController();
    controller.abort();

    const receipt = await runtime.evaluateUnsafe({
      browserId: created.browserId,
      pageId: created.initialPageId,
      expectedRevision: before.view.revision,
      expression: '1 + 1',
      timeoutMs: 500,
      maxOutputBytes: 1024,
      signal: controller.signal,
    });

    expect(receipt).toMatchObject({
      outcome: 'cancelled',
      dispatched: false,
      preRevision: before.view.revision,
      postRevision: before.view.revision,
      postObservation: 'completed',
    });
    expect(session.evaluations).toHaveLength(0);
  });

  it('invalidates the complete browser if post-evaluation observation fails', async () => {
    const { runtime, session, created } = await setup(observation([]));
    const before = await runtime.observe({ browserId: created.browserId });
    session.onEvaluate = () => {
      session.observeError = new Error('secret post-observation detail');
      return { dispatched: true, outcome: 'exception' };
    };

    const receipt = await runtime.evaluateUnsafe({
      browserId: created.browserId,
      pageId: created.initialPageId,
      expectedRevision: before.view.revision,
      expression: 'throw new Error("do-not-leak")',
      timeoutMs: 500,
      maxOutputBytes: 1024,
    });

    expect(receipt).toMatchObject({
      outcome: 'exception',
      dispatched: true,
      postObservation: 'failed',
      browserInvalidated: true,
      postObservationError: {
        code: 'post_evaluation_observation_failed',
      },
    });
    expect(JSON.stringify(receipt)).not.toContain('secret post-observation detail');
    expect(JSON.stringify(receipt)).not.toContain('do-not-leak');
    expect(session.closeCalls).toBe(1);
    await expect(runtime.pages({ browserId: created.browserId })).rejects.toMatchObject({
      code: 'unknown_browser',
    });
  });

  it('removes the browser immediately when the driver cannot contain unsafe execution', async () => {
    const { runtime, session, created } = await setup(observation([]));
    const before = await runtime.observe({ browserId: created.browserId });
    session.onEvaluate = () => {
      session.observeError = new Error('post-observation must not run');
      return {
        dispatched: true,
        outcome: 'timed_out',
        terminationAttempted: true,
        terminationConfirmed: false,
        browserInvalidated: true,
      };
    };

    const receipt = await runtime.evaluateUnsafe({
      browserId: created.browserId,
      pageId: created.initialPageId,
      expectedRevision: before.view.revision,
      expression: 'new Promise(() => {})',
      timeoutMs: 25,
      maxOutputBytes: 1024,
    });

    expect(receipt).toMatchObject({
      outcome: 'timed_out',
      dispatched: true,
      terminationAttempted: true,
      terminationConfirmed: false,
      browserInvalidated: true,
      postObservation: 'failed',
      postObservationError: { code: 'evaluation_containment_failed' },
    });
    expect(session.closeCalls).toBe(0);
    await expect(runtime.pages({ browserId: created.browserId })).rejects.toMatchObject({
      code: 'unknown_browser',
    });
  });

  it('fails closed when a nonconforming driver throws after unsafe dispatch may have begun', async () => {
    const { runtime, session, created } = await setup(observation([]));
    const before = await runtime.observe({ browserId: created.browserId });
    session.onEvaluate = () => {
      session.observeError = new Error('post-observation must not run');
      throw new Error('driver transport detail must not escape');
    };

    const receipt = await runtime.evaluateUnsafe({
      browserId: created.browserId,
      pageId: created.initialPageId,
      expectedRevision: before.view.revision,
      expression: 'globalThis.maybeStarted = true',
      timeoutMs: 500,
      maxOutputBytes: 1024,
    });

    expect(receipt).toMatchObject({
      outcome: 'exception',
      dispatched: true,
      browserInvalidated: true,
      postObservation: 'failed',
      postObservationError: { code: 'evaluation_containment_failed' },
    });
    expect(JSON.stringify(receipt)).not.toContain('driver transport detail');
    expect(session.closeCalls).toBe(1);
    await expect(runtime.pages({ browserId: created.browserId })).rejects.toMatchObject({
      code: 'unknown_browser',
    });
  });
});

describe('BrowserIRRuntime captures', () => {
  it('rejects captures that exceed physical-pixel or encoded-byte limits', async () => {
    const { runtime, session, created } = await setup(
      observation([observedEntity('save-order', 'node-1')]),
    );
    const before = await runtime.observe({ browserId: created.browserId });
    const capture = (overrides: Partial<CaptureResult>): CaptureResult => ({
      pageId: session.current.pageId,
      mediaType: 'image/png',
      data: new Uint8Array([1]),
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      scrollX: 0,
      scrollY: 0,
      ...overrides,
    });

    session.capture = async () =>
      capture({ width: MAX_CAPTURE_PHYSICAL_PIXELS + 1, height: 1 });
    await expect(
      runtime.capture({
        browserId: created.browserId,
        expectedRevision: before.view.revision,
        kind: 'viewport',
      }),
    ).rejects.toMatchObject({ code: 'capture_too_large' });

    session.capture = async () =>
      capture({ data: new Uint8Array(MAX_CAPTURE_BYTES + 1) });
    await expect(
      runtime.capture({
        browserId: created.browserId,
        expectedRevision: before.view.revision,
        kind: 'viewport',
      }),
    ).rejects.toMatchObject({ code: 'capture_too_large' });
  });

  it('rejects nonpositive or nonfinite capture geometry from a driver', async () => {
    const { runtime, session, created } = await setup(
      observation([observedEntity('save-order', 'node-1')]),
    );
    const before = await runtime.observe({ browserId: created.browserId });
    const invalidGeometries: Array<Partial<CaptureResult>> = [
      { width: 0 },
      { height: -1 },
      { deviceScaleFactor: Number.NaN },
      { scrollX: Number.POSITIVE_INFINITY },
    ];

    for (const invalidGeometry of invalidGeometries) {
      session.capture = async () => ({
        pageId: session.current.pageId,
        mediaType: 'image/png',
        data: new Uint8Array([1]),
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        scrollX: 0,
        scrollY: 0,
        ...invalidGeometry,
      });
      await expect(
        runtime.capture({
          browserId: created.browserId,
          expectedRevision: before.view.revision,
          kind: 'viewport',
        }),
      ).rejects.toMatchObject({ code: 'capture_invalid' });
    }
  });

  it('returns pixels only after a stable post-capture observation', async () => {
    const { runtime, session, created } = await setup(
      observation([observedEntity('save-order', 'node-1')]),
    );
    const before = await runtime.observe({ browserId: created.browserId });
    let verificationObservations = 0;
    session.observe = async () => {
      verificationObservations += 1;
      return session.current;
    };

    const capture = await runtime.capture({
      browserId: created.browserId,
      expectedRevision: before.view.revision,
      kind: 'viewport',
    });

    expect(capture).toMatchObject({
      browserId: created.browserId,
      pageId: created.initialPageId,
      revision: before.view.revision,
      mediaType: 'image/png',
    });
    expect(verificationObservations).toBe(1);
  });

  it('rejects a stale capture revision before asking the driver for pixels', async () => {
    const { runtime, session, created } = await setup(
      observation([observedEntity('save-order', 'node-1')]),
    );
    const before = await runtime.observe({ browserId: created.browserId });
    let captures = 0;
    session.capture = async () => {
      captures += 1;
      return {
        pageId: session.current.pageId,
        mediaType: 'image/png',
        data: new Uint8Array([1]),
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        scrollX: 0,
        scrollY: 0,
      };
    };

    await expect(
      runtime.capture({
        browserId: created.browserId,
        expectedRevision: before.view.revision - 1,
        kind: 'viewport',
      }),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    expect(captures).toBe(0);
  });

  it('rejects pixels when post-capture stability cannot be verified', async () => {
    const { runtime, session, created } = await setup(
      observation([observedEntity('save-order', 'node-1')]),
    );
    const before = await runtime.observe({ browserId: created.browserId });
    session.observe = async () => {
      throw new Error('private driver failure details');
    };

    await expect(
      runtime.capture({
        browserId: created.browserId,
        expectedRevision: before.view.revision,
        kind: 'viewport',
      }),
    ).rejects.toMatchObject({
      code: 'capture_verification_failed',
      message: 'Could not verify that the page remained stable during capture; observe and retry.',
    });
  });

  it('rejects pixels when the represented page changes during capture', async () => {
    const beforeEntity = observedEntity('save-order', 'node-1', {
      value: 'saving',
    });
    const afterEntity = observedEntity('save-order', 'node-1', {
      value: 'saved',
    });
    const { runtime, session, created } = await setup(observation([beforeEntity]));
    const before = await runtime.observe({ browserId: created.browserId });

    session.capture = async () => {
      session.current = observation([afterEntity]);
      return {
        pageId: session.current.pageId,
        mediaType: 'image/png',
        data: new Uint8Array([1, 2, 3]),
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        scrollX: 0,
        scrollY: 0,
      };
    };

    await expect(
      runtime.capture({
        browserId: created.browserId,
        pageId: created.initialPageId,
        expectedRevision: before.view.revision,
        kind: 'viewport',
      }),
    ).rejects.toMatchObject({
      code: 'capture_invalidated',
      message: `Page changed from revision ${before.view.revision} to ${before.view.revision + 1} during capture; observe and retry.`,
    });
  });
});

describe('BrowserIRRuntime waits', () => {
  it('rejects stale entity-state targets before polling the driver', async () => {
    const { runtime, session, created } = await setup(
      observation([observedEntity('save-order', 'node-1')]),
    );
    const observed = await runtime.observe({ browserId: created.browserId });
    const target = observed.view.structured.entities[0]!.ref;
    let polls = 0;
    session.observe = async () => {
      polls += 1;
      return session.current;
    };

    const staleTargets: EntityRef[] = [
      { ...target, browserId: 'browser-other' },
      { ...target, pageId: 'page-other' },
      { ...target, revision: target.revision - 1 },
    ];

    for (const staleTarget of staleTargets) {
      await expect(
        runtime.wait({
          browserId: created.browserId,
          expectedRevision: observed.view.revision,
          condition: {
            kind: 'entity_state',
            target: staleTarget,
            state: { enabled: true },
          },
          timeoutMs: 1,
          pollIntervalMs: 0,
        }),
      ).rejects.toMatchObject({ code: 'stale_target' });
    }

    expect(polls).toBe(0);
  });

  it('settles only after two unchanged non-busy observations and resets on change', async () => {
    const stable = observedEntity('save-order', 'node-1', {
      value: 'draft',
      state: { visible: true, enabled: true, busy: false },
    });
    const changing = observedEntity('save-order', 'node-1', {
      value: 'saving',
      state: { visible: true, enabled: true, busy: true },
    });
    const saved = observedEntity('save-order', 'node-1', {
      value: 'saved',
      state: { visible: true, enabled: true, busy: false },
    });
    const frames = [
      observation([stable]),
      observation([stable]),
      observation([changing]),
      observation([changing]),
      observation([saved]),
      observation([saved]),
      observation([saved]),
    ];
    const { runtime, session, created } = await setup(frames[0]!);
    let frameIndex = 0;
    session.observe = async () =>
      frames[Math.min(frameIndex++, frames.length - 1)]!;

    const result = await runtime.wait({
      browserId: created.browserId,
      expectedRevision: 0,
      condition: { kind: 'settled' },
      timeoutMs: 1_000,
      pollIntervalMs: 0,
    });

    expect(frameIndex).toBe(7);
    expect(result.snapshot.entities[0]?.value).toBe('saved');
    expect(result.snapshot.entities[0]?.state.busy).toBe(false);
  });
});

describe('BrowserIRRuntime identity and revisions', () => {
  it('keeps the same ref and revision for an unchanged observation', async () => {
    const { runtime, created } = await setup(observation([observedEntity('save-order', 'node-1')]));

    const first = await runtime.observe({ browserId: created.browserId });
    const second = await runtime.observe({ browserId: created.browserId });

    expect(second.view.revision).toBe(first.view.revision);
    expect(second.view.structured.entities[0]!.ref).toEqual(first.view.structured.entities[0]!.ref);
    expect(second.delta.changed).toEqual([]);
    expect(second.view.structured.entities[0]).not.toHaveProperty('sourceId');
    expect(second.view.structured.entities[0]).not.toHaveProperty('identityKey');
    expect(second.view.structured.entities[0]).not.toHaveProperty('target');
  });

  it('keeps the surviving duplicate bound to its canonical ID when an earlier duplicate disappears', async () => {
    const firstDuplicate = observedEntity('new-customer', 'source-first', {
      name: 'New customer',
      description: 'First duplicate',
    });
    const survivingDuplicate = observedEntity('new-customer', 'source-survivor', {
      name: 'New customer',
      description: 'Surviving duplicate',
    });
    const { runtime, session, created } = await setup(
      observation([firstDuplicate, survivingDuplicate]),
    );

    const first = await runtime.observe({ browserId: created.browserId });
    const firstDuplicateId = first.view.structured.entities.find(
      (entity) => entity.description === 'First duplicate',
    )?.ref.entityId;
    const survivorId = first.view.structured.entities.find(
      (entity) => entity.description === 'Surviving duplicate',
    )?.ref.entityId;
    expect(firstDuplicateId).toBeDefined();
    expect(survivorId).toBeDefined();
    expect(survivorId).not.toBe(firstDuplicateId);

    session.current = observation([survivingDuplicate]);
    const second = await runtime.observe({ browserId: created.browserId });

    expect(second.view.structured.entities[0]?.ref.entityId).toBe(survivorId);
    expect(second.delta.removed).toContain(firstDuplicateId);
    expect(second.delta.invalidatedRefs).toContain(firstDuplicateId);
  });

  it('replaces and invalidates a ref when a recycled source changes meaning', async () => {
    const { runtime, session, created } = await setup(
      observation([observedEntity('vehicle:VIN-001', 'recycled-row')]),
    );
    const first = await runtime.observe({ browserId: created.browserId });
    const oldRef = first.view.structured.entities[0]!.ref;

    session.current = observation([observedEntity('vehicle:VIN-002', 'recycled-row')]);
    const second = await runtime.observe({ browserId: created.browserId });
    const newRef = second.view.structured.entities[0]!.ref;

    expect(newRef.entityId).not.toBe(oldRef.entityId);
    expect(second.delta.removed).toContain(oldRef.entityId);
    expect(second.delta.invalidatedRefs).toContain(oldRef.entityId);
    expect(second.delta.added.map((entity) => entity.id)).toContain(newRef.entityId);
  });

  it('invalidates every prior reference whenever the page revision advances', async () => {
    const firstEntity = observedEntity('first-action', 'node-1');
    const secondEntity = observedEntity('second-action', 'node-2');
    const { runtime, session, created } = await setup(
      observation([firstEntity, secondEntity]),
    );
    const first = await runtime.observe({ browserId: created.browserId });
    const priorIds = first.view.structured.entities
      .map((entity) => entity.ref.entityId)
      .sort();

    session.current = observation([
      { ...firstEntity, state: { ...firstEntity.state, expanded: true } },
      secondEntity,
    ]);
    const second = await runtime.observe({ browserId: created.browserId });

    expect(second.view.revision).toBe(first.view.revision + 1);
    expect(second.delta.invalidatedRefs).toEqual(priorIds);
  });

  it('rebinds a retained sibling only across a contiguous value-only revision path', async () => {
    const name = observedEntity('customer-name', 'node-name', {
      kind: 'input',
      role: 'textbox',
      value: '',
      capabilities: [{ kind: 'fill' }],
    });
    const city = observedEntity('customer-city', 'node-city', {
      kind: 'input',
      role: 'textbox',
      value: '',
      capabilities: [{ kind: 'fill' }],
    });
    const { runtime, session, created } = await setup(observation([name, city]));
    const first = await runtime.observe({ browserId: created.browserId });
    const nameRef = first.view.structured.entities.find(
      (entity) => entity.name === 'customer-name',
    )!.ref;
    const cityRef = first.view.structured.entities.find(
      (entity) => entity.name === 'customer-city',
    )!.ref;
    session.onAct = ({ action }) => {
      if (action.kind !== 'fill') throw new Error('expected a fill action');
      const filled = action.target.opaqueId === 'target:node-name' ? name : city;
      const value = action.value;
      session.current = observation([
        filled === name ? { ...name, value } : name,
        filled === city ? { ...city, value } : city,
      ]);
    };

    const firstFill = await runtime.act({
      browserId: created.browserId,
      expectedRevision: first.view.revision,
      action: { kind: 'fill', target: nameRef, value: 'Steinweg Logistik GmbH' },
    });
    expect(firstFill.status).toBe('verified');
    expect(firstFill.delta?.rebindableRefs).toContain(cityRef.entityId);

    const secondFill = await runtime.act({
      browserId: created.browserId,
      expectedRevision: firstFill.postRevision!,
      action: { kind: 'fill', target: cityRef, value: 'Leipzig' },
    });

    expect(secondFill.status).toBe('verified');
    expect(secondFill.dispatched).toBe(true);
    expect(session.actions).toHaveLength(2);
  });

  it('fails closed when an old ref identity is recycled before a current-revision action', async () => {
    const before = observedEntity('vehicle:VIN-001', 'recycled-row');
    const { runtime, session, created } = await setup(observation([before]));
    const first = await runtime.observe({ browserId: created.browserId });
    const oldRef = first.view.structured.entities[0]!.ref;

    session.current = observation([observedEntity('vehicle:VIN-002', 'recycled-row')]);
    const current = await runtime.observe({ browserId: created.browserId });
    const receipt = await runtime.act({
      browserId: created.browserId,
      expectedRevision: current.view.revision,
      action: { kind: 'click', target: oldRef },
    });

    expect(receipt.status).toBe('stale_target');
    expect(receipt.dispatched).toBe(false);
    expect(session.actions).toHaveLength(0);
  });

  it('fails closed when bounded rebind history no longer covers the old ref', async () => {
    const retained = observedEntity('retained-action', 'node-retained');
    const changing = observedEntity('changing-value', 'node-changing', {
      kind: 'input',
      role: 'textbox',
      value: '0',
      capabilities: [{ kind: 'fill' }],
    });
    const { runtime, session, created } = await setup(observation([retained, changing]));
    const first = await runtime.observe({ browserId: created.browserId });
    const oldRef = first.view.structured.entities.find(
      (entity) => entity.name === 'retained-action',
    )!.ref;

    let current = first;
    for (let index = 1; index <= 40; index += 1) {
      session.current = observation([{ ...changing, value: String(index) }, retained]);
      current = await runtime.observe({ browserId: created.browserId });
    }
    const receipt = await runtime.act({
      browserId: created.browserId,
      expectedRevision: current.view.revision,
      action: { kind: 'click', target: oldRef },
    });

    expect(receipt.status).toBe('stale_target');
    expect(receipt.dispatched).toBe(false);
    expect(session.actions).toHaveLength(0);
  });

  it('rejects a stale expected revision before dispatching an action', async () => {
    const initialEntity = observedEntity('credit-limit', 'node-input', {
      kind: 'input',
      role: 'textbox',
      value: '30000',
      capabilities: [{ kind: 'fill' }],
    });
    const { runtime, session, created } = await setup(observation([initialEntity]));
    const first = await runtime.observe({ browserId: created.browserId });
    const staleTarget = first.view.structured.entities[0]!.ref;

    session.current = observation([{ ...initialEntity, value: '45000' }]);
    const current = await runtime.observe({ browserId: created.browserId });
    expect(current.view.revision).toBeGreaterThan(first.view.revision);

    const receipt = await runtime.act({
      browserId: created.browserId,
      expectedRevision: first.view.revision,
      action: { kind: 'fill', target: staleTarget, value: '50000' },
    });

    expect(receipt.status).toBe('stale_target');
    expect(receipt.dispatched).toBe(false);
    expect(session.actions).toHaveLength(0);
  });

  it('re-observes and rejects a target whose virtualized source was recycled before dispatch', async () => {
    const { runtime, session, created } = await setup(
      observation([observedEntity('vehicle:VIN-001', 'recycled-row')]),
    );
    const first = await runtime.observe({ browserId: created.browserId });
    const oldTarget = first.view.structured.entities[0]!.ref;

    session.current = observation([observedEntity('vehicle:VIN-002', 'recycled-row')]);
    const receipt = await runtime.act({
      browserId: created.browserId,
      expectedRevision: first.view.revision,
      action: { kind: 'click', target: oldTarget },
    });

    expect(receipt.status).toBe('stale_target');
    expect(receipt.dispatched).toBe(false);
    expect(session.actions).toHaveLength(0);
  });

  it('rejects stale navigation before calling the driver', async () => {
    const initialEntity = observedEntity('orders', 'node-orders');
    const { runtime, session, created } = await setup(observation([initialEntity]));
    const first = await runtime.observe({ browserId: created.browserId });

    session.current = observation([{ ...initialEntity, state: { visible: true, enabled: false } }]);
    const current = await runtime.observe({ browserId: created.browserId });
    expect(current.view.revision).toBeGreaterThan(first.view.revision);

    await expect(
      runtime.navigate({
        browserId: created.browserId,
        expectedRevision: first.view.revision,
        url: 'https://fixture.test/app/orders',
      }),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    expect(session.navigations).toHaveLength(0);
  });

  it('resolves duplicate identity keys through source-addressed containment', async () => {
    const { runtime, created } = await setup(
      observation(
        [
          observedEntity('scope:navigation', 'scope-nav', {
            kind: 'region',
            role: 'navigation',
            name: 'Primary navigation',
            capabilities: [],
          }),
          observedEntity('scope:main', 'scope-main', {
            kind: 'region',
            role: 'main',
            name: 'Customer workspace',
            capabilities: [],
          }),
          observedEntity('new-customer', 'nav-new-customer', {
            role: 'link',
            name: 'New customer',
          }),
          observedEntity('new-customer', 'main-new-customer', {
            role: 'link',
            name: 'New customer',
          }),
        ],
        {
          relations: [
            sourceRelation('scope-nav', 'nav-new-customer', 'contains'),
            sourceRelation('scope-main', 'main-new-customer', 'contains'),
          ],
        },
      ),
    );

    const result = await runtime.observe({ browserId: created.browserId });
    const scopes = new Map(
      result.view.structured.entities
        .filter((entity) => entity.kind === 'region')
        .map((entity) => [entity.name, entity.ref.entityId]),
    );
    const newCustomerIds = result.view.structured.entities
      .filter((entity) => entity.name === 'New customer')
      .map((entity) => entity.ref.entityId);
    const contains = result.view.structured.relations.filter((relation) => relation.kind === 'contains');

    expect(new Set(newCustomerIds).size).toBe(2);
    expect(contains).toHaveLength(2);
    expect(new Set(contains.map((relation) => relation.from.entityId))).toEqual(
      new Set([scopes.get('Primary navigation'), scopes.get('Customer workspace')]),
    );
    expect(new Set(contains.map((relation) => relation.to.entityId))).toEqual(
      new Set(newCustomerIds),
    );

    const serialized = JSON.stringify(result.view);
    expect(serialized).not.toContain('scope-nav');
    expect(serialized).not.toContain('scope-main');
    expect(serialized).not.toContain('nav-new-customer');
    expect(serialized).not.toContain('main-new-customer');
    expect(serialized).not.toContain('target:');
  });

  it('includes a focused duplicate’s one-hop containing scope and relationship', async () => {
    const { runtime, created } = await setup(
      observation(
        [
          observedEntity('scope:navigation', 'scope-nav', {
            kind: 'region',
            role: 'navigation',
            name: 'Primary navigation',
            capabilities: [],
          }),
          observedEntity('scope:main', 'scope-main', {
            kind: 'region',
            role: 'main',
            name: 'Customer workspace',
            capabilities: [],
          }),
          observedEntity('new-customer', 'nav-new-customer', {
            role: 'link',
            name: 'New customer',
            description: 'Navigation action',
          }),
          observedEntity('new-customer', 'main-new-customer', {
            role: 'link',
            name: 'New customer',
            description: 'Workspace action',
          }),
        ],
        {
          relations: [
            sourceRelation('scope-nav', 'nav-new-customer', 'contains'),
            sourceRelation('scope-main', 'main-new-customer', 'contains'),
          ],
        },
      ),
    );

    const observed = await runtime.observe({ browserId: created.browserId });
    const workspaceAction = observed.view.structured.entities.find(
      (entity) => entity.description === 'Workspace action',
    );
    const workspaceScope = observed.view.structured.entities.find(
      (entity) => entity.name === 'Customer workspace',
    );
    if (!workspaceAction || !workspaceScope) throw new Error('missing semantic context entities');

    const focused = await runtime.inspect({
      browserId: created.browserId,
      refs: [workspaceAction.ref],
    });

    expect(focused.structured.entities.map((entity) => entity.ref.entityId)).toEqual(
      expect.arrayContaining([workspaceAction.ref.entityId, workspaceScope.ref.entityId]),
    );
    expect(focused.structured.entities).toHaveLength(2);
    expect(focused.structured.relations).toContainEqual(
      expect.objectContaining({
        kind: 'contains',
        from: workspaceScope.ref,
        to: workspaceAction.ref,
      }),
    );
  });

  it('treats inspect refs from another browser, page, or revision as stale', async () => {
    const { runtime, created } = await setup(
      observation([observedEntity('customer-name', 'node-name')]),
    );
    const observed = await runtime.observe({ browserId: created.browserId });
    const target = observed.view.structured.entities[0]!.ref;
    const staleRefs: EntityRef[] = [
      { ...target, browserId: 'browser-other' },
      { ...target, pageId: 'page-other' },
      { ...target, revision: target.revision - 1 },
    ];

    for (const staleRef of staleRefs) {
      const inspected = await runtime.inspect({
        browserId: created.browserId,
        refs: [staleRef],
      });

      expect.soft(inspected.structured.entities, JSON.stringify(staleRef)).toEqual([]);
      expect
        .soft(inspected.structured.omissions, JSON.stringify(staleRef))
        .toContainEqual({
          kind: 'stale_refs',
          count: 1,
          reason: 'stale_reference',
        });
    }
  });
});

describe('BrowserIRRuntime view compiler', () => {
  it('produces deterministic structured and compact text views', async () => {
    const { runtime, created } = await setup(
      observation([
        observedEntity('z-last', 'node-z'),
        observedEntity('a-first', 'node-a', { role: 'link', capabilities: [{ kind: 'click' }] }),
      ]),
    );

    const observed = await runtime.observe({ browserId: created.browserId });
    const first = await runtime.inspect({ browserId: created.browserId });
    const second = await runtime.inspect({ browserId: created.browserId });

    expect(first).toEqual(second);
    expect(first.text).toBe(second.text);
    expect(first.revision).toBe(observed.view.revision);
    expect(first.structured.entities.map((entity) => entity.name)).toEqual(['z-last', 'a-first']);
  });

  it('keeps field-specific recovery guidance in the compact model view', async () => {
    const { runtime, created } = await setup(
      observation([
        observedEntity('vat-id', 'node-vat', {
          kind: 'input',
          role: 'textbox',
          name: 'VAT ID',
          description: 'VAT ID must be two letters followed by 9 digits.',
          state: { visible: true, enabled: true, invalid: true },
          capabilities: [{ kind: 'fill' }],
        }),
      ]),
    );

    const result = await runtime.observe({ browserId: created.browserId });

    expect(result.view.text).toContain(
      'description="VAT ID must be two letters followed by 9 digits."',
    );
    expect(result.view.text).toContain('state=enabled=true,invalid=true,visible=true');
  });

  it('locally truncates an oversized alert description before evicting useful controls', async () => {
    const description =
      'Validation failed. VAT ID must be two letters followed by 9 digits. ' + 'x'.repeat(8_000);
    const { runtime, created } = await setup(
      observation([
        observedEntity('validation-alert', 'node-alert', {
          kind: 'status',
          role: 'alert',
          name: 'Validation failed',
          description,
          state: { visible: true, transient: true },
          capabilities: [],
        }),
        observedEntity('customer-name', 'node-name', {
          kind: 'input',
          role: 'textbox',
          name: 'Customer name',
          capabilities: [{ kind: 'fill' }],
        }),
        observedEntity('save-customer', 'node-save', {
          role: 'button',
          name: 'Save customer',
        }),
        observedEntity('cancel', 'node-cancel', {
          role: 'button',
          name: 'Cancel',
        }),
      ]),
    );
    const maxCharacters = 2_000;

    const result = await runtime.observe({
      browserId: created.browserId,
      budget: { maxCharacters },
    });
    const serialized = JSON.stringify({
      text: result.view.text,
      structured: result.view.structured,
    });
    const alert = result.view.structured.entities.find((entity) => entity.role === 'alert');

    expect(serialized.length).toBeLessThanOrEqual(maxCharacters);
    expect(result.view.structured.entities.map((entity) => entity.name)).toEqual(
      expect.arrayContaining([
        'Validation failed',
        'Customer name',
        'Save customer',
        'Cancel',
      ]),
    );
    expect(alert?.description).toContain(
      'VAT ID must be two letters followed by 9 digits.',
    );
    expect(alert?.description?.length).toBeLessThan(description.length);
    expect(result.view.structured.omissions).toContainEqual(
      expect.objectContaining({ kind: 'content', reason: 'budget' }),
    );
    expect(result.view.text).toMatch(/\[\d+ content omitted: budget\]/);
  });

  it('locally truncates nested values and capability reasons in finite-budget views', async () => {
    const oversized = 'x'.repeat(8_000);
    const { runtime, created } = await setup(
      observation([
        observedEntity('save-customer', 'node-save', {
          name: 'Save customer',
          value: { note: oversized },
          capabilities: [{ kind: 'click', reason: oversized }],
        }),
        observedEntity('cancel', 'node-cancel', {
          name: 'Cancel',
          capabilities: [{ kind: 'click' }],
        }),
      ]),
    );

    const result = await runtime.observe({
      browserId: created.browserId,
      budget: { maxCharacters: 1_600 },
    });
    const save = result.view.structured.entities.find(
      (entity) => entity.name === 'Save customer',
    );
    const note = (save?.value as { note?: string } | undefined)?.note;

    expect(result.view.structured.entities.map((entity) => entity.name)).toEqual(
      expect.arrayContaining(['Save customer', 'Cancel']),
    );
    expect(note?.length).toBeLessThan(oversized.length);
    expect(save?.capabilities[0]?.reason?.length).toBeLessThan(oversized.length);
    expect(result.view.structured.omissions).toContainEqual(
      expect.objectContaining({ kind: 'content', reason: 'budget' }),
    );
  });

  it('reports explicit omissions when the view budget truncates entities', async () => {
    const entities = Array.from({ length: 5 }, (_, index) =>
      observedEntity(`action-${index + 1}`, `node-${index + 1}`),
    );
    const { runtime, created } = await setup(observation(entities));

    const result = await runtime.observe({
      browserId: created.browserId,
      budget: { maxEntities: 2 },
    });

    expect(result.view.truncated).toBe(true);
    expect(result.view.structured.entities).toHaveLength(2);
    expect(result.view.structured.omissions).toContainEqual({
      kind: 'entities',
      count: 3,
      reason: 'budget',
    });
    expect(result.view.text).toContain('[3 entities omitted: budget]');
  });

  it('keeps high-value top-of-viewport actions ahead of repetitive row links', async () => {
    const entities = [
      observedEntity('customer:adler', 'row-adler', {
        role: 'link',
        name: 'Adler GmbH',
        geometry: { x: 20, y: 500, width: 200, height: 30, inViewport: true },
      }),
      observedEntity('customer:berlin', 'row-berlin', {
        role: 'link',
        name: 'Berlin Motors',
        geometry: { x: 20, y: 540, width: 200, height: 30, inViewport: true },
      }),
      observedEntity('new-customer', 'new-customer', {
        role: 'link',
        name: 'New customer',
        geometry: { x: 1_200, y: 80, width: 160, height: 36, inViewport: true },
      }),
    ];
    const { runtime, created } = await setup(observation(entities));

    const result = await runtime.observe({
      browserId: created.browserId,
      budget: { maxEntities: 2 },
    });

    expect(result.view.structured.entities.map((entity) => entity.name)).toContain('New customer');
  });

  it('bounds the combined text and structured representation', async () => {
    const entities = Array.from({ length: 8 }, (_, index) =>
      observedEntity(`action-${index + 1}`, `node-${index + 1}`, {
        description: `Detailed help ${'x'.repeat(500)}`,
      }),
    );
    const { runtime, created } = await setup(
      observation(entities, {
        visibleText: `Customer table ${'row data '.repeat(1_000)}`,
      }),
    );
    const maxCharacters = 1_200;

    const result = await runtime.observe({
      browserId: created.browserId,
      budget: { maxCharacters },
    });
    const serialized = JSON.stringify({
      text: result.view.text,
      structured: result.view.structured,
    });

    expect(serialized.length).toBeLessThanOrEqual(maxCharacters);
    expect(result.view.truncated).toBe(true);
    expect(result.view.structured.omissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'content', reason: 'budget' }),
        expect.objectContaining({ kind: 'entities', reason: 'budget' }),
      ]),
    );
  });

  it('bounds long page metadata and marks the view truncated at a small budget', () => {
    const maxCharacters = 512;
    const snapshot: GraphSnapshot = {
      browserId: 'browser-1',
      pageId: 'page-1',
      revision: 1,
      url: `https://fixture.test/customers?filter=${'x'.repeat(2_000)}`,
      title: `Customers ${'y'.repeat(2_000)}`,
      entities: [],
      relations: [],
    };

    const view = compileView(snapshot, { budget: { maxCharacters } });
    const serialized = JSON.stringify({
      text: view.text,
      structured: view.structured,
    });

    expect(serialized.length).toBeLessThanOrEqual(maxCharacters);
    expect(view.truncated).toBe(true);
    expect(view.structured.omissions).toContainEqual(
      expect.objectContaining({ kind: 'content', reason: 'budget' }),
    );
  });

  it('renders canonical relationships in the compact text view', () => {
    const snapshot: GraphSnapshot = {
      browserId: 'browser-1',
      pageId: 'page-1',
      revision: 3,
      url: 'https://fixture.test/customers',
      title: 'Customers',
      entities: [
        {
          id: 'scope-main',
          pageId: 'page-1',
          kind: 'region',
          role: 'main',
          name: 'Customer workspace',
          state: { visible: true },
          capabilities: [],
          evidence: [],
          confidence: 1,
        },
        {
          id: 'action-new',
          pageId: 'page-1',
          kind: 'control',
          role: 'link',
          name: 'New customer',
          state: { visible: true, enabled: true },
          capabilities: [{ kind: 'click' }],
          evidence: [],
          confidence: 1,
        },
      ],
      relations: [{ from: 'scope-main', to: 'action-new', kind: 'contains' }],
    };

    const view = compileView(snapshot);

    expect(view.text).toContain('[scope-main@r3] contains [action-new@r3]');
  });
});

describe('BrowserIRRuntime actions', () => {
  it('blocks missing and explicitly disabled capabilities before driver dispatch', async () => {
    const cases: Array<{
      label: string;
      entity: DriverObservedEntity;
      action: (target: EntityRef) => BrowserAction;
    }> = [
      {
        label: 'missing capability',
        entity: observedEntity('customer-name', 'node-name', {
          kind: 'input',
          role: 'textbox',
          capabilities: [{ kind: 'click' }],
        }),
        action: (target) => ({ kind: 'fill', target, value: 'Ada' }),
      },
      {
        label: 'disabled capability',
        entity: observedEntity('save-customer', 'node-save', {
          capabilities: [{ kind: 'click', enabled: false }],
        }),
        action: (target) => ({ kind: 'click', target }),
      },
    ];

    for (const testCase of cases) {
      const { runtime, session, created } = await setup(
        observation([testCase.entity]),
      );
      const observed = await runtime.observe({ browserId: created.browserId });
      const target = observed.view.structured.entities[0]!.ref;

      const receipt = await runtime.act({
        browserId: created.browserId,
        expectedRevision: observed.view.revision,
        action: testCase.action(target),
      });

      expect.soft(receipt, testCase.label).toMatchObject({
        status: 'blocked',
        dispatched: false,
        preRevision: observed.view.revision,
        effects: [],
        error: { code: 'unsupported_action' },
      });
      expect.soft(session.actions, testCase.label).toHaveLength(0);
    }
  });

  it('separates dispatch from a verified post-action delta', async () => {
    const initialEntity = observedEntity('customer-name', 'node-name', {
      kind: 'input',
      role: 'textbox',
      value: 'Before',
      capabilities: [{ kind: 'fill' }],
    });
    const { runtime, session, created } = await setup(observation([initialEntity]));
    const before = await runtime.observe({ browserId: created.browserId });
    const target = before.view.structured.entities[0]!.ref;

    session.onAct = () => {
      session.current = observation([{ ...initialEntity, value: 'After' }]);
    };

    const receipt = await runtime.act({
      browserId: created.browserId,
      expectedRevision: before.view.revision,
      action: { kind: 'fill', target, value: 'After' },
    });

    expect(receipt.dispatched).toBe(true);
    expect(receipt.status).toBe('verified');
    expect(receipt.effects).toContainEqual({
      kind: 'graph_changed',
      verified: true,
      detail: '1 entity changed',
    });
    expect(receipt.delta?.changed.map((change) => change.entity.id)).toContain(target.entityId);
    expect(receipt.observation?.view.structured.entities[0]!.value).toBe('After');
  });

  it('verifies every requested value of a multi-select through related option state', async () => {
    const status = observedEntity('customer-status', 'node-status', {
      kind: 'input',
      role: 'combobox',
      name: 'Customer Status',
      value: 'active',
      capabilities: [{ kind: 'select' }],
    });
    const active = observedEntity('customer-status:active', 'node-active', {
      kind: 'option',
      role: 'option',
      name: 'Active',
      value: 'active',
      state: { selected: true, enabled: true },
      capabilities: [],
    });
    const suspended = observedEntity(
      'customer-status:suspended',
      'node-suspended',
      {
        kind: 'option',
        role: 'option',
        name: 'Suspended',
        value: 'suspended',
        state: { selected: false, enabled: true },
        capabilities: [],
      },
    );
    const relations = [
      sourceRelation('node-active', 'node-status', 'option-of'),
      sourceRelation('node-suspended', 'node-status', 'option-of'),
    ];
    const { runtime, session, created } = await setup(
      observation([status, active, suspended], { relations }),
    );
    const before = await runtime.observe({ browserId: created.browserId });
    const target = before.view.structured.entities.find(
      (entity) => entity.name === 'Customer Status',
    )?.ref;
    if (!target) throw new Error('missing multi-select target');

    session.onAct = () => {
      session.current = observation(
        [
          status,
          active,
          {
            ...suspended,
            state: { ...suspended.state, selected: true },
          },
        ],
        { relations },
      );
    };

    const receipt = await runtime.act({
      browserId: created.browserId,
      expectedRevision: before.view.revision,
      action: {
        kind: 'select',
        target,
        values: ['active', 'suspended'],
      },
    });

    expect(receipt.status).toBe('verified');
    expect(receipt.effects).toContainEqual(
      expect.objectContaining({
        kind: 'graph_changed',
        verified: true,
      }),
    );
  });

  it('does not mistake an unrelated graph change for the requested action effect', async () => {
    const initialEntity = observedEntity('customer-name', 'node-name', {
      kind: 'input',
      role: 'textbox',
      value: 'Before',
      capabilities: [{ kind: 'fill' }],
    });
    const { runtime, session, created } = await setup(observation([initialEntity]));
    const before = await runtime.observe({ browserId: created.browserId });
    const target = before.view.structured.entities[0]!.ref;

    session.onAct = () => {
      session.current = observation([
        initialEntity,
        observedEntity('unrelated-dashboard-tile', 'node-tile', {
          text: 'Loaded independently',
        }),
      ]);
    };

    const receipt = await runtime.act({
      browserId: created.browserId,
      expectedRevision: before.view.revision,
      action: { kind: 'fill', target, value: 'After' },
    });

    expect(receipt.dispatched).toBe(true);
    expect(receipt.status).toBe('dispatched_unverified');
    expect(receipt.effects).not.toContainEqual(
      expect.objectContaining({ kind: 'graph_changed', verified: true }),
    );
  });

  it('verifies target-correlated page feedback after a click', async () => {
    const action = observedEntity('test-creation', 'node-dealership', {
      name: 'Test Creation',
      capabilities: [{ kind: 'click' }],
    });
    const { runtime, session, created } = await setup(
      observation([action], {
        visibleText: 'Test Creation No dealership selected',
      }),
    );
    const before = await runtime.observe({ browserId: created.browserId });
    const target = before.view.structured.entities[0]!.ref;
    session.onAct = () => {
      session.current = observation([action], {
        visibleText: 'Test Creation Test Creation selected',
      });
    };

    const receipt = await runtime.act({
      browserId: created.browserId,
      expectedRevision: before.view.revision,
      action: { kind: 'click', target },
    });

    expect(receipt.status).toBe('verified');
    expect(receipt.effects).toContainEqual(
      expect.objectContaining({ kind: 'graph_changed', verified: true }),
    );
  });

  it('verifies newly observed validation feedback after a click', async () => {
    const submit = observedEntity('create-customer', 'node-submit', {
      name: 'Create customer',
      capabilities: [{ kind: 'click' }],
    });
    const field = observedEntity('vat-id', 'node-vat', {
      kind: 'input',
      role: 'textbox',
      name: 'VAT ID',
      state: { visible: true, enabled: true, invalid: false },
      capabilities: [{ kind: 'fill' }],
    });
    const { runtime, session, created } = await setup(
      observation([submit, field]),
    );
    const before = await runtime.observe({ browserId: created.browserId });
    const target = before.view.structured.entities.find(
      (entity) => entity.name === 'Create customer',
    )!.ref;
    session.onAct = () => {
      session.current = observation([
        submit,
        {
          ...field,
          state: { ...field.state, invalid: true },
          description: 'VAT ID has an invalid format.',
        },
        observedEntity('validation-alert', 'node-alert', {
          kind: 'status',
          role: 'alert',
          name: '1 field needs attention.',
          state: { visible: true, transient: true },
          capabilities: [],
        }),
      ]);
    };

    const receipt = await runtime.act({
      browserId: created.browserId,
      expectedRevision: before.view.revision,
      action: { kind: 'click', target },
    });

    expect(receipt.status).toBe('verified');
  });

  it('does not treat document replacement alone as proof of a field mutation', async () => {
    const cases: Array<{
      label: string;
      entity: DriverObservedEntity;
      action: (target: EntityRef) => BrowserAction;
    }> = [
      {
        label: 'fill',
        entity: observedEntity('customer-name', 'node-name', {
          kind: 'input',
          role: 'textbox',
          value: 'Before',
          capabilities: [{ kind: 'fill' }],
        }),
        action: (target) => ({ kind: 'fill', target, value: 'After' }),
      },
      {
        label: 'type',
        entity: observedEntity('customer-name', 'node-name', {
          kind: 'input',
          role: 'textbox',
          value: 'Before',
          capabilities: [{ kind: 'type' }],
        }),
        action: (target) => ({ kind: 'type', target, text: 'After' }),
      },
      {
        label: 'check',
        entity: observedEntity('priority-customer', 'node-checkbox', {
          kind: 'input',
          role: 'checkbox',
          state: { visible: true, enabled: true, checked: false },
          capabilities: [{ kind: 'check' }],
        }),
        action: (target) => ({ kind: 'check', target, checked: true }),
      },
    ];

    for (const testCase of cases) {
      const { runtime, session, created } = await setup(
        observation([testCase.entity], { documentId: 'document-1' }),
      );
      const before = await runtime.observe({ browserId: created.browserId });
      const target = before.view.structured.entities[0]!.ref;
      session.onAct = () => {
        session.current = observation([testCase.entity], {
          documentId: 'document-2',
        });
      };

      const receipt = await runtime.act({
        browserId: created.browserId,
        expectedRevision: before.view.revision,
        action: testCase.action(target),
      });

      expect.soft(receipt.status, testCase.label).toBe(
        'dispatched_unverified',
      );
      expect.soft(receipt.delta?.pageChanged, testCase.label).toBe(true);
      expect.soft(receipt.effects, testCase.label).toContainEqual(
        expect.objectContaining({
          kind: 'graph_changed',
          verified: false,
        }),
      );
    }
  });

  it('does not verify generic actions from focus-only or unrelated page changes', async () => {
    const cases: Array<{
      label: string;
      entities: DriverObservedEntity[];
      action: (targets: EntityRef[]) => BrowserAction;
    }> = [
      {
        label: 'click',
        entities: [
          observedEntity('open-customer', 'node-primary', {
            capabilities: [{ kind: 'click' }],
          }),
        ],
        action: ([target]) => ({ kind: 'click', target: target! }),
      },
      {
        label: 'double click',
        entities: [
          observedEntity('edit-ticket', 'node-primary', {
            capabilities: [{ kind: 'doubleClick' }],
          }),
        ],
        action: ([target]) => ({ kind: 'doubleClick', target: target! }),
      },
      {
        label: 'context click',
        entities: [
          observedEntity('order-row', 'node-primary', {
            capabilities: [{ kind: 'contextClick' }],
          }),
        ],
        action: ([target]) => ({ kind: 'contextClick', target: target! }),
      },
      {
        label: 'press',
        entities: [
          observedEntity('search', 'node-primary', {
            capabilities: [{ kind: 'press' }],
          }),
        ],
        action: ([target]) => ({ kind: 'press', target: target!, key: 'Enter' }),
      },
      {
        label: 'drag',
        entities: [
          observedEntity('appointment', 'node-primary', {
            capabilities: [{ kind: 'drag' }],
          }),
          observedEntity('empty-slot', 'node-destination', {
            capabilities: [],
          }),
        ],
        action: ([target, destination]) => ({
          kind: 'drag',
          target: target!,
          destination: destination!,
        }),
      },
      {
        label: 'upload',
        entities: [
          observedEntity('attachment', 'node-primary', {
            kind: 'input',
            capabilities: [{ kind: 'upload' }],
          }),
        ],
        action: ([target]) => ({
          kind: 'upload',
          target: target!,
          files: [
            {
              name: 'invoice.txt',
              mediaType: 'text/plain',
              data: new Uint8Array([1]),
            },
          ],
        }),
      },
    ];

    for (const testCase of cases) {
      for (const change of ['focus-only', 'unrelated-page'] as const) {
        const { runtime, session, created } = await setup(
          observation(testCase.entities),
        );
        const before = await runtime.observe({ browserId: created.browserId });
        const targets = testCase.entities.map((entity) => {
          const target = before.view.structured.entities.find(
            (candidate) => candidate.name === entity.name,
          )?.ref;
          if (!target) throw new Error(`missing ${entity.name}`);
          return target;
        });

        session.onAct = () => {
          session.current =
            change === 'focus-only'
              ? observation([
                  {
                    ...testCase.entities[0]!,
                    state: {
                      ...testCase.entities[0]!.state,
                      focused: true,
                    },
                  },
                  ...testCase.entities.slice(1),
                ])
              : observation(testCase.entities, {
                  visibleText: 'An unrelated dashboard tile refreshed.',
                });
        };

        const receipt = await runtime.act({
          browserId: created.browserId,
          expectedRevision: before.view.revision,
          action: testCase.action(targets),
        });

        expect.soft(receipt.status, `${testCase.label}/${change}`).toBe(
          'dispatched_unverified',
        );
        expect
          .soft(receipt.effects, `${testCase.label}/${change}`)
          .toContainEqual(
            expect.objectContaining({
              kind: 'graph_changed',
              verified: false,
            }),
          );
      }
    }
  });
});
