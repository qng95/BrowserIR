export type BrowserId = string;
export type PageId = string;
export type EntityId = string;
export type Revision = number;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface Viewport {
  width: number;
  height: number;
}

export interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportX?: number;
  viewportY?: number;
  inViewport?: boolean;
  occluded?: boolean;
}

export type EntityKind =
  | 'document'
  | 'region'
  | 'control'
  | 'input'
  | 'option'
  | 'menu'
  | 'dialog'
  | 'form'
  | 'table'
  | 'row'
  | 'cell'
  | 'text'
  | 'image'
  | 'status'
  | 'unknown';

export type CapabilityKind =
  | 'click'
  | 'contextClick'
  | 'doubleClick'
  | 'fill'
  | 'type'
  | 'select'
  | 'check'
  | 'hover'
  | 'press'
  | 'scroll'
  | 'drag'
  | 'upload'
  | 'focus';

export interface Capability {
  kind: CapabilityKind;
  enabled?: boolean;
  reason?: string;
  confidence?: number;
}

export interface EntityState {
  visible?: boolean;
  enabled?: boolean;
  /** Whether a sensitive input is populated, without exposing its value. */
  hasValue?: boolean;
  selected?: boolean;
  expanded?: boolean;
  busy?: boolean;
  invalid?: boolean;
  transient?: boolean;
  focused?: boolean;
  checked?: boolean | 'mixed';
}

export interface Evidence {
  sensor: string;
  detail?: string;
  confidence?: number;
}

export type RelationKind =
  | 'contains'
  | 'labels'
  | 'controls'
  | 'owns'
  | 'popup-for'
  | 'row-of'
  | 'cell-of'
  | 'option-of'
  | 'embeds-document'
  | 'pagination-for'
  | 'describes';

export interface Relation {
  from: EntityId;
  to: EntityId;
  kind: RelationKind;
  confidence?: number;
  evidence?: Evidence[];
}

/**
 * Browser-independent canonical entity. Driver source identifiers and targets
 * are intentionally absent from this type.
 */
export interface Entity {
  id: EntityId;
  pageId: PageId;
  kind: EntityKind;
  role?: string;
  name?: string;
  description?: string;
  text?: string;
  value?: JsonValue;
  state: EntityState;
  geometry?: Geometry;
  capabilities: Capability[];
  evidence: Evidence[];
  confidence: number;
}

export interface EntityRef {
  browserId: BrowserId;
  pageId: PageId;
  entityId: EntityId;
  revision: Revision;
}

export interface BrowserCreateOptions {
  viewport?: Viewport;
  deviceScaleFactor?: number;
  locale?: string;
  timezoneId?: string;
  colorScheme?: 'light' | 'dark' | 'no-preference';
  reducedMotion?: 'reduce' | 'no-preference';
  headless?: boolean;
}

export interface BrowserSessionInfo {
  browserId: BrowserId;
  initialPageId: PageId;
  revision: Revision;
}

/**
 * Opaque, session-local handle understood only by the driver that issued it.
 * It is never included in a canonical graph or compiled model view.
 */
export interface DriverTarget {
  opaqueId: string;
}

export interface DriverObservedEntity {
  sourceId: string;
  identityKey: string;
  target: DriverTarget;
  kind: EntityKind;
  role?: string;
  name?: string;
  description?: string;
  text?: string;
  value?: JsonValue;
  state?: EntityState;
  geometry?: Geometry;
  capabilities?: Capability[];
  evidence?: Evidence[];
  confidence?: number;
}

export interface DriverObservedRelation {
  fromSourceId: string;
  toSourceId: string;
  kind: RelationKind;
  confidence?: number;
  evidence?: Evidence[];
}

export interface DriverObservation {
  pageId: PageId;
  /**
   * Opaque identity of the physical document tree currently loaded in the
   * page. A driver changes it whenever a represented document is replaced,
   * attached, or detached, even when URLs and observable semantic content
   * remain identical.
   */
  documentId?: string;
  url: string;
  title?: string;
  visibleText?: string;
  capturedAt: number;
  entities: DriverObservedEntity[];
  relations?: DriverObservedRelation[];
  /** Facts the driver could not capture because a bounded sensor reached its cap. */
  capturedOmissions?: ViewOmission[];
}

export interface DriverNavigateRequest {
  pageId: PageId;
  url: string;
}

export interface DriverObserveRequest {
  pageId: PageId;
}

export interface UploadFile {
  name: string;
  mediaType: string;
  data: Uint8Array;
}

export type BrowserAction =
  | { kind: 'click'; target: EntityRef }
  | { kind: 'contextClick'; target: EntityRef }
  | { kind: 'doubleClick'; target: EntityRef }
  | { kind: 'fill'; target: EntityRef; value: string }
  | { kind: 'type'; target: EntityRef; text: string }
  | { kind: 'select'; target: EntityRef; values: string[] }
  | { kind: 'check'; target: EntityRef; checked: boolean }
  | { kind: 'hover'; target: EntityRef }
  | { kind: 'press'; target?: EntityRef; key: string }
  | { kind: 'scroll'; target?: EntityRef; deltaX: number; deltaY: number }
  | { kind: 'drag'; target: EntityRef; destination: EntityRef }
  | { kind: 'upload'; target: EntityRef; files: UploadFile[] }
  | { kind: 'focus'; target: EntityRef };

