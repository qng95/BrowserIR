import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import { z } from 'zod';

import { stableJson } from '../environment.js';
import {
  CONTROL_CAPABILITY_AGENT_RUNTIME_PACKAGE_NAMES,
  resolveControlCapabilityAgentRuntimePackageInputs,
} from './control-capability-agent-runtime-boundary.js';
import {
  PLAYWRIGHT_MCP_RUNTIME_PACKAGE_NAMES,
  playwrightMcpChromiumExecutablePath,
  probePlaywrightMcpChromiumVersion,
  resolvePlaywrightMcpRuntimePackageInputs,
} from './playwright-mcp-runtime-boundary.js';

export const INSTALLED_RUNTIME_PROVENANCE_SCHEMA_VERSION = '1.0.0' as const;

export const CONTROL_CAPABILITY_RUNTIME_PACKAGE_NAMES = [
  ...CONTROL_CAPABILITY_AGENT_RUNTIME_PACKAGE_NAMES,
  ...PLAYWRIGHT_MCP_RUNTIME_PACKAGE_NAMES,
] as const;

export interface InstalledRuntimePackageInput {
  name: string;
  /** Absolute resolved package directory. Absolute paths are never retained. */
  packageDirectory: string;
}

export interface InstalledRuntimeBrowserInput {
  engine: 'chromium';
  executablePath: string;
  launchVersion(executablePath: string): Promise<string>;
}

export interface InstalledRuntimeFileProvenance {
  path: string;
  kind: 'package_manifest' | 'package_payload';
  bytes: number;
  sha256: string;
}

export interface InstalledRuntimePackageProvenance {
  name: string;
  version: string;
  files: readonly InstalledRuntimeFileProvenance[];
  sha256: string;
}

export interface InstalledRuntimeBrowserProvenance {
  engine: 'chromium';
  version: string;
  executableBytes: number;
  executableSha256: string;
}

export interface InstalledRuntimeProvenance {
  schemaVersion: typeof INSTALLED_RUNTIME_PROVENANCE_SCHEMA_VERSION;
  packages: readonly InstalledRuntimePackageProvenance[];
  browser: InstalledRuntimeBrowserProvenance;
  sha256: string;
}

export interface CollectInstalledRuntimeProvenanceInput {
  packages: readonly InstalledRuntimePackageInput[];
  browser: InstalledRuntimeBrowserInput;
}

const digestPattern = /^[a-f0-9]{64}$/;
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

const fileSchema = z
  .object({
    path: z.string().min(1),
    kind: z.enum(['package_manifest', 'package_payload']),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(digestPattern),
  })
  .strict();

const packageSchema = z
  .object({
    name: z.string().regex(packageNamePattern),
    version: z.string().min(1).max(256),
    files: z.array(fileSchema).min(2),
    sha256: z.string().regex(digestPattern),
  })
  .strict();

const provenanceSchema = z
  .object({
    schemaVersion: z.literal(INSTALLED_RUNTIME_PROVENANCE_SCHEMA_VERSION),
    packages: z.array(packageSchema).min(1),
    browser: z
      .object({
        engine: z.literal('chromium'),
        version: z.string().min(1).max(256),
        executableBytes: z.number().int().positive(),
        executableSha256: z.string().regex(digestPattern),
      })
      .strict(),
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

function assertPackageName(name: string): void {
  if (!packageNamePattern.test(name)) {
    throw new Error(`Installed runtime package name is invalid: ${JSON.stringify(name)}.`);
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
      `Installed runtime package directory for ${name} must be an absolute path without traversal.`,
    );
  }
}

function assertRelativePayloadPath(path: string): void {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
    path === 'node_modules' ||
    path.split('/').includes('node_modules')
  ) {
    throw new Error(`Installed runtime payload path is unsafe: ${JSON.stringify(path)}.`);
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
      throw new Error(`Installed runtime ${description} is missing: ${path}`);
    }
    throw error;
  }
}

