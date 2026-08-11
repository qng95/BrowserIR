import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';

import { z } from 'zod';

import { stableJson } from '../environment.js';

export const SEALED_EXECUTION_BUILD_PROVENANCE_SCHEMA_VERSION = '1.0.0' as const;

export const SEALED_UPLIFT_BROWSERIR_PACKAGE_NAMES = [
  '@browserir/core',
  '@browserir/playwright',
  '@browserir/mcp',
] as const;

export type SealedUpliftBrowserIrPackageName =
  (typeof SEALED_UPLIFT_BROWSERIR_PACKAGE_NAMES)[number];

export interface SealedBuildPackageInput {
  name: SealedUpliftBrowserIrPackageName;
  /** Absolute resolved package directory containing package.json and dist/. */
  packageDirectory: string;
}

export interface SealedBuildFileProvenance {
  path: string;
  bytes: number;
  sha256: string;
}

export interface SealedBuildPackageProvenance {
  name: SealedUpliftBrowserIrPackageName;
  version: string;
  files: readonly SealedBuildFileProvenance[];
  sha256: string;
}

export interface SealedBuildProvenance {
  schemaVersion: typeof SEALED_EXECUTION_BUILD_PROVENANCE_SCHEMA_VERSION;
  packages: readonly SealedBuildPackageProvenance[];
  sha256: string;
}

export interface SealedGitSourceSnapshot {
  revision: string | null;
  tree: string | null;
  clean: boolean;
}

const digestPattern = /^[a-f0-9]{64}$/;
const gitObjectPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const expectedPackageNames = new Set<string>(SEALED_UPLIFT_BROWSERIR_PACKAGE_NAMES);

const buildFileProvenanceSchema = z
  .object({
    path: z.string(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(digestPattern),
  })
  .strict();

const buildPackageProvenanceSchema = z
  .object({
    name: z.enum(SEALED_UPLIFT_BROWSERIR_PACKAGE_NAMES),
    version: z.string().min(1),
    files: z.array(buildFileProvenanceSchema),
    sha256: z.string().regex(digestPattern),
  })
  .strict();

const buildProvenanceSchema = z
  .object({
    schemaVersion: z.literal(SEALED_EXECUTION_BUILD_PROVENANCE_SCHEMA_VERSION),
    packages: z.array(buildPackageProvenanceSchema),
    sha256: z.string().regex(digestPattern),
  })
  .strict();

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

const provenanceDigest = (value: unknown): string => sha256(stableJson(value));

const filesystemErrorCode = (error: unknown): unknown =>
  typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;

export function assertValidSealedBuildRelativePath(path: string): void {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
    (path !== 'package.json' && !path.startsWith('dist/'))
  ) {
    throw new Error(
      `Sealed build path must be a safe package-relative package.json or dist file path: ${JSON.stringify(path)}.`,
    );
  }
}

function assertAbsolutePackageDirectory(path: string, name: string): void {
  const segments = path.split(/[\\/]/u);
  if (
    !isAbsolute(path) ||
    path.includes('\0') ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error(
      `Sealed build package directory for ${name} must be an absolute path without traversal.`,
    );
  }
}

async function requiredStat(
  path: string,
  description: string,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstat(path);
  } catch (error) {
    if (filesystemErrorCode(error) === 'ENOENT') {
      throw new Error(`Sealed build ${description} is missing: ${path}`);
    }
    throw error;
  }
}

