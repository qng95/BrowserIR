import { createHash } from 'node:crypto';
import { link, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { stableJson } from '../environment.js';
import type { AgentToolDescriptor } from './contracts.js';
import { modelFacingToolCatalogSha256 } from './evidence-drop-runner.js';
import {
  createPairedExecutionIntegrityBinding,
  parsePairedExecutionEnvironment,
  renderPairedExecutionEnvironment,
  type PairedExecutionEnvironment,
} from './paired-environment.js';
import { parsePairedJournalNdjson } from './paired-journal.js';
import {
  assertSealedBuildProvenanceStable,
  assertSealedGitSourceStable,
  parseSealedBuildProvenance,
  renderSealedBuildProvenance,
  type SealedBuildProvenance,
  type SealedGitSourceSnapshot,
} from './sealed-execution-provenance.js';

export const PAIRED_AGENT_BENCHMARK_COMPLETION_SCHEMA_VERSION = '1.0.0' as const;
export const PAIRED_AGENT_BENCHMARK_COMPLETION_FILE = 'COMPLETE.json' as const;

const sha256Pattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const checksumLinePattern = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const requiredArtifacts = new Set([
  'attempts.ndjson',
  'comparison.json',
  'control-tool-catalog.json',
  'environment-end.json',
  'environment-start.json',
  'execution-start.json',
  'execution.json',
  'journal.ndjson',
  'protocol.json',
  'summary.md',
  'system-prompt.txt',
  'treatment-tool-catalog.json',
]);
const sealedRequiredArtifacts = new Set([
  'build-provenance-end.json',
  'build-provenance-start.json',
]);

const completionIdentitySchema = z
  .object({
    runId: z.string().regex(identifierPattern),
    protocolId: z.string().regex(identifierPattern),
    protocolSha256: z.string().regex(sha256Pattern),
    journalFinalEventSha256: z.string().regex(sha256Pattern),
  })
  .strict();

const markerSchema = z
  .object({
    schemaVersion: z.literal(PAIRED_AGENT_BENCHMARK_COMPLETION_SCHEMA_VERSION),
    state: z.literal('complete'),
    ...completionIdentitySchema.shape,
    artifactManifestSha256: z.string().regex(sha256Pattern),
  })
  .strict();

const sourceSnapshotSchema = z
  .object({
    revision: z.string().nullable(),
    tree: z.string().nullable(),
    clean: z.boolean(),
    freezeRef: z.string().min(1).max(256).optional(),
  })
  .strict();

const toolDescriptorSchema = z
  .object({
    name: z.string(),
    title: z.string().optional(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();

const toolCatalogBindingsSchema = z
  .object({
    control: z
      .object({
        sha256: z.string().regex(sha256Pattern),
        toolCount: z.number().int().nonnegative(),
      })
      .strict(),
    treatment: z
      .object({
        sha256: z.string().regex(sha256Pattern),
        toolCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

const buildProvenanceBindingSchema = z
  .object({
    startSha256: z.string().regex(sha256Pattern),
    endSha256: z.string().regex(sha256Pattern),
  })
  .strict();

export type PairedAgentBenchmarkCompletionMarker = z.output<typeof markerSchema>;

export interface CreatePairedAgentBenchmarkCompletionMarkerInput {
  runId: string;
  protocolId: string;
  protocolSha256: string;
  journalFinalEventSha256: string;
}

const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

const errorCode = (error: unknown): unknown =>
  typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;

export function parsePairedAgentBenchmarkCompletionMarker(
  input: unknown,
): PairedAgentBenchmarkCompletionMarker {
  const parsed = markerSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `Invalid paired benchmark completion marker: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

export function renderPairedAgentBenchmarkCompletionMarker(input: unknown): string {
  const marker = parsePairedAgentBenchmarkCompletionMarker(input);
  return `${JSON.stringify(marker, null, 2)}\n`;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const jsonRecord = (content: Buffer, name: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString('utf8')) as unknown;
  } catch {
    throw new Error(`Paired benchmark artifact ${name} is not valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Paired benchmark artifact ${name} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
};

const canonicalEnvironment = (
  content: Buffer,
  name: string,
): PairedExecutionEnvironment => {
  const source = content.toString('utf8');
  const parsed = parsePairedExecutionEnvironment(jsonRecord(content, name));
  if (renderPairedExecutionEnvironment(parsed) !== source) {
    throw new Error(`Paired benchmark artifact ${name} is not canonical.`);
  }
  return parsed;
};

const canonicalBuildProvenance = (
  content: Buffer,
  name: string,
): SealedBuildProvenance => {
  const source = content.toString('utf8');
  const parsed = parseSealedBuildProvenance(jsonRecord(content, name));
  if (renderSealedBuildProvenance(parsed) !== source) {
    throw new Error(`Paired benchmark artifact ${name} is not canonical.`);
  }
  return parsed;
};

const sourceSnapshot = (input: unknown, name: string): SealedGitSourceSnapshot & {
  freezeRef?: string | undefined;
} => {
  const parsed = sourceSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `Paired benchmark ${name} source is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
};

const toolCatalog = (content: Buffer, name: string): AgentToolDescriptor[] => {
  let raw: unknown;
  try {
    raw = JSON.parse(content.toString('utf8')) as unknown;
  } catch {
    throw new Error(`Paired benchmark artifact ${name} is not valid JSON.`);
  }
  const parsed = z.array(toolDescriptorSchema).safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Paired benchmark artifact ${name} is not a valid tool catalog: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
};

const toolCatalogBindings = (
  input: unknown,
  name: string,
): z.output<typeof toolCatalogBindingsSchema> => {
  const parsed = toolCatalogBindingsSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Paired benchmark ${name} tool catalogs are invalid.`);
  }
  return parsed.data;
};

const matchingIdentity = (
  artifact: Record<string, unknown>,
  name: string,
  identity: CreatePairedAgentBenchmarkCompletionMarkerInput,
): void => {
  for (const key of ['runId', 'protocolId', 'protocolSha256'] as const) {
    if (artifact[key] !== identity[key]) {
      throw new Error(`Paired benchmark artifact ${name} has mismatched ${key}.`);
    }
  }
};

function verifiedJournal(
  source: Buffer,
  identity: CreatePairedAgentBenchmarkCompletionMarkerInput,
): 'development' | 'sealed' {
  const retained = parsePairedJournalNdjson(source.toString('utf8'));
  if (!retained.complete) {
    throw new Error('Paired benchmark journal does not retain a completed schedule.');
  }
  if (
    retained.run.runId !== identity.runId ||
    retained.run.protocolId !== identity.protocolId ||
    retained.run.protocolSha256 !== identity.protocolSha256
  ) {
    throw new Error('Paired benchmark journal run_started identity is invalid.');
  }
  if (retained.events.at(-1)?.eventSha256 !== identity.journalFinalEventSha256) {
    throw new Error('Paired benchmark journal final event digest differs from its marker.');
  }
  return retained.run.phase;
}

async function verifiedArtifactManifest(
  outputDirectory: string,
  identity: CreatePairedAgentBenchmarkCompletionMarkerInput,
): Promise<string> {
  let source: string;
  try {
    source = await readFile(join(outputDirectory, 'SHA256SUMS'), 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot finalize paired benchmark evidence without SHA256SUMS: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!source.endsWith('\n')) {
    throw new Error('Paired benchmark SHA256SUMS is not canonical.');
  }
  const lines = source.slice(0, -1).split('\n');
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw new Error('Paired benchmark SHA256SUMS is empty or malformed.');
  }
  const entries = lines.map((line) => {
    const match = checksumLinePattern.exec(line);
    if (match === null) throw new Error('Paired benchmark SHA256SUMS is malformed.');
    return { digest: match[1]!, name: match[2]! };
  });
  const names = entries.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    throw new Error('Paired benchmark SHA256SUMS contains duplicate artifacts.');
  }
  const canonicalNames = [...names].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (names.some((name, index) => name !== canonicalNames[index])) {
    throw new Error('Paired benchmark SHA256SUMS is not canonically ordered.');
  }
  if (names.includes('SHA256SUMS') || names.includes(PAIRED_AGENT_BENCHMARK_COMPLETION_FILE)) {
    throw new Error('Paired benchmark SHA256SUMS contains a reserved artifact.');
  }
  for (const required of requiredArtifacts) {
    if (!names.includes(required)) {
      throw new Error(`Paired benchmark SHA256SUMS is missing required artifact ${required}.`);
    }
  }
  const contents = new Map<string, Buffer>();
  for (const entry of entries) {
    let content: Buffer;
    try {
      content = await readFile(join(outputDirectory, entry.name));
    } catch (error) {
      throw new Error(
        `Paired benchmark artifact ${entry.name} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (sha256(content) !== entry.digest) {
      throw new Error(`Paired benchmark artifact digest differs for ${entry.name}.`);
    }
    contents.set(entry.name, content);
  }
  const journalPhase = verifiedJournal(contents.get('journal.ndjson')!, identity);
  if (journalPhase === 'sealed') {
    for (const required of sealedRequiredArtifacts) {
      if (!names.includes(required)) {
        throw new Error(`Paired benchmark SHA256SUMS is missing required artifact ${required}.`);
      }
    }
  }
  if (sha256(contents.get('protocol.json')!) !== identity.protocolSha256) {
    throw new Error('Paired benchmark protocol.json digest differs from its marker.');
  }
  const comparison = jsonRecord(contents.get('comparison.json')!, 'comparison.json');
  matchingIdentity(comparison, 'comparison.json', identity);
  if (comparison['phase'] !== journalPhase) {
    throw new Error('Paired benchmark comparison phase differs from its journal.');
  }
  const executionStart = jsonRecord(
    contents.get('execution-start.json')!,
    'execution-start.json',
  );
  matchingIdentity(executionStart, 'execution-start.json', identity);
  if (executionStart['stage'] !== 'started') {
    throw new Error('Paired benchmark execution-start.json is not a start artifact.');
  }
  const execution = jsonRecord(contents.get('execution.json')!, 'execution.json');
  matchingIdentity(execution, 'execution.json', identity);
  if (execution['stage'] !== 'completed') {
    throw new Error('Paired benchmark execution.json is not completed.');
  }

  const executionStartSource = sourceSnapshot(
    executionStart['source'],
    'execution-start.json',
  );
  const executionSource = sourceSnapshot(execution['source'], 'execution.json');
  if (stableJson(executionStartSource) !== stableJson(executionSource)) {
    throw new Error('Paired benchmark execution source differs from its start artifact.');
  }
  const executionSourceEnd = sourceSnapshot(execution['sourceEnd'], 'execution.json end');
  if (journalPhase === 'sealed') {
    assertSealedGitSourceStable(executionSource, executionSourceEnd);
    if (
      executionSource.freezeRef === undefined ||
      executionSourceEnd.freezeRef !== executionSource.freezeRef
    ) {
      throw new Error('Paired benchmark sealed source freezeRef drifted between endpoints.');
    }
  }

  const startToolCatalogs = toolCatalogBindings(
    executionStart['toolCatalogs'],
    'execution-start.json',
  );
  const endToolCatalogs = toolCatalogBindings(
    execution['toolCatalogs'],
    'execution.json',
  );
  if (stableJson(startToolCatalogs) !== stableJson(endToolCatalogs)) {
    throw new Error('Paired benchmark execution tool catalogs differ from their start artifact.');
  }
  for (const role of ['control', 'treatment'] as const) {
    const name = `${role}-tool-catalog.json`;
    const catalog = toolCatalog(contents.get(name)!, name);
    const expected = {
      sha256: modelFacingToolCatalogSha256(catalog),
      toolCount: catalog.length,
    };
    if (stableJson(startToolCatalogs[role]) !== stableJson(expected)) {
      throw new Error(`Paired benchmark ${role} tool catalog digest or count differs.`);
    }
  }

  const executionJournal = execution['journal'];
  if (
    typeof executionJournal !== 'object' ||
    executionJournal === null ||
    Array.isArray(executionJournal) ||
    (executionJournal as Record<string, unknown>)['finalEventSha256'] !==
      identity.journalFinalEventSha256
  ) {
    throw new Error('Paired benchmark execution journal tail differs from its marker.');
  }

  const environmentStart = canonicalEnvironment(
    contents.get('environment-start.json')!,
    'environment-start.json',
  );
  const environmentEnd = canonicalEnvironment(
    contents.get('environment-end.json')!,
    'environment-end.json',
  );
  const expectedEnvironmentBinding = createPairedExecutionIntegrityBinding(
    environmentStart,
    environmentEnd,
    identity.journalFinalEventSha256,
  );
  if (stableJson(execution['environment']) !== stableJson(expectedEnvironmentBinding)) {
    throw new Error('Paired benchmark execution environment binding differs from its endpoints.');
  }

  if (journalPhase === 'sealed') {
    const buildStart = canonicalBuildProvenance(
      contents.get('build-provenance-start.json')!,
      'build-provenance-start.json',
    );
    const buildEnd = canonicalBuildProvenance(
      contents.get('build-provenance-end.json')!,
      'build-provenance-end.json',
    );
    assertSealedBuildProvenanceStable(buildStart, buildEnd);
    const buildBinding = buildProvenanceBindingSchema.safeParse(
      execution['buildProvenance'],
    );
    if (
      !buildBinding.success ||
      buildBinding.data.startSha256 !== buildStart.sha256 ||
      buildBinding.data.endSha256 !== buildEnd.sha256
    ) {
      throw new Error('Paired benchmark execution build provenance binding differs.');
    }
  } else if (execution['buildProvenance'] !== undefined) {
    throw new Error('Development paired benchmark execution has sealed build provenance.');
  }
  return source;
}

export async function readPairedAgentBenchmarkCompletionMarker(
  outputDirectory: string,
): Promise<PairedAgentBenchmarkCompletionMarker | undefined> {
  let source: string;
  try {
    source = await readFile(
      join(outputDirectory, PAIRED_AGENT_BENCHMARK_COMPLETION_FILE),
      'utf8',
    );
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid paired benchmark completion marker JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const marker = parsePairedAgentBenchmarkCompletionMarker(input);
  if (source !== renderPairedAgentBenchmarkCompletionMarker(marker)) {
    throw new Error('Invalid paired benchmark completion marker: non-canonical bytes.');
  }
  const artifactManifest = await verifiedArtifactManifest(outputDirectory, {
    runId: marker.runId,
    protocolId: marker.protocolId,
    protocolSha256: marker.protocolSha256,
    journalFinalEventSha256: marker.journalFinalEventSha256,
  });
  if (sha256(artifactManifest) !== marker.artifactManifestSha256) {
    throw new Error(
      'Invalid paired benchmark completion marker: artifact manifest digest differs.',
    );
  }
  return marker;
}

/**
 * Atomically exposes COMPLETE.json only after every checksummed final artifact
 * exists and matches its retained digest. Callers must invoke this as the last
 * publication step; an existing marker is never overwritten or silently reused.
 */
export async function createPairedAgentBenchmarkCompletionMarker(
  outputDirectory: string,
  input: CreatePairedAgentBenchmarkCompletionMarkerInput,
): Promise<PairedAgentBenchmarkCompletionMarker> {
  const identity = completionIdentitySchema.parse(input);
  const artifactManifest = await verifiedArtifactManifest(outputDirectory, identity);
  const marker = parsePairedAgentBenchmarkCompletionMarker({
    schemaVersion: PAIRED_AGENT_BENCHMARK_COMPLETION_SCHEMA_VERSION,
    state: 'complete',
    ...identity,
    artifactManifestSha256: sha256(artifactManifest),
  });
  const staging = await mkdtemp(join(outputDirectory, '.paired-completion-'));
  const staged = join(staging, PAIRED_AGENT_BENCHMARK_COMPLETION_FILE);
  const destination = join(outputDirectory, PAIRED_AGENT_BENCHMARK_COMPLETION_FILE);
  try {
    const handle = await open(staged, 'wx');
    try {
      await handle.writeFile(renderPairedAgentBenchmarkCompletionMarker(marker), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(staged, destination);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        throw new Error('Paired benchmark evidence is already finalized by COMPLETE.json.');
      }
      throw error;
    }
    await syncDirectory(outputDirectory);
    return marker;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
