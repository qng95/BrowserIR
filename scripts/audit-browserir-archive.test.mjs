import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditPayloadFailures,
  candidateManifestFailures,
} from './audit-browserir-archive.mjs';

const manifest = () => ({
  name: 'browserir-mcp',
  version: '0.1.0',
  publishConfig: {
    access: 'public',
    registry: 'https://registry.npmjs.org/',
    tag: 'latest',
  },
});

test('accepts a version-bound public default candidate', () => {
  assert.deepEqual(
    candidateManifestFailures(manifest(), 'browserir-mcp-0.1.0.tgz'),
    [],
  );
});

test('rejects archive identity and registry drift', () => {
  const candidate = manifest();
  candidate.publishConfig.registry = 'https://registry.example.invalid/';
  const failures = candidateManifestFailures(candidate, 'renamed.tgz');
  assert.ok(failures.includes('archive filename must match the embedded package version'));
  assert.ok(failures.includes('publish registry must be https://registry.npmjs.org/'));
});

test('requires a zero-vulnerability npm audit payload', () => {
  const clean = {
    vulnerabilities: {},
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0,
      },
    },
  };
  assert.deepEqual(auditPayloadFailures(clean), []);
  clean.metadata.vulnerabilities.high = 1;
  clean.metadata.vulnerabilities.total = 1;
  clean.vulnerabilities.example = { severity: 'high' };
  const failures = auditPayloadFailures(clean);
  assert.ok(failures.some((failure) => failure.includes('high vulnerabilities')));
  assert.ok(failures.includes('npm audit returned one or more vulnerability records'));
});
