import * as z from 'zod/v4';

import { MAX_CAPTURE_PHYSICAL_PIXELS } from '@browserir/core';
import {
  MAX_UNSAFE_EVALUATE_EXPRESSION_CHARACTERS,
  MAX_UNSAFE_EVALUATE_OUTPUT_BYTES,
  MAX_UNSAFE_EVALUATE_TIMEOUT_MS,
} from './unsafe-evaluate.js';

const browserId = z
  .string()
  .min(1)
  .max(256)
  .describe('Opaque browser handle returned by browser_create.');
const pageId = z.string().min(1).max(256).describe('Opaque page handle returned by BrowserIR.');
const revision = z.number().int().nonnegative().describe('BrowserIR representation revision.');
const maxTokens = z
  .number()
  .int()
  .min(256)
  .max(100_000)
  .describe('Maximum approximate tokens for the complete returned BrowserIR model payload.');
const timeoutMs = z.number().int().min(1).max(120_000);
const webUrl = z.url().refine(
  (value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  },
  { message: 'Only http: and https: navigation is allowed.' },
);

export const browserCreateSchema = z
  .object({
    viewport: z
      .object({
        width: z.number().int().min(320).max(3840),
        height: z.number().int().min(240).max(2160),
        device_scale_factor: z.number().min(0.5).max(3).optional(),
      })
      .strict()
      .optional(),
    locale: z.string().min(2).max(64).optional(),
    timezone_id: z.string().min(1).max(128).optional(),
    color_scheme: z.enum(['light', 'dark']).optional(),
    reduced_motion: z.boolean().optional(),
  })
  .strict()
  .refine(
    (input) => {
      const viewport = input.viewport;
      if (viewport === undefined) return true;
      const scale = viewport.device_scale_factor ?? 1;
      return (
        viewport.width * viewport.height * scale * scale <=
        MAX_CAPTURE_PHYSICAL_PIXELS
      );
    },
    {
      path: ['viewport'],
      message: `Viewport exceeds the ${MAX_CAPTURE_PHYSICAL_PIXELS} physical-pixel capture limit.`,
    },
  );

export const browserNavigateSchema = z
  .object({
    browser_id: browserId,
    page_id: pageId.optional(),
    url: webUrl,
    expected_revision: revision,
    max_tokens: maxTokens.optional(),
  })
  .strict();

export const browserObserveSchema = z
  .object({
    browser_id: browserId,
    page_id: pageId.optional(),
    expected_revision: revision.optional(),
    max_tokens: maxTokens.optional(),
  })
  .strict();

export const browserInspectSchema = z
  .object({
    browser_id: browserId,
    page_id: pageId.optional(),
    entity_ids: z.array(z.string().min(1).max(256)).min(1).max(100),
    expected_revision: revision,
    max_tokens: maxTokens.optional(),
    include_evidence: z.boolean().optional(),
  })
  .strict();

const entityTarget = z
  .object({
    page_id: pageId.optional(),
    entity_id: z.string().min(1).max(256),
    revision,
  })
  .strict();

const pointerAction = z.object({
  kind: z.enum(['click', 'double_click', 'context_click', 'focus', 'hover']),
  target: entityTarget,
}).strict();
const fillAction = z.object({
  kind: z.literal('fill'),
  target: entityTarget,
  value: z.string(),
}).strict();
const typeAction = z.object({
  kind: z.literal('type'),
  target: entityTarget,
  text: z.string(),
}).strict();
const selectAction = z.object({
  kind: z.literal('select'),
  target: entityTarget,
  values: z.array(z.string()).min(1).max(100),
}).strict();
const checkAction = z.object({
  kind: z.enum(['check', 'uncheck']),
  target: entityTarget,
}).strict();
const pressAction = z.object({
  kind: z.literal('press'),
  keys: z.string().min(1).max(200),
  target: entityTarget.optional(),
}).strict();
const scrollAction = z.object({
  kind: z.literal('scroll'),
  target: entityTarget.optional(),
  delta_x: z.number().finite().optional(),
  delta_y: z.number().finite().optional(),
}).strict();
const dragAction = z.object({
  kind: z.literal('drag'),
  source: entityTarget,
  target: entityTarget,
}).strict();
const uploadAction = z.object({
  kind: z.literal('upload'),
  target: entityTarget,
  artifact_ids: z.array(z.string().min(1).max(256)).min(1).max(20),
}).strict();

const browserAction = z.union([
  pointerAction,
  fillAction,
  typeAction,
  selectAction,
  checkAction,
  pressAction,
  scrollAction,
  dragAction,
  uploadAction,
]);

export const browserActSchema = z
  .object({
    browser_id: browserId,
    page_id: pageId.optional(),
    expected_revision: revision,
    action: browserAction,
    max_tokens: maxTokens.optional(),
  })
  .strict();

const waitCondition = z.union([
  z.object({ kind: z.literal('revision_change') }).strict(),
  z
    .object({
      kind: z.literal('text'),
      value: z.string().min(1).max(4000),
      state: z.literal('visible').optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('entity_state'),
      target: entityTarget,
      state: z.enum(['visible', 'hidden', 'enabled', 'disabled', 'expanded', 'collapsed']),
    })
    .strict(),
  z.object({ kind: z.literal('settled') }).strict(),
]);

export const browserWaitSchema = z
  .object({
    browser_id: browserId,
    page_id: pageId.optional(),
    expected_revision: revision,
    condition: waitCondition,
    timeout_ms: timeoutMs.optional(),
    max_tokens: maxTokens.optional(),
  })
  .strict();

export const browserPagesSchema = z.object({ browser_id: browserId }).strict();

export const browserCaptureSchema = z
  .object({
    browser_id: browserId,
    page_id: pageId.optional(),
    expected_revision: revision,
    kind: z.enum(['viewport', 'entity']).optional(),
    target_entity_id: z.string().min(1).max(256).optional(),
    format: z.literal('png').optional(),
  })
  .strict()
  .refine((input) => input.kind !== 'entity' || input.target_entity_id !== undefined, {
    message: 'target_entity_id is required for an entity capture',
    path: ['target_entity_id'],
  })
  .refine((input) => input.kind !== 'viewport' || input.target_entity_id === undefined, {
    message: 'target_entity_id is only valid for an entity capture',
    path: ['target_entity_id'],
  });

export const browserCloseSchema = z
  .object({
    browser_id: browserId,
    page_id: pageId.optional(),
    expected_revision: revision.optional(),
  })
  .strict();

export const browserEvaluateUnsafeSchema = z
  .object({
    browser_id: browserId,
    page_id: pageId,
    expected_revision: revision,
    expression: z
      .string()
      .min(1)
      .max(MAX_UNSAFE_EVALUATE_EXPRESSION_CHARACTERS),
    timeout_ms: z
      .number()
      .int()
      .min(1)
      .max(MAX_UNSAFE_EVALUATE_TIMEOUT_MS)
      .optional(),
    max_output_bytes: z
      .number()
      .int()
      .min(1)
      .max(MAX_UNSAFE_EVALUATE_OUTPUT_BYTES)
      .optional(),
    max_tokens: maxTokens.optional(),
  })
  .strict();
