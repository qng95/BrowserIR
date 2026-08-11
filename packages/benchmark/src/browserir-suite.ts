import {
  BrowserIRRuntime,
  type BrowserAction,
  type BrowserCreateOptions,
  type ObservationResult,
} from '@browserir/core';
import { createPlaywrightBrowserDriver } from '@browserir/playwright';
import { startAppServer } from '@think-dom/fixture-app';

import { runWarmObservationTarget } from './internal/warm-observation.js';
import type { ScenarioRunResult } from './runner.js';

export interface ObservationTarget {
  id: string;
  path: string;
}

export const BROWSERIR_OBSERVATION_METHODOLOGY = 'warm-steady-state' as const;

export const BROWSERIR_OBSERVATION_TARGETS: readonly ObservationTarget[] = [
  { id: 'observe-warm/customers-5000', path: '/app/customers' },
  { id: 'observe-warm/vehicles-12000-virtualized', path: '/app/vehicles' },
  { id: 'observe-warm/orders-draft-table', path: '/app/orders?status=Draft' },
  { id: 'observe-warm/workshop-spatial-grid', path: '/app/workshop' },
  { id: 'observe-warm/parts-master-detail', path: '/app/parts' },
  { id: 'observe-warm/query-builder', path: '/app/reports/query' },
  { id: 'observe-warm/staged-dashboard', path: '/app/dashboard' },
];

export interface BrowserIrObservationSuiteOptions {
  warmups?: number;
  samples?: number;
  maxCharacters?: number;
  headless?: boolean;
  targets?: readonly ObservationTarget[];
  onProgress?: (message: string) => void;
}

const DEFAULT_PROFILE: BrowserCreateOptions = {
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: 'light',
  reducedMotion: 'reduce',
  locale: 'en-US',
  timezoneId: 'UTC',
};

const nonNegativeInteger = (value: number, label: string): number => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
};

const positiveInteger = (value: number, label: string): number => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
};

function namedTarget(
  observation: ObservationResult,
  name: string,
  capability: string,
) {
  const matches = observation.view.structured.entities.filter(
    (entity) =>
      entity.name === name &&
      entity.capabilities.some(
        (candidate) => candidate.kind === capability && candidate.enabled,
      ),
  );
  const rolePreferred =
    capability === 'click'
      ? matches.filter((entity) => entity.role === 'button')
      : matches;
  const resolved = rolePreferred.length === 1 ? rolePreferred : matches;
  if (resolved.length !== 1) {
    throw new Error(
      `Expected one enabled ${capability} target named ${JSON.stringify(name)}, found ${matches.length}: ${matches.map((entity) => `${entity.kind}/${entity.role ?? 'no-role'}/${entity.ref.entityId}`).join(', ')}.`,
    );
  }
  return resolved[0]!.ref;
}

async function actAndObserve(
  runtime: BrowserIRRuntime,
  browserId: string,
  current: ObservationResult,
  action: BrowserAction,
): Promise<ObservationResult> {
  const receipt = await runtime.act({
    browserId,
    pageId: current.view.pageId,
    expectedRevision: current.view.revision,
    action,
    budget: { maxCharacters: 16_000 },
  });
  if (!receipt.dispatched) {
    throw new Error(
      `Benchmark setup action ${action.kind} was blocked: ${receipt.error?.code ?? receipt.status}.`,
    );
  }
  return (
    receipt.observation ??
    runtime.observe({ browserId, pageId: current.view.pageId })
  );
}

async function signIn(
  runtime: BrowserIRRuntime,
  browserId: string,
  origin: string,
): Promise<ObservationResult> {
  let current = await runtime.navigate({
    browserId,
    expectedRevision: 0,
    url: `${origin}/app/login`,
    budget: { maxCharacters: 16_000 },
  });
  current = await actAndObserve(runtime, browserId, current, {
    kind: 'fill',
    target: namedTarget(current, 'Username', 'fill'),
    value: 'test',
  });
  current = await actAndObserve(runtime, browserId, current, {
    kind: 'fill',
    target: namedTarget(current, 'Password', 'fill'),
    value: 'test',
  });
  current = await actAndObserve(runtime, browserId, current, {
    kind: 'click',
    target: namedTarget(current, 'Sign in', 'click'),
  });
  if (!current.view.structured.page.url.includes('/app/')) {
    throw new Error(`Benchmark sign-in did not reach an application page: ${current.view.structured.page.url}.`);
  }
  return current;
}

function validateTargets(targets: readonly ObservationTarget[]): void {
  const ids = new Set<string>();
  for (const target of targets) {
    if (target.id.trim() === '') throw new Error('Observation target IDs must not be empty.');
    if (ids.has(target.id)) throw new Error(`Duplicate observation target ID: ${target.id}.`);
    if (!target.path.startsWith('/')) {
      throw new Error(`Observation target ${target.id} must use an origin-relative path.`);
    }
    ids.add(target.id);
  }
}

export async function runBrowserIrObservationSuite(
  options: BrowserIrObservationSuiteOptions = {},
): Promise<ScenarioRunResult[]> {
  const warmups = nonNegativeInteger(options.warmups ?? 5, 'warmups');
  const samples = positiveInteger(options.samples ?? 100, 'samples');
  const maxCharacters = positiveInteger(options.maxCharacters ?? 16_000, 'maxCharacters');
  const targets = options.targets ?? BROWSERIR_OBSERVATION_TARGETS;
  validateTargets(targets);

  const app = await startAppServer({ apiLatencyMs: 0, pageLatencyMs: 0 });
  const results: ScenarioRunResult[] = [];
  try {
    for (const target of targets) {
      options.onProgress?.(`${target.id}: creating isolated browser session`);
      const runtime = new BrowserIRRuntime(
        createPlaywrightBrowserDriver({ headless: options.headless ?? true }),
      );
      const created = await runtime.create(DEFAULT_PROFILE);
      const current = await signIn(runtime, created.browserId, app.origin);
      try {
        const targetRun = await runWarmObservationTarget({
          target,
          runtime,
          browserId: created.browserId,
          pageId: created.initialPageId,
          origin: app.origin,
          current,
          warmups,
          samples,
          maxCharacters,
          ...(options.onProgress === undefined
            ? {}
            : { onProgress: options.onProgress }),
        });
        results.push(targetRun.result);
      } finally {
        await runtime.close({ browserId: created.browserId }).catch(() => {});
      }
    }
  } finally {
    await app.close();
  }
  return results;
}
