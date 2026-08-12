import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertPairedRuntimeProvenanceStable,
  collectPairedUpliftRuntimeProvenance,
  parsePairedRuntimeProvenance,
  renderPairedRuntimeProvenance,
  type PairedRuntimeProvenance,
} from './paired-runtime-provenance.js';

export const PAIRED_RUNTIME_PROVENANCE_START_ARTIFACT =
  'runtime-provenance-start.json' as const;
export const PAIRED_RUNTIME_PROVENANCE_END_ARTIFACT =
  'runtime-provenance-end.json' as const;

export type PairedRuntimeProvenanceCollector = () => Promise<PairedRuntimeProvenance>;

export interface PreparePairedRuntimeProvenanceStartOptions {
  outputDirectory: string;
  mode: 'create' | 'resume';
  collect?: PairedRuntimeProvenanceCollector | undefined;
}

export interface PreparedPairedRuntimeProvenanceStart {
  snapshot: PairedRuntimeProvenance;
  rendered: string;
}

const parseRetainedStart = (source: string): PairedRuntimeProvenance => {
  let raw: unknown;
  try {
    raw = JSON.parse(source) as unknown;
  } catch {
    throw new Error(`${PAIRED_RUNTIME_PROVENANCE_START_ARTIFACT} is not valid JSON.`);
  }
  const parsed = parsePairedRuntimeProvenance(raw);
  if (renderPairedRuntimeProvenance(parsed) !== source) {
    throw new Error(
      `${PAIRED_RUNTIME_PROVENANCE_START_ARTIFACT} is not in canonical create-only form.`,
    );
  }
  return parsed;
};

/** Creates or verifies both role-specific installed runtime start snapshots. */
export async function preparePairedRuntimeProvenanceStart(
  options: PreparePairedRuntimeProvenanceStartOptions,
): Promise<PreparedPairedRuntimeProvenanceStart> {
  const path = join(options.outputDirectory, PAIRED_RUNTIME_PROVENANCE_START_ARTIFACT);
  const collect = options.collect ?? collectPairedUpliftRuntimeProvenance;
  if (options.mode === 'create') {
    const snapshot = parsePairedRuntimeProvenance(await collect());
    const rendered = renderPairedRuntimeProvenance(snapshot);
    await writeFile(path, rendered, { encoding: 'utf8', flag: 'wx' });
    return { snapshot, rendered };
  }

  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot resume without ${PAIRED_RUNTIME_PROVENANCE_START_ARTIFACT}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Parse retained evidence before any live package or browser probe.
  const retained = parseRetainedStart(source);
  const current = parsePairedRuntimeProvenance(await collect());
  assertPairedRuntimeProvenanceStable(retained, current);
  return { snapshot: retained, rendered: source };
}

export interface CapturePairedRuntimeProvenanceEndOptions {
  start: PairedRuntimeProvenance;
  collect?: PairedRuntimeProvenanceCollector | undefined;
}

export interface CapturedPairedRuntimeProvenanceEnd {
  end: PairedRuntimeProvenance;
  renderedStart: string;
  renderedEnd: string;
}

/** Recaptures and verifies both installed arm runtimes after the durable journal. */
export async function capturePairedRuntimeProvenanceEnd(
  options: CapturePairedRuntimeProvenanceEndOptions,
): Promise<CapturedPairedRuntimeProvenanceEnd> {
  const collect = options.collect ?? collectPairedUpliftRuntimeProvenance;
  const end = parsePairedRuntimeProvenance(await collect());
  assertPairedRuntimeProvenanceStable(options.start, end);
  return {
    end,
    renderedStart: renderPairedRuntimeProvenance(options.start),
    renderedEnd: renderPairedRuntimeProvenance(end),
  };
}
