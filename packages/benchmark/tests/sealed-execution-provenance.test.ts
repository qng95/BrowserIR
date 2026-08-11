import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertSealedBuildProvenanceStable,
  assertSealedGitSourceStable,
  assertValidSealedBuildRelativePath,
  collectSealedBuildProvenance,
  parseSealedBuildProvenance,
  renderSealedBuildProvenance,
  type SealedBuildPackageInput,
  type SealedGitSourceSnapshot,
} from '../src/agent-benchmark/sealed-execution-provenance.js';

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function packageFixture(
  root: string,
  name: SealedBuildPackageInput['name'],
  files: Readonly<Record<string, string>> = {
    'index.d.ts': 'export declare const value: string;\n',
    'index.js': 'export const value = "alpha";\n',
  },
): Promise<SealedBuildPackageInput> {
  const directory = join(root, name.split('/').at(-1)!);
  await mkdir(join(directory, 'dist'), { recursive: true });
  await writeFile(
    join(directory, 'package.json'),
    `${JSON.stringify({ name, version: '0.1.0', type: 'module' }, null, 2)}\n`,
  );
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(directory, 'dist', relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);
  }
  return { name, packageDirectory: directory };
}

async function fixturePackages(): Promise<{
  root: string;
  packages: SealedBuildPackageInput[];
}> {
  const root = await mkdtemp(join(tmpdir(), 'browserir-sealed-build-'));
  temporaryDirectories.push(root);
  return {
    root,
    packages: await Promise.all([
      packageFixture(root, '@browserir/core'),
      packageFixture(root, '@browserir/playwright'),
      packageFixture(root, '@browserir/mcp'),
    ]),
  };
}

