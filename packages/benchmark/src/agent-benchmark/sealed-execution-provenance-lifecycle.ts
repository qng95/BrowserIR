import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertSealedBuildProvenanceStable,
  collectUpliftBrowserIrBuildProvenance,
  parseSealedBuildProvenance,
  renderSealedBuildProvenance,
  type SealedBuildProvenance,
} from './sealed-execution-provenance.js';

export const SEALED_EXECUTION_BUILD_START_ARTIFACT =
  'build-provenance-start.json' as const;
export const SEALED_EXECUTION_BUILD_END_ARTIFACT =
  'build-provenance-end.json' as const;

export type SealedExecutionBuildCollector = () => Promise<SealedBuildProvenance>;

export interface PrepareSealedExecutionBuildStartOptions {
  outputDirectory: string;
  mode: 'create' | 'resume';
  collect?: SealedExecutionBuildCollector | undefined;
}

export interface PreparedSealedExecutionBuildStart {
  snapshot: SealedBuildProvenance;
  rendered: string;
}

const collectBuild = async (): Promise<SealedBuildProvenance> =>
  collectUpliftBrowserIrBuildProvenance();

const parseRetainedStart = (source: string): SealedBuildProvenance => {
  let raw: unknown;
  try {
    raw = JSON.parse(source) as unknown;
  } catch {
    throw new Error(
      `Retained ${SEALED_EXECUTION_BUILD_START_ARTIFACT} is not valid JSON.`,
    );
  }
  let snapshot: SealedBuildProvenance;
  try {
    snapshot = parseSealedBuildProvenance(raw);
  } catch (error) {
    throw new Error(
      `Retained ${SEALED_EXECUTION_BUILD_START_ARTIFACT} is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (renderSealedBuildProvenance(snapshot) !== source) {
    throw new Error(
      `Retained ${SEALED_EXECUTION_BUILD_START_ARTIFACT} is not in canonical create-only form.`,
    );
  }
  return snapshot;
};

/**
 * Creates the immutable executed-build snapshot, or validates a retained start
 * against the exact package bytes loaded by a resumed sealed run.
 */
export async function prepareSealedExecutionBuildStart(
  options: PrepareSealedExecutionBuildStartOptions,
): Promise<PreparedSealedExecutionBuildStart> {
  const path = join(options.outputDirectory, SEALED_EXECUTION_BUILD_START_ARTIFACT);
  const collect = options.collect ?? collectBuild;
  if (options.mode === 'create') {
    const snapshot = parseSealedBuildProvenance(await collect());
    const rendered = renderSealedBuildProvenance(snapshot);
    await writeFile(path, rendered, { encoding: 'utf8', flag: 'wx' });
    return { snapshot, rendered };
  }

  let retainedSource: string;
  try {
    retainedSource = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot resume without ${SEALED_EXECUTION_BUILD_START_ARTIFACT}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  // Validate retained bytes before probing the live build. A malformed retained
  // artifact must never be replaced by whatever happens to be on disk now.
  const retained = parseRetainedStart(retainedSource);
  const current = parseSealedBuildProvenance(await collect());
  assertSealedBuildProvenanceStable(retained, current);
  return { snapshot: retained, rendered: retainedSource };
}

export interface CaptureSealedExecutionBuildEndOptions {
  start: SealedBuildProvenance;
  collect?: SealedExecutionBuildCollector | undefined;
}

export interface CapturedSealedExecutionBuildEnd {
  end: SealedBuildProvenance;
  renderedStart: string;
  renderedEnd: string;
}

/** Recaptures and validates executable bytes after the durable run completes. */
export async function captureSealedExecutionBuildEnd(
  options: CaptureSealedExecutionBuildEndOptions,
): Promise<CapturedSealedExecutionBuildEnd> {
  const start = parseSealedBuildProvenance(options.start);
  const collect = options.collect ?? collectBuild;
  const end = parseSealedBuildProvenance(await collect());
  assertSealedBuildProvenanceStable(start, end);
  return {
    end,
    renderedStart: renderSealedBuildProvenance(start),
    renderedEnd: renderSealedBuildProvenance(end),
  };
}
