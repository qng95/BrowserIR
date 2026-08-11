import { randomUUID } from 'node:crypto';

import {
  MAX_CAPTURE_BYTES,
  MAX_CAPTURE_PHYSICAL_PIXELS,
  sanitizeModelFacingUrl,
} from '@browserir/core';
import type {
  BrowserCreateOptions,
  BrowserDriver,
  BrowserDriverSession,
  Capability,
  CaptureResult,
  DriverActionRequest,
  DriverActionResult,
  DriverCaptureRequest,
  DriverCloseRequest,
  DriverNavigateRequest,
  DriverObservation,
  DriverObserveRequest,
  DriverObservedEntity,
  DriverObservedRelation,
  DriverPage,
  DriverTarget,
  DriverUnsafeEvaluateRequest,
  DriverUnsafeEvaluateResult,
  EntityKind,
  EntityState,
  Evidence,
  ViewOmission,
} from '@browserir/core';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type ElementHandle,
  type Frame,
  type JSHandle,
  type LaunchOptions,
  type Page,
  type Request,
} from 'playwright';

import { mapOrderedConcurrent } from './ordered-concurrency.js';
import { evaluateUnsafeInPlaywrightPage } from './unsafe-evaluate.js';

export const STABLE_VIEWPORT = Object.freeze({
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
});

export const DEFAULT_MAX_PAGES_PER_SESSION = 32;
export const DEFAULT_MAX_FRAMES_PER_OBSERVATION = 64;

/**
 * ARIA roles whose contract includes direct user activation. `option` is
 * intentionally custom-only: native HTMLOptionElement activation is mediated
 * by its owning select, while custom ARIA options are activated directly.
 */
export const SEMANTIC_ACTIVATION_ROLE_POLICY = Object.freeze({
  button: 'direct',
  link: 'direct',
  checkbox: 'direct',
  radio: 'direct',
  switch: 'direct',
  tab: 'direct',
  treeitem: 'direct',
  option: 'custom-only',
  menuitem: 'direct',
  menuitemcheckbox: 'direct',
  menuitemradio: 'direct',
} as const);

type SemanticActivationRole = keyof typeof SEMANTIC_ACTIVATION_ROLE_POLICY;

const SEMANTIC_ACTIVATION_SELECTOR = Object.entries(
  SEMANTIC_ACTIVATION_ROLE_POLICY,
)
  .filter(([, policy]) => policy === 'direct')
  .map(([role]) => `[role="${role}"]`)
  .join(',');

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[contenteditable="true"]',
  '[role="combobox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="textbox"]',
  SEMANTIC_ACTIVATION_SELECTOR,
  '[aria-haspopup="listbox"]',
  '[draggable="true"]',
  '[aria-grabbed]',
  '[aria-dropeffect]',
].join(',');

const OBSERVABLE_SELECTOR = [
  INTERACTIVE_SELECTOR,
  '[role="listbox"]',
  '[role="alert"]',
  '[role="status"]',
].join(',');

const CHOICE_OPTION_SELECTOR = [
  'option',
  '[role="option"]',
  '[aria-selected][value]',
  '[aria-selected][data-value]',
].join(',');

const SEMANTIC_SCOPE_SELECTOR = [
  'nav',
  'main',
  '[role="navigation"]',
  '[role="main"]',
  '[role="toolbar"]',
].join(',');

const MAX_VISIBLE_TEXT_LENGTH = 20_000;
const OBSERVATION_CONCURRENCY = 16;
const MAX_CUSTOM_SCAN_ELEMENTS = 25_000;
const MAX_CUSTOM_INTERACTION_TARGETS = 200;

export const STANDARD_ELEMENT_POLICY = Object.freeze({
  maxScannedElements: 25_000,
  maxObservableElements: 2_000,
  maxSemanticScopes: 200,
  maxChoiceOptions: 2_000,
});

export const SEMANTIC_RELATIONSHIP_POLICY = Object.freeze({
  maxScannedElements: 25_000,
  maxControls: 500,
  maxLabelCandidates: 1_000,
  acceptanceThreshold: 0.86,
  ambiguityMargin: 0.12,
});

/** Hard bounds for the structural table sensor, applied independently per frame. */
export const TABLE_STRUCTURE_POLICY = Object.freeze({
  maxScannedElements: 25_000,
  maxTables: 50,
  maxRows: 200,
  maxCells: 2_000,
  maxTextCharacters: 512,
});

export interface PlaywrightBrowserDriverOptions {
  headless?: boolean;
  launchOptions?: Omit<LaunchOptions, 'headless'>;
  /** Optional context-level network allowlist. Values must be exact HTTP(S) origins. */
  allowedOrigins?: readonly string[];
  /** Service workers can bypass ordinary request interception; controlled runs should block them. */
  serviceWorkers?: 'allow' | 'block';
  /** Maximum simultaneously tracked pages, including popups, in one browser session. */
  maxPagesPerSession?: number;
  /** Maximum documents analyzed in one observation, including the main frame. */
  maxFramesPerObservation?: number;
}

const normalizedAllowedOrigins = (
  values: readonly string[] | undefined,
): ReadonlySet<string> | undefined => {
  if (values === undefined) return undefined;
  const origins = new Set<string>();
  for (const value of values) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError('allowedOrigins values must be absolute HTTP or HTTPS origins.');
    }
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.origin !== value
    ) {
      throw new TypeError('allowedOrigins values must be exact HTTP or HTTPS origins.');
    }
    if (origins.has(url.origin)) {
      throw new TypeError(`allowedOrigins contains a duplicate origin: ${url.origin}`);
    }
    origins.add(url.origin);
  }
  return origins;
};

type TargetBinding = {
  pageId: string;
  handle: ElementHandle<HTMLElement>;
};

type PageRecord = {
  pageId: string;
  page: Page;
  generation: number;
  documentGeneration: number;
  pendingDocumentNavigations: WeakSet<Frame>;
};

type SessionProfile = {
  width: number;
  height: number;
  deviceScaleFactor: number;
};

type ElementFacts = {
  kind: EntityKind;
  role?: string;
  name?: string;
  description?: string;
  text?: string;
  value?: string;
  semanticKey?: string;
  state: EntityState;
  capabilities: Capability[];
  scope?: {
    sourceId: string;
    signature: string;
  };
  container?: {
    sourceId: string;
    signature: string;
  };
  interactionEvidence?: InteractionEvidence;
};

type InteractionEvidence = {
  detail:
    | 'react-click-handler'
    | 'react-double-click-handler'
    | 'react-drag-start-handler'
    | 'react-drop-handler'
    | 'vue-click-handler'
    | 'vue-double-click-handler'
    | 'vue-drag-start-handler'
    | 'vue-drop-handler'
    | 'dom-click-listener'
    | 'dom-double-click-listener'
    | 'delegated-dom-double-click-listener'
    | 'dom-drag-start-listener'
    | 'dom-drop-listener'
    | 'inline-click-handler'
    | 'inline-double-click-handler'
    | 'inline-drag-start-handler'
    | 'inline-drop-handler'
    | 'native-draggable'
    | 'aria-grabbed'
    | 'aria-drop-target'
    | 'pointer-cue';
  confidence: number;
  capabilities: Capability['kind'][];
  acceptsDrop?: boolean;
};

type InteractionCandidate = InteractionEvidence & {
  element: HTMLElement;
  index: number;
};

type InteractionCandidateBinding = {
  handle: ElementHandle<HTMLElement>;
  evidence: InteractionEvidence;
};

type InteractionSnapshot = {
  elements: HTMLElement[];
  evidence: InteractionEvidence[];
  omittedCandidates: number;
  scanTruncated: boolean;
};

type InteractionCandidateBindingSnapshot = {
  bindings: InteractionCandidateBinding[];
  omittedCandidates: number;
  scanTruncated: boolean;
};

type BoundedElementSnapshot = {
  elements: Element[];
  omittedMatches: number;
  scanTruncated: boolean;
};

type BoundedElementBindingSnapshot = {
  handles: ElementHandle<HTMLElement>[];
  omittedMatches: number;
  scanTruncated: boolean;
};

type SemanticLabelFacts = {
  text: string;
  visible: boolean;
  semanticKey: string | undefined;
  scopeName: string | undefined;
  confidence: number;
  evidence: Evidence[];
};

type SemanticLabelRelationshipFacts = {
  labelIndex: number;
  controlSourceId: string;
  name: string;
  scopeName: string | undefined;
  inferred: boolean;
  confidence: number;
  evidence: Evidence[];
};

type SemanticLabelSnapshot = {
  elements: HTMLElement[];
  labels: SemanticLabelFacts[];
  relationships: SemanticLabelRelationshipFacts[];
  omittedAnalysis: number;
  analysisCountExact: boolean;
};

type SemanticLabelBinding = {
  index: number;
  handle: ElementHandle<HTMLElement>;
  facts: SemanticLabelFacts;
};

type SemanticLabelBindingSnapshot = {
  labels: SemanticLabelBinding[];
  relationships: SemanticLabelRelationshipFacts[];
  omittedAnalysis: number;
  analysisCountExact: boolean;
};

type SemanticRelationshipPolicy = typeof SEMANTIC_RELATIONSHIP_POLICY;

type ElementFactsInput = {
  targetRegistry: WeakMap<HTMLElement, string>;
  interactionEvidence?: InteractionEvidence;
};

type ChoiceOptionFacts = {
  ownerSourceId: string;
  ownerSignature: string;
  name: string;
  value: string;
  state: EntityState;
  nativeOption: boolean;
};

type ScopeFacts = {
  role: 'navigation' | 'main' | 'toolbar';
  name: string;
  signature: string;
};

type FrameFacts = {
  name: string;
  signature: string;
};

type TableStructurePolicy = typeof TABLE_STRUCTURE_POLICY;

type TableStructureValue = {
  rowCount?: number;
  columnCount?: number;
  rowIndex?: number;
  columnIndex?: number;
};

type TableStructureFacts = {
  kind: 'table' | 'row' | 'cell';
  role: string;
  identityKey: string;
  name?: string;
  text?: string;
  value?: TableStructureValue;
  parentIndex?: number;
  scopeSourceId?: string;
};

type TableStructureSnapshot = {
  elements: HTMLElement[];
  facts: TableStructureFacts[];
  omittedEntities: number;
  omittedRelations: number;
  omittedContentCharacters: number;
  scanTruncated: boolean;
};

type TableStructureBinding = {
  index: number;
  handle: ElementHandle<HTMLElement>;
  facts: TableStructureFacts;
};

type TableStructureBindingSnapshot = {
  bindings: TableStructureBinding[];
  omittedEntities: number;
  omittedRelations: number;
  omittedContentCharacters: number;
  scanTruncated: boolean;
};

const isSemanticActivationRole = (
  role: string | undefined,
): role is SemanticActivationRole =>
  role !== undefined &&
  Object.prototype.hasOwnProperty.call(SEMANTIC_ACTIVATION_ROLE_POLICY, role);

const semanticActivationCapabilities = (
  role: string | undefined,
  state: EntityState,
  nativeElement = false,
): Capability[] => {
  if (!isSemanticActivationRole(role) || state.visible !== true) return [];
  const policy = SEMANTIC_ACTIVATION_ROLE_POLICY[role];
  if (policy === 'custom-only' && nativeElement) return [];
  return [
    {
      kind: 'click',
      enabled: state.enabled !== false,
      reason: `${role}-activation`,
      confidence: 1,
    },
  ];
};

const applySemanticActivationPolicy = (facts: ElementFacts): void => {
  if (!isSemanticActivationRole(facts.role)) return;
  if (facts.name === undefined && facts.text !== undefined) {
    facts.name = facts.text;
    delete facts.text;
  }
  const inferred = semanticActivationCapabilities(facts.role, facts.state);
  for (const capability of inferred) {
    if (
      facts.capabilities.some(
        (candidate) => candidate.kind === capability.kind,
      )
    ) {
      continue;
    }
    facts.capabilities.push(capability);
  }
};

class ObservationInvalidatedError extends Error {}

class ActionMayHaveDispatchedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionMayHaveDispatchedError';
  }
}

/**
 * Playwright owns browser mechanics; BrowserIR owns meaning and model-facing
 * identity. This adapter emits normalized facts and opaque target handles only.
 */
export class PlaywrightBrowserDriver implements BrowserDriver {
  readonly #options: PlaywrightBrowserDriverOptions;

  constructor(options: PlaywrightBrowserDriverOptions = {}) {
    this.#options = options;
  }

  /** Overridable launch seam for embedders and deterministic lifecycle tests. */
  protected launchBrowser(options: LaunchOptions): Promise<Browser> {
    return chromium.launch(options);
  }

  async createSession(options: BrowserCreateOptions = {}): Promise<BrowserDriverSession> {
    const allowedOrigins = normalizedAllowedOrigins(this.#options.allowedOrigins);
    const maxPagesPerSession =
      this.#options.maxPagesPerSession ?? DEFAULT_MAX_PAGES_PER_SESSION;
    if (!Number.isSafeInteger(maxPagesPerSession) || maxPagesPerSession < 1) {
      throw new RangeError('maxPagesPerSession must be a positive safe integer.');
    }
    const maxFramesPerObservation =
      this.#options.maxFramesPerObservation ??
      DEFAULT_MAX_FRAMES_PER_OBSERVATION;
    if (
      !Number.isSafeInteger(maxFramesPerObservation) ||
      maxFramesPerObservation < 1
    ) {
      throw new RangeError(
        'maxFramesPerObservation must be a positive safe integer.',
      );
    }
    const profile: SessionProfile = {
      width: options.viewport?.width ?? STABLE_VIEWPORT.width,
      height: options.viewport?.height ?? STABLE_VIEWPORT.height,
      deviceScaleFactor: options.deviceScaleFactor ?? STABLE_VIEWPORT.deviceScaleFactor,
    };
    const physicalPixels =
      profile.width *
      profile.height *
      profile.deviceScaleFactor *
      profile.deviceScaleFactor;
    if (physicalPixels > MAX_CAPTURE_PHYSICAL_PIXELS) {
      throw new RangeError(
        `Browser profile exceeds the ${MAX_CAPTURE_PHYSICAL_PIXELS} physical-pixel capture limit.`,
      );
    }
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let session: PlaywrightBrowserSession | undefined;
    try {
      browser = await this.launchBrowser({
        handleSIGHUP: false,
        handleSIGINT: false,
        handleSIGTERM: false,
        ...this.#options.launchOptions,
        headless: options.headless ?? this.#options.headless ?? true,
      });
      context = await browser.newContext({
        viewport: { width: profile.width, height: profile.height },
        deviceScaleFactor: profile.deviceScaleFactor,
        acceptDownloads: false,
        colorScheme: options.colorScheme ?? 'light',
        reducedMotion: options.reducedMotion ?? 'reduce',
        serviceWorkers: this.#options.serviceWorkers ?? 'allow',
        ...(options.locale === undefined ? {} : { locale: options.locale }),
        ...(options.timezoneId === undefined ? {} : { timezoneId: options.timezoneId }),
      });
      if (allowedOrigins !== undefined) {
        await context.route('**/*', async (route) => {
          const requestUrl = route.request().url();
          let requestOrigin: string | undefined;
          try {
            const parsedRequestUrl = new URL(requestUrl);
            if (
              parsedRequestUrl.protocol === 'http:' ||
              parsedRequestUrl.protocol === 'https:'
            ) {
              requestOrigin = parsedRequestUrl.origin;
            }
          } catch {
            // Fail closed below for malformed or non-network request URLs.
          }
          if (requestOrigin === undefined || !allowedOrigins.has(requestOrigin)) {
            await route.abort('blockedbyclient');
            return;
          }

          // Playwright does not route redirected requests through an ordinary
          // context handler reliably. Fetch one response without following it,
          // validate any Location target, then let Chromium process the
          // fulfilled response. This keeps redirect, form, click, and popup
          // navigation under the same origin policy as direct navigation.
          const response = await route.fetch({ maxRedirects: 0 });
          const location = response.headers()['location'];
          if (location !== undefined && response.status() >= 300 && response.status() < 400) {
            let redirectOrigin: string | undefined;
            try {
              const redirectUrl = new URL(location, requestUrl);
              if (
                redirectUrl.protocol === 'http:' ||
                redirectUrl.protocol === 'https:'
              ) {
                redirectOrigin = redirectUrl.origin;
              }
            } catch {
              // Fail closed below for an invalid redirect target.
            }
            if (redirectOrigin === undefined || !allowedOrigins.has(redirectOrigin)) {
              await route.abort('blockedbyclient');
              return;
            }
          }
          await route.fulfill({ response });
        });
      }
      await context.addInitScript(installInteractionListenerTracker);
      session = new PlaywrightBrowserSession(
        browser,
        context,
        profile,
        maxPagesPerSession,
        maxFramesPerObservation,
      );
      await session.initialize();
      return session;
    } catch (error) {
      if (session !== undefined) {
        await session.close().catch(() => {});
      } else {
        await context?.close().catch(() => {});
        await browser?.close().catch(() => {});
      }
      throw error;
    }
  }
}

export function createPlaywrightBrowserDriver(
  options: PlaywrightBrowserDriverOptions = {},
): PlaywrightBrowserDriver {
  return new PlaywrightBrowserDriver(options);
}

class PlaywrightBrowserSession implements BrowserDriverSession {
  readonly browserId = `browser_${randomUUID()}`;
  initialPageId = '';

  readonly #browser: Browser;
  readonly #context: BrowserContext;
  readonly #profile: SessionProfile;
  readonly #maxPages: number;
  readonly #maxFramesPerObservation: number;
  readonly #pages = new Map<string, PageRecord>();
  readonly #pageIds = new WeakMap<Page, string>();
  readonly #frameIds = new WeakMap<Frame, string>();
  readonly #targets = new Map<string, TargetBinding>();
  readonly #targetRegistries = new Map<
    Frame,
    JSHandle<WeakMap<HTMLElement, string>>
  >();
  #nextPage = 0;
  #nextFrame = 0;
  #nextTarget = 0;
  #closed = false;

  constructor(
    browser: Browser,
    context: BrowserContext,
    profile: SessionProfile,
    maxPages: number,
    maxFramesPerObservation: number,
  ) {
    this.#browser = browser;
    this.#context = context;
    this.#profile = profile;
    this.#maxPages = maxPages;
    this.#maxFramesPerObservation = maxFramesPerObservation;
    context.on('page', (page) => {
      if (
        this.#pageIds.get(page) === undefined &&
        this.#pages.size >= this.#maxPages
      ) {
        void page.close().catch(() => {});
        return;
      }
      this.#registerPage(page);
    });
  }

  async initialize(): Promise<void> {
    const page = await this.#context.newPage();
    try {
      this.initialPageId = this.#registerPage(page).pageId;
    } catch (error) {
      await page.close().catch(() => {});
      throw error;
    }
  }

  async navigate(input: DriverNavigateRequest): Promise<DriverObservation> {
    const record = this.#page(input.pageId);
    await record.page.goto(input.url, { waitUntil: 'domcontentloaded' });
    return this.observe({ pageId: input.pageId });
  }

