import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const packageDirectory = 'packages/playwright-mcp';
export const packageName = 'browserir';

const expectedDescription =
  'The semantic browser layer for AI agents.';
const expectedKeywords = [
  'browserir',
  'playwright',
  'mcp',
  'browser-automation',
  'ai-agents',
  'enterprise-ui',
  'accessibility',
];
const expectedRepository = {
  type: 'git',
  url: 'git+https://github.com/qng95/BrowserIR.git',
  directory: packageDirectory,
};
const expectedHomepage =
  'https://github.com/qng95/BrowserIR/tree/main/packages/playwright-mcp#readme';
const expectedBugs = { url: 'https://github.com/qng95/BrowserIR/issues' };
const expectedPublishConfig = {
  access: 'public',
  provenance: true,
  registry: 'https://registry.npmjs.org/',
  tag: 'latest',
};
const expectedExports = {
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
};
const expectedScripts = {
  prebuild: 'node ./scripts/clean-dist.mjs',
  build: 'tsc -p tsconfig.build.json',
  prepack: 'pnpm build',
  test: 'vitest run',
  typecheck: 'tsc --noEmit',
};
const expectedDependencies = { '@modelcontextprotocol/client': '2.0.0' };
const expectedRuntimeExports = {
  '.': ['ADAPTIVE_PLAYWRIGHT_TOOLS_VERSION', 'createAdaptivePlaywrightTools'],
  './reference-policies': [
    'ADAPTIVE_REFERENCE_POLICIES_VERSION',
    'createCrossTreeLabelReferencePolicy',
    'createGridCoordinateReferencePolicy',
    'createScheduleCoordinateReferencePolicy',
  ],
};
const allowedManifestKeys = [
  'bugs',
  'dependencies',
  'description',
  'engines',
  'exports',
  'files',
  'homepage',
  'keywords',
  'license',
  'main',
  'name',
  'publishConfig',
  'repository',
  'scripts',
  'sideEffects',
  'type',
  'types',
  'version',
];
const semverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const normalized = (path) => path.replaceAll('\\', '/');
const sorted = (values) => [...values].sort((left, right) => left.localeCompare(right));
const canonicalJsonValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      sorted(Object.keys(value)).map((key) => [key, canonicalJsonValue(value[key])]),
    );
  }
  return value;
};
const sameJson = (left, right) =>
  JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function listFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(normalized(relative(directory, path)));
      else throw new Error(`Unexpected non-file entry: ${path}`);
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

export function expectedDistPaths(root = workspaceRoot) {
  const sourceRoot = resolve(root, packageDirectory, 'src');
  return sorted(listFiles(sourceRoot).flatMap((path) =>
    emittedPaths(path).map((output) => `dist/${output}`)));
}

export function expectedPackPaths(root = workspaceRoot) {
  return sorted([
    'LICENSE',
    'README.md',
    ...expectedDistPaths(root),
    'package.json',
  ]);
}

