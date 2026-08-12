import {
  BrowserIRError,
  MAX_CAPTURE_BYTES,
  MAX_CAPTURE_PHYSICAL_PIXELS,
  type ActionReceipt,
  type BrowserCapture,
  type BrowserIRRuntime,
  type CompiledView,
  type ObservationResult,
  type UnsafeEvaluationReceipt,
} from '@browserir/core';
import { describe, expect, it, vi } from 'vitest';

import {
  createBrowserIrRuntimeService,
  type BrowserUnsafeEvaluateAuditRecord,
} from '../src/index.js';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const compiledView = (): CompiledView => ({
  browserId: 'browser-1',
  pageId: 'page-1',
  revision: 1,
  text:
    'Page: Customers\nURL: https://example.test/customers\nRevision: 1\n' +
    '[e1@r1] control role="button" name="Save" state=enabled=true,visible=true actions=click',
  truncated: false,
  structured: {
    page: { url: 'https://example.test/customers', title: 'Customers' },
    entities: [
      {
        ref: {
          browserId: 'browser-1',
          pageId: 'page-1',
          entityId: 'e1',
          revision: 1,
        },
        kind: 'control',
        role: 'button',
        name: 'Save',
        state: { visible: true, enabled: true },
        capabilities: [{ kind: 'click' }],
        evidence: [],
        confidence: 1,
      },
    ],
    relations: [],
    omissions: [],
  },
});

const observation = (): ObservationResult => ({
  snapshot: {
    browserId: 'browser-1',
    pageId: 'page-1',
    revision: 1,
    url: 'https://example.test/customers',
    title: 'Customers',
    entities: [],
    relations: [],
  },
  delta: {
    fromRevision: 0,
    toRevision: 1,
    pageChanged: true,
    added: [],
    removed: [],
    changed: [],
    addedRelations: [],
    removedRelations: [],
    invalidatedRefs: [],
  },
  view: compiledView(),
});

function fakeRuntime(): BrowserIRRuntime {
  return {
    create: vi.fn(async () => ({
      browserId: 'browser-1',
      initialPageId: 'page-1',
      revision: 0,
    })),
    navigate: vi.fn(async () => observation()),
    observe: vi.fn(async () => observation()),
    inspect: vi.fn(async () => compiledView()),
    act: vi.fn(async () => {
      const result: ActionReceipt = {
        status: 'verified',
        dispatched: true,
        preRevision: 1,
        postRevision: 2,
        effects: [{ kind: 'graph_changed', verified: true }],
      };
      return result;
    }),
    wait: vi.fn(async () => observation()),
    pages: vi.fn(async () => [
      {
        browserId: 'browser-1',
        pageId: 'page-1',
        revision: 1,
        url: 'https://example.test/customers',
        title: 'Customers',
      },
    ]),
    capture: vi.fn(async () => {
      const result: BrowserCapture = {
        browserId: 'browser-1',
        pageId: 'page-1',
        revision: 1,
        mediaType: 'image/png',
        data: new Uint8Array([1, 2, 3]),
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        scrollX: 0,
        scrollY: 0,
      };
      return result;
    }),
    evaluateUnsafe: vi.fn(async () => {
      const result: UnsafeEvaluationReceipt = {
        outcome: 'completed',
        dispatched: true,
        preRevision: 1,
        postRevision: 2,
        value: 2,
        outputBytes: 1,
        observation: observation(),
        postObservation: 'completed',
        openedPageIds: [],
      };
      return result;
    }),
    invalidateBrowser: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } as unknown as BrowserIRRuntime;
}