async function readPayloadFile(input: {
  absolutePath: string;
  relativePath: string;
  packageName: string;
  kind: InstalledRuntimeFileProvenance['kind'];
}): Promise<{ file: InstalledRuntimeFileProvenance; content: Buffer }> {
  assertRelativePayloadPath(input.relativePath);
  const stat = await requiredStat(
    input.absolutePath,
    `file ${input.packageName}:${input.relativePath}`,
  );
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Installed runtime may not contain a symlink: ${input.packageName}:${input.relativePath}.`,
    );
  }
  if (!stat.isFile()) {
    throw new Error(
      `Installed runtime contains a non-file payload: ${input.packageName}:${input.relativePath}.`,
    );
  }
  const content = await readFile(input.absolutePath);
  return {
    file: {
      path: input.relativePath,
      kind: input.kind,
      bytes: content.byteLength,
      sha256: sha256(content),
    },
    content,
  };
}

async function walkPackagePayloads(input: {
  packageName: string;
  packageDirectory: string;
  directory: string;
}): Promise<InstalledRuntimeFileProvenance[]> {
  const files: InstalledRuntimeFileProvenance[] = [];
  const entries = await readdir(input.directory, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const absolutePath = join(input.directory, entry.name);
    const relativePath = relative(input.packageDirectory, absolutePath).replaceAll('\\', '/');
    if (relativePath === 'package.json' || relativePath.split('/').includes('node_modules')) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Installed runtime may not contain a symlink: ${input.packageName}:${relativePath}.`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await walkPackagePayloads({ ...input, directory: absolutePath })));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `Installed runtime contains an unsupported entry: ${input.packageName}:${relativePath}.`,
      );
    }
    files.push(
      (
        await readPayloadFile({
          absolutePath,
          relativePath,
          packageName: input.packageName,
          kind: 'package_payload',
        })
      ).file,
    );
  }
  return files;
}

function parsePackageIdentity(content: Buffer, expectedName: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString('utf8')) as unknown;
  } catch {
    throw new Error(`Installed runtime package.json is invalid JSON for ${expectedName}.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Installed runtime package.json is not an object for ${expectedName}.`);
  }
  const manifest = parsed as Record<string, unknown>;
  if (manifest['name'] !== expectedName) {
    throw new Error(
      `Installed runtime package name mismatch: expected ${expectedName}, received ${String(manifest['name'])}.`,
    );
  }
  if (
    typeof manifest['version'] !== 'string' ||
    manifest['version'].length === 0 ||
    manifest['version'].length > 256
  ) {
    throw new Error(`Installed runtime package version is invalid for ${expectedName}.`);
  }
  return manifest['version'];
}

async function collectPackage(
  input: InstalledRuntimePackageInput,
): Promise<InstalledRuntimePackageProvenance> {
  assertPackageName(input.name);
  assertAbsolutePackageDirectory(input.packageDirectory, input.name);
  const packageStat = await requiredStat(
    input.packageDirectory,
    `package directory for ${input.name}`,
  );
  if (packageStat.isSymbolicLink()) {
    throw new Error(`Installed runtime package directory may not be a symlink: ${input.name}.`);
  }
  if (!packageStat.isDirectory()) {
    throw new Error(`Installed runtime package root is not a directory: ${input.name}.`);
  }
  const manifest = await readPayloadFile({
    absolutePath: join(input.packageDirectory, 'package.json'),
    relativePath: 'package.json',
    packageName: input.name,
    kind: 'package_manifest',
  });
  const version = parsePackageIdentity(manifest.content, input.name);
  const payloads = await walkPackagePayloads({
    packageName: input.name,
    packageDirectory: input.packageDirectory,
    directory: input.packageDirectory,
  });
  if (payloads.length === 0) {
    throw new Error(`Installed runtime package has no package payload: ${input.name}.`);
  }
  const files = [...payloads, manifest.file].sort((left, right) =>
    compareText(left.path, right.path),
  );
  const unsigned = { name: input.name, version, files } as const;
  return { ...unsigned, sha256: provenanceDigest(unsigned) };
}

