import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path';

import { chromium } from 'playwright';

const brokerRequire = createRequire(
  new URL('./playwright-mcp-broker.js', import.meta.url),
);
const mcpManifestPath = brokerRequire.resolve('@playwright/mcp/package.json');
const mcpPackageDirectory = dirname(mcpManifestPath);
const mcpRuntimeRequire = createRequire(join(mcpPackageDirectory, 'cli.js'));
const mcpManifest = brokerRequire('@playwright/mcp/package.json') as {
  name?: unknown;
  version?: unknown;
};

function packageDirectoryFromEntry(entryPath: string, expectedName: string): string {
  const root = parse(entryPath).root;
  let directory = dirname(entryPath);
  while (directory !== root) {
    const manifestPath = join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
      } catch {
        throw new Error(`Runtime package manifest is invalid JSON for ${expectedName}.`);
      }
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>)['name'] === expectedName
      ) {
        return directory;
      }
    }
    directory = dirname(directory);
  }
  throw new Error(`Cannot resolve the runtime package root for ${expectedName}.`);
}

const mcpClientEntryPaths = [
  brokerRequire.resolve('@modelcontextprotocol/client'),
  brokerRequire.resolve('@modelcontextprotocol/client/stdio'),
];
const mcpClientPackageDirectory = packageDirectoryFromEntry(
  mcpClientEntryPaths[0]!,
  '@modelcontextprotocol/client',
);
if (
  mcpClientEntryPaths.some((entryPath) => {
    const relativePath = relative(mcpClientPackageDirectory, entryPath);
    return (
      relativePath.length === 0 ||
      isAbsolute(relativePath) ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`)
    );
  })
) {
  throw new Error('The Playwright MCP broker client imports resolve outside one package root.');
}

if (mcpManifest.name !== '@playwright/mcp' || typeof mcpManifest.version !== 'string') {
  throw new Error('The resolved official Playwright MCP manifest is invalid.');
}

export const PLAYWRIGHT_MCP_VERSION = mcpManifest.version;

export const PLAYWRIGHT_MCP_RUNTIME_PACKAGE_NAMES = [
  '@modelcontextprotocol/client',
  '@playwright/mcp',
  'playwright',
  'playwright-core',
] as const;

export interface PlaywrightMcpRuntimePackageInput {
  name: (typeof PLAYWRIGHT_MCP_RUNTIME_PACKAGE_NAMES)[number];
  packageDirectory: string;
}

interface ProbedBrowser {
  version(): string;
  close(): Promise<void>;
}

interface PlaywrightRuntime {
  chromium: {
    launch(options: {
      headless: boolean;
      executablePath: string;
    }): Promise<ProbedBrowser>;
  };
}

/** The exact Chromium path passed by the benchmark broker to the MCP child. */
export const playwrightMcpChromiumExecutablePath = (): string =>
  chromium.executablePath();

/** Resolve exact packages loaded by the broker and the spawned MCP child. */
export function resolvePlaywrightMcpRuntimePackageInputs(): PlaywrightMcpRuntimePackageInput[] {
  return [
    {
      name: '@modelcontextprotocol/client',
      packageDirectory: mcpClientPackageDirectory,
    },
    { name: '@playwright/mcp', packageDirectory: mcpPackageDirectory },
    {
      name: 'playwright',
      packageDirectory: dirname(mcpRuntimeRequire.resolve('playwright/package.json')),
    },
    {
      name: 'playwright-core',
      packageDirectory: dirname(mcpRuntimeRequire.resolve('playwright-core/package.json')),
    },
  ];
}

/** Launch the selected binary through the same Playwright runtime used by the MCP child. */
export async function probePlaywrightMcpChromiumVersion(
  executablePath: string,
): Promise<string> {
  const runtime = mcpRuntimeRequire('playwright') as PlaywrightRuntime;
  const browser = await runtime.chromium.launch({ headless: true, executablePath });
  try {
    return browser.version();
  } finally {
    await browser.close();
  }
}
