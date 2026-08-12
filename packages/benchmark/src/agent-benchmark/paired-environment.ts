import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  BROWSERIR_PROTOCOL_VERSION,
} from '@browserir/mcp';
import { z } from 'zod';

import { stableJson } from '../environment.js';
import {
  OPENROUTER_REQUIRED_CONTROL_PARAMETERS,
  openRouterControlModelFingerprint,
  verifyOpenRouterControlModelBinding,
  type OpenRouterControlModelSnapshot,
} from '../control-capability-model-metadata.js';
import { FIXTURE_AGENT_BROWSER_PROFILE } from './fixture-target.js';

export const PAIRED_EXECUTION_ENVIRONMENT_SCHEMA_VERSION = '1.2.0' as const;
export const PAIRED_EXECUTION_INTEGRITY_BINDING_SCHEMA_VERSION = '1.0.0' as const;

const execFile = promisify(execFileCallback);
const localRequire = createRequire(import.meta.url);
type RuntimeRequire = ReturnType<typeof createRequire>;
const sha256Pattern = /^[a-f0-9]{64}$/;
const prefixedSha256Pattern = /^sha256:[a-f0-9]{64}$/;
const safePrintable = /^[\x20-\x7e]+$/;
const safeName = /^[A-Za-z0-9@][A-Za-z0-9@/_.+-]{0,255}$/;

const boundedPrintable = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(safePrintable, 'must contain bounded printable ASCII only');
const digestSchema = z.string().regex(sha256Pattern);
const prefixedDigestSchema = z.string().regex(prefixedSha256Pattern);

const hostSchema = z
  .object({
    platform: boundedPrintable,
    release: boundedPrintable,
    arch: boundedPrintable,
    hardware: z
      .object({
        cpuModel: boundedPrintable,
        logicalCpuCount: z.number().int().positive(),
        memoryBytes: z.number().int().positive(),
      })
      .strict(),
    resourceLimits: z
      .object({
        attemptConcurrency: z.literal(1),
        processBoundary: z.literal(false),
        containerOrVmLimits: z.literal('unverified'),
      })
      .strict(),
  })
  .strict();

const harnessSchema = z
  .object({
    nodeVersion: boundedPrintable,
    pnpmVersion: boundedPrintable,
    packageManager: boundedPrintable,
    lockfileSha256: digestSchema,
  })
  .strict();

const runtimePackageSchema = z
  .object({
    name: z.string().regex(safeName),
    version: boundedPrintable,
  })
  .strict();

const browserSchema = z
  .object({
    engine: z.literal('chromium'),
    version: boundedPrintable,
    executableSha256: digestSchema,
  })
  .strict();

const armSchema = z
  .object({
    interfaceVersion: boundedPrintable,
    runtimePackages: z
      .array(runtimePackageSchema)
      .min(1)
      .superRefine((packages, context) => {
        const names = packages.map((candidate) => candidate.name);
        if (new Set(names).size !== names.length) {
          context.addIssue({ code: 'custom', message: 'runtime package names must be unique' });
        }
      })
      .transform((packages) =>
        [...packages].sort((left, right) => left.name.localeCompare(right.name)),
      ),
    browser: browserSchema,
  })
  .strict();

const modelConfigurationSchema = z
  .object({
    contextWindowTokens: z.number().int().positive().optional(),
    temperature: z.number().finite().min(0).max(2),
    maxRetries: z.number().int().nonnegative(),
    imageMode: z.enum(['text-only', 'multimodal']),
  })
  .strict();

const openRouterRequiredParametersSchema = z.custom<
  typeof OPENROUTER_REQUIRED_CONTROL_PARAMETERS
>(
  (value) =>
    Array.isArray(value) &&
    value.length === OPENROUTER_REQUIRED_CONTROL_PARAMETERS.length &&
    value.every(
      (parameter, index) => parameter === OPENROUTER_REQUIRED_CONTROL_PARAMETERS[index],
    ),
  'must contain the exact required OpenRouter parameter list',
);

const openRouterMetadataSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    modelId: boundedPrintable,
    canonicalModelSlug: boundedPrintable,
    contextWindowTokens: z.number().int().positive(),
    providerRoute: boundedPrintable,
    providerName: boundedPrintable,
    endpointName: boundedPrintable,
    endpointModelId: boundedPrintable,
    maxCompletionTokens: z.number().int().positive(),
    requiredParameters: openRouterRequiredParametersSchema,
  })
  .strict();

const ollamaModelSchema = z
  .object({
    provider: z.literal('ollama'),
    modelId: boundedPrintable,
    artifactDigest: prefixedDigestSchema,
    verification: z.literal('ollama-endpoint-reported-digest'),
    runtime: z
      .object({
        name: boundedPrintable,
        version: boundedPrintable,
      })
      .strict(),
    configuration: modelConfigurationSchema,
    capabilities: z
      .array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/))
      .superRefine((capabilities, context) => {
        if (new Set(capabilities).size !== capabilities.length) {
          context.addIssue({ code: 'custom', message: 'model capabilities must be unique' });
        }
      })
      .transform((capabilities) => [...capabilities].sort())
      .optional(),
  })
  .strict();

const openAiModelSchema = z
  .object({
    provider: z.literal('openai'),
    modelId: boundedPrintable,
    artifactDigest: prefixedDigestSchema,
    verification: z.literal('protocol-declared-unverified'),
    runtime: z
      .object({
        name: boundedPrintable,
        version: boundedPrintable,
      })
      .strict(),
    configuration: modelConfigurationSchema,
  })
  .strict();

const openRouterModelSchema = z
  .object({
    provider: z.literal('openrouter'),
    modelId: boundedPrintable,
    canonicalModelSlug: boundedPrintable,
    modelMetadataSha256: digestSchema,
    providerRoute: boundedPrintable,
    verification: z.literal('openrouter-endpoint-metadata-fingerprint'),
    metadata: openRouterMetadataSchema,
    configuration: modelConfigurationSchema.extend({
      contextWindowTokens: z.number().int().positive(),
      maxOutputTokens: z.number().int().positive(),
    }),
  })
  .strict()
  .superRefine((model, context) => {
    if (
      model.modelId !== model.metadata.modelId ||
      model.modelId !== model.metadata.endpointModelId ||
      model.canonicalModelSlug !== model.metadata.canonicalModelSlug ||
      model.providerRoute !== model.metadata.providerRoute
    ) {
      context.addIssue({
        code: 'custom',
        message: 'OpenRouter model identity differs from its exact endpoint metadata',
      });
    }
    if (model.configuration.contextWindowTokens !== model.metadata.contextWindowTokens) {
      context.addIssue({
        code: 'custom',
        message: 'OpenRouter context window differs from its exact endpoint metadata',
      });
    }
    if (model.configuration.maxOutputTokens > model.metadata.maxCompletionTokens) {
      context.addIssue({
        code: 'custom',
        message: 'OpenRouter output budget exceeds the selected endpoint limit',
      });
    }
    if (
      model.modelMetadataSha256 !==
      openRouterControlModelFingerprint(model.metadata as OpenRouterControlModelSnapshot)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'OpenRouter model metadata fingerprint is invalid',
      });
    }
  });

const modelSchema = z.discriminatedUnion('provider', [
  ollamaModelSchema,
  openAiModelSchema,
  openRouterModelSchema,
]);

const ollamaMetadataSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    provider: z.literal('ollama'),
    modelId: boundedPrintable,
    artifactDigest: prefixedDigestSchema,
    contextWindowTokens: z.number().int().positive().optional(),
    capabilities: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)),
  })
  .strict();

const pairedModelMetadataSchema = z.union([
  openRouterMetadataSchema,
  ollamaMetadataSchema,
]);

const targetSchema = z
  .object({
    expectedVersion: prefixedDigestSchema,
    headless: z.boolean(),
    profile: z
      .object({
        viewport: z
          .object({
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            deviceScaleFactor: z.number().positive(),
          })
          .strict(),
        locale: boundedPrintable,
        timezoneId: boundedPrintable,
        colorScheme: z.enum(['light', 'dark', 'no-preference']),
        reducedMotion: z.enum(['reduce', 'no-preference']),
      })
      .strict(),
  })
  .strict();