export function manifestFailures(
  manifest,
  rootManifest,
  expectedVersion = rootManifest?.version,
) {
  const failures = [];
  const expectedLicense = rootManifest?.license;
  const actualKeys = sorted(Object.keys(manifest));

  if (!sameJson(actualKeys, allowedManifestKeys)) {
    failures.push(
      `manifest keys must be exactly ${allowedManifestKeys.join(', ')}; found ${actualKeys.join(', ')}`,
    );
  }
  if (manifest.name !== packageName) failures.push(`name must be ${packageName}`);
  if (
    manifest.version !== rootManifest?.version ||
    manifest.version !== expectedVersion ||
    !semverPattern.test(manifest.version ?? '')
  ) {
    failures.push(
      `version must be valid SemVer and match workspace/release version ${expectedVersion ?? '(missing)'}`,
    );
  }
  if (manifest.description !== expectedDescription) {
    failures.push(`description must be exactly ${JSON.stringify(expectedDescription)}`);
  }
  if (manifest.license !== expectedLicense || expectedLicense !== 'Apache-2.0') {
    failures.push('license must be Apache-2.0 and match the workspace license');
  }
  if (Object.hasOwn(manifest, 'private')) failures.push('private must be absent');
  if (manifest.sideEffects !== false) failures.push('sideEffects must be false');
  if (manifest.type !== 'module') failures.push('type must be module');
  if (manifest.main !== './dist/index.js') failures.push('main must be ./dist/index.js');
  if (manifest.types !== './dist/index.d.ts') failures.push('types must be ./dist/index.d.ts');
  if (!sameJson(manifest.files, ['dist'])) failures.push('files must be exactly ["dist"]');
  if (!sameJson(manifest.exports, expectedExports)) failures.push('exports do not match the public API allowlist');
  if (!sameJson(manifest.engines, { node: '>=22.13.0' })) {
    failures.push('engines must be exactly {"node":">=22.13.0"}');
  }
  if (!sameJson(manifest.scripts, expectedScripts)) failures.push('scripts do not match the release allowlist');
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (Object.hasOwn(manifest.scripts ?? {}, hook)) failures.push(`${hook} lifecycle hook is forbidden`);
  }
  if (!sameJson(manifest.dependencies, expectedDependencies)) {
    failures.push('runtime dependencies do not match the release allowlist');
  }
  if (!sameJson(manifest.keywords, expectedKeywords)) failures.push('keywords do not match the release metadata');
  if (!sameJson(manifest.repository, expectedRepository)) failures.push('repository metadata is not canonical');
  if (manifest.homepage !== expectedHomepage) failures.push(`homepage must be ${expectedHomepage}`);
  if (!sameJson(manifest.bugs, expectedBugs)) failures.push('bugs metadata is not canonical');
  if (!sameJson(manifest.publishConfig, expectedPublishConfig)) {
    failures.push('publishConfig must pin public access, provenance, npmjs registry, and latest tag');
  }
  return failures;
}

function staticFailures(root, manifest, rootManifest, expectedVersion) {
  const failures = manifestFailures(manifest, rootManifest, expectedVersion);
  const packageRoot = resolve(root, packageDirectory);
  const readme = resolve(packageRoot, 'README.md');
  const packageLicense = resolve(packageRoot, 'LICENSE');
  const rootLicense = resolve(root, 'LICENSE');

  if (!existsSync(readme) || readFileSync(readme, 'utf8').trim() === '') {
    failures.push('README.md must exist and be non-empty');
  }
  if (!existsSync(packageLicense)) {
    failures.push('package LICENSE must exist');
  } else if (readFileSync(packageLicense).compare(readFileSync(rootLicense)) !== 0) {
    failures.push('package LICENSE must be byte-identical to the workspace LICENSE');
  }

  const sourcePaths = listFiles(resolve(packageRoot, 'src'));
  const unsupportedSources = sourcePaths.filter((path) => emittedPaths(path).length === 0);
  if (unsupportedSources.length > 0) {
    failures.push(`src contains unsupported release inputs: ${unsupportedSources.join(', ')}`);
  }
  const actualDist = listFiles(resolve(packageRoot, 'dist')).map((path) => `dist/${path}`);
  const expectedDist = expectedDistPaths(root);
  if (!sameJson(actualDist, expectedDist)) {
    failures.push(
      `dist must equal deterministic TypeScript outputs; expected ${expectedDist.join(', ')}, found ${actualDist.join(', ')}`,
    );
  }
  if (actualDist.some((path) => path.endsWith('.map'))) failures.push('source maps are forbidden');
  return failures;
}

