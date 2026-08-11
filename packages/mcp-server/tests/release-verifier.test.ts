import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { releaseReadinessFailures } from '../../../scripts/verify-release.mjs';

const packageDefinitions = [
  {
    directory: 'packages/browser-ir',
    name: '@browserir/core',
    description: 'Browser-independent interaction representation and runtime for AI browser agents.',
    keywords: [
      'browserir',
      'browser-automation',
      'ai-agents',
      'interaction-representation',
      'accessibility',
    ],
    dependencies: {},
  },
  {
    directory: 'packages/playwright-driver',
    name: '@browserir/playwright',
    description: 'Playwright and Chromium observation and action backend for BrowserIR.',
    keywords: [
      'browserir',
      'playwright',
      'chromium',
      'browser-automation',
      'ai-agents',
    ],
    dependencies: {
      '@browserir/core': 'workspace:*',
      playwright: '1.62.0',
    },
  },
  {
    directory: 'packages/mcp-server',
    name: '@browserir/mcp',
    description: 'Local stdio Model Context Protocol server for BrowserIR browser automation.',
    keywords: [
      'browserir',
      'mcp',
      'model-context-protocol',
      'browser-automation',
      'ai-agents',
    ],
    dependencies: {
      '@browserir/core': 'workspace:*',
      '@browserir/playwright': 'workspace:*',
      '@modelcontextprotocol/server': '2.0.0',
      zod: '4.4.3',
    },
  },
] as const;

const temporaryRoots: string[] = [];

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function createReadyWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'browserir-release-ready-'));
  temporaryRoots.push(root);
  const license = 'MIT license fixture text.\n';
  const repositoryUrl = 'https://github.com/browserir/browserir.git';
  const homepage = 'https://github.com/browserir/browserir#readme';
  const bugs = { url: 'https://github.com/browserir/browserir/issues' };
  write(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'browserir-release-fixture',
        version: '0.1.0-alpha.1',
        private: true,
        license: 'MIT',
        repository: { type: 'git', url: repositoryUrl },
        homepage,
        bugs,
      },
      null,
      2,
    )}\n`,
  );
  write(join(root, 'README.md'), '# Test workspace\n');
  write(join(root, 'LICENSE'), license);

  for (const definition of packageDefinitions) {
    const directory = join(root, definition.directory);
    const manifest = {
      name: definition.name,
      version: '0.1.0-alpha.1',
      description: definition.description,
      keywords: definition.keywords,
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      files: ['dist'],
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
          default: './dist/index.js',
        },
        './package.json': './package.json',
      },
      engines: { node: '>=22.13.0' },
      scripts: {
        prebuild: 'node ../../scripts/clean-package-dist.mjs',
        build: 'tsc -p tsconfig.build.json',
        prepack: 'pnpm build',
      },
      license: 'MIT',
      repository: {
        type: 'git',
        url: repositoryUrl,
        directory: definition.directory,
      },
      homepage,
      bugs,
      publishConfig: { access: 'public' },
      ...(definition.name === '@browserir/mcp'
        ? { bin: { 'browserir-mcp': './dist/cli.js' } }
        : {}),
      dependencies: definition.dependencies,
    };
    write(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    write(join(directory, 'README.md'), `# ${definition.name}\n`);
    write(join(directory, 'LICENSE'), license);
    write(join(directory, 'src/index.ts'), 'export const ready = true;\n');
    write(join(directory, 'dist/index.js'), 'export const ready = true;\n');
    write(join(directory, 'dist/index.d.ts'), 'export declare const ready = true;\n');
    if (definition.name === '@browserir/mcp') {
      write(join(directory, 'src/cli.ts'), '#!/usr/bin/env node\n');
      write(join(directory, 'dist/cli.js'), '#!/usr/bin/env node\n');
      write(join(directory, 'dist/cli.d.ts'), 'export {};\n');
    }
  }
  return root;
}

