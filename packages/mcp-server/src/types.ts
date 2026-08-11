export interface BrowserViewport {
  width: number;
  height: number;
  device_scale_factor?: number | undefined;
}

export interface BrowserCreateInput {
  viewport?: BrowserViewport | undefined;
  locale?: string | undefined;
  timezone_id?: string | undefined;
  color_scheme?: 'light' | 'dark' | undefined;
  reduced_motion?: boolean | undefined;
}

export interface BrowserNavigateInput {
  browser_id: string;
  page_id?: string | undefined;
  url: string;
  expected_revision: number;
  max_tokens?: number | undefined;
}

export interface BrowserObserveInput {
  browser_id: string;
  page_id?: string | undefined;
  expected_revision?: number | undefined;
  max_tokens?: number | undefined;
}

export interface BrowserInspectInput {
  browser_id: string;
  page_id?: string | undefined;
  entity_ids: string[];
  expected_revision: number;
  max_tokens?: number | undefined;
  include_evidence?: boolean | undefined;
}

export interface EntityTarget {
  page_id?: string | undefined;
  entity_id: string;
  revision: number;
}

export type BrowserAction =
  | { kind: 'click' | 'double_click' | 'context_click' | 'focus' | 'hover'; target: EntityTarget }
  | { kind: 'fill'; target: EntityTarget; value: string }
  | { kind: 'type'; target: EntityTarget; text: string }
  | { kind: 'select'; target: EntityTarget; values: string[] }
  | { kind: 'check' | 'uncheck'; target: EntityTarget }
  | { kind: 'press'; keys: string; target?: EntityTarget | undefined }
  | {
      kind: 'scroll';
      target?: EntityTarget | undefined;
      delta_x?: number | undefined;
      delta_y?: number | undefined;
    }
  | { kind: 'drag'; source: EntityTarget; target: EntityTarget }
  | { kind: 'upload'; target: EntityTarget; artifact_ids: string[] };

export interface BrowserActInput {
  browser_id: string;
  page_id?: string | undefined;
  expected_revision: number;
  action: BrowserAction;
  max_tokens?: number | undefined;
}

export type BrowserWaitCondition =
  | { kind: 'revision_change' }
  | { kind: 'text'; value: string; state?: 'visible' | undefined }
  | {
      kind: 'entity_state';
      target: EntityTarget;
      state: 'visible' | 'hidden' | 'enabled' | 'disabled' | 'expanded' | 'collapsed';
    }
  | { kind: 'settled' };

export interface BrowserWaitInput {
  browser_id: string;
  page_id?: string | undefined;
  expected_revision: number;
  condition: BrowserWaitCondition;
  timeout_ms?: number | undefined;
  max_tokens?: number | undefined;
}

export interface BrowserPagesInput {
  browser_id: string;
}

export interface BrowserCaptureInput {
  browser_id: string;
  page_id?: string | undefined;
  expected_revision: number;
  kind?: 'viewport' | 'entity' | undefined;
  target_entity_id?: string | undefined;
  format?: 'png' | undefined;
}

export interface BrowserCloseInput {
  browser_id: string;
  page_id?: string | undefined;
  expected_revision?: number | undefined;
}

export interface BrowserEvaluateUnsafeInput {
  browser_id: string;
  page_id: string;
  expected_revision: number;
  expression: string;
  timeout_ms?: number | undefined;
  max_output_bytes?: number | undefined;
  max_tokens?: number | undefined;
}

export interface BrowserIrCallContext {
  signal?: AbortSignal;
}

export interface BrowserUnsafeEvaluateAuditRecord {
  phase: 'intent' | 'completion';
  operation_id: string;
  timestamp: string;
  expression_sha256: string;
  expression_bytes: number;
  browser_id: string;
  page_id: string;
  expected_revision: number;
  requested_timeout_ms: number;
  effective_timeout_ms: number;
  requested_output_bytes: number;
  effective_output_bytes: number;
  pre_revision?: number;
  post_revision?: number;
  duration_ms?: number;
  dispatched?: boolean;
  outcome?: string;
  output_bytes?: number;
  output_omitted?: boolean;
  redaction_count?: number;
  termination_attempted?: boolean;
  termination_confirmed?: boolean;
  post_observation?: 'not_started' | 'completed' | 'failed';
  browser_invalidated?: boolean;
  opened_page_ids?: string[];
}

export interface BrowserIrImage {
  data: string;
  mime_type: 'image/png' | 'image/jpeg';
}

/**
 * Protocol-neutral result returned by the BrowserIR application boundary.
 * The MCP adapter is responsible for translating it into MCP content blocks.
 */
export interface BrowserIrToolResult {
  summary: string;
  data: Record<string, unknown>;
  image?: BrowserIrImage;
  is_error?: boolean;
}

/**
 * Thin application port used by the MCP layer. A production implementation
 * delegates these calls to BrowserIRRuntime; tests can use a deterministic fake.
 */
export interface BrowserIrService {
  create(input: BrowserCreateInput): Promise<BrowserIrToolResult>;
  navigate(input: BrowserNavigateInput): Promise<BrowserIrToolResult>;
  observe(input: BrowserObserveInput): Promise<BrowserIrToolResult>;
  inspect(input: BrowserInspectInput): Promise<BrowserIrToolResult>;
  act(input: BrowserActInput): Promise<BrowserIrToolResult>;
  wait(input: BrowserWaitInput): Promise<BrowserIrToolResult>;
  pages(input: BrowserPagesInput): Promise<BrowserIrToolResult>;
  capture(input: BrowserCaptureInput): Promise<BrowserIrToolResult>;
  close(input: BrowserCloseInput): Promise<BrowserIrToolResult>;
  evaluateUnsafe?(
    input: BrowserEvaluateUnsafeInput,
    context?: BrowserIrCallContext,
  ): Promise<BrowserIrToolResult>;
  /** Close every browser session owned by this service instance. */
  dispose?(): Promise<void>;
}

export class BrowserIrServiceError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'BrowserIrServiceError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
