import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BROWSERIR_VERSION } from '../src/version.js';

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const workspaceManifest = JSON.parse(
  readFileSync(resolve(workspaceRoot, 'package.json'), 'utf8'),
) as { version: string };
const packageDirectories = [
  'packages/browser-ir',
  'packages/playwright-driver',
  'packages/mcp-server',
] as const;

const expectedPackPaths: Record<(typeof packageDirectories)[number], string[]> = {
  'packages/browser-ir': [
    'README.md',
    'dist/compiler.d.ts',
    'dist/compiler.js',
    'dist/index.d.ts',
    'dist/index.js',
    'dist/limits.d.ts',
    'dist/limits.js',
    'dist/runtime.d.ts',
    'dist/runtime.js',
    'dist/types.d.ts',
    'dist/types.js',
    'dist/url.d.ts',
    'dist/url.js',
    'package.json',
  ],
  'packages/playwright-driver': [
    'README.md',
    'dist/index.d.ts',
    'dist/index.js',
    'dist/ordered-concurrency.d.ts',
    'dist/ordered-concurrency.js',
    'dist/unsafe-evaluate.d.ts',
    'dist/unsafe-evaluate.js',
    'package.json',
  ],
  'packages/mcp-server': [
    'README.md',
    'dist/cli-options.d.ts',
    'dist/cli-options.js',
    'dist/cli.d.ts',
    'dist/cli.js',
    'dist/index.d.ts',
    'dist/index.js',
    'dist/runtime-service.d.ts',
    'dist/runtime-service.js',
    'dist/schemas.d.ts',
    'dist/schemas.js',
    'dist/server.d.ts',
    'dist/server.js',
    'dist/stdio.d.ts',
    'dist/stdio.js',
    'dist/types.d.ts',
    'dist/types.js',
    'dist/unsafe-evaluate.d.ts',
    'dist/unsafe-evaluate.js',
    'dist/version.d.ts',
    'dist/version.js',
    'package.json',
  ],
};

const expectedRuntimeDependencies: Record<
  (typeof packageDirectories)[number],
  Record<string, string>
> = {
  'packages/browser-ir': {},
  'packages/playwright-driver': {
    '@browserir/core': 'workspace:*',
    playwright: '1.62.0',
  },
  'packages/mcp-server': {
    '@browserir/core': 'workspace:*',
    '@browserir/playwright': 'workspace:*',
    '@modelcontextprotocol/server': '2.0.0',
    zod: '4.4.3',
  },
};

const expectedDiscoveryMetadata: Record<
  (typeof packageDirectories)[number],
  { description: string; keywords: string[] }
> = {
  'packages/browser-ir': {
    description: 'Browser-independent interaction representation and runtime for AI browser agents.',
    keywords: [
      'browserir',
      'browser-automation',
      'ai-agents',
      'interaction-representation',
      'accessibility',
    ],
  },
  'packages/playwright-driver': {
    description: 'Playwright and Chromium observation and action backend for BrowserIR.',
    keywords: ['browserir', 'playwright', 'chromium', 'browser-automation', 'ai-agents'],
  },
  'packages/mcp-server': {
    description: 'Local stdio Model Context Protocol server for BrowserIR browser automation.',
    keywords: [
      'browserir',
      'mcp',
      'model-context-protocol',
      'browser-automation',
      'ai-agents',
    ],
  },
};

type PackageManifest = {
  name: string;
  version: string;
  description?: string;
  keywords?: string[];
  private?: boolean;
  engines?: { node?: string };
  files?: string[];
  main?: string;
  types?: string;
  exports?: Record<string, unknown>;
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

function manifest(directory: (typeof packageDirectories)[number]): PackageManifest {
  return JSON.parse(
    readFileSync(resolve(workspaceRoot, directory, 'package.json'), 'utf8'),
  ) as PackageManifest;
}

describe('release package contract', () => {
  it.each(packageDirectories)('%s builds ESM and declarations from an allowlisted dist', (directory) => {
    const packageJson = manifest(directory);

    expect(packageJson.version).toBe(workspaceManifest.version);
    expect({
      description: packageJson.description,
      keywords: packageJson.keywords,
    }).toEqual(expectedDiscoveryMetadata[directory]);
    expect(packageJson.engines?.node).toBe('>=22.13.0');
    expect(packageJson.files).toEqual(['dist']);
    expect(packageJson.scripts?.build).toBeTruthy();
    expect(packageJson.scripts?.prebuild).toBe('node ../../scripts/clean-package-dist.mjs');
    expect(packageJson.scripts?.prepack).toBe('pnpm build');
    expect(packageJson.main).toBe('./dist/index.js');
    expect(packageJson.types).toBe('./dist/index.d.ts');
    expect(packageJson.exports).toEqual({
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
        default: './dist/index.js',
      },
      './package.json': './package.json',
    });
    expect(() => readFileSync(resolve(workspaceRoot, directory, 'dist/index.js'))).not.toThrow();
    expect(() => readFileSync(resolve(workspaceRoot, directory, 'dist/index.d.ts'))).not.toThrow();
    expect(() => readFileSync(resolve(workspaceRoot, directory, 'README.md'))).not.toThrow();
    expect(packageJson.dependencies ?? {}).toEqual(expectedRuntimeDependencies[directory]);
    expect(packageJson.optionalDependencies).toBeUndefined();
    expect(packageJson.peerDependencies).toBeUndefined();
  });

  it('ships the MCP stdio executable and Playwright backend as production code', () => {
    const packageJson = manifest('packages/mcp-server');

    expect(BROWSERIR_VERSION).toBe(packageJson.version);
    expect(BROWSERIR_VERSION).toBe(workspaceManifest.version);
    expect(packageJson.bin).toEqual({ 'browserir-mcp': './dist/cli.js' });
    expect(packageJson.dependencies?.['@browserir/playwright']).toBe('workspace:*');
    expect(() => readFileSync(resolve(workspaceRoot, 'packages/mcp-server/dist/cli.js'))).not.toThrow();
  });

  it.each(packageDirectories)('%s has an exact documented packlist without source maps', (directory) => {
    const output = execFileSync(
      'pnpm',
      ['--config.ignore-scripts=true', 'pack', '--dry-run', '--json'],
      {
      cwd: resolve(workspaceRoot, directory),
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 120_000,
      },
    );
    const jsonStart = Math.max(0, output.lastIndexOf('\n{') + 1);
    const packed = JSON.parse(output.slice(jsonStart)) as {
      files: Array<{ path: string }>;
    };
    const paths = packed.files.map((file) => file.path).sort();

    const expectedPaths = [
      ...expectedPackPaths[directory],
      ...(existsSync(resolve(workspaceRoot, directory, 'LICENSE')) ? ['LICENSE'] : []),
    ];
    expect(paths).toEqual(expectedPaths.sort());
    expect(paths.some((path) => path.endsWith('.map'))).toBe(false);
  });
});
