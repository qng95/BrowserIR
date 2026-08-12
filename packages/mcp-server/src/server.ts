import {
  McpServer,
  createMcpHandler,
  type CallToolResult,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';

import {
  browserActSchema,
  browserCaptureSchema,
  browserCloseSchema,
  browserCreateSchema,
  browserEvaluateUnsafeSchema,
  browserInspectSchema,
  browserNavigateSchema,
  browserObserveSchema,
  browserPagesSchema,
  browserWaitSchema,
} from './schemas.js';
import {
  BrowserIrServiceError,
  type BrowserIrService,
  type BrowserIrToolResult,
} from './types.js';
import { BROWSERIR_VERSION } from './version.js';

export const SAFE_BROWSER_TOOL_NAMES = [
  'browser_create',
  'browser_navigate',
  'browser_observe',
  'browser_inspect',
  'browser_act',
  'browser_wait',
  'browser_pages',
  'browser_capture',
  'browser_close',
] as const;

const STATIC_CATALOG_CACHE_TTL_MS = 5 * 60 * 1_000;

export interface BrowserIrMcpOptions {
  service: BrowserIrService;
  enableUnsafeEvaluate?: boolean;
  allowLegacyProtocol?: boolean;
}

function toCallToolResult(result: BrowserIrToolResult): CallToolResult {
  const content: CallToolResult['content'] = [{ type: 'text', text: result.summary }];
  if (result.image) {
    content.push({
      type: 'image',
      data: result.image.data,
      mimeType: result.image.mime_type,
    });
  }
  return {
    content,
    structuredContent: result.data,
    ...(result.is_error === true ? { isError: true } : {}),
  };
}

function toErrorResult(error: unknown): CallToolResult {
  const known = error instanceof BrowserIrServiceError;
  const message = known ? error.message : 'BrowserIR operation failed.';
  const code = known ? error.code : 'internal_error';
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: {
      error: {
        code,
        message,
        ...(known && error.details !== undefined ? { details: error.details } : {}),
      },
    },
    isError: true,
  };
}

async function invoke(operation: () => Promise<BrowserIrToolResult>): Promise<CallToolResult> {
  try {
    return toCallToolResult(await operation());
  } catch (error) {
    return toErrorResult(error);
  }
}

export function createBrowserIrMcpServer(options: BrowserIrMcpOptions): McpServer {
  const { service } = options;
  if (options.enableUnsafeEvaluate === true && service.evaluateUnsafe === undefined) {
    throw new Error('Unsafe evaluation was enabled, but the BrowserIR service does not implement it.');
  }

  const server = new McpServer(
    { name: 'browserir', version: BROWSERIR_VERSION },
    {
      capabilities: { tools: {} },
      cacheHints: {
        'server/discover': {
          ttlMs: STATIC_CATALOG_CACHE_TTL_MS,
          cacheScope: 'public',
        },
        'tools/list':
          options.enableUnsafeEvaluate === true
            ? { ttlMs: 0, cacheScope: 'private' }
            : { ttlMs: STATIC_CATALOG_CACHE_TTL_MS, cacheScope: 'public' },
      },
      instructions:
        'Use BrowserIR observations and entity references for browser work. Re-observe after stale revisions. Arbitrary page evaluation is an optional escape hatch and should not be needed for normal tasks.',
    },
  );

  server.registerTool(
    'browser_create',
    {
      title: 'Create browser',
      description:
        'Create an isolated BrowserIR browser and return opaque browser/page handles plus the initial revision.',
      inputSchema: browserCreateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (input) => invoke(() => service.create(input)),
  );

  server.registerTool(
    'browser_navigate',
    {
      title: 'Navigate browser',
      description:
        'Navigate a page at the expected BrowserIR revision and return the resulting compact observation.',
      inputSchema: browserNavigateSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (input) => invoke(() => service.navigate(input)),
  );

  server.registerTool(
    'browser_observe',
    {
      title: 'Observe browser',
      description:
        'Compile the current compact BrowserIR view with deterministic ordering, explicit omissions, and changes from the preceding observation.',
      inputSchema: browserObserveSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    (input) => invoke(() => service.observe(input)),
  );

  server.registerTool(
    'browser_inspect',
    {
      title: 'Inspect BrowserIR entities',
      description:
        'Expand selected BrowserIR entities, relationships, capabilities, and optional evidence.',
      inputSchema: browserInspectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    (input) => invoke(() => service.inspect(input)),
  );

  server.registerTool(
    'browser_act',
    {
      title: 'Act in browser',
      description:
        'Execute one entity-targeted or page-scoped typed action at an expected revision and return verified effects. Copy entity ref tokens exactly without brackets. Example fill: {kind:"fill",target_ref:"e15@r7",value:"Ada",expected_revision:7}. Required fields by kind: target_ref for click/double_click/context_click/focus/hover/fill/type/select/check/uncheck/upload; value for fill; text for type; values for select; keys for press; artifact_ids for upload; source_ref and destination_ref for drag.',
      inputSchema: browserActSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    (input) => invoke(() => service.act(input)),
  );

  server.registerTool(
    'browser_wait',
    {
      title: 'Wait for browser condition',
      description:
        'Wait for a bounded semantic condition, then return the new BrowserIR revision and delta. Use flat fields: {kind:"text",value:"Saved",expected_revision:7}; entity_state additionally requires target_ref and state. Copy ref tokens exactly without brackets.',
      inputSchema: browserWaitSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    (input) => invoke(() => service.wait(input)),
  );

  server.registerTool(
    'browser_pages',
    {
      title: 'List browser pages',
      description: 'List the current pages, popups, and their opaque BrowserIR handles.',
      inputSchema: browserPagesSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    (input) => invoke(() => service.pages(input)),
  );

  server.registerTool(
    'browser_capture',
    {
      title: 'Capture browser image',
      description:
        'Capture a viewport or entity image for one BrowserIR revision; reject the result if a post-capture observation finds represented page changes.',
      inputSchema: browserCaptureSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    (input) => invoke(() => service.capture(input)),
  );

  server.registerTool(
    'browser_close',
    {
      title: 'Close browser',
      description: 'Close a BrowserIR page or the complete isolated browser session.',
      inputSchema: browserCloseSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    (input) => invoke(() => service.close(input)),
  );

  if (options.enableUnsafeEvaluate === true) {
    const evaluateUnsafe = service.evaluateUnsafe;
    if (evaluateUnsafe === undefined) {
      throw new Error('Unsafe evaluation was enabled, but the BrowserIR service does not implement it.');
    }
    server.registerTool(
      'browser_evaluate_unsafe',
      {
        title: 'Evaluate page code (unsafe)',
        description:
          'Opt-in escape hatch: execute bounded code in the page context, then force a full observation. Prefer BrowserIR typed actions.',
        inputSchema: browserEvaluateUnsafeSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
      (input, context) =>
        invoke(() =>
          service.evaluateUnsafe!(input, { signal: context.mcpReq.signal }),
        ),
    );
  }

  return server;
}

export function createBrowserIrMcpHandler(options: BrowserIrMcpOptions): McpHttpHandler {
  return createMcpHandler(() => createBrowserIrMcpServer(options), {
    legacy: options.allowLegacyProtocol === true ? 'stateless' : 'reject',
  });
}