async function hashExecutable(path: string): Promise<{ bytes: number; sha256: string }> {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new Error('Installed runtime browser executable path must be absolute.');
  }
  const stat = await requiredStat(path, 'browser executable');
  if (stat.isSymbolicLink()) {
    throw new Error('Installed runtime browser executable may not be a symlink.');
  }
  if (!stat.isFile() || stat.size < 1 || !Number.isSafeInteger(stat.size)) {
    throw new Error('Installed runtime browser executable must be a non-empty regular file.');
  }
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    hash.update(buffer);
  }
  if (bytes !== stat.size) {
    throw new Error('Installed runtime browser executable changed while being hashed.');
  }
  return { bytes, sha256: hash.digest('hex') };
}

function assertUniqueInputs(inputs: readonly InstalledRuntimePackageInput[]): void {
  if (inputs.length === 0) throw new Error('Installed runtime package inputs must not be empty.');
  const names = inputs.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    throw new Error('Installed runtime package inputs contain a duplicate package name.');
  }
}

export async function collectInstalledRuntimeProvenance(
  input: CollectInstalledRuntimeProvenanceInput,
): Promise<InstalledRuntimeProvenance> {
  assertUniqueInputs(input.packages);
  const packages: InstalledRuntimePackageProvenance[] = [];
  for (const packageInput of [...input.packages].sort((left, right) =>
    compareText(left.name, right.name),
  )) {
    packages.push(await collectPackage(packageInput));
  }
  const executable = await hashExecutable(input.browser.executablePath);
  const version = await input.browser.launchVersion(input.browser.executablePath);
  if (version.trim().length === 0 || version.length > 256) {
    throw new Error('Installed runtime browser returned an invalid version.');
  }
  const browser: InstalledRuntimeBrowserProvenance = {
    engine: input.browser.engine,
    version,
    executableBytes: executable.bytes,
    executableSha256: executable.sha256,
  };
  const unsigned = {
    schemaVersion: INSTALLED_RUNTIME_PROVENANCE_SCHEMA_VERSION,
    packages,
    browser,
  } as const;
  return { ...unsigned, sha256: provenanceDigest(unsigned) };
}

/** Collect the exact agent, MCP client/server, Playwright, and browser execution boundary. */
export async function collectControlCapabilityRuntimeProvenance(): Promise<InstalledRuntimeProvenance> {
  const packages = [
    ...resolveControlCapabilityAgentRuntimePackageInputs(),
    ...resolvePlaywrightMcpRuntimePackageInputs(),
  ];
  const expectedNames = new Set<string>(CONTROL_CAPABILITY_RUNTIME_PACKAGE_NAMES);
  if (
    packages.length !== CONTROL_CAPABILITY_RUNTIME_PACKAGE_NAMES.length ||
    packages.some((entry) => !expectedNames.has(entry.name)) ||
    new Set(packages.map(({ name }) => name)).size !== packages.length
  ) {
    throw new Error('Control capability runtime package resolution is incomplete.');
  }
  return collectInstalledRuntimeProvenance({
    packages,
    browser: {
      engine: 'chromium',
      executablePath: playwrightMcpChromiumExecutablePath(),
      launchVersion: probePlaywrightMcpChromiumVersion,
    },
  });
}

function assertFile(file: InstalledRuntimeFileProvenance, packageName: string): void {
  assertRelativePayloadPath(file.path);
  const expectedKind =
    file.path === 'package.json' ? 'package_manifest' : 'package_payload';
  if (file.kind !== expectedKind) {
    throw new Error(`Installed runtime payload kind is invalid for ${packageName}:${file.path}.`);
  }
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !digestPattern.test(file.sha256)) {
    throw new Error(`Installed runtime payload metadata is invalid for ${packageName}:${file.path}.`);
  }
}