async function readRegularFile(
  absolutePath: string,
  relativePath: string,
  packageName: string,
): Promise<{ file: SealedBuildFileProvenance; content: Buffer }> {
  assertValidSealedBuildRelativePath(relativePath);
  const stat = await requiredStat(
    absolutePath,
    `file ${packageName}:${relativePath}`,
  );
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Sealed build may not contain a symlink: ${packageName}:${relativePath}`,
    );
  }
  if (!stat.isFile()) {
    throw new Error(
      `Sealed build contains an unsupported non-file entry: ${packageName}:${relativePath}`,
    );
  }
  const bytes = await readFile(absolutePath);
  return {
    file: {
      path: relativePath,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    },
    content: bytes,
  };
}

async function walkDistFiles(input: {
  packageName: string;
  packageDirectory: string;
  directory: string;
}): Promise<SealedBuildFileProvenance[]> {
  const files: SealedBuildFileProvenance[] = [];
  const entries = await readdir(input.directory, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const absolutePath = join(input.directory, entry.name);
    const relativePath = relative(input.packageDirectory, absolutePath).replaceAll('\\', '/');
    assertValidSealedBuildRelativePath(relativePath);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Sealed build may not contain a symlink: ${input.packageName}:${relativePath}`,
      );
    }
    if (entry.isDirectory()) {
      files.push(
        ...(await walkDistFiles({
          ...input,
          directory: absolutePath,
        })),
      );
    } else if (entry.isFile()) {
      files.push(
        (await readRegularFile(absolutePath, relativePath, input.packageName)).file,
      );
    } else {
      throw new Error(
        `Sealed build contains an unsupported non-file entry: ${input.packageName}:${relativePath}`,
      );
    }
  }
  return files;
}

function parsePackageIdentity(
  content: Buffer,
  expectedName: SealedUpliftBrowserIrPackageName,
): { name: string; version: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString('utf8')) as unknown;
  } catch {
    throw new Error(`Sealed build package.json is not valid JSON for ${expectedName}.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Sealed build package.json is not an object for ${expectedName}.`);
  }
  const manifest = parsed as Record<string, unknown>;
  if (manifest['name'] !== expectedName) {
    throw new Error(
      `Sealed build package name mismatch: expected ${expectedName}, received ${String(manifest['name'])}.`,
    );
  }
  if (typeof manifest['version'] !== 'string' || manifest['version'].length === 0) {
    throw new Error(`Sealed build package version is missing for ${expectedName}.`);
  }
  return { name: expectedName, version: manifest['version'] };
}

async function collectPackage(
  input: SealedBuildPackageInput,
): Promise<SealedBuildPackageProvenance> {
  assertAbsolutePackageDirectory(input.packageDirectory, input.name);
  const packageStat = await requiredStat(
    input.packageDirectory,
    `package directory for ${input.name}`,
  );
  if (packageStat.isSymbolicLink()) {
    throw new Error(`Sealed build package directory may not be a symlink: ${input.name}.`);
  }
  if (!packageStat.isDirectory()) {
    throw new Error(`Sealed build package root is not a directory: ${input.name}.`);
  }

  const packageJsonPath = join(input.packageDirectory, 'package.json');
  const packageJson = await readRegularFile(
    packageJsonPath,
    'package.json',
    input.name,
  );
  const identity = parsePackageIdentity(packageJson.content, input.name);

  const distDirectory = join(input.packageDirectory, 'dist');
  const distStat = await requiredStat(distDirectory, `dist directory for ${input.name}`);
  if (distStat.isSymbolicLink()) {
    throw new Error(`Sealed build dist directory may not be a symlink: ${input.name}:dist.`);
  }
  if (!distStat.isDirectory()) {
    throw new Error(`Sealed build dist entry is not a directory: ${input.name}:dist.`);
  }
  const distFiles = await walkDistFiles({
    packageName: input.name,
    packageDirectory: input.packageDirectory,
    directory: distDirectory,
  });
  if (distFiles.length === 0) {
    throw new Error(`Sealed build dist directory has no files for ${input.name}.`);
  }
  const files = [...distFiles, packageJson.file].sort((left, right) =>
    compareText(left.path, right.path),
  );
  const unsigned = {
    name: input.name,
    version: identity.version,
    files,
  } as const;
  return { ...unsigned, sha256: provenanceDigest(unsigned) };
}