const environmentSchema = z
  .object({
    schemaVersion: z.literal(PAIRED_EXECUTION_ENVIRONMENT_SCHEMA_VERSION),
    host: hostSchema,
    harness: harnessSchema,
    model: modelSchema,
    target: targetSchema,
    arms: z
      .object({
        control: armSchema,
        treatment: armSchema,
      })
      .strict(),
  })
  .strict();

export type PairedExecutionEnvironment = z.output<typeof environmentSchema>;
export type PairedExecutionHost = z.input<typeof hostSchema>;
export type PairedExecutionHarness = z.input<typeof harnessSchema>;
export type PairedExecutionModel = z.input<typeof modelSchema>;
export type PairedExecutionModelMetadata = z.output<typeof pairedModelMetadataSchema>;
export type PairedExecutionArm = z.input<typeof armSchema>;

export interface PairedExecutionEnvironmentProtocol {
  agent:
    | {
        provider: 'ollama' | 'openai';
        baseUrl?: string | undefined;
        modelId: string;
        modelDigest: string;
        contextWindowTokens?: number | undefined;
        temperature: number;
        maxRetries: number;
        imageMode: 'text-only' | 'multimodal';
      }
    | {
        provider: 'openrouter';
        baseUrl: 'https://openrouter.ai/api/v1';
        modelId: string;
        canonicalModelSlug: string;
        modelMetadataSha256: string;
        providerRoute: string;
        temperature: number;
        maxOutputTokens: number;
        maxRetries: number;
        imageMode: 'text-only' | 'multimodal';
      };
  target: {
    expectedVersion: string;
    headless: boolean;
  };
  arms: {
    control: { interfaceVersion: string };
    treatment: { interfaceVersion: string };
  };
}

export interface PairedExecutionEnvironmentCollectionOptions {
  /** Used only for local reads. Absolute paths are never retained in the snapshot. */
  workspaceRoot: string;
  protocol: PairedExecutionEnvironmentProtocol;
}

export interface PairedExecutionEnvironmentProbe {
  host(): Promise<PairedExecutionHost>;
  harness(workspaceRoot: string): Promise<PairedExecutionHarness>;
  model(protocol: PairedExecutionEnvironmentProtocol): Promise<PairedExecutionModel>;
  arm(
    role: 'control' | 'treatment',
    protocol: PairedExecutionEnvironmentProtocol,
  ): Promise<PairedExecutionArm>;
}

export interface CreateDefaultPairedExecutionEnvironmentProbeOptions {
  fetch?: typeof fetch | undefined;
}

interface PlaywrightBrowser {
  version(): string;
  close(): Promise<void>;
}

interface PlaywrightRuntime {
  chromium: {
    executablePath(): string;
    launch(options: {
      headless: boolean;
      executablePath?: string | undefined;
    }): Promise<PlaywrightBrowser>;
  };
}

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  packageManager?: unknown;
}

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function manifest(path: string): Promise<PackageManifest> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('A runtime package manifest is not a JSON object.');
  }
  return parsed as PackageManifest;
}

const manifestVersion = async (path: string): Promise<string> => {
  const value = (await manifest(path)).version;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('A runtime package manifest has no version.');
  }
  return value;
};

const resolveManifest = (loader: RuntimeRequire, specifier: string): string =>
  loader.resolve(`${specifier}/package.json`);

const playwrightCoreVersion = async (playwrightManifestPath: string): Promise<string> => {
  const playwrightRequire = createRequire(playwrightManifestPath);
  return manifestVersion(resolveManifest(playwrightRequire, 'playwright-core'));
};

async function browserMetadata(input: {
  runtime: PlaywrightRuntime;
  executablePath: string;
  executableSha256: Promise<string>;
}): Promise<PairedExecutionArm['browser']> {
  // Hash before launch so a failed file read cannot orphan a running probe
  // browser. The default probe memoizes this digest across both arms.
  const executableSha256 = await input.executableSha256;
  const browser = await input.runtime.chromium.launch({
    headless: true,
    executablePath: input.executablePath,
  });
  try {
    return {
      engine: 'chromium',
      version: browser.version(),
      executableSha256,
    };
  } finally {
    await browser.close();
  }
}

