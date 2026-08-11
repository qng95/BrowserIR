import { createHash } from 'node:crypto';

export interface BenchmarkEnvironment {
  os: {
    platform: string;
    release: string;
    arch: string;
    [key: string]: string | number | boolean | undefined;
  };
  runtime: {
    node: string;
    pnpm: string;
    [key: string]: string | number | boolean | undefined;
  };
  browser: {
    playwright: string;
    chromium: string;
    headless: boolean;
    [key: string]: string | number | boolean | undefined;
  };
  profile: {
    viewport: string;
    deviceScaleFactor: number;
    [key: string]: string | number | boolean | undefined;
  };
  [key: string]: unknown;
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Environment metadata cannot contain non-finite numbers.');
  }
  return value;
};

export const stableJson = (value: unknown): string =>
  JSON.stringify(canonical(value));

export const environmentFingerprint = (
  environment: BenchmarkEnvironment,
): string => {
  // Source provenance must remain in environment.json, but a candidate build
  // necessarily has a different revision from its baseline. Hash only the
  // execution conditions so regression comparison remains possible.
  const { source: _source, ...executionEnvironment } = environment;
  return createHash('sha256')
    .update(stableJson(executionEnvironment), 'utf8')
    .digest('hex');
};
