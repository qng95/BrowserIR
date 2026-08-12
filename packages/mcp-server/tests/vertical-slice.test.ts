import { BrowserIRRuntime } from '@browserir/core';
import { createPlaywrightBrowserDriver } from '@browserir/playwright';
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from '@modelcontextprotocol/client';
import { startAppServer, taskById } from '@think-dom/fixture-app';
import { expect, it } from 'vitest';

import {
  createBrowserIrMcpHandler,
  createBrowserIrRuntimeService,
} from '../src/index.js';

interface ModelEntity {
  name?: string;
  role?: string;
  value?: unknown;
  state?: Record<string, unknown>;
  ref: {
    page_id: string;
    entity_id: string;
    revision: number;
  };
}

interface ObservationEnvelope {
  browser_id: string;
  page_id: string;
  revision: number;
  entities: ModelEntity[];
}

const entityMatching = (
  observation: ObservationEnvelope,
  query: { name: string; role?: string },
): ModelEntity => {
  const matches = observation.entities.filter(
    (candidate) =>
      candidate.name === query.name &&
      (query.role === undefined || candidate.role === query.role),
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one BrowserIR entity matching ${JSON.stringify(query)}, found ${matches.length}.`,
    );
  }
  return matches[0]!;
};

const entityNamed = (observation: ObservationEnvelope, name: string): ModelEntity =>
  entityMatching(observation, { name });

const modelText = (result: CallToolResult): string => {
  const content = result.content.find(
    (item): item is { type: 'text'; text: string } => item.type === 'text',
  );
  if (!content) throw new Error('missing BrowserIR model view');
  return content.text;
};

const modelPayloadCharacters = (result: CallToolResult): number =>
  JSON.stringify({
    content: result.content,
    structuredContent: result.structuredContent,
  }).length;

const modelFacingPayloadCharacters = (result: CallToolResult): number => {
  const sections = [modelText(result)];
  if (result.structuredContent !== undefined) {
    sections.push(
      `Structured tool content:\n${JSON.stringify(result.structuredContent, null, 2)}`,
    );
  }
  return Buffer.byteLength(sections.filter(Boolean).join('\n\n'), 'utf8');
};

// Captured by this deterministic flow before delta-first action receipts.
// Keep a margin for harmless renderer changes while preventing regression to
// the legacy 51,970-byte behavior.
const LEGACY_CREATE_CUSTOMER_MODEL_FACING_BYTES = 51_970;
const REQUIRED_MODEL_FACING_REDUCTION = 0.15;

const parseState = (line: string): Record<string, unknown> => {
  const state = line.match(/\bstate=([^ ]+)/)?.[1];
  if (state === undefined) return {};
  return Object.fromEntries(
    state.split(',').map((entry) => {
      const [key, value] = entry.split('=');
      return [key, value === 'true' ? true : value === 'false' ? false : value];
    }),
  );
};

const observationEnvelope = (result: CallToolResult): ObservationEnvelope => {
  if (typeof result.structuredContent !== 'object' || result.structuredContent === null) {
    throw new Error('missing structured content');
  }
  const envelope = result.structuredContent as {
    browser_id: string;
    page_id: string;
    revision: number;
  };
  const entities = modelText(result)
    .split('\n')
    .flatMap((line): ModelEntity[] => {
      const ref = line.match(/^\[([^@\]]+)@r(\d+)\]/);
      if (ref === null) return [];
      const encodedName = line.match(/\bname=("(?:\\.|[^"\\])*")/)?.[1];
      const encodedRole = line.match(/\brole=("(?:\\.|[^"\\])*")/)?.[1];
      return [
        {
          ...(encodedName === undefined ? {} : { name: JSON.parse(encodedName) as string }),
          ...(encodedRole === undefined ? {} : { role: JSON.parse(encodedRole) as string }),
          state: parseState(line),
          ref: {
            page_id: envelope.page_id,
            entity_id: ref[1]!,
            revision: Number(ref[2]),
          },
        },
      ];
    });
  return { ...envelope, entities };
};

const advanceEnvelope = (
  previous: ObservationEnvelope,
  result: CallToolResult,
): ObservationEnvelope => {
  const data = result.structuredContent as
    | { representation?: unknown; revision?: unknown; post_revision?: unknown }
    | undefined;
  if (data?.representation !== 'delta') return observationEnvelope(result);
  const revision =
    typeof data.revision === 'number'
      ? data.revision
      : typeof data.post_revision === 'number'
        ? data.post_revision
        : undefined;
  if (revision === undefined) throw new Error('delta receipt omitted its current revision');
  return { ...previous, revision };
};

type ActionableContext = {
  page_id: string;
  revision: number;
  targets: Array<{ target_ref: string; name?: string }>;
  omitted: number;
};

const actionableContext = (result: CallToolResult): ActionableContext => {
  const data = result.structuredContent as
    | { actionable_context?: Partial<ActionableContext> }
    | undefined;
  const context = data?.actionable_context;
  if (
    typeof context?.page_id !== 'string' ||
    typeof context.revision !== 'number' ||
    !Array.isArray(context.targets) ||
    typeof context.omitted !== 'number'
  ) {
    throw new Error('delta receipt omitted actionable_context');
  }
  return context as ActionableContext;
};

const actionableRef = (
  context: ActionableContext,
  name: string,
): ModelEntity['ref'] | undefined => {
  const target = context.targets.find((candidate) => candidate.name === name);
  if (target === undefined) return undefined;
  const parsed = /^([^@]+)@r(\d+)$/.exec(target.target_ref);
  if (parsed === null || Number(parsed[2]) !== context.revision) {
    throw new Error('delta receipt returned a malformed target_ref');
  }
  return { page_id: context.page_id, entity_id: parsed[1]!, revision: Number(parsed[2]) };
};

const targetRef = (ref: ModelEntity['ref']): string => `${ref.entity_id}@r${ref.revision}`;

it(
  'drives the real fixture login through MCP using only BrowserIR references',
  async () => {
    const app = await startAppServer({
      apiLatencyMs: 0,
      pageLatencyMs: 0,
      customers: 50,
      vehicles: 50,
    });
    const runtime = new BrowserIRRuntime(createPlaywrightBrowserDriver());
    const service = createBrowserIrRuntimeService(runtime);
    const handler = createBrowserIrMcpHandler({ service });
    const transport = new StreamableHTTPClientTransport(new URL('http://browserir.test/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    const client = new Client(
      { name: 'browserir-vertical-slice', version: '0.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    let browserId: string | undefined;

    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe('modern');

      const created = await client.callTool({ name: 'browser_create', arguments: {} });
      const createData = created.structuredContent as {
        browser_id: string;
        page_id: string;
        revision: number;
      };
      browserId = createData.browser_id;

      const navigated = await client.callTool({
        name: 'browser_navigate',
        arguments: {
          browser_id: createData.browser_id,
          page_id: createData.page_id,
          url: `${app.origin}/app/login`,
          expected_revision: createData.revision,
        },
      });
      let current = observationEnvelope(navigated);
      expect(current.entities.map((entity) => entity.name)).toEqual(
        expect.arrayContaining(['Username', 'Password', 'Sign in']),
      );

      const username = entityNamed(current, 'Username');
      const usernameFilled = await client.callTool({
        name: 'browser_act',
        arguments: {
          browser_id: current.browser_id,
          page_id: current.page_id,
          expected_revision: current.revision,
          kind: 'fill',
          target_ref: targetRef(username.ref),
          value: 'test',
        },
      });
      expect(usernameFilled.structuredContent).toMatchObject({ status: 'verified' });
      current = advanceEnvelope(current, usernameFilled);

      const password = entityNamed(current, 'Password');
      const passwordFilled = await client.callTool({
        name: 'browser_act',
        arguments: {
          browser_id: current.browser_id,
          page_id: current.page_id,
          expected_revision: current.revision,
          kind: 'fill',
          target_ref: targetRef(password.ref),
          value: 'test',
        },
      });
      expect(passwordFilled.structuredContent).toMatchObject({ status: 'verified' });
      current = advanceEnvelope(current, passwordFilled);
      const refreshedLogin = await client.callTool({
        name: 'browser_observe',
        arguments: {
          browser_id: current.browser_id,
          page_id: current.page_id,
          expected_revision: current.revision,
        },
      });
      current = observationEnvelope(refreshedLogin);
      const representedPassword = entityNamed(current, 'Password');
      expect(representedPassword).not.toHaveProperty('value');
      expect(representedPassword.state).toMatchObject({ hasValue: true });

      const signInCandidates = current.entities.filter((entity) => entity.name === 'Sign in');
      expect(signInCandidates.map((entity) => entity.role)).toEqual(
        expect.arrayContaining(['link', 'button']),
      );
      expect(new Set(signInCandidates.map((entity) => entity.ref.entity_id)).size).toBe(2);
      expect(() => entityNamed(current, 'Sign in')).toThrow(/found 2/);
      const signIn = entityMatching(current, { name: 'Sign in', role: 'button' });
      const signedIn = await client.callTool({
        name: 'browser_act',
        arguments: {
          browser_id: current.browser_id,
          page_id: current.page_id,
          expected_revision: current.revision,
          kind: 'click',
          target_ref: targetRef(signIn.ref),
        },
      });

      expect(signedIn.structuredContent).toMatchObject({ status: 'verified' });
      const finalObservation = observationEnvelope(signedIn);
      expect(finalObservation.entities.map((entity) => entity.name)).toContain('New customer');

      await client.callTool({
        name: 'browser_close',
        arguments: { browser_id: current.browser_id },
      });
      browserId = undefined;
    } finally {
      if (browserId !== undefined) {
        await runtime.close({ browserId }).catch(() => {});
      }
      await client.close().catch(() => {});
      await handler.close().catch(() => {});
      await app.close();
    }
  },
  60_000,
);

it(
  'creates a customer through compact MCP views and passes database plus audit verification',
  async () => {
    const app = await startAppServer({
      apiLatencyMs: 0,
      pageLatencyMs: 0,
      customers: 50,
      vehicles: 50,
    });
    const runtime = new BrowserIRRuntime(createPlaywrightBrowserDriver());
    const service = createBrowserIrRuntimeService(runtime);
    const handler = createBrowserIrMcpHandler({ service });
    const transport = new StreamableHTTPClientTransport(new URL('http://browserir.test/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    const client = new Client(
      { name: 'browserir-create-customer', version: '0.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    let browserId: string | undefined;
    const responseSizes: number[] = [];
    const fillResponseSizes: number[] = [];
    const modelFacingResponseSizes: number[] = [];
    const recordResponse = (result: CallToolResult): number => {
      const payloadCharacters = modelPayloadCharacters(result);
      responseSizes.push(payloadCharacters);
      modelFacingResponseSizes.push(modelFacingPayloadCharacters(result));
      return payloadCharacters;
    };

    try {
      await client.connect(transport);
      const created = await client.callTool({ name: 'browser_create', arguments: {} });
      const createData = created.structuredContent as {
        browser_id: string;
        page_id: string;
        revision: number;
      };
      browserId = createData.browser_id;
      recordResponse(created);

      const navigated = await client.callTool({
        name: 'browser_navigate',
        arguments: {
          browser_id: createData.browser_id,
          page_id: createData.page_id,
          url: `${app.origin}/app/login`,
          expected_revision: createData.revision,
          max_tokens: 4_000,
        },
      });
      recordResponse(navigated);
      let current = observationEnvelope(navigated);

      for (const [name, value] of [
        ['Username', 'test'],
        ['Password', 'test'],
      ] as const) {
        const result = await client.callTool({
          name: 'browser_act',
          arguments: {
            browser_id: current.browser_id,
            page_id: current.page_id,
            expected_revision: current.revision,
            max_tokens: 4_000,
            kind: 'fill',
            target_ref: targetRef(entityNamed(current, name).ref),
            value,
          },
        });
        recordResponse(result);
        expect(result.structuredContent).toMatchObject({ status: 'verified' });
        current = advanceEnvelope(current, result);
      }

      const signedIn = await client.callTool({
        name: 'browser_act',
        arguments: {
          browser_id: current.browser_id,
          page_id: current.page_id,
          expected_revision: current.revision,
          max_tokens: 4_000,
          kind: 'click',
          target_ref: targetRef(entityMatching(current, { name: 'Sign in', role: 'button' }).ref),
        },
      });
      recordResponse(signedIn);
      current = advanceEnvelope(current, signedIn);

      const openedForm = await client.callTool({
        name: 'browser_act',
        arguments: {
          browser_id: current.browser_id,
          page_id: current.page_id,
          expected_revision: current.revision,
          max_tokens: 4_000,
          kind: 'click',
          target_ref: targetRef(entityNamed(current, 'New customer').ref),
        },
      });
      recordResponse(openedForm);
      current = advanceEnvelope(current, openedForm);

      const formTargets = new Map(
        [
          'Customer name',
          'City',
          'Country',
          'Credit limit (€)',
          'VAT ID',
          'Create customer',
        ].map((name) => [name, entityNamed(current, name).ref] as const),
      );
      let continuation: ActionableContext | undefined;
      for (const [name, value] of [
        ['Customer name', 'Steinweg Logistik GmbH'],
        ['City', 'Leipzig'],
        ['Country', 'Germany'],
        ['Credit limit (€)', '30000'],
        ['VAT ID', 'DE145879632'],
      ] as const) {
        const target =
          (continuation === undefined ? undefined : actionableRef(continuation, name)) ??
          formTargets.get(name)!;
        expect(target.revision).toBe(current.revision);
        const result = await client.callTool({
          name: 'browser_act',
          arguments: {
            browser_id: current.browser_id,
            page_id: current.page_id,
            expected_revision: current.revision,
            max_tokens: 4_000,
            kind: 'fill',
            target_ref: targetRef(target),
            value,
          },
        });
        const responseSize = recordResponse(result);
        fillResponseSizes.push(responseSize);
        expect(result.structuredContent).toMatchObject({
          status: 'verified',
          representation: 'delta',
          changes: { rebindable_refs: expect.arrayContaining([formTargets.get(name)!.entity_id]) },
        });
        expect(modelText(result)).toContain('Delta only');
        continuation = actionableContext(result);
        expect(JSON.stringify(continuation).length).toBeLessThanOrEqual(640);
        if (name === 'Country') {
          expect(continuation.targets.map((candidate) => candidate.name)).toEqual(
            expect.arrayContaining([
              'Status',
              'Credit limit (€)',
              'VAT ID',
              'Create customer',
            ]),
          );
          expect(continuation.targets.map((candidate) => candidate.name)).not.toEqual(
            expect.arrayContaining(['Customer name', 'City', 'Cancel']),
          );
        }
        current = advanceEnvelope(current, result);
      }

      const createTarget = actionableRef(continuation!, 'Create customer');
      expect(createTarget).toBeDefined();
      expect(createTarget!.revision).toBe(current.revision);
      const submitted = await client.callTool({
        name: 'browser_act',
        arguments: {
          browser_id: current.browser_id,
          page_id: current.page_id,
          expected_revision: current.revision,
          max_tokens: 4_000,
          kind: 'click',
          target_ref: targetRef(createTarget!),
        },
      });
      recordResponse(submitted);
      expect(submitted.structuredContent).toMatchObject({ status: 'verified' });
      expect(modelText(submitted)).toContain('Steinweg Logistik GmbH');

      const verification = taskById('create-customer')!.verify(app.db);
      expect(verification).toMatchObject({
        passed: true,
        reason: 'Customer created with all fields correct.',
      });
      const audit = app.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM audit
           WHERE action = 'customer.create' AND detail = ?`,
        )
        .get('Steinweg Logistik GmbH') as { count: number };
      expect(Number(audit.count)).toBe(1);
      const largestResponse = Math.max(...responseSizes);
      const largestFillResponse = Math.max(...fillResponseSizes);
      const totalModelFacingResponse = modelFacingResponseSizes.reduce(
        (total, size) => total + size,
        0,
      );
      if (process.env['BROWSERIR_REPORT_RESPONSE_SIZES'] === '1') {
        console.info(`Largest create-customer MCP model payload: ${largestResponse} characters`);
        console.info(
          `Largest delta-first form-fill payload: ${largestFillResponse} characters`,
        );
        console.info(
          `Total create-customer model-facing response payload: ${totalModelFacingResponse} bytes`,
        );
      }
      expect(largestResponse).toBeLessThanOrEqual(16_000);
      expect(largestFillResponse).toBeLessThanOrEqual(2_200);
      expect(totalModelFacingResponse).toBeLessThanOrEqual(
        Math.floor(
          LEGACY_CREATE_CUSTOMER_MODEL_FACING_BYTES *
            (1 - REQUIRED_MODEL_FACING_REDUCTION),
        ),
      );

      await client.callTool({
        name: 'browser_close',
        arguments: { browser_id: current.browser_id },
      });
      browserId = undefined;
    } finally {
      if (browserId !== undefined) {
        await runtime.close({ browserId }).catch(() => {});
      }
      await client.close().catch(() => {});
      await handler.close().catch(() => {});
      await app.close();
    }
  },
  60_000,
);

