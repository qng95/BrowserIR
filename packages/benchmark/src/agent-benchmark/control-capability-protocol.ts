import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { z } from 'zod';

export const CONTROL_CAPABILITY_PROTOCOL_SCHEMA_VERSION = '1.0.0' as const;

const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const safeProviderRoute = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
const sha256 = /^[a-f0-9]{64}$/;
const prefixedSha256 = /^sha256:[a-f0-9]{64}$/;
const unsigned32 = z.number().int().min(0).max(0xffff_ffff);

const modelCapabilitiesSchema = z
  .object({
    tools: z.literal(true),
    seed: z.literal(true),
    temperature: z.literal(true),
  })
  .strict();

const commonAgentFields = {
  framework: z.literal('langchain-create-agent'),
  frameworkVersion: z.literal('1.5.5'),
  modelCapabilities: modelCapabilitiesSchema,
  temperature: z.number().finite().min(0).max(2),
  maxOutputTokens: z.literal(4096),
  maxRetries: z.literal(0),
  imageMode: z.enum(['text-only', 'multimodal']),
  systemPrompt: z.string().trim().min(1).max(10_000),
  systemPromptSha256: z.string().regex(sha256),
} as const;

const openRouterAgentSchema = z
  .object({
    ...commonAgentFields,
    provider: z.literal('openrouter'),
    baseUrl: z.literal('https://openrouter.ai/api/v1'),
    apiKeyEnv: z.literal('OPENROUTER_API_KEY'),
    modelId: z.string().trim().min(1).max(256),
    canonicalModelSlug: z.string().trim().min(1).max(256),
    modelMetadataSha256: z.string().regex(sha256),
    modelCapabilities: z
      .object({
        tools: z.literal(true),
        seed: z.literal(true),
        temperature: z.literal(true),
      })
      .strict(),
    providerRoute: z.string().regex(safeProviderRoute),
    reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']),
    providerPolicy: z
      .object({
        allowFallbacks: z.literal(false),
        requireParameters: z.literal(true),
        dataCollection: z.literal('deny'),
      })
      .strict(),
  })
  .strict();

const ollamaAgentSchema = z
  .object({
    ...commonAgentFields,
    provider: z.literal('ollama'),
    baseUrl: z.string().url(),
    modelId: z.string().trim().min(1).max(256),
    modelDigest: z.string().regex(prefixedSha256),
    contextWindowTokens: z.number().int().positive(),
  })
  .strict();

const protocolSchema = z
  .object({
    schemaVersion: z.literal(CONTROL_CAPABILITY_PROTOCOL_SCHEMA_VERSION),
    purpose: z.literal('control_capability_qualification'),
    scoreEligible: z.literal(false),
    status: z.literal('frozen'),
    dropId: z.string().regex(safeId),
    protocolId: z.string().regex(safeId),
    task: z
      .object({
        id: z.literal('create-customer'),
        version: z.string().regex(prefixedSha256),
        promptSha256: z.string().regex(sha256),
        oracleVersion: z.string().regex(prefixedSha256),
      })
      .strict(),
    reservedSealedTaskIds: z.tuple([z.literal('validation-recovery')]),
    schedule: z
      .object({
        attempts: z.literal(5),
        modelSeedBase: unsigned32,
        stoppingRule: z.literal('run-entire-schedule'),
        invalidReplacementPolicy: z.literal('none'),
      })
      .strict(),
    decisionRule: z
      .object({
        id: z.literal('complete-five-zero-invalid-at-least-one-pass'),
        requiredCompletedAttempts: z.literal(5),
        maximumInvalidAttempts: z.literal(0),
        minimumPasses: z.literal(1),
      })
      .strict(),
    budgets: z
      .object({
        maxDurationMs: z.number().int().positive(),
        maxToolCalls: z.number().int().positive(),
        maxModelTurns: z.number().int().positive(),
      })
      .strict(),
    agent: z.discriminatedUnion('provider', [openRouterAgentSchema, ollamaAgentSchema]),
    target: z
      .object({
        expectedVersion: z.string().regex(prefixedSha256),
        headless: z.boolean(),
      })
      .strict(),
    control: z
      .object({
        role: z.literal('control'),
        id: z.literal('playwright-mcp'),
        package: z.literal('@playwright/mcp'),
        label: z.literal('Official Playwright MCP'),
        interfaceVersion: z.string().trim().min(1).max(160),
        expectedToolCatalogSha256: z.string().regex(sha256),
      })
      .strict(),
  })
  .strict()
  .superRefine((protocol, context) => {
    if (protocol.agent.provider === 'ollama') {
      const endpoint = new URL(protocol.agent.baseUrl);
      const loopback = endpoint.hostname === '127.0.0.1' || endpoint.hostname === '[::1]';
      if (
        endpoint.protocol !== 'http:' ||
        !loopback ||
        endpoint.port.length === 0 ||
        endpoint.username.length > 0 ||
        endpoint.password.length > 0 ||
        endpoint.search.length > 0 ||
        endpoint.hash.length > 0 ||
        (endpoint.pathname !== '/v1' && endpoint.pathname !== '/v1/')
      ) {
        context.addIssue({
          code: 'custom',
          path: ['agent', 'baseUrl'],
          message:
            'Ollama baseUrl must be an explicit HTTP loopback /v1 endpoint with a port and no credentials, query, or fragment.',
        });
      }
    }
    const actualPromptSha256 = createHash('sha256')
      .update(protocol.agent.systemPrompt, 'utf8')
      .digest('hex');
    if (actualPromptSha256 !== protocol.agent.systemPromptSha256) {
      context.addIssue({
        code: 'custom',
        path: ['agent', 'systemPromptSha256'],
        message: 'System prompt hash does not match its bytes.',
      });
    }
  });

export type ControlCapabilityProtocol = z.infer<typeof protocolSchema>;

export function parseControlCapabilityProtocol(input: unknown): ControlCapabilityProtocol {
  const result = protocolSchema.safeParse(input);
  if (!result.success) {
    throw new Error(
      `Invalid control capability protocol: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}

export async function readControlCapabilityProtocol(path: string): Promise<{
  protocol: ControlCapabilityProtocol;
  sourceText: string;
  sha256: string;
}> {
  const sourceText = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText) as unknown;
  } catch (error) {
    throw new Error(
      `Control capability protocol is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    protocol: parseControlCapabilityProtocol(parsed),
    sourceText,
    sha256: createHash('sha256').update(sourceText, 'utf8').digest('hex'),
  };
}
