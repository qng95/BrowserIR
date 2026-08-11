import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertPairedExecutionEnvironmentStable,
  collectPairedExecutionEnvironment,
  createPairedExecutionIntegrityBinding,
  parsePairedExecutionEnvironment,
  renderPairedExecutionEnvironment,
  type PairedExecutionEnvironment,
  type PairedExecutionEnvironmentCollectionOptions,
  type PairedExecutionIntegrityBinding,
} from './paired-environment.js';

export const PAIRED_EXECUTION_ENVIRONMENT_START_ARTIFACT =
  'environment-start.json' as const;
export const PAIRED_EXECUTION_ENVIRONMENT_END_ARTIFACT =
  'environment-end.json' as const;

export type PairedExecutionEnvironmentCollector = (
  options: PairedExecutionEnvironmentCollectionOptions,
) => Promise<PairedExecutionEnvironment>;

export interface PreparePairedExecutionEnvironmentStartOptions {
  outputDirectory: string;
  mode: 'create' | 'resume';
  collectionOptions: PairedExecutionEnvironmentCollectionOptions;
  collect?: PairedExecutionEnvironmentCollector | undefined;
}

export interface PreparedPairedExecutionEnvironmentStart {
  snapshot: PairedExecutionEnvironment;
  rendered: string;
}

const collectEnvironment = async (
  options: PairedExecutionEnvironmentCollectionOptions,
): Promise<PairedExecutionEnvironment> => collectPairedExecutionEnvironment(options);

const parseRetainedStart = (source: string): PairedExecutionEnvironment => {
  let raw: unknown;
  try {
    raw = JSON.parse(source) as unknown;
  } catch {
    throw new Error('Retained environment-start.json is not valid JSON.');
  }
  const snapshot = parsePairedExecutionEnvironment(raw);
  if (renderPairedExecutionEnvironment(snapshot) !== source) {
    throw new Error('Retained environment-start.json is not in canonical create-only form.');
  }
  return snapshot;
};

/**
 * Creates the immutable start snapshot for a new run, or validates the retained
 * snapshot against a freshly probed environment before a resumed attempt starts.
 */
export async function preparePairedExecutionEnvironmentStart(
  options: PreparePairedExecutionEnvironmentStartOptions,
): Promise<PreparedPairedExecutionEnvironmentStart> {
  const path = join(
    options.outputDirectory,
    PAIRED_EXECUTION_ENVIRONMENT_START_ARTIFACT,
  );
  const collect = options.collect ?? collectEnvironment;
  if (options.mode === 'create') {
    const snapshot = parsePairedExecutionEnvironment(
      await collect(options.collectionOptions),
    );
    const rendered = renderPairedExecutionEnvironment(snapshot);
    await writeFile(path, rendered, { encoding: 'utf8', flag: 'wx' });
    return { snapshot, rendered };
  }

  let retainedSource: string;
  try {
    retainedSource = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot resume without ${PAIRED_EXECUTION_ENVIRONMENT_START_ARTIFACT}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  // Parse the retained artifact before starting any live environment probes.
  const retained = parseRetainedStart(retainedSource);
  const current = parsePairedExecutionEnvironment(
    await collect(options.collectionOptions),
  );
  assertPairedExecutionEnvironmentStable(retained, current);
  return { snapshot: retained, rendered: retainedSource };
}

export interface CapturePairedExecutionEnvironmentEndOptions {
  start: PairedExecutionEnvironment;
  collectionOptions: PairedExecutionEnvironmentCollectionOptions;
  journalFinalEventSha256: string;
  collect?: PairedExecutionEnvironmentCollector | undefined;
}

export interface CapturedPairedExecutionEnvironmentEnd {
  end: PairedExecutionEnvironment;
  renderedStart: string;
  renderedEnd: string;
  binding: PairedExecutionIntegrityBinding;
}

/** Recaptures the environment after the completed journal and seals the binding. */
export async function capturePairedExecutionEnvironmentEnd(
  options: CapturePairedExecutionEnvironmentEndOptions,
): Promise<CapturedPairedExecutionEnvironmentEnd> {
  const collect = options.collect ?? collectEnvironment;
  const end = parsePairedExecutionEnvironment(
    await collect(options.collectionOptions),
  );
  const binding = createPairedExecutionIntegrityBinding(
    options.start,
    end,
    options.journalFinalEventSha256,
  );
  return {
    end,
    renderedStart: renderPairedExecutionEnvironment(options.start),
    renderedEnd: renderPairedExecutionEnvironment(end),
    binding,
  };
}