const packageEntry = async (
  name: string,
  manifestPath: string,
): Promise<{ name: string; version: string }> => ({
  name,
  version: await manifestVersion(manifestPath),
});

async function controlArm(
  protocol: PairedExecutionEnvironmentProtocol,
  executableDigest: (path: string) => Promise<string>,
): Promise<PairedExecutionArm> {
  const mcpManifestPath = resolveManifest(localRequire, '@playwright/mcp');
  const mcpRequire = createRequire(mcpManifestPath);
  const runtimeManifestPath = resolveManifest(mcpRequire, 'playwright');
  const runtime = mcpRequire('playwright') as PlaywrightRuntime;
  const launchRuntime = localRequire('playwright') as PlaywrightRuntime;
  const actualInterfaceVersion = await manifestVersion(mcpManifestPath);
  if (protocol.arms.control.interfaceVersion !== actualInterfaceVersion) {
    throw new Error('Control interface version drifted before environment capture.');
  }
  const browser = await browserMetadata({
    runtime,
    // The benchmark passes this exact explicit path to the official MCP CLI.
    executablePath: launchRuntime.chromium.executablePath(),
    executableSha256: executableDigest(launchRuntime.chromium.executablePath()),
  });
  return {
    interfaceVersion: actualInterfaceVersion,
    runtimePackages: [
      await packageEntry('@playwright/mcp', mcpManifestPath),
      {
        name: 'playwright-core',
        version: await playwrightCoreVersion(runtimeManifestPath),
      },
    ],
    browser,
  };
}

async function treatmentArm(
  protocol: PairedExecutionEnvironmentProtocol,
  executableDigest: (path: string) => Promise<string>,
): Promise<PairedExecutionArm> {
  const coreManifestPath = resolveManifest(localRequire, '@browserir/core');
  const mcpManifestPath = resolveManifest(localRequire, '@browserir/mcp');
  const driverManifestPath = resolveManifest(localRequire, '@browserir/playwright');
  const driverRequire = createRequire(driverManifestPath);
  const runtimeManifestPath = resolveManifest(driverRequire, 'playwright');
  const runtime = driverRequire('playwright') as PlaywrightRuntime;
  const mcpVersion = await manifestVersion(mcpManifestPath);
  const actualInterfaceVersion = `${mcpVersion}+mcp-${BROWSERIR_PROTOCOL_VERSION}`;
  if (protocol.arms.treatment.interfaceVersion !== actualInterfaceVersion) {
    throw new Error('Treatment interface version drifted before environment capture.');
  }
  return {
    interfaceVersion: actualInterfaceVersion,
    runtimePackages: [
      await packageEntry('@browserir/core', coreManifestPath),
      await packageEntry('@browserir/mcp', mcpManifestPath),
      await packageEntry('@browserir/playwright', driverManifestPath),
      {
        name: 'playwright-core',
        version: await playwrightCoreVersion(runtimeManifestPath),
      },
    ],
    browser: await browserMetadata({
      runtime,
      executablePath: runtime.chromium.executablePath(),
      executableSha256: executableDigest(runtime.chromium.executablePath()),
    }),
  };
}

const configuredContext = (parameters: unknown): number | undefined => {
  if (typeof parameters !== 'string') return undefined;
  const raw = parameters
    .split('\n')
    .map((line) => line.trim().split(/\s+/u))
    .find(([name]) => name === 'num_ctx')?.[1];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
};

