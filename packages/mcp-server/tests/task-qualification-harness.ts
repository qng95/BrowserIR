import { BrowserIRRuntime } from '@browserir/core';
import { createPlaywrightBrowserDriver } from '@browserir/playwright';
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from '@modelcontextprotocol/client';
import {
  TASKS,
  startAppServer,
  taskById,
} from '@think-dom/fixture-app';

import {
  createBrowserIrMcpHandler,
  createBrowserIrRuntimeService,
} from '../src/index.js';
import {
  hashAdvertisedToolCatalog,
  QUALIFICATION_BROWSER_PROFILE,
  QUALIFICATION_FIXTURE_PROFILE,
} from './task-qualification-metadata.js';

const MAX_MODEL_TOKENS = 100_000;
export const CLIENT_PROTOCOL_VERSION = '2026-07-28';

type JsonRecord = Record<string, unknown>;
type TaskOutcome = 'passed' | 'failed' | 'not_applicable';

export interface QualificationEntity {
  id: string;
  revision: number;
  kind: string;
  role?: string | undefined;
  name?: string | undefined;
  text?: string | undefined;
  description?: string | undefined;
  value?: unknown;
  state: Record<string, string | boolean>;
  actions: string[];
}

export interface QualificationRelation {
  from: string;
  kind: string;
  to: string;
}

export interface QualificationObservation {
  browserId: string;
  pageId: string;
  revision: number;
  scope: 'full' | 'continuation';
  continuationOmitted: number;
  title?: string | undefined;
  url?: string | undefined;
  visibleText?: string | undefined;
  entities: QualificationEntity[];
  relations: QualificationRelation[];
  modelText: string;
}

export interface QualificationDiagnostic {
  sequence: number;
  tool: string;
  action?: string | undefined;
  target?: string | undefined;
  status?: string | undefined;
  revision?: number | undefined;
  isError: boolean;
  durationMs: number;
  summary: string;
}

export interface FixtureTaskQualificationResult {
  taskId: string;
  prompt: string;
  outcome: TaskOutcome;
  passed: boolean;
  reason: string;
  evidence?: unknown;
  plannerError?: string | undefined;
  diagnostics: QualificationDiagnostic[];
  isolation: {
    processId: number;
    origin: string;
    browserId?: string | undefined;
    clientName: string;
    protocolVersion: string;
    toolCatalogSha256?: string | undefined;
    toolCatalogToolCount?: number | undefined;
  };
  durationMs: number;
}

interface ParsedEnvelope {
  [key: string]: unknown;
  browser_id?: unknown;
  page_id?: unknown;
  revision?: unknown;
  post_revision?: unknown;
}

interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const modelText = (result: CallToolResult): string =>
  result.content
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text)
    .join('\n');

const jsonStringField = (line: string, field: string): string | undefined => {
  const encoded = line.match(new RegExp(`\\b${field}=(\"(?:\\\\.|[^\"\\\\])*\")`))?.[1];
  if (encoded === undefined) return undefined;
  try {
    return JSON.parse(encoded) as string;
  } catch {
    return undefined;
  }
};