function assertExactPackageInputs(inputs: readonly SealedBuildPackageInput[]): void {
  const names = inputs.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    throw new Error('Sealed build package inputs contain a duplicate package name.');
  }
  const missing = SEALED_UPLIFT_BROWSERIR_PACKAGE_NAMES.filter(
    (name) => !names.includes(name),
  );
  const unexpected = names.filter((name) => !expectedPackageNames.has(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Sealed build package set mismatch; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}.`,
    );
  }
}

export async function collectSealedBuildProvenance(input: {
  packages: readonly SealedBuildPackageInput[];
}): Promise<SealedBuildProvenance> {
  assertExactPackageInputs(input.packages);
  const packages: SealedBuildPackageProvenance[] = [];
  for (const packageInput of [...input.packages].sort((left, right) =>
    compareText(left.name, right.name),
  )) {
    packages.push(await collectPackage(packageInput));
  }
  const unsigned = {
    schemaVersion: SEALED_EXECUTION_BUILD_PROVENANCE_SCHEMA_VERSION,
    packages,
  } as const;
  return { ...unsigned, sha256: provenanceDigest(unsigned) };
}

/** Resolve the exact workspace packages imported by the uplift runtime. */
export async function collectUpliftBrowserIrBuildProvenance(): Promise<SealedBuildProvenance> {
  const loader = createRequire(import.meta.url);
  const packages = SEALED_UPLIFT_BROWSERIR_PACKAGE_NAMES.map((name) => ({
    name,
    packageDirectory: dirname(loader.resolve(`${name}/package.json`)),
  }));
  return collectSealedBuildProvenance({ packages });
}

function assertFileProvenance(file: SealedBuildFileProvenance, packageName: string): void {
  assertValidSealedBuildRelativePath(file.path);
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
    throw new Error(`Invalid sealed build byte count for ${packageName}:${file.path}.`);
  }
  if (!digestPattern.test(file.sha256)) {
    throw new Error(`Invalid sealed build file digest for ${packageName}:${file.path}.`);
  }
}

function assertBuildProvenance(provenance: SealedBuildProvenance): void {
  if (provenance.schemaVersion !== SEALED_EXECUTION_BUILD_PROVENANCE_SCHEMA_VERSION) {
    throw new Error('Unsupported sealed build provenance schema version.');
  }
  assertExactPackageInputs(
    provenance.packages.map(({ name }) => ({ name, packageDirectory: '/' })),
  );
  const sortedPackages = [...provenance.packages].sort((left, right) =>
    compareText(left.name, right.name),
  );
  if (sortedPackages.some((entry, index) => entry !== provenance.packages[index])) {
    throw new Error('Sealed build packages are not canonically ordered.');
  }
  for (const packageEntry of provenance.packages) {
    if (packageEntry.version.length === 0) {
      throw new Error(`Invalid sealed build package version for ${packageEntry.name}.`);
    }
    const paths = new Set<string>();
    for (const file of packageEntry.files) {
      assertFileProvenance(file, packageEntry.name);
      if (paths.has(file.path)) {
        throw new Error(`Duplicate sealed build path ${packageEntry.name}:${file.path}.`);
      }
      paths.add(file.path);
    }
    if (!paths.has('package.json') || ![...paths].some((path) => path.startsWith('dist/'))) {
      throw new Error(`Sealed build package is missing package.json or dist files: ${packageEntry.name}.`);
    }
    const sortedFiles = [...packageEntry.files].sort((left, right) =>
      compareText(left.path, right.path),
    );
    if (sortedFiles.some((entry, index) => entry !== packageEntry.files[index])) {
      throw new Error(`Sealed build files are not canonically ordered for ${packageEntry.name}.`);
    }
    const actualPackageDigest = provenanceDigest({
      name: packageEntry.name,
      version: packageEntry.version,
      files: packageEntry.files,
    });
    if (packageEntry.sha256 !== actualPackageDigest) {
      throw new Error(`Sealed build package digest is invalid for ${packageEntry.name}.`);
    }
  }
  const actualDigest = provenanceDigest({
    schemaVersion: provenance.schemaVersion,
    packages: provenance.packages,
  });
  if (provenance.sha256 !== actualDigest) {
    throw new Error('Sealed build aggregate digest is invalid.');
  }
}

export function parseSealedBuildProvenance(input: unknown): SealedBuildProvenance {
  const result = buildProvenanceSchema.safeParse(input);
  if (!result.success) {
    throw new Error(
      `Invalid sealed build provenance: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  assertBuildProvenance(result.data);
  return result.data;
}

