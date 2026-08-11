import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const workflow = readFileSync(`${workspaceRoot}.github/workflows/ci.yml`, 'utf8');
const rootManifest = JSON.parse(readFileSync(`${workspaceRoot}package.json`, 'utf8')) as {
  scripts?: Record<string, string>;
};
const setupDocuments = [
  readFileSync(`${workspaceRoot}README.md`, 'utf8'),
  readFileSync(`${workspaceRoot}CONTRIBUTING.md`, 'utf8'),
  readFileSync(`${workspaceRoot}docs/RELEASE_CHECKLIST.md`, 'utf8'),
];
const releaseChecklist = setupDocuments[2]!;
const playwrightPackageReadme = readFileSync(
  `${workspaceRoot}packages/playwright-driver/README.md`,
  'utf8',
);
const mcpPackageReadme = readFileSync(
  `${workspaceRoot}packages/mcp-server/README.md`,
  'utf8',
);

function job(name: string): string {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Missing CI job ${name}.`);
  const remainder = workflow.slice(start + marker.length);
  const nextJob = remainder.search(/^  [a-z][a-z-]+:\n/m);
  return nextJob < 0 ? remainder : remainder.slice(0, nextJob);
}

describe('public release CI contract', () => {
  it('qualifies the minimum supported Node release and the pinned Node 24 release', () => {
    expect(job('verify')).toContain("node: ['22.13.0', '24.19.0']");
    expect(job('packed-consumer')).toContain("node: ['22.13.0', '24.19.0']");
    for (const name of [
      'verify',
      'capability-qualification',
      'task-qualification',
      'representation-qualification',
      'performance-characterization',
      'packed-consumer',
      'production-dependency-audit',
    ]) {
      expect(job(name)).toContain('pnpm install --frozen-lockfile');
    }
  });

  it('pins the runner image and builds once before recursive package tests', () => {
    const runnerImages = [...workflow.matchAll(/runs-on: (\S+)/g)].map((match) => match[1]);
    expect(runnerImages.length).toBeGreaterThanOrEqual(8);
    expect(runnerImages.every((image) => image === 'ubuntu-24.04')).toBe(true);
    expect(workflow).not.toContain('ubuntu-latest');
    expect(rootManifest.scripts?.test).toBe('pnpm build && pnpm -r test');
    expect(rootManifest.scripts?.['test:workspace']).toBe('pnpm -r test');
    expect(rootManifest.scripts?.['release:evidence']).toBe(
      'node scripts/record-release-evidence.mjs',
    );
    expect(job('verify')).toContain('pnpm release:evidence workspace-verification');
    expect(job('verify')).toContain('--skip-build');
    expect(job('verify')).not.toContain('run: pnpm test:workspace');
    expect(job('verify').indexOf('run: pnpm build')).toBeLessThan(
      job('verify').indexOf('pnpm release:evidence workspace-verification'),
    );
  });

  it('keeps every third-party action pinned to an immutable commit', () => {
    const actionReferences = [...workflow.matchAll(/^\s*uses:\s*(\S+)/gm)].map(
      (match) => match[1],
    );

    expect(actionReferences.length).toBeGreaterThan(0);
    expect(actionReferences.every((reference) => /@[0-9a-f]{40}$/.test(reference!))).toBe(true);
  });

  it.each([
    [
      'capability-qualification',
      'timeout-minutes: 20',
      'pnpm release:evidence capability-qualification',
    ],
    [
      'task-qualification',
      'timeout-minutes: 45',
      'pnpm release:evidence task-qualification',
    ],
    [
      'representation-qualification',
      'timeout-minutes: 30',
      'pnpm release:evidence representation-qualification',
    ],
    [
      'performance-characterization',
      'timeout-minutes: 30',
      'pnpm release:evidence performance-characterization',
    ],
    ['packed-consumer', 'timeout-minutes: 30', 'pnpm release:evidence packed-consumer'],
    [
      'production-dependency-audit',
      'timeout-minutes: 10',
      'pnpm release:evidence production-audit',
    ],
  ])('%s is a separately bounded release gate', (name, timeout, command) => {
    const body = job(name);

    expect(body).toContain(timeout);
    expect(body).toContain(command);
  });

  it('builds workspace package boundaries before source-driven browser qualifications', () => {
    for (const name of [
      'capability-qualification',
      'representation-qualification',
      'performance-characterization',
    ]) {
      const body = job(name);
      expect(body).toContain('run: pnpm build');
      expect(body.indexOf('run: pnpm build')).toBeLessThan(
        body.indexOf(
          name === 'capability-qualification'
            ? 'pnpm release:evidence capability-qualification'
            : name === 'representation-qualification'
              ? 'pnpm release:evidence representation-qualification'
              : 'pnpm release:evidence performance-characterization',
        ),
      );
    }
  });

  it('retains every release gate on success or failure without weakening failures', () => {
    const evidenceJobs: Array<[string, string]> = [
      ['verify', 'output/ci/verify/'],
      ['capability-qualification', 'output/ci/capabilities/'],
      ['task-qualification', 'output/ci/qualification/'],
      ['representation-qualification', 'output/ci/representation/'],
      ['performance-characterization', 'output/ci/performance/'],
      ['packed-consumer', 'output/ci/packed-consumer/'],
      ['production-dependency-audit', 'output/ci/production-audit/'],
      ['release-evidence-dossier', 'output/ci/release-dossier/'],
    ];
    for (const [name, path] of evidenceJobs) {
      const body = job(name);
      expect(body).toContain('if: ${{ always() }}');
      expect(body).toContain('actions/upload-artifact@');
      expect(body).toContain(path);
      expect(body).toContain('if-no-files-found: error');
      expect(body).toContain('retention-days: 90');
      expect(body).toContain('${{ github.sha }}');
    }
    expect(job('capability-qualification')).toContain(
      'pnpm release:evidence capability-qualification',
    );
    expect(workflow).not.toContain('--ignore-registry-errors');
    expect(workflow).not.toContain('continue-on-error: true');
    expect(workflow).not.toMatch(/^\s*run:\s*pnpm verify:release\s*$/m);
  });

  it('assembles every matrix fragment into one fail-closed clean-source dossier', () => {
    const body = job('release-evidence-dossier');
    for (const dependency of [
      'verify',
      'capability-qualification',
      'task-qualification',
      'representation-qualification',
      'performance-characterization',
      'packed-consumer',
      'production-dependency-audit',
    ]) {
      expect(body).toContain(`      - ${dependency}`);
    }
    expect(body).toContain('if: ${{ always() && !cancelled() }}');
    expect(body).toContain(
      'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1',
    );
    expect(body).toContain('merge-multiple: false');
    expect(body).toContain('pnpm release:evidence:assemble --');
    expect(body).toContain('--input output/ci/downloaded');
    expect(body).toContain('--output output/ci/release-dossier');
    expect(body).not.toContain('--artifact-directory');
  });

  it('bootstraps a signing-key-aware package manager on the minimum Node release', () => {
    for (const document of setupDocuments) {
      expect(document).toContain('npm install --global corepack@0.34.7');
      expect(document).toContain('corepack install --global pnpm@10.30.3');
      expect(document).not.toContain('COREPACK_INTEGRITY_KEYS=0');
    }
  });

  it('documents a pnpm-safe Playwright install and project-local MCP executable', () => {
    expect(playwrightPackageReadme).toContain('"playwright@1.62.0"');
    expect(playwrightPackageReadme).toContain('pnpm add @browserir/core @browserir/playwright');
    expect(mcpPackageReadme).toContain('"playwright@1.62.0"');
    expect(mcpPackageReadme).toContain('"--dir"');
    expect(mcpPackageReadme).toContain('/absolute/path/to/your/project');
    expect(mcpPackageReadme).not.toContain('"command": "browserir-mcp"');
  });

  it('binds publication to the exact packed-consumer artifacts and hashes', () => {
    expect(releaseChecklist).toContain('--artifact-directory /absolute/private/path/');
    expect(releaseChecklist).toContain('SHA256SUMS');
    expect(releaseChecklist).toContain('Do not rebuild or repack');
    expect(releaseChecklist).toContain('Publish the exact hashed `.tgz` files');
  });
});