  async observe(input: DriverObserveRequest): Promise<DriverObservation> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const record = this.#page(input.pageId);
      const startGeneration = record.generation;
      try {
        return await this.#observeAtGeneration(record, startGeneration);
      } catch (error) {
        const invalidated =
          error instanceof ObservationInvalidatedError ||
          record.generation !== startGeneration ||
          this.#pages.get(input.pageId) !== record;
        if (!invalidated) throw error;
        if (attempt === 1) {
          throw new Error(
            `Page ${input.pageId} changed document during observation twice; retry after it settles.`,
          );
        }
      }
    }
    throw new Error(`Could not observe page ${input.pageId}`);
  }

  async #observeAtGeneration(
    record: PageRecord,
    startGeneration: number,
  ): Promise<DriverObservation> {
    const entities: DriverObservedEntity[] = [];
    const relations: DriverObservedRelation[] = [];
    const capturedOmissions: ViewOmission[] = [];
    const visibleText: string[] = [];
    const stagedTargets = new Map<string, TargetBinding>();
    const pendingHandles = new Set<ElementHandle<HTMLElement>>();
    const frameSources = new Map<Frame, string>();
    const pendingFrameRelations: Array<{ parent: Frame; childSourceId: string }> = [];
    const recordBoundedAnalysis = (
      snapshot: Pick<
        BoundedElementBindingSnapshot,
        'omittedMatches' | 'scanTruncated'
      >,
    ): void => {
      const count =
        snapshot.omittedMatches + (snapshot.scanTruncated ? 1 : 0);
      if (count === 0) return;
      capturedOmissions.push({
        kind: 'analysis',
        count,
        reason: 'scan_cap',
        ...(snapshot.scanTruncated ? { exact: false } : {}),
      });
    };
    const mergeInteractionEvidence = (
      sourceId: string,
      facts: ElementFacts,
      evidence: InteractionEvidence,
    ): boolean => {
      const existing = entities.find((entity) => entity.sourceId === sourceId);
      if (existing === undefined) return false;
      const evidenceCapabilities = new Set(evidence.capabilities);
      for (const capability of facts.capabilities) {
        if (!evidenceCapabilities.has(capability.kind)) continue;
        const known = existing.capabilities?.find(
          (candidate) => candidate.kind === capability.kind,
        );
        if (known === undefined) {
          (existing.capabilities ??= []).push({ ...capability });
        } else if (capability.enabled === false) {
          known.enabled = false;
          if (capability.reason === undefined) delete known.reason;
          else known.reason = capability.reason;
          if (capability.confidence === undefined) delete known.confidence;
          else known.confidence = capability.confidence;
        }
      }
      existing.evidence = [
        ...(existing.evidence ?? []),
        {
          sensor: 'playwright-dom-interaction',
          detail: evidence.detail,
          confidence: evidence.confidence,
        },
      ];
      existing.confidence = Math.min(
        existing.confidence ?? 1,
        evidence.confidence,
      );
      return true;
    };

    try {
      const pageFrames = record.page.frames();
      const observedFrames = pageFrames.slice(0, this.#maxFramesPerObservation);
      if (pageFrames.length > observedFrames.length) {
        capturedOmissions.push({
          kind: 'analysis',
          count: pageFrames.length - observedFrames.length,
          reason: 'scan_cap',
        });
      }
      for (const frame of observedFrames) {
        const frameNamespace = this.#frameNamespace(frame);
        let frameTarget: DriverTarget | undefined;
        const parentFrame = frame.parentFrame();
        if (parentFrame !== null) {
          const rawFrameHandle = await frame.frameElement().catch(() => null);
          if (rawFrameHandle !== null) {
            const handle = rawFrameHandle as ElementHandle<HTMLElement>;
            try {
              if (await handle.isVisible().catch(() => false)) {
                const [facts, box] = await Promise.all([
                  handle.evaluate(readFrameFacts),
                  handle.boundingBox(),
                ]);
                frameTarget = await this.#stageTarget(
                  parentFrame,
                  record.pageId,
                  handle,
                  this.#targetCandidate(),
                  stagedTargets,
                );
                frameSources.set(frame, frameTarget.opaqueId);
                pendingFrameRelations.push({
                  parent: parentFrame,
                  childSourceId: frameTarget.opaqueId,
                });
                entities.push({
                  sourceId: frameTarget.opaqueId,
                  identityKey: [
                    frameNamespace,
                    identityDocumentUrl(frame.url()),
                    'document',
                    facts.signature,
                  ].join('\u001f'),
                  target: frameTarget,
                  kind: 'document',
                  role: 'document',
                  name: facts.name,
                  state: { visible: true },
                  capabilities: [],
                  evidence: [{ sensor: 'playwright-dom', confidence: 1 }],
                  confidence: 1,
                  ...(box === null
                    ? {}
                    : {
                        geometry: {
                          x: box.x,
                          y: box.y,
                          width: box.width,
                          height: box.height,
                        },
                      }),
                });
              } else {
                await handle.dispose().catch(() => {});
              }
            } catch (error) {
              await handle.dispose().catch(() => {});
              throw error;
            }
          }
        }

        const targetRegistry = await this.#targetRegistry(frame);
        const body = frame.locator('body');
        if ((await body.count()) > 0) {
          const text = await body
            .evaluate(readPerceptibleText)
            .catch(() => '');
          if (text.trim()) visibleText.push(text);
        }

        const scopeSnapshot = await snapshotBoundedElements(
          frame,
          SEMANTIC_SCOPE_SELECTOR,
          STANDARD_ELEMENT_POLICY.maxSemanticScopes,
        );
        recordBoundedAnalysis(scopeSnapshot);
        const scopeHandles = scopeSnapshot.handles;
        for (const handle of scopeHandles) pendingHandles.add(handle);
        const scopeCandidates = Array.from(
          { length: scopeHandles.length },
          () => this.#targetCandidate(),
        );
        const observedScopes = await mapOrderedConcurrent(
          scopeHandles.map((handle, index) => ({ handle, index })),
          OBSERVATION_CONCURRENCY,
          async ({ handle, index }) => {
            const [visible, interactiveDescendants] = await Promise.all([
              handle.isVisible().catch(() => false),
              handle
                .evaluate(
                  (element, selector) =>
                    element.querySelectorAll(selector).length,
                  INTERACTIVE_SELECTOR,
                )
                .catch(() => 0),
            ]);
            if (!visible || interactiveDescendants === 0) {
              pendingHandles.delete(handle);
              await handle.dispose().catch(() => {});
              return undefined;
            }
            try {
              const facts = await handle.evaluate(readScopeFacts);
              const target = await this.#stageTarget(
                frame,
                record.pageId,
                handle,
                scopeCandidates[index]!,
                stagedTargets,
              );
              pendingHandles.delete(handle);
              return { facts, target };
            } catch (error) {
              pendingHandles.delete(handle);
              await handle.dispose().catch(() => {});
              throw error;
            }
          },
        );
        for (const observedScope of observedScopes) {
          if (observedScope === undefined) continue;
          const { facts, target } = observedScope;
          entities.push({
            sourceId: target.opaqueId,
            identityKey: [
              frameNamespace,
              identityDocumentUrl(frame.url()),
              'scope',
              facts.signature,
            ].join('\u001f'),
            target,
            kind: 'region',
            role: facts.role,
            name: facts.name,
            state: { visible: true },
            capabilities: [],
            evidence: [{ sensor: 'playwright-dom', confidence: 1 }],
            confidence: 1,
          });
          if (frameTarget !== undefined) {
            relations.push({
              fromSourceId: frameTarget.opaqueId,
              toSourceId: target.opaqueId,
              kind: 'contains',
              confidence: 1,
            });
          }
        }

        const tableStructure = await snapshotTableStructure(
          frame,
          targetRegistry,
        );
        if (tableStructure.omittedEntities > 0) {
          capturedOmissions.push({
            kind: 'entities',
            count: tableStructure.omittedEntities,
            reason: 'scan_cap',
            ...(tableStructure.scanTruncated ? { exact: false } : {}),
          });
        }
        if (tableStructure.omittedContentCharacters > 0) {
          capturedOmissions.push({
            kind: 'content',
            count: tableStructure.omittedContentCharacters,
            reason: 'scan_cap',
          });
        }
        if (tableStructure.omittedRelations > 0) {
          capturedOmissions.push({
            kind: 'relations',
            count: tableStructure.omittedRelations,
            reason: 'scan_cap',
            ...(tableStructure.scanTruncated ? { exact: false } : {}),
          });
        }
        for (const binding of tableStructure.bindings) {
          pendingHandles.add(binding.handle);
        }
        const tableTargetCandidates = tableStructure.bindings.map(() =>
          this.#targetCandidate(),
        );
        const observedTableStructure = await mapOrderedConcurrent(
          tableStructure.bindings.map((binding, index) => ({ binding, index })),
          OBSERVATION_CONCURRENCY,
          async ({ binding, index }) => {
            try {
              const [target, box] = await Promise.all([
                this.#stageTarget(
                  frame,
                  record.pageId,
                  binding.handle,
                  tableTargetCandidates[index]!,
                  stagedTargets,
                ),
                binding.handle.boundingBox(),
              ]);
              pendingHandles.delete(binding.handle);
              return { ...binding, target, box };
            } catch (error) {
              pendingHandles.delete(binding.handle);
              await binding.handle.dispose().catch(() => {});
              throw error;
            }
          },
        );
        const tableSourceByIndex = new Map<number, string>();
        for (const observedStructure of observedTableStructure) {
          const { box, facts, index, target } = observedStructure;
          tableSourceByIndex.set(index, target.opaqueId);
          entities.push({
            sourceId: target.opaqueId,
            identityKey: [
              frameNamespace,
              identityDocumentUrl(frame.url()),
              'structure',
              facts.identityKey,
            ].join('\u001f'),
            target,
            kind: facts.kind,
            role: facts.role,
            ...(facts.name === undefined ? {} : { name: facts.name }),
            ...(facts.text === undefined ? {} : { text: facts.text }),
            ...(facts.value === undefined ? {} : { value: facts.value }),
            state: { visible: true },
            capabilities: [],
            evidence: [{ sensor: 'playwright-dom-structure', confidence: 1 }],
            confidence: 1,
            ...(box === null
              ? {}
              : {
                  geometry: {
                    x: box.x,
                    y: box.y,
                    width: box.width,
                    height: box.height,
                  },
                }),
          });
        }
        for (const observedStructure of observedTableStructure) {
          const sourceId = tableSourceByIndex.get(observedStructure.index);
          if (sourceId === undefined) continue;
          const parentSourceId =
            observedStructure.facts.parentIndex === undefined
              ? undefined
              : tableSourceByIndex.get(observedStructure.facts.parentIndex);
          if (observedStructure.facts.kind === 'table') {
            const ownerSourceId =
              observedStructure.facts.scopeSourceId ?? frameTarget?.opaqueId;
            if (ownerSourceId !== undefined) {
              relations.push({
                fromSourceId: ownerSourceId,
                toSourceId: sourceId,
                kind: 'contains',
                confidence: 1,
              });
            }
          } else if (
            observedStructure.facts.kind === 'row' &&
            parentSourceId !== undefined
          ) {
            relations.push(
              {
                fromSourceId: parentSourceId,
                toSourceId: sourceId,
                kind: 'contains',
                confidence: 1,
              },
              {
                fromSourceId: sourceId,
                toSourceId: parentSourceId,
                kind: 'row-of',
                confidence: 1,
              },
            );
          } else if (
            observedStructure.facts.kind === 'cell' &&
            parentSourceId !== undefined
          ) {
            relations.push(
              {
                fromSourceId: parentSourceId,
                toSourceId: sourceId,
                kind: 'contains',
                confidence: 1,
              },
              {
                fromSourceId: sourceId,
                toSourceId: parentSourceId,
                kind: 'cell-of',
                confidence: 1,
              },
            );
          }
        }

        const candidateSnapshot = await snapshotBoundedElements(
          frame,
          OBSERVABLE_SELECTOR,
          STANDARD_ELEMENT_POLICY.maxObservableElements,
        );
        recordBoundedAnalysis(candidateSnapshot);
        const candidateHandles = candidateSnapshot.handles;
        for (const handle of candidateHandles) pendingHandles.add(handle);
        const targetCandidates = Array.from(
          { length: candidateHandles.length },
          () => this.#targetCandidate(),
        );
        const observedCandidates = await mapOrderedConcurrent(
          candidateHandles.map((handle, index) => ({ handle, index })),
          OBSERVATION_CONCURRENCY,
          async ({ handle, index }) => {
            if (!(await handle.isVisible().catch(() => false))) {
              pendingHandles.delete(handle);
              await handle.dispose().catch(() => {});
              return undefined;
            }
            try {
              const [facts, box] = await Promise.all([
                handle.evaluate(readElementFacts, { targetRegistry }),
                handle.boundingBox(),
              ]);
              applySemanticActivationPolicy(facts);
              if (!facts.state.visible) {
                pendingHandles.delete(handle);
                await handle.dispose().catch(() => {});
                return undefined;
              }
              const target = await this.#stageTarget(
                frame,
                record.pageId,
                handle,
                targetCandidates[index]!,
                stagedTargets,
              );
              pendingHandles.delete(handle);
              return { box, facts, target };
            } catch (error) {
              pendingHandles.delete(handle);
              await handle.dispose().catch(() => {});
              throw error;
            }
          },
        );
        for (const observedCandidate of observedCandidates) {
          if (observedCandidate === undefined) continue;
          const { box, facts, target } = observedCandidate;
          const interactionEvidence = facts.interactionEvidence;
          if (
            interactionEvidence !== undefined &&
            mergeInteractionEvidence(
              target.opaqueId,
              facts,
              interactionEvidence,
            )
          ) {
            continue;
          }

          entities.push({
            sourceId: target.opaqueId,
            identityKey: [
              frameNamespace,
              identityDocumentUrl(frame.url()),
              facts.role ?? facts.kind,
              facts.semanticKey ?? '',
              facts.name ?? '',
              facts.container?.signature ?? '',
              facts.scope?.signature ?? '',
              facts.kind === 'status' ? facts.text ?? '' : '',
            ].join('\u001f'),
            target,
            kind: facts.kind,
            ...(facts.role === undefined ? {} : { role: facts.role }),
            ...(facts.name === undefined ? {} : { name: facts.name }),
            ...(facts.description === undefined ? {} : { description: facts.description }),
            ...(facts.text === undefined ? {} : { text: facts.text }),
            ...(facts.value === undefined ? {} : { value: facts.value }),
            state: facts.state,
            capabilities: facts.capabilities,
            evidence: [
              { sensor: 'playwright-dom', confidence: 1 },
              ...(interactionEvidence === undefined
                ? []
                : [
                    {
                      sensor: 'playwright-dom-interaction',
                      detail: interactionEvidence.detail,
                      confidence: interactionEvidence.confidence,
                    },
                  ]),
            ],
            confidence: interactionEvidence?.confidence ?? 1,
            ...(box === null
              ? {}
              : {
                  geometry: {
                    x: box.x,
                    y: box.y,
                    width: box.width,
                    height: box.height,
                  },
                }),
          });
          if (facts.container !== undefined) {
            relations.push({
              fromSourceId: facts.container.sourceId,
              toSourceId: target.opaqueId,
              kind: 'contains',
              confidence: 1,
            });
          } else if (facts.scope !== undefined) {
            relations.push({
              fromSourceId: facts.scope.sourceId,
              toSourceId: target.opaqueId,
              kind: 'contains',
              confidence: 1,
            });
          } else if (frameTarget !== undefined) {
            relations.push({
              fromSourceId: frameTarget.opaqueId,
              toSourceId: target.opaqueId,
              kind: 'contains',
              confidence: 1,
            });
          }
        }

        const semanticLabels = await snapshotSemanticLabelRelationships(
          frame,
          targetRegistry,
        );
        if (semanticLabels.omittedAnalysis > 0) {
          capturedOmissions.push({
            kind: 'analysis',
            count: semanticLabels.omittedAnalysis,
            reason: 'scan_cap',
            ...(semanticLabels.analysisCountExact ? {} : { exact: false }),
          });
        }
        for (const label of semanticLabels.labels) {
          pendingHandles.add(label.handle);
        }
        const labelTargetCandidates = semanticLabels.labels.map(() =>
          this.#targetCandidate(),
        );
        const observedLabels = await mapOrderedConcurrent(
          semanticLabels.labels.map((label, index) => ({ label, index })),
          OBSERVATION_CONCURRENCY,
          async ({ label, index }) => {
            try {
              const [target, box] = await Promise.all([
                this.#stageTarget(
                  frame,
                  record.pageId,
                  label.handle,
                  labelTargetCandidates[index]!,
                  stagedTargets,
                ),
                label.handle.boundingBox(),
              ]);
              pendingHandles.delete(label.handle);
              return { ...label, target, box };
            } catch (error) {
              pendingHandles.delete(label.handle);
              await label.handle.dispose().catch(() => {});
              throw error;
            }
          },
        );
        const labelSourceByIndex = new Map<number, string>();
        const controlBySource = new Map(
          entities.map((entity) => [entity.sourceId, entity]),
        );
        for (const observedLabel of observedLabels) {
          const { box, facts, index, target } = observedLabel;
          labelSourceByIndex.set(index, target.opaqueId);
          const linkedControlKeys = semanticLabels.relationships
            .filter((relationship) => relationship.labelIndex === index)
            .map(
              (relationship) =>
                controlBySource.get(relationship.controlSourceId)?.identityKey ?? '',
            )
            .filter(Boolean)
            .sort();
          entities.push({
            sourceId: target.opaqueId,
            identityKey: [
              frameNamespace,
              identityDocumentUrl(frame.url()),
              'label',
              facts.semanticKey ?? '',
              facts.scopeName ?? '',
              facts.text,
              linkedControlKeys.join('\u001e'),
            ].join('\u001f'),
            target,
            kind: 'text',
            role: 'label',
            text: facts.text,
            state: { visible: facts.visible },
            capabilities: [],
            evidence: facts.evidence.map((evidence) => ({ ...evidence })),
            confidence: facts.confidence,
            ...(box === null
              ? {}
              : {
                  geometry: {
                    x: box.x,
                    y: box.y,
                    width: box.width,
                    height: box.height,
                  },
                }),
          });
        }
        for (const relationship of semanticLabels.relationships) {
          const labelSourceId = labelSourceByIndex.get(relationship.labelIndex);
          const control = controlBySource.get(relationship.controlSourceId);
          if (labelSourceId === undefined || control === undefined) continue;
          if (relationship.inferred && control.name === undefined) {
            control.name = relationship.name;
            control.identityKey = [
              control.identityKey,
              relationship.scopeName ?? '',
              relationship.name,
            ].join('\u001f');
            control.evidence = [
              ...(control.evidence ?? []),
              {
                sensor: 'playwright-dom-relationship',
                detail: 'inferred-label',
                confidence: relationship.confidence,
              },
            ];
            control.confidence = Math.min(
              control.confidence ?? 1,
              relationship.confidence,
            );
          }
          relations.push({
            fromSourceId: labelSourceId,
            toSourceId: relationship.controlSourceId,
            kind: 'labels',
            confidence: relationship.confidence,
            evidence: relationship.evidence.map((evidence) => ({ ...evidence })),
          });
        }

        const optionSnapshot = await snapshotBoundedElements(
          frame,
          CHOICE_OPTION_SELECTOR,
          STANDARD_ELEMENT_POLICY.maxChoiceOptions,
        );
        recordBoundedAnalysis(optionSnapshot);
        const optionHandles = optionSnapshot.handles;
        for (const handle of optionHandles) pendingHandles.add(handle);
        const optionTargetCandidates = optionHandles.map(() =>
          this.#targetCandidate(),
        );
        const observedOptions = await mapOrderedConcurrent(
          optionHandles.map((handle, index) => ({ handle, index })),
          OBSERVATION_CONCURRENCY,
          async ({ handle, index }) => {
            try {
              const facts = await handle.evaluate(readChoiceOptionFacts, {
                targetRegistry,
              });
              if (facts === undefined) {
                pendingHandles.delete(handle);
                await handle.dispose().catch(() => {});
                return undefined;
              }
              const [target, box] = await Promise.all([
                this.#stageTarget(
                  frame,
                  record.pageId,
                  handle,
                  optionTargetCandidates[index]!,
                  stagedTargets,
                ),
                handle.boundingBox(),
              ]);
              pendingHandles.delete(handle);
              return { box, facts, target };
            } catch (error) {
              pendingHandles.delete(handle);
              await handle.dispose().catch(() => {});
              throw error;
            }
          },
        );
        for (const observedOption of observedOptions) {
          if (observedOption === undefined) continue;
          const { box, facts, target } = observedOption;
          entities.push({
            sourceId: target.opaqueId,
            identityKey: [
              frameNamespace,
              identityDocumentUrl(frame.url()),
              'option',
              facts.ownerSignature,
              facts.value,
              facts.name,
            ].join('\u001f'),
            target,
            kind: 'option',
            role: 'option',
            name: facts.name,
            value: facts.value,
            state: facts.state,
            capabilities: semanticActivationCapabilities(
              'option',
              facts.state,
              facts.nativeOption,
            ),
            evidence: [{ sensor: 'playwright-dom', confidence: 1 }],
            confidence: 1,
            ...(box === null
              ? {}
              : {
                  geometry: {
                    x: box.x,
                    y: box.y,
                    width: box.width,
                    height: box.height,
                  },
                }),
          });
          relations.push({
            fromSourceId: target.opaqueId,
            toSourceId: facts.ownerSourceId,
            kind: 'option-of',
            confidence: 1,
          });
        }

        const customCandidateSnapshot = await snapshotInteractionCandidates(frame);
        if (customCandidateSnapshot.omittedCandidates > 0) {
          capturedOmissions.push({
            kind: 'entities',
            count: customCandidateSnapshot.omittedCandidates,
            reason: 'scan_cap',
          });
        }
        if (customCandidateSnapshot.scanTruncated) {
          capturedOmissions.push({
            kind: 'analysis',
            count: 1,
            reason: 'scan_cap',
            exact: false,
          });
        }
        const customCandidates = customCandidateSnapshot.bindings;
        for (const candidate of customCandidates) {
          pendingHandles.add(candidate.handle);
        }
        const customTargetCandidates = customCandidates.map(() => this.#targetCandidate());
        const observedCustomCandidates = await mapOrderedConcurrent(
          customCandidates.map((candidate, index) => ({ candidate, index })),
          OBSERVATION_CONCURRENCY,
          async ({ candidate, index }) => {
            const handle = candidate.handle;
            try {
              if (
                !(await handle.evaluate((element) => element.isConnected).catch(() => false)) ||
                !(await handle.isVisible().catch(() => false))
              ) {
                pendingHandles.delete(handle);
                await handle.dispose().catch(() => {});
                return undefined;
              }
              const [facts, box] = await Promise.all([
                handle.evaluate(readElementFacts, {
                  targetRegistry,
                  interactionEvidence: candidate.evidence,
                }),
                handle.boundingBox(),
              ]);
              applySemanticActivationPolicy(facts);
              if (!facts.state.visible) {
                pendingHandles.delete(handle);
                await handle.dispose().catch(() => {});
                return undefined;
              }
              const target = await this.#stageTarget(
                frame,
                record.pageId,
                handle,
                customTargetCandidates[index]!,
                stagedTargets,
              );
              pendingHandles.delete(handle);
              return { box, facts, target };
            } catch (error) {
              pendingHandles.delete(handle);
              await handle.dispose().catch(() => {});
              throw error;
            }
          },
        );
        for (const observedCandidate of observedCustomCandidates) {
          if (observedCandidate === undefined) continue;
          const { box, facts, target } = observedCandidate;
          const interactionEvidence = facts.interactionEvidence;
          if (interactionEvidence === undefined) continue;
          if (
            mergeInteractionEvidence(
              target.opaqueId,
              facts,
              interactionEvidence,
            )
          ) {
            continue;
          }

          entities.push({
            sourceId: target.opaqueId,
            identityKey: [
              frameNamespace,
              identityDocumentUrl(frame.url()),
              facts.role ?? facts.kind,
              facts.semanticKey ?? '',
              facts.name ?? '',
              facts.container?.signature ?? '',
              facts.scope?.signature ?? '',
            ].join('\u001f'),
            target,
            kind: facts.kind,
            ...(facts.role === undefined ? {} : { role: facts.role }),
            ...(facts.name === undefined ? {} : { name: facts.name }),
            ...(facts.description === undefined ? {} : { description: facts.description }),
            ...(facts.text === undefined ? {} : { text: facts.text }),
            state: facts.state,
            capabilities: facts.capabilities,
            evidence: [
              {
                sensor: 'playwright-dom-interaction',
                detail: interactionEvidence.detail,
                confidence: interactionEvidence.confidence,
              },
            ],
            confidence: interactionEvidence.confidence,
            ...(box === null
              ? {}
              : {
                  geometry: {
                    x: box.x,
                    y: box.y,
                    width: box.width,
                    height: box.height,
                  },
                }),
          });
          if (facts.container !== undefined) {
            relations.push({
              fromSourceId: facts.container.sourceId,
              toSourceId: target.opaqueId,
              kind: 'contains',
              confidence: interactionEvidence.confidence,
            });
          } else if (facts.scope !== undefined) {
            relations.push({
              fromSourceId: facts.scope.sourceId,
              toSourceId: target.opaqueId,
              kind: 'contains',
              confidence: interactionEvidence.confidence,
            });
          } else if (frameTarget !== undefined) {
            relations.push({
              fromSourceId: frameTarget.opaqueId,
              toSourceId: target.opaqueId,
              kind: 'contains',
              confidence: interactionEvidence.confidence,
            });
          }
        }
      }

      for (const pending of pendingFrameRelations) {
        const parentSourceId = frameSources.get(pending.parent);
        if (parentSourceId === undefined) continue;
        relations.push({
          fromSourceId: parentSourceId,
          toSourceId: pending.childSourceId,
          kind: 'embeds-document',
          confidence: 1,
        });
      }
      const title = await record.page.title();
      const url = sanitizeModelFacingUrl(record.page.url());
      const compactedVisibleText = compactVisibleText(visibleText);
      const capturedAt = Date.now();
      if (
        record.generation !== startGeneration ||
        this.#pages.get(record.pageId) !== record
      ) {
        throw new ObservationInvalidatedError();
      }
      await this.#commitObservedTargets(record.pageId, stagedTargets);

      return {
        pageId: record.pageId,
        documentId: `${record.pageId}:${record.documentGeneration}`,
        url,
        title,
        visibleText: compactedVisibleText,
        entities,
        relations,
        ...(capturedOmissions.length === 0
          ? {}
          : {
              capturedOmissions: capturedOmissions
                .reduce<ViewOmission[]>((merged, omission) => {
                  const existing = merged.find(
                    (candidate) =>
                      candidate.kind === omission.kind &&
                      candidate.reason === omission.reason,
                  );
                  if (existing === undefined) merged.push({ ...omission });
                  else {
                    existing.count += omission.count;
                    if (omission.exact === false) existing.exact = false;
                  }
                  return merged;
                }, [])
                .sort(
                  (left, right) =>
                    left.kind.localeCompare(right.kind) ||
                    left.reason.localeCompare(right.reason),
                ),
            }),
        capturedAt,
      };
    } catch (error) {
      await Promise.all(
        [
          ...[...stagedTargets.values()].map(({ handle }) => handle),
          ...pendingHandles,
        ].map((handle) => handle.dispose().catch(() => {})),
      );
      throw error;
    }
  }

  async act(input: DriverActionRequest): Promise<DriverActionResult> {
    try {
      const record = this.#page(input.pageId);
      const action = input.action;

      switch (action.kind) {
        case 'click':
          await this.#target(input.pageId, action.target).handle.click();
          break;
        case 'contextClick':
          await this.#target(input.pageId, action.target).handle.click({ button: 'right' });
          break;
        case 'doubleClick':
          await this.#target(input.pageId, action.target).handle.dblclick();
          break;
        case 'fill':
          await this.#target(input.pageId, action.target).handle.fill(action.value);
          break;
        case 'type':
          await this.#target(input.pageId, action.target).handle.type(action.text);
          break;
        case 'press':
          if (action.target) await this.#target(input.pageId, action.target).handle.press(action.key);
          else await record.page.keyboard.press(action.key);
          break;
        case 'select':
          await this.#select(input.pageId, action.target, action.values);
          break;
        case 'check':
          await this.#target(input.pageId, action.target).handle.setChecked(action.checked);
          break;
        case 'hover':
          await this.#target(input.pageId, action.target).handle.hover();
          break;
        case 'focus':
          await this.#target(input.pageId, action.target).handle.focus();
          break;
        case 'scroll':
          if (action.target) {
            await this.#target(input.pageId, action.target).handle.evaluate(
              (element, delta) => {
                element.scrollBy(delta.x, delta.y);
              },
              { x: action.deltaX, y: action.deltaY },
            );
          } else {
            await record.page.mouse.wheel(action.deltaX, action.deltaY);
          }
          break;
        case 'drag':
          await this.#drag(input.pageId, action.target, action.destination);
          break;
        case 'upload':
          await this.#target(input.pageId, action.target).handle.setInputFiles(
            action.files.map((file) => ({
              name: file.name,
              mimeType: file.mediaType,
              buffer: Buffer.from(file.data),
            })),
          );
          break;
        default: {
          const unsupported: never = action;
          return {
            dispatched: false,
            error: {
              code: 'unsupported_action',
              message: `Unsupported Playwright action kind: ${String(
                (unsupported as { kind?: unknown }).kind,
              )}`,
            },
          };
        }
      }

      return { dispatched: true };
    } catch (error) {
      return {
        dispatched: error instanceof ActionMayHaveDispatchedError,
        error: {
          code: error instanceof Error && /stale opaque target/i.test(error.message) ? 'stale_target' : 'action_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async evaluateUnsafe(
    input: DriverUnsafeEvaluateRequest,
  ): Promise<DriverUnsafeEvaluateResult> {
    const record = this.#page(input.pageId);
    return evaluateUnsafeInPlaywrightPage(record.page, input, {
      invalidateBrowser: () => this.#beginUnsafeInvalidation(),
    });
  }

  async pages(): Promise<DriverPage[]> {
    this.#assertOpen();
    return Promise.all(
      [...this.#pages.values()].map(async ({ pageId, page }) => {
        const opener = await page.opener();
        const openerPageId = opener ? this.#pageIds.get(opener) : undefined;
        return {
          pageId,
          url: sanitizeModelFacingUrl(page.url()),
          title: await page.title().catch(() => ''),
          ...(openerPageId === undefined ? {} : { openerPageId }),
        };
      }),
    );
  }

  async capture(input: DriverCaptureRequest): Promise<CaptureResult> {
    const record = this.#page(input.pageId);
    const scroll = await record.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));

    if (input.kind === 'viewport') {
      const data = await record.page.screenshot({ type: 'png', fullPage: false });
      if (data.byteLength > MAX_CAPTURE_BYTES) {
        throw new Error(
          `Capture exceeds the ${MAX_CAPTURE_BYTES}-byte encoded-image limit.`,
        );
      }
      return {
        data,
        mediaType: 'image/png',
        pageId: input.pageId,
        width: this.#profile.width,
        height: this.#profile.height,
        deviceScaleFactor: this.#profile.deviceScaleFactor,
        scrollX: scroll.x,
        scrollY: scroll.y,
        capturedAt: Date.now(),
      };
    }

    if (!input.target) throw new Error('entity capture requires an opaque target');
    const binding = this.#target(input.pageId, input.target);
    const box = await binding.handle.boundingBox();
    if (!box) throw new Error(`Target ${input.target.opaqueId} has no visible bounding box`);
    const physicalPixels =
      box.width *
      box.height *
      this.#profile.deviceScaleFactor *
      this.#profile.deviceScaleFactor;
    if (physicalPixels > MAX_CAPTURE_PHYSICAL_PIXELS) {
      throw new Error(
        `Capture exceeds the ${MAX_CAPTURE_PHYSICAL_PIXELS} physical-pixel limit.`,
      );
    }
    const data = await binding.handle.screenshot({ type: 'png' });
    if (data.byteLength > MAX_CAPTURE_BYTES) {
      throw new Error(
        `Capture exceeds the ${MAX_CAPTURE_BYTES}-byte encoded-image limit.`,
      );
    }
    return {
      data,
      mediaType: 'image/png',
      pageId: input.pageId,
      width: Math.max(1, Math.round(box.width)),
      height: Math.max(1, Math.round(box.height)),
      deviceScaleFactor: this.#profile.deviceScaleFactor,
      scrollX: scroll.x,
      scrollY: scroll.y,
      clip: {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      },
      capturedAt: Date.now(),
    };
  }

  async close(input: DriverCloseRequest = {}): Promise<void> {
    if (this.#closed) return;
    if (input.pageId !== undefined) {
      const record = this.#page(input.pageId);
      await record.page.close();
      this.#removePage(input.pageId);
      return;
    }

    await Promise.all([...this.#targets.values()].map(({ handle }) => handle.dispose().catch(() => {})));
    await Promise.all(
      [...this.#targetRegistries.values()].map((registry) =>
        registry.dispose().catch(() => {}),
      ),
    );
    this.#targets.clear();
    this.#targetRegistries.clear();
    this.#pages.clear();
    const failures: unknown[] = [];
    await this.#context.close().catch((error: unknown) => {
      failures.push(error);
    });
    await this.#browser.close().catch((error: unknown) => {
      failures.push(error);
    });
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Failed to close the Playwright browser session cleanly.',
      );
    }
    this.#closed = true;
  }

  #beginUnsafeInvalidation(): {
    invalidated: true;
    cleanup: Promise<void>;
  } {
    if (this.#closed) {
      return { invalidated: true, cleanup: Promise.resolve() };
    }

    // This logical boundary is synchronous and irreversible. The caller can
    // safely return a browser-invalidated receipt even if Playwright or the
    // external Chromium process never confirms physical shutdown.
    this.#closed = true;
    const targetHandles = [...this.#targets.values()].map(({ handle }) => handle);
    const targetRegistries = [...this.#targetRegistries.values()];
    this.#targets.clear();
    this.#targetRegistries.clear();
    this.#pages.clear();

    const bestEffort = (operation: () => Promise<unknown>): Promise<void> =>
      Promise.resolve()
        .then(operation)
        .then(() => {}, () => {});
    const cleanup = Promise.all([
      ...targetHandles.map((handle) => bestEffort(() => handle.dispose())),
      ...targetRegistries.map((registry) =>
        bestEffort(() => registry.dispose()),
      ),
      bestEffort(() => this.#context.close()),
      bestEffort(() => this.#browser.close()),
    ]).then(() => {});
    return { invalidated: true, cleanup };
  }

  #registerPage(page: Page): PageRecord {
    const knownId = this.#pageIds.get(page);
    if (knownId) return this.#pages.get(knownId)!;

    const pageId = `page_${++this.#nextPage}`;
    const record: PageRecord = {
      pageId,
      page,
      generation: 0,
      documentGeneration: 0,
      pendingDocumentNavigations: new WeakSet(),
    };
    this.#pageIds.set(page, pageId);
    this.#pages.set(pageId, record);
    page.on('request', (request) => {
      if (request.isNavigationRequest()) {
        record.pendingDocumentNavigations.add(request.frame());
      }
    });
    page.on('framenavigated', (frame) => {
      record.generation += 1;
      if (record.pendingDocumentNavigations.has(frame)) {
        record.documentGeneration += 1;
        record.pendingDocumentNavigations.delete(frame);
      }
      this.#removeTargetRegistry(frame);
    });
    page.on('frameattached', () => {
      record.generation += 1;
      record.documentGeneration += 1;
    });
    page.on('framedetached', (frame) => {
      record.generation += 1;
      record.documentGeneration += 1;
      record.pendingDocumentNavigations.delete(frame);
      this.#removeTargetRegistry(frame);
    });
    page.once('close', () => {
      record.generation += 1;
      this.#removePage(pageId);
    });
    return record;
  }

  #removePage(pageId: string): void {
    const page = this.#pages.get(pageId)?.page;
    this.#pages.delete(pageId);
    for (const [opaqueId, binding] of this.#targets) {
      if (binding.pageId !== pageId) continue;
      void binding.handle.dispose().catch(() => {});
      this.#targets.delete(opaqueId);
    }
    if (page !== undefined) {
      for (const [frame, registry] of this.#targetRegistries) {
        if (frame.page() !== page) continue;
        this.#targetRegistries.delete(frame);
        void registry.dispose().catch(() => {});
      }
    }
  }

  #page(pageId: string): PageRecord {
    this.#assertOpen();
    const record = this.#pages.get(pageId);
    if (!record || record.page.isClosed()) throw new Error(`Unknown or closed page: ${pageId}`);
    return record;
  }

  #frameNamespace(frame: Frame): string {
    const knownId = this.#frameIds.get(frame);
    if (knownId) return knownId;
    const frameId = `frame_${++this.#nextFrame}`;
    this.#frameIds.set(frame, frameId);
    return frameId;
  }

  #targetCandidate(): string {
    return `target_${++this.#nextTarget}`;
  }

  #target(pageId: string, target: DriverTarget): TargetBinding {
    this.#assertOpen();
    const binding = this.#targets.get(target.opaqueId);
    if (!binding || binding.pageId !== pageId) {
      throw new Error(`Unknown or stale opaque target: ${target.opaqueId}`);
    }
    return binding;
  }

  async #stageTarget(
    frame: Frame,
    pageId: string,
    handle: ElementHandle<HTMLElement>,
    candidate: string,
    stagedTargets: Map<string, TargetBinding>,
  ): Promise<DriverTarget> {
    const registry = await this.#targetRegistry(frame);
    const opaqueId = await handle.evaluate(
      (element, input) => {
        let knownId = input.registry.get(element);
        if (knownId === undefined) {
          knownId = input.nextId;
          input.registry.set(element, knownId);
        }
        return knownId;
      },
      { registry, nextId: candidate },
    );

    const existing = stagedTargets.get(opaqueId);
    if (existing && existing.handle !== handle) {
      await handle.dispose().catch(() => {});
      return { opaqueId };
    }
    stagedTargets.set(opaqueId, { pageId, handle });
    return { opaqueId };
  }

  async #targetRegistry(
    frame: Frame,
  ): Promise<JSHandle<WeakMap<HTMLElement, string>>> {
    const existing = this.#targetRegistries.get(frame);
    if (existing !== undefined) return existing;
    const registry = await frame.evaluateHandle(
      () => new WeakMap<HTMLElement, string>(),
    );
    this.#targetRegistries.set(frame, registry);
    return registry;
  }

  #removeTargetRegistry(frame: Frame): void {
    const registry = this.#targetRegistries.get(frame);
    if (registry === undefined) return;
    this.#targetRegistries.delete(frame);
    void registry.dispose().catch(() => {});
  }

  async #commitObservedTargets(
    pageId: string,
    stagedTargets: Map<string, TargetBinding>,
  ): Promise<void> {
    const disposals: Promise<void>[] = [];
    for (const [opaqueId, binding] of this.#targets) {
      if (binding.pageId !== pageId) continue;
      const replacement = stagedTargets.get(opaqueId);
      if (replacement === undefined) {
        this.#targets.delete(opaqueId);
        disposals.push(binding.handle.dispose().catch(() => {}));
        continue;
      }
      if (replacement.handle !== binding.handle) {
        disposals.push(binding.handle.dispose().catch(() => {}));
      }
      this.#targets.set(opaqueId, replacement);
      stagedTargets.delete(opaqueId);
    }
    for (const [opaqueId, binding] of stagedTargets) {
      this.#targets.set(opaqueId, binding);
    }
    stagedTargets.clear();
    await Promise.all(disposals);
  }

  async #select(
    pageId: string,
    target: DriverTarget,
    values: string[],
  ): Promise<void> {
    const control = this.#target(pageId, target).handle;
    const isNativeSelect = await control.evaluate(
      (element) => element instanceof HTMLSelectElement,
    );
    if (isNativeSelect) {
      const page = this.#page(pageId).page;
      const mainFrame = page.mainFrame();
      let navigationRequestStarted = false;
      let navigationCommitted = false;
      let resolveNavigationRequest: (() => void) | undefined;
      let resolveNavigation: (() => void) | undefined;
      const navigationRequest = new Promise<void>((resolve) => {
        resolveNavigationRequest = resolve;
      });
      const navigation = new Promise<void>((resolve) => {
        resolveNavigation = resolve;
      });
      const onRequest = (request: Request) => {
        if (
          request.isNavigationRequest() &&
          request.frame() === mainFrame
        ) {
          navigationRequestStarted = true;
          resolveNavigationRequest?.();
        }
      };
      const onNavigated = (frame: Frame) => {
        if (frame !== mainFrame) return;
        navigationCommitted = true;
        resolveNavigation?.();
      };
      page.on('request', onRequest);
      page.on('framenavigated', onNavigated);
      let selectionDispatched = false;
      try {
        await control.selectOption(values);
        selectionDispatched = true;
        if (!navigationRequestStarted) {
          let detectionTimeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              navigationRequest,
              new Promise<void>((resolve) => {
                detectionTimeout = setTimeout(resolve, 100);
              }),
            ]);
          } finally {
            if (detectionTimeout !== undefined) {
              clearTimeout(detectionTimeout);
            }
          }
        }
        if (navigationRequestStarted && !navigationCommitted) {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              navigation,
              new Promise<never>((_, reject) => {
                timeout = setTimeout(
                  () =>
                    reject(
                      new Error(
                        'Timed out waiting for the selection postback to commit.',
                      ),
                    ),
                  5_000,
                );
              }),
            ]);
          } finally {
            if (timeout !== undefined) clearTimeout(timeout);
          }
        }
        if (navigationRequestStarted) {
          await mainFrame.waitForLoadState('domcontentloaded');
        }
      } catch (error) {
        if (selectionDispatched) {
          throw new ActionMayHaveDispatchedError(
            error instanceof Error ? error.message : String(error),
          );
        }
        throw error;
      } finally {
        page.off('request', onRequest);
        page.off('framenavigated', onNavigated);
      }
      return;
    }
    if (values.length !== 1) {
      throw new Error(
        'Custom choice controls currently require exactly one requested value.',
      );
    }

    const requested = values[0]!;
    const frame = await control.ownerFrame();
    if (frame === null) throw new Error('Choice control is no longer attached.');

    const exactMatches = async (): Promise<ElementHandle<HTMLElement>[]> => {
      const snapshot = await snapshotBoundedElements(
        frame,
        CHOICE_OPTION_SELECTOR,
        STANDARD_ELEMENT_POLICY.maxChoiceOptions,
      );
      const candidates = snapshot.handles;
      if (snapshot.scanTruncated || snapshot.omittedMatches > 0) {
        await Promise.all(
          candidates.map((candidate) => candidate.dispose().catch(() => {})),
        );
        throw new Error(
          'Choice option search exceeded its bounded scan; narrow or filter the option list before selecting.',
        );
      }
      const matches: ElementHandle<HTMLElement>[] = [];
      for (const candidate of candidates) {
        const matchesControl = await candidate
          .evaluate(
            (
              option,
              input: {
                control: HTMLElement;
                requested: string;
              },
            ) => {
              const normalize = (value: string | null | undefined): string =>
                value?.replace(/\s+/g, ' ').trim() ?? '';
              if (
                option.matches(':disabled') ||
                option.getAttribute('aria-disabled') === 'true'
              ) {
                return false;
              }
              const owner = input.control;
              const associated = (() => {
                if (
                  owner instanceof HTMLSelectElement &&
                  option instanceof HTMLOptionElement
                ) {
                  return option.closest('select') === owner;
                }
                if (owner.contains(option)) return true;
                const controlledIds = [
                  ...(owner
                    .getAttribute('aria-controls')
                    ?.split(/\s+/)
                    .filter(Boolean) ?? []),
                  ...(owner
                    .getAttribute('aria-owns')
                    ?.split(/\s+/)
                    .filter(Boolean) ?? []),
                ];
                for (
                  let ancestor = option.parentElement;
                  ancestor !== null;
                  ancestor = ancestor.parentElement
                ) {
                  if (ancestor.id && controlledIds.includes(ancestor.id)) {
                    return true;
                  }
                }
                return false;
              })();
              if (!associated) return false;
              const name =
                normalize(option.getAttribute('aria-label')) ||
                normalize(option.textContent);
              const value =
                (option instanceof HTMLOptionElement
                  ? normalize(option.value)
                  : '') ||
                normalize(option.getAttribute('value')) ||
                normalize(option.getAttribute('data-value')) ||
                name;
              return value === input.requested || name === input.requested;
            },
            { control, requested },
          )
          .catch(() => false);
        if (matchesControl) {
          matches.push(candidate);
        } else {
          await candidate.dispose().catch(() => {});
        }
      }
      return matches;
    };

    const knownMatches = await exactMatches();
    if (knownMatches.length !== 1) {
      await Promise.all(
        knownMatches.map((handle) => handle.dispose().catch(() => {})),
      );
      throw new Error(
        knownMatches.length === 0
          ? `No exact option matched ${JSON.stringify(requested)}.`
          : `${knownMatches.length} options exactly matched ${JSON.stringify(
              requested,
            )}; refusing an ambiguous selection.`,
      );
    }
    await knownMatches[0]!.dispose().catch(() => {});

    await control.click();

    let matches: ElementHandle<HTMLElement>[];
    try {
      matches = await exactMatches();
    } catch (error) {
      throw new ActionMayHaveDispatchedError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (matches.length !== 1) {
      await Promise.all(
        matches.map((handle) => handle.dispose().catch(() => {})),
      );
      throw new ActionMayHaveDispatchedError(
        matches.length === 0
          ? `Choice control opened, but no exact option matched ${JSON.stringify(
              requested,
            )}.`
          : `Choice control opened, but ${matches.length} options exactly matched ${JSON.stringify(
              requested,
            )}; refusing an ambiguous selection.`,
      );
    }

    const option = matches[0]!;
    try {
      if (!(await option.isVisible().catch(() => false))) {
        throw new ActionMayHaveDispatchedError(
          `Exact option ${JSON.stringify(requested)} is not currently visible.`,
        );
      }
      try {
        await option.click();
      } catch (error) {
        throw new ActionMayHaveDispatchedError(
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      await option.dispose().catch(() => {});
    }
  }

  async #drag(pageId: string, source: DriverTarget, destination: DriverTarget): Promise<void> {
    const page = this.#page(pageId).page;
    const sourceBox = await this.#target(pageId, source).handle.boundingBox();
    const destinationBox = await this.#target(pageId, destination).handle.boundingBox();
    if (!sourceBox || !destinationBox) throw new Error('drag source or destination is not visible');

    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    try {
      await page.mouse.move(
        destinationBox.x + destinationBox.width / 2,
        destinationBox.y + destinationBox.height / 2,
        { steps: 12 },
      );
    } finally {
      await page.mouse.up();
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(`Browser session ${this.browserId} is closed`);
  }
}

function identityDocumentUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url.split('#', 1)[0] ?? url;
  }
}

