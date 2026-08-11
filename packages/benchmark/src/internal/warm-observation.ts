import type {
  BrowserIRRuntime,
  ObservationResult,
} from '@browserir/core';

import { runScenario, type ScenarioRunResult } from '../runner.js';

export interface WarmObservationTarget {
  id: string;
  path: string;
}

export type WarmObservationRuntime = Pick<
  BrowserIRRuntime,
  'navigate' | 'wait' | 'observe'
>;

export interface WarmObservationTargetOptions {
  target: WarmObservationTarget;
  runtime: WarmObservationRuntime;
  browserId: string;
  pageId: string;
  origin: string;
  current: ObservationResult;
  warmups: number;
  samples: number;
  maxCharacters: number;
  now?: () => number;
  onProgress?: (message: string) => void;
}

export interface WarmObservationTargetResult {
  result: ScenarioRunResult;
  current: ObservationResult;
}

/**
 * Prepare a target once, then time only repeated observations of the settled
 * document. This module is internal to the benchmark harness so tests can pin
 * the timing boundary without exposing dependency-injection hooks publicly.
 */
export async function runWarmObservationTarget(
  options: WarmObservationTargetOptions,
): Promise<WarmObservationTargetResult> {
  const {
    browserId,
    maxCharacters,
    onProgress,
    origin,
    pageId,
    runtime,
    samples,
    target,
    warmups,
  } = options;
  let current = options.current;

  onProgress?.(`${target.id}: navigating and settling once before timing`);
  current = await runtime.navigate({
    browserId,
    pageId,
    expectedRevision: current.view.revision,
    url: `${origin}${target.path}`,
    budget: { maxCharacters },
  });
  current = await runtime.wait({
    browserId,
    pageId,
    expectedRevision: current.view.revision,
    condition: { kind: 'settled' },
    timeoutMs: 10_000,
    pollIntervalMs: 25,
    budget: { maxCharacters },
  });

  const result = await runScenario({
    id: target.id,
    warmups,
    samples,
    ...(options.now === undefined ? {} : { now: options.now }),
    setup: (iteration, measured) => {
      onProgress?.(
        `${target.id}: ${measured ? 'sample' : 'warmup'} ${iteration + 1}/${warmups + samples}`,
      );
      return undefined;
    },
    run: async () => {
      current = await runtime.observe({
        browserId,
        pageId,
        budget: { maxCharacters },
      });
      const modelPayload = JSON.stringify({
        text: current.view.text,
        structured: current.view.structured,
      });
      return { payloadBytes: Buffer.byteLength(modelPayload, 'utf8') };
    },
    teardown: () => {},
  });

  return { result, current };
}
