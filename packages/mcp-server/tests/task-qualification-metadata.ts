import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { createRequire } from 'node:module';

import {
  DEFAULT_SEED,
  CUSTOMER_COUNT,
  VEHICLE_COUNT,
} from '@think-dom/fixture-app';

import {
  environmentFingerprint,
  stableJson,
  type BenchmarkEnvironment,
} from '../../benchmark/src/environment.js';

import type { FixtureTaskQualificationResult } from './task-qualification-harness.js';

export const QUALIFICATION_FIXTURE_PROFILE = Object.freeze({
  seed: DEFAULT_SEED,
  customers: CUSTOMER_COUNT,
  vehicles: VEHICLE_COUNT,
  apiLatencyMs: 0,
  pageLatencyMs: 0,
});

export const QUALIFICATION_BROWSER_PROFILE = Object.freeze({
  engine: 'chromium',
  headless: true,
  viewport: Object.freeze({ width: 1440, height: 900 }),
  deviceScaleFactor: 1,
  locale: 'en-US',
  timezoneId: 'UTC',
  colorScheme: 'light',
  reducedMotion: 'reduce',
});

export const QUALIFICATION_PLANNER = Object.freeze({
  id: 'browserir-deterministic-reference-planner-v1',
  deterministic: true,
  allowedInterface: 'advertised MCP tools and BrowserIR opaque entity references',
  forbiddenInterfaces: Object.freeze([
    'selectors',
    'page evaluation',
    'database reads before grading',
  ]),
});

export interface AdvertisedToolSchema {
  name: string;
  inputSchema: unknown;
}

export interface QualificationEnvironment extends BenchmarkEnvironment {
  packages: {
    browserirCore: string;
    browserirPlaywright: string;
    browserirMcp: string;
    playwright: string;
    mcpClient: string;
    mcpServer: string;
  };
  fixture: typeof QUALIFICATION_FIXTURE_PROFILE;
  protocol: { mcp: string };
  planner: typeof QUALIFICATION_PLANNER;
  toolCatalog: {
    hashAlgorithm: 'sha256';
    status: 'verified' | 'partial' | 'unavailable' | 'inconsistent';
    sha256?: string | undefined;
    scope: 'advertised tool name and input schema';
    toolCount?: number | undefined;
    observedWorkers: number;
    totalWorkers: number;
    unsafeEvaluateEnabled: false;
  };
  source: {
    revision: string;
    dirty: boolean;
  };
}

export interface QualificationReproducibilityMetadata {
  startedAtUtc: string;
  completedAtUtc: string;
  durationMs: number;
  environmentFingerprint: string;
  environment: QualificationEnvironment;
}

const require = createRequire(import.meta.url);

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

const packageRootFromEntry = (entry: string, expectedName: string): string => {
  let current = dirname(entry);
  const root = parse(current).root;
  while (current !== root) {
    const manifestPath = join(current, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = readJson(manifestPath);
      if (manifest['name'] === expectedName) return current;
    }
    current = dirname(current);
  }
  throw new Error(`Could not locate package root for ${expectedName}.`);
};

const installedPackageVersion = (name: string): string => {
  const root = packageRootFromEntry(require.resolve(name), name);
  const version = readJson(join(root, 'package.json'))['version'];
  if (typeof version !== 'string' || version === '') {
    throw new Error(`Package ${name} does not advertise a version.`);
  }
  return version;
};

const workspacePackageVersion = (workspaceRoot: string, directory: string): string => {
  const version = readJson(resolve(workspaceRoot, directory, 'package.json'))['version'];
  if (typeof version !== 'string' || version === '') {
    throw new Error(`${directory} does not advertise a version.`);
  }
  return version;
};

const commandOutput = (
  command: string,
  args: readonly string[],
  cwd: string,
): string => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const optionalCommandOutput = (
  command: string,
  args: readonly string[],
  cwd: string,
): string | undefined => {
  try {
    return commandOutput(command, args, cwd);
  } catch {
    return undefined;
  }
};

export function collectSourceState(workspaceRoot: string): QualificationEnvironment['source'] {
  const revision = optionalCommandOutput(
    'git',
    ['rev-parse', '--verify', 'HEAD'],
    workspaceRoot,
  );
  const status = optionalCommandOutput(
    'git',
    ['status', '--porcelain', '--untracked-files=normal'],
    workspaceRoot,
  );
  return {
    revision: revision ?? 'unavailable',
    dirty: revision === undefined || status === undefined || status !== '',
  };
}

const chromiumVersion = (): string => {
  const playwrightRoot = packageRootFromEntry(require.resolve('playwright'), 'playwright');
  const playwrightRequire = createRequire(join(playwrightRoot, 'package.json'));
  const coreRoot = packageRootFromEntry(playwrightRequire.resolve('playwright-core'), 'playwright-core');
  const browsers = readJson(join(coreRoot, 'browsers.json'))['browsers'];
  if (!Array.isArray(browsers)) return 'unknown';
  const chromium = browsers.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === 'object' &&
      (candidate as Record<string, unknown>)['name'] === 'chromium',
  ) as Record<string, unknown> | undefined;
  const version = chromium?.['browserVersion'];
  return typeof version === 'string' && version !== '' ? version : 'unknown';
};