function parsePackJson(output) {
  const source = output.trim();
  const candidates = [source];
  for (let index = source.lastIndexOf('\n{'); index >= 0; index = source.lastIndexOf('\n{', index - 1)) {
    candidates.push(source.slice(index + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // pnpm may write non-JSON notices before its final JSON result.
    }
  }
  throw new Error(`Could not parse pnpm pack output: ${source.slice(-500)}`);
}

function packInto(packageRoot, destination) {
  const output = execFileSync(
    'pnpm',
    ['--config.ignore-scripts=true', 'pack', '--pack-destination', destination, '--json'],
    { cwd: packageRoot, encoding: 'utf8', stdio: 'pipe', timeout: 120_000 },
  );
  const result = parsePackJson(output);
  const reported = typeof result.filename === 'string' ? basename(result.filename) : undefined;
  const archives = readdirSync(destination).filter((entry) => entry.endsWith('.tgz'));
  if (reported !== undefined && archives.includes(reported)) return resolve(destination, reported);
  if (archives.length === 1) return resolve(destination, archives[0]);
  throw new Error(`Expected exactly one packed archive; found ${archives.length}.`);
}

function archivePaths(archive) {
  const entries = execFileSync('tar', ['-tzf', archive], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 30_000,
  }).split('\n').map((entry) => entry.trim()).filter(Boolean);
  const files = [];
  for (const entry of entries) {
    if (
      entry.startsWith('/') ||
      !entry.startsWith('package/') ||
      entry.split('/').some((segment) => segment === '..')
    ) {
      throw new Error(`Unsafe packed path: ${entry}`);
    }
    if (!entry.endsWith('/')) files.push(entry.slice('package/'.length));
  }
  return sorted(files);
}

function assertExtractedTreeSafe(packageRoot) {
  const visit = (current) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const status = lstatSync(path);
      if (status.isSymbolicLink()) throw new Error(`Packed artifact contains symlink: ${path}`);
      if (status.isDirectory()) visit(path);
      else if (!status.isFile()) throw new Error(`Packed artifact contains special file: ${path}`);
    }
  };
  visit(packageRoot);
}

async function importPublicEntries(extractedPackage, manifest) {
  const imports = {};
  for (const subpath of ['.', './reference-policies']) {
    const target = manifest.exports?.[subpath]?.import;
    if (typeof target !== 'string' || !target.startsWith('./')) {
      throw new Error(`Missing safe ESM import target for ${subpath}.`);
    }
    const path = resolve(extractedPackage, target);
    if (!path.startsWith(`${extractedPackage}${sep}`)) {
      throw new Error(`ESM import target escapes package root: ${target}`);
    }
    const loaded = await import(`${pathToFileURL(path).href}?release-verify=${randomUUID()}`);
    const exportNames = sorted(Object.keys(loaded));
    if (!sameJson(exportNames, expectedRuntimeExports[subpath])) {
      throw new Error(
        `Runtime exports for ${subpath} differ; expected ${expectedRuntimeExports[subpath].join(', ')}, found ${exportNames.join(', ')}`,
      );
    }
    imports[subpath] = { target, exports: exportNames };
  }
  return imports;
}

function artifactRecords(extractedPackage, paths) {
  return paths.map((path) => {
    const bytes = readFileSync(resolve(extractedPackage, path));
    return { path, bytes: bytes.byteLength, sha256: sha256(bytes) };
  });
}

function parseArguments(argv) {
  let artifactDirectory;
  let expectedVersion;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--artifact-directory') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--artifact-directory requires a path.');
      }
      artifactDirectory = resolve(value);
      index += 1;
    } else if (argument === '--expected-version') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--expected-version requires a SemVer value.');
      }
      if (!semverPattern.test(value)) throw new Error('--expected-version must be valid SemVer.');
      expectedVersion = value;
      index += 1;
    } else if (argument === '--help') {
      return { help: true, artifactDirectory: undefined, expectedVersion: undefined };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { help: false, artifactDirectory, expectedVersion };
}