function compactVisibleText(chunks: string[]): string {
  const lines = chunks
    .flatMap((chunk) => chunk.split(/\r?\n/))
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const unique = [...new Set(lines)].join('\n');
  return unique.slice(0, MAX_VISIBLE_TEXT_LENGTH);
}

function readPerceptibleText(root: HTMLElement): string {
  const view = root.ownerDocument.defaultView;
  if (view === null) return '';
  const sensitiveHintPattern =
    /\b(?:password|passcode|passphrase|pin|one[- ]?time(?: code)?|otp|verification code|recovery code|api[- ]?key|access[- ]?token|refresh[- ]?token|private[- ]?key|client[- ]?secret|security code|card number|credit card|cvv|cvc)\b/i;
  const isSensitiveField = (candidate: HTMLElement): boolean => {
    const input =
      candidate instanceof HTMLInputElement ? candidate : undefined;
    const role = candidate.getAttribute('role')?.toLowerCase() ?? '';
    const fieldLike =
      input !== undefined ||
      candidate instanceof HTMLTextAreaElement ||
      candidate.isContentEditable ||
      ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(role);
    if (!fieldLike) return false;
    const labelledText = (
      candidate.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean) ?? []
    )
      .map((id) => candidate.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ');
    const hints = [
      candidate.getAttribute('aria-label'),
      labelledText,
      candidate.getAttribute('placeholder'),
      candidate.getAttribute('title'),
      candidate.getAttribute('name'),
      candidate.id,
      candidate.getAttribute('data-testid'),
      candidate.getAttribute('data-field'),
    ]
      .filter((hint): hint is string => Boolean(hint))
      .join(' ');
    return (
      input?.type === 'password' ||
      ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc'].includes(
        input?.autocomplete.toLowerCase() ?? '',
      ) ||
      candidate.getAttribute('data-sensitive') === 'true' ||
      sensitiveHintPattern.test(hints)
    );
  };
  const maxTextLength = 20_000;
  const textNodes: Text[] = [];
  const roots: Array<HTMLElement | ShadowRoot> = [root];
  const seenRoots = new Set<Node>();

  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const currentRoot = roots[rootIndex]!;
    if (seenRoots.has(currentRoot)) continue;
    seenRoots.add(currentRoot);

    const walker = root.ownerDocument.createTreeWalker(
      currentRoot,
      NodeFilter.SHOW_TEXT,
    );
    for (
      let node = walker.nextNode();
      node !== null && textNodes.length < 20_000;
      node = walker.nextNode()
    ) {
      if (node instanceof Text) textNodes.push(node);
    }

    const elements =
      currentRoot instanceof HTMLElement
        ? [currentRoot, ...Array.from(currentRoot.querySelectorAll('*'))]
        : Array.from(currentRoot.querySelectorAll('*'));
    for (const element of elements) {
      if (element.shadowRoot !== null) roots.push(element.shadowRoot);
    }
  }

  const lines: string[] = [];
  let characters = 0;
  for (const textNode of textNodes) {
    if (characters >= maxTextLength * 2) break;
    const text = textNode.data.replace(/\s+/g, ' ').trim();
    const parent = textNode.parentElement;
    if (
      !text ||
      parent === null ||
      ['script', 'style', 'noscript', 'template'].includes(
        parent.tagName.toLowerCase(),
      )
    ) {
      continue;
    }

    let insideSensitiveField = false;
    for (
      let current: HTMLElement | null = parent;
      current !== null;
      current =
        current.parentElement ??
        (current.getRootNode() instanceof ShadowRoot
          ? ((current.getRootNode() as ShadowRoot).host as HTMLElement)
          : null)
    ) {
      if (isSensitiveField(current)) {
        insideSensitiveField = true;
        break;
      }
    }
    if (insideSensitiveField) continue;

    let hidden = false;
    for (
      let current: HTMLElement | null = parent;
      current !== null;
      current =
        current.parentElement ??
        (current.getRootNode() instanceof ShadowRoot
          ? (current.getRootNode() as ShadowRoot).host as HTMLElement
          : null)
    ) {
      const style = view.getComputedStyle(current);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number(style.opacity) === 0
      ) {
        hidden = true;
        break;
      }
    }
    if (hidden) continue;

    const range = root.ownerDocument.createRange();
    range.selectNodeContents(textNode);
    const perceptible = Array.from(range.getClientRects()).some((rect) => {
      if (rect.width <= 0 || rect.height <= 0) return false;
      const left = Math.max(0, rect.left);
      const top = Math.max(0, rect.top);
      const right = Math.min(view.innerWidth, rect.right);
      const bottom = Math.min(view.innerHeight, rect.bottom);
      if (right <= left || bottom <= top) {
        const position = view.getComputedStyle(parent).position;
        return (
          position !== 'fixed' &&
          rect.right > 0 &&
          rect.left < view.innerWidth
        );
      }
      const x = left + (right - left) / 2;
      const y = top + (bottom - top) / 2;
      const nodeRoot = parent.getRootNode();
      const topElement =
        nodeRoot instanceof ShadowRoot
          ? nodeRoot.elementsFromPoint(x, y)[0]
          : root.ownerDocument.elementsFromPoint(x, y)[0];
      return (
        topElement !== undefined &&
        (topElement === parent || parent.contains(topElement))
      );
    });
    if (!perceptible) continue;
    lines.push(text);
    characters += text.length + 1;
  }
  return lines.join('\n');
}

