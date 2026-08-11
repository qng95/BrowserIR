import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { arch, cpus, platform, release, totalmem } from 'node:os';

import { chromium } from 'playwright';

import type { BenchmarkEnvironment } from './environment.js';

const require = createRequire(import.meta.url);

function command(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unavailable';
  }
}

function playwrightVersion(): string {
  try {
    const manifest = require('playwright/package.json') as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function packageVersion(specifier: string): string {
  try {
    const manifest = require(specifier) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function collectBenchmarkEnvironment(
  headless: boolean,
  workload?: Readonly<Record<string, unknown>>,
): Promise<BenchmarkEnvironment> {
  const browser = await chromium.launch({ headless: true });
  let chromiumVersion: string;
  try {
    chromiumVersion = browser.version();
  } finally {
    await browser.close();
  }
  const processors = cpus();
  const dirty = command('git', ['status', '--porcelain']) !== '';
  return {
    os: { platform: platform(), release: release(), arch: arch() },
    runtime: {
      node: process.version,
      pnpm: command('pnpm', ['--version']),
    },
    browser: {
      playwright: playwrightVersion(),
      chromium: chromiumVersion,
      headless,
    },
    profile: {
      viewport: '1440x900',
      deviceScaleFactor: 1,
      colorScheme: 'light',
      reducedMotion: true,
      locale: 'en-US',
      timezone: 'UTC',
    },
    hardware: {
      cpuModel: processors[0]?.model ?? 'unknown',
      logicalCpus: processors.length,
      memoryBytes: totalmem(),
    },
    source: {
      revision: command('git', ['rev-parse', 'HEAD']),
      dirty,
      packages: {
        core: packageVersion('@browserir/core/package.json'),
        playwright: packageVersion('@browserir/playwright/package.json'),
      },
    },
    ...(workload === undefined ? {} : { workload: { ...workload } }),
  };
}