function assertProvenance(input: InstalledRuntimeProvenance): void {
  const sortedPackages = [...input.packages].sort((left, right) =>
    compareText(left.name, right.name),
  );
  if (sortedPackages.some((entry, index) => entry !== input.packages[index])) {
    throw new Error('Installed runtime packages are not canonically ordered.');
  }
  if (new Set(input.packages.map(({ name }) => name)).size !== input.packages.length) {
    throw new Error('Installed runtime provenance contains duplicate packages.');
  }
  for (const packageEntry of input.packages) {
    const sortedFiles = [...packageEntry.files].sort((left, right) =>
      compareText(left.path, right.path),
    );
    if (sortedFiles.some((entry, index) => entry !== packageEntry.files[index])) {
      throw new Error(`Installed runtime files are not canonical for ${packageEntry.name}.`);
    }
    const paths = new Set<string>();
    for (const file of packageEntry.files) {
      assertFile(file, packageEntry.name);
      if (paths.has(file.path)) {
        throw new Error(`Installed runtime path is duplicated: ${packageEntry.name}:${file.path}.`);
      }
      paths.add(file.path);
    }
    if (!paths.has('package.json') || paths.size < 2) {
      throw new Error(`Installed runtime package is missing required payloads: ${packageEntry.name}.`);
    }
    const expectedDigest = provenanceDigest({
      name: packageEntry.name,
      version: packageEntry.version,
      files: packageEntry.files,
    });
    if (packageEntry.sha256 !== expectedDigest) {
      throw new Error(`Installed runtime package digest is invalid for ${packageEntry.name}.`);
    }
  }
  const expectedDigest = provenanceDigest({
    schemaVersion: input.schemaVersion,
    packages: input.packages,
    browser: input.browser,
  });
  if (input.sha256 !== expectedDigest) {
    throw new Error('Installed runtime aggregate digest is invalid.');
  }
}

export function parseInstalledRuntimeProvenance(input: unknown): InstalledRuntimeProvenance {
  const result = provenanceSchema.safeParse(input);
  if (!result.success) {
    throw new Error(
      `Invalid installed runtime provenance: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  assertProvenance(result.data);
  return result.data;
}

export function renderInstalledRuntimeProvenance(input: unknown): string {
  const parsed = parseInstalledRuntimeProvenance(input);
  return `${JSON.stringify(JSON.parse(stableJson(parsed)) as unknown, null, 2)}\n`;
}

const filesByPath = (
  packageEntry: InstalledRuntimePackageProvenance,
): ReadonlyMap<string, InstalledRuntimeFileProvenance> =>
  new Map(packageEntry.files.map((file) => [file.path, file]));

export function assertInstalledRuntimeProvenanceStable(
  start: InstalledRuntimeProvenance,
  end: InstalledRuntimeProvenance,
): void {
  assertProvenance(start);
  assertProvenance(end);
  if (start.sha256 === end.sha256 && stableJson(start) === stableJson(end)) return;
  const endPackages = new Map(end.packages.map((entry) => [entry.name, entry]));
  for (const startPackage of start.packages) {
    const endPackage = endPackages.get(startPackage.name);
    if (endPackage === undefined) {
      throw new Error(`Installed runtime provenance drift: missing package ${startPackage.name}.`);
    }
    const startFiles = filesByPath(startPackage);
    const endFiles = filesByPath(endPackage);
    const missing = [...startFiles.keys()].filter((path) => !endFiles.has(path));
    const unexpected = [...endFiles.keys()].filter((path) => !startFiles.has(path));
    if (missing.length > 0 || unexpected.length > 0) {
      throw new Error(
        `Installed runtime provenance drift for ${startPackage.name}; missing files: ${missing.join(', ') || 'none'}; unexpected files: ${unexpected.join(', ') || 'none'}.`,
      );
    }
    for (const [path, startFile] of startFiles) {
      const endFile = endFiles.get(path)!;
      if (startFile.sha256 !== endFile.sha256 || startFile.bytes !== endFile.bytes) {
        throw new Error(`Installed runtime content changed for ${startPackage.name} at ${path}.`);
      }
    }
    if (startPackage.version !== endPackage.version) {
      throw new Error(`Installed runtime package version drifted for ${startPackage.name}.`);
    }
    endPackages.delete(startPackage.name);
  }
  if (endPackages.size > 0) {
    throw new Error(
      `Installed runtime provenance drift: unexpected packages ${[...endPackages.keys()].join(', ')}.`,
    );
  }
  if (
    start.browser.executableSha256 !== end.browser.executableSha256 ||
    start.browser.executableBytes !== end.browser.executableBytes
  ) {
    throw new Error('Installed runtime Chromium executable content changed.');
  }
  if (start.browser.version !== end.browser.version) {
    throw new Error('Installed runtime Chromium launched version drifted.');
  }
  throw new Error('Installed runtime provenance changed between execution start and end.');
}