function retainArtifacts(artifactDirectory, archive, report) {
  if (existsSync(artifactDirectory) && !lstatSync(artifactDirectory).isDirectory()) {
    throw new Error(`Artifact path is not a directory: ${artifactDirectory}`);
  }
  mkdirSync(artifactDirectory, { recursive: true });
  const retainedArchive = resolve(artifactDirectory, basename(archive));
  const reportName = `browserir-${report.package.version}-release-report.json`;
  const retainedReport = resolve(artifactDirectory, reportName);
  if (existsSync(retainedArchive) || existsSync(retainedReport)) {
    throw new Error('Refusing to overwrite an existing release artifact or report.');
  }
  copyFileSync(archive, retainedArchive, fsConstants.COPYFILE_EXCL);
  try {
    writeFileSync(retainedReport, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    rmSync(retainedArchive, { force: true });
    throw error;
  }
  return { archive: retainedArchive, report: retainedReport };
}

export async function verifyBrowserIrRelease({
  root = workspaceRoot,
  artifactDirectory,
  expectedVersion,
  build = true,
} = {}) {
  const packageRoot = resolve(root, packageDirectory);
  const manifestPath = resolve(packageRoot, 'package.json');
  const rootManifest = readJson(resolve(root, 'package.json'));
  const manifest = readJson(manifestPath);
  const releaseVersion = expectedVersion ?? rootManifest.version;
  const prebuildFailures = manifestFailures(manifest, rootManifest, releaseVersion);
  if (prebuildFailures.length > 0) {
    throw new Error(`Release manifest is blocked:\n- ${prebuildFailures.join('\n- ')}`);
  }

  if (build) {
    execFileSync('pnpm', ['--filter', packageName, 'build'], {
      cwd: root,
      stdio: 'inherit',
      timeout: 120_000,
    });
  }

  const failures = staticFailures(root, manifest, rootManifest, releaseVersion);
  if (failures.length > 0) throw new Error(`Release verification is blocked:\n- ${failures.join('\n- ')}`);

  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'browserir-release-'));
  try {
    const packDirectory = resolve(temporaryDirectory, 'pack');
    const extractDirectory = resolve(temporaryDirectory, 'extract');
    mkdirSync(packDirectory);
    mkdirSync(extractDirectory);
    const archive = packInto(packageRoot, packDirectory);
    const expectedArchiveName = `browserir-${manifest.version}.tgz`;
    if (basename(archive) !== expectedArchiveName) {
      throw new Error(
        `Packed filename must be ${expectedArchiveName}; found ${basename(archive)}.`,
      );
    }
    const observedPaths = archivePaths(archive);
    const expectedPaths = expectedPackPaths(root);
    if (!sameJson(observedPaths, expectedPaths)) {
      throw new Error(
        `Packed file allowlist mismatch; expected ${expectedPaths.join(', ')}, found ${observedPaths.join(', ')}`,
      );
    }

    execFileSync('tar', ['-xzf', archive, '-C', extractDirectory], {
      stdio: 'pipe',
      timeout: 30_000,
    });
    const extractedPackage = resolve(extractDirectory, 'package');
    assertExtractedTreeSafe(extractedPackage);
    const packedManifest = readJson(resolve(extractedPackage, 'package.json'));
    const expectedPackedManifest = structuredClone(manifest);
    // pnpm intentionally removes prepack from the published manifest after
    // using it locally. Every other byte-significant manifest field must stay
    // bound to the source contract verified above.
    delete expectedPackedManifest.scripts.prepack;
    if (!sameJson(packedManifest, expectedPackedManifest)) {
      throw new Error(
        'Packed package.json differs from the verified source package.json beyond pnpm\'s expected prepack removal.',
      );
    }
    const imports = await importPublicEntries(extractedPackage, packedManifest);
    const archiveBytes = readFileSync(archive);
    const report = {
      schemaVersion: 'browserir-release-verification/1',
      package: { name: manifest.name, version: manifest.version },
      build: { command: `pnpm --filter ${packageName} build`, executions: build ? 1 : 0 },
      pack: { command: 'pnpm --config.ignore-scripts=true pack', lifecycleScripts: false },
      archive: {
        filename: basename(archive),
        bytes: statSync(archive).size,
        sha256: sha256(archiveBytes),
      },
      files: artifactRecords(extractedPackage, observedPaths),
      imports,
    };
    const retained = artifactDirectory === undefined
      ? undefined
      : retainArtifacts(artifactDirectory, archive, report);
    return { report, retained };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      'Usage: node scripts/verify-browserir-release.mjs ' +
      '[--expected-version SEMVER] [--artifact-directory PATH]\n',
    );
    return;
  }
  const result = await verifyBrowserIrRelease({
    artifactDirectory: options.artifactDirectory,
    expectedVersion: options.expectedVersion,
  });
  process.stdout.write(
    `Release verification passed for ${result.report.package.name}@${result.report.package.version}.\n` +
    `Tarball sha256: ${result.report.archive.sha256}\n`,
  );
  if (result.retained !== undefined) {
    process.stdout.write(`Retained tarball: ${result.retained.archive}\nRetained report: ${result.retained.report}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
