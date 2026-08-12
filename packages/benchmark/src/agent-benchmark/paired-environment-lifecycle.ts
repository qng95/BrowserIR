import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertPairedExecutionEnvironmentStable,
  collectPairedExecutionEnvironment,
  createPairedExecutionIntegrityBinding,
  parsePairedExecutionEnvironment,
  parsePairedExecutionModelMetadata,
  renderPairedExecutionEnvironment,
  renderPairedExecutionModelMetadata,
  type PairedExecutionEnvironment,
  type PairedExecutionEnvironmentCollectionOptions,
  type PairedExecutionIntegrityBinding,
} from './paired-environment.js';

export const PAIRED_EXECUTION_ENVIRONMENT_START_ARTIFACT =
  'environment-start.json' as const;
export const PAIRED_EXECUTION_ENVIRONMENT_END_ARTIFACT =
  'environment-end.json' as const;
export const PAIRED_EXECUTION_MODEL_METADATA_START_ARTIFACT =
  'model-metadata-start.json' as const;
export const PAIRED_EXECUTION_MODEL_METADATA_END_ARTIFACT =
  'model-metadata-end.json' as const;

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
  renderedModelMetadata?: string | undefined;
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

const renderedModelMetadata = (
  snapshot: PairedExecutionEnvironment,
): string | undefined =>
  snapshot.model.provider === 'openai'
    ? undefined
    : renderPairedExecutionModelMetadata(snapshot);

const parseRetainedModelMetadata = (
  source: string,
  retainedEnvironment: PairedExecutionEnvironment,
): string => {
  let raw: unknown;
  try {
    raw = JSON.parse(source) as unknown;
  } catch {
    throw new Error(
      `${PAIRED_EXECUTION_MODEL_METADATA_START_ARTIFACT} is not valid JSON.`,
    );
  }
  const parsed = parsePairedExecutionModelMetadata(raw);
  const canonical = renderPairedExecutionModelMetadata(parsed);
  if (canonical !== source) {
    throw new Error(
      `${PAIRED_EXECUTION_MODEL_METADATA_START_ARTIFACT} is not in canonical create-only form.`,
    );
  }
  const expected = renderedModelMetadata(retainedEnvironment);
  if (expected === undefined || canonical !== expected) {
    throw new Error(
      `${PAIRED_EXECUTION_MODEL_METADATA_START_ARTIFACT} differs from environment-start.json.`,
    );
  }
  return canonical;
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
    const modelMetadata = renderedModelMetadata(snapshot);
    if (modelMetadata !== undefined) {
      await writeFile(
        join(
          options.outputDirectory,
          PAIRED_EXECUTION_MODEL_METADATA_START_ARTIFACT,
        ),
        modelMetadata,
        { encoding: 'utf8', flag: 'wx' },
      );
    }
    return {
      snapshot,
      rendered,
      ...(modelMetadata === undefined
        ? {}
        : { renderedModelMetadata: modelMetadata }),
    };
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
  let retainedModelMetadata: string | undefined;
  if (retained.model.provider !== 'openai') {
    let source: string;
    try {
      source = await readFile(
        join(
          options.outputDirectory,
          PAIRED_EXECUTION_MODEL_METADATA_START_ARTIFACT,
        ),
        'utf8',
      );
    } catch (error) {
      throw new Error(
        `Cannot resume without ${PAIRED_EXECUTION_MODEL_METADATA_START_ARTIFACT}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    retainedModelMetadata = parseRetainedModelMetadata(source, retained);
  }
  const current = parsePairedExecutionEnvironment(
    await collect(options.collectionOptions),
  );
  assertPairedExecutionEnvironmentStable(retained, current);
  return {
    snapshot: retained,
    rendered: retainedSource,
    ...(retainedModelMetadata === undefined
      ? {}
      : { renderedModelMetadata: retainedModelMetadata }),
  };
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
  renderedModelMetadataStart?: string | undefined;
  renderedModelMetadataEnd?: string | undefined;
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
    ...(options.start.model.provider === 'openai'
      ? {}
      : {
          renderedModelMetadataStart: renderPairedExecutionModelMetadata(
            options.start,
          ),
          renderedModelMetadataEnd: renderPairedExecutionModelMetadata(end),
        }),
    binding,
  };
}