async function snapshotBoundedElements(
  frame: Frame,
  selector: string,
  maxMatches: number,
): Promise<BoundedElementBindingSnapshot> {
  const batch = await frame.evaluateHandle(discoverBoundedElements, {
    selector,
    maxScannedElements: STANDARD_ELEMENT_POLICY.maxScannedElements,
    maxMatches,
  });
  const handles: ElementHandle<HTMLElement>[] = [];
  let elementsHandle: JSHandle<Element[]> | undefined;
  const disposableProperties: JSHandle[] = [];

  try {
    const snapshotFacts = await batch.evaluate((snapshot) => ({
      omittedMatches: snapshot.omittedMatches,
      scanTruncated: snapshot.scanTruncated,
    }));
    elementsHandle = await batch.getProperty('elements');
    const properties = await elementsHandle.getProperties();
    const entries = [...properties.entries()]
      .filter(([name]) => /^(?:0|[1-9]\d*)$/.test(name))
      .sort(([left], [right]) => Number(left) - Number(right));
    const numericNames = new Set(entries.map(([name]) => name));
    for (const [name, handle] of properties) {
      if (!numericNames.has(name)) disposableProperties.push(handle);
    }

    for (const [, property] of entries) {
      const handle = property.asElement() as ElementHandle<HTMLElement> | null;
      if (handle === null) {
        disposableProperties.push(property);
        continue;
      }
      handles.push(handle);
    }
    return {
      handles,
      omittedMatches: snapshotFacts.omittedMatches,
      scanTruncated: snapshotFacts.scanTruncated,
    };
  } catch (error) {
    await Promise.all(handles.map((handle) => handle.dispose().catch(() => {})));
    throw error;
  } finally {
    await Promise.all(
      disposableProperties.map((handle) => handle.dispose().catch(() => {})),
    );
    await elementsHandle?.dispose().catch(() => {});
    await batch.dispose().catch(() => {});
  }
}

async function snapshotTableStructure(
  frame: Frame,
  targetRegistry: JSHandle<WeakMap<HTMLElement, string>>,
): Promise<TableStructureBindingSnapshot> {
  const batch = await frame.evaluateHandle(discoverTableStructure, {
    targetRegistry,
    policy: TABLE_STRUCTURE_POLICY,
  });
  const bindings: TableStructureBinding[] = [];
  let elementsHandle: JSHandle<HTMLElement[]> | undefined;
  const disposableProperties: JSHandle[] = [];

  try {
    const snapshotFacts = await batch.evaluate((snapshot) => ({
      facts: snapshot.facts,
      omittedEntities: snapshot.omittedEntities,
      omittedRelations: snapshot.omittedRelations,
      omittedContentCharacters: snapshot.omittedContentCharacters,
      scanTruncated: snapshot.scanTruncated,
    }));
    elementsHandle = await batch.getProperty('elements');
    const properties = await elementsHandle.getProperties();
    const entries = [...properties.entries()]
      .filter(([name]) => /^(?:0|[1-9]\d*)$/.test(name))
      .sort(([left], [right]) => Number(left) - Number(right));
    const numericNames = new Set(entries.map(([name]) => name));
    for (const [name, handle] of properties) {
      if (!numericNames.has(name)) disposableProperties.push(handle);
    }

    for (const [name, property] of entries) {
      const index = Number(name);
      const handle = property.asElement() as ElementHandle<HTMLElement> | null;
      const facts = snapshotFacts.facts[index];
      if (handle === null || facts === undefined) {
        disposableProperties.push(property);
        continue;
      }
      bindings.push({ index, handle, facts });
    }
    return {
      bindings,
      omittedEntities: snapshotFacts.omittedEntities,
      omittedRelations: snapshotFacts.omittedRelations,
      omittedContentCharacters: snapshotFacts.omittedContentCharacters,
      scanTruncated: snapshotFacts.scanTruncated,
    };
  } catch (error) {
    await Promise.all(
      bindings.map(({ handle }) => handle.dispose().catch(() => {})),
    );
    throw error;
  } finally {
    await Promise.all(
      disposableProperties.map((handle) => handle.dispose().catch(() => {})),
    );
    await elementsHandle?.dispose().catch(() => {});
    await batch.dispose().catch(() => {});
  }
}

