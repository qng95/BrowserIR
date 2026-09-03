import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  expectedDistPaths,
  expectedPackPaths,
  manifestFailures,
} from './verify-browserir-release.mjs';

const rootManifest = { version: '0.1.0', license: 'Apache-2.0' };
const validManifest = () => ({
  name: 'browserir-mcp',
  version: '0.1.0',
  description: 'The semantic browser layer for AI agents.',
  license: 'Apache-2.0',
  repository: {
    type: 'git',
    url: 'git+https://github.com/qng95/BrowserIR.git',
    directory: 'packages/playwright-mcp',
  },
  homepage: 'https://github.com/qng95/BrowserIR/tree/main/packages/playwright-mcp#readme',
  bugs: { url: 'https://github.com/qng95/BrowserIR/issues' },
  keywords: [
    'browserir',
    'playwright',
    'mcp',
    'browser-automation',
    'ai-agents',
    'enterprise-ui',
    'accessibility',
  ],
  type: 'module',
  sideEffects: false,
  main: './dist/index.js',
  types: './dist/index.d.ts',
  files: ['dist'],
  exports: {
    '.': {
      types: './dist/index.d.ts',
      import: './dist/index.js',
      default: './dist/index.js',
    },
    './reference-policies': {
      types: './dist/reference-policies.d.ts',
      import: './dist/reference-policies.js',
      default: './dist/reference-policies.js',
    },
    './package.json': './package.json',
  },
  engines: { node: '>=22.13.0' },
  publishConfig: {
    access: 'public',
    provenance: true,
    registry: 'https://registry.npmjs.org/',
    tag: 'latest',
  },
  scripts: {
    prebuild: 'node ./scripts/clean-dist.mjs',
    build: 'tsc -p tsconfig.build.json',
    prepack: 'pnpm build',
    test: 'vitest run',
    typecheck: 'tsc --noEmit',
  },
  dependencies: { '@modelcontextprotocol/client': '2.0.0' },
});

test('accepts only the pinned public manifest contract', () => {
  assert.deepEqual(manifestFailures(validManifest(), rootManifest, '0.1.0'), []);
});

test('rejects a manifest that differs from the explicitly expected release version', () => {
  assert.ok(
    manifestFailures(validManifest(), rootManifest, '0.1.1').some((failure) =>
      failure.includes('workspace/release version 0.1.1')),
  );
});

test('rejects private packages, install hooks, and extra manifest keys', () => {
  const manifest = validManifest();
  manifest.private = false;
  manifest.scripts.install = 'node install.js';
  const failures = manifestFailures(manifest, rootManifest);
  assert.ok(failures.some((failure) => failure.includes('manifest keys must be exactly')));
  assert.ok(failures.includes('private must be absent'));
  assert.ok(failures.includes('scripts do not match the release allowlist'));
  assert.ok(failures.includes('install lifecycle hook is forbidden'));
});

test('rejects a release channel or registry drift', () => {
  const manifest = validManifest();
  manifest.publishConfig = {
    access: 'public',
    provenance: true,
    registry: 'https://registry.example.invalid/',
    tag: 'latest',
  };
  assert.ok(
    manifestFailures(manifest, rootManifest).includes(
      'publishConfig must pin public access, provenance, npmjs registry, and latest tag',
    ),
  );
});

test('derives the exact tarball allowlist from TypeScript sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'browserir-verifier-test-'));
  try {
    const source = join(root, 'packages/playwright-mcp/src');
    mkdirSync(join(source, 'internal'), { recursive: true });
    writeFileSync(join(source, 'index.ts'), 'export const ok = true;\n');
    writeFileSync(join(source, 'internal/policy-set.ts'), 'export {};\n');
    assert.deepEqual(expectedDistPaths(root), [
      'dist/index.d.ts',
      'dist/index.js',
      'dist/internal/policy-set.d.ts',
      'dist/internal/policy-set.js',
    ]);
    assert.deepEqual(expectedPackPaths(root), [
      'dist/index.d.ts',
      'dist/index.js',
      'dist/internal/policy-set.d.ts',
      'dist/internal/policy-set.js',
      'LICENSE',
      'package.json',
      'README.md',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
