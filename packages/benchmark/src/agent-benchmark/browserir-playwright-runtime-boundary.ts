import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const brokerRequire = createRequire(new URL('./mcp-broker.js', import.meta.url));
const driverManifestPath = brokerRequire.resolve('@browserir/playwright/package.json');
const driverRequire = createRequire(driverManifestPath);
const playwrightManifestPath = driverRequire.resolve('playwright/package.json');
const playwrightRequire = createRequire(playwrightManifestPath);

export const BROWSERIR_PLAYWRIGHT_RUNTIME_PACKAGE_NAMES = [
  'playwright',
  'playwright-core',
] as const;

export interface BrowserIrPlaywrightRuntimePackageInput {
  name: (typeof BROWSERIR_PLAYWRIGHT_RUNTIME_PACKAGE_NAMES)[number];
  packageDirectory: string;
}

interface ProbedBrowser {
  version(): string;
  close(): Promise<void>;
}

interface PlaywrightRuntime {
  chromium: {
    executablePath(): string;
    launch(options: {
      headless: boolean;
      executablePath: string;
    }): Promise<ProbedBrowser>;
  };
}

/** Resolve the Playwright packages loaded by BrowserIR's actual driver import boundary. */
export function resolveBrowserIrPlaywrightRuntimePackageInputs(): BrowserIrPlaywrightRuntimePackageInput[] {
  return [
    { name: 'playwright', packageDirectory: dirname(playwrightManifestPath) },
    {
      name: 'playwright-core',
      packageDirectory: dirname(playwrightRequire.resolve('playwright-core/package.json')),
    },
  ];
}

/** The Chromium binary selected by BrowserIR's Playwright backend. */
export const browserIrPlaywrightChromiumExecutablePath = (): string =>
  (driverRequire('playwright') as PlaywrightRuntime).chromium.executablePath();

/** Launch the selected binary through the same Playwright runtime as BrowserIR. */
export async function probeBrowserIrPlaywrightChromiumVersion(
  executablePath: string,
): Promise<string> {
  const runtime = driverRequire('playwright') as PlaywrightRuntime;
  const browser = await runtime.chromium.launch({ headless: true, executablePath });
  try {
    return browser.version();
  } finally {
    await browser.close();
  }
}