const jsonValueField = (line: string): unknown => {
  const encoded = line.match(/\bvalue=((?:"(?:\\.|[^"\\])*")|(?:\{.*?\})|(?:\[.*?\])|(?:[^ ]+))/)?.[1];
  if (encoded === undefined) return undefined;
  try {
    return JSON.parse(encoded) as unknown;
  } catch {
    return encoded;
  }
};

const parseState = (line: string): Record<string, string | boolean> => {
  const encoded = line.match(/\bstate=([^ ]+)/)?.[1];
  if (encoded === undefined) return {};
  return Object.fromEntries(
    encoded.split(',').map((entry) => {
      const separator = entry.indexOf('=');
      const key = separator < 0 ? entry : entry.slice(0, separator);
      const value = separator < 0 ? '' : entry.slice(separator + 1);
      return [key, value === 'true' ? true : value === 'false' ? false : value];
    }),
  );
};

export function parseBrowserIrObservation(
  text: string,
  envelope: ParsedEnvelope,
): QualificationObservation {
  const browserId = typeof envelope.browser_id === 'string' ? envelope.browser_id : '';
  const pageId = typeof envelope.page_id === 'string' ? envelope.page_id : '';
  if (
    typeof envelope.revision === 'number' &&
    typeof envelope.post_revision === 'number' &&
    envelope.revision !== envelope.post_revision
  ) {
    throw new Error('BrowserIR receipt revision and post_revision do not match.');
  }
  const envelopeRevision =
    typeof envelope.revision === 'number'
      ? envelope.revision
      : typeof envelope.post_revision === 'number'
        ? envelope.post_revision
        : undefined;
  const revisionLine = text.match(/^Revision: (\d+)$/m)?.[1];
  const revision = envelopeRevision ?? Number(revisionLine ?? 0);
  const scope = envelope.representation === 'delta' ? 'continuation' : 'full';
  let continuationOmitted = 0;
  const entities: QualificationEntity[] = [];
  const relations: QualificationRelation[] = [];

  for (const line of text.split('\n')) {
    const relation = line.match(/^\[([^@\]]+)@r\d+\] ([a-z][a-z-]*) \[([^@\]]+)@r\d+\]$/);
    if (relation !== null) {
      relations.push({ from: relation[1]!, kind: relation[2]!, to: relation[3]! });
      continue;
    }
    const entity = line.match(/^\[([^@\]]+)@r(\d+)\] ([a-z]+)(?: |$)/);
    if (entity === null) continue;
    const actions = line.match(/\bactions=([^ ]+)/)?.[1]?.split(',').filter(Boolean) ?? [];
    entities.push({
      id: entity[1]!,
      revision: Number(entity[2]),
      kind: entity[3]!,
      role: jsonStringField(line, 'role'),
      name: jsonStringField(line, 'name'),
      text: jsonStringField(line, 'text'),
      description: jsonStringField(line, 'description'),
      value: jsonValueField(line),
      state: parseState(line),
      actions,
    });
  }

  if (envelope.representation === 'delta' && envelope.actionable_context !== undefined) {
    if (!isRecord(envelope.actionable_context)) {
      throw new Error('Delta-first actionable_context is malformed.');
    }
    const context = envelope.actionable_context;
    if (typeof context.page_id !== 'string' || context.page_id !== pageId) {
      throw new Error('Delta-first actionable_context page_id does not match the receipt.');
    }
    if (typeof context.revision !== 'number' || context.revision !== revision) {
      throw new Error('Delta-first actionable_context revision does not match the receipt.');
    }
    const contextRevision = context.revision;
    if (
      !Array.isArray(context.targets) ||
      typeof context.omitted !== 'number' ||
      !Number.isInteger(context.omitted) ||
      context.omitted < 0
    ) {
      throw new Error('Delta-first actionable_context targets or omitted count is malformed.');
    }
    continuationOmitted = context.omitted;
    const seenEntityIds = new Set<string>();
    const contextEntities = context.targets.map((candidate, index): QualificationEntity => {
      const label = `Delta-first actionable_context target ${index + 1}`;
      const parsedRef =
        isRecord(candidate) && typeof candidate.target_ref === 'string'
          ? /^([^@\]]+)@r(\d+)$/.exec(candidate.target_ref)
          : null;
      if (
        !isRecord(candidate) ||
        parsedRef === null ||
        Number(parsedRef[2]) !== contextRevision ||
        typeof candidate.kind !== 'string' ||
        candidate.kind.length === 0 ||
        !Array.isArray(candidate.actions) ||
        candidate.actions.length === 0 ||
        candidate.actions.some((action) => typeof action !== 'string') ||
        (Object.hasOwn(candidate, 'role') && typeof candidate.role !== 'string') ||
        (Object.hasOwn(candidate, 'name') && typeof candidate.name !== 'string') ||
        (Object.hasOwn(candidate, 'value_present') &&
          typeof candidate.value_present !== 'boolean') ||
        (Object.hasOwn(candidate, 'checked') &&
          typeof candidate.checked !== 'boolean' &&
          candidate.checked !== 'mixed') ||
        (Object.hasOwn(candidate, 'invalid') && typeof candidate.invalid !== 'boolean')
      ) {
        throw new Error(`${label} is malformed.`);
      }
      const entityId = parsedRef[1]!;
      if (seenEntityIds.has(entityId)) {
        throw new Error(`${label} duplicates entity_id ${JSON.stringify(entityId)}.`);
      }
      seenEntityIds.add(entityId);
      const actions = candidate.actions.filter(
        (action): action is string => typeof action === 'string',
      );
      const state: Record<string, string | boolean> = {};
      if (typeof candidate.value_present === 'boolean') {
        state.hasValue = candidate.value_present;
      }
      if (typeof candidate.checked === 'boolean' || candidate.checked === 'mixed') {
        state.checked = candidate.checked;
      }
      if (candidate.invalid === true) state.invalid = true;
      return {
        id: entityId,
        revision: contextRevision,
        kind: candidate.kind,
        ...(typeof candidate.role === 'string' ? { role: candidate.role } : {}),
        ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
        ...(Object.hasOwn(candidate, 'current_value')
          ? { value: candidate.current_value }
          : {}),
        state,
        actions,
      };
    });
    entities.push(...contextEntities);
  }

  const title = text.match(/^Page: (.*)$/m)?.[1];
  const url = text.match(/^URL: (.*)$/m)?.[1];
  const encodedVisibleText = text.match(/^Visible text: ("(?:\\.|[^"\\])*")$/m)?.[1];
  let visibleText: string | undefined;
  if (encodedVisibleText !== undefined) {
    try {
      visibleText = JSON.parse(encodedVisibleText) as string;
    } catch {
      visibleText = undefined;
    }
  }
  return {
    browserId,
    pageId,
    revision,
    scope,
    continuationOmitted,
    title,
    url,
    visibleText,
    entities,
    relations,
    modelText: text,
  };
}

export function qualificationContinuationNeedsObserve(
  observation: QualificationObservation,
): boolean {
  return (
    observation.scope === 'continuation' &&
    (observation.entities.length === 0 || observation.continuationOmitted > 0)
  );
}

export function latestObservationArguments(input: {
  browserId: string;
  pageId: string;
}): JsonRecord {
  return {
    browser_id: input.browserId,
    page_id: input.pageId,
    max_tokens: MAX_MODEL_TOKENS,
  };
}

const resultEnvelope = (result: CallToolResult): ParsedEnvelope =>
  isRecord(result.structuredContent) ? result.structuredContent : {};

const safeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const diagnosticKinds = new Set([
  'check',
  'click',
  'context_click',
  'double_click',
  'drag',
  'entity_state',
  'fill',
  'focus',
  'hover',
  'press',
  'revision_change',
  'select',
  'settled',
  'text',
  'timeout',
  'type',
  'uncheck',
  'upload',
]);

const safeDiagnosticRef = (value: unknown): string | undefined =>
  typeof value === 'string' && /^e[1-9]\d*@r[1-9]\d*$/.test(value)
    ? value
    : undefined;

export function publicSafeToolArgumentsDiagnostic(
  args: JsonRecord,
): Pick<QualificationDiagnostic, 'action' | 'target'> {
  const action =
    typeof args.kind === 'string' && diagnosticKinds.has(args.kind)
      ? args.kind
      : undefined;
  const targetRef = safeDiagnosticRef(args.target_ref);
  const sourceRef = safeDiagnosticRef(args.source_ref);
  const destinationRef = safeDiagnosticRef(args.destination_ref);
  const target =
    action === 'drag'
      ? sourceRef !== undefined && destinationRef !== undefined
        ? `${sourceRef} -> ${destinationRef}`
        : undefined
      : targetRef;
  return {
    ...(action === undefined ? {} : { action }),
    ...(target === undefined ? {} : { target }),
  };
}

export class QualificationToolError extends Error {
  readonly tool: string;
  readonly status: string | undefined;
  readonly dispatched: boolean | undefined;

  constructor(input: {
    tool: string;
    status?: string | undefined;
    dispatched?: boolean | undefined;
    summary: string;
  }) {
    super(`${input.tool} failed: ${input.summary}`);
    this.name = 'QualificationToolError';
    this.tool = input.tool;
    this.status = input.status;
    this.dispatched = input.dispatched;
  }
}

export async function actWithFreshTargetRetry<T, R>(input: {
  resolve: () => T | Promise<T>;
  refresh: () => Promise<unknown>;
  act: (target: T) => Promise<R>;
}): Promise<R> {
  try {
    return await input.act(await input.resolve());
  } catch (error) {
    if (
      !(error instanceof QualificationToolError) ||
      error.tool !== 'browser_act' ||
      error.status !== 'stale_target' ||
      error.dispatched !== false
    ) {
      throw error;
    }
  }
  await input.refresh();
  return input.act(await input.resolve());
}