it(
  'exposes server validation reasons in BrowserIR and recovers to a verified customer creation',
  async () => {
    const app = await startAppServer({
      apiLatencyMs: 0,
      pageLatencyMs: 0,
      customers: 50,
      vehicles: 50,
    });
    const runtime = new BrowserIRRuntime(createPlaywrightBrowserDriver());
    const service = createBrowserIrRuntimeService(runtime);
    const handler = createBrowserIrMcpHandler({ service });
    const transport = new StreamableHTTPClientTransport(new URL('http://browserir.test/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    const client = new Client(
      { name: 'browserir-validation-recovery', version: '0.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    let browserId: string | undefined;

    try {
      await client.connect(transport);
      const created = await client.callTool({ name: 'browser_create', arguments: {} });
      const createData = created.structuredContent as {
        browser_id: string;
        page_id: string;
        revision: number;
      };
      browserId = createData.browser_id;

      const navigated = await client.callTool({
        name: 'browser_navigate',
        arguments: {
          browser_id: createData.browser_id,
          page_id: createData.page_id,
          url: `${app.origin}/app/login`,
          expected_revision: createData.revision,
          max_tokens: 4_000,
        },
      });
      let current = observationEnvelope(navigated);

      const actOnNamed = async (
        kind: 'click' | 'fill',
        name: string,
        value?: string,
        role?: string,
      ): Promise<CallToolResult> => {
        const result = await client.callTool({
          name: 'browser_act',
          arguments: {
            browser_id: current.browser_id,
            page_id: current.page_id,
            expected_revision: current.revision,
            max_tokens: 4_000,
            kind,
            target_ref: targetRef(entityMatching(current, {
                name,
                ...(role === undefined ? {} : { role }),
              }).ref),
            ...(value === undefined ? {} : { value }),
          },
        });
        expect(result.structuredContent).toMatchObject({ status: 'verified' });
        current = advanceEnvelope(current, result);
        return result;
      };

      await actOnNamed('fill', 'Username', 'test');
      await actOnNamed('fill', 'Password', 'test');
      await actOnNamed('click', 'Sign in', undefined, 'button');
      await actOnNamed('click', 'New customer');

      for (const [name, value] of [
        ['Customer name', 'Steinweg Logistik GmbH'],
        ['City', 'Leipzig'],
        ['Country', 'Germany'],
        ['Credit limit (€)', '300000'],
        ['VAT ID', 'DE123'],
      ] as const) {
        await actOnNamed('fill', name, value);
      }

      const rejected = await actOnNamed('click', 'Create customer');
      const rejectedView = modelText(rejected);
      if (process.env['BROWSERIR_REPORT_REPRESENTATION'] === '1') {
        console.info(`Current BrowserIR validation view:\n${rejectedView}`);
      }
      expect(rejectedView).toContain('2 field(s) need attention.');
      const alertLine = rejectedView
        .split('\n')
        .find((line) => line.includes('role="alert"'));
      expect(alertLine, rejectedView).toContain('state=transient=true,visible=true');
      expect(alertLine, rejectedView).not.toContain('actions=');

      const creditLine = rejectedView
        .split('\n')
        .find((line) => line.includes('name="Credit limit (€)"'));
      expect(creditLine, rejectedView).toContain(
        'Credit limit above 250.000 € needs board approval.',
      );
      expect(creditLine, rejectedView).toContain('invalid=true');

      const vatLine = rejectedView
        .split('\n')
        .find((line) => line.includes('name="VAT ID"'));
      expect(vatLine, rejectedView).toContain(
        'VAT ID must be two letters followed by 9 digits.',
      );
      expect(vatLine, rejectedView).toContain('invalid=true');

      expect(
        app.db
          .prepare(`SELECT COUNT(*) AS count FROM audit WHERE action = 'customer.create'`)
          .get(),
      ).toMatchObject({ count: 0 });

      await actOnNamed('fill', 'Credit limit (€)', '30000');
      await actOnNamed('fill', 'VAT ID', 'DE145879632');
      const submitted = await actOnNamed('click', 'Create customer');
      expect(modelText(submitted)).toContain('Steinweg Logistik GmbH');

      const verification = taskById('create-customer')!.verify(app.db);
      expect(verification).toMatchObject({
        passed: true,
        reason: 'Customer created with all fields correct.',
      });
      const audit = app.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM audit
           WHERE action = 'customer.create' AND detail = ?`,
        )
        .get('Steinweg Logistik GmbH') as { count: number };
      expect(Number(audit.count)).toBe(1);

      await client.callTool({
        name: 'browser_close',
        arguments: { browser_id: current.browser_id },
      });
      browserId = undefined;
    } finally {
      if (browserId !== undefined) {
        await runtime.close({ browserId }).catch(() => {});
      }
      await client.close().catch(() => {});
      await handler.close().catch(() => {});
      await app.close();
    }
  },
  60_000,
);