async function snapshotInteractionCandidates(
  frame: Frame,
): Promise<InteractionCandidateBindingSnapshot> {
  const batch = await frame.evaluateHandle(discoverInteractionCandidates, {
    scanLimit: MAX_CUSTOM_SCAN_ELEMENTS,
    retainLimit: MAX_CUSTOM_INTERACTION_TARGETS,
    standardSelector: [OBSERVABLE_SELECTOR, CHOICE_OPTION_SELECTOR].join(','),
  });
  const bindings: InteractionCandidateBinding[] = [];
  let elementsHandle: JSHandle<HTMLElement[]> | undefined;
  const disposableProperties: JSHandle[] = [];

  try {
    const snapshotFacts = await batch.evaluate((snapshot) => ({
      evidence: snapshot.evidence,
      omittedCandidates: snapshot.omittedCandidates,
      scanTruncated: snapshot.scanTruncated,
    }));
    elementsHandle = await batch.getProperty('elements');
    const properties = await elementsHandle.getProperties();
    const entries = [...properties.entries()]
      .filter(([name]) => /^(?:0|[1-9]\d*)$/.test(name))
      .sort(([left], [right]) => Number(left) - Number(right));
    const numericNames = new Set(entries.map(([name]) => name));
    for (const [name, handle] of properties) {
      if (!numericNames.has(name)) disposableProperties.push(handle);
    }

    for (const [name, elementProperty] of entries) {
      const elementHandle =
        elementProperty.asElement() as ElementHandle<HTMLElement> | null;
      if (elementHandle === null) {
        disposableProperties.push(elementProperty);
        continue;
      }
      const candidateEvidence = snapshotFacts.evidence[Number(name)];
      if (candidateEvidence === undefined) {
        disposableProperties.push(elementProperty);
        continue;
      }
      bindings.push({ handle: elementHandle, evidence: candidateEvidence });
    }

    return {
      bindings,
      omittedCandidates: snapshotFacts.omittedCandidates,
      scanTruncated: snapshotFacts.scanTruncated,
    };
  } catch (error) {
    await Promise.all(
      bindings.map(({ handle }) => handle.dispose().catch(() => {})),
    );
    throw error;
  } finally {
    await Promise.all(
      disposableProperties.map((handle) => handle.dispose().catch(() => {})),
    );
    await elementsHandle?.dispose().catch(() => {});
    await batch.dispose().catch(() => {});
  }
}

async function snapshotSemanticLabelRelationships(
  frame: Frame,
  targetRegistry: JSHandle<WeakMap<HTMLElement, string>>,
): Promise<SemanticLabelBindingSnapshot> {
  const batch = await frame.evaluateHandle(discoverSemanticLabelRelationships, {
    targetRegistry,
    policy: SEMANTIC_RELATIONSHIP_POLICY,
  });
  const labels: SemanticLabelBinding[] = [];
  let elementsHandle: JSHandle<HTMLElement[]> | undefined;
  const disposableProperties: JSHandle[] = [];

  try {
    const facts = await batch.evaluate((snapshot) => ({
      labels: snapshot.labels,
      relationships: snapshot.relationships,
      omittedAnalysis: snapshot.omittedAnalysis,
      analysisCountExact: snapshot.analysisCountExact,
    }));
    elementsHandle = await batch.getProperty('elements');
    const properties = await elementsHandle.getProperties();
    const entries = [...properties.entries()]
      .filter(([name]) => /^(?:0|[1-9]\d*)$/.test(name))
      .sort(([left], [right]) => Number(left) - Number(right));
    const numericNames = new Set(entries.map(([name]) => name));
    for (const [name, handle] of properties) {
      if (!numericNames.has(name)) disposableProperties.push(handle);
    }

    for (const [name, property] of entries) {
      const index = Number(name);
      const handle = property.asElement() as ElementHandle<HTMLElement> | null;
      const labelFacts = facts.labels[index];
      if (handle === null || labelFacts === undefined) {
        disposableProperties.push(property);
        continue;
      }
      labels.push({ index, handle, facts: labelFacts });
    }

    return {
      labels,
      relationships: facts.relationships,
      omittedAnalysis: facts.omittedAnalysis,
      analysisCountExact: facts.analysisCountExact,
    };
  } catch (error) {
    await Promise.all(labels.map(({ handle }) => handle.dispose().catch(() => {})));
    throw error;
  } finally {
    await Promise.all(
      disposableProperties.map((handle) => handle.dispose().catch(() => {})),
    );
    await elementsHandle?.dispose().catch(() => {});
    await batch.dispose().catch(() => {});
  }
}

function readFrameFacts(element: HTMLElement): FrameFacts {
  const normalized = (value: string | null | undefined): string | undefined => {
    const text = value?.replace(/\s+/g, ' ').trim();
    return text ? text : undefined;
  };
  const referencedText = (candidate: Element, attribute: string): string | undefined => {
    const ids = candidate.getAttribute(attribute)?.split(/\s+/).filter(Boolean) ?? [];
    return normalized(
      ids
        .map((id) => candidate.ownerDocument.getElementById(id)?.textContent ?? '')
        .join(' '),
    );
  };
  const accessibleName = (candidate: Element): string | undefined =>
    normalized(candidate.getAttribute('aria-label')) ??
    referencedText(candidate, 'aria-labelledby') ??
    normalized(candidate.getAttribute('title')) ??
    normalized(candidate.getAttribute('name'));

  const siblings = Array.from(element.ownerDocument.querySelectorAll('iframe,frame'));
  const ordinal = Math.max(1, siblings.indexOf(element) + 1);
  const baseName = accessibleName(element);
  const duplicateNameCount =
    baseName === undefined
      ? 0
      : siblings.filter((candidate) => accessibleName(candidate) === baseName).length;
  const name =
    baseName === undefined
      ? `Frame ${ordinal}`
      : duplicateNameCount > 1
        ? `${baseName} (frame ${ordinal})`
        : baseName;
  const signature = [
    element.tagName.toLowerCase(),
    normalized(element.id),
    normalized(element.getAttribute('name')),
    String(ordinal),
  ]
    .filter(Boolean)
    .join('\u001e');
  return { name, signature };
}

function readScopeFacts(element: HTMLElement): ScopeFacts {
  const normalized = (value: string | null | undefined): string | undefined => {
    const text = value?.replace(/\s+/g, ' ').trim();
    return text ? text : undefined;
  };
  const referencedText = (attribute: string): string | undefined => {
    const ids = element.getAttribute(attribute)?.split(/\s+/).filter(Boolean) ?? [];
    const root = element.getRootNode();
    return normalized(
      ids
        .map((id) => {
          const local =
            root instanceof Document || root instanceof ShadowRoot
              ? root.getElementById(id)
              : null;
          return (
            local?.textContent ??
            element.ownerDocument.getElementById(id)?.textContent ??
            ''
          );
        })
        .join(' '),
    );
  };
  const tag = element.tagName.toLowerCase();
  const explicitRole = normalized(element.getAttribute('role'));
  const role: ScopeFacts['role'] =
    explicitRole === 'navigation' || explicitRole === 'main' || explicitRole === 'toolbar'
      ? explicitRole
      : tag === 'nav'
        ? 'navigation'
        : 'main';
  const semanticName =
    normalized(element.getAttribute('aria-label')) ?? referencedText('aria-labelledby');
  const name =
    semanticName ??
    (role === 'main'
      ? normalized(element.ownerDocument.title) ?? 'Main content'
      : role === 'navigation'
        ? 'Navigation'
        : 'Toolbar');
  return { role, name, signature: [role, semanticName ?? ''].join('\u001e') };
}

function installInteractionListenerTracker(): void {
  const listenersKey = Symbol.for('@browserir/playwright/interaction-listeners');
  const patchedKey = Symbol.for('@browserir/playwright/interaction-listeners-patched');
  const trackedTypes = new Set([
    'click',
    'dblclick',
    'dragstart',
    'dragover',
    'drop',
  ]);
  const prototype = EventTarget.prototype as EventTarget & {
    [key: symbol]: boolean | undefined;
  };
  if (prototype[patchedKey] === true) return;

  const originalAdd = prototype.addEventListener;
  const originalRemove = prototype.removeEventListener;
  Object.defineProperty(prototype, patchedKey, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  prototype.addEventListener = function (
    this: EventTarget,
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    Reflect.apply(originalAdd, this, [type, callback, options]);
    if (
      !(this instanceof Element) ||
      callback === null ||
      !trackedTypes.has(type.toLowerCase())
    ) {
      return;
    }
    try {
      const target = this as Element & {
        [key: symbol]: Map<string, Set<EventListenerOrEventListenerObject>> | undefined;
      };
      let listeners = target[listenersKey];
      if (listeners === undefined) {
        listeners = new Map();
        Object.defineProperty(target, listenersKey, {
          value: listeners,
          configurable: true,
          enumerable: false,
          writable: false,
        });
      }
      const normalizedType = type.toLowerCase();
      let callbacks = listeners.get(normalizedType);
      if (callbacks === undefined) {
        callbacks = new Set();
        listeners.set(normalizedType, callbacks);
      }
      callbacks.add(callback);
    } catch {
      // Bookkeeping is advisory and must never change native listener behavior.
    }
  };

  prototype.removeEventListener = function (
    this: EventTarget,
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    Reflect.apply(originalRemove, this, [type, callback, options]);
    if (
      !(this instanceof Element) ||
      callback === null ||
      !trackedTypes.has(type.toLowerCase())
    ) {
      return;
    }
    try {
      const target = this as Element & {
        [key: symbol]: Map<string, Set<EventListenerOrEventListenerObject>> | undefined;
      };
      target[listenersKey]?.get(type.toLowerCase())?.delete(callback);
    } catch {
      // Bookkeeping is advisory and must never change native listener behavior.
    }
  };
}

function discoverBoundedElements(input: {
  selector: string;
  maxScannedElements: number;
  maxMatches: number;
}): BoundedElementSnapshot {
  const elements: Element[] = [];
  const roots: Array<Document | ShadowRoot> = [document];
  const maxScannedElements = Math.max(
    0,
    Math.floor(input.maxScannedElements),
  );
  const maxMatches = Math.max(0, Math.floor(input.maxMatches));
  let scannedElements = 0;
  let omittedMatches = 0;
  let scanTruncated = false;

  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const root = roots[rootIndex]!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (
      let candidate = walker.nextNode() as Element | null;
      candidate !== null;
      candidate = walker.nextNode() as Element | null
    ) {
      if (scannedElements >= maxScannedElements) {
        scanTruncated = true;
        break;
      }
      scannedElements += 1;
      if (candidate.shadowRoot !== null) roots.push(candidate.shadowRoot);
      if (!candidate.matches(input.selector)) continue;
      if (elements.length < maxMatches) elements.push(candidate);
      else omittedMatches += 1;
    }
    if (scanTruncated) break;
  }

  return { elements, omittedMatches, scanTruncated };
}

function discoverTableStructure(input: {
  targetRegistry: WeakMap<HTMLElement, string>;
  policy: TableStructurePolicy;
}): TableStructureSnapshot {
  const tableSelector = 'table,[role="table"],[role="grid"],[role="treegrid"]';
  const rowSelector = 'tr,[role="row"]';
  const cellSelector =
    'th,td,[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]';
  const structureSelector = `${tableSelector},${rowSelector},${cellSelector}`;
  const scopeSelector =
    'nav,main,[role="navigation"],[role="main"],[role="toolbar"]';
  const elements: HTMLElement[] = [];
  const facts: TableStructureFacts[] = [];
  const retainedIndex = new Map<HTMLElement, number>();
  const roots: Array<Document | ShadowRoot> = [document];
  const candidates: HTMLElement[] = [];
  let scannedElements = 0;
  let scanTruncated = false;
  let omittedEntities = 0;
  let omittedRelations = 0;
  let omittedContentCharacters = 0;

  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const root = roots[rootIndex]!;
    const descendants = root.querySelectorAll<HTMLElement>('*');
    for (let index = 0; index < descendants.length; index += 1) {
      if (scannedElements >= input.policy.maxScannedElements) {
        scanTruncated = true;
        break;
      }
      const candidate = descendants[index]!;
      scannedElements += 1;
      if (candidate.shadowRoot !== null) roots.push(candidate.shadowRoot);
      if (candidate.matches(structureSelector)) candidates.push(candidate);
    }
    if (scanTruncated) break;
  }
  if (scanTruncated) {
    // The exact number of semantic entities beyond the scan boundary is unknowable
    // without violating the boundary. One records the guaranteed incomplete scan.
    omittedEntities += 1;
    omittedRelations += 1;
  }

  const normalize = (
    value: string | null | undefined,
    accountForTruncation = false,
  ): string | undefined => {
    const text = value?.replace(/\s+/g, ' ').trim();
    if (!text) return undefined;
    if (text.length <= input.policy.maxTextCharacters) return text;
    if (accountForTruncation) {
      omittedContentCharacters += text.length - input.policy.maxTextCharacters;
    }
    return `${text.slice(0, Math.max(0, input.policy.maxTextCharacters - 1))}…`;
  };
  const parentAcrossRoots = (element: HTMLElement): HTMLElement | null => {
    if (element.parentElement !== null) return element.parentElement;
    const root = element.getRootNode();
    return root instanceof ShadowRoot ? (root.host as HTMLElement) : null;
  };
  const isPerceptible = (element: HTMLElement): boolean => {
    const view = element.ownerDocument.defaultView;
    if (view === null) return false;
    for (
      let current: HTMLElement | null = element;
      current !== null;
      current = parentAcrossRoots(current)
    ) {
      if (
        current.hidden ||
        current.inert ||
        current.getAttribute('aria-hidden') === 'true'
      ) {
        return false;
      }
      const style = view.getComputedStyle(current);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const semanticText = (element: HTMLElement): string | undefined => {
    const walker = element.ownerDocument.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
    );
    const chunks: string[] = [];
    let collectedCharacters = 0;
    let stoppedEarly = false;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = node.parentElement;
      const text = node.textContent?.replace(/\s+/g, ' ').trim();
      if (
        parent === null ||
        !text ||
        ['script', 'style', 'noscript', 'template'].includes(
          parent.tagName.toLowerCase(),
        ) ||
        !isPerceptible(parent)
      ) {
        continue;
      }
      chunks.push(text);
      collectedCharacters += text.length + 1;
      if (collectedCharacters > input.policy.maxTextCharacters * 4) {
        stoppedEarly = true;
        break;
      }
    }
    if (stoppedEarly) omittedContentCharacters += 1;
    return normalize(chunks.join(' '), true);
  };
  const referencedText = (
    element: HTMLElement,
    attribute: string,
  ): string | undefined => {
    const ids =
      element.getAttribute(attribute)?.split(/\s+/).filter(Boolean).slice(0, 16) ?? [];
    const root = element.getRootNode();
    return normalize(
      ids
        .map((id) => {
          const local = (
            root as Node & {
              getElementById?: (candidateId: string) => Element | null;
            }
          ).getElementById?.(id);
          return (
            local?.textContent ??
            element.ownerDocument.getElementById(id)?.textContent ??
            ''
          );
        })
        .join(' '),
      true,
    );
  };
  const accessibleName = (element: HTMLElement): string | undefined =>
    normalize(element.getAttribute('aria-label'), true) ??
    referencedText(element, 'aria-labelledby');
  const positiveIntegerAttribute = (
    element: HTMLElement,
    attribute: string,
  ): number | undefined => {
    const raw = element.getAttribute(attribute);
    if (raw === null || !/^[1-9]\d*$/.test(raw)) return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : undefined;
  };
  const explicitKey = (
    element: HTMLElement,
    attributes: readonly string[],
  ): string | undefined => {
    for (const attribute of attributes) {
      const value = normalize(
        attribute === 'id'
          ? element.id
          : element.getAttribute(attribute),
      );
      if (value !== undefined) return `${attribute}:${value}`;
    }
    return undefined;
  };
  const closestTable = (element: HTMLElement): HTMLElement | null =>
    element.closest<HTMLElement>(tableSelector);
  const closestRow = (element: HTMLElement): HTMLElement | null =>
    element.closest<HTMLElement>(rowSelector);
  const classify = (
    element: HTMLElement,
  ): TableStructureFacts['kind'] | undefined => {
    const tag = element.tagName.toLowerCase();
    const role = normalize(element.getAttribute('role'));
    if (
      tag === 'table' ||
      role === 'table' ||
      role === 'grid' ||
      role === 'treegrid'
    ) {
      return 'table';
    }
    if (tag === 'tr' || role === 'row') return 'row';
    if (
      tag === 'th' ||
      tag === 'td' ||
      role === 'cell' ||
      role === 'gridcell' ||
      role === 'columnheader' ||
      role === 'rowheader'
    ) {
      return 'cell';
    }
    return undefined;
  };

  let retainedTables = 0;
  let retainedRows = 0;
  let retainedCells = 0;
  let encounteredTables = 0;
  const encounteredRows = new Map<HTMLElement, number>();
  const encounteredCells = new Map<HTMLElement, number>();
  const structuralIdentity = new Map<HTMLElement, string>();

  for (const candidate of candidates) {
    const kind = classify(candidate);
    if (kind === undefined) continue;
    if (kind === 'table') encounteredTables += 1;
    if (!isPerceptible(candidate)) continue;

    if (kind === 'table') {
      if (retainedTables >= input.policy.maxTables) {
        omittedEntities += 1;
        omittedRelations += 1;
        continue;
      }
      retainedTables += 1;
      const explicitRole = normalize(candidate.getAttribute('role'));
      const role =
        explicitRole === 'grid' || explicitRole === 'treegrid'
          ? explicitRole
          : 'table';
      const caption =
        candidate instanceof HTMLTableElement
          ? normalize(candidate.caption?.innerText, true)
          : undefined;
      const semanticName = accessibleName(candidate) ?? caption;
      const name =
        semanticName ??
        `${role === 'treegrid' ? 'Tree grid' : role === 'grid' ? 'Grid' : 'Table'} ${encounteredTables}`;
      const key = explicitKey(candidate, [
        'data-record-id',
        'data-row-id',
        'data-key',
        'data-id',
        'id',
      ]);
      const identityKey = [
        'table',
        role,
        key ??
          (semanticName === undefined
            ? `ordinal:${encounteredTables}`
            : `name:${semanticName}`),
      ].join('\u001e');
      structuralIdentity.set(candidate, identityKey);
      const rowCount = positiveIntegerAttribute(candidate, 'aria-rowcount');
      const columnCount = positiveIntegerAttribute(candidate, 'aria-colcount');
      const value: TableStructureValue = {
        ...(rowCount === undefined ? {} : { rowCount }),
        ...(columnCount === undefined ? {} : { columnCount }),
      };
      const scope = candidate.closest<HTMLElement>(scopeSelector);
      const scopeSourceId =
        scope === null ? undefined : input.targetRegistry.get(scope);
      const index = elements.length;
      retainedIndex.set(candidate, index);
      elements.push(candidate);
      facts.push({
        kind,
        role,
        identityKey,
        name,
        ...(Object.keys(value).length === 0 ? {} : { value }),
        ...(scopeSourceId === undefined ? {} : { scopeSourceId }),
      });
      continue;
    }

    const table = closestTable(candidate);
    if (table === null) continue;
    const tableIndex = table === null ? undefined : retainedIndex.get(table);
    const tableIdentity =
      table === null ? undefined : structuralIdentity.get(table);
    if (tableIndex === undefined || tableIdentity === undefined) {
      omittedEntities += 1;
      omittedRelations += 2;
      continue;
    }

    if (kind === 'row') {
      const nextOrdinal = (encounteredRows.get(table) ?? 0) + 1;
      encounteredRows.set(table, nextOrdinal);
      if (retainedRows >= input.policy.maxRows) {
        omittedEntities += 1;
        omittedRelations += 2;
        continue;
      }
      retainedRows += 1;
      const text = semanticText(candidate);
      const name = accessibleName(candidate) ?? text;
      const recordKey = explicitKey(candidate, [
        'data-record-id',
        'data-row-id',
        'data-key',
        'data-id',
        'id',
      ]);
      const rowIndex = positiveIntegerAttribute(candidate, 'aria-rowindex');
      const discriminator =
        recordKey ??
        (rowIndex === undefined
          ? `ordinal:${nextOrdinal}\u001etext:${text ?? ''}`
          : `aria-rowindex:${rowIndex}`);
      const identityKey = [tableIdentity, 'row', discriminator].join('\u001e');
      structuralIdentity.set(candidate, identityKey);
      const index = elements.length;
      retainedIndex.set(candidate, index);
      elements.push(candidate);
      facts.push({
        kind,
        role: 'row',
        identityKey,
        ...(name === undefined ? {} : { name }),
        ...(text === undefined ? {} : { text }),
        ...(rowIndex === undefined ? {} : { value: { rowIndex } }),
        parentIndex: tableIndex,
      });
      continue;
    }

    const row = closestRow(candidate);
    if (row === null) continue;
    const rowIndex = row === null ? undefined : retainedIndex.get(row);
    const rowIdentity = row === null ? undefined : structuralIdentity.get(row);
    if (rowIndex === undefined || rowIdentity === undefined) {
      omittedEntities += 1;
      omittedRelations += 2;
      continue;
    }
    const nextOrdinal = (encounteredCells.get(row) ?? 0) + 1;
    encounteredCells.set(row, nextOrdinal);
    if (retainedCells >= input.policy.maxCells) {
      omittedEntities += 1;
      omittedRelations += 2;
      continue;
    }
    retainedCells += 1;
    const tag = candidate.tagName.toLowerCase();
    const explicitRole = normalize(candidate.getAttribute('role'));
    const role =
      explicitRole === 'cell' ||
      explicitRole === 'gridcell' ||
      explicitRole === 'columnheader' ||
      explicitRole === 'rowheader'
        ? explicitRole
        : tag === 'th'
          ? candidate.getAttribute('scope') === 'row'
            ? 'rowheader'
            : 'columnheader'
          : 'cell';
    const text = semanticText(candidate);
    const name = accessibleName(candidate);
    const columnIndex = positiveIntegerAttribute(candidate, 'aria-colindex');
    const columnKey = explicitKey(candidate, [
      'data-column-key',
      'data-col-key',
      'headers',
      'id',
    ]);
    const discriminator =
      columnKey ??
      (columnIndex === undefined
        ? `ordinal:${nextOrdinal}`
        : `aria-colindex:${columnIndex}`);
    const identityKey = [rowIdentity, 'cell', discriminator].join('\u001e');
    structuralIdentity.set(candidate, identityKey);
    const index = elements.length;
    retainedIndex.set(candidate, index);
    elements.push(candidate);
    facts.push({
      kind,
      role,
      identityKey,
      ...(name === undefined ? {} : { name }),
      ...(text === undefined ? {} : { text }),
      ...(columnIndex === undefined ? {} : { value: { columnIndex } }),
      parentIndex: rowIndex,
    });
  }

  return {
    elements,
    facts,
    omittedEntities,
    omittedRelations,
    omittedContentCharacters,
    scanTruncated,
  };
}