async function ollamaModel(
  protocol: PairedExecutionEnvironmentProtocol,
): Promise<PairedExecutionModel> {
  if (protocol.agent.provider !== 'ollama') {
    throw new Error('Ollama model probe received a non-Ollama protocol.');
  }
  if (protocol.agent.baseUrl === undefined) {
    throw new Error('Ollama environment capture requires an explicit endpoint.');
  }
  const [versionResponse, tagsResponse, showResponse] = await Promise.all([
    fetch(new URL('/api/version', protocol.agent.baseUrl), { redirect: 'error' }),
    fetch(new URL('/api/tags', protocol.agent.baseUrl), { redirect: 'error' }),
    fetch(new URL('/api/show', protocol.agent.baseUrl), {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: protocol.agent.modelId }),
    }),
  ]);
  if (!versionResponse.ok || !tagsResponse.ok || !showResponse.ok) {
    throw new Error('Ollama environment capture failed.');
  }
  const versionBody = (await versionResponse.json()) as { version?: unknown };
  const tagsBody = (await tagsResponse.json()) as {
    models?: Array<{ name?: unknown; digest?: unknown }>;
  };
  const showBody = (await showResponse.json()) as {
    parameters?: unknown;
    capabilities?: unknown;
  };
  const serverVersion = versionBody.version;
  const installed = tagsBody.models?.find(
    (candidate) => candidate.name === protocol.agent.modelId,
  );
  if (typeof serverVersion !== 'string' || typeof installed?.digest !== 'string') {
    throw new Error('Ollama environment capture returned incomplete metadata.');
  }
  const artifactDigest = `sha256:${installed.digest}`;
  if (artifactDigest !== protocol.agent.modelDigest) {
    throw new Error('Ollama model artifact drifted during environment capture.');
  }
  const contextWindowTokens = configuredContext(showBody.parameters);
  if (
    protocol.agent.contextWindowTokens !== undefined &&
    contextWindowTokens !== protocol.agent.contextWindowTokens
  ) {
    throw new Error('Ollama model context drifted during environment capture.');
  }
  const capabilities = Array.isArray(showBody.capabilities)
    ? showBody.capabilities.filter(
        (capability): capability is string => typeof capability === 'string',
      )
    : undefined;
  return {
    provider: 'ollama',
    modelId: protocol.agent.modelId,
    artifactDigest,
    verification: 'ollama-endpoint-reported-digest',
    runtime: { name: 'ollama', version: serverVersion },
    configuration: {
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
      temperature: protocol.agent.temperature,
      maxRetries: protocol.agent.maxRetries,
      imageMode: protocol.agent.imageMode,
    },
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

async function openRouterModel(
  protocol: PairedExecutionEnvironmentProtocol,
  request: typeof fetch,
): Promise<PairedExecutionModel> {
  if (protocol.agent.provider !== 'openrouter') {
    throw new Error('OpenRouter model probe received a non-OpenRouter protocol.');
  }
  const metadata = await verifyOpenRouterControlModelBinding({
    binding: protocol.agent,
    fetch: request,
  });
  return {
    provider: 'openrouter',
    modelId: protocol.agent.modelId,
    canonicalModelSlug: protocol.agent.canonicalModelSlug,
    modelMetadataSha256: protocol.agent.modelMetadataSha256,
    providerRoute: protocol.agent.providerRoute,
    verification: 'openrouter-endpoint-metadata-fingerprint',
    metadata,
    configuration: {
      contextWindowTokens: metadata.contextWindowTokens,
      temperature: protocol.agent.temperature,
      maxOutputTokens: protocol.agent.maxOutputTokens,
      maxRetries: protocol.agent.maxRetries,
      imageMode: protocol.agent.imageMode,
    },
  };
}

export const createDefaultPairedExecutionEnvironmentProbe =
  (
    options: CreateDefaultPairedExecutionEnvironmentProbeOptions = {},
  ): PairedExecutionEnvironmentProbe => {
  const executableDigests = new Map<string, Promise<string>>();
  const executableDigest = (path: string): Promise<string> => {
    let pending = executableDigests.get(path);
    if (pending === undefined) {
      pending = sha256File(path);
      executableDigests.set(path, pending);
    }
    return pending;
  };
  return {
    host: async () => {
      const processors = cpus();
      return {
        platform: platform(),
        release: release(),
        arch: arch(),
        hardware: {
          cpuModel: processors[0]?.model ?? 'unknown',
          logicalCpuCount: processors.length,
          memoryBytes: totalmem(),
        },
        resourceLimits: {
          attemptConcurrency: 1,
          processBoundary: false,
          containerOrVmLimits: 'unverified',
        },
      };
    },
    harness: async (workspaceRoot) => {
      const rootManifest = await manifest(join(workspaceRoot, 'package.json'));
      if (typeof rootManifest.packageManager !== 'string') {
        throw new Error('The workspace package manager is not pinned.');
      }
      const { stdout } = await execFile('pnpm', ['--version'], { cwd: workspaceRoot });
      return {
        nodeVersion: process.version,
        pnpmVersion: stdout.trim(),
        packageManager: rootManifest.packageManager,
        lockfileSha256: await sha256File(join(workspaceRoot, 'pnpm-lock.yaml')),
      };
    },
    model: async (protocol) =>
      protocol.agent.provider === 'ollama'
        ? ollamaModel(protocol)
        : protocol.agent.provider === 'openrouter'
          ? openRouterModel(protocol, options.fetch ?? globalThis.fetch)
          : {
              provider: 'openai',
              modelId: protocol.agent.modelId,
              artifactDigest: protocol.agent.modelDigest,
              verification: 'protocol-declared-unverified',
              runtime: { name: 'openai-managed', version: 'unverified' },
              configuration: {
                ...(protocol.agent.contextWindowTokens === undefined
                  ? {}
                  : { contextWindowTokens: protocol.agent.contextWindowTokens }),
                temperature: protocol.agent.temperature,
                maxRetries: protocol.agent.maxRetries,
                imageMode: protocol.agent.imageMode,
              },
            },
    arm: async (role, protocol) =>
      role === 'control'
        ? controlArm(protocol, executableDigest)
        : treatmentArm(protocol, executableDigest),
  };
};

export function parsePairedExecutionEnvironment(
  input: unknown,
): PairedExecutionEnvironment {
  const result = environmentSchema.safeParse(input);
  if (!result.success) {
    throw new Error(
      `Invalid paired execution environment: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}

export function renderPairedExecutionEnvironment(input: unknown): string {
  const parsed = parsePairedExecutionEnvironment(input);
  return `${JSON.stringify(JSON.parse(stableJson(parsed)) as unknown, null, 2)}\n`;
}

export function pairedExecutionModelMetadata(
  input: PairedExecutionEnvironment | PairedExecutionModel,
): PairedExecutionModelMetadata {
  const model = 'model' in input ? input.model : modelSchema.parse(input);
  if (model.provider === 'openrouter') return model.metadata;
  if (model.provider === 'openai') {
    throw new Error(
      'Legacy OpenAI execution has no verifiable endpoint metadata snapshot.',
    );
  }
  return pairedModelMetadataSchema.parse({
    schemaVersion: '1.0.0',
    provider: 'ollama',
    modelId: model.modelId,
    artifactDigest: model.artifactDigest,
    ...(model.configuration.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: model.configuration.contextWindowTokens }),
    capabilities: model.capabilities ?? [],
  });
}

export function parsePairedExecutionModelMetadata(
  input: unknown,
): PairedExecutionModelMetadata {
  const result = pairedModelMetadataSchema.safeParse(input);
  if (!result.success) {
    throw new Error(
      `Invalid paired execution model metadata: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}

export function renderPairedExecutionModelMetadata(
  input: PairedExecutionEnvironment | PairedExecutionModel | PairedExecutionModelMetadata,
): string {
  const metadata =
    typeof input === 'object' &&
    input !== null &&
    ('model' in input || 'verification' in input)
      ? pairedExecutionModelMetadata(
          input as PairedExecutionEnvironment | PairedExecutionModel,
        )
      : parsePairedExecutionModelMetadata(input);
  return `${JSON.stringify(JSON.parse(stableJson(metadata)) as unknown, null, 2)}\n`;
}

export function pairedExecutionEnvironmentFingerprint(input: unknown): string {
  return sha256(stableJson(parsePairedExecutionEnvironment(input)));
}

const differingPaths = (left: unknown, right: unknown, path = ''): string[] => {
  if (stableJson(left) === stableJson(right)) return [];
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) ||
    Array.isArray(right)
  ) {
    return [path || 'root'];
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
  return keys.flatMap((key) =>
    differingPaths(leftRecord[key], rightRecord[key], path.length === 0 ? key : `${path}.${key}`),
  );
};

export function assertPairedExecutionEnvironmentStable(
  start: unknown,
  end: unknown,
): string {
  const parsedStart = parsePairedExecutionEnvironment(start);
  const parsedEnd = parsePairedExecutionEnvironment(end);
  const startFingerprint = pairedExecutionEnvironmentFingerprint(parsedStart);
  const endFingerprint = pairedExecutionEnvironmentFingerprint(parsedEnd);
  if (startFingerprint !== endFingerprint) {
    const paths = differingPaths(parsedStart, parsedEnd);
    throw new Error(`Paired execution environment drifted at: ${paths.join(', ')}.`);
  }
  return startFingerprint;
}

export interface PairedExecutionIntegrityBinding {
  schemaVersion: typeof PAIRED_EXECUTION_INTEGRITY_BINDING_SCHEMA_VERSION;
  environmentFingerprint: string;
  environmentStartSha256: string;
  environmentEndSha256: string;
  journalFinalEventSha256: string;
  bindingSha256: string;
}

export function createPairedExecutionIntegrityBinding(
  start: unknown,
  end: unknown,
  journalFinalEventSha256: string,
): PairedExecutionIntegrityBinding {
  if (!sha256Pattern.test(journalFinalEventSha256)) {
    throw new Error('Journal final event must be a lowercase SHA-256 digest.');
  }
  const environmentFingerprint = assertPairedExecutionEnvironmentStable(start, end);
  const environmentStartSha256 = sha256(renderPairedExecutionEnvironment(start));
  const environmentEndSha256 = sha256(renderPairedExecutionEnvironment(end));
  const payload = {
    schemaVersion: PAIRED_EXECUTION_INTEGRITY_BINDING_SCHEMA_VERSION,
    environmentFingerprint,
    environmentStartSha256,
    environmentEndSha256,
    journalFinalEventSha256,
  } as const;
  return {
    ...payload,
    bindingSha256: sha256(stableJson(payload)),
  };
}

export async function collectPairedExecutionEnvironment(
  options: PairedExecutionEnvironmentCollectionOptions,
  probe: PairedExecutionEnvironmentProbe = createDefaultPairedExecutionEnvironmentProbe(),
): Promise<PairedExecutionEnvironment> {
  const harness = await probe.harness(options.workspaceRoot);
  const pinnedPnpm = /^pnpm@([^+]+)(?:\+.*)?$/u.exec(harness.packageManager)?.[1];
  if (pinnedPnpm === undefined) {
    throw new Error('The workspace package manager must pin an exact pnpm version.');
  }
  if (harness.pnpmVersion !== pinnedPnpm) {
    throw new Error(
      `pnpm runtime ${harness.pnpmVersion} does not match workspace pin ${harness.packageManager}.`,
    );
  }
  const [host, model, control, treatment] = await Promise.all([
    probe.host(),
    probe.model(options.protocol),
    probe.arm('control', options.protocol),
    probe.arm('treatment', options.protocol),
  ]);
  if (
    model.provider !== options.protocol.agent.provider ||
    model.modelId !== options.protocol.agent.modelId
  ) {
    throw new Error('Model probe metadata drifted from the protocol.');
  }
  const modelBindingDrifted =
    options.protocol.agent.provider === 'openrouter'
      ? model.provider !== 'openrouter' ||
        model.canonicalModelSlug !== options.protocol.agent.canonicalModelSlug ||
        model.modelMetadataSha256 !== options.protocol.agent.modelMetadataSha256 ||
        model.providerRoute !== options.protocol.agent.providerRoute
      : model.provider !== options.protocol.agent.provider ||
        model.artifactDigest !== options.protocol.agent.modelDigest;
  if (modelBindingDrifted) {
    throw new Error('Model metadata drifted from the protocol.');
  }
  if (
    control.interfaceVersion !== options.protocol.arms.control.interfaceVersion ||
    treatment.interfaceVersion !== options.protocol.arms.treatment.interfaceVersion
  ) {
    throw new Error('Arm probe metadata drifted from the protocol.');
  }
  return parsePairedExecutionEnvironment({
    schemaVersion: PAIRED_EXECUTION_ENVIRONMENT_SCHEMA_VERSION,
    host,
    harness,
    model,
    target: {
      expectedVersion: options.protocol.target.expectedVersion,
      headless: options.protocol.target.headless,
      profile: FIXTURE_AGENT_BROWSER_PROFILE,
    },
    arms: { control, treatment },
  });
}
