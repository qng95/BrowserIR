import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultSourceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const freezeRefPattern = /^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const temporaryPrefix = 'browserir-sealed-uplift-';
const inheritedEnvironmentNames = [
  'CI',
  'FORCE_COLOR',
  'LANG',
  'LC_ALL',
  'NO_COLOR',
  'PATH',
  'PLAYWRIGHT_BROWSERS_PATH',
  'TERM',
  'TZ',
];

export const SEALED_UPLIFT_USAGE = `BrowserIR sealed uplift launcher

Usage:
  node scripts/run-sealed-uplift.mjs --protocol FILE (--output ABSOLUTE_DIRECTORY | --resume ABSOLUTE_DIRECTORY)

The protocol path is repository-relative. Evidence must use an explicit absolute
directory outside the source checkout. The launcher clones the protocol freezeRef,
installs with the frozen lockfile, builds, and only then invokes the uplift CLI.
`;

const valueAfter = (args, index, option) => {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--') || value.trim().length === 0) {
    throw new Error(`${option} requires a non-empty value.`);
  }
  return value;
};

const canonicalRepositoryRelativePath = (value) => {
  if (isAbsolute(value) || value.includes('\\')) {
    throw new Error('--protocol must be a canonical repository-relative path.');
  }
  const normalized = normalize(value);
  if (
    normalized !== value ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith(`..${sep}`)
  ) {
    throw new Error('--protocol must stay inside the repository without path traversal.');
  }
  return normalized;
};

const absoluteEvidencePath = (value, option) => {
  if (!isAbsolute(value)) {
    throw new Error(`${option} must be an absolute external evidence directory.`);
  }
  const normalized = resolve(value);
  if (normalized === parsePath(normalized).root) {
    throw new Error(`${option} cannot be a filesystem root.`);
  }
  return normalized;
};

export function parseSealedUpliftArguments(args) {
  let protocolPath;
  let outputDirectory;
  let resumeDirectory;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option !== '--protocol' && option !== '--output' && option !== '--resume') {
      throw new Error(`Unknown sealed uplift option: ${String(option)}.`);
    }
    if (seen.has(option)) throw new Error(`Duplicate ${option} option.`);
    seen.add(option);
    const value = valueAfter(args, index, option);
    if (option === '--protocol') protocolPath = canonicalRepositoryRelativePath(value);
    else if (option === '--output') outputDirectory = absoluteEvidencePath(value, option);
    else resumeDirectory = absoluteEvidencePath(value, option);
    index += 1;
  }
  if (protocolPath === undefined) throw new Error('--protocol is required.');
  if ((outputDirectory === undefined) === (resumeDirectory === undefined)) {
    throw new Error('Exactly one of --output or --resume is required; they cannot be used together.');
  }
  return {
    protocolPath,
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
    ...(resumeDirectory === undefined ? {} : { resumeDirectory }),
  };
}

export function createSealedUpliftEnvironment(source, isolatedRoot) {
  if (!isAbsolute(isolatedRoot) || isolatedRoot === parsePath(isolatedRoot).root) {
    throw new Error('Sealed uplift environment root must be an absolute non-root path.');
  }
  if (typeof source.PATH !== 'string' || source.PATH.length === 0) {
    throw new Error('Sealed uplift requires a non-empty PATH.');
  }
  const environment = {};
  for (const name of inheritedEnvironmentNames) {
    const value = source[name];
    if (typeof value === 'string' && value.length > 0) environment[name] = value;
  }
  return Object.freeze({
    ...environment,
    HOME: join(isolatedRoot, 'home'),
    TMPDIR: join(isolatedRoot, 'tmp'),
    XDG_CACHE_HOME: join(isolatedRoot, 'cache'),
    XDG_CONFIG_HOME: join(isolatedRoot, 'config'),
    XDG_DATA_HOME: join(isolatedRoot, 'data'),
    COREPACK_HOME: join(isolatedRoot, 'corepack'),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_DEFAULT_TO_LATEST: '0',
    NPM_CONFIG_USERCONFIG: join(isolatedRoot, 'npmrc'),
  });
}

const isWithin = (parent, candidate) => {
  const path = relative(parent, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
};

async function canonicalPotentialPath(path) {
  const missing = [];
  let cursor = path;
  for (;;) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missing.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

async function assertRegularFile(path, label) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file, not a symlink or special file.`);
  }
}

async function readSealedManifest(path) {
  await assertRegularFile(path, 'Sealed protocol manifest');
  const source = await readFile(path, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `Sealed protocol manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Sealed protocol manifest must be a JSON object.');
  }
  if (parsed.phase !== 'sealed') {
    throw new Error('Sealed uplift launcher requires a manifest whose phase is sealed.');
  }
  if (typeof parsed.freezeRef !== 'string' || !freezeRefPattern.test(parsed.freezeRef)) {
    throw new Error('Sealed protocol manifest requires a canonical refs/tags/... freezeRef.');
  }
  return { source, freezeRef: parsed.freezeRef };
}

async function pathExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function defaultRunCommand({ command, args, cwd, stdio }, environment) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio,
      env: environment,
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        reject(
          new Error(
            `${command} exited ${code === null ? `from signal ${signal ?? 'unknown'}` : `with status ${code}`}.`,
          ),
        );
      }
    });
  });
}

