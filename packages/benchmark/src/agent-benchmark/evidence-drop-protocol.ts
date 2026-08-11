import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { z } from 'zod';

export const EVIDENCE_DROP_PROTOCOL_SCHEMA_VERSION = '1.0.0' as const;

const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sha256 = /^[a-f0-9]{64}$/;
const prefixedSha256 = /^sha256:[a-f0-9]{64}$/;
const unsigned32 = z.number().int().min(0).max(0xffff_ffff);

const armSchema = z
  .object({
    role: z.enum(['control', 'treatment']),
    id: z.string().regex(safeId),
    label: z.string().trim().min(1).max(160),
    interfaceVersion: z.string().trim().min(1).max(160),
    expectedToolCatalogSha256: z.string().regex(sha256).optional(),
  })
  .strict();

const protocolSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_DROP_PROTOCOL_SCHEMA_VERSION),
    dropId: z.string().regex(safeId),
    protocolId: z.string().regex(safeId),
    phase: z.enum(['development', 'sealed']),
    status: z.enum(['draft', 'frozen']),
    freezeRef: z.string().regex(/^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/).optional(),
    question: z.string().trim().min(1).max(1_000),
    taskIds: z.array(z.string().regex(safeId)).min(1),
    taskContracts: z
      .array(
        z
          .object({
            id: z.string().regex(safeId),
            version: z.string().regex(prefixedSha256),
            promptSha256: z.string().regex(sha256),
            oracleVersion: z.string().trim().min(1).max(160),
          })
          .strict(),
      )
      .min(1),
    reservedSealedTaskIds: z.array(z.string().regex(safeId)).min(1),
    trialsPerTask: z.number().int().positive(),
    schedule: z
      .object({
        orderSeed: unsigned32,
        bootstrapSeed: unsigned32,
        modelSeedBase: unsigned32.optional(),
        bootstrapResamples: z.number().int().min(1_000),
        stoppingRule: z.literal('run-entire-schedule'),
        invalidReplacementPolicy: z.literal('none'),
      })
      .strict(),
    budgets: z
      .object({
        maxDurationMs: z.number().int().positive(),
        maxToolCalls: z.number().int().positive(),
        maxModelTurns: z.number().int().positive(),
      })
      .strict(),
    agent: z
      .object({
        framework: z.literal('langchain-create-agent'),
        provider: z.enum(['ollama', 'openai']),
        baseUrl: z.string().url().optional(),
        modelId: z.string().trim().min(1).max(256),
        modelDigest: z.string().regex(prefixedSha256),
        contextWindowTokens: z.number().int().positive().optional(),
        temperature: z.number().min(0).max(2),
        maxRetries: z.literal(0),
        imageMode: z.enum(['text-only', 'multimodal']),
        systemPrompt: z.string().trim().min(1).max(10_000),
        systemPromptSha256: z.string().regex(sha256),
      })
      .strict(),
    target: z
      .object({
        expectedVersion: z.string().regex(prefixedSha256),
        headless: z.boolean(),
      })
      .strict(),
    arms: z
      .object({
        control: armSchema,
        treatment: armSchema,
      })
      .strict(),
    analysis: z
      .object({
        confidence: z.literal(0.95),
        interval: z.enum(['paired-percentile-bootstrap', 'paired-hoeffding-bound']),
        invalidBlockHeadlineThreshold: z.literal(0.05),
        primaryMetric: z.literal('paired-treatment-minus-control-pass-rate'),
      })
      .strict(),
  })
  .strict()
  .superRefine((protocol, context) => {
    const add = (path: PropertyKey[], message: string): void => {
      context.addIssue({ code: 'custom', path, message });
    };
    if (new Set(protocol.taskIds).size !== protocol.taskIds.length) {
      add(['taskIds'], 'taskIds must be unique.');
    }
    const contractIds = protocol.taskContracts.map((contract) => contract.id);
    if (
      new Set(contractIds).size !== contractIds.length ||
      contractIds.length !== protocol.taskIds.length ||
      contractIds.some((id, index) => id !== protocol.taskIds[index])
    ) {
      add(
        ['taskContracts'],
        'taskContracts must be unique and match taskIds in the same order.',
      );
    }
    if (
      new Set(protocol.reservedSealedTaskIds).size !== protocol.reservedSealedTaskIds.length
    ) {
      add(['reservedSealedTaskIds'], 'reservedSealedTaskIds must be unique.');
    }
    if (protocol.arms.control.role !== 'control') {
      add(['arms', 'control', 'role'], 'The control arm role must be control.');
    }
    if (protocol.arms.treatment.role !== 'treatment') {
      add(['arms', 'treatment', 'role'], 'The treatment arm role must be treatment.');
    }
    if (protocol.arms.control.id === protocol.arms.treatment.id) {
      add(['arms'], 'Control and treatment arm IDs must differ.');
    }
    const actualPromptSha256 = createHash('sha256')
      .update(protocol.agent.systemPrompt, 'utf8')
      .digest('hex');
    if (actualPromptSha256 !== protocol.agent.systemPromptSha256) {
      add(['agent', 'systemPromptSha256'], 'System prompt hash does not match its bytes.');
    }
    if (/\b(?:browserir|playwright)\b/i.test(protocol.agent.systemPrompt)) {
      add(
        ['agent', 'systemPrompt'],
        'The shared system prompt must be arm-neutral and must not name BrowserIR or Playwright.',
      );
    }
    if (protocol.agent.provider === 'ollama' && protocol.agent.baseUrl === undefined) {
      add(['agent', 'baseUrl'], 'Ollama protocols require an explicit baseUrl.');
    }
    if (protocol.phase === 'development') {
      const reserved = new Set(protocol.reservedSealedTaskIds);
      if (protocol.taskIds.some((taskId) => reserved.has(taskId))) {
        add(
          ['taskIds'],
          'Development taskIds must not contain a task reserved for sealed evaluation.',
        );
      }
    } else {
      if (protocol.schedule.modelSeedBase === undefined) {
        add(
          ['schedule', 'modelSeedBase'],
          'A sealed protocol requires a precommitted modelSeedBase.',
        );
      }
      if (protocol.agent.temperature <= 0) {
        add(
          ['agent', 'temperature'],
          'A sealed protocol requires a stochastic temperature greater than zero so precommitted model seeds can define distinct sampling trials.',
        );
      }
      if (protocol.agent.provider === 'ollama' && protocol.agent.baseUrl !== undefined) {
        const endpoint = new URL(protocol.agent.baseUrl);
        const loopbackHost =
          endpoint.hostname === '127.0.0.1' || endpoint.hostname === '[::1]';
        if (
          endpoint.protocol !== 'http:' ||
          !loopbackHost ||
          endpoint.port.length === 0 ||
          endpoint.username.length > 0 ||
          endpoint.password.length > 0 ||
          endpoint.search.length > 0 ||
          endpoint.hash.length > 0 ||
          (endpoint.pathname !== '/v1' && endpoint.pathname !== '/v1/')
        ) {
          add(
            ['agent', 'baseUrl'],
            'A sealed Ollama protocol requires an explicit http://127.0.0.1:PORT/v1 or http://[::1]:PORT/v1 loopback endpoint without credentials, query, or fragment.',
          );
        }
      }
      if (protocol.status !== 'frozen') {
        add(['status'], 'A sealed protocol must be frozen.');
      }
      if (protocol.analysis.interval !== 'paired-hoeffding-bound') {
        add(
          ['analysis', 'interval'],
          'Frozen evidence must use the boundary-valid paired Hoeffding interval.',
        );
      }
      if (protocol.freezeRef === undefined) {
        add(['freezeRef'], 'A frozen sealed protocol requires a freezeRef tag.');
      }
      const scored = new Set(protocol.taskIds);
      const reserved = new Set(protocol.reservedSealedTaskIds);
      if (
        scored.size !== reserved.size ||
        [...scored].some((taskId) => !reserved.has(taskId))
      ) {
        add(
          ['taskIds'],
          'Sealed taskIds must exactly match reservedSealedTaskIds.',
        );
      }
      for (const role of ['control', 'treatment'] as const) {
        if (protocol.arms[role].expectedToolCatalogSha256 === undefined) {
          add(
            ['arms', role, 'expectedToolCatalogSha256'],
            `The frozen ${role} arm requires an exact tool catalog hash.`,
          );
        }
      }
      if (
        protocol.agent.provider === 'ollama' &&
        protocol.agent.contextWindowTokens === undefined
      ) {
        add(
          ['agent', 'contextWindowTokens'],
          'A frozen Ollama protocol must bind the configured context window.',
        );
      }
    }
  });

export type EvidenceDropProtocol = z.infer<typeof protocolSchema>;

export function parseEvidenceDropProtocol(input: unknown): EvidenceDropProtocol {
  const result = protocolSchema.safeParse(input);
  if (!result.success) {
    throw new Error(
      `Invalid evidence-drop protocol: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}

export async function readEvidenceDropProtocol(path: string): Promise<{
  protocol: EvidenceDropProtocol;
  sourceText: string;
  sha256: string;
}> {
  const sourceText = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText) as unknown;
  } catch (error) {
    throw new Error(
      `Evidence-drop protocol is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const protocol = parseEvidenceDropProtocol(parsed);
  return {
    protocol,
    sourceText,
    sha256: createHash('sha256').update(sourceText, 'utf8').digest('hex'),
  };
}