export type ResolvedAction =
  | { kind: 'click'; target: DriverTarget }
  | { kind: 'contextClick'; target: DriverTarget }
  | { kind: 'doubleClick'; target: DriverTarget }
  | { kind: 'fill'; target: DriverTarget; value: string }
  | { kind: 'type'; target: DriverTarget; text: string }
  | { kind: 'select'; target: DriverTarget; values: string[] }
  | { kind: 'check'; target: DriverTarget; checked: boolean }
  | { kind: 'hover'; target: DriverTarget }
  | { kind: 'press'; target?: DriverTarget; key: string }
  | { kind: 'scroll'; target?: DriverTarget; deltaX: number; deltaY: number }
  | { kind: 'drag'; target: DriverTarget; destination: DriverTarget }
  | { kind: 'upload'; target: DriverTarget; files: UploadFile[] }
  | { kind: 'focus'; target: DriverTarget };

export interface DriverActionRequest {
  pageId: PageId;
  action: ResolvedAction;
}

export interface ObservedEffect {
  kind: string;
  verified: boolean;
  detail?: string;
}

export interface DriverActionResult {
  dispatched: boolean;
  error?: {
    code: string;
    message: string;
  };
  effects?: ObservedEffect[];
}

/**
 * Deliberately unsafe page-context evaluation. Hosts must keep this capability
 * disabled unless an operator has explicitly opted in.
 */
