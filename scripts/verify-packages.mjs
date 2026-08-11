import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const releasePackageDefinitions = [
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
    bin: { 'browserir-mcp': './dist/cli.js' },
  },
];

export const releasePackages = releasePackageDefinitions.map(
  (definition) => definition.directory,
);

const normalized = (path) => path.replaceAll('\\', '/');
const sorted = (values) => [...values].sort((left, right) => left.localeCompare(right));
const semverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function listFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(normalized(relative(directory, path)));
    }
  };
  visit(directory);
  return sorted(files);
}

function emittedPaths(sourcePath) {
  if (sourcePath.endsWith('.d.ts')) return [];
  if (sourcePath.endsWith('.mts')) {
    const base = sourcePath.slice(0, -4);
    return [`${base}.d.mts`, `${base}.mjs`];
  }
  if (sourcePath.endsWith('.cts')) {
    const base = sourcePath.slice(0, -4);
    return [`${base}.d.cts`, `${base}.cjs`];
  }
  if (sourcePath.endsWith('.tsx')) {
    const base = sourcePath.slice(0, -4);
    return [`${base}.d.ts`, `${base}.js`];
  }
  if (sourcePath.endsWith('.ts')) {
    const base = sourcePath.slice(0, -3);
    return [`${base}.d.ts`, `${base}.js`];
  }
  return [];
}

export function expectedDistPaths(directory, root = workspaceRoot) {
  const sourceRoot = resolve(root, directory, 'src');
  return sorted(
    listFiles(sourceRoot).flatMap((path) =>
      emittedPaths(path).map((output) => `dist/${output}`),
    ),
  );
}

export function expectedPackPaths(directory, root = workspaceRoot) {
  const packageRoot = resolve(root, directory);
  return sorted([
    'README.md',
    ...(existsSync(resolve(packageRoot, 'LICENSE')) ? ['LICENSE'] : []),
    ...expectedDistPaths(directory, root),
    'package.json',
  ]);
}

export function readManifest(directory, root = workspaceRoot) {
  return JSON.parse(readFileSync(resolve(root, directory, 'package.json'), 'utf8'));
}

function parseJsonOutput(output) {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    for (let index = trimmed.lastIndexOf('\n{'); index >= 0; index = trimmed.lastIndexOf('\n{', index - 1)) {
      try {
        return JSON.parse(trimmed.slice(index + 1));
      } catch {
        // Continue looking for the final complete JSON document.
      }
    }
  }
  throw new Error(`Could not parse pnpm JSON output: ${trimmed.slice(-500)}`);
}

export function packReleasePackage(directory, destination, root = workspaceRoot) {
  const output = execFileSync(
    'pnpm',
    [
      '--config.ignore-scripts=true',
      'pack',
      '--pack-destination',
      destination,
      '--json',
    ],
    {
      cwd: resolve(root, directory),
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 120_000,
    },
  );
  const result = parseJsonOutput(output);
  const filename = typeof result.filename === 'string' ? basename(result.filename) : undefined;
  if (filename !== undefined) {
    const archive = resolve(destination, filename);
    if (existsSync(archive)) return archive;
  }
  const archives = readdirSync(destination)
    .filter((path) => path.endsWith('.tgz'))
    .map((path) => resolve(destination, path));
  if (archives.length !== 1) {
    throw new Error(`Expected one packed archive for ${directory}; found ${archives.length}.`);
  }
  return archives[0];
}