const one = <T>(values: T[], description: string): T => {
  if (values.length !== 1) {
    throw new Error(`Expected exactly one ${description}; found ${values.length}.`);
  }
  return values[0]!;
};

const numberValue = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

export class BrowserIrReferenceAgent {
  readonly diagnostics: QualificationDiagnostic[] = [];
  readonly origin: string;
  readonly clientName: string;

  #client: Client;
  #handler: ReturnType<typeof createBrowserIrMcpHandler>;
  #service: ReturnType<typeof createBrowserIrRuntimeService>;
  #runtime: BrowserIRRuntime;
  #current?: QualificationObservation;
  #browserId?: string;
  #initialPageId?: string;
  #initialRevision?: number;
  #toolCatalogSha256?: string;
  #toolCatalogToolCount?: number;
  #closed = false;

  private constructor(input: {
    origin: string;
    clientName: string;
    client: Client;
    handler: ReturnType<typeof createBrowserIrMcpHandler>;
    service: ReturnType<typeof createBrowserIrRuntimeService>;
    runtime: BrowserIRRuntime;
  }) {
    this.origin = input.origin;
    this.clientName = input.clientName;
    this.#client = input.client;
    this.#handler = input.handler;
    this.#service = input.service;
    this.#runtime = input.runtime;
  }

