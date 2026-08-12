import * as z from 'zod/v4';

import { MAX_CAPTURE_PHYSICAL_PIXELS } from '@browserir/core';
import {
  MAX_UNSAFE_EVALUATE_EXPRESSION_CHARACTERS,
  MAX_UNSAFE_EVALUATE_OUTPUT_BYTES,
  MAX_UNSAFE_EVALUATE_TIMEOUT_MS,
} from './unsafe-evaluate.js';
import type { BrowserActInput, BrowserWaitInput } from './types.js';

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

const actionKind = z
  .enum([
    'click',
    'double_click',
    'context_click',
    'focus',
    'hover',
    'fill',
    'type',
    'select',
    'check',
    'uncheck',
    'press',
    'scroll',
    'drag',
    'upload',
  ])
  .describe('Action to execute. Supply action-specific fields at this same top level.');

const actionFieldNames = [
  'target_ref',
  'destination_page_id',
  'source_ref',
  'destination_ref',
  'value',
  'text',
  'values',
  'keys',
  'delta_x',
  'delta_y',
  'artifact_ids',
] as const;

const requiredTargetFields = ['target_ref'] as const;

const allowedFieldsByKind: Record<BrowserActInput['kind'], ReadonlySet<string>> = {
  click: new Set(requiredTargetFields),
  double_click: new Set(requiredTargetFields),
  context_click: new Set(requiredTargetFields),
  focus: new Set(requiredTargetFields),
  hover: new Set(requiredTargetFields),
  fill: new Set([...requiredTargetFields, 'value']),
  type: new Set([...requiredTargetFields, 'text']),
  select: new Set([...requiredTargetFields, 'values']),
  check: new Set(requiredTargetFields),
  uncheck: new Set(requiredTargetFields),
  press: new Set([...requiredTargetFields, 'keys']),
  scroll: new Set([...requiredTargetFields, 'delta_x', 'delta_y']),
  drag: new Set([
    'destination_page_id',
    'source_ref',
    'destination_ref',
  ]),
  upload: new Set([...requiredTargetFields, 'artifact_ids']),
};

const requiredFieldsByKind: Record<BrowserActInput['kind'], readonly string[]> = {
  click: requiredTargetFields,
  double_click: requiredTargetFields,
  context_click: requiredTargetFields,
  focus: requiredTargetFields,
  hover: requiredTargetFields,
  fill: [...requiredTargetFields, 'value'],
  type: [...requiredTargetFields, 'text'],
  select: [...requiredTargetFields, 'values'],
  check: requiredTargetFields,
  uncheck: requiredTargetFields,
  press: ['keys'],
  scroll: [],
  drag: [
    'source_ref',
    'destination_ref',
  ],
  upload: [...requiredTargetFields, 'artifact_ids'],
};