function inspectPackedPackage(directory, root) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'browserir-pack-'));
  try {
    const archive = packReleasePackage(directory, temporaryDirectory, root);
    return inspectPackedArchive(archive);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function inspectPackedArchive(archive) {
  const manifest = JSON.parse(
    execFileSync('tar', ['-xOf', archive, 'package/package.json'], {
      encoding: 'utf8',
      stdio: 'pipe',
    }),
  );
  const paths = execFileSync('tar', ['-tf', archive], {
    encoding: 'utf8',
    stdio: 'pipe',
  })
    .split('\n')
    .map((path) => path.trim())
    .filter((path) => path.startsWith('package/') && !path.endsWith('/'))
    .map((path) => path.slice('package/'.length));
  return { manifest, paths: sorted(paths) };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function definitionFor(directory) {
  return releasePackageDefinitions.find((definition) => definition.directory === directory);
}

export function packageStaticFailures({
  root = workspaceRoot,
  packageDirectories = releasePackages,
} = {}) {
  const failures = [];
  let expectedVersion;
  try {
    expectedVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  } catch {
    // The public-release verifier reports an unreadable root manifest explicitly.
  }
  if (typeof expectedVersion !== 'string' || !semverPattern.test(expectedVersion)) {
    failures.push('workspace: root package version must be valid SemVer');
  }
  for (const directory of packageDirectories) {
    const definition = definitionFor(directory);
    let manifest;
    try {
      manifest = readManifest(directory, root);
    } catch (error) {
      failures.push(`${directory}: package.json could not be read: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const label = manifest.name ?? directory;
    if (definition !== undefined && manifest.name !== definition.name) {
      failures.push(`${label}: package name must be ${definition.name}`);
    }
    if (definition !== undefined && manifest.description !== definition.description) {
      failures.push(`${label}: package description must match the release definition`);
    }
    if (definition !== undefined && !sameJson(manifest.keywords, definition.keywords)) {
      failures.push(`${label}: package keywords must match the release definition`);
    }
    if (manifest.version !== expectedVersion) {
      failures.push(`${label}: version must match workspace version ${expectedVersion ?? '(missing)'}`);
    }
    if (manifest.engines?.node !== '>=22.13.0') {
      failures.push(`${label}: engines.node must be >=22.13.0`);
    }
    if (!sameJson(manifest.files, ['dist'])) {
      failures.push(`${label}: files must allowlist only dist`);
    }
    if (manifest.type !== 'module') failures.push(`${label}: type must be module`);
    if (manifest.main !== './dist/index.js') failures.push(`${label}: main must be ./dist/index.js`);
    if (manifest.types !== './dist/index.d.ts') failures.push(`${label}: types must be ./dist/index.d.ts`);
    if (
      !sameJson(manifest.exports, {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
          default: './dist/index.js',
        },
        './package.json': './package.json',
      })
    ) {
      failures.push(`${label}: exports must expose ESM, declarations, and package.json only`);
    }
    const readmePath = resolve(root, directory, 'README.md');
    if (!existsSync(readmePath) || readFileSync(readmePath, 'utf8').trim() === '') {
      failures.push(`${label}: non-empty package README.md is required`);
    }
    const actualDist = listFiles(resolve(root, directory, 'dist')).map((path) => `dist/${path}`);
    const expectedDist = expectedDistPaths(directory, root);
    if (!sameJson(actualDist, expectedDist)) {
      failures.push(
        `${label}: dist contents differ from deterministic TypeScript outputs (expected ${expectedDist.join(', ') || 'none'}; found ${actualDist.join(', ') || 'none'})`,
      );
    }
    if (actualDist.some((path) => path.endsWith('.map'))) {
      failures.push(`${label}: public build must not contain source maps`);
    }
    const dependencyNames = sorted(Object.keys(manifest.dependencies ?? {}));
    const expectedDependencyRanges = definition?.dependencies ?? manifest.dependencies ?? {};
    const expectedDependencies = sorted(Object.keys(expectedDependencyRanges));
    if (!sameJson(dependencyNames, expectedDependencies)) {
      failures.push(
        `${label}: runtime dependencies must be exactly ${expectedDependencies.join(', ') || '(none)'}`,
      );
    }
    for (const [dependency, expectedRange] of Object.entries(expectedDependencyRanges)) {
      if (manifest.dependencies?.[dependency] !== expectedRange) {
        failures.push(
          `${label}: dependency ${dependency} must use ${expectedRange}; found ${manifest.dependencies?.[dependency] ?? '(missing)'}`,
        );
      }
    }
    for (const field of ['optionalDependencies', 'peerDependencies']) {
      if (Object.keys(manifest[field] ?? {}).length > 0) {
        failures.push(`${label}: ${field} is not allowed in the 0.1 public package boundary`);
      }
    }
    if (
      (Array.isArray(manifest.bundleDependencies) && manifest.bundleDependencies.length > 0) ||
      (Array.isArray(manifest.bundledDependencies) && manifest.bundledDependencies.length > 0)
    ) {
      failures.push(`${label}: bundled dependencies are not allowed in public packages`);
    }
    const expectedLifecycleScripts = {
      prebuild: 'node ../../scripts/clean-package-dist.mjs',
      build: 'tsc -p tsconfig.build.json',
      prepack: 'pnpm build',
    };
    for (const [script, expectedCommand] of Object.entries(expectedLifecycleScripts)) {
      if (manifest.scripts?.[script] !== expectedCommand) {
        failures.push(`${label}: ${script} script must be ${expectedCommand}`);
      }
    }
    for (const script of [
      'preinstall',
      'install',
      'postinstall',
      'postbuild',
      'prepublish',
      'prepublishOnly',
      'preprepare',
      'prepare',
      'postprepare',
      'postpack',
      'publish',
      'postpublish',
    ]) {
      if (Object.hasOwn(manifest.scripts ?? {}, script)) {
        failures.push(`${label}: ${script} lifecycle script is not allowed in a public package`);
      }
    }
    if (definition?.bin === undefined) {
      if (manifest.bin !== undefined) failures.push(`${label}: unexpected executable mapping`);
    } else {
      if (!sameJson(manifest.bin, definition.bin)) {
        failures.push(`${label}: bin must map browserir-mcp to ./dist/cli.js`);
      }
      const cliPath = resolve(root, directory, 'dist/cli.js');
      if (!existsSync(cliPath)) {
        failures.push(`${label}: missing dist/cli.js`);
      } else if (!readFileSync(cliPath, 'utf8').startsWith('#!/usr/bin/env node\n')) {
        failures.push(`${label}: dist/cli.js must start with #!/usr/bin/env node`);
      }
    }
  }
  return failures;
}

export function packedArtifactFailures({
  root = workspaceRoot,
  packageDirectories = releasePackages,
  archives,
} = {}) {
  const failures = [];
  const sourceManifests = new Map();
  for (const directory of packageDirectories) {
    try {
      const manifest = readManifest(directory, root);
      sourceManifests.set(manifest.name, manifest);
    } catch {
      // Static verification reports the malformed manifest.
    }
  }

  for (const directory of packageDirectories) {
    let sourceManifest;
    try {
      sourceManifest = readManifest(directory, root);
    } catch {
      continue;
    }
    const label = sourceManifest.name ?? directory;
    try {
      const suppliedArchive = archives?.get(sourceManifest.name);
      if (archives !== undefined && suppliedArchive === undefined) {
        failures.push(`${label}: supplied release archive is missing`);
        continue;
      }
      const packed =
        suppliedArchive === undefined
          ? inspectPackedPackage(directory, root)
          : inspectPackedArchive(suppliedArchive);
      const expectedPaths = expectedPackPaths(directory, root);
      if (!sameJson(packed.paths, expectedPaths)) {
        failures.push(
          `${label}: packed files differ from exact allowlist (expected ${expectedPaths.join(', ')}; found ${packed.paths.join(', ')})`,
        );
      }
      for (const field of [
        'name',
        'version',
        'description',
        'keywords',
        'type',
        'main',
        'types',
        'files',
        'exports',
        'bin',
        'engines',
        'private',
        'license',
        'repository',
        'homepage',
        'bugs',
        'publishConfig',
      ]) {
        if (!sameJson(packed.manifest[field], sourceManifest[field])) {
          failures.push(`${label}: packed manifest changed ${field}`);
        }
      }
      const expectedPackedScripts = { ...(sourceManifest.scripts ?? {}) };
      // pnpm runs/consumes prepack while constructing the archive, then removes
      // that one hook from the published manifest. Every other script remains
      // part of the exact artifact contract.
      delete expectedPackedScripts.prepack;
      if (!sameJson(packed.manifest.scripts, expectedPackedScripts)) {
        failures.push(`${label}: packed manifest changed scripts beyond removing prepack`);
      }
      const sourceDependencyNames = sorted(Object.keys(sourceManifest.dependencies ?? {}));
      const packedDependencyNames = sorted(Object.keys(packed.manifest.dependencies ?? {}));
      if (!sameJson(packedDependencyNames, sourceDependencyNames)) {
        failures.push(
          `${label}: packed runtime dependency names changed (expected ${sourceDependencyNames.join(', ') || '(none)'}; found ${packedDependencyNames.join(', ') || '(none)'})`,
        );
      }
      for (const [dependency, sourceRange] of Object.entries(sourceManifest.dependencies ?? {})) {
        const packedRange = packed.manifest.dependencies?.[dependency];
        if (typeof packedRange !== 'string') {
          failures.push(`${label}: packed manifest is missing dependency ${dependency}`);
          continue;
        }
        if (typeof sourceRange === 'string' && sourceRange.startsWith('workspace:')) {
          const localVersion = sourceManifests.get(dependency)?.version;
          if (packedRange.startsWith('workspace:')) {
            failures.push(`${label}: packed dependency ${dependency} retains unusable ${packedRange}`);
          } else if (sourceRange === 'workspace:*' && packedRange !== localVersion) {
            failures.push(
              `${label}: packed dependency ${dependency} must resolve workspace:* to ${localVersion ?? 'the local release version'}; found ${packedRange}`,
            );
          }
        } else if (packedRange !== sourceRange) {
          failures.push(`${label}: packed dependency ${dependency} changed from ${sourceRange} to ${packedRange}`);
        }
      }
    } catch (error) {
      failures.push(`${label}: package inspection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

export function packageLayoutFailures({
  root = workspaceRoot,
  packageDirectories = releasePackages,
  inspectPackedArtifacts = true,
} = {}) {
  const failures = packageStaticFailures({ root, packageDirectories });
  if (inspectPackedArtifacts && failures.length === 0) {
    failures.push(...packedArtifactFailures({ root, packageDirectories }));
  }
  return failures;
}

function main() {
  execFileSync('pnpm', ['build'], { cwd: workspaceRoot, stdio: 'inherit' });
  const failures = packageLayoutFailures();
  if (failures.length > 0) {
    process.stderr.write(`Package verification failed:\n- ${failures.join('\n- ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('Package verification passed.\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