export interface DriverUnsafeEvaluateRequest {
  pageId: PageId;
  expression: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export type UnsafeEvaluationOutcome =
  | 'completed'
  | 'exception'
  | 'timed_out'
  | 'cancelled'
  | 'context_destroyed'
  | 'serialization_failed'
  | 'output_too_large';

export interface DriverUnsafeEvaluateResult {
  /** Whether page code may have started executing. */
  dispatched: boolean;
  outcome: UnsafeEvaluationOutcome;
  /** Present only for a completed, JSON-compatible result. */
  value?: JsonValue;
  /** UTF-8 bytes in the serialized result before MCP-layer redaction. */
  outputBytes?: number;
  outputOmitted?: boolean;
  terminationAttempted?: boolean;
  terminationConfirmed?: boolean;
  /**
   * True only after the driver has irreversibly invalidated its logical
   * browser session because page-level execution containment could not be
   * confirmed. Physical process cleanup remains best effort.
   */
  browserInvalidated?: boolean;
}

export interface DriverPage {
  pageId: PageId;
  url: string;
  title?: string;
  openerPageId?: PageId;
}

export type CaptureKind = 'viewport' | 'entity';

export interface DriverCaptureRequest {
  pageId: PageId;
  kind: CaptureKind;
  target?: DriverTarget;
}

export interface CaptureResult {
  pageId: PageId;
  mediaType: 'image/png' | 'image/jpeg';
  data: Uint8Array;
  /** CSS-pixel width. Physical area is width × height × deviceScaleFactor². */
  width: number;
  /** CSS-pixel height. Physical area is width × height × deviceScaleFactor². */
  height: number;
  deviceScaleFactor: number;
  scrollX: number;
  scrollY: number;
  clip?: Geometry;
  capturedAt?: number;
}

export interface DriverCloseRequest {
  pageId?: PageId;
}

export interface BrowserDriverSession {
  readonly browserId: BrowserId;
  readonly initialPageId: PageId;
  navigate(request: DriverNavigateRequest): Promise<DriverObservation>;
  observe(request: DriverObserveRequest): Promise<DriverObservation>;
  act(request: DriverActionRequest): Promise<DriverActionResult>;
  /** Optional because arbitrary evaluation is not a requirement for drivers. */
  evaluateUnsafe?(
    request: DriverUnsafeEvaluateRequest,
  ): Promise<DriverUnsafeEvaluateResult>;
  pages(): Promise<DriverPage[]>;
  capture(request: DriverCaptureRequest): Promise<CaptureResult>;
  close(request?: DriverCloseRequest): Promise<void>;
}

export interface BrowserDriver {
  createSession(options?: BrowserCreateOptions): Promise<BrowserDriverSession>;
}

export interface GraphSnapshot {
  browserId: BrowserId;
  pageId: PageId;
  revision: Revision;
  url: string;
  title?: string;
  visibleText?: string;
  /** Sensor-level omissions captured before model-view budget compilation. */
  capturedOmissions?: ViewOmission[];
  entities: Entity[];
  relations: Relation[];
}

export interface EntityChange {
  entity: Entity;
  changedFields: string[];
}

export interface GraphDelta {
  fromRevision: Revision;
  toRevision: Revision;
  pageChanged: boolean;
  added: Entity[];
  removed: EntityId[];
  changed: EntityChange[];
  addedRelations: Relation[];
  removedRelations: Relation[];
  invalidatedRefs: EntityId[];
  /**
   * Entity identities proven safe to rebind from fromRevision to toRevision.
   * The original references remain revision-bound; the runtime accepts them
   * only with a current expectedRevision and a contiguous retained-identity
   * proof for every intervening revision.
   */
  rebindableRefs?: EntityId[];
  /**
   * True when hidden page state may have changed even if semantic sensors saw
   * no graph difference. Every prior entity reference is invalidated.
   */
  stateInvalidated?: boolean;
}

export interface ViewBudget {
  maxEntities?: number;
  maxCharacters?: number;
}

export interface ViewOmission {
  kind: 'entities' | 'relations' | 'content' | 'analysis' | 'stale_refs';
  count: number;
  reason: 'budget' | 'not_in_focus' | 'stale_reference' | 'scan_cap';
  /** False when a sensor proves truncation but cannot safely count every omitted fact. */
  exact?: boolean;
}

export interface CompiledEntity
  extends Omit<Entity, 'id' | 'pageId' | 'evidence' | 'confidence'> {
  ref: EntityRef;
  evidence?: Entity['evidence'];
  confidence?: Entity['confidence'];
}

export interface CompiledRelation {
  from: EntityRef;
  to: EntityRef;
  kind: RelationKind;
  confidence?: number;
  evidence?: Evidence[];
}

export interface StructuredView {
  page: {
    url: string;
    title?: string;
    visibleText?: string;
  };
  entities: CompiledEntity[];
  relations: CompiledRelation[];
  omissions: ViewOmission[];
}

export interface CompiledView {
  browserId: BrowserId;
  pageId: PageId;
  revision: Revision;
  structured: StructuredView;
  text: string;
  truncated: boolean;
}

export interface ObservationResult {
  snapshot: GraphSnapshot;
  delta: GraphDelta;
  view: CompiledView;
}

export interface NavigateRequest {
  browserId: BrowserId;
  pageId?: PageId;
  expectedRevision: Revision;
  url: string;
  budget?: ViewBudget;
}

export interface ObserveRequest {
  browserId: BrowserId;
  pageId?: PageId;
  budget?: ViewBudget;
}

export interface InspectRequest {
  browserId: BrowserId;
  pageId?: PageId;
  refs?: EntityRef[];
  budget?: ViewBudget;
  includeEvidence?: boolean;
}

export interface ActRequest {
  browserId: BrowserId;
  pageId?: PageId;
  expectedRevision: Revision;
  action: BrowserAction;
  budget?: ViewBudget;
}

export interface UnsafeEvaluateRequest {
  browserId: BrowserId;
  pageId: PageId;
  expectedRevision: Revision;
  expression: string;
  timeoutMs: number;
  maxOutputBytes: number;
  budget?: ViewBudget;
  signal?: AbortSignal;
}

export interface UnsafeEvaluationReceipt {
  outcome: UnsafeEvaluationOutcome;
  dispatched: boolean;
  preRevision: Revision;
  postRevision?: Revision;
  value?: JsonValue;
  outputBytes?: number;
  outputOmitted?: boolean;
  terminationAttempted?: boolean;
  terminationConfirmed?: boolean;
  observation?: ObservationResult;
  postObservation: 'completed' | 'failed';
  /** True means the runtime removed the browser after verification failed. */
  browserInvalidated?: boolean;
  openedPageIds: PageId[];
  error?: {
    code: string;
    message: string;
  };
  postObservationError?: {
    code:
      | 'post_evaluation_observation_failed'
      | 'evaluation_containment_failed';
    message: string;
  };
}

export type ActionStatus =
  | 'verified'
  | 'dispatched_unverified'
  | 'no_effect'
  | 'stale_target'
  | 'ambiguous_target'
  | 'blocked';

export interface ActionReceipt {
  status: ActionStatus;
  dispatched: boolean;
  preRevision: Revision;
  postRevision?: Revision;
  effects: ObservedEffect[];
  delta?: GraphDelta;
  observation?: ObservationResult;
  error?: {
    code: string;
    message: string;
  };
}

export interface PagesRequest {
  browserId: BrowserId;
}

export interface PageInfo extends DriverPage {
  browserId: BrowserId;
  revision: Revision;
}

export interface CaptureRequest {
  browserId: BrowserId;
  pageId?: PageId;
  expectedRevision: Revision;
  kind: CaptureKind;
  target?: EntityRef;
}

export interface BrowserCapture extends CaptureResult {
  browserId: BrowserId;
  revision: Revision;
  target?: EntityRef;
}

export interface CloseRequest {
  browserId: BrowserId;
  pageId?: PageId;
}

export type WaitCondition =
  | { kind: 'revision_after'; revision: Revision }
  | { kind: 'entity_present'; role?: string; name?: string }
  | { kind: 'entity_state'; target: EntityRef; state: EntityState }
  | { kind: 'text_includes'; text: string }
  | { kind: 'settled' };

export interface WaitRequest {
  browserId: BrowserId;
  pageId?: PageId;
  expectedRevision: Revision;
  condition: WaitCondition;
  timeoutMs?: number;
  pollIntervalMs?: number;
  budget?: ViewBudget;
}