describe('BrowserIR runtime MCP service', () => {
  it('does not install unsafe evaluation unless an audited capability is configured', () => {
    const runtime = fakeRuntime();
    expect(createBrowserIrRuntimeService(runtime).evaluateUnsafe).toBeUndefined();
    expect(
      createBrowserIrRuntimeService(runtime, {
        unsafeEvaluate: { audit: vi.fn() },
      }).evaluateUnsafe,
    ).toBeTypeOf('function');
  });

  it('returns a redacted bounded receipt and emits source-free intent and completion audits', async () => {
    const runtime = fakeRuntime();
    const audits: BrowserUnsafeEvaluateAuditRecord[] = [];
    const mutatedObservation = observation();
    mutatedObservation.snapshot.revision = 2;
    mutatedObservation.delta = {
      ...mutatedObservation.delta,
      fromRevision: 1,
      toRevision: 2,
      stateInvalidated: true,
    };
    mutatedObservation.view = {
      ...mutatedObservation.view,
      revision: 2,
      text: mutatedObservation.view.text.replaceAll('Revision: 1', 'Revision: 2'),
    };
    runtime.evaluateUnsafe = vi.fn(async (): Promise<UnsafeEvaluationReceipt> => ({
      outcome: 'completed',
      dispatched: true,
      preRevision: 1,
      postRevision: 2,
      value: {
        password: 'runtime-password-secret',
        url: 'https://user:pass@example.test/customer?token=url-secret&tab=history',
        note: 'Bearer eyJhbGciOiJIUzI1NiJ9.secret.signature',
        safe: 'customer-42',
      },
      outputBytes: 180,
      observation: mutatedObservation,
      postObservation: 'completed',
      openedPageIds: ['page-2'],
    }));
    const service = createBrowserIrRuntimeService(runtime, {
      unsafeEvaluate: {
        audit: async (record) => {
          audits.push(record);
        },
      },
    });
    const source = 'document.body.dataset.password = "source-secret"; ({ safe: 1 })';

    const result = await service.evaluateUnsafe!(
      {
        browser_id: 'browser-1',
        page_id: 'page-1',
        expected_revision: 1,
        expression: source,
        timeout_ms: 400,
        max_output_bytes: 4096,
        max_tokens: 1024,
      },
      { signal: new AbortController().signal },
    );

    expect(result.is_error).not.toBe(true);
    expect(result.data).toMatchObject({
      browser_id: 'browser-1',
      page_id: 'page-1',
      outcome: 'completed',
      dispatched: true,
      pre_revision: 1,
      post_revision: 2,
      opened_page_ids: ['page-2'],
      result: {
        password: '[REDACTED]',
        safe: 'customer-42',
      },
      redaction_count: expect.any(Number),
      expression_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const serialized = JSON.stringify({ result, audits });
    expect(serialized).not.toContain('runtime-password-secret');
    expect(serialized).not.toContain('url-secret');
    expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(serialized).not.toContain('source-secret');
    expect(audits.map((record) => record.phase)).toEqual(['intent', 'completion']);
    expect(audits[0]?.operation_id).toBe(audits[1]?.operation_id);
    expect(audits[1]).toMatchObject({
      outcome: 'completed',
      dispatched: true,
      post_observation: 'completed',
      opened_page_ids: ['page-2'],
    });
    expect(JSON.stringify(audits)).not.toContain('customer-42');
    expect(runtime.evaluateUnsafe).toHaveBeenCalledWith(
      expect.objectContaining({
        browserId: 'browser-1',
        pageId: 'page-1',
        expectedRevision: 1,
        timeoutMs: 400,
        maxOutputBytes: expect.any(Number),
      }),
    );
  });

  it('blocks dispatch when the intent audit fails', async () => {
    const runtime = fakeRuntime();
    const service = createBrowserIrRuntimeService(runtime, {
      unsafeEvaluate: {
        audit: vi.fn(async () => {
          throw new Error('audit sink secret');
        }),
      },
    });

    await expect(
      service.evaluateUnsafe!({
        browser_id: 'browser-1',
        page_id: 'page-1',
        expected_revision: 1,
        expression: '1 + 1',
      }),
    ).rejects.toMatchObject({
      code: 'unsafe_evaluation_audit_failed',
      message: expect.not.stringContaining('secret'),
    });
    expect(runtime.evaluateUnsafe).not.toHaveBeenCalled();
  });

  it('fails closed when the completion audit cannot be recorded', async () => {
    const runtime = fakeRuntime();
    let auditCall = 0;
    const service = createBrowserIrRuntimeService(runtime, {
      unsafeEvaluate: {
        audit: vi.fn(async () => {
          auditCall += 1;
          if (auditCall === 2) throw new Error('completion sink failed');
        }),
      },
    });

    await expect(
      service.evaluateUnsafe!({
        browser_id: 'browser-1',
        page_id: 'page-1',
        expected_revision: 1,
        expression: '1 + 1',
      }),
    ).rejects.toMatchObject({ code: 'unsafe_evaluation_audit_failed' });
    expect(runtime.evaluateUnsafe).toHaveBeenCalledOnce();
    expect(runtime.invalidateBrowser).toHaveBeenCalledWith('browser-1');
  });

  it('aborts an active unsafe evaluation before service disposal waits for its queue', async () => {
    const runtime = fakeRuntime();
    let receivedSignal: AbortSignal | undefined;
    runtime.evaluateUnsafe = vi.fn(
      async (request): Promise<UnsafeEvaluationReceipt> => {
        receivedSignal = request.signal;
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted === true) resolve();
          else request.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          outcome: 'cancelled',
          dispatched: true,
          preRevision: 1,
          postRevision: 2,
          postObservation: 'completed',
          openedPageIds: [],
          terminationAttempted: true,
          terminationConfirmed: true,
        };
      },
    );
    const audits: BrowserUnsafeEvaluateAuditRecord[] = [];
    const service = createBrowserIrRuntimeService(runtime, {
      unsafeEvaluate: {
        audit: (record) => {
          audits.push(record);
        },
      },
    });

    const pending = service.evaluateUnsafe!({
      browser_id: 'browser-1',
      page_id: 'page-1',
      expected_revision: 1,
      expression: 'new Promise(() => {})',
    });
    await nextTurn();
    const disposing = service.dispose!();

    await expect(pending).resolves.toMatchObject({
      is_error: true,
      data: { outcome: 'cancelled', termination_confirmed: true },
    });
    await expect(disposing).resolves.toBeUndefined();
    expect(receivedSignal?.aborted).toBe(true);
    expect(audits.map((record) => record.phase)).toEqual(['intent', 'completion']);
  });

  it('maps stable browser profile options and returns opaque MCP handles', async () => {
    const runtime = fakeRuntime();
    const service = createBrowserIrRuntimeService(runtime);

    const result = await service.create({
      viewport: { width: 1440, height: 900, device_scale_factor: 1 },
      locale: 'en-US',
      timezone_id: 'UTC',
      color_scheme: 'light',
      reduced_motion: true,
    });

    expect(runtime.create).toHaveBeenCalledWith({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    });
    expect(result.data).toEqual({
      browser_id: 'browser-1',
      page_id: 'page-1',
      revision: 0,
    });
  });

  it('bounds concurrently owned and in-flight browsers for one MCP connection', async () => {
    const runtime = fakeRuntime();
    const createMayFinish = deferred();
    let nextBrowser = 0;
    runtime.create = vi.fn(async () => {
      await createMayFinish.promise;
      nextBrowser += 1;
      return {
        browserId: `browser-${nextBrowser}`,
        initialPageId: 'page-1',
        revision: 0,
      };
    });
    const service = createBrowserIrRuntimeService(runtime, {
      maxBrowsersPerConnection: 1,
    });

    const first = service.create({});
    await nextTurn();
    await expect(service.create({})).rejects.toMatchObject({
      code: 'resource_limit',
      message: expect.stringContaining('1-browser connection limit'),
    });
    expect(runtime.create).toHaveBeenCalledOnce();

    createMayFinish.resolve();
    const firstResult = await first;
    await expect(service.create({})).rejects.toMatchObject({
      code: 'resource_limit',
    });
    await service.close({
      browser_id: String(firstResult.data.browser_id),
    });
    await expect(service.create({})).resolves.toMatchObject({
      data: { browser_id: 'browser-2' },
    });
  });

  it('preserves expected revisions and emits one canonical budgeted model view', async () => {
    const runtime = fakeRuntime();
    const service = createBrowserIrRuntimeService(runtime);

    const result = await service.navigate({
      browser_id: 'browser-1',
      page_id: 'page-1',
      url: 'https://example.test/customers',
      expected_revision: 0,
      max_tokens: 512,
    });

    expect(runtime.navigate).toHaveBeenCalledWith({
      browserId: 'browser-1',
      pageId: 'page-1',
      url: 'https://example.test/customers',
      expectedRevision: 0,
      budget: { maxCharacters: 1536 },
    });
    expect(result.summary).toContain('[e1@r1]');
    expect(result.data).toMatchObject({
      browser_id: 'browser-1',
      page_id: 'page-1',
      revision: 1,
      truncated: false,
      omissions: [],
      changes: {
        from_revision: 0,
        to_revision: 1,
        added: [],
      },
    });
    expect(result.data).not.toHaveProperty('view');
    expect(result.data).not.toHaveProperty('delta');
  });

  it('maps MCP action names and refs to the core action contract', async () => {
    const runtime = fakeRuntime();
    const service = createBrowserIrRuntimeService(runtime);

    const result = await service.act({
      browser_id: 'browser-1',
      page_id: 'page-1',
      expected_revision: 1,
      max_tokens: 256,
      kind: 'double_click',
      target_ref: 'e1@r1',
    });

    expect(runtime.act).toHaveBeenCalledWith({
      browserId: 'browser-1',
      pageId: 'page-1',
      expectedRevision: 1,
      budget: { maxCharacters: 768 },
      action: {
        kind: 'doubleClick',
        target: {
          browserId: 'browser-1',
          pageId: 'page-1',
          entityId: 'e1',
          revision: 1,
        },
      },
    });
    expect(result.data).toEqual({
      browser_id: 'browser-1',
      page_id: 'page-1',
      status: 'verified',
      dispatched: true,
      pre_revision: 1,
      post_revision: 2,
      effects: [{ kind: 'graph_changed', verified: true }],
    });
  });

  it('resolves an omitted action page to the only open page', async () => {
    const runtime = fakeRuntime();
    const service = createBrowserIrRuntimeService(runtime);

    await service.act({
      browser_id: 'browser-1',
      expected_revision: 1,
      kind: 'fill',
      target_ref: 'e1@r1',
      value: 'Updated',
    });

    expect(runtime.pages).toHaveBeenCalledWith({ browserId: 'browser-1' });
    expect(runtime.act).toHaveBeenCalledWith({
      browserId: 'browser-1',
      pageId: 'page-1',
      expectedRevision: 1,
      budget: { maxCharacters: 12_000 },
      action: {
        kind: 'fill',
        target: {
          browserId: 'browser-1',
          pageId: 'page-1',
          entityId: 'e1',
          revision: 1,
        },
        value: 'Updated',
      },
    });
  });

  it('uses an explicit top-level action page without consulting open-page inference', async () => {
    const runtime = fakeRuntime();
    runtime.pages = vi.fn(async () => [
      { browserId: 'browser-1', pageId: 'page-1', revision: 1, url: 'https://example.test' },
      { browserId: 'browser-1', pageId: 'page-2', revision: 1, url: 'https://example.test/2' },
    ]);
    const service = createBrowserIrRuntimeService(runtime);

    await service.act({
      browser_id: 'browser-1',
      page_id: 'page-2',
      expected_revision: 1,
      kind: 'click',
      target_ref: 'e2@r1',
    });

    expect(runtime.pages).not.toHaveBeenCalled();
    expect(runtime.act).toHaveBeenCalledWith({
      browserId: 'browser-1',
      pageId: 'page-2',
      expectedRevision: 1,
      budget: { maxCharacters: 12_000 },
      action: {
        kind: 'click',
        target: {
          browserId: 'browser-1',
          pageId: 'page-2',
          entityId: 'e2',
          revision: 1,
        },
      },
    });
  });

  it('keeps an explicit top-level action page in the translated ref', async () => {
    const runtime = fakeRuntime();
    runtime.pages = vi.fn(async () => []);
    const service = createBrowserIrRuntimeService(runtime);

    await service.act({
      browser_id: 'browser-1',
      page_id: 'page-2',
      expected_revision: 1,
      kind: 'click',
      target_ref: 'e2@r1',
    });

    expect(runtime.pages).not.toHaveBeenCalled();
    expect(runtime.act).toHaveBeenCalledWith(
      expect.objectContaining({
        browserId: 'browser-1',
        pageId: 'page-2',
        action: expect.objectContaining({
          target: expect.objectContaining({ pageId: 'page-2' }),
        }),
      }),
    );
  });

  it('routes cross-page drag source and destination refs independently', async () => {
    const runtime = fakeRuntime();
    runtime.pages = vi.fn(async () => [
      { browserId: 'browser-1', pageId: 'page-1', revision: 1, url: 'https://example.test' },
      { browserId: 'browser-1', pageId: 'page-2', revision: 1, url: 'https://example.test/2' },
    ]);
    const service = createBrowserIrRuntimeService(runtime);

    await service.act({
      browser_id: 'browser-1',
      page_id: 'page-1',
      expected_revision: 1,
      kind: 'drag',
      source_ref: 'e1@r1',
      destination_page_id: 'page-2',
      destination_ref: 'e2@r1',
    });

    expect(runtime.pages).not.toHaveBeenCalled();
    expect(runtime.act).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: 'page-1',
        action: {
          kind: 'drag',
          target: expect.objectContaining({ pageId: 'page-1', entityId: 'e1' }),
          destination: expect.objectContaining({ pageId: 'page-2', entityId: 'e2' }),
        },
      }),
    );
  });

  it('never treats a drag destination page as an omitted source page', async () => {
    const runtime = fakeRuntime();
    runtime.pages = vi.fn(async () => [
      { browserId: 'browser-1', pageId: 'page-1', revision: 1, url: 'https://example.test' },
      { browserId: 'browser-1', pageId: 'page-2', revision: 1, url: 'https://example.test/2' },
    ]);
    const service = createBrowserIrRuntimeService(runtime);

    await expect(
      service.act({
        browser_id: 'browser-1',
        expected_revision: 1,
        kind: 'drag',
        source_ref: 'e1@r1',
        destination_page_id: 'page-2',
        destination_ref: 'e2@r1',
      }),
    ).rejects.toMatchObject({ code: 'ambiguous_page' });
    expect(runtime.act).not.toHaveBeenCalled();
  });

  it('rejects an omitted action page when more than one page is open', async () => {
    const runtime = fakeRuntime();
    runtime.pages = vi.fn(async () => [
      { browserId: 'browser-1', pageId: 'page-1', revision: 1, url: 'https://example.test' },
      { browserId: 'browser-1', pageId: 'page-2', revision: 1, url: 'https://example.test/2' },
    ]);
    const service = createBrowserIrRuntimeService(runtime);

    await expect(
      service.act({
        browser_id: 'browser-1',
        expected_revision: 1,
        kind: 'click',
        target_ref: 'e1@r1',
      }),
    ).rejects.toMatchObject({ code: 'ambiguous_page' });
    expect(runtime.act).not.toHaveBeenCalled();
  });

  it('rejects a page-less action when no page is open', async () => {
    const runtime = fakeRuntime();
    runtime.pages = vi.fn(async () => []);
    const service = createBrowserIrRuntimeService(runtime);

    await expect(
      service.act({
        browser_id: 'browser-1',
        expected_revision: 1,
        kind: 'click',
        target_ref: 'e1@r1',
      }),
    ).rejects.toMatchObject({ code: 'unknown_page' });
    expect(runtime.act).not.toHaveBeenCalled();
  });

  it('serializes action deltas once without repeating full entity payloads', async () => {
    const runtime = fakeRuntime();
    const deltaEntity = {
      id: 'e-added',
      pageId: 'page-1',
      kind: 'control' as const,
      role: 'button',
      name: 'Created',
      description: 'delta-only-sentinel',
      state: { visible: true, enabled: true },
      capabilities: [{ kind: 'click' as const }],
      evidence: [],
      confidence: 1,
    };
    const observed = observation();
    observed.delta = {
      fromRevision: 1,
      toRevision: 2,
      pageChanged: false,
      added: [deltaEntity],
      removed: [],
      changed: [],
      addedRelations: [],
      removedRelations: [],
      invalidatedRefs: [],
    };
    runtime.act = vi.fn(async (): Promise<ActionReceipt> => ({
      status: 'verified',
      dispatched: true,
      preRevision: 1,
      postRevision: 2,
      effects: [{ kind: 'graph_changed', verified: true }],
      delta: observed.delta,
      observation: observed,
    }));
    const service = createBrowserIrRuntimeService(runtime);

    const result = await service.act({
      browser_id: 'browser-1',
      page_id: 'page-1',
      expected_revision: 1,
      kind: 'click',
      target_ref: 'e1@r1',
    });

    expect(result.data).toMatchObject({
      browser_id: 'browser-1',
      page_id: 'page-1',
      changes: { added: ['e-added'] },
      revision: 1,
      truncated: false,
      omissions: [],
    });
    expect(result.data).not.toHaveProperty('observation');
    expect(result.data).not.toHaveProperty('delta');
    expect(JSON.stringify(result.data)).not.toContain('delta-only-sentinel');
  });

  it('returns a compact delta-first receipt for a proven value-only action', async () => {
    const runtime = fakeRuntime();
    const observed = observation();
    const changedEntity = {
      id: 'e1',
      pageId: 'page-1',
      kind: 'input' as const,
      role: 'textbox',
      name: 'Customer name',
      value: 'Steinweg Logistik GmbH',
      state: { visible: true, enabled: true },
      capabilities: [{ kind: 'fill' as const }],
      evidence: [],
      confidence: 1,
    };
    observed.delta = {
      fromRevision: 1,
      toRevision: 2,
      pageChanged: false,
      added: [],
      removed: [],
      changed: [{ entity: changedEntity, changedFields: ['value'] }],
      addedRelations: [],
      removedRelations: [],
      invalidatedRefs: ['e1'],
      rebindableRefs: ['e1'],
    };
    observed.snapshot.revision = 2;
    observed.snapshot.entities = [changedEntity];
    observed.view = {
      ...compiledView(),
      revision: 2,
      text:
        'Page: Customers\nURL: https://example.test/customers\nRevision: 2\n' +
        '[e1@r2] input role="textbox" name="Customer name" ' +
        'value="UNRELATED_FULL_VIEW_SENTINEL" actions=fill',
      structured: {
        ...compiledView().structured,
        entities: [
          {
            ref: {
              browserId: 'browser-1',
              pageId: 'page-1',
              entityId: 'e0',
              revision: 2,
            },
            kind: 'input',
            role: 'textbox',
            name: 'Already completed field',
            value: 'PRIOR_VALUE_MUST_NOT_REPEAT',
            state: { visible: true, enabled: true },
            capabilities: [{ kind: 'fill' }],
            evidence: [],
            confidence: 1,
          },
          {
            ref: {
              browserId: 'browser-1',
              pageId: 'page-1',
              entityId: 'e1',
              revision: 2,
            },
            kind: 'input',
            role: 'textbox',
            name: 'Customer name',
            value: 'UNRELATED_FULL_VIEW_SENTINEL',
            state: { visible: true, enabled: true },
            capabilities: [{ kind: 'fill' }],
            evidence: [],
            confidence: 1,
          },
          {
            ref: {
              browserId: 'browser-1',
              pageId: 'page-1',
              entityId: 'e2',
              revision: 2,
            },
            kind: 'input',
            role: 'textbox',
            name: 'City',
            value: '',
            state: { visible: true, enabled: true },
            capabilities: [{ kind: 'fill' }],
            evidence: [],
            confidence: 1,
          },
          {
            ref: {
              browserId: 'browser-1',
              pageId: 'page-1',
              entityId: 'e3',
              revision: 2,
            },
            kind: 'control',
            role: 'button',
            name: 'Create customer',
            state: { visible: true, enabled: true },
            capabilities: [{ kind: 'click' }],
            evidence: [],
            confidence: 1,
          },
          {
            ref: {
              browserId: 'browser-1',
              pageId: 'page-1',
              entityId: 'e4',
              revision: 2,
            },
            kind: 'control',
            name: 'Custom cell editor',
            state: { visible: true, enabled: true },
            capabilities: [{ kind: 'click' }, { kind: 'doubleClick' }],
            evidence: [],
            confidence: 0.9,
          },
          {
            ref: {
              browserId: 'browser-1',
              pageId: 'page-1',
              entityId: 'e4',
              revision: 2,
            },
            kind: 'control',
            role: 'link',
            name: 'Unrelated navigation',
            state: { visible: true, enabled: true },
            capabilities: [{ kind: 'click' }],
            evidence: [],
            confidence: 1,
          },
          {
            ref: {
              browserId: 'browser-1',
              pageId: 'page-1',
              entityId: 'e5',
              revision: 2,
            },
            kind: 'input',
            role: 'textbox',
            name: 'Hidden decoy',
            state: { visible: false, enabled: true },
            capabilities: [{ kind: 'fill' }],
            evidence: [],
            confidence: 1,
          },
        ],
      },
    };
    runtime.act = vi.fn(async (): Promise<ActionReceipt> => ({
      status: 'verified',
      dispatched: true,
      preRevision: 1,
      postRevision: 2,
      effects: [{ kind: 'graph_changed', verified: true }],
      delta: observed.delta,
      observation: observed,
    }));
    const service = createBrowserIrRuntimeService(runtime);

    const result = await service.act({
      browser_id: 'browser-1',
      page_id: 'page-1',
      expected_revision: 1,
      kind: 'fill',
      target_ref: 'e1@r1',
      value: 'Steinweg Logistik GmbH',
    });

    expect(result.summary).toContain('Delta only');
    expect(result.summary).not.toContain('UNRELATED_FULL_VIEW_SENTINEL');
    expect(result.data).toMatchObject({
      representation: 'delta',
      post_revision: 2,
      changes: { rebindable_refs: ['e1'] },
      actionable_context: {
        page_id: 'page-1',
        revision: 2,
        targets: [
          {
            target_ref: 'e2@r2',
            kind: 'input',
            role: 'textbox',
            name: 'City',
            value_present: false,
            actions: ['fill'],
          },
          {
            target_ref: 'e3@r2',
            kind: 'control',
            role: 'button',
            name: 'Create customer',
            actions: ['click'],
          },
          {
            target_ref: 'e4@r2',
            kind: 'control',
            name: 'Custom cell editor',
            actions: ['click', 'doubleClick'],
          },
        ],
        omitted: 0,
      },
    });
    expect(result.summary).toContain('Continue with fresh actionable_context target_ref tokens');
    expect(JSON.stringify(result.data)).not.toContain('Already completed field');
    expect(JSON.stringify(result.data)).not.toContain('PRIOR_VALUE_MUST_NOT_REPEAT');
    expect(JSON.stringify(result.data)).not.toContain('Unrelated navigation');
    expect(JSON.stringify(result.data)).not.toContain('Hidden decoy');
    expect(JSON.stringify({ summary: result.summary, data: result.data }).length).toBeLessThan(
      2_500,
    );
  });

  it('orders a misaligned visual row left to right without fuzzy row chaining', async () => {
    const runtime = fakeRuntime();
    const observed = observation();
    const changedEntity = {
      id: 'e1',
      pageId: 'page-1',
      kind: 'input' as const,
      role: 'combobox',
      name: 'Status',
      value: 'In stock',
      state: { visible: true, enabled: true },
      geometry: { x: 100, y: 106, width: 120, height: 30 },
      capabilities: [{ kind: 'select' as const }],
      evidence: [],
      confidence: 1,
    };
    observed.delta = {
      fromRevision: 1,
      toRevision: 2,
      pageChanged: false,
      added: [],
      removed: [],
      changed: [{ entity: changedEntity, changedFields: ['value'] }],
      addedRelations: [],
      removedRelations: [],
      invalidatedRefs: ['e1'],
      rebindableRefs: ['e1'],
    };
    observed.view = {
      ...compiledView(),
      revision: 2,
      structured: {
        ...compiledView().structured,
        entities: [
          {
            ref: {
              browserId: 'browser-1',
              pageId: 'page-1',
              entityId: 'e1',
              revision: 2,
            },
            kind: 'input',
            role: 'combobox',
            name: 'Status',
            value: 'In stock',
            state: { visible: true, enabled: true },
            geometry: { x: 100, y: 106, width: 120, height: 30 },
            capabilities: [{ kind: 'select' }],
            evidence: [],
            confidence: 1,
          },
          {
            ref: {
              browserId: 'browser-1',
              pageId: 'page-1',
              entityId: 'e2',
              revision: 2,
            },
            kind: 'control',
            role: 'button',
            name: 'Apply',
            state: { visible: true, enabled: true },
            geometry: { x: 240, y: 100, width: 80, height: 34 },
            capabilities: [{ kind: 'click' }],
            evidence: [],
            confidence: 1,
          },
          {
            ref: {
              browserId: 'browser-1',
              pageId: 'page-1',
              entityId: 'e3',
              revision: 2,
            },
            kind: 'input',
            role: 'textbox',
            name: 'Next visual row',
            value: '',
            state: { visible: true, enabled: true },
            geometry: { x: 20, y: 110, width: 120, height: 30 },
            capabilities: [{ kind: 'fill' }],
            evidence: [],
            confidence: 1,
          },
        ],
      },
    };
    runtime.act = vi.fn(async (): Promise<ActionReceipt> => ({
      status: 'verified',
      dispatched: true,
      preRevision: 1,
      postRevision: 2,
      effects: [{ kind: 'graph_changed', verified: true }],
      delta: observed.delta,
      observation: observed,
    }));
    const service = createBrowserIrRuntimeService(runtime);

    const result = await service.act({
      browser_id: 'browser-1',
      page_id: 'page-1',
      expected_revision: 1,
      kind: 'select',
      target_ref: 'e1@r1',
      values: ['In stock'],
    });

    expect(result.data).toMatchObject({
      actionable_context: {
        targets: [
          expect.objectContaining({ target_ref: 'e2@r2', name: 'Apply' }),
          expect.objectContaining({ target_ref: 'e3@r2', name: 'Next visual row' }),
        ],
      },
    });
  });

  it('bounds actionable continuation context across a large positioned view', async () => {
    const actionableTargetCount = 5_000;
    const runtime = fakeRuntime();
    const observed = observation();
    const changedEntity = {
      id: 'e1',
      pageId: 'page-1',
      kind: 'input' as const,
      role: 'textbox',
      name: 'Current field',
      value: 'done',
      state: { visible: true, enabled: true },
      geometry: { x: 0, y: 0, width: 120, height: 30 },
      capabilities: [{ kind: 'fill' as const }],
      evidence: [],
      confidence: 1,
    };
    observed.delta = {
      fromRevision: 1,
      toRevision: 2,
      pageChanged: false,
      added: [],
      removed: [],
      changed: [{ entity: changedEntity, changedFields: ['value'] }],
      addedRelations: [],
      removedRelations: [],
      invalidatedRefs: ['e1'],
      rebindableRefs: ['e1'],
    };
    observed.view = {
      ...compiledView(),
      revision: 2,
      structured: {
        ...compiledView().structured,
        entities: [
          {
            ref: {
              browserId: 'browser-1',
              pageId: 'page-1',
              entityId: 'e1',
              revision: 2,
            },
            kind: 'input',
            role: 'textbox',
            name: 'Current field',
            value: 'done',
            state: { visible: true, enabled: true },
            geometry: { x: 0, y: 0, width: 120, height: 30 },
            capabilities: [{ kind: 'fill' }],
            evidence: [],
            confidence: 1,
          },
          ...Array.from({ length: actionableTargetCount }, (_, index) => ({
            ref: {
              browserId: 'browser-1',
              pageId: 'page-1',
              entityId: `next-${index}`,
              revision: 2,
            },
            kind: 'input' as const,
            role: 'textbox',
            name: `Next field ${index} ${'x'.repeat(80)}`,
            value: '',
            state: { visible: true, enabled: true },
            geometry: { x: 0, y: (index + 1) * 40, width: 120, height: 30 },
            capabilities: [{ kind: 'fill' as const }],
            evidence: [],
            confidence: 1,
          })),
        ],
      },
    };
    runtime.act = vi.fn(async (): Promise<ActionReceipt> => ({
      status: 'verified',
      dispatched: true,
      preRevision: 1,
      postRevision: 2,
      effects: [{ kind: 'graph_changed', verified: true }],
      delta: observed.delta,
      observation: observed,
    }));
    const service = createBrowserIrRuntimeService(runtime);

    const result = await service.act({
      browser_id: 'browser-1',
      page_id: 'page-1',
      expected_revision: 1,
      max_tokens: 256,
      kind: 'fill',
      target_ref: 'e1@r1',
      value: 'done',
    });

    const context = result.data.actionable_context as
      | { targets: unknown[]; omitted: number }
      | undefined;
    expect(context).toEqual({
      page_id: 'page-1',
      revision: 2,
      targets: [],
      omitted: actionableTargetCount,
    });
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(128);
    expect(JSON.stringify({ summary: result.summary, data: result.data }).length).toBeLessThanOrEqual(
      1_024,
    );
    expect(result.summary).toContain('omitted by the response budget');
  });

  it('bounds the complete tool result and reports omitted changes for a large delta', async () => {
    const runtime = fakeRuntime();
    const observed = observation();
    observed.delta = {
      fromRevision: 0,
      toRevision: 1,
      pageChanged: false,
      added: [],
      removed: Array.from(
        { length: 400 },
        (_, index) => `removed-entity-${index.toString().padStart(4, '0')}-${'x'.repeat(48)}`,
      ),
      changed: [],
      addedRelations: [],
      removedRelations: [],
      invalidatedRefs: [],
    };
    runtime.observe = vi.fn(async () => observed);
    const service = createBrowserIrRuntimeService(runtime);
    const maxTokens = 256;

    const result = await service.observe({
      browser_id: 'browser-1',
      page_id: 'page-1',
      max_tokens: maxTokens,
    });

    const completeModelResult = JSON.stringify({
      summary: result.summary,
      data: result.data,
    });
    const omissions = Array.isArray(result.data.omissions) ? result.data.omissions : [];
    const omittedChanges = omissions.find(
      (omission) =>
        typeof omission === 'object' &&
        omission !== null &&
        'kind' in omission &&
        omission.kind === 'changes',
    );

    expect.soft(completeModelResult.length).toBeLessThanOrEqual(maxTokens * 4);
    expect.soft(result.data.truncated).toBe(true);
    expect(omittedChanges).toMatchObject({
      kind: 'changes',
      reason: 'budget',
    });
    expect(
      typeof omittedChanges === 'object' &&
        omittedChanges !== null &&
        'count' in omittedChanges &&
        typeof omittedChanges.count === 'number'
        ? omittedChanges.count
        : 0,
    ).toBeGreaterThan(0);
  });

  it('reports omitted action changes even when no post-action observation is available', async () => {
    const runtime = fakeRuntime();
    const observed = observation();
    observed.delta.removed = Array.from(
      { length: 400 },
      (_, index) => `removed-action-entity-${index.toString().padStart(4, '0')}`,
    );
    runtime.act = vi.fn(async (): Promise<ActionReceipt> => ({
      status: 'dispatched_unverified',
      dispatched: true,
      preRevision: 1,
      postRevision: 2,
      effects: [],
      delta: observed.delta,
    }));
    const service = createBrowserIrRuntimeService(runtime);

    const result = await service.act({
      browser_id: 'browser-1',
      page_id: 'page-1',
      expected_revision: 1,
      max_tokens: 256,
      kind: 'click',
      target_ref: 'e1@r1',
    });

    expect(result.data.truncated).toBe(true);
    expect(result.data.omissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'changes', reason: 'budget' }),
      ]),
    );
  });

  it('uses the observed current revision when an action receipt carries a conflicting post revision', async () => {
    const runtime = fakeRuntime();
    const observed = observation();
    observed.view.revision = 3;
    observed.snapshot.revision = 3;
    observed.delta = {
      ...observed.delta,
      fromRevision: 1,
      toRevision: 3,
    };
    runtime.act = vi.fn(async (): Promise<ActionReceipt> => ({
      status: 'verified',
      dispatched: true,
      preRevision: 1,
      postRevision: 2,
      effects: [{ kind: 'graph_changed', verified: true }],
      delta: observed.delta,
      observation: observed,
    }));
    const service = createBrowserIrRuntimeService(runtime);

    const result = await service.act({
      browser_id: 'browser-1',
      page_id: 'page-1',
      expected_revision: 1,
      kind: 'click',
      target_ref: 'e1@r1',
    });

    expect(result.data.revision).toBe(3);
    const exposedCurrentRevisions = [
      result.data.revision,
      result.data.post_revision,
      (result.data.changes as Record<string, unknown> | undefined)?.to_revision,
    ].filter((revision): revision is number => typeof revision === 'number');
    expect(new Set(exposedCurrentRevisions)).toEqual(new Set([3]));
  });

  it('does not expose raw action error messages through the MCP result', async () => {
    const runtime = fakeRuntime();
    const secretSentinel = 'SECRET-RUNTIME-DETAIL-user@example.test-bearer-token';
    runtime.act = vi.fn(async (): Promise<ActionReceipt> => ({
      status: 'blocked',
      dispatched: false,
      preRevision: 1,
      effects: [],
      error: {
        code: 'driver_rejected_action',
        message: secretSentinel,
      },
    }));
    const service = createBrowserIrRuntimeService(runtime);

    const result = await service.act({
      browser_id: 'browser-1',
      page_id: 'page-1',
      expected_revision: 1,
      kind: 'click',
      target_ref: 'e1@r1',
    });

    expect(result.data.error).toMatchObject({ code: 'driver_rejected_action' });
    expect(JSON.stringify(result)).not.toContain(secretSentinel);
  });

  it('forwards wait budgets and detailed inspection evidence explicitly', async () => {
    const runtime = fakeRuntime();
    const service = createBrowserIrRuntimeService(runtime);

    await service.wait({
      browser_id: 'browser-1',
      page_id: 'page-1',
      expected_revision: 1,
      kind: 'revision_change',
      max_tokens: 300,
    });
    await service.inspect({
      browser_id: 'browser-1',
      page_id: 'page-1',
      entity_ids: ['e1'],
      expected_revision: 1,
      max_tokens: 400,
      include_evidence: true,
    });

    expect(runtime.wait).toHaveBeenCalledWith({
      browserId: 'browser-1',
      pageId: 'page-1',
      expectedRevision: 1,
      condition: { kind: 'revision_after', revision: 1 },
      budget: { maxCharacters: 900 },
    });
    expect(runtime.inspect).toHaveBeenCalledWith({
      browserId: 'browser-1',
      pageId: 'page-1',
      refs: [
        {
          browserId: 'browser-1',
          pageId: 'page-1',
          entityId: 'e1',
          revision: 1,
        },
      ],
      budget: { maxCharacters: 1200 },
      includeEvidence: true,
    });
  });

  it('maps the advertised settled wait condition to the core runtime', async () => {
    const runtime = fakeRuntime();
    const service = createBrowserIrRuntimeService(runtime);

    await service.wait({
      browser_id: 'browser-1',
      page_id: 'page-1',
      expected_revision: 1,
      kind: 'settled',
      timeout_ms: 2_000,
    });

    expect(runtime.wait).toHaveBeenCalledWith({
      browserId: 'browser-1',
      pageId: 'page-1',
      expectedRevision: 1,
      condition: { kind: 'settled' },
      timeoutMs: 2_000,
      budget: { maxCharacters: 12_000 },
    });
  });

  it('maps a flat revision-bound entity-state wait to the core runtime', async () => {
    const runtime = fakeRuntime();
    const service = createBrowserIrRuntimeService(runtime);

    await service.wait({
      browser_id: 'browser-1',
      page_id: 'page-1',
      expected_revision: 3,
      kind: 'entity_state',
      target_ref: 'e9@r3',
      state: 'disabled',
    });

    expect(runtime.wait).toHaveBeenCalledWith({
      browserId: 'browser-1',
      pageId: 'page-1',
      expectedRevision: 3,
      condition: {
        kind: 'entity_state',
        target: {
          browserId: 'browser-1',
          pageId: 'page-1',
          entityId: 'e9',
          revision: 3,
        },
        state: { enabled: false },
      },
      budget: { maxCharacters: 12_000 },
    });
  });

  it('fails explicitly instead of guessing when inspection spans multiple pages', async () => {
    const runtime = fakeRuntime();
    runtime.pages = vi.fn(async () => [
      {
        browserId: 'browser-1',
        pageId: 'page-1',
        revision: 1,
        url: 'https://example.test/customers',
      },
      {
        browserId: 'browser-1',
        pageId: 'page-2',
        revision: 1,
        url: 'https://example.test/print',
      },
    ]);
    const service = createBrowserIrRuntimeService(runtime);

    await expect(
      service.inspect({
        browser_id: 'browser-1',
        entity_ids: ['e1'],
        expected_revision: 1,
      }),
    ).rejects.toMatchObject({
      code: 'ambiguous_page',
    });
    expect(runtime.inspect).not.toHaveBeenCalled();
  });

  it('enforces expected revisions for inspection and close', async () => {
    const runtime = fakeRuntime();
    const service = createBrowserIrRuntimeService(runtime);

    await expect(
      service.inspect({
        browser_id: 'browser-1',
        page_id: 'page-1',
        entity_ids: ['e1'],
        expected_revision: 0,
      }),
    ).rejects.toMatchObject({ code: 'stale_revision' });

    await expect(
      service.close({
        browser_id: 'browser-1',
        page_id: 'page-1',
        expected_revision: 0,
      }),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    expect(runtime.close).not.toHaveBeenCalled();
  });

  it('returns revision-bound screenshot bytes as an MCP image', async () => {
    const runtime = fakeRuntime();
    const service = createBrowserIrRuntimeService(runtime);

    const result = await service.capture({
      browser_id: 'browser-1',
      page_id: 'page-1',
      expected_revision: 1,
      kind: 'viewport',
      format: 'png',
    });

    expect(runtime.observe).toHaveBeenCalledWith({
      browserId: 'browser-1',
      pageId: 'page-1',
    });
    expect(runtime.capture).toHaveBeenCalledWith({
      browserId: 'browser-1',
      pageId: 'page-1',
      expectedRevision: 1,
      kind: 'viewport',
    });
    expect(result.image).toEqual({
      data: Buffer.from([1, 2, 3]).toString('base64'),
      mime_type: 'image/png',
    });
    expect(result.data).toMatchObject({
      browser_id: 'browser-1',
      page_id: 'page-1',
      revision: 1,
      width: 1440,
      height: 900,
      device_scale_factor: 1,
    });
  });

  it('rejects oversized encoded images before base64 MCP serialization', async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.capture).mockResolvedValue({
      browserId: 'browser-1',
      pageId: 'page-1',
      revision: 1,
      mediaType: 'image/png',
      data: new Uint8Array(MAX_CAPTURE_BYTES + 1),
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      scrollX: 0,
      scrollY: 0,
    });
    const service = createBrowserIrRuntimeService(runtime);

    await expect(
      service.capture({
        browser_id: 'browser-1',
        page_id: 'page-1',
        expected_revision: 1,
        kind: 'viewport',
      }),
    ).rejects.toMatchObject({
      code: 'capture_too_large',
      message: expect.stringContaining('encoded-image limit'),
    });
  });

  it('rejects oversized physical captures before MCP serialization', async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.capture).mockResolvedValue({
      browserId: 'browser-1',
      pageId: 'page-1',
      revision: 1,
      mediaType: 'image/png',
      data: new Uint8Array([1, 2, 3]),
      width: MAX_CAPTURE_PHYSICAL_PIXELS + 1,
      height: 1,
      deviceScaleFactor: 1,
      scrollX: 0,
      scrollY: 0,
    });
    const service = createBrowserIrRuntimeService(runtime);

    await expect(
      service.capture({
        browser_id: 'browser-1',
        page_id: 'page-1',
        expected_revision: 1,
        kind: 'viewport',
      }),
    ).rejects.toMatchObject({
      code: 'capture_too_large',
      message: expect.stringContaining('physical-pixel limit'),
    });
  });

  it('rejects invalid capture geometry before MCP serialization', async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.capture).mockResolvedValue({
      browserId: 'browser-1',
      pageId: 'page-1',
      revision: 1,
      mediaType: 'image/png',
      data: new Uint8Array([1, 2, 3]),
      width: 1440,
      height: 900,
      deviceScaleFactor: 0,
      scrollX: 0,
      scrollY: 0,
    });
    const service = createBrowserIrRuntimeService(runtime);

    await expect(
      service.capture({
        browser_id: 'browser-1',
        page_id: 'page-1',
        expected_revision: 1,
        kind: 'viewport',
      }),
    ).rejects.toMatchObject({
      code: 'capture_invalid',
      message: expect.stringContaining('geometry'),
    });
  });

  it('infers an entity crop when a capture target is supplied', async () => {
    const runtime = fakeRuntime();
    const service = createBrowserIrRuntimeService(runtime);

    await service.capture({
      browser_id: 'browser-1',
      page_id: 'page-1',
      expected_revision: 1,
      target_entity_id: 'e1',
      format: 'png',
    });

    expect(runtime.capture).toHaveBeenCalledWith({
      browserId: 'browser-1',
      pageId: 'page-1',
      expectedRevision: 1,
      kind: 'entity',
      target: {
        browserId: 'browser-1',
        pageId: 'page-1',
        entityId: 'e1',
        revision: 1,
      },
    });
  });

  it('runs stateful operations for one browser in deterministic call order', async () => {
    const runtime = fakeRuntime();
    const firstMayFinish = deferred();
    const events: string[] = [];
    runtime.navigate = vi.fn(async ({ url }) => {
      events.push(`start:${url}`);
      if (url.endsWith('/first')) await firstMayFinish.promise;
      events.push(`finish:${url}`);
      return observation();
    });
    const service = createBrowserIrRuntimeService(runtime);

    const first = service.navigate({
      browser_id: 'browser-1',
      url: 'https://example.test/first',
      expected_revision: 0,
    });
    const second = service.navigate({
      browser_id: 'browser-1',
      url: 'https://example.test/second',
      expected_revision: 1,
    });
    await nextTurn();

    expect(events).toEqual(['start:https://example.test/first']);
    firstMayFinish.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual([
      'start:https://example.test/first',
      'finish:https://example.test/first',
      'start:https://example.test/second',
      'finish:https://example.test/second',
    ]);
  });

  it('makes the second same-revision mutation stale instead of dispatching twice', async () => {
    const runtime = fakeRuntime();
    const firstMayFinish = deferred();
    let currentRevision = 1;
    let dispatches = 0;
    runtime.act = vi.fn(async (request): Promise<ActionReceipt> => {
      if (request.expectedRevision !== currentRevision) {
        return {
          status: 'stale_target',
          dispatched: false,
          preRevision: currentRevision,
          effects: [],
          error: { code: 'stale_target', message: 'internal stale detail' },
        };
      }
      await firstMayFinish.promise;
      dispatches += 1;
      currentRevision += 1;
      return {
        status: 'verified',
        dispatched: true,
        preRevision: 1,
        postRevision: currentRevision,
        effects: [{ kind: 'graph_changed', verified: true }],
      };
    });
    const service = createBrowserIrRuntimeService(runtime);
    const action = {
      kind: 'click' as const,
      target_ref: 'e1@r1',
    };

    const first = service.act({
      browser_id: 'browser-1',
      page_id: 'page-1',
      expected_revision: 1,
      ...action,
    });
    const second = service.act({
      browser_id: 'browser-1',
      page_id: 'page-1',
      expected_revision: 1,
      ...action,
    });
    await nextTurn();

    expect(runtime.act).toHaveBeenCalledTimes(1);
    firstMayFinish.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.data.status).toBe('verified');
    expect(secondResult.data).toMatchObject({
      status: 'stale_target',
      dispatched: false,
      error: {
        code: 'stale_target',
        message: 'The action target is stale. Observe the page again before retrying.',
      },
    });
    expect(dispatches).toBe(1);
    expect(runtime.act).toHaveBeenCalledTimes(2);
  });

  it('does not make independent browser queues wait for each other', async () => {
    const runtime = fakeRuntime();
    const browserOneMayFinish = deferred();
    const events: string[] = [];
    runtime.pages = vi.fn(async ({ browserId }) => {
      events.push(`start:${browserId}`);
      if (browserId === 'browser-1') await browserOneMayFinish.promise;
      events.push(`finish:${browserId}`);
      return [];
    });
    const service = createBrowserIrRuntimeService(runtime);

    const first = service.pages({ browser_id: 'browser-1' });
    const second = service.pages({ browser_id: 'browser-2' });
    await second;

    expect(events).toEqual([
      'start:browser-1',
      'start:browser-2',
      'finish:browser-2',
    ]);
    browserOneMayFinish.resolve();
    await first;
    expect(events.at(-1)).toBe('finish:browser-1');
  });

  it('continues and cleans up a browser queue after an operation rejects', async () => {
    const runtime = fakeRuntime();
    runtime.navigate = vi
      .fn()
      .mockRejectedValueOnce(new Error('first operation failed'))
      .mockResolvedValue(observation());
    const service = createBrowserIrRuntimeService(runtime);

    const first = service.navigate({
      browser_id: 'browser-1',
      url: 'https://example.test/first',
      expected_revision: 0,
    });
    const second = service.navigate({
      browser_id: 'browser-1',
      url: 'https://example.test/second',
      expected_revision: 0,
    });

    await expect(first).rejects.toThrow('first operation failed');
    await expect(second).resolves.toMatchObject({ data: { browser_id: 'browser-1' } });
    await expect(
      service.navigate({
        browser_id: 'browser-1',
        url: 'https://example.test/third',
        expected_revision: 1,
      }),
    ).resolves.toMatchObject({ data: { browser_id: 'browser-1' } });
    expect(runtime.navigate).toHaveBeenCalledTimes(3);
  });

  it('returns stable sanitized errors for duplicate close and disposed services', async () => {
    const runtime = fakeRuntime();
    let closed = false;
    runtime.close = vi.fn(async () => {
      if (closed) {
        throw new BrowserIRError(
          'unknown_browser',
          'SECRET browser process details that must never cross MCP',
        );
      }
      closed = true;
    });
    const service = createBrowserIrRuntimeService(runtime);
    await service.create({});

    await expect(service.close({ browser_id: 'browser-1' })).resolves.toMatchObject({
      data: { browser_id: 'browser-1', closed: true },
    });
    await expect(service.close({ browser_id: 'browser-1' })).rejects.toMatchObject({
      code: 'unknown_browser',
      message: 'The browser handle is unknown or already closed.',
    });
    await expect(service.close({ browser_id: 'missing-browser' })).rejects.toMatchObject({
      code: 'unknown_browser',
      message: 'The browser handle is unknown or already closed.',
    });

    await service.dispose?.();
    const attempts: Array<() => Promise<unknown>> = [
      () => service.create({}),
      () =>
        service.navigate({
          browser_id: 'browser-1',
          url: 'https://example.test/',
          expected_revision: 1,
        }),
      () => service.observe({ browser_id: 'browser-1' }),
      () =>
        service.inspect({
          browser_id: 'browser-1',
          entity_ids: ['e1'],
          expected_revision: 1,
        }),
      () =>
        service.act({
          browser_id: 'browser-1',
          page_id: 'page-1',
          expected_revision: 1,
          kind: 'click',
          target_ref: 'e1@r1',
        }),
      () =>
        service.wait({
          browser_id: 'browser-1',
          expected_revision: 1,
          kind: 'settled',
        }),
      () => service.pages({ browser_id: 'browser-1' }),
      () =>
        service.capture({
          browser_id: 'browser-1',
          expected_revision: 1,
          kind: 'viewport',
        }),
      () => service.close({ browser_id: 'browser-1' }),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({
        code: 'service_disposed',
        message: 'This BrowserIR service connection has already closed.',
      });
    }
    expect(runtime.create).toHaveBeenCalledOnce();
    expect(runtime.navigate).not.toHaveBeenCalled();
    expect(runtime.observe).not.toHaveBeenCalled();
    expect(runtime.inspect).not.toHaveBeenCalled();
    expect(runtime.act).not.toHaveBeenCalled();
    expect(runtime.wait).not.toHaveBeenCalled();
    expect(runtime.pages).not.toHaveBeenCalled();
    expect(runtime.capture).not.toHaveBeenCalled();
  });
});