describe('sealed execution build provenance', () => {
  it('hashes package.json and dist bytes deterministically independent of input order', async () => {
    const fixture = await fixturePackages();

    const forward = await collectSealedBuildProvenance({ packages: fixture.packages });
    const reverse = await collectSealedBuildProvenance({
      packages: [...fixture.packages].reverse(),
    });

    expect(reverse).toEqual(forward);
    expect(forward.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(forward.packages.map((entry) => entry.name)).toEqual([
      '@browserir/core',
      '@browserir/mcp',
      '@browserir/playwright',
    ]);
    for (const entry of forward.packages) {
      expect(entry.files.map((file) => file.path)).toEqual([
        'dist/index.d.ts',
        'dist/index.js',
        'package.json',
      ]);
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('round-trips only canonical strict provenance artifacts', async () => {
    const fixture = await fixturePackages();
    const provenance = await collectSealedBuildProvenance({ packages: fixture.packages });
    const rendered = renderSealedBuildProvenance(provenance);

    expect(parseSealedBuildProvenance(JSON.parse(rendered) as unknown)).toEqual(provenance);
    expect(renderSealedBuildProvenance(JSON.parse(rendered) as unknown)).toBe(rendered);
    expect(() =>
      parseSealedBuildProvenance({ ...provenance, unexpected: true }),
    ).toThrow(/invalid sealed build provenance.*unrecognized/i);
    expect(() =>
      parseSealedBuildProvenance({ ...provenance, sha256: '0'.repeat(64) }),
    ).toThrow(/aggregate digest/i);
  });

  it('detects byte drift at an existing built path', async () => {
    const fixture = await fixturePackages();
    const start = await collectSealedBuildProvenance({ packages: fixture.packages });
    await writeFile(
      join(fixture.packages[0]!.packageDirectory, 'dist', 'index.js'),
      'export const value = "changed";\n',
    );
    const end = await collectSealedBuildProvenance({ packages: fixture.packages });

    expect(() => assertSealedBuildProvenanceStable(start, end)).toThrow(
      /@browserir\/core.*dist\/index\.js.*content|content.*@browserir\/core.*dist\/index\.js/i,
    );
  });

  it('binds the exact package.json bytes as executable package provenance', async () => {
    const fixture = await fixturePackages();
    const mcp = fixture.packages[2]!;
    const start = await collectSealedBuildProvenance({ packages: fixture.packages });
    await writeFile(
      join(mcp.packageDirectory, 'package.json'),
      '{"name":"@browserir/mcp","version":"0.1.0","type":"module"}\n',
    );
    const end = await collectSealedBuildProvenance({ packages: fixture.packages });

    expect(() => assertSealedBuildProvenanceStable(start, end)).toThrow(
      /content.*@browserir\/mcp.*package\.json|@browserir\/mcp.*package\.json.*content/i,
    );
  });

  it('detects path renames as one missing and one unexpected file', async () => {
    const fixture = await fixturePackages();
    const core = fixture.packages[0]!.packageDirectory;
    const start = await collectSealedBuildProvenance({ packages: fixture.packages });
    await rename(join(core, 'dist', 'index.js'), join(core, 'dist', 'runtime.js'));
    const end = await collectSealedBuildProvenance({ packages: fixture.packages });

    expect(() => assertSealedBuildProvenanceStable(start, end)).toThrow(
      /missing.*dist\/index\.js.*unexpected.*dist\/runtime\.js/i,
    );
  });

  it('detects added and removed build files without accepting a new manifest', async () => {
    const addedFixture = await fixturePackages();
    const addedStart = await collectSealedBuildProvenance({
      packages: addedFixture.packages,
    });
    await writeFile(
      join(addedFixture.packages[1]!.packageDirectory, 'dist', 'late.js'),
      'export {};\n',
    );
    const addedEnd = await collectSealedBuildProvenance({
      packages: addedFixture.packages,
    });
    expect(() => assertSealedBuildProvenanceStable(addedStart, addedEnd)).toThrow(
      /@browserir\/playwright.*unexpected.*dist\/late\.js|unexpected.*@browserir\/playwright.*dist\/late\.js/i,
    );

    const removedFixture = await fixturePackages();
    const removedStart = await collectSealedBuildProvenance({
      packages: removedFixture.packages,
    });
    await rm(join(removedFixture.packages[2]!.packageDirectory, 'dist', 'index.d.ts'));
    const removedEnd = await collectSealedBuildProvenance({
      packages: removedFixture.packages,
    });
    expect(() => assertSealedBuildProvenanceStable(removedStart, removedEnd)).toThrow(
      /@browserir\/mcp.*missing.*dist\/index\.d\.ts|missing.*@browserir\/mcp.*dist\/index\.d\.ts/i,
    );
  });

  it('fails closed for missing package inputs and unsafe relative paths', async () => {
    const fixture = await fixturePackages();
    await expect(
      collectSealedBuildProvenance({ packages: fixture.packages.slice(0, 2) }),
    ).rejects.toThrow(/missing.*@browserir\/mcp/i);
    await expect(
      collectSealedBuildProvenance({
        packages: [
          ...fixture.packages.slice(0, 2),
          {
            name: '@browserir/unexpected' as SealedBuildPackageInput['name'],
            packageDirectory: fixture.packages[2]!.packageDirectory,
          },
        ],
      }),
    ).rejects.toThrow(/missing.*@browserir\/mcp.*unexpected.*@browserir\/unexpected/i);

    await rm(join(fixture.packages[0]!.packageDirectory, 'package.json'));
    await expect(
      collectSealedBuildProvenance({ packages: fixture.packages }),
    ).rejects.toThrow(/@browserir\/core.*package\.json.*missing|missing.*package\.json/i);

    const missingDistFixture = await fixturePackages();
    await rm(join(missingDistFixture.packages[0]!.packageDirectory, 'dist'), {
      recursive: true,
    });
    await expect(
      collectSealedBuildProvenance({ packages: missingDistFixture.packages }),
    ).rejects.toThrow(/@browserir\/core.*dist.*missing|missing.*dist/i);

    expect(() => assertValidSealedBuildRelativePath('../outside.js')).toThrow(
      /relative.*path|path.*relative|traversal/i,
    );
    expect(() => assertValidSealedBuildRelativePath('dist/../outside.js')).toThrow(
      /relative.*path|path.*relative|traversal/i,
    );
    expect(() => assertValidSealedBuildRelativePath('/absolute.js')).toThrow(
      /relative.*path|path.*relative|absolute/i,
    );
  });

  it('rejects symlinks and non-file entries anywhere in dist', async () => {
    const linkedFixture = await fixturePackages();
    const linkedDist = join(linkedFixture.packages[0]!.packageDirectory, 'dist');
    await symlink('index.js', join(linkedDist, 'alias.js'));
    await expect(
      collectSealedBuildProvenance({ packages: linkedFixture.packages }),
    ).rejects.toThrow(/symlink.*alias\.js/i);

    const fifoFixture = await fixturePackages();
    const fifo = join(fifoFixture.packages[1]!.packageDirectory, 'dist', 'runtime.pipe');
    await execFile('mkfifo', [fifo]);
    await expect(
      collectSealedBuildProvenance({ packages: fifoFixture.packages }),
    ).rejects.toThrow(/non-file|unsupported.*runtime\.pipe/i);
  });
});

const gitSource = (
  overrides: Partial<SealedGitSourceSnapshot> = {},
): SealedGitSourceSnapshot => ({
  revision: '1'.repeat(40),
  tree: '2'.repeat(40),
  clean: true,
  ...overrides,
});

describe('sealed Git source provenance', () => {
  it('accepts only exact clean start/end source identity', () => {
    expect(() => assertSealedGitSourceStable(gitSource(), gitSource())).not.toThrow();

    expect(() =>
      assertSealedGitSourceStable(gitSource(), gitSource({ revision: '3'.repeat(40) })),
    ).toThrow(/revision.*drift/i);
    expect(() =>
      assertSealedGitSourceStable(gitSource(), gitSource({ tree: '4'.repeat(40) })),
    ).toThrow(/tree.*drift/i);
    expect(() =>
      assertSealedGitSourceStable(gitSource(), gitSource({ clean: false })),
    ).toThrow(/clean.*end|end.*clean|dirty/i);
    expect(() =>
      assertSealedGitSourceStable(gitSource({ clean: false }), gitSource()),
    ).toThrow(/clean.*start|start.*clean|dirty/i);
  });

  it('fails closed when either Git snapshot is unresolved or malformed', () => {
    expect(() =>
      assertSealedGitSourceStable(gitSource({ revision: null }), gitSource()),
    ).toThrow(/resolved.*revision|revision.*resolved/i);
    expect(() =>
      assertSealedGitSourceStable(gitSource(), gitSource({ tree: 'not-a-git-id' })),
    ).toThrow(/tree.*Git|Git.*tree/i);
  });
});