  static async start(origin: string, clientName: string): Promise<BrowserIrReferenceAgent> {
    const runtime = new BrowserIRRuntime(createPlaywrightBrowserDriver());
    const service = createBrowserIrRuntimeService(runtime);
    const handler = createBrowserIrMcpHandler({ service });
    const transport = new StreamableHTTPClientTransport(new URL('http://browserir.test/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    const client = new Client(
      { name: clientName, version: '0.0.0' },
      { versionNegotiation: { mode: { pin: CLIENT_PROTOCOL_VERSION } } },
    );
    const agent = new BrowserIrReferenceAgent({ origin, clientName, client, handler, service, runtime });
    try {
      await client.connect(transport);
      const catalog = await client.listTools();
      agent.#toolCatalogSha256 = hashAdvertisedToolCatalog(
        catalog.tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema })),
      );
      agent.#toolCatalogToolCount = catalog.tools.length;
      const created = await agent.call('browser_create', {
        viewport: {
          width: QUALIFICATION_BROWSER_PROFILE.viewport.width,
          height: QUALIFICATION_BROWSER_PROFILE.viewport.height,
          device_scale_factor: QUALIFICATION_BROWSER_PROFILE.deviceScaleFactor,
        },
        locale: QUALIFICATION_BROWSER_PROFILE.locale,
        timezone_id: QUALIFICATION_BROWSER_PROFILE.timezoneId,
        color_scheme: QUALIFICATION_BROWSER_PROFILE.colorScheme,
        reduced_motion: QUALIFICATION_BROWSER_PROFILE.reducedMotion === 'reduce',
      });
      const data = resultEnvelope(created);
      if (
        typeof data.browser_id !== 'string' ||
        typeof data.page_id !== 'string' ||
        typeof data.revision !== 'number'
      ) {
        throw new Error('browser_create did not return opaque browser/page handles and a revision.');
      }
      agent.#browserId = data.browser_id;
      agent.#initialPageId = data.page_id;
      agent.#initialRevision = data.revision;
      return agent;
    } catch (error) {
      await agent.close().catch(() => {});
      throw error;
    }
  }

  get browserId(): string | undefined {
    return this.#browserId;
  }

  get toolCatalogSha256(): string | undefined {
    return this.#toolCatalogSha256;
  }

  get toolCatalogToolCount(): number | undefined {
    return this.#toolCatalogToolCount;
  }

  get current(): QualificationObservation {
    if (this.#current === undefined) throw new Error('The browser has not been observed yet.');
    return this.#current;
  }

  private async call(name: string, args: JsonRecord): Promise<CallToolResult> {
    const started = performance.now();
    const publicSafeArguments = publicSafeToolArgumentsDiagnostic(args);
    let result: CallToolResult;
    try {
      result = await this.#client.callTool({ name, arguments: args });
    } catch (error) {
      this.diagnostics.push({
        sequence: this.diagnostics.length + 1,
        tool: name,
        ...publicSafeArguments,
        isError: true,
        durationMs: Math.round(performance.now() - started),
        summary: safeError(error).slice(0, 500),
      });
      throw error;
    }
    const data = resultEnvelope(result);
    const status = typeof data.status === 'string' ? data.status : undefined;
    const dispatched = typeof data.dispatched === 'boolean' ? data.dispatched : undefined;
    const revision =
      typeof data.revision === 'number'
        ? data.revision
        : typeof data.post_revision === 'number'
          ? data.post_revision
          : undefined;
    const summary = modelText(result);
    this.diagnostics.push({
      sequence: this.diagnostics.length + 1,
      tool: name,
      ...publicSafeArguments,
      status,
      revision,
      isError: result.isError === true,
      durationMs: Math.round(performance.now() - started),
      summary: summary.replace(/\s+/g, ' ').slice(0, 500),
    });
    if (result.isError === true) {
      throw new QualificationToolError({
        tool: name,
        status,
        dispatched,
        summary,
      });
    }
    return result;
  }

  private setCurrent(result: CallToolResult): QualificationObservation {
    const parsed = parseBrowserIrObservation(modelText(result), resultEnvelope(result));
    if (!parsed.browserId || !parsed.pageId || parsed.revision < 0) {
      throw new Error('BrowserIR tool result did not contain a complete observation envelope.');
    }
    this.#current = parsed;
    return parsed;
  }

  async navigate(pathOrUrl: string): Promise<QualificationObservation> {
    if (this.#browserId === undefined || this.#initialPageId === undefined || this.#initialRevision === undefined) {
      throw new Error('Browser session is not initialized.');
    }
    const url = new URL(pathOrUrl, this.origin).toString();
    const pageId = this.#current?.pageId ?? this.#initialPageId;
    const revision = this.#current?.revision ?? this.#initialRevision;
    return this.setCurrent(
      await this.call('browser_navigate', {
        browser_id: this.#browserId,
        page_id: pageId,
        url,
        expected_revision: revision,
        max_tokens: MAX_MODEL_TOKENS,
      }),
    );
  }

  async observe(): Promise<QualificationObservation> {
    return this.setCurrent(
      await this.call('browser_observe', {
        browser_id: this.current.browserId,
        page_id: this.current.pageId,
        expected_revision: this.current.revision,
        max_tokens: MAX_MODEL_TOKENS,
      }),
    );
  }

  async observeLatest(): Promise<QualificationObservation> {
    return this.setCurrent(
      await this.call('browser_observe', latestObservationArguments(this.current)),
    );
  }

  async waitSettled(timeoutMs = 10_000): Promise<QualificationObservation> {
    return this.setCurrent(
      await this.call('browser_wait', {
        browser_id: this.current.browserId,
        page_id: this.current.pageId,
        expected_revision: this.current.revision,
        kind: 'settled',
        timeout_ms: timeoutMs,
        max_tokens: MAX_MODEL_TOKENS,
      }),
    );
  }

  async waitText(value: string, timeoutMs = 10_000): Promise<QualificationObservation> {
    return this.setCurrent(
      await this.call('browser_wait', {
        browser_id: this.current.browserId,
        page_id: this.current.pageId,
        expected_revision: this.current.revision,
        kind: 'text',
        value,
        state: 'visible',
        timeout_ms: timeoutMs,
        max_tokens: MAX_MODEL_TOKENS,
      }),
    );
  }

  async waitRevisionChange(timeoutMs = 10_000): Promise<QualificationObservation> {
    return this.setCurrent(
      await this.call('browser_wait', {
        browser_id: this.current.browserId,
        page_id: this.current.pageId,
        expected_revision: this.current.revision,
        kind: 'revision_change',
        timeout_ms: timeoutMs,
        max_tokens: MAX_MODEL_TOKENS,
      }),
    );
  }

  find(input: {
    name?: string | undefined;
    role?: string | undefined;
    kind?: string | undefined;
    textIncludes?: string | undefined;
    action?: string | undefined;
  }): QualificationEntity {
    const matches = this.findAll(input);
    if (matches.length === 0 && this.current.scope === 'continuation') {
      throw new Error(
        `Entity matching ${JSON.stringify(input)} is absent from the compact actionable continuation; browser_observe is required before treating it as absent from the page.`,
      );
    }
    return one(matches, `entity matching ${JSON.stringify(input)}`);
  }

  findAll(input: {
    name?: string | undefined;
    role?: string | undefined;
    kind?: string | undefined;
    textIncludes?: string | undefined;
    action?: string | undefined;
  }): QualificationEntity[] {
    return this.current.entities.filter(
      (entity) =>
        (input.name === undefined || entity.name === input.name) &&
        (input.role === undefined || entity.role === input.role) &&
        (input.kind === undefined || entity.kind === input.kind) &&
        (input.textIncludes === undefined ||
          `${entity.name ?? ''} ${entity.text ?? ''}`.includes(input.textIncludes)) &&
        (input.action === undefined || entity.actions.includes(input.action)),
    );
  }

  rowContaining(text: string): QualificationEntity {
    return one(
      this.current.entities.filter(
        (entity) => entity.kind === 'row' && `${entity.name ?? ''} ${entity.text ?? ''}`.includes(text),
      ),
      `row containing ${JSON.stringify(text)}`,
    );
  }

  children(parent: QualificationEntity): QualificationEntity[] {
    const ids = new Set(
      this.current.relations
        .filter((relation) => relation.from === parent.id && relation.kind === 'contains')
        .map((relation) => relation.to),
    );
    return this.current.entities.filter((entity) => ids.has(entity.id));
  }

  async inspectGeometry(entityIds: string[]): Promise<Map<string, Geometry>> {
    const geometries = new Map<string, Geometry>();
    const entities = await this.inspectEntities(entityIds);
    for (const raw of entities) {
      if (!isRecord(raw.ref) || !isRecord(raw.geometry)) continue;
      const id = raw.ref.entity_id;
      const { x, y, width, height } = raw.geometry;
      if (
        typeof id === 'string' &&
        typeof x === 'number' &&
        typeof y === 'number' &&
        typeof width === 'number' &&
        typeof height === 'number'
      ) {
        geometries.set(id, { x, y, width, height });
      }
    }
    return geometries;
  }

  async inspectEntities(
    entityIds: string[],
    includeEvidence = false,
  ): Promise<Record<string, unknown>[]> {
    const inspected: Record<string, unknown>[] = [];
    for (let offset = 0; offset < entityIds.length; offset += 100) {
      const result = await this.call('browser_inspect', {
        browser_id: this.current.browserId,
        page_id: this.current.pageId,
        entity_ids: entityIds.slice(offset, offset + 100),
        expected_revision: this.current.revision,
        max_tokens: MAX_MODEL_TOKENS,
        include_evidence: includeEvidence,
      });
      const data = resultEnvelope(result);
      const view = isRecord(data.view) ? data.view : undefined;
      const entities = Array.isArray(view?.entities) ? view.entities : [];
      for (const raw of entities) {
        if (isRecord(raw)) inspected.push(raw);
      }
    }
    return inspected;
  }

  async inspectObservation(
    entityIds: string[],
    includeEvidence = false,
  ): Promise<QualificationObservation> {
    const result = await this.call('browser_inspect', {
      browser_id: this.current.browserId,
      page_id: this.current.pageId,
      entity_ids: entityIds,
      expected_revision: this.current.revision,
      max_tokens: MAX_MODEL_TOKENS,
      include_evidence: includeEvidence,
    });
    return parseBrowserIrObservation(modelText(result), resultEnvelope(result));
  }

  async inside(
    container: QualificationEntity,
    predicate: (entity: QualificationEntity) => boolean,
  ): Promise<QualificationEntity[]> {
    const candidates = this.current.entities.filter(predicate);
    const geometries = await this.inspectGeometry([container.id, ...candidates.map((candidate) => candidate.id)]);
    const outer = geometries.get(container.id);
    if (outer === undefined) throw new Error(`BrowserIR did not expose geometry for ${container.id}.`);
    return candidates.filter((candidate) => {
      const inner = geometries.get(candidate.id);
      if (inner === undefined) return false;
      const centerX = inner.x + inner.width / 2;
      const centerY = inner.y + inner.height / 2;
      return (
        centerX >= outer.x &&
        centerX <= outer.x + outer.width &&
        centerY >= outer.y &&
        centerY <= outer.y + outer.height
      );
    });
  }

  async act(
    action:
      | { kind: 'click' | 'double_click' | 'context_click' | 'focus' | 'hover' | 'check' | 'uncheck'; target: QualificationEntity }
      | { kind: 'fill'; target: QualificationEntity; value: string }
      | { kind: 'type'; target: QualificationEntity; text: string }
      | { kind: 'select'; target: QualificationEntity; values: string[] }
      | { kind: 'press'; target?: QualificationEntity | undefined; keys: string }
      | { kind: 'drag'; source: QualificationEntity; target: QualificationEntity },
  ): Promise<QualificationObservation> {
    const ref = (entity: QualificationEntity): string =>
      `${entity.id}@r${this.current.revision}`;
    let encoded: JsonRecord;
    if (action.kind === 'drag') {
      encoded = { kind: 'drag', source_ref: ref(action.source), destination_ref: ref(action.target) };
    } else if (action.kind === 'press') {
      encoded = {
        kind: 'press',
        keys: action.keys,
        ...(action.target === undefined ? {} : { target_ref: ref(action.target) }),
      };
    } else if (action.kind === 'fill') {
      encoded = { kind: 'fill', target_ref: ref(action.target), value: action.value };
    } else if (action.kind === 'type') {
      encoded = { kind: 'type', target_ref: ref(action.target), text: action.text };
    } else if (action.kind === 'select') {
      encoded = { kind: 'select', target_ref: ref(action.target), values: action.values };
    } else {
      encoded = { kind: action.kind, target_ref: ref(action.target) };
    }
    const result = await this.call('browser_act', {
      browser_id: this.current.browserId,
      page_id: this.current.pageId,
      expected_revision: this.current.revision,
      ...encoded,
      max_tokens: MAX_MODEL_TOKENS,
    });
    const observation = this.setCurrent(result);
    if (qualificationContinuationNeedsObserve(observation)) {
      return this.observe();
    }
    return observation;
  }

  click(entity: QualificationEntity): Promise<QualificationObservation> {
    return this.act({ kind: 'click', target: entity });
  }

  fill(entity: QualificationEntity, value: string): Promise<QualificationObservation> {
    return this.act({ kind: 'fill', target: entity, value });
  }

  select(entity: QualificationEntity, value: string): Promise<QualificationObservation> {
    return this.act({ kind: 'select', target: entity, values: [value] });
  }

  async signIn(): Promise<void> {
    await this.navigate('/app/login');
    await this.fill(this.find({ name: 'Username' }), 'test');
    await this.fill(this.find({ name: 'Password' }), 'test');
    await this.click(this.find({ name: 'Sign in', role: 'button' }));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#browserId !== undefined) {
      try {
        await this.call('browser_close', { browser_id: this.#browserId });
      } catch {
        await this.#runtime.close({ browserId: this.#browserId }).catch(() => {});
      }
    }
    await this.#client.close().catch(() => {});
    await this.#handler.close().catch(() => {});
    await this.#service.dispose?.().catch(() => {});
  }
}

type FixtureTaskPlanner = (agent: BrowserIrReferenceAgent) => Promise<void>;

const createCustomer = async (
  agent: BrowserIrReferenceAgent,
  values: { name: string; city: string; country: string; creditLimit: string; vatId?: string },
): Promise<void> => {
  await agent.navigate('/app/customers/new');
  for (const [name, value] of [
    ['Customer name', values.name],
    ['City', values.city],
    ['Country', values.country],
    ['Credit limit (€)', values.creditLimit],
    ...(values.vatId === undefined ? [] : ([['VAT ID', values.vatId]] as const)),
  ] as const) {
    await agent.fill(agent.find({ name }), value);
  }
  await agent.click(agent.find({ name: 'Create customer', role: 'button' }));
};

const customerEditFromRow = async (
  agent: BrowserIrReferenceAgent,
  row: QualificationEntity,
): Promise<void> => {
  const edit = one(
    await agent.inside(row, (entity) => entity.role === 'link' && entity.name === 'Edit'),
    'Edit link inside customer row',
  );
  await agent.click(edit);
};

const vehicleOpenFromOnlyRow = async (agent: BrowserIrReferenceAgent): Promise<void> => {
  await agent.click(agent.find({ name: 'Open', role: 'link' }));
};

const updateVehicleStatus = async (agent: BrowserIrReferenceAgent, status: string): Promise<void> => {
  await agent.select(agent.find({ name: 'Change status' }), status);
  await agent.click(agent.find({ name: 'Update status', role: 'button' }));
};

const firstVehicleVinInCurrentGrid = async (
  agent: BrowserIrReferenceAgent,
): Promise<string> => {
  const grid = agent.find({ kind: 'table', role: 'grid' });
  const inspectedGrid = await agent.inspectObservation([grid.id]);
  const gridLines = (inspectedGrid.visibleText ?? '').split('\n').map((line) => line.trim());
  const vinHeader = gridLines.findIndex((line) => /^VIN(?:\s*[▲▼])?$/.test(line));
  const vin = vinHeader < 0
    ? undefined
    : gridLines.slice(vinHeader + 1).find(
        (line) =>
          line.length >= 10 &&
          line.length <= 20 &&
          /^[A-Z0-9]+$/.test(line) &&
          /[A-Z]/.test(line) &&
          /\d/.test(line),
      );
  if (vin === undefined) throw new Error('BrowserIR did not expose a vehicle VIN from the current grid.');
  return vin;
};

const findPaginatedRow = async (
  agent: BrowserIrReferenceAgent,
  text: string,
  maxPages = 100,
): Promise<QualificationEntity> => {
  for (let page = 1; page <= maxPages; page += 1) {
    const rows = agent.current.entities.filter(
      (entity) => entity.kind === 'row' && `${entity.name ?? ''} ${entity.text ?? ''}`.includes(text),
    );
    if (rows.length === 1) return rows[0]!;
    if (rows.length > 1) throw new Error(`More than one row contains ${JSON.stringify(text)}.`);
    const next = agent.findAll({ name: 'Next', role: 'link' });
    if (next.length === 0) break;
    await agent.click(one(next, 'Next page link'));
  }
  throw new Error(`Could not find a paginated row containing ${JSON.stringify(text)}.`);
};

const planners = {
  'create-customer': async (agent) => {
    await agent.signIn();
    await createCustomer(agent, {
      name: 'Steinweg Logistik GmbH',
      city: 'Leipzig',
      country: 'Germany',
      creditLimit: '30000',
      vatId: 'DE145879632',
    });
  },

  'raise-credit-limit': async (agent) => {
    await agent.signIn();
    await agent.navigate('/app/customers');
    await agent.fill(agent.find({ name: 'Search' }), 'K-100042');
    await agent.click(agent.find({ name: 'Apply', role: 'button' }));
    await customerEditFromRow(agent, agent.rowContaining('K-100042'));
    await agent.fill(agent.find({ name: 'Credit limit (€)' }), '45000');
    await agent.click(agent.find({ name: 'Save changes', role: 'button' }));
  },

  'validation-recovery': async (agent) => {
    await agent.signIn();
    await createCustomer(agent, {
      name: 'Nordlicht Spedition',
      city: 'Bremen',
      country: 'Germany',
      creditLimit: '400000',
    });
    if (!agent.current.modelText.includes('250.000')) {
      throw new Error('BrowserIR did not expose the server credit-limit ceiling after rejection.');
    }
    await agent.fill(agent.find({ name: 'Credit limit (€)' }), '250000');
    await agent.click(agent.find({ name: 'Create customer', role: 'button' }));
  },

  'mark-order-delivered': async (agent) => {
    await agent.signIn();
    await agent.navigate('/app/orders');
    const row = await findPaginatedRow(agent, 'A-2026-0007');
    const target = one(
      await agent.inside(
        row,
        (entity) => entity.role === 'checkbox' && entity.actions.includes('contextClick'),
      ),
      'context-clickable selection control inside order row',
    );
    await agent.act({ kind: 'context_click', target });
    await agent.waitText('Mark delivered', 3_000);
    await agent.click(agent.find({ role: 'menuitem', textIncludes: 'Mark delivered' }));
  },

  'highest-revenue-poland': async (agent) => {
    await agent.signIn();
    await agent.navigate('/app/customers?sort=revenue&dir=desc');
    const row = agent.current.entities.find(
      (entity) => entity.kind === 'row' && `${entity.name ?? ''} ${entity.text ?? ''}`.includes('Poland'),
    );
    if (row === undefined) throw new Error('No Polish customer appeared in the descending-revenue view.');
    await customerEditFromRow(agent, row);
    await agent.select(agent.find({ name: 'Status', role: 'combobox' }), 'Active');
    await agent.click(agent.find({ name: 'Save changes', role: 'button' }));
  },

  'reserve-cheapest-in-stock': async (agent) => {
    await agent.signIn();
    await agent.navigate('/app/vehicles');
    await agent.select(agent.find({ name: 'Status', role: 'combobox' }), 'In stock');
    await agent.click(agent.find({ name: 'Apply', role: 'button' }));
    await agent.click(agent.find({ name: 'Price', role: 'link' }));
    const vin = await firstVehicleVinInCurrentGrid(agent);
    await agent.fill(agent.find({ name: 'Search' }), vin);
    await agent.click(agent.find({ name: 'Apply', role: 'button' }));
    await vehicleOpenFromOnlyRow(agent);
    await updateVehicleStatus(agent, 'Reserved');
  },

  'order-through-wizard': async (agent) => {
    await agent.signIn();
    await agent.navigate('/app/vehicles');
    await agent.select(agent.find({ name: 'Status', role: 'combobox' }), 'In stock');
    await agent.click(agent.find({ name: 'Apply', role: 'button' }));
    const inStockVin = await firstVehicleVinInCurrentGrid(agent);
    await agent.navigate('/app/orders/new');
    await agent.fill(agent.find({ name: 'Customer' }), 'K-100032');
    let customerOptions: QualificationEntity[] = [];
    for (let attempt = 0; attempt < 3 && customerOptions.length === 0; attempt += 1) {
      await agent.waitRevisionChange();
      customerOptions = agent.current.entities.filter(
        (entity) => entity.role === 'option' && `${entity.name ?? ''} ${entity.text ?? ''}`.includes('K-100032'),
      );
    }
    if (customerOptions.length === 0) {
      throw new Error('BrowserIR did not expose the K-100032 autocomplete option.');
    }
    await agent.waitSettled();
    const customerOption = one(
      agent.current.entities.filter(
        (entity) => entity.role === 'option' && `${entity.name ?? ''} ${entity.text ?? ''}`.includes('K-100032'),
      ),
      'K-100032 autocomplete option',
    );
    await agent.click(customerOption);
    await agent.click(agent.find({ name: 'Continue', role: 'button' }));
    await agent.click(agent.find({ name: 'Choose vehicle…', role: 'button' }));
    await agent.waitSettled();
    await agent.fill(agent.find({ name: 'Filter by VIN, make or model…' }), inStockVin);
    const matchingVehicleOptions = (): QualificationEntity[] => {
      const visibleListboxes = agent.current.entities.filter(
        (entity) => entity.role === 'listbox' && entity.state.visible === true,
      );
      const picker = visibleListboxes.length === 1 ? visibleListboxes[0] : undefined;
      const pickerOptionIds = new Set(
        picker === undefined
          ? []
          : agent.current.relations
              .filter(
                (relation) => relation.kind === 'option-of' && relation.to === picker.id,
              )
              .map((relation) => relation.from),
      );
      const representedOptions = agent.current.entities.filter(
        (entity) => entity.role === 'option' && pickerOptionIds.has(entity.id),
      );
      const matchingOptions = representedOptions.filter(
        (entity) => `${entity.name ?? ''} ${entity.text ?? ''}`.includes(inStockVin),
      );
      if (
        representedOptions.length === 1 &&
        matchingOptions.length === 0 &&
        agent.current.visibleText?.includes(inStockVin) === true
      ) {
        throw new Error(
          `Filtered VIN ${inStockVin} is visible but not bound to a selectable option entity.`,
        );
      }
      return representedOptions.length === 1 && matchingOptions.length === 1
        ? matchingOptions
        : [];
    };
    let vehicleOptions: QualificationEntity[] = [];
    for (let attempt = 0; attempt < 4 && vehicleOptions.length === 0; attempt += 1) {
      await agent.waitRevisionChange();
      vehicleOptions = matchingVehicleOptions();
    }
    if (vehicleOptions.length === 0) {
      throw new Error(`No picker option was represented for in-stock VIN ${inStockVin}.`);
    }
    await actWithFreshTargetRetry({
      resolve: () =>
        one(matchingVehicleOptions(), `vehicle picker option for ${inStockVin}`),
      refresh: async () => {
        await agent.observeLatest();
        await agent.waitSettled();
      },
      act: (vehicleOption) => agent.click(vehicleOption),
    });
    await agent.click(agent.find({ name: 'Continue', role: 'button' }));
    await agent.fill(agent.find({ name: 'Delivery date' }), '2026-09-30');
    await agent.click(agent.find({ name: 'Continue', role: 'button' }));
    await agent.click(agent.find({ name: 'Create order', role: 'button' }));
  },

  'find-vin-deep-in-inventory': async (agent) => {
    await agent.signIn();
    await agent.navigate('/app/vehicles');
    await agent.fill(agent.find({ name: 'Search' }), 'WV1ZZZ0075000');
    await agent.click(agent.find({ name: 'Apply', role: 'button' }));
    await vehicleOpenFromOnlyRow(agent);
    await updateVehicleStatus(agent, 'Demo');
  },

  'bulk-cancel-drafts': async (agent) => {
    await agent.signIn();
    await agent.navigate('/app/orders');
    await agent.select(agent.find({ name: 'Status', role: 'combobox' }), 'Draft');
    await agent.click(agent.find({ name: 'Apply', role: 'button' }));
    await agent.act({ kind: 'check', target: agent.find({ name: 'Select all orders on this page' }) });
    await agent.click(agent.find({ name: 'Cancel orders', role: 'button' }));
  },

  'reschedule-appointment': async (agent) => {
    await agent.signIn();
    await agent.navigate('/app/workshop');
    const bay1 = agent.rowContaining('Bay 1');
    const bay4 = agent.rowContaining('Bay 4');
    const allGeometry = await agent.inspectGeometry(agent.current.entities.map((entity) => entity.id));
    const byX = (left: QualificationEntity, right: QualificationEntity): number =>
      (allGeometry.get(left.id)?.x ?? Number.MAX_SAFE_INTEGER) -
      (allGeometry.get(right.id)?.x ?? Number.MAX_SAFE_INTEGER);
    const bay1Cells = agent.children(bay1).filter((entity) => entity.kind === 'cell' && entity.role === 'cell').sort(byX);
    if (bay1Cells.length < 3) throw new Error('BrowserIR did not expose Bay 1 schedule cells.');
    const sourceCell = bay1Cells[2]!;
    const sourceBox = allGeometry.get(sourceCell.id);
    if (sourceBox === undefined) throw new Error('BrowserIR did not expose source schedule-cell geometry.');
    const source = agent.current.entities.find((entity) => {
      if (entity.role !== 'button' || entity.name === 'Empty slot') return false;
      const box = allGeometry.get(entity.id);
      if (box === undefined) return false;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      return x >= sourceBox.x && x <= sourceBox.x + sourceBox.width && y >= sourceBox.y && y <= sourceBox.y + sourceBox.height;
    });
    if (source === undefined) throw new Error('BrowserIR did not bind the Bay 1 13:00 appointment to its represented cell.');
    const targets = await agent.inside(bay4, (entity) => entity.role === 'button' && entity.name === 'Empty slot');
    const target = targets.sort(byX)[0];
    if (target === undefined) throw new Error('BrowserIR did not expose a free Bay 4 slot.');
    await agent.act({ kind: 'drag', source, target });
  },

  'restock-low-part': async (agent) => {
    await agent.signIn();
    await agent.navigate('/app/parts');
    const expandedLinks = agent.current.entities.filter(
      (entity) => entity.role === 'link' && typeof entity.state.expanded === 'boolean',
    );
    const initialRootGeometry = await agent.inspectGeometry(expandedLinks.map((entity) => entity.id));
    const rightmostRootX = Math.max(
      ...expandedLinks.map((entity) => initialRootGeometry.get(entity.id)?.x ?? Number.NEGATIVE_INFINITY),
    );
    const roots = expandedLinks.filter((entity) => {
      const x = initialRootGeometry.get(entity.id)?.x;
      return entity.name !== undefined && x !== undefined && rightmostRootX - x < 80;
    });
    if (roots.length === 0) throw new Error('BrowserIR did not expose the collapsed part-category roots.');

    const inspectCategory = async (): Promise<boolean> => {
      const listUrl = agent.current.url;
      if (listUrl === undefined) throw new Error('BrowserIR did not expose the category URL.');
      const skus = agent.current.entities
        .filter((entity) => entity.role === 'link' && /^P-[A-Z0-9-]+$/.test(entity.name ?? ''))
        .map((entity) => entity.name!);
      for (const sku of skus) {
        const row = agent.rowContaining(sku);
        const stockCell = one(
          agent.children(row).filter(
            (entity) => entity.kind === 'cell' && /^\d+$/.test(entity.text ?? ''),
          ),
          `stock cell for ${sku}`,
        );
        const stock = Number(stockCell.text);
        await agent.click(agent.find({ name: sku, role: 'link' }));
        const visible = agent.current.visibleText ?? '';
        const reorderMatch = /Reorder level\s+(\d+)/.exec(visible);
        if (reorderMatch !== null) {
          const reorder = Number(reorderMatch[1]);
          if (stock < reorder) {
            await agent.fill(agent.find({ name: 'Add stock' }), String(reorder * 2 - stock));
            await agent.click(agent.find({ name: 'Restock', role: 'button' }));
            return true;
          }
        }
        await agent.navigate(listUrl);
      }
      return false;
    };

    const rootNames = roots.map((entity) => entity.name).filter((name): name is string => name !== undefined);
    for (const rootName of rootNames) {
      const rootLabel = rootName.replace(/^[▸▾]\s*/, '');
      await agent.navigate('/app/parts');
      await agent.click(agent.find({ name: rootName, role: 'link' }));
      if (await inspectCategory()) return;
      await agent.navigate('/app/parts');
      await agent.click(agent.find({ name: rootName, role: 'link' }));
      const currentRoot = one(
        agent.current.entities.filter(
          (entity) => entity.role === 'link' && entity.name?.replace(/^[▸▾]\s*/, '') === rootLabel,
        ),
        `expanded category ${rootLabel}`,
      );
      const linkCandidates = agent.current.entities.filter((entity) => entity.role === 'link');
      const linkGeometry = await agent.inspectGeometry(linkCandidates.map((entity) => entity.id));
      const currentRootX = linkGeometry.get(currentRoot.id)?.x;
      if (currentRootX === undefined) throw new Error(`BrowserIR did not expose geometry for category ${rootName}.`);
      const childNames = linkCandidates
        .filter(
          (entity) =>
            entity.role === 'link' &&
            entity.name !== undefined &&
            !rootNames.includes(entity.name) &&
            Math.abs((linkGeometry.get(entity.id)?.x ?? Number.POSITIVE_INFINITY) - currentRootX) < 80,
        )
        .map((entity) => entity.name!);
      for (const childName of childNames) {
        await agent.navigate('/app/parts');
        await agent.click(agent.find({ name: rootName, role: 'link' }));
        await agent.click(agent.find({ name: childName, role: 'link' }));
        if (await inspectCategory()) return;
      }
    }
    throw new Error('No below-reorder part could be reached using represented category and part references.');
  },

  'settle-invoice': async (agent) => {
    await agent.signIn();
    await agent.navigate('/app/invoices');
    const row = await findPaginatedRow(agent, 'R-2026-0002');
    const invoice = one(
      await agent.inside(row, (entity) => entity.role === 'link' && entity.name === 'R-2026-0002'),
      'invoice link inside target row',
    );
    await agent.click(invoice);
    const amount = agent.find({ name: 'Amount (€)' });
    const derivedAmount = numberValue(amount.value);
    if (derivedAmount === undefined) throw new Error('BrowserIR did not expose the outstanding payment value.');
    await agent.fill(amount, String(derivedAmount));
    await agent.click(agent.find({ name: 'Record payment', role: 'button' }));
  },

  'triage-ticket': async (agent) => {
    await agent.signIn();
    await agent.navigate('/app/tickets');
    const editField = async (field: 'priority' | 'assignee', value: string): Promise<void> => {
      const values = field === 'priority' ? ['Low', 'Normal', 'High', 'Urgent'] : ['S. Weber', 'A. Klein', 'M. Roth', 'Unassigned'];
      const resolveCell = async (): Promise<QualificationEntity> => {
        const row = agent.rowContaining('T-1005');
        return one(
          await agent.inside(
            row,
            (entity) =>
              entity.kind === 'cell' &&
              values.includes(`${entity.text ?? entity.name ?? ''}`),
          ),
          `${field} cell inside T-1005 row`,
        );
      };
      const refresh = async (): Promise<void> => {
        await agent.observeLatest();
        await agent.waitSettled();
      };
      await actWithFreshTargetRetry({
        resolve: resolveCell,
        refresh,
        act: (cell) => agent.act({ kind: 'double_click', target: cell }),
      });
      await actWithFreshTargetRetry({
        resolve: () => agent.find({ name: field }),
        refresh,
        act: (editor) => agent.select(editor, value),
      });
    };
    await editField('priority', 'Urgent');
    await editField('assignee', 'M. Roth');
  },

  'query-three-conditions': async (agent) => {
    await agent.signIn();
    await agent.navigate('/app/reports/query');
    await agent.select(agent.find({ name: 'Match' }), 'all');
    await agent.click(agent.find({ name: 'Add condition', role: 'button' }));
    await agent.click(agent.find({ name: 'Add condition', role: 'button' }));

    await agent.select(agent.find({ name: 'Field 1' }), 'country');
    await agent.select(agent.find({ name: 'Operator 1' }), 'equals');
    await agent.fill(agent.find({ name: 'Value 1' }), 'Germany');

    await agent.select(agent.find({ name: 'Field 2' }), 'status');
    await agent.select(agent.find({ name: 'Operator 2' }), 'equals');
    await agent.select(agent.find({ name: 'Value 2' }), 'Active');

    await agent.select(agent.find({ name: 'Field 3' }), 'credit_limit');
    await agent.select(agent.find({ name: 'Operator 3' }), '>');
    await agent.fill(agent.find({ name: 'Value 3' }), '30000');
    await agent.click(agent.find({ name: 'Run query', role: 'button' }));
  },
} satisfies Record<string, FixtureTaskPlanner>;

export const FIXTURE_TASK_PLANNERS: Readonly<Record<string, FixtureTaskPlanner>> = planners;

export async function qualifyFixtureTask(taskId: string): Promise<FixtureTaskQualificationResult> {
  const task = taskById(taskId);
  if (task === undefined) throw new Error(`Unknown fixture task: ${taskId}`);
  const planner = FIXTURE_TASK_PLANNERS[taskId];
  if (planner === undefined) throw new Error(`No deterministic reference planner for fixture task: ${taskId}`);
  const started = performance.now();
  const app = await startAppServer({
    seed: QUALIFICATION_FIXTURE_PROFILE.seed,
    customers: QUALIFICATION_FIXTURE_PROFILE.customers,
    vehicles: QUALIFICATION_FIXTURE_PROFILE.vehicles,
    apiLatencyMs: QUALIFICATION_FIXTURE_PROFILE.apiLatencyMs,
    pageLatencyMs: QUALIFICATION_FIXTURE_PROFILE.pageLatencyMs,
  });
  const clientName = `browserir-qualification-${taskId}`;
  let agent: BrowserIrReferenceAgent | undefined;
  let plannerError: string | undefined;
  let browserId: string | undefined;
  let toolCatalogSha256: string | undefined;
  let toolCatalogToolCount: number | undefined;
  let diagnostics: QualificationDiagnostic[] = [];
  try {
    try {
      agent = await BrowserIrReferenceAgent.start(app.origin, clientName);
      browserId = agent.browserId;
      toolCatalogSha256 = agent.toolCatalogSha256;
      toolCatalogToolCount = agent.toolCatalogToolCount;
      await planner(agent);
    } catch (error) {
      plannerError = safeError(error);
    } finally {
      if (agent !== undefined) {
        await agent.close().catch((error) => {
          plannerError ??= `cleanup failed: ${safeError(error)}`;
        });
        diagnostics = [...agent.diagnostics];
      }
    }

    // The database-backed oracle is intentionally invoked only after all agent
    // activity and browser/MCP cleanup have stopped.
    const oracle = task.verify(app.db);
    return {
      taskId,
      prompt: task.prompt,
      outcome: oracle.outcome,
      passed: oracle.passed,
      reason: oracle.reason,
      evidence: oracle.evidence,
      plannerError,
      diagnostics,
      isolation: {
        processId: process.pid,
        origin: app.origin,
        browserId,
        clientName,
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        toolCatalogSha256,
        toolCatalogToolCount,
      },
      durationMs: Math.round(performance.now() - started),
    };
  } finally {
    await app.close();
  }
}

export async function qualifyAllFixtureTasks(): Promise<FixtureTaskQualificationResult[]> {
  const results: FixtureTaskQualificationResult[] = [];
  for (const task of TASKS) results.push(await qualifyFixtureTask(task.id));
  return results;
}