export function hashAdvertisedToolCatalog(
  tools: readonly AdvertisedToolSchema[],
): string {
  const names = new Set<string>();
  const catalog = tools
    .map((tool) => {
      if (names.has(tool.name)) throw new Error(`Duplicate advertised tool name: ${tool.name}.`);
      names.add(tool.name);
      return { name: tool.name, inputSchema: tool.inputSchema };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  return createHash('sha256').update(stableJson(catalog), 'utf8').digest('hex');
}

export function collectQualificationEnvironment(
  workspaceRoot: string,
  results: readonly FixtureTaskQualificationResult[],
): QualificationEnvironment {
  const catalogHashes = [
    ...new Set(
      results
        .map((result) => result.isolation.toolCatalogSha256)
        .filter((value): value is string => typeof value === 'string' && value !== ''),
    ),
  ];
  const toolCounts = [
    ...new Set(
      results
        .map((result) => result.isolation.toolCatalogToolCount)
        .filter(
          (value): value is number =>
            typeof value === 'number' && Number.isInteger(value) && value >= 0,
        ),
    ),
  ];
  const protocols = [...new Set(results.map((result) => result.isolation.protocolVersion))];
  const observedCatalogs = results.filter(
    (result) =>
      typeof result.isolation.toolCatalogSha256 === 'string' &&
      typeof result.isolation.toolCatalogToolCount === 'number',
  ).length;
  const catalogStatus =
    catalogHashes.length > 1 || toolCounts.length > 1
      ? 'inconsistent'
      : observedCatalogs === 0
        ? 'unavailable'
        : observedCatalogs < results.length
          ? 'partial'
          : 'verified';
  const protocol = protocols.length === 1 ? protocols[0]! : `inconsistent:${protocols.sort().join(',')}`;
  return {
    os: { platform: platform(), release: release(), arch: arch() },
    runtime: {
      node: process.version,
      pnpm: commandOutput('pnpm', ['--version'], workspaceRoot),
    },
    browser: {
      playwright: installedPackageVersion('playwright'),
      chromium: chromiumVersion(),
      headless: QUALIFICATION_BROWSER_PROFILE.headless,
    },
    profile: {
      viewport: `${QUALIFICATION_BROWSER_PROFILE.viewport.width}x${QUALIFICATION_BROWSER_PROFILE.viewport.height}`,
      deviceScaleFactor: QUALIFICATION_BROWSER_PROFILE.deviceScaleFactor,
      locale: QUALIFICATION_BROWSER_PROFILE.locale,
      timezoneId: QUALIFICATION_BROWSER_PROFILE.timezoneId,
      colorScheme: QUALIFICATION_BROWSER_PROFILE.colorScheme,
      reducedMotion: QUALIFICATION_BROWSER_PROFILE.reducedMotion,
    },
    packages: {
      browserirCore: workspacePackageVersion(workspaceRoot, 'packages/browser-ir'),
      browserirPlaywright: workspacePackageVersion(workspaceRoot, 'packages/playwright-driver'),
      browserirMcp: workspacePackageVersion(workspaceRoot, 'packages/mcp-server'),
      playwright: installedPackageVersion('playwright'),
      mcpClient: installedPackageVersion('@modelcontextprotocol/client'),
      mcpServer: installedPackageVersion('@modelcontextprotocol/server'),
    },
    fixture: QUALIFICATION_FIXTURE_PROFILE,
    protocol: { mcp: protocol },
    planner: QUALIFICATION_PLANNER,
    toolCatalog: {
      hashAlgorithm: 'sha256',
      status: catalogStatus,
      ...(catalogHashes.length === 1 ? { sha256: catalogHashes[0]! } : {}),
      scope: 'advertised tool name and input schema',
      ...(toolCounts.length === 1 ? { toolCount: toolCounts[0]! } : {}),
      observedWorkers: observedCatalogs,
      totalWorkers: results.length,
      unsafeEvaluateEnabled: false,
    },
    source: collectSourceState(workspaceRoot),
  };
}

export function createQualificationReproducibilityMetadata(input: {
  startedAtUtc: string;
  completedAtUtc: string;
  environment: QualificationEnvironment;
}): QualificationReproducibilityMetadata {
  const started = Date.parse(input.startedAtUtc);
  const completed = Date.parse(input.completedAtUtc);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    throw new Error('Qualification timestamps must be valid UTC instants in chronological order.');
  }
  return {
    startedAtUtc: new Date(started).toISOString(),
    completedAtUtc: new Date(completed).toISOString(),
    durationMs: completed - started,
    environmentFingerprint: environmentFingerprint(input.environment),
    environment: input.environment,
  };
}

export function qualificationEnvironmentFailures(
  environment: QualificationEnvironment,
  expectedProtocol = '2026-07-28',
): string[] {
  const failures: string[] = [];
  if (environment.toolCatalog.status !== 'verified') {
    failures.push(
      `Advertised tool catalog status is ${environment.toolCatalog.status}; expected verified.`,
    );
  }
  if (environment.protocol.mcp !== expectedProtocol) {
    failures.push(
      `Observed MCP protocol ${environment.protocol.mcp}; expected ${expectedProtocol}.`,
    );
  }
  return failures;
}