const flatBrowserActSchema = z
  .object({
    browser_id: browserId,
    page_id: pageId
      .describe('Page containing the target, or the page for a page-scoped press/scroll.')
      .optional(),
    expected_revision: revision,
    kind: actionKind,
    target_ref: z
      .string()
      .regex(/^e[1-9]\d*@r(?:0|[1-9]\d*)$/)
      .max(256)
      .refine((value) => Number.isSafeInteger(Number(value.slice(value.lastIndexOf('@r') + 2))), {
        message: 'Entity ref revision must be a safe integer.',
      })
      .describe('Entity ref for this action. Copy the token without brackets: e15@r7 from [e15@r7].')
      .optional(),
    destination_page_id: pageId.describe('Destination page for drag; defaults to page_id.').optional(),
    source_ref: z
      .string()
      .regex(/^e[1-9]\d*@r(?:0|[1-9]\d*)$/)
      .max(256)
      .refine((value) => Number.isSafeInteger(Number(value.slice(value.lastIndexOf('@r') + 2))), {
        message: 'Entity ref revision must be a safe integer.',
      })
      .describe('Required only for drag; copy the source token without brackets.')
      .optional(),
    destination_ref: z
      .string()
      .regex(/^e[1-9]\d*@r(?:0|[1-9]\d*)$/)
      .max(256)
      .refine((value) => Number.isSafeInteger(Number(value.slice(value.lastIndexOf('@r') + 2))), {
        message: 'Entity ref revision must be a safe integer.',
      })
      .describe('Required only for drag; copy the destination token without brackets.')
      .optional(),
    value: z.string().describe('Required only for fill.').optional(),
    text: z.string().describe('Required only for type.').optional(),
    values: z.array(z.string()).min(1).max(100).describe('Required only for select.').optional(),
    keys: z.string().min(1).max(200).describe('Required only for press.').optional(),
    delta_x: z.number().finite().describe('Horizontal delta for scroll.').optional(),
    delta_y: z.number().finite().describe('Vertical delta for scroll.').optional(),
    artifact_ids: z
      .array(z.string().min(1).max(256))
      .min(1)
      .max(20)
      .describe('Required only for upload.')
      .optional(),
    max_tokens: maxTokens.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const required = requiredFieldsByKind[input.kind];
    for (const field of required) {
      if (input[field as keyof typeof input] === undefined) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is required for ${input.kind}.`,
        });
      }
    }

    const allowed = allowedFieldsByKind[input.kind];
    for (const field of actionFieldNames) {
      if (!allowed.has(field) && input[field] !== undefined) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is not valid for ${input.kind}.`,
        });
      }
    }
  });

export const browserActSchema = flatBrowserActSchema as z.ZodType<BrowserActInput>;

const flatBrowserWaitSchema = z
  .object({
    browser_id: browserId,
    page_id: pageId.optional(),
    expected_revision: revision,
    kind: z
      .enum(['revision_change', 'text', 'entity_state', 'settled'])
      .describe('Wait condition. Supply its fields at this same top level.'),
    value: z.string().min(1).max(4000).describe('Required only for text.').optional(),
    state: z
      .enum(['visible', 'hidden', 'enabled', 'disabled', 'expanded', 'collapsed'])
      .describe('Required only for entity_state; text supports only visible and may omit it.')
      .optional(),
    target_ref: z
      .string()
      .regex(/^e[1-9]\d*@r(?:0|[1-9]\d*)$/)
      .max(256)
      .refine((value) => Number.isSafeInteger(Number(value.slice(value.lastIndexOf('@r') + 2))), {
        message: 'Entity ref revision must be a safe integer.',
      })
      .describe('Required only for entity_state; copy the ref token without brackets.')
      .optional(),
    timeout_ms: timeoutMs.optional(),
    max_tokens: maxTokens.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.kind === 'text') {
      if (input.value === undefined) {
        context.addIssue({ code: 'custom', path: ['value'], message: 'value is required for text.' });
      }
      if (input.state !== undefined && input.state !== 'visible') {
        context.addIssue({
          code: 'custom',
          path: ['state'],
          message: 'Only visible is supported for text.',
        });
      }
      if (input.target_ref !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['target_ref'],
          message: 'target_ref is not valid for text.',
        });
      }
      return;
    }
    if (input.kind === 'entity_state') {
      if (input.target_ref === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['target_ref'],
          message: 'target_ref is required for entity_state.',
        });
      }
      if (input.state === undefined) {
        context.addIssue({ code: 'custom', path: ['state'], message: 'state is required for entity_state.' });
      }
      if (input.value !== undefined) {
        context.addIssue({ code: 'custom', path: ['value'], message: 'value is not valid for entity_state.' });
      }
      return;
    }
    for (const field of ['value', 'state', 'target_ref'] as const) {
      if (input[field] !== undefined) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is not valid for ${input.kind}.`,
        });
      }
    }
  });

export const browserWaitSchema = flatBrowserWaitSchema as z.ZodType<BrowserWaitInput>;

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