export function renderSealedBuildProvenance(input: unknown): string {
  const parsed = parseSealedBuildProvenance(input);
  return `${JSON.stringify(JSON.parse(stableJson(parsed)) as unknown, null, 2)}\n`;
}

const filesByPath = (
  packageEntry: SealedBuildPackageProvenance,
): ReadonlyMap<string, SealedBuildFileProvenance> =>
  new Map(packageEntry.files.map((file) => [file.path, file]));

export function assertSealedBuildProvenanceStable(
  start: SealedBuildProvenance,
  end: SealedBuildProvenance,
): void {
  assertBuildProvenance(start);
  assertBuildProvenance(end);
  if (start.sha256 === end.sha256 && stableJson(start) === stableJson(end)) return;

  const endPackages = new Map(end.packages.map((entry) => [entry.name, entry]));
  for (const startPackage of start.packages) {
    const endPackage = endPackages.get(startPackage.name);
    if (endPackage === undefined) {
      throw new Error(`Sealed build provenance drift: missing package ${startPackage.name}.`);
    }
    const startFiles = filesByPath(startPackage);
    const endFiles = filesByPath(endPackage);
    const missing = [...startFiles.keys()].filter((path) => !endFiles.has(path));
    const unexpected = [...endFiles.keys()].filter((path) => !startFiles.has(path));
    if (missing.length > 0 || unexpected.length > 0) {
      throw new Error(
        `Sealed build provenance drift for ${startPackage.name}; missing files: ${missing.join(', ') || 'none'}; unexpected files: ${unexpected.join(', ') || 'none'}.`,
      );
    }
    for (const [path, startFile] of startFiles) {
      const endFile = endFiles.get(path)!;
      if (startFile.sha256 !== endFile.sha256 || startFile.bytes !== endFile.bytes) {
        throw new Error(
          `Sealed build content changed for ${startPackage.name} at ${path}.`,
        );
      }
    }
    if (startPackage.version !== endPackage.version) {
      throw new Error(`Sealed build package version drifted for ${startPackage.name}.`);
    }
    endPackages.delete(startPackage.name);
  }
  const unexpectedPackages = [...endPackages.keys()];
  if (unexpectedPackages.length > 0) {
    throw new Error(
      `Sealed build provenance drift: unexpected packages ${unexpectedPackages.join(', ')}.`,
    );
  }
  throw new Error('Sealed build provenance changed between execution start and end.');
}

function assertResolvedGitObject(value: string | null, field: 'revision' | 'tree'): string {
  if (value === null) {
    throw new Error(`Sealed Git source requires a resolved ${field}.`);
  }
  if (!gitObjectPattern.test(value)) {
    throw new Error(`Sealed Git source ${field} is not a canonical Git object ID.`);
  }
  return value;
}

/** Pure comparison; callers own Git process execution and snapshot collection. */
export function assertSealedGitSourceStable(
  start: SealedGitSourceSnapshot,
  end: SealedGitSourceSnapshot,
): void {
  const startRevision = assertResolvedGitObject(start.revision, 'revision');
  const startTree = assertResolvedGitObject(start.tree, 'tree');
  const endRevision = assertResolvedGitObject(end.revision, 'revision');
  const endTree = assertResolvedGitObject(end.tree, 'tree');
  if (!start.clean) throw new Error('Sealed Git source start snapshot is dirty, not clean.');
  if (!end.clean) throw new Error('Sealed Git source end snapshot is dirty, not clean.');
  if (startRevision !== endRevision) {
    throw new Error('Sealed Git source revision drifted between start and end.');
  }
  if (startTree !== endTree) {
    throw new Error('Sealed Git source tree drifted between start and end.');
  }
}