function discoverInteractionCandidates(
  options: {
    scanLimit: number;
    retainLimit: number;
    standardSelector: string;
  },
): InteractionSnapshot {
  const standardSelector = options.standardSelector;
  const semanticScopeSelector = [
    'html',
    'body',
    'nav',
    'main',
    '[role="navigation"]',
    '[role="main"]',
    '[role="toolbar"]',
  ].join(',');
  const listenersKey = Symbol.for('@browserir/playwright/interaction-listeners');
  const scanLimit = Math.max(0, Math.floor(options.scanLimit));
  const scannedElements: Element[] = [];
  let scanTruncated = false;
  const collectElements = (root: Document | ShadowRoot): void => {
    for (const element of Array.from(root.querySelectorAll('*'))) {
      if (scannedElements.length >= scanLimit) {
        scanTruncated = true;
        return;
      }
      scannedElements.push(element);
      if (element.shadowRoot !== null) collectElements(element.shadowRoot);
      if (scanTruncated) return;
    }
  };
  collectElements(document);
  const evidenceByElement = new Map<HTMLElement, InteractionCandidate>();
  const composedParent = (element: Element): HTMLElement | null => {
    if (element.parentElement !== null) return element.parentElement;
    const root = element.getRootNode();
    return root instanceof ShadowRoot && root.host instanceof HTMLElement
      ? root.host
      : null;
  };
  const standardElements = new Set<HTMLElement>();
  const standardAncestors = new Set<HTMLElement>();

  const handlerRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  const ownDataPropertyValue = (
    target: object,
    propertyName: string,
  ): unknown => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(target, propertyName);
      return descriptor !== undefined && 'value' in descriptor
        ? descriptor.value
        : undefined;
    } catch {
      return undefined;
    }
  };
  const hasFunction = (record: Record<string, unknown>, names: string[]): boolean =>
    names.some((name) => typeof record[name] === 'function');
  const trackedListenerCount = (
    element: HTMLElement,
    type: 'click' | 'dblclick' | 'dragstart' | 'dragover' | 'drop',
  ): number => {
    try {
      const target = element as HTMLElement & {
        [key: symbol]: Map<string, Set<EventListenerOrEventListenerObject>> | undefined;
      };
      return target[listenersKey]?.get(type)?.size ?? 0;
    } catch {
      return 0;
    }
  };

  for (const element of scannedElements) {
    if (element instanceof HTMLElement && element.matches(standardSelector)) {
      standardElements.add(element);
    }
  }
  for (const element of standardElements) {
    for (
      let ancestor = composedParent(element);
      ancestor !== null;
      ancestor = composedParent(ancestor)
    ) {
      standardAncestors.add(ancestor);
    }
  }

  for (let index = 0; index < scannedElements.length; index += 1) {
    const element = scannedElements[index];
    if (
      !(element instanceof HTMLElement) ||
      standardElements.has(element) ||
      element.matches(semanticScopeSelector)
    ) {
      continue;
    }
    const accessibleText =
      element.getAttribute('aria-label')?.trim() ||
      element.getAttribute('title')?.trim() ||
      element.innerText.replace(/\s+/g, ' ').trim();
    if (!accessibleText) continue;

    const signals: Array<{
      detail: InteractionEvidence['detail'];
      confidence: number;
      capability?: Capability['kind'];
      acceptsDrop?: boolean;
      priority: number;
    }> = [];
    const addSignal = (
      detail: InteractionEvidence['detail'],
      confidence: number,
      priority: number,
      capability?: Capability['kind'],
      acceptsDrop = false,
    ): void => {
      signals.push({
        detail,
        confidence,
        priority,
        ...(capability === undefined ? {} : { capability }),
        ...(acceptsDrop ? { acceptsDrop: true } : {}),
      });
    };
    for (const propertyName of Object.getOwnPropertyNames(element)) {
      if (propertyName.startsWith('__reactProps$')) {
        const props = handlerRecord(
          ownDataPropertyValue(element, propertyName),
        );
        if (props) {
          if (hasFunction(props, ['onClick', 'onClickCapture'])) {
            addSignal('react-click-handler', 0.98, 10, 'click');
          }
          if (hasFunction(props, ['onDoubleClick', 'onDoubleClickCapture'])) {
            addSignal(
              'react-double-click-handler',
              0.98,
              50,
              'doubleClick',
            );
          }
          if (hasFunction(props, ['onDragStart', 'onDragStartCapture'])) {
            addSignal('react-drag-start-handler', 0.98, 45, 'drag');
          }
          if (
            hasFunction(props, [
              'onDrop',
              'onDropCapture',
              'onDragOver',
              'onDragOverCapture',
            ])
          ) {
            addSignal('react-drop-handler', 0.98, 40, undefined, true);
          }
        }
      }
      if (propertyName === '_vei' || propertyName === '__vei') {
        const invokers = handlerRecord(
          ownDataPropertyValue(element, propertyName),
        );
        if (invokers) {
          const names = Object.keys(invokers);
          if (names.some((name) => /(?:^|:)on?click(?:capture)?$/i.test(name))) {
            addSignal('vue-click-handler', 0.98, 10, 'click');
          }
          if (names.some((name) => /(?:^|:)on?dblclick(?:capture)?$/i.test(name))) {
            addSignal(
              'vue-double-click-handler',
              0.98,
              50,
              'doubleClick',
            );
          }
          if (names.some((name) => /(?:^|:)on?dragstart(?:capture)?$/i.test(name))) {
            addSignal('vue-drag-start-handler', 0.98, 45, 'drag');
          }
          if (
            names.some((name) =>
              /(?:^|:)on?(?:drop|dragover)(?:capture)?$/i.test(name),
            )
          ) {
            addSignal('vue-drop-handler', 0.98, 40, undefined, true);
          }
        }
      }
    }

    if (trackedListenerCount(element, 'click') > 0) {
      addSignal('dom-click-listener', 0.95, 10, 'click');
    }
    if (trackedListenerCount(element, 'dblclick') > 0) {
      addSignal('dom-double-click-listener', 0.95, 50, 'doubleClick');
    }
    if (trackedListenerCount(element, 'dragstart') > 0) {
      addSignal('dom-drag-start-listener', 0.95, 45, 'drag');
    }
    if (
      trackedListenerCount(element, 'drop') > 0 ||
      trackedListenerCount(element, 'dragover') > 0
    ) {
      addSignal('dom-drop-listener', 0.95, 40, undefined, true);
    }
    if (
      typeof ownDataPropertyValue(element, 'onclick') === 'function' ||
      element.hasAttribute('onclick')
    ) {
      addSignal('inline-click-handler', 0.95, 10, 'click');
    }
    if (
      typeof ownDataPropertyValue(element, 'ondblclick') === 'function' ||
      element.hasAttribute('ondblclick')
    ) {
      addSignal('inline-double-click-handler', 0.95, 50, 'doubleClick');
    }
    if (
      typeof ownDataPropertyValue(element, 'ondragstart') === 'function' ||
      element.hasAttribute('ondragstart')
    ) {
      addSignal('inline-drag-start-handler', 0.95, 45, 'drag');
    }
    if (
      typeof ownDataPropertyValue(element, 'ondrop') === 'function' ||
      typeof ownDataPropertyValue(element, 'ondragover') === 'function' ||
      element.hasAttribute('ondrop') ||
      element.hasAttribute('ondragover')
    ) {
      addSignal('inline-drop-handler', 0.95, 40, undefined, true);
    }

    if (
      element.tabIndex >= 0 &&
      element.matches(
        'td,th,[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]',
      ) &&
      !signals.some((signal) => signal.capability === 'doubleClick')
    ) {
      for (
        let ancestor = composedParent(element);
        ancestor !== null;
        ancestor = composedParent(ancestor)
      ) {
        if (trackedListenerCount(ancestor, 'dblclick') > 0) {
          addSignal(
            'delegated-dom-double-click-listener',
            0.8,
            49,
            'doubleClick',
          );
          break;
        }
      }
    }

    if (signals.length === 0) {
      const view = element.ownerDocument.defaultView;
      const cursor = view?.getComputedStyle(element).cursor;
      const parent = composedParent(element);
      const parentCursor =
        parent === null ? undefined : view?.getComputedStyle(parent).cursor;
      let delegatedClickAncestor = false;
      for (
        let ancestor = composedParent(element);
        ancestor !== null;
        ancestor = composedParent(ancestor)
      ) {
        if (trackedListenerCount(ancestor, 'click') > 0) {
          delegatedClickAncestor = true;
          break;
        }
      }
      if (
        cursor === 'pointer' &&
        parentCursor !== 'pointer' &&
        delegatedClickAncestor
      ) {
        addSignal('pointer-cue', 0.65, 1, 'click');
      }
    }
    const primary = [...signals].sort(
      (left, right) =>
        right.priority - left.priority ||
        right.confidence - left.confidence ||
        left.detail.localeCompare(right.detail),
    )[0];
    const evidence: InteractionEvidence | undefined =
      primary === undefined
        ? undefined
        : {
            detail: primary.detail,
            confidence: Math.min(...signals.map((signal) => signal.confidence)),
            capabilities: (['click', 'doubleClick', 'drag'] as const).filter(
              (capability) =>
                signals.some((signal) => signal.capability === capability),
            ),
            ...(signals.some((signal) => signal.acceptsDrop === true)
              ? { acceptsDrop: true }
              : {}),
          };
    if (
      evidence !== undefined &&
      !(
        standardAncestors.has(element) &&
        evidence.detail === 'pointer-cue'
      )
    ) {
      evidenceByElement.set(element, { element, index, ...evidence });
    }
  }

  const candidateElements = new Set(evidenceByElement.keys());
  const candidateAncestors = new Set<HTMLElement>();
  for (const element of candidateElements) {
    for (
      let ancestor = composedParent(element);
      ancestor !== null;
      ancestor = composedParent(ancestor)
    ) {
      if (candidateElements.has(ancestor)) candidateAncestors.add(ancestor);
    }
  }

  const candidates: InteractionCandidate[] = [];
  for (const [element, candidate] of evidenceByElement) {
    if (
      (candidate.detail === 'dom-click-listener' ||
        candidate.detail === 'pointer-cue') &&
      candidateAncestors.has(element)
    ) {
      continue;
    }
    candidates.push(candidate);
  }
  const retained = candidates
    .sort(
      (left, right) =>
        right.confidence - left.confidence || left.index - right.index,
    )
    .slice(0, Math.max(0, Math.floor(options.retainLimit)))
    .sort((left, right) => left.index - right.index);
  return {
    elements: retained.map((candidate) => candidate.element),
    evidence: retained.map(
      ({ element: _element, index: _index, ...evidence }) => evidence,
    ),
    omittedCandidates: candidates.length - retained.length,
    scanTruncated,
  };
}