function setLicenseExpression(root: string, expression: string): void {
  const manifestPaths = [
    join(root, 'package.json'),
    ...packageDefinitions.map((definition) =>
      join(root, definition.directory, 'package.json'),
    ),
  ];
  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    manifest.license = expression;
    write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('public release gate', () => {
  it('accepts a complete release fixture without depending on the current workspace blockers', () => {
    const root = createReadyWorkspace();

    expect(
      releaseReadinessFailures({
        root,
        inspectPackedArtifacts: false,
      }),
    ).toEqual([]);
  });

  it('reports legal, ownership, privacy, and package-license blockers in a blocked fixture', () => {
    const root = createReadyWorkspace();
    unlinkSync(join(root, 'LICENSE'));
    for (const definition of packageDefinitions) {
      const manifestPath = join(root, definition.directory, 'package.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest.private = true;
      delete manifest.license;
      delete manifest.repository;
      delete manifest.publishConfig;
      write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      unlinkSync(join(root, definition.directory, 'LICENSE'));
    }

    const failures = releaseReadinessFailures({
      root,
      inspectPackedArtifacts: false,
    });

    expect(failures).toContain('workspace: LICENSE is required before public release');
    expect(failures).toContain('@browserir/core: private must be removed before publishing');
    expect(failures).toContain('@browserir/core: publishConfig.access must be public');
    expect(failures).toContain('@browserir/core: a non-placeholder SPDX license expression is required');
    expect(failures).toContain(
      '@browserir/mcp: repository must match the canonical URL and package directory',
    );
    expect(failures).toContain('@browserir/mcp: package LICENSE is required in the published tarball');
  });

  it('rejects a package license that differs from the selected root license', () => {
    const root = createReadyWorkspace();
    write(join(root, 'packages/mcp-server/LICENSE'), 'Different license text.\n');

    expect(
      releaseReadinessFailures({
        root,
        inspectPackedArtifacts: false,
      }),
    ).toContain('@browserir/mcp: package LICENSE must match the workspace LICENSE');
  });

  it('rejects empty and placeholder legal declarations', () => {
    const root = createReadyWorkspace();
    write(join(root, 'LICENSE'), '  \n');
    const rootManifestPath = join(root, 'package.json');
    const rootManifest = JSON.parse(readFileSync(rootManifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    rootManifest.license = 'TEST-ONLY';
    write(rootManifestPath, `${JSON.stringify(rootManifest, null, 2)}\n`);

    const packageManifestPath = join(root, 'packages/mcp-server/package.json');
    const packageManifest = JSON.parse(readFileSync(packageManifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    packageManifest.license = 'TEST-ONLY';
    write(packageManifestPath, `${JSON.stringify(packageManifest, null, 2)}\n`);
    write(join(root, 'packages/mcp-server/LICENSE'), '\n');

    const failures = releaseReadinessFailures({
      root,
      inspectPackedArtifacts: false,
    });

    expect(failures).toContain('workspace: LICENSE must not be empty');
    expect(failures).toContain('workspace: a non-placeholder SPDX license expression is required');
    expect(failures).toContain(
      '@browserir/mcp: a non-placeholder SPDX license expression is required',
    );
    expect(failures).toContain('@browserir/mcp: package LICENSE must not be empty');
  });

  it('accepts a registered compound SPDX expression', () => {
    const root = createReadyWorkspace();
    setLicenseExpression(root, '(MIT OR Apache-2.0)');

    expect(
      releaseReadinessFailures({
        root,
        inspectPackedArtifacts: false,
      }),
    ).toEqual([]);
  });

  it.each([
    'FooBar',
    'MIT WITH MadeUp-exception',
    'LicenseRef-Proprietary',
    'DocumentRef-vendor:LicenseRef-custom',
  ])(
    'rejects an unregistered SPDX identifier or exception: %s',
    (expression) => {
      const root = createReadyWorkspace();
      setLicenseExpression(root, expression);

      const failures = releaseReadinessFailures({
        root,
        inspectPackedArtifacts: false,
      });

      expect(failures).toContain(
        'workspace: a non-placeholder SPDX license expression is required',
      );
      expect(failures).toContain(
        '@browserir/core: a non-placeholder SPDX license expression is required',
      );
    },
  );

  it('rejects any public private flag, extra export, or install lifecycle hook', () => {
    const root = createReadyWorkspace();
    const manifestPath = join(root, 'packages/mcp-server/package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      private?: boolean;
      exports: Record<string, unknown>;
      scripts: Record<string, string>;
    };
    manifest.private = false;
    manifest.exports['./internal'] = './dist/internal.js';
    manifest.scripts.postinstall = 'node unexpected.js';
    manifest.scripts.postbuild = 'node exfiltrate.js';
    manifest.scripts.prepublishOnly = 'node exfiltrate.js';
    write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const failures = releaseReadinessFailures({
      root,
      inspectPackedArtifacts: false,
    });

    expect(failures).toContain('@browserir/mcp: private must be removed before publishing');
    expect(failures).toContain(
      '@browserir/mcp: exports must expose ESM, declarations, and package.json only',
    );
    expect(failures).toContain(
      '@browserir/mcp: postinstall lifecycle script is not allowed in a public package',
    );
    expect(failures).toContain(
      '@browserir/mcp: prepublishOnly lifecycle script is not allowed in a public package',
    );
    expect(failures).toContain(
      '@browserir/mcp: postbuild lifecycle script is not allowed in a public package',
    );
  });

  it('requires package repository, homepage, and issue metadata to match the workspace', () => {
    const root = createReadyWorkspace();
    const manifestPath = join(root, 'packages/mcp-server/package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.repository = {
      type: 'git',
      url: 'https://github.com/browserir/browserir.git',
      directory: 'packages/browser-ir',
    };
    manifest.homepage = 'https://example.com/other';
    manifest.bugs = { url: 'https://example.com/issues' };
    write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const failures = releaseReadinessFailures({
      root,
      inspectPackedArtifacts: false,
    });

    expect(failures).toContain(
      '@browserir/mcp: repository must match the canonical URL and package directory',
    );
    expect(failures).toContain(
      '@browserir/mcp: homepage must match the canonical workspace homepage',
    );
    expect(failures).toContain(
      '@browserir/mcp: bugs must match the canonical workspace issue URL',
    );
  });

  it('rejects invalid or inconsistent release versions without forcing a stable version', () => {
    const root = createReadyWorkspace();
    const rootManifestPath = join(root, 'package.json');
    const rootManifest = JSON.parse(readFileSync(rootManifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    rootManifest.version = '0.1.0-alpha.01';
    write(rootManifestPath, `${JSON.stringify(rootManifest, null, 2)}\n`);

    const mcpManifestPath = join(root, 'packages/mcp-server/package.json');
    const mcpManifest = JSON.parse(readFileSync(mcpManifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    mcpManifest.version = '0.1.0';
    write(mcpManifestPath, `${JSON.stringify(mcpManifest, null, 2)}\n`);

    const failures = releaseReadinessFailures({
      root,
      inspectPackedArtifacts: false,
    });

    expect(failures).toContain('workspace: root package version must be valid SemVer');
    expect(failures).toContain(
      '@browserir/mcp: version must match workspace version 0.1.0-alpha.01',
    );
  });

  it('requires the workspace root and every non-release package to remain private', () => {
    const root = createReadyWorkspace();
    const rootManifestPath = join(root, 'package.json');
    const rootManifest = JSON.parse(readFileSync(rootManifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    rootManifest.private = false;
    write(rootManifestPath, `${JSON.stringify(rootManifest, null, 2)}\n`);
    write(
      join(root, 'packages/benchmark/package.json'),
      `${JSON.stringify({ name: '@browserir/benchmark', private: false }, null, 2)}\n`,
    );

    const failures = releaseReadinessFailures({
      root,
      inspectPackedArtifacts: false,
    });

    expect(failures).toContain('workspace: root package must remain private');
    expect(failures).toContain(
      '@browserir/benchmark: non-release workspace package must remain private',
    );
  });

  it('rejects runtime dependency range drift and hidden dependency channels', () => {
    const root = createReadyWorkspace();
    const manifestPath = join(root, 'packages/mcp-server/package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    manifest.dependencies['@browserir/core'] = '^0.1.0';
    manifest.peerDependencies = { playwright: '^1.62.0' };
    write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const failures = releaseReadinessFailures({
      root,
      inspectPackedArtifacts: false,
    });

    expect(failures).toContain(
      '@browserir/mcp: dependency @browserir/core must use workspace:*; found ^0.1.0',
    );
    expect(failures).toContain(
      '@browserir/mcp: peerDependencies is not allowed in the 0.1 public package boundary',
    );
  });
});
