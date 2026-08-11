import type { ScenarioSample } from './schema.js';

export interface ScenarioRunMeasurement {
  payloadBytes?: number;
  metrics?: Readonly<Record<string, number>>;
}

export interface ScenarioDefinition<State> {
  id: string;
  warmups: number;
  samples: number;
  now?: () => number;
  setup(iteration: number, measured: boolean): Promise<State> | State;
  run(state: State): Promise<ScenarioRunMeasurement | void> | ScenarioRunMeasurement | void;
  teardown(state: State, measured: boolean): Promise<void> | void;
}

export interface ScenarioRunResult {
  id: string;
  warmups: number;
  samples: ScenarioSample[];
}

const nonNegativeInteger = (value: number, label: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
};

export async function runScenario<State>(
  definition: ScenarioDefinition<State>,
): Promise<ScenarioRunResult> {
  nonNegativeInteger(definition.warmups, 'warmups');
  if (!Number.isInteger(definition.samples) || definition.samples < 1) {
    throw new Error('samples must be a positive integer.');
  }
  const now = definition.now ?? (() => performance.now());
  const measuredSamples: ScenarioSample[] = [];
  const total = definition.warmups + definition.samples;

  for (let absoluteIteration = 0; absoluteIteration < total; absoluteIteration += 1) {
    const measured = absoluteIteration >= definition.warmups;
    let state: State | undefined;
    try {
      state = await definition.setup(absoluteIteration, measured);
      const startedAt = now();
      const measurement = await definition.run(state);
      const durationMs = now() - startedAt;
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        throw new Error('The benchmark clock returned an invalid duration.');
      }
      if (measured) {
        measuredSamples.push({
          scenarioId: definition.id,
          iteration: absoluteIteration - definition.warmups,
          durationMs,
          ...(measurement?.payloadBytes === undefined
            ? {}
            : { payloadBytes: measurement.payloadBytes }),
          ...(measurement?.metrics === undefined
            ? {}
            : { metrics: { ...measurement.metrics } }),
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Benchmark scenario ${definition.id} failed: ${detail}`, {
        cause: error,
      });
    } finally {
      if (state !== undefined) await definition.teardown(state, measured);
    }
  }

  return {
    id: definition.id,
    warmups: definition.warmups,
    samples: measuredSamples,
  };
}
