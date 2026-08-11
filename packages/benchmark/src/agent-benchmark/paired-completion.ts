import { createHash } from 'node:crypto';
import { link, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

export const PAIRED_AGENT_BENCHMARK_COMPLETION_SCHEMA_VERSION = '1.0.0' as const;
export const PAIRED_AGENT_BENCHMARK_COMPLETION_FILE = 'COMPLETE.json' as const;

const sha256Pattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const checksumLinePattern = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const requiredArtifacts = new Set([
  'attempts.ndjson',
  'comparison.json',
  'execution.json',
  'journal.ndjson',
  'summary.md',
]);

const markerSchema = z
  .object({
    schemaVersion: z.literal(PAIRED_AGENT_BENCHMARK_COMPLETION_SCHEMA_VERSION),
    state: z.literal('complete'),
    runId: z.string().regex(identifierPattern),
    protocolId: z.string().regex(identifierPattern),
    protocolSha256: z.string().regex(sha256Pattern),
    journalFinalEventSha256: z.string().regex(sha256Pattern),
    artifactManifestSha256: z.string().regex(sha256Pattern),
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

async function verifiedArtifactManifest(outputDirectory: string): Promise<string> {
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
  const artifactManifest = await verifiedArtifactManifest(outputDirectory);
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
  const artifactManifest = await verifiedArtifactManifest(outputDirectory);
  const marker = parsePairedAgentBenchmarkCompletionMarker({
    schemaVersion: PAIRED_AGENT_BENCHMARK_COMPLETION_SCHEMA_VERSION,
    state: 'complete',
    ...input,
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