const command = (runCommand, executable, args, cwd) =>
  runCommand({ command: executable, args, cwd, stdio: 'inherit' });

export async function launchSealedUplift(args, dependencies = {}) {
  const options = parseSealedUpliftArguments(args);
  const sourceRoot = await realpath(resolve(dependencies.sourceRoot ?? defaultSourceRoot));
  const temporaryParentDirectory = await realpath(
    resolve(dependencies.temporaryParentDirectory ?? tmpdir()),
  );
  const injectedRunCommand = dependencies.runCommand;
  const protocolFile = resolve(sourceRoot, options.protocolPath);
  if (!isWithin(sourceRoot, protocolFile) || protocolFile === sourceRoot) {
    throw new Error('Sealed protocol manifest must be inside the source checkout.');
  }
  const canonicalProtocolFile = await realpath(protocolFile);
  if (!isWithin(sourceRoot, canonicalProtocolFile)) {
    throw new Error('Sealed protocol manifest resolves outside the source checkout.');
  }
  const launchManifest = await readSealedManifest(protocolFile);
  const requestedEvidenceDirectory = options.outputDirectory ?? options.resumeDirectory;
  const evidenceDirectory = await canonicalPotentialPath(requestedEvidenceDirectory);
  if (isWithin(sourceRoot, evidenceDirectory)) {
    throw new Error('The evidence directory must be external and outside the source checkout.');
  }
  if (isWithin(sourceRoot, temporaryParentDirectory)) {
    throw new Error('The temporary checkout parent must be outside the source checkout.');
  }
  const evidenceMetadata = await pathExists(evidenceDirectory);
  if (options.outputDirectory !== undefined && evidenceMetadata !== undefined) {
    throw new Error('--output must name a new directory that does not already exist.');
  }
  if (options.resumeDirectory !== undefined && !evidenceMetadata?.isDirectory()) {
    throw new Error('--resume must name an existing evidence directory.');
  }

  let temporaryRoot;
  let primaryError;
  try {
    const temporaryCandidate = await mkdtemp(join(temporaryParentDirectory, temporaryPrefix));
    if (
      dirname(temporaryCandidate) !== temporaryParentDirectory ||
      !basename(temporaryCandidate).startsWith(temporaryPrefix) ||
      basename(temporaryCandidate).length <= temporaryPrefix.length
    ) {
      throw new Error('Temporary directory provider returned an unsafe cleanup target.');
    }
    // Assign only after validation so the cleanup path can never widen if a
    // temporary-directory provider violates the expected mkdtemp contract.
    temporaryRoot = temporaryCandidate;
    if (isWithin(temporaryRoot, evidenceDirectory)) {
      throw new Error('The evidence directory must remain outside the temporary checkout.');
    }
    const isolatedEnvironmentRoot = join(temporaryRoot, 'environment');
    const environment = createSealedUpliftEnvironment(
      process.env,
      isolatedEnvironmentRoot,
    );
    await Promise.all([
      mkdir(environment.HOME, { recursive: true }),
      mkdir(environment.TMPDIR, { recursive: true }),
      mkdir(environment.XDG_CACHE_HOME, { recursive: true }),
      mkdir(environment.XDG_CONFIG_HOME, { recursive: true }),
      mkdir(environment.XDG_DATA_HOME, { recursive: true }),
      mkdir(environment.COREPACK_HOME, { recursive: true }),
    ]);
    await writeFile(environment.NPM_CONFIG_USERCONFIG, '', { flag: 'wx' });
    const runCommand =
      injectedRunCommand ??
      ((sealedCommand) => defaultRunCommand(sealedCommand, environment));
    const checkout = join(temporaryRoot, 'source');
    await command(
      runCommand,
      'git',
      [
        'clone',
        '--no-checkout',
        '--local',
        '--no-hardlinks',
        '--',
        sourceRoot,
        checkout,
      ],
      sourceRoot,
    );
    await command(
      runCommand,
      'git',
      ['-c', 'advice.detachedHead=false', 'checkout', '--detach', launchManifest.freezeRef],
      checkout,
    );
    const frozenManifest = await readSealedManifest(join(checkout, options.protocolPath));
    if (
      frozenManifest.freezeRef !== launchManifest.freezeRef ||
      frozenManifest.source !== launchManifest.source
    ) {
      throw new Error('Frozen manifest bytes differ from the launch manifest.');
    }
    await command(
      runCommand,
      'corepack',
      ['pnpm', 'install', '--frozen-lockfile'],
      checkout,
    );
    await command(runCommand, 'corepack', ['pnpm', 'build'], checkout);
    const evidenceOption = options.outputDirectory === undefined ? '--resume' : '--output';
    await command(
      runCommand,
      'corepack',
      [
        'pnpm',
        'benchmark:uplift',
        '--',
        '--protocol',
        options.protocolPath,
        evidenceOption,
        evidenceDirectory,
      ],
      checkout,
    );
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  if (temporaryRoot !== undefined) {
    try {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      cleanupError = error;
    }
  }
  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [primaryError, cleanupError],
      `Sealed uplift failed (${String(primaryError)}) and temporary cleanup also failed.`,
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(SEALED_UPLIFT_USAGE);
    return;
  }
  await launchSealedUplift(args);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(
      `BrowserIR sealed uplift launcher failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