function discoverSemanticLabelRelationships(input: {
  targetRegistry: WeakMap<HTMLElement, string>;
  policy: SemanticRelationshipPolicy;
}): SemanticLabelSnapshot {
  type Rect = {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  };
  type ControlCandidate = {
    element: HTMLElement;
    sourceId: string;
    order: number;
    rect: Rect;
    scopeName: string | undefined;
    type: string;
  };
  type LabelCandidate = {
    element: HTMLElement;
    order: number;
    text: string;
    rect: Rect;
    scopeName: string | undefined;
  };
  type RelationshipDraft = {
    label: HTMLElement;
    controlSourceId: string;
    name: string;
    scopeName: string | undefined;
    inferred: boolean;
    confidence: number;
    evidence: Evidence[];
  };
  type ScoredPair = {
    label: LabelCandidate;
    control: ControlCandidate;
    score: number;
    evidenceDetails: string[];
  };

  const normalize = (value: string | null | undefined): string | undefined => {
    const text = value?.normalize('NFKC').replace(/\s+/g, ' ').trim();
    return text ? text : undefined;
  };
  const composedParent = (element: Element): HTMLElement | null => {
    if (element.parentElement !== null) return element.parentElement;
    const root = element.getRootNode();
    return root instanceof ShadowRoot && root.host instanceof HTMLElement
      ? root.host
      : null;
  };
  const rootLocalElement = (owner: Element, id: string): HTMLElement | null => {
    const root = owner.getRootNode();
    const local = (
      root as Node & {
        getElementById?: (candidateId: string) => Element | null;
      }
    ).getElementById?.(id);
    return local instanceof HTMLElement
      ? local
      : owner.ownerDocument.getElementById(id);
  };
  const referencedElements = (owner: Element, attribute: string): HTMLElement[] =>
    (owner.getAttribute(attribute)?.split(/\s+/).filter(Boolean) ?? [])
      .map((id) => rootLocalElement(owner, id))
      .filter((element): element is HTMLElement => element !== null);
  const referencedText = (owner: Element, attribute: string): string | undefined =>
    normalize(
      referencedElements(owner, attribute)
        .map((element) => element.textContent ?? '')
        .join(' '),
    );
  const isRendered = (element: HTMLElement): boolean => {
    const view = element.ownerDocument.defaultView;
    if (view === null) return false;
    for (
      let current: HTMLElement | null = element;
      current !== null;
      current = composedParent(current)
    ) {
      const style = view.getComputedStyle(current);
      if (
        current.hidden ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const isDecorative = (element: HTMLElement): boolean => {
    for (
      let current: HTMLElement | null = element;
      current !== null;
      current = composedParent(current)
    ) {
      const role = current.getAttribute('role');
      if (
        current.getAttribute('aria-hidden') === 'true' ||
        current.inert ||
        role === 'none' ||
        role === 'presentation'
      ) {
        return true;
      }
    }
    return false;
  };
  const semanticScopeName = (element: HTMLElement): string | undefined => {
    for (
      let current: HTMLElement | null = element;
      current !== null;
      current = composedParent(current)
    ) {
      if (
        !current.matches(
          'fieldset,section,form,main,dialog,[role="group"],[role="region"],[role="dialog"]',
        )
      ) {
        continue;
      }
      const explicit =
        normalize(current.getAttribute('aria-label')) ??
        referencedText(current, 'aria-labelledby');
      if (explicit !== undefined) return explicit;
      const directLabel = current.querySelector<HTMLElement>(
        ':scope > legend,:scope > h1,:scope > h2,:scope > h3',
      );
      const text = normalize(directLabel?.textContent);
      if (text !== undefined) return text;
    }
    return undefined;
  };
  const directText = (element: HTMLElement): string | undefined => {
    const text = normalize(
      Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join(' '),
    );
    if (text !== undefined) return text;
    return element.childElementCount === 0
      ? normalize(element.textContent)
      : undefined;
  };
  const rectOf = (element: HTMLElement): Rect => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  };
  const controlType = (element: HTMLElement): string => {
    if (element instanceof HTMLInputElement) return element.type.toLowerCase();
    if (element instanceof HTMLTextAreaElement) return 'textarea';
    if (element instanceof HTMLSelectElement) return 'select';
    if (element.isContentEditable) return 'contenteditable';
    return element.getAttribute('role')?.toLowerCase() ?? '';
  };
  const hasExistingName = (element: HTMLElement): boolean => {
    const nativeControl =
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
        ? element
        : undefined;
    return Boolean(
      normalize(element.getAttribute('aria-label')) ??
        referencedText(element, 'aria-labelledby') ??
        normalize(
          Array.from(nativeControl?.labels ?? [])
            .map((label) => label.textContent ?? '')
            .join(' '),
        ) ??
        normalize(element.getAttribute('placeholder')) ??
        normalize(element.getAttribute('title')),
    );
  };
  const typeCompatible = (label: string, type: string): boolean => {
    const normalizedLabel = label.toLocaleLowerCase();
    const groups: Array<{ types: string[]; pattern: RegExp }> = [
      { types: ['email'], pattern: /\be-?mail\b/i },
      { types: ['tel'], pattern: /\b(?:phone|mobile|telephone|tel)\b/i },
      { types: ['date', 'datetime-local'], pattern: /\b(?:date|birth|dob)\b/i },
      { types: ['password'], pattern: /\b(?:password|passcode|pin)\b/i },
      { types: ['url'], pattern: /\b(?:url|website|site)\b/i },
      { types: ['number', 'range'], pattern: /\b(?:amount|number|price|limit|quantity|total)\b/i },
      { types: ['search'], pattern: /\bsearch\b/i },
    ];
    return groups.some(
      (group) => group.types.includes(type) && group.pattern.test(normalizedLabel),
    );
  };

  const scanned: HTMLElement[] = [];
  const roots: Array<Document | ShadowRoot> = [document];
  let scanTruncated = false;
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const root = roots[rootIndex]!;
    for (const candidate of Array.from(root.querySelectorAll('*'))) {
      if (scanned.length >= input.policy.maxScannedElements) {
        scanTruncated = true;
        break;
      }
      if (!(candidate instanceof HTMLElement)) continue;
      scanned.push(candidate);
      if (candidate.shadowRoot !== null) roots.push(candidate.shadowRoot);
    }
    if (scanTruncated) break;
  }

  const controlSelector = [
    'input:not([type="hidden"])',
    'select',
    'textarea',
    '[contenteditable="true"]',
    '[role="textbox"]',
    '[role="combobox"]',
    '[role="spinbutton"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
  ].join(',');
  const controlCandidates = scanned.flatMap(
    (element, order): ControlCandidate[] => {
      const sourceId = input.targetRegistry.get(element);
      if (
        sourceId === undefined ||
        !element.matches(controlSelector) ||
        !isRendered(element)
      ) {
        return [];
      }
      return [
        {
          element,
          sourceId,
          order,
          rect: rectOf(element),
          scopeName: semanticScopeName(element),
          type: controlType(element),
        },
      ];
    },
  );
  const controls = controlCandidates.slice(0, input.policy.maxControls);
  let omittedAnalysis = controlCandidates.length - controls.length;
  let analysisCountExact = true;
  if (scanTruncated) {
    omittedAnalysis += 1;
    analysisCountExact = false;
  }
  const controlByElement = new Map(
    controls.map((control) => [control.element, control]),
  );

  const drafts: RelationshipDraft[] = [];
  const exactControls = new Set<string>();
  const exactLabels = new Set<HTMLElement>();
  const exactDraftByLabel = new Map<HTMLElement, Map<string, RelationshipDraft>>();
  const addExact = (
    label: HTMLElement,
    control: ControlCandidate,
    detail: 'native-label' | 'aria-labelledby',
  ): void => {
    const name = normalize(label.textContent);
    if (name === undefined) return;
    let byControl = exactDraftByLabel.get(label);
    if (byControl === undefined) {
      byControl = new Map();
      exactDraftByLabel.set(label, byControl);
    }
    const evidence: Evidence = {
      sensor: 'playwright-dom-relationship',
      detail,
      confidence: 1,
    };
    const existing = byControl.get(control.sourceId);
    if (existing !== undefined) {
      if (!existing.evidence.some((item) => item.detail === detail)) {
        existing.evidence.push(evidence);
      }
      return;
    }
    const draft: RelationshipDraft = {
      label,
      controlSourceId: control.sourceId,
      name,
      scopeName: control.scopeName,
      inferred: false,
      confidence: 1,
      evidence: [evidence],
    };
    byControl.set(control.sourceId, draft);
    drafts.push(draft);
    exactControls.add(control.sourceId);
    exactLabels.add(label);
  };

  for (const element of scanned) {
    if (!(element instanceof HTMLLabelElement)) continue;
    const controlled = element.control;
    if (!(controlled instanceof HTMLElement)) continue;
    const control = controlByElement.get(controlled);
    if (control !== undefined) addExact(element, control, 'native-label');
  }
  for (const control of controls) {
    for (const label of referencedElements(control.element, 'aria-labelledby')) {
      addExact(label, control, 'aria-labelledby');
    }
  }

  const labelSelector = 'label,span,p,div,dt,th,td,legend';
  const allLabelCandidates = scanned.flatMap(
    (element, order): LabelCandidate[] => {
      if (
        exactLabels.has(element) ||
        !element.matches(labelSelector) ||
        isDecorative(element) ||
        !isRendered(element) ||
        element.matches(controlSelector) ||
        element.querySelector(controlSelector) !== null
      ) {
        return [];
      }
      const text = directText(element);
      if (text === undefined || text.length > 120) return [];
      return [
        {
          element,
          order,
          text,
          rect: rectOf(element),
          scopeName: semanticScopeName(element),
        },
      ];
    },
  );
  const labelCandidates = allLabelCandidates.slice(
    0,
    input.policy.maxLabelCandidates,
  );
  omittedAnalysis += allLabelCandidates.length - labelCandidates.length;
  const unresolvedControls = controls.filter(
    (control) =>
      !exactControls.has(control.sourceId) && !hasExistingName(control.element),
  );
  const scored: ScoredPair[] = [];
  for (const control of unresolvedControls) {
    for (const label of labelCandidates) {
      if (
        control.scopeName !== undefined &&
        label.scopeName !== undefined &&
        control.scopeName !== label.scopeName
      ) {
        continue;
      }
      const verticalCenterDistance = Math.abs(
        (label.rect.top + label.rect.bottom) / 2 -
          (control.rect.top + control.rect.bottom) / 2,
      );
      const rowTolerance = Math.max(
        8,
        Math.min(24, (label.rect.height + control.rect.height) * 0.45),
      );
      const horizontalGap = control.rect.left - label.rect.right;
      const sameRow = verticalCenterDistance <= rowTolerance;
      const labelToLeft = horizontalGap >= -8 && horizontalGap <= 480;
      const verticalGap = control.rect.top - label.rect.bottom;
      const alignedAbove =
        verticalGap >= -2 &&
        verticalGap <= 80 &&
        Math.abs(control.rect.left - label.rect.left) <=
          Math.max(48, control.rect.width * 0.4);
      if (!(sameRow && labelToLeft) && !alignedAbove) continue;

      let score = 0;
      const evidenceDetails: string[] = [];
      if (sameRow && labelToLeft) {
        score += 0.62;
        score += 0.14;
        score += Math.max(0, 1 - Math.max(0, horizontalGap) / 600) * 0.08;
        evidenceDetails.push('spatial-row-alignment');
      } else if (alignedAbove) {
        score += 0.56;
        score += 0.14;
        score += Math.max(0, 1 - Math.max(0, verticalGap) / 100) * 0.08;
        evidenceDetails.push('spatial-above-alignment');
      }
      if (
        control.scopeName !== undefined &&
        label.scopeName === control.scopeName
      ) {
        score += 0.08;
        evidenceDetails.push('same-named-scope');
      }
      if (typeCompatible(label.text, control.type)) {
        score += 0.08;
        evidenceDetails.push('input-type-compatibility');
      }
      scored.push({
        label,
        control,
        score: Math.min(0.99, Math.round(score * 1_000) / 1_000),
        evidenceDetails,
      });
    }
  }

  const comparePairs = (left: ScoredPair, right: ScoredPair): number =>
    right.score - left.score ||
    left.control.order - right.control.order ||
    left.label.order - right.label.order;
  const byControl = new Map<string, ScoredPair[]>();
  const byLabel = new Map<HTMLElement, ScoredPair[]>();
  for (const pair of scored) {
    const controlPairs = byControl.get(pair.control.sourceId) ?? [];
    controlPairs.push(pair);
    byControl.set(pair.control.sourceId, controlPairs);
    const labelPairs = byLabel.get(pair.label.element) ?? [];
    labelPairs.push(pair);
    byLabel.set(pair.label.element, labelPairs);
  }
  for (const pairs of byControl.values()) pairs.sort(comparePairs);
  for (const pairs of byLabel.values()) pairs.sort(comparePairs);

  const globallyEligible = scored
    .filter((pair) => {
      const controlPairs = byControl.get(pair.control.sourceId)!;
      const labelPairs = byLabel.get(pair.label.element)!;
      const controlRunnerUp = controlPairs[1]?.score ?? 0;
      const labelRunnerUp = labelPairs[1]?.score ?? 0;
      return (
        controlPairs[0] === pair &&
        labelPairs[0] === pair &&
        pair.score >= input.policy.acceptanceThreshold &&
        pair.score - controlRunnerUp >= input.policy.ambiguityMargin &&
        pair.score - labelRunnerUp >= input.policy.ambiguityMargin
      );
    })
    .sort(comparePairs);
  const assignedControls = new Set<string>();
  const assignedLabels = new Set<HTMLElement>();
  for (const pair of globallyEligible) {
    if (
      assignedControls.has(pair.control.sourceId) ||
      assignedLabels.has(pair.label.element)
    ) {
      continue;
    }
    assignedControls.add(pair.control.sourceId);
    assignedLabels.add(pair.label.element);
    drafts.push({
      label: pair.label.element,
      controlSourceId: pair.control.sourceId,
      name: pair.label.text,
      scopeName: pair.control.scopeName,
      inferred: true,
      confidence: pair.score,
      evidence: [
        ...pair.evidenceDetails.map((detail): Evidence => ({
          sensor: 'playwright-dom-relationship',
          detail,
          confidence: pair.score,
        })),
        {
          sensor: 'playwright-dom-relationship',
          detail: 'global-one-to-one-margin',
          confidence: pair.score,
        },
      ],
    });
  }

  const elements: HTMLElement[] = [];
  const labels: SemanticLabelFacts[] = [];
  const indexByElement = new Map<HTMLElement, number>();
  const relationships: SemanticLabelRelationshipFacts[] = [];
  for (const draft of drafts) {
    let labelIndex = indexByElement.get(draft.label);
    if (labelIndex === undefined) {
      labelIndex = elements.length;
      indexByElement.set(draft.label, labelIndex);
      elements.push(draft.label);
      labels.push({
        text: draft.name,
        visible: isRendered(draft.label),
        semanticKey:
          normalize(draft.label.id) ??
          normalize(draft.label.getAttribute('name')),
        scopeName: draft.scopeName,
        confidence: draft.confidence,
        evidence: draft.evidence.map((evidence) => ({ ...evidence })),
      });
    }
    relationships.push({
      labelIndex,
      controlSourceId: draft.controlSourceId,
      name: draft.name,
      scopeName: draft.scopeName,
      inferred: draft.inferred,
      confidence: draft.confidence,
      evidence: draft.evidence.map((evidence) => ({ ...evidence })),
    });
  }

  return {
    elements,
    labels,
    relationships,
    omittedAnalysis,
    analysisCountExact,
  };
}

function readChoiceOptionFacts(
  element: HTMLElement,
  factsInput: Pick<ElementFactsInput, 'targetRegistry'>,
): ChoiceOptionFacts | undefined {
  const normalized = (value: string | null | undefined): string | undefined => {
    const text = value?.replace(/\s+/g, ' ').trim();
    return text ? text : undefined;
  };
  const rootLocalElement = (
    owner: HTMLElement,
    id: string,
  ): HTMLElement | null => {
    const root = owner.getRootNode();
    const local = (
      root as Node & {
        getElementById?: (candidateId: string) => Element | null;
      }
    ).getElementById?.(id);
    return local instanceof HTMLElement
      ? local
      : owner.ownerDocument.getElementById(id);
  };
  const referencedText = (
    owner: HTMLElement,
    attribute: string,
  ): string | undefined => {
    const ids =
      owner.getAttribute(attribute)?.split(/\s+/).filter(Boolean) ?? [];
    return normalized(
      ids
        .map((id) => rootLocalElement(owner, id)?.textContent ?? '')
        .join(' '),
    );
  };
  const collectComposedElements = (document: Document): HTMLElement[] => {
    const elements: HTMLElement[] = [];
    const roots: Array<Document | ShadowRoot> = [document];
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index]!;
      for (const candidate of Array.from(root.querySelectorAll('*'))) {
        if (candidate instanceof HTMLElement) elements.push(candidate);
        if (candidate.shadowRoot !== null) roots.push(candidate.shadowRoot);
      }
    }
    return elements;
  };
  const tokenAttributeContains = (
    candidate: HTMLElement,
    attribute: string,
    token: string,
  ): boolean =>
    (candidate.getAttribute(attribute)?.split(/\s+/).filter(Boolean) ?? [])
      .includes(token);

  let owner =
    element instanceof HTMLOptionElement
      ? element.closest<HTMLSelectElement>('select')
      : element.closest<HTMLElement>(
          'select,[role="combobox"],[aria-haspopup="listbox"]',
        );
  if (owner === null) {
    const controlledIds: string[] = [];
    for (
      let ancestor = element.parentElement;
      ancestor !== null;
      ancestor = ancestor.parentElement
    ) {
      if (ancestor.id) controlledIds.push(ancestor.id);
    }
    const composedElements = collectComposedElements(element.ownerDocument);
    const owners = composedElements.filter(
      (candidate) =>
        (candidate.getAttribute('role') === 'combobox' ||
          candidate.getAttribute('aria-haspopup') === 'listbox') &&
        controlledIds.some(
          (id) =>
            tokenAttributeContains(candidate, 'aria-controls', id) ||
            tokenAttributeContains(candidate, 'aria-owns', id),
        ),
    );
    if (owners.length > 1) return undefined;
    owner = owners[0] ?? element.closest<HTMLElement>('[role="listbox"]');
    if (owner === null) return undefined;
  }

  const ownerSourceId = factsInput.targetRegistry.get(owner);
  if (ownerSourceId === undefined) return undefined;

  const name =
    normalized(element.getAttribute('aria-label')) ??
    referencedText(element, 'aria-labelledby') ??
    normalized(element.textContent);
  if (name === undefined) return undefined;
  const value =
    (element instanceof HTMLOptionElement
      ? normalized(element.value)
      : undefined) ??
    normalized(element.getAttribute('value')) ??
    normalized(element.getAttribute('data-value')) ??
    name;

  const labelledControl =
    owner instanceof HTMLInputElement ||
    owner instanceof HTMLSelectElement ||
    owner instanceof HTMLTextAreaElement
      ? owner
      : undefined;
  const ownerName =
    normalized(owner.getAttribute('aria-label')) ??
    referencedText(owner, 'aria-labelledby') ??
    normalized(
      Array.from(labelledControl?.labels ?? [])
        .map((label) => label.textContent ?? '')
        .join(' '),
    );
  const semanticOwner = owner.closest<HTMLElement>(
    '[data-record-id],[data-row-id],[data-id],[data-key]',
  );
  const stableOwnerIdentifier =
    normalized(owner.getAttribute('name')) ??
    normalized(semanticOwner?.getAttribute('data-record-id')) ??
    normalized(semanticOwner?.getAttribute('data-row-id')) ??
    normalized(semanticOwner?.getAttribute('data-id')) ??
    normalized(semanticOwner?.getAttribute('data-key')) ??
    ownerName ??
    normalized(owner.id);
  const ownerSignature = [
    normalized(owner.getAttribute('role')) ??
      (owner instanceof HTMLSelectElement ? 'combobox' : undefined) ??
      (owner.getAttribute('aria-haspopup') === 'listbox'
        ? 'combobox'
        : undefined) ??
      '',
    ownerName ?? '',
    stableOwnerIdentifier ?? '',
  ].join('\u001e');

  const selected =
    element instanceof HTMLOptionElement
      ? element.selected
      : element.getAttribute('aria-selected') === 'true';
  const composedParent = (candidate: HTMLElement): HTMLElement | null => {
    if (candidate.parentElement !== null) return candidate.parentElement;
    const root = candidate.getRootNode();
    return root instanceof ShadowRoot && root.host instanceof HTMLElement
      ? root.host
      : null;
  };
  const ancestors: HTMLElement[] = [];
  for (
    let current: HTMLElement | null = element;
    current !== null;
    current = composedParent(current)
  ) {
    ancestors.push(current);
  }
  const disabled = ancestors.some(
    (candidate) =>
      candidate.matches(':disabled') ||
      candidate.getAttribute('aria-disabled') === 'true' ||
      candidate.inert ||
      candidate.hasAttribute('inert'),
  );
  const visible = (() => {
    const view = element.ownerDocument.defaultView;
    if (view === null) return false;
    for (const candidate of ancestors) {
      const style = view.getComputedStyle(candidate);
      if (
        candidate.hidden ||
        candidate.getAttribute('aria-hidden') === 'true' ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(view.innerWidth, rect.right);
    const bottom = Math.min(view.innerHeight, rect.bottom);
    if (right <= left || bottom <= top) {
      const position = view.getComputedStyle(element).position;
      return (
        position !== 'fixed' &&
        rect.right > 0 &&
        rect.left < view.innerWidth
      );
    }
    const x = left + (right - left) / 2;
    const y = top + (bottom - top) / 2;
    const root = element.getRootNode();
    const topElement =
      root instanceof ShadowRoot
        ? root.elementsFromPoint(x, y)[0]
        : element.ownerDocument.elementsFromPoint(x, y)[0];
    return (
      topElement !== undefined &&
      (topElement === element || element.contains(topElement))
    );
  })();
  return {
    ownerSourceId,
    ownerSignature,
    name,
    value,
    state: {
      selected,
      enabled: !disabled,
      visible,
    },
    nativeOption: element instanceof HTMLOptionElement,
  };
}

function readElementFacts(
  element: HTMLElement,
  factsInput: ElementFactsInput,
): ElementFacts {
  const directInteractionEvidence = (): InteractionEvidence | undefined => {
    const capabilities = new Set<Capability['kind']>();
    const signals: Array<{
      detail: InteractionEvidence['detail'];
      confidence: number;
      priority: number;
      acceptsDrop?: boolean;
    }> = [];
    const add = (
      detail: InteractionEvidence['detail'],
      confidence: number,
      priority: number,
      capability?: Capability['kind'],
      acceptsDrop = false,
    ): void => {
      if (capability !== undefined) capabilities.add(capability);
      signals.push({
        detail,
        confidence,
        priority,
        ...(acceptsDrop ? { acceptsDrop: true } : {}),
      });
    };
    if (element.hasAttribute('onclick')) {
      add('inline-click-handler', 0.95, 10, 'click');
    }
    if (element.hasAttribute('ondblclick')) {
      add('inline-double-click-handler', 0.95, 50, 'doubleClick');
    }
    if (element.hasAttribute('ondragstart')) {
      add('inline-drag-start-handler', 0.95, 45, 'drag');
    }
    if (
      element.hasAttribute('ondrop') ||
      element.hasAttribute('ondragover')
    ) {
      add('inline-drop-handler', 0.95, 40, undefined, true);
    }
    if (element.getAttribute('draggable')?.toLowerCase() === 'true') {
      add('native-draggable', 1, 46, 'drag');
    }
    const ariaGrabbed = element.getAttribute('aria-grabbed')?.toLowerCase();
    if (ariaGrabbed === 'true' || ariaGrabbed === 'false') {
      add('aria-grabbed', 0.9, 44, 'drag');
    }
    const ariaDropEffect = element.getAttribute('aria-dropeffect')?.toLowerCase();
    if (ariaDropEffect !== undefined && ariaDropEffect !== 'none') {
      add('aria-drop-target', 0.9, 39, undefined, true);
    }
    const primary = [...signals].sort(
      (left, right) =>
        right.priority - left.priority ||
        right.confidence - left.confidence ||
        left.detail.localeCompare(right.detail),
    )[0];
    return primary === undefined
      ? undefined
      : {
          detail: primary.detail,
          confidence: Math.min(...signals.map((signal) => signal.confidence)),
          capabilities: [...capabilities],
          ...(signals.some((signal) => signal.acceptsDrop === true)
            ? { acceptsDrop: true }
            : {}),
        };
  };
  const interactionEvidence =
    factsInput.interactionEvidence ?? directInteractionEvidence();
  const normalized = (value: string | null | undefined): string | undefined => {
    const text = value?.replace(/\s+/g, ' ').trim();
    return text ? text : undefined;
  };
  const referencedText = (attribute: string): string | undefined => {
    const ids = element.getAttribute(attribute)?.split(/\s+/).filter(Boolean) ?? [];
    const root = element.getRootNode();
    return normalized(
      ids
        .map((id) => {
          const local = (
            root as Node & {
              getElementById?: (candidateId: string) => Element | null;
            }
          ).getElementById?.(id);
          return (
            local?.textContent ??
            element.ownerDocument.getElementById(id)?.textContent ??
            ''
          );
        })
        .join(' '),
    );
  };
  const conciseLabelText = (label: HTMLLabelElement): string | undefined => {
    const textParts: string[] = [];
    const walker = label.ownerDocument.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current !== null) {
      const parent = current.parentElement;
      const excludedContainer = parent?.closest(
        'input,select,textarea,button,option,[role="option"],[role="listbox"],[role="menu"],[aria-hidden="true"]',
      );
      if (
        excludedContainer === null ||
        excludedContainer === undefined ||
        !label.contains(excludedContainer)
      ) {
        textParts.push(current.textContent ?? '');
      }
      current = walker.nextNode();
    }
    return normalized(textParts.join(' '));
  };

  const tag = element.tagName.toLowerCase();
  const input = element instanceof HTMLInputElement ? element : undefined;
  const select = element instanceof HTMLSelectElement ? element : undefined;
  const textarea = element instanceof HTMLTextAreaElement ? element : undefined;
  const explicitRole = normalized(element.getAttribute('role'));
  const implicitRole =
    tag === 'a'
      ? 'link'
      : tag === 'button'
        ? 'button'
        : tag === 'select'
          ? 'combobox'
          : tag === 'textarea'
            ? 'textbox'
            : input?.type === 'checkbox'
              ? 'checkbox'
              : input?.type === 'radio'
                ? 'radio'
                : input?.type === 'button' || input?.type === 'submit' || input?.type === 'reset'
                  ? 'button'
                  : input
                    ? 'textbox'
                    : element.isContentEditable
                      ? 'textbox'
                      : undefined;
  const inferredChoiceRole =
    element.getAttribute('aria-haspopup') === 'listbox' &&
    (element.hasAttribute('aria-controls') || element.hasAttribute('aria-owns'))
      ? 'combobox'
      : undefined;
  const role = explicitRole ?? implicitRole ?? inferredChoiceRole;
  const labelledControl = input ?? select ?? textarea;
  const nativeLabels = Array.from(labelledControl?.labels ?? []);
  const labels = labelledControl
    ? normalized(nativeLabels.map((label) => label.textContent ?? '').join(' '))
    : undefined;
  const sensitiveAutocomplete = new Set([
    'current-password',
    'new-password',
    'one-time-code',
    'cc-number',
    'cc-csc',
  ]);
  const fieldLike =
    input !== undefined ||
    textarea !== undefined ||
    element.isContentEditable ||
    ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(
      explicitRole ?? '',
    );
  const sensitiveHints = [
    element.getAttribute('aria-label'),
    referencedText('aria-labelledby'),
    labels,
    element.getAttribute('placeholder'),
    element.getAttribute('title'),
    element.getAttribute('name'),
    element.id,
    element.getAttribute('data-testid'),
    element.getAttribute('data-field'),
  ]
    .filter((hint): hint is string => Boolean(hint))
    .join(' ');
  const sensitiveHintPattern =
    /\b(?:password|passcode|passphrase|pin|one[- ]?time(?: code)?|otp|verification code|recovery code|api[- ]?key|access[- ]?token|refresh[- ]?token|private[- ]?key|client[- ]?secret|security code|card number|credit card|cvv|cvc)\b/i;
  const isSensitiveField =
    fieldLike &&
    (input?.type === 'password' ||
      sensitiveAutocomplete.has(input?.autocomplete.toLowerCase() ?? '') ||
      element.getAttribute('data-sensitive') === 'true' ||
      sensitiveHintPattern.test(sensitiveHints));
  const compositeFieldName = (() => {
    if (
      input === undefined ||
      !['text', 'search', 'tel'].includes(input.type)
    ) {
      return undefined;
    }

    let container = element.parentElement;
    for (let depth = 0; container !== null && depth < 5; depth += 1) {
      if (container.tagName === 'FORM' || container.tagName === 'MAIN') break;
      const controls = Array.from(
        container.querySelectorAll<HTMLInputElement>(
          'input:not([type="hidden"])',
        ),
      );
      if (
        controls.length >= 2 &&
        controls.length <= 4 &&
        controls.includes(input)
      ) {
        const candidateLabels =
          container instanceof HTMLLabelElement
            ? [container]
            : Array.from(container.querySelectorAll<HTMLLabelElement>('label'));
        const controllingLabels = candidateLabels.filter(
          (label) =>
            label.control instanceof HTMLInputElement &&
            controls.includes(label.control),
        );
        const requiredControls = controls.filter(
          (control) => control.required || control.getAttribute('aria-required') === 'true',
        );
        const controllingLabel = controllingLabels[0];
        if (
          controllingLabels.length === 1 &&
          controllingLabel !== undefined &&
          requiredControls.length === 1 &&
          controllingLabel.control !== requiredControls[0]
        ) {
          const fieldLabel = conciseLabelText(controllingLabel);
          const phoneEvidence =
            input.type === 'tel' ||
            requiredControls[0]?.type === 'tel' ||
            controls.some((control) =>
              /\btel(?:-national|-country-code)?\b/i.test(
                control.autocomplete,
              ),
            ) ||
            /\b(?:phone|mobile|telephone)\b/i.test(fieldLabel ?? '');
          if (fieldLabel === undefined || !phoneEvidence) {
            container = container.parentElement;
            continue;
          }
          if (requiredControls[0] === labelledControl) return fieldLabel;
          if (controllingLabel.control === labelledControl) {
            return `${fieldLabel} country code`;
          }
        }
      }
      container = container.parentElement;
    }
    return undefined;
  })();
  const ownText = isSensitiveField
    ? undefined
    : normalized(element.innerText || element.textContent);
  const inputUsesValueAsName =
    input !== undefined && ['button', 'submit', 'reset', 'image'].includes(input.type);
  const name =
    normalized(element.getAttribute('aria-label')) ??
    referencedText('aria-labelledby') ??
    compositeFieldName ??
    labels ??
    (element instanceof HTMLImageElement ? normalized(element.alt) : undefined) ??
    ((role === 'button' ||
    role === 'link' ||
    role === 'alert' ||
    role === 'status' ||
    interactionEvidence !== undefined)
      ? ownText
      : undefined) ??
    normalized(element.getAttribute('placeholder')) ??
    normalized(element.getAttribute('title')) ??
    (inputUsesValueAsName ? normalized(input.value) : undefined);
  const nativeInvalid = labelledControl?.matches(':invalid') ?? false;
  const nativeValidationMessage =
    nativeInvalid && element.ownerDocument.activeElement === element
      ? normalized(labelledControl?.validationMessage)
      : undefined;
  const description = isSensitiveField
    ? undefined
    : normalized(element.getAttribute('aria-description')) ??
      referencedText('aria-describedby') ??
      nativeValidationMessage ??
      normalized(element.getAttribute('title'));
  const value =
    select
      ? select.value
      : input
        ? isSensitiveField
          ? undefined
          : input.value
        : textarea
          ? textarea.value
          : element.isContentEditable
            ? isSensitiveField
              ? undefined
              : normalized(element.textContent)
            : normalized(
                isSensitiveField
                  ? undefined
                  : element.getAttribute('value') ??
                      element.getAttribute('aria-valuetext') ??
                      element.getAttribute('aria-valuenow'),
              );

  const perceptible = (() => {
    const view = element.ownerDocument.defaultView;
    if (view === null) return false;
    for (
      let current: HTMLElement | null = element;
      current !== null;
      current =
        current.parentElement ??
        (current.getRootNode() instanceof ShadowRoot
          ? (current.getRootNode() as ShadowRoot).host as HTMLElement
          : null)
    ) {
      const style = view.getComputedStyle(current);
      if (
        current.hidden ||
        current.getAttribute('aria-hidden') === 'true' ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
    }

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(view.innerWidth, rect.right);
    const bottom = Math.min(view.innerHeight, rect.bottom);
    if (right <= left || bottom <= top) {
      const position = view.getComputedStyle(element).position;
      return position !== 'fixed' && rect.right > 0 && rect.left < view.innerWidth;
    }

    const x = left + (right - left) / 2;
    const y = top + (bottom - top) / 2;
    const root = element.getRootNode();
    const topElement =
      root instanceof ShadowRoot
        ? root.elementsFromPoint(x, y)[0]
        : element.ownerDocument.elementsFromPoint(x, y)[0];
    return (
      topElement !== undefined &&
      (topElement === element || element.contains(topElement))
    );
  })();

  const disabled = (() => {
    for (
      let current: HTMLElement | null = element;
      current !== null;
      current =
        current.parentElement ??
        (current.getRootNode() instanceof ShadowRoot
          ? ((current.getRootNode() as ShadowRoot).host as HTMLElement)
          : null)
    ) {
      if (
        current.matches(':disabled') ||
        current.getAttribute('aria-disabled') === 'true' ||
        current.inert ||
        current.hasAttribute('inert')
      ) {
        return true;
      }
    }
    return false;
  })();
  const isStatusRole = role === 'alert' || role === 'status';
  const state: EntityState = isStatusRole
    ? { visible: perceptible }
    : {
        visible: perceptible,
        enabled: !disabled,
        focused: element.matches(':focus'),
      };
  if (isSensitiveField) {
    state.hasValue = Boolean(
      input?.value ||
        textarea?.value ||
        element.textContent?.trim() ||
        element.getAttribute('value') ||
        element.getAttribute('aria-valuetext') ||
        element.getAttribute('aria-valuenow'),
    );
  }
  if (input?.type === 'checkbox' || input?.type === 'radio') {
    state.checked = input.indeterminate ? 'mixed' : input.checked;
  } else {
    const ariaChecked = element.getAttribute('aria-checked');
    if (ariaChecked !== null) {
      state.checked = ariaChecked === 'mixed' ? 'mixed' : ariaChecked === 'true';
    }
  }
  const expanded = element.getAttribute('aria-expanded');
  if (expanded !== null || role === 'combobox') {
    state.expanded = expanded === 'true';
  }
  const selected = element.getAttribute('aria-selected');
  if (selected !== null) state.selected = selected === 'true';
  const busy = element.getAttribute('aria-busy');
  if (busy !== null) state.busy = busy === 'true';
  const invalid = element.getAttribute('aria-invalid');
  if (invalid !== null || nativeInvalid) {
    state.invalid = (invalid !== null && invalid !== 'false') || nativeInvalid;
  }
  if (role === 'alert') state.transient = true;

  const semanticOwner = element.closest<HTMLElement>(
    '[data-record-id],[data-row-id],[data-id],[data-key]',
  );
  const semanticKey = normalized(
    [
      element.getAttribute('name') ?? element.id,
      element.getAttribute('href'),
      input?.type,
      semanticOwner?.getAttribute('data-record-id'),
      semanticOwner?.getAttribute('data-row-id'),
      semanticOwner?.getAttribute('data-id'),
      semanticOwner?.getAttribute('data-key'),
    ]
      .filter((part): part is string => Boolean(part))
      .join('\u001e'),
  );
  const structuralSelector =
    'table,[role="table"],[role="grid"],[role="treegrid"],tr,[role="row"],th,td,[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]';
  const parentAcrossRoots = (candidate: HTMLElement): HTMLElement | null => {
    if (candidate.parentElement !== null) return candidate.parentElement;
    const root = candidate.getRootNode();
    return root instanceof ShadowRoot ? (root.host as HTMLElement) : null;
  };
  let structuralContainerElement: HTMLElement | null = parentAcrossRoots(element);
  while (
    structuralContainerElement !== null &&
    !structuralContainerElement.matches(structuralSelector)
  ) {
    structuralContainerElement = parentAcrossRoots(structuralContainerElement);
  }
  let container: ElementFacts['container'];
  if (structuralContainerElement !== null) {
    const sourceId = factsInput.targetRegistry.get(structuralContainerElement);
    if (sourceId !== undefined) {
      const closestAcrossRoots = (
        start: HTMLElement,
        selector: string,
      ): HTMLElement | undefined => {
        for (
          let current: HTMLElement | null = start;
          current !== null;
          current = parentAcrossRoots(current)
        ) {
          if (current.matches(selector)) return current;
        }
        return undefined;
      };
      const table = closestAcrossRoots(
        structuralContainerElement,
        'table,[role="table"],[role="grid"],[role="treegrid"]',
      );
      const row = closestAcrossRoots(
        structuralContainerElement,
        'tr,[role="row"]',
      );
      const attributeKey = (
        candidate: HTMLElement | undefined,
        attributes: readonly string[],
      ): string => {
        if (candidate === undefined) return '';
        for (const attribute of attributes) {
          const candidateValue = normalized(
            attribute === 'id'
              ? candidate.id
              : candidate.getAttribute(attribute),
          );
          if (candidateValue !== undefined) {
            return `${attribute}:${candidateValue}`;
          }
        }
        return '';
      };
      container = {
        sourceId,
        signature: [
          structuralContainerElement.getAttribute('role') ??
            structuralContainerElement.tagName.toLowerCase(),
          attributeKey(table, [
            'data-record-id',
            'data-row-id',
            'data-key',
            'data-id',
            'id',
            'aria-label',
          ]),
          attributeKey(row, [
            'data-record-id',
            'data-row-id',
            'data-key',
            'data-id',
            'id',
            'aria-rowindex',
          ]),
          attributeKey(structuralContainerElement, [
            'data-column-key',
            'data-col-key',
            'headers',
            'id',
            'aria-colindex',
          ]),
        ].join('\u001e'),
      };
    }
  }
  const scopeElement = element.closest<HTMLElement>(
    'nav,main,[role="navigation"],[role="main"],[role="toolbar"]',
  );
  let scope: ElementFacts['scope'];
  if (scopeElement !== null) {
    const explicitScopeRole = normalized(scopeElement.getAttribute('role'));
    const scopeRole =
      explicitScopeRole === 'navigation' ||
      explicitScopeRole === 'main' ||
      explicitScopeRole === 'toolbar'
        ? explicitScopeRole
        : scopeElement.tagName.toLowerCase() === 'nav'
          ? 'navigation'
          : 'main';
    const scopeIds =
      scopeElement.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean) ?? [];
    const semanticScopeName =
      normalized(scopeElement.getAttribute('aria-label')) ??
      normalized(
        scopeIds
          .map((id) => scopeElement.ownerDocument.getElementById(id)?.textContent ?? '')
          .join(' '),
      );
    const scopeName =
      semanticScopeName ??
      (scopeRole === 'main'
        ? normalized(scopeElement.ownerDocument.title) ?? 'Main content'
        : scopeRole === 'navigation'
          ? 'Navigation'
          : 'Toolbar');
    const sourceId = factsInput.targetRegistry.get(scopeElement);
    if (sourceId !== undefined) {
      scope = {
        sourceId,
        signature: [scopeRole, semanticScopeName ?? ''].join('\u001e'),
      };
    }
  }

  const kind: EntityKind =
    isStatusRole
      ? 'status'
      : input ||
          select ||
          textarea ||
          element.isContentEditable ||
          role === 'combobox' ||
          role === 'textbox' ||
          role === 'spinbutton'
        ? 'input'
        : 'control';
  const initialCapabilities: Capability['kind'][] =
    kind === 'status'
      ? []
      : interactionEvidence === undefined || element.tabIndex >= 0
        ? ['hover', 'focus', 'contextClick']
        : ['hover', 'contextClick'];
  const capabilities = new Set<Capability['kind']>(initialCapabilities);
  if (interactionEvidence?.capabilities.includes('click') === true) {
    capabilities.add('click');
  }
  if (
    role === 'button' ||
    role === 'link' ||
    role === 'tab' ||
    interactionEvidence?.capabilities.includes('doubleClick') === true
  ) {
    capabilities.add('doubleClick');
  }
  if (interactionEvidence?.capabilities.includes('drag') === true) {
    capabilities.add('drag');
  }
  const editableCombobox =
    role === 'combobox' &&
    (input !== undefined ||
      textarea !== undefined ||
      element.isContentEditable);
  if (
    role === 'textbox' ||
    role === 'spinbutton' ||
    editableCombobox
  ) {
    capabilities.add('fill');
    capabilities.add('type');
    capabilities.add('press');
  }
  if (role === 'combobox') capabilities.add('select');
  if (role === 'checkbox' || role === 'radio' || role === 'switch') capabilities.add('check');
  if (input?.type === 'file') capabilities.add('upload');

  return {
    kind,
    ...(role === undefined ? {} : { role }),
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(ownText === undefined || ownText === name || role === 'combobox'
      ? {}
      : { text: ownText }),
    ...(value === undefined ? {} : { value }),
    ...(semanticKey === undefined ? {} : { semanticKey }),
    state,
    capabilities: [...capabilities].map((capabilityKind) => {
      const evidenceBacked =
        interactionEvidence?.capabilities.includes(capabilityKind) === true;
      const confidence = evidenceBacked
        ? interactionEvidence.confidence
        : undefined;
      return {
        kind: capabilityKind,
        enabled: !disabled,
        ...(evidenceBacked && interactionEvidence !== undefined
          ? { reason: interactionEvidence.detail }
          : {}),
        ...(confidence === undefined ? {} : { confidence }),
      };
    }),
    ...(container === undefined ? {} : { container }),
    ...(scope === undefined ? {} : { scope }),
    ...(interactionEvidence === undefined ? {} : { interactionEvidence }),
  };
}
